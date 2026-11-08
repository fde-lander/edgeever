/**
 * TDD — poster_render_jobs (0066) wrapper isolation（SPEC V1.2 §6.1, Q4）
 *
 * Upstream v2.23.0 adds `poster_render_jobs`: one row per pending/completed
 * client-side poster render, linked to a memo via memo_id. It is a NEW leak
 * surface: the read helpers in poster-render-service.ts SELECT from the table
 * directly, with no JOIN memos, so the existing `memos` rule cannot cover them.
 *
 * Without an INJECTION_RULES entry, an agent token can read a hidden memo's
 * render job (template id, revision, status, timestamps) and poll its progress.
 *
 * TDD order (as written in the SPEC):
 *   step 1 — T2 + T3 only, watch T3 go RED
 *   step 2 — add the one-line rule, watch T3 go GREEN
 *   step 3 — add T1 / T4 / T5, all green
 *
 * Fixture schema mirrors migrations/0001_initial.sql + 0066_poster_render_jobs.sql.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createHidingDatabase } from "../apps/api/src/mcp-hiding";
import type {
  DatabaseAdapter,
  DatabaseQueryResult,
  PreparedStatementAdapter,
} from "../apps/api/src/storage-contract";

// ─────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE notebooks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      parent_id TEXT REFERENCES notebooks(id),
      name TEXT DEFAULT '',
      is_deleted INTEGER DEFAULT 0
    );
    CREATE TABLE memos (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      notebook_id TEXT REFERENCES notebooks(id),
      title TEXT DEFAULT '',
      content_markdown TEXT DEFAULT '',
      revision INTEGER DEFAULT 0,
      is_deleted INTEGER DEFAULT 0
    );
    CREATE TABLE poster_render_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      memo_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL,
      template_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','rendering','completed','failed')),
      claim_token TEXT,
      expires_at TEXT NOT NULL,
      result_revision INTEGER,
      error_code TEXT,
      created_at TEXT NOT NULL,
      commit_guard INTEGER NOT NULL DEFAULT 1 CHECK(commit_guard = 1)
    );
  `);

  db.exec(`
    INSERT INTO notebooks (id, workspace_id, name) VALUES
      ('nb_ok', 'ws1', 'Visible'),
      ('nb_hidden', 'ws1', 'Hidden');
    INSERT INTO memos (id, workspace_id, notebook_id, title, content_markdown) VALUES
      ('m_visible', 'ws1', 'nb_ok', 'visible poster', 'poster doc'),
      ('m_hidden', 'ws1', 'nb_hidden', 'hidden poster', 'poster doc');
    INSERT INTO poster_render_jobs
      (id, workspace_id, memo_id, expected_revision, template_id, status, expires_at, created_at) VALUES
      ('job_visible', 'ws1', 'm_visible', 1, 'tpl_a', 'pending', '2030-01-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z'),
      ('job_hidden',  'ws1', 'm_hidden',  1, 'tpl_b', 'pending', '2030-01-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z');
  `);

  return db;
}

/** Wrap bun:sqlite Database as DatabaseAdapter (same shape as table_forms test). */
function wrapDb(db: Database): DatabaseAdapter {
  return {
    prepare(sql: string): PreparedStatementAdapter {
      const stmt = db.prepare(sql);
      return {
        bind(...vals: unknown[]) {
          const bound = db.prepare(sql);
          return {
            bind(...v: unknown[]) { return this; },
            async all<T = Record<string, unknown>>() {
              return { results: bound.all(...vals) as T[], success: true as const, meta: {} };
            },
            async first<T = unknown>(col?: string) {
              const row = bound.get(...vals);
              if (!row) return null;
              if (col && typeof row === "object") return (row as Record<string, unknown>)[col] as T;
              return row as T;
            },
            async run<T = Record<string, unknown>>() {
              bound.run(...vals);
              return { results: [] as T[], success: true as const, meta: {} };
            },
          } as PreparedStatementAdapter;
        },
        async all<T = Record<string, unknown>>() {
          return { results: stmt.all() as T[], success: true as const, meta: {} };
        },
        async first<T = unknown>(col?: string) {
          const row = stmt.get();
          if (!row) return null;
          if (col && typeof row === "object") return (row as Record<string, unknown>)[col] as T;
          return row as T;
        },
        async run<T = Record<string, unknown>>() {
          stmt.run();
          return { results: [] as T[], success: true as const, meta: {} };
        },
      };
    },
    async batch<T = unknown>(statements: PreparedStatementAdapter[]): Promise<DatabaseQueryResult<T>[]> {
      const results: DatabaseQueryResult<T>[] = [];
      for (const stmt of statements) {
        await stmt.run();
        results.push({ results: [], success: true, meta: {} });
      }
      return results;
    },
  };
}

describe("poster_render_jobs hiding wrapper (SPEC V1.2 Q4)", () => {
  let rawDb: Database;
  let hidingDb: DatabaseAdapter;

  beforeEach(() => {
    rawDb = createTestDb();
    hidingDb = createHidingDatabase(wrapDb(rawDb), new Set(["nb_hidden"]));
  });

  // Real read helper from poster-render-service.ts L19-20 (readPosterRenderJob).
  const readJobSql =
    "SELECT * FROM poster_render_jobs WHERE workspace_id = ? AND id = ?";

  test("T2: visible memo's render job is readable via readPosterRenderJob", async () => {
    const row = await hidingDb.prepare(readJobSql).bind("ws1", "job_visible").first<{ id: string }>();
    expect(row?.id).toBe("job_visible");
  });

  test("T3: hidden memo's render job is NOT visible to an agent (direct SELECT)", async () => {
    // RED before the rule exists: this returns job_hidden and leaks template id,
    // revision, status and timestamps of a memo the agent must not see.
    const row = await hidingDb.prepare(readJobSql).bind("ws1", "job_hidden").first<{ id: string }>();
    expect(row).toBeNull();
  });

  test("T1: unpaginated SELECT over poster_render_jobs filters hidden rows only", async () => {
    const result = await hidingDb
      .prepare("SELECT id, memo_id, status FROM poster_render_jobs")
      .all<{ id: string; memo_id: string; status: string }>();
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("job_visible");
    expect(ids).not.toContain("job_hidden");
  });

  test("T4: orphan job (memo_id points to a non-existent memo) is NOT dropped (NULL-safe)", async () => {
    rawDb.exec(
      `INSERT INTO poster_render_jobs
        (id, workspace_id, memo_id, expected_revision, status, expires_at, created_at)
       VALUES ('job_orphan', 'ws1', 'm_ghost', 1, 'pending', '2030-01-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z')`
    );
    const result = await hidingDb
      .prepare("SELECT id FROM poster_render_jobs WHERE id = ?")
      .bind("job_orphan")
      .all<{ id: string }>();
    // An orphan belongs to no hidden notebook, so a NOT IN subquery must not
    // swallow it (BUG-002 lesson: `NULL NOT IN (...)` filters the row away).
    expect(result.results.map((r) => r.id)).toContain("job_orphan");
  });

  test("T5: rewritten SQL executes cleanly and the hidden job stays 404-shaped", async () => {
    // Executes the real rewritten statement rather than only asserting text,
    // guarding against BUG-001-style ambiguity or SQL that no longer parses.
    const visible = await hidingDb.prepare(readJobSql).bind("ws1", "job_visible").first<{ id: string }>();
    expect(visible?.id).toBe("job_visible");
    const hidden = await hidingDb.prepare(readJobSql).bind("ws1", "job_hidden").first<{ id: string }>();
    expect(hidden).toBeNull();
  });
});
