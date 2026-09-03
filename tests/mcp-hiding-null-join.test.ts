/**
 * TDD RED-1 — BUG-002 / BUG-002b regression guards (fde-v1.50.0.3).
 *
 * BUG-002: the hiding wrapper injects `NOT IN (...)` into the outer WHERE of
 * queries whose driving table is LEFT JOINed to memos. For a notebook with zero
 * memos the joined column is NULL, and SQL three-valued logic makes
 * `NULL NOT IN (...)` evaluate to NULL → the whole row is dropped. Symptom:
 * create_notebook returned "Notebook not found after create" 100% of the time and
 * every empty notebook was invisible through MCP/REST while the web session
 * (no wrapper) saw them fine.
 *
 * BUG-002b: the same defect exists in the `MEMO_ID_SUBQUERY` fragment builder,
 * which serves memo_contents / memo_revisions / resources /
 * memo_search_documents / memo_tags / memos_fts. `memos m LEFT JOIN
 * memo_contents c` therefore drops any memo without a content row.
 *
 * These tests run the REAL wrapper against a REAL bun:sqlite database with the
 * REAL production SQL templates. toContain-style assertions are not enough here
 * (see mcp-hiding-real-sqlite.test.ts header): the bug is a semantic one that
 * only shows up when the rewritten SQL actually executes.
 *
 * T1-T4 assert the bug is fixed (they FAIL before the NULL-safe patch).
 * T5-T8 assert the isolation guarantee is NOT weakened by the fix (they PASS
 * both before and after — they are the safety net that stops a future "fix"
 * from simply letting hidden rows through).
 *
 * Fixture schema mirrors migrations/0001_initial.sql (notebooks PK is the single
 * column `id TEXT PRIMARY KEY` — a composite PK causes `foreign key mismatch`).
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHidingDatabase } from "../apps/api/src/mcp-hiding";
import { notebookSelectSql } from "../apps/api/src/notebook-service";
import type {
  DatabaseAdapter,
  DatabaseQueryResult,
  PreparedStatementAdapter,
} from "../apps/api/src/storage-contract";

// ─────────────────────────────────────────────────────────────
// Fixture: 4 notebooks covering the empty/hidden matrix, plus a memo with no
// memo_contents row (the BUG-002b trigger).
// ─────────────────────────────────────────────────────────────

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE notebooks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      parent_id TEXT REFERENCES notebooks(id),
      name TEXT NOT NULL,
      slug TEXT,
      icon TEXT,
      color TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE memos (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      notebook_id TEXT NOT NULL REFERENCES notebooks(id),
      title TEXT DEFAULT '',
      excerpt TEXT DEFAULT '',
      tags_json TEXT DEFAULT '[]',
      is_pinned INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      deleted_at TEXT,
      source_memo_ids TEXT,
      merge_source_count INTEGER DEFAULT 0,
      merged_into_memo_id TEXT
    );
    CREATE TABLE memo_contents (
      memo_id TEXT PRIMARY KEY REFERENCES memos(id),
      revision INTEGER DEFAULT 1,
      content_json TEXT DEFAULT '',
      content_markdown TEXT DEFAULT '',
      content_text TEXT NOT NULL DEFAULT '',
      content_hash TEXT DEFAULT ''
    );
    CREATE TABLE resources (
      id TEXT PRIMARY KEY,
      memo_id TEXT NOT NULL REFERENCES memos(id),
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    INSERT INTO notebooks (id, workspace_id, name, sort_order) VALUES
      ('nb_ok', 'ws1', 'Empty-A-Has-Memos', 10),
      ('nb_empty', 'ws1', 'Empty-B-No-Memos', 20),
      ('nb_hidden', 'ws1', 'Secret-Has-Memos', 30),
      ('nb_hidden_empty', 'ws1', 'Secret-No-Memos', 40);
    INSERT INTO memos (id, workspace_id, notebook_id, title) VALUES
      ('m_ok', 'ws1', 'nb_ok', 'visible with content'),
      ('m_nocontent', 'ws1', 'nb_ok', 'visible WITHOUT memo_contents row'),
      ('m_hid', 'ws1', 'nb_hidden', 'hidden with content');
    INSERT INTO memo_contents (memo_id, content_text) VALUES
      ('m_ok', 'visible body'),
      ('m_hid', 'secret body');
    INSERT INTO resources (id, memo_id, is_deleted) VALUES
      ('r_ok', 'm_ok', 0),
      ('r_hid', 'm_hid', 0);
  `);
  return db;
}

const HIDDEN_IDS = new Set(["nb_hidden", "nb_hidden_empty"]);

/**
 * Adapter over a real bun:sqlite Database. bind() returns a NEW statement
 * object (the adapter contract requires immutability because the hiding
 * wrapper wraps the result of bind()). Uses db.prepare() — NOT db.query(),
 * whose one-shot cache throws "datatype mismatch" on reuse.
 */
