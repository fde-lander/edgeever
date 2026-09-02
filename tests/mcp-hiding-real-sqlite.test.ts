/**
 * TDD RED-1 — Real SQLite execution tests for mcp-hiding SQL rewriting.
 *
 * BUG-001 fix validation: every rewritten SQL MUST execute against a real
 * bun:sqlite in-memory database (bun:sqlite 3.53.2) with the real migration
 * schema. toContain assertions alone are self-blind (DOUBT 2: old fixture
 * referenced an undefined CTE and still passed).
 *
 * Four RED tests (Phase 11, MASTER approved Q1=A / Q2=A / Q4 dedup):
 *   1. searchMemoSummaries FTS branch (real memo-service.ts SQL) — no ambiguity,
 *      FTS MATCH actually filtered, no duplicate injections
 *   2. list_memos includeDescendants=1 (D3) — nested IN-subquery id-set CTE
 *      must NOT be injected; rewritten SQL executes + isolation semantics hold
 *   3. isNotebookDescendant (D4) — notebooks-only tree-walk utility SQL must
 *      NOT be injected (Q2=A narrow whitelist); executes unchanged
 *   4. dedup — same (table, alias) referenced in CTE + outer level injects once
 *
 * Isolation semantics are verified by seeding visible vs hidden rows and
 * asserting the hidden ones never appear.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHidingDatabase } from "../apps/api/src/mcp-hiding";
import type {
  DatabaseAdapter,
  PreparedStatementAdapter,
} from "../apps/api/src/storage-contract";

// ─────────────────────────────────────────────────────────────
// Real schema (mirrors migrations/0001 + 0034, minimal columns needed)
// notebooks PK is single-column id TEXT (0001_initial.sql:4 real shape)
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
      excerpt TEXT DEFAULT '',
      tags_json TEXT DEFAULT '[]',
      is_pinned INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,
      is_deleted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT '',
      deleted_at TEXT
    );
    CREATE TABLE memo_contents (
      memo_id TEXT PRIMARY KEY REFERENCES memos(id),
      revision INTEGER DEFAULT 1,
      content_text TEXT DEFAULT ''
    );
    CREATE TABLE memo_search_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memo_id TEXT NOT NULL,
      title TEXT DEFAULT '',
      content_text TEXT DEFAULT '',
      tags TEXT DEFAULT ''
    );
    CREATE VIRTUAL TABLE memos_fts USING fts5(
      memo_id UNINDEXED, title, content_text, tags,
      content = 'memo_search_documents', content_rowid = 'id'
    );
    CREATE TABLE resources (
      id TEXT PRIMARY KEY,
      memo_id TEXT REFERENCES memos(id),
      is_deleted INTEGER DEFAULT 0
    );
    CREATE TABLE memo_tags (
      memo_id TEXT NOT NULL REFERENCES memos(id),
      name TEXT DEFAULT '',
      workspace_id TEXT DEFAULT '',
      normalized_name TEXT DEFAULT ''
    );
  `);

  // Seed: workspace ws1; visible nb_ok; hidden nb_hidden (+ child nb_hidden_child)
  db.exec(`
    INSERT INTO notebooks (id, workspace_id, parent_id, name) VALUES
      ('nb_ok', 'ws1', NULL, 'Visible'),
      ('nb_hidden', 'ws1', NULL, 'Hidden'),
      ('nb_hidden_child', 'ws1', 'nb_hidden', 'HiddenChild');
    INSERT INTO memos (id, workspace_id, notebook_id, title, excerpt) VALUES
      ('m_visible_1', 'ws1', 'nb_ok', 'coffee brewing guide', 'latte art'),
      ('m_visible_2', 'ws1', 'nb_ok', 'docker tutorial', 'containers'),
      ('m_hidden_1', 'ws1', 'nb_hidden', 'coffee secret', 'hidden latte'),
      ('m_hidden_2', 'ws1', 'nb_hidden_child', 'secret child memo', 'hidden child');
    INSERT INTO memo_contents (memo_id, content_text) VALUES
      ('m_visible_1', 'how to brew coffee with latte art'),
      ('m_visible_2', 'docker compose tutorial'),
      ('m_hidden_1', 'secret coffee notes'),
      ('m_hidden_2', 'secret child content');
    INSERT INTO memo_search_documents (memo_id, title, content_text) VALUES
      ('m_visible_1', 'coffee brewing guide', 'how to brew coffee with latte art'),
      ('m_visible_2', 'docker tutorial', 'docker compose tutorial'),
      ('m_hidden_1', 'coffee secret', 'secret coffee notes'),
      ('m_hidden_2', 'secret child memo', 'secret child content');
    INSERT INTO memos_fts(memos_fts) VALUES('rebuild');
  `);
  return db;
}

const HIDDEN_IDS = new Set(["nb_hidden", "nb_hidden_child"]);

/**
 * Wrap a real bun:sqlite Database with the hiding adapter by adapting
 * bun:sqlite's prepared statements to the DatabaseAdapter contract.
 * prepare() captures nothing — SQL actually EXECUTES.
 *
 * bun:sqlite Statement semantics: stmt.bind(...values) binds AND returns the
 * same statement (chainable); stmt.get/all/run accept values either bound or
 * inline. We track bound values ourselves because the adapter contract's
 * bind() must return a NEW statement-like object without mutating the old one
 * (HidingPreparedStatement wraps the result of bind()).
 */
