/**
 * Hiding management routes — per-token notebook hiding configuration.
 *
 * All routes require owner authentication (requireOwner). Agent/member tokens
 * are rejected with 403 to prevent self-unhiding.
 *
 * Routes:
 * GET  /api/v1/api-tokens/:id/hiding  — list hidden notebook IDs for this token
 * PUT  /api/v1/api-tokens/:id/hiding  — replace hidden notebook set (full replace)
 */
import { Hono } from "hono";
import type { AppContext, AppEnv } from "./api-context";
import { AppError } from "./app-error";
import { requireOwner, getWorkspaceId } from "./request-auth";
import type { DatabaseAdapter } from "./storage-contract";

export type HidingRouteDependencies = {
  // intentionally minimal — routes use c.env.storage directly
};

interface HiddenNotebookRow {
  token_id: string;
  notebook_id: string;
  workspace_id: string;
  created_at: string;
}

/** Validate that a notebook belongs to the same workspace and exists. */
const validateNotebookInWorkspace = async (
  db: DatabaseAdapter,
  workspaceId: string,
  notebookId: string,
): Promise<boolean> => {
  const row = await db
    .prepare(`SELECT id FROM notebooks WHERE id = ? AND workspace_id = ? AND is_deleted = 0`)
    .bind(notebookId, workspaceId)
    .first<{ id: string }>();
  return row !== null;
};

/** Validate that a token belongs to the same workspace. */
const validateTokenInWorkspace = async (
  db: DatabaseAdapter,
  workspaceId: string,
  tokenId: string,
): Promise<boolean> => {
  const row = await db
    .prepare(`SELECT id FROM api_tokens WHERE id = ? AND workspace_id = ?`)
    .bind(tokenId, workspaceId)
    .first<{ id: string }>();
  return row !== null;
};

export const registerHidingRoutes = (
  app: Hono<AppEnv>,
  _dependencies: HidingRouteDependencies = {},
) => {
  // GET — list hidden notebook IDs for a token
  app.get("/api/v1/api-tokens/:id/hiding", async (c) => {
    const denied = requireOwner(c);
    if (denied) return denied;

    const tokenId = c.req.param("id");
    const workspaceId = getWorkspaceId(c);
    const db = c.env.storage.db;

    // Verify token belongs to this workspace
    const tokenValid = await validateTokenInWorkspace(db, workspaceId, tokenId);
    if (!tokenValid) {
      return c.json({ error: { code: "not_found", message: "Token not found" } }, 404);
    }

    const rows = await db
      .prepare(
        `SELECT notebook_id FROM mcp_token_hidden_notebooks
         WHERE token_id = ? AND workspace_id = ?
         ORDER BY created_at ASC`
      )
      .bind(tokenId, workspaceId)
      .all<{ notebook_id: string }>();

    return c.json({
      tokenId,
      hiddenNotebookIds: rows.results.map((r) => r.notebook_id),
    });
  });

  // PUT — replace hidden notebook set (full replace)
  app.put("/api/v1/api-tokens/:id/hiding", async (c) => {
    const denied = requireOwner(c);
    if (denied) return denied;

    const tokenId = c.req.param("id");
    const workspaceId = getWorkspaceId(c);
    const db = c.env.storage.db;

    // Verify token belongs to this workspace
    const tokenValid = await validateTokenInWorkspace(db, workspaceId, tokenId);
    if (!tokenValid) {
      return c.json({ error: { code: "not_found", message: "Token not found" } }, 404);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.hiddenNotebookIds)) {
      return c.json({
        error: { code: "invalid_request", message: "Expected { hiddenNotebookIds: string[] }" },
      }, 400);
    }

    const requestedIds = Array.from(new Set(
      body.hiddenNotebookIds.filter((id: unknown) => typeof id === "string" && id.trim()),
    )) as string[];

    // Validate all notebooks exist in this workspace
    for (const notebookId of requestedIds) {
      const valid = await validateNotebookInWorkspace(db, workspaceId, notebookId);
      if (!valid) {
        return c.json({
          error: {
            code: "not_found",
            message: `Notebook "${notebookId}" not found in this workspace`,
          },
        }, 404);
      }
    }

    // Full replace: delete existing, then insert new set
    // Use batch for atomicity
    const now = new Date().toISOString();
    const statements = [
      db
        .prepare(
          `DELETE FROM mcp_token_hidden_notebooks WHERE token_id = ? AND workspace_id = ?`
        )
        .bind(tokenId, workspaceId),
      ...requestedIds.map((notebookId) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO mcp_token_hidden_notebooks (token_id, notebook_id, workspace_id, created_at)
             VALUES (?, ?, ?, ?)`
          )
          .bind(tokenId, notebookId, workspaceId, now)
      ),
    ];

    await db.batch(statements);

    return c.json({
      tokenId,
      hiddenNotebookIds: requestedIds,
    });
  });
};