function wrapRealDb(db: Database, hiddenIds: Set<string>): DatabaseAdapter {
  const makeStatement = (sql: string, bound: unknown[]): PreparedStatementAdapter => ({
    bind: (...values: unknown[]) => makeStatement(sql, [...bound, ...values]),
    first: async <T = unknown>(): Promise<T | null> =>
      (db.prepare(sql).get(...(bound as never[])) ?? null) as T | null,
    run: async <T = unknown>(): Promise<DatabaseQueryResult<T>> => {
      db.prepare(sql).run(...(bound as never[]));
      return { results: [], success: true, meta: {} } as unknown as DatabaseQueryResult<T>;
    },
    all: async <T = unknown>(): Promise<DatabaseQueryResult<T>> =>
      ({
        results: db.prepare(sql).all(...(bound as never[])) as T[],
        success: true,
        meta: {},
      }) as unknown as DatabaseQueryResult<T>,
  });

  const adapter: DatabaseAdapter = {
    prepare: (sql: string) => makeStatement(sql, []),
    batch: async () => [],
  } as unknown as DatabaseAdapter;

  return createHidingDatabase(adapter, hiddenIds);
}

// Real production SQL — notebook-service.ts:54-63 (listNotebooks tail)
const LIST_NOTEBOOKS_TAIL = `WHERE n.workspace_id = ? AND n.is_deleted = 0
         GROUP BY n.id, n.parent_id, n.name, n.slug, n.icon, n.color, n.sort_order, n.created_at, n.updated_at
         ORDER BY n.parent_id IS NOT NULL, n.sort_order ASC, n.name ASC`;

// Real production SQL — notebook-service.ts:130-139 (getNotebook tail); this is
// also the read that createNotebookRecord / deleteNotebookRecord verify with.
const GET_NOTEBOOK_TAIL = `WHERE n.id = ? AND n.workspace_id = ? AND n.is_deleted = 0
         GROUP BY n.id, n.parent_id, n.name, n.slug, n.icon, n.color, n.sort_order, n.created_at, n.updated_at`;

// Real production SQL — sync-routes.ts:70-76 (GET /sync/bootstrap notebooks)
const SYNC_BOOTSTRAP_NOTEBOOKS_SQL = `SELECT n.id, n.parent_id, n.name, n.slug, n.icon, n.color, n.sort_order,
                n.created_at, n.updated_at, COUNT(m.id) AS memo_count, MAX(m.updated_at) AS last_memo_updated_at
         FROM notebooks n
         LEFT JOIN memos m ON m.notebook_id = n.id AND m.workspace_id = n.workspace_id AND m.is_deleted = 0
         WHERE n.workspace_id = ? AND n.is_deleted = 0
         GROUP BY n.id, n.parent_id, n.name, n.slug, n.icon, n.color, n.sort_order, n.created_at, n.updated_at
         ORDER BY n.sort_order ASC, n.name ASC`;

// memos LEFT JOIN memo_contents — the BUG-002b shape (index.ts:588-589 demo seed
// and any future upstream LEFT JOIN on a memo_* table).
const MEMOS_LEFT_JOIN_CONTENTS_SQL = `SELECT m.id, c.content_text
   FROM memos m
   LEFT JOIN memo_contents c ON c.memo_id = m.id
   WHERE m.workspace_id = ? AND m.is_deleted = 0
   ORDER BY m.id`;

const MEMOS_INNER_JOIN_CONTENTS_SQL = `SELECT m.id
   FROM memos m
   INNER JOIN memo_contents c ON c.memo_id = m.id
   WHERE m.workspace_id = ? AND m.is_deleted = 0
   ORDER BY m.id`;

const RESOURCES_JOIN_MEMOS_SQL = `SELECT r.id
   FROM resources r
   INNER JOIN memos m ON m.id = r.memo_id
   WHERE m.workspace_id = ? AND r.is_deleted = 0
   ORDER BY r.id`;

const RESOURCES_STANDALONE_SQL = `SELECT r.id FROM resources r WHERE r.is_deleted = 0 ORDER BY r.id`;

