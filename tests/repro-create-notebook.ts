/**
 * BUG-002 REPRO — investigation artifact (kept per MASTER decision Q7 = keep).
 *
 * Purpose: standalone script proving that the hiding wrapper wrongly filtered
 * OUT empty notebooks, which made `create_notebook` fail with
 * "Notebook not found after create" (404) on every call.
 * It is NOT a bun:test file (run manually: `bun tests/repro-create-notebook.ts`)
 * and is NOT part of `bun test` collection.
 *
 * Root cause (proven here, 2026-09-02):
 *   notebookSelectSql is `FROM notebooks n LEFT JOIN memos m ...`; the wrapper
 *   appended `m.notebook_id NOT IN (hidden)` to WHERE. For a notebook with zero
 *   memos the LEFT JOIN yields m.notebook_id = NULL, and SQL three-valued logic
 *   makes `NULL NOT IN (...)` evaluate to NULL → the whole row is dropped.
 *
 * Expected output BEFORE the fde-v1.50.0.3 NULL-safe fix:
 *   TEST 1 → "PASS — row: null"          (row absent, nothing inserted yet)
 *   TEST 2 → "FAIL — getNotebook returned NULL (reproduces bug!)"
 *   TEST 3 → "baseline PASS"             (same SQL without wrapper works)
 *
 * Expected output AFTER the fix (NULL-safe fragments in mcp-hiding.ts):
 *   TEST 2 → "PASS — getNotebook found row"
 * i.e. this script doubles as a manual before/after verification tool.
 *
 * Permanent regression coverage lives in:
 *   - tests/mcp-hiding-null-join.test.ts (empty-notebook visibility + leak guards)
 *
 * createNotebookRecord flow being reproduced (notebook-service.ts):
 *   1. batch([INSERT notebooks..., INSERT audit...])
 *   2. getNotebook() → notebookSelectSql with `WHERE n.id = ? AND n.workspace_id = ?`
 */
import { Database } from "bun:sqlite";

// ── Real schema (migrations/0001 minimal subset) ──
const db = new Database(":memory:");
db.exec(`
CREATE TABLE notebooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  sort_order INTEGER,
  icon TEXT,
  color TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE memos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  notebook_id TEXT,
  title TEXT,
  excerpt TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT,
  actor_id TEXT,
  action TEXT,
  entity_type TEXT,
  entity_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
`);

// ── Copy the exact rewrite from mcp-hiding.ts behavior ──
// Instead of importing (module has deps), simulate the two fragments:
// notebooks-driven rule: alias.id NOT IN (...)
// memos-driven rule: alias.notebook_id NOT IN (...)
const HIDDEN = ["nb_hidden_1", "nb_hidden_2"];

// We test the EXACT SQL from notebook-service.ts getNotebook (via notebookSelectSql):
const getNotebookSql = `
  SELECT n.id,
         n.parent_id,
         n.name,
         n.slug,
         n.icon,
         n.color,
         n.sort_order,
         COUNT(m.id) AS memo_count,
         MAX(m.updated_at) AS last_memo_updated_at,
         n.created_at,
         n.updated_at
  FROM notebooks n
  LEFT JOIN memos m ON m.notebook_id = n.id AND m.is_deleted = 0
  WHERE n.id = ? AND n.workspace_id = ? AND n.is_deleted = 0
   GROUP BY n.id, n.parent_id, n.name, n.slug, n.icon, n.color, n.sort_order, n.created_at, n.updated_at`;

// Import the real rewriter directly (it has no runtime deps beyond itself)
import { createHidingDatabase } from "../apps/api/src/mcp-hiding";
import type { DatabaseAdapter } from "../apps/api/src/storage-contract";

// Adapter for bun:sqlite matching storage-contract
const adapter = {
  prepare(sql: string) {
    const stmt = db.prepare(sql);
    return {
      bind(...args: unknown[]) {
        return {
          first: async <T>() => stmt.get(...(args as never[])) as T | null,
          all: async <T>() => ({ results: stmt.all(...(args as never[])) as T[] }),
          run: async () => stmt.run(...(args as never[])),
          raw: async () => stmt.raw.all(...(args as never[])),
        };
      },
      first: async <T>() => stmt.get() as T | null,
      all: async <T>() => ({ results: stmt.all() as T[] }),
      run: async () => stmt.run(),
      raw: async () => stmt.raw.all(),
    };
  },
  async batch(statements: unknown[]) {
    const results = [];
    for (const s of statements) {
      // batch statements are already bound — call run
      results.push(await s.run());
    }
    return results;
  },
} as unknown as DatabaseAdapter;

const wrapped = createHidingDatabase(adapter, new Set(HIDDEN));

console.log("=== TEST 1: getNotebook SQL through hiding wrapper ===");
try {
  const row = await wrapped
    .prepare(getNotebookSql)
    .bind("nb_test_1", "ws_default")
    .first();
  console.log("PASS — row:", row);
} catch (err) {
  console.log("FAIL:", (err as Error).message);
}

console.log("\n=== TEST 2: full create flow (batch INSERT then getNotebook) ===");
try {
  await wrapped.batch([
    wrapped
      .prepare(
        `INSERT INTO notebooks (id, workspace_id, parent_id, name, slug, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind("nb_test_1", "ws_default", null, "DZ_TEST", "dz_test", 1, "2026-09-02T00:00:00Z", "2026-09-02T00:00:00Z"),
    wrapped
      .prepare(
        `INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind("audit_1", "token", "tok_1", "notebook.create", "notebook", "nb_test_1", "{}", "2026-09-02T00:00:00Z"),
  ]);
  console.log("batch INSERT OK");

  const row = await wrapped
    .prepare(getNotebookSql)
    .bind("nb_test_1", "ws_default")
    .first();
  console.log(row ? "PASS — getNotebook found row" : "FAIL — getNotebook returned NULL (reproduces bug!)");
  if (!row) {
    // Show what the rewritten SQL actually produces by calling prepare directly
    console.log("\n=== DIAG: raw rows in notebooks table ===");
    console.log(db.prepare("SELECT id, name, is_deleted FROM notebooks").all());
    console.log("\n=== DIAG: intercept rewritten SQL via fake adapter ===");
  }
} catch (err) {
  console.log("FAIL:", (err as Error).message);
}

console.log("\n=== TEST 3: same SQL WITHOUT wrapper (baseline) ===");
const row = await adapter
  .prepare(getNotebookSql)
  .bind("nb_test_1", "ws_default")
  .first();
console.log(row ? "baseline PASS" : "baseline FAIL — row missing even unwrapped");