function wrapRealDb(db: Database, hiddenIds: Set<string>): DatabaseAdapter {
  const adapter: DatabaseAdapter = {
    prepare(sql: string): PreparedStatementAdapter {
      // bun:sqlite prepare() = reusable prepared statement (query() is one-shot cached)
      const stmt = db.prepare(sql);
      const bound: unknown[] = [];
      const wrapped: PreparedStatementAdapter = {
        bind(...values: unknown[]) {
          // Adapter contract: bind() returns a new statement object holding
          // these values (immutability — old statement keeps old bindings).
          const newBound = [...bound, ...values];
          const newStmt: PreparedStatementAdapter = {
            bind(...more: unknown[]) {
              const newest = [...newBound, ...more];
              const s2: PreparedStatementAdapter = {
                bind: (...m2: unknown[]) => {
                  newest.push(...m2);
                  return s2;
                },
                first: async <T = unknown>() => (stmt.get(...(newest as never[])) ?? null) as T | null,
                run: async () => {
                  stmt.run(...(newest as never[]));
                  return { results: [], meta: {} } as never;
                },
                all: async <T2 = unknown>() => ({
                  results: stmt.all(...(newest as never[])) as T2[],
                  meta: {},
                } as never),
              };
              return s2;
            },
            first: async <T = unknown>() => (stmt.get(...(newBound as never[])) ?? null) as T | null,
            run: async () => {
              stmt.run(...(newBound as never[]));
              return { results: [], meta: {} } as never;
            },
            all: async <T2 = unknown>() => ({
              results: stmt.all(...(newBound as never[])) as T2[],
              meta: {},
            } as never),
          };
          return newStmt;
        },
        async first<T = unknown>(): Promise<T | null> {
          return (stmt.get(...(bound as never[])) ?? null) as T | null;
        },
        async run() {
          stmt.run(...(bound as never[]));
          return { results: [], meta: {} } as never;
        },
        async all<T = unknown>() {
          const results = stmt.all(...(bound as never[])) as T[];
          return { results, meta: {} } as never;
        },
      };
      return wrapped;
    },
    async batch<T = unknown>(statements: PreparedStatementAdapter[]) {
      const out: DatabaseQueryResult<T>[] = [];
      for (const s of statements) {
        out.push(await (s as unknown as { all: () => Promise<DatabaseQueryResult<T>> }).all());
      }
      return out;
    },
  } as unknown as DatabaseAdapter;

  return createHidingDatabase(adapter, hiddenIds);
}

// Import type for batch results
import type { DatabaseQueryResult } from "../apps/api/src/storage-contract";