describe("mcp-hiding NULL-safe injection (BUG-002 / BUG-002b)", () => {
  // ── T1-T4: the bug. These FAIL before the NULL-safe patch. ──

  test("T1 listNotebooks: a notebook with zero memos is still returned (memo_count 0)", async () => {
    const hiding = wrapRealDb(createTestDb(), HIDDEN_IDS);

    const rows = await hiding
      .prepare(notebookSelectSql(LIST_NOTEBOOKS_TAIL))
      .bind("ws1")
      .all<{ id: string; memo_count: number }>();

    const summary = rows.results.map((r) => `${r.id}:${r.memo_count}`);
    expect(summary).toEqual(["nb_ok:2", "nb_empty:0"]);
  });

  test("T2 getNotebook: an empty notebook is findable by id (create/delete verify read)", async () => {
    const hiding = wrapRealDb(createTestDb(), HIDDEN_IDS);

    const row = await hiding
      .prepare(notebookSelectSql(GET_NOTEBOOK_TAIL))
      .bind("nb_empty", "ws1")
      .first<{ id: string; memo_count: number }>();

    expect(row).not.toBeNull();
    expect(row!.id).toBe("nb_empty");
    expect(row!.memo_count).toBe(0);
  });

  test("T3 memos LEFT JOIN memo_contents: a memo without a content row survives", async () => {
    const hiding = wrapRealDb(createTestDb(), HIDDEN_IDS);

    const rows = await hiding
      .prepare(MEMOS_LEFT_JOIN_CONTENTS_SQL)
      .bind("ws1")
      .all<{ id: string }>();

    const ids = rows.results.map((r) => r.id);
    expect(ids).toEqual(["m_nocontent", "m_ok"]);
  });

  test("T4 sync bootstrap notebooks SQL: empty notebook present for REST agents", async () => {
    const hiding = wrapRealDb(createTestDb(), HIDDEN_IDS);

    const rows = await hiding
      .prepare(SYNC_BOOTSTRAP_NOTEBOOKS_SQL)
      .bind("ws1")
      .all<{ id: string }>();

    const ids = rows.results.map((r) => r.id).sort();
    expect(ids).toEqual(["nb_empty", "nb_ok"]);
  });

  // ── T5-T8: the isolation guarantee. These must PASS before AND after. ──

  test("T5 getNotebook: a HIDDEN notebook with zero memos stays invisible", async () => {
    const hiding = wrapRealDb(createTestDb(), HIDDEN_IDS);

    const row = await hiding
      .prepare(notebookSelectSql(GET_NOTEBOOK_TAIL))
      .bind("nb_hidden_empty", "ws1")
      .first<{ id: string }>();

    expect(row).toBeNull();
  });

  test("T6 getNotebook: a HIDDEN notebook with memos stays invisible", async () => {
    const hiding = wrapRealDb(createTestDb(), HIDDEN_IDS);

    const row = await hiding
      .prepare(notebookSelectSql(GET_NOTEBOOK_TAIL))
      .bind("nb_hidden", "ws1")
      .first<{ id: string }>();

    expect(row).toBeNull();
  });

  test("T7 listNotebooks / memos join: hidden notebooks and their memos never appear", async () => {
    const hiding = wrapRealDb(createTestDb(), HIDDEN_IDS);

    // Pure isolation guard: assert only on the ABSENCE of hidden rows so this
    // test passes before AND after the NULL-safe patch. T1 owns the positive
    // assertion that nb_empty must be present.
    const notebooks = await hiding
      .prepare(notebookSelectSql(LIST_NOTEBOOKS_TAIL))
      .bind("ws1")
      .all<{ id: string }>();
    const notebookIds = notebooks.results.map((r) => r.id);
    expect(notebookIds).not.toContain("nb_hidden");
    expect(notebookIds).not.toContain("nb_hidden_empty");

    const memos = await hiding
      .prepare(MEMOS_INNER_JOIN_CONTENTS_SQL)
      .bind("ws1")
      .all<{ id: string }>();
    expect(memos.results.map((r) => r.id)).toEqual(["m_ok"]);
  });

  test("T8 resources: hidden memo's resource excluded via JOIN and standalone SELECT", async () => {
    const hiding = wrapRealDb(createTestDb(), HIDDEN_IDS);

    const joined = await hiding
      .prepare(RESOURCES_JOIN_MEMOS_SQL)
      .bind("ws1")
      .all<{ id: string }>();
    expect(joined.results.map((r) => r.id)).toEqual(["r_ok"]);

    const standalone = await hiding
      .prepare(RESOURCES_STANDALONE_SQL)
      .all<{ id: string }>();
    expect(standalone.results.map((r) => r.id)).toEqual(["r_ok"]);
  });
});