// Real SQL from apps/api/src/memo-service.ts searchMemoSummaries FTS branch
// (exact structure as of fde-v1.50.0.2 baseline; placeholders match binds)
const SEARCH_FTS_SQL = `WITH raw_matches(memo_id, rank) AS (
  SELECT memo_id, bm25(memos_fts)
  FROM memos_fts
  WHERE memos_fts MATCH ?

  UNION ALL

  SELECT m.id, 100.0
  FROM memos m
  INNER JOIN memo_contents c ON c.memo_id = m.id
  WHERE m.title LIKE ? ESCAPE '\\'
     OR c.content_text LIKE ? ESCAPE '\\'
     OR m.tags_json LIKE ? ESCAPE '\\'
), search_matches AS (
  SELECT memo_id, MIN(rank) AS rank
  FROM raw_matches
  GROUP BY memo_id
)
SELECT m.id, m.notebook_id, m.title, m.excerpt, m.tags_json, m.is_pinned,
       m.is_archived, m.is_deleted, m.created_at, m.updated_at, m.deleted_at, c.revision,
       c.content_text
FROM search_matches s
INNER JOIN memos m ON m.id = s.memo_id
INNER JOIN memo_contents c ON c.memo_id = m.id
WHERE m.workspace_id = ? AND m.is_deleted = 0
ORDER BY s.rank ASC, m.is_pinned DESC, m.updated_at DESC
LIMIT ?`;

// Real SQL from apps/api/src/memo-list-service.ts includeNotebookDescendants branch
const LIST_DESCENDANTS_SQL = `SELECT m.id, m.title
FROM memos m
WHERE m.workspace_id = ?
  AND m.is_deleted = 0
  AND m.notebook_id IN (
    WITH RECURSIVE descendants(id) AS (
      SELECT id
      FROM notebooks
      WHERE workspace_id = ? AND id = ? AND is_deleted = 0
      UNION
      SELECT n.id
      FROM notebooks n
      INNER JOIN descendants d ON n.parent_id = d.id
      WHERE n.workspace_id = ? AND n.is_deleted = 0
    )
    SELECT id FROM descendants
  )
ORDER BY m.is_pinned DESC, m.updated_at DESC
LIMIT ?`;

// Real SQL from apps/api/src/notebook-service.ts isNotebookDescendant
const NOTEBOOK_DESCENDANT_SQL = `WITH RECURSIVE descendants(id) AS (
  SELECT id
  FROM notebooks
  WHERE workspace_id = ? AND parent_id = ? AND is_deleted = 0

  UNION ALL

  SELECT n.id
  FROM notebooks n
  INNER JOIN descendants d ON n.parent_id = d.id
  WHERE n.workspace_id = ? AND n.is_deleted = 0
)
SELECT id
FROM descendants
WHERE id = ?
LIMIT 1`;

describe("mcp-hiding real-SQLite execution (BUG-001 fix)", () => {
  test("search FTS branch: rewritten SQL executes with NO ambiguity + hidden memos excluded", async () => {
    const db = createTestDb();
    const hiding = wrapRealDb(db, HIDDEN_IDS);

    const rows = await hiding
      .prepare(SEARCH_FTS_SQL)
      .bind("coffee", "%coffee%", "%coffee%", "%coffee%", "ws1", 50)
      .all<{ id: string }>();

    // Must not throw "ambiguous column name: memo_id" (BUG-001 symptom)
    const ids = rows.results.map((r) => r.id).sort();
    expect(ids).toEqual(["m_visible_1"]); // hidden coffee memo excluded, visible one present
  });

  test("search FTS branch: FTS MATCH actually filtered (no full-table dilution)", async () => {
    const db = createTestDb();
    const hiding = wrapRealDb(db, HIDDEN_IDS);

    const rows = await hiding
      .prepare(SEARCH_FTS_SQL)
      .bind("docker", "%docker%", "%docker%", "%docker%", "ws1", 50)
      .all<{ id: string }>();

    const ids = rows.results.map((r) => r.id);
    expect(ids).toEqual(["m_visible_2"]);
  });

  test("D3: list_memos includeDescendants — nested id-set CTE not injected, executes, hidden excluded", async () => {
    const db = createTestDb();
    const hiding = wrapRealDb(db, HIDDEN_IDS);

    // List descendants of nb_ok (visible root) — must only return its memos
    const stmt1 = hiding.prepare(LIST_DESCENDANTS_SQL).bind("ws1", "ws1", "nb_ok", "ws1", 50);
    const rows = await stmt1.all<{ id: string }>();
    const ids = rows.results.map((r) => r.id).sort();

    // Must not throw "no such column: notebooks.id" (D3 symptom)
    expect(ids).toEqual(["m_visible_1", "m_visible_2"]);

    // Isolation semantics: hidden-child memo never appears even when the
    // traversal root is nb_ok (its CTE can't reach hidden ids anyway, but if
    // the root were hidden the outer NOT IN guard must hold)
    const stmt2 = hiding.prepare(LIST_DESCENDANTS_SQL).bind("ws1", "ws1", "nb_hidden", "ws1", 50);
    const hiddenRoot = (await stmt2.all<{ id: string }>()).results.map((r) => r.id);
    expect(hiddenRoot).toEqual([]); // outer m.notebook_id NOT IN filters hidden root's memos
  });

  test("D4: isNotebookDescendant — notebooks-only utility SQL passes through UNCHANGED and executes", async () => {
    const db = createTestDb();
    const hiding = wrapRealDb(db, HIDDEN_IDS);

    // nb_hidden_child IS a descendant of nb_hidden → true
    const stmt1 = hiding.prepare(NOTEBOOK_DESCENDANT_SQL).bind("ws1", "nb_hidden", "ws1", "nb_hidden_child");
    const isChild = await stmt1.first<{ id: string }>();
    expect(isChild).not.toBeNull();
    expect(isChild!.id).toBe("nb_hidden_child");

    // nb_ok is NOT a descendant of nb_hidden → null
    const stmt2 = hiding.prepare(NOTEBOOK_DESCENDANT_SQL).bind("ws1", "nb_hidden", "ws1", "nb_ok");
    const notChild = await stmt2.first<unknown>();
    expect(notChild).toBeNull();
  });

  test("dedup: same (table, alias) referenced in CTE and outer level injects ONCE each", () => {
    const db = createTestDb();
    const capturing: string[] = [];

    // Capture-only adapter: records the rewritten SQL but NEVER executes it
    // (all() returns empty without touching SQLite — no binds needed).
    const captureDb: DatabaseAdapter = {
      prepare(sql: string) {
        capturing.push(sql);
        return {
          bind: () => {
            return {
              first: async () => null,
              run: async () => ({ results: [], meta: {} }),
              all: async () => ({ results: [], meta: {} }),
            } as unknown as PreparedStatementAdapter;
          },
          first: async () => null,
          run: async () => ({ results: [], meta: {} }),
          all: async () => ({ results: [], meta: {} }),
        } as unknown as PreparedStatementAdapter;
      },
      batch: async () => [],
    } as unknown as DatabaseAdapter;
    const captureHiding = createHidingDatabase(captureDb, HIDDEN_IDS);
    captureHiding.prepare(SEARCH_FTS_SQL);
    const rewritten = capturing[0];

    // fragments must appear exactly once
    const countOccurrences = (haystack: string, needle: string) =>
      haystack.split(needle).length - 1;
    expect(countOccurrences(rewritten, "m.notebook_id NOT IN")).toBe(1);
    expect(
      countOccurrences(rewritten, "c.memo_id NOT IN (SELECT id FROM memos")
    ).toBe(1);
    // bare memo_id must NOT land in the outer WHERE (BUG-001 root cause)
    expect(
      /WHERE m\.workspace_id = \? AND m\.is_deleted = 0 AND memo_id NOT IN/.test(rewritten)
    ).toBe(false);
    // FTS branch DOES get its scoped injection (inside CTE, after MATCH)
    expect(/memos_fts MATCH \? AND memo_id NOT IN/.test(rewritten)).toBe(true);
  });
});
