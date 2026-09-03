/**
 * 9.4 HidingDatabaseAdapter — TDD test
 *
 * Tests the core mcp-hiding.ts module:
 * 1. SQL tokenizer correctness
 * 2. Table reference + alias detection
 * 3. SELECT rewriting for 8 content tables
 * 4. FTS5 double-insurance (CTE internal + outer)
 * 5. fail-closed behavior
 * 6. INSERT/UPDATE/DELETE passthrough
 * 7. batch unwrap
 * 8. Empty hidden set passthrough
 * 9. loadHiddenNotebookIds recursive CTE
 * 10. Write guard helpers
 */
import { describe, expect, test } from "bun:test";
import {
  createHidingDatabase,
  createHidingDatabaseWithSymbol,
  getHidingSet,
  isNotebookHidden,
  loadHiddenNotebookIds,
} from "../apps/api/src/mcp-hiding";
import type {
  DatabaseAdapter,
  DatabaseQueryResult,
  PreparedStatementAdapter,
} from "../apps/api/src/storage-contract";

// ─────────────────────────────────────────────────────────────
// Mock implementations
// ─────────────────────────────────────────────────────────────

class MockStatement implements PreparedStatementAdapter {
  constructor(
    public readonly sql: string,
    public readonly binds: unknown[] = [],
    public mockResults: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new MockStatement(this.sql, values, this.mockResults);
  }

  async all<T = Record<string, unknown>>(): Promise<DatabaseQueryResult<T>> {
    return { results: [...this.mockResults] as T[], success: true, meta: {} };
  }

  async first<T = unknown>(columnName?: string): Promise<T | null> {
    if (this.mockResults.length === 0) return null;
    const row = this.mockResults[0] as Record<string, unknown>;
    if (columnName === undefined) return row as T;
    return (row?.[columnName] ?? null) as T;
  }

  async run<T = Record<string, unknown>>(): Promise<DatabaseQueryResult<T>> {
    return { results: [], success: true, meta: {} };
  }
}

class MockDatabaseAdapter implements DatabaseAdapter {
  public preparedSqls: string[] = [];
  public batchCalls = 0;
  public lastBatchStatements: PreparedStatementAdapter[] = [];

  constructor(public mockResults: unknown[] = []) {}

  prepare(sql: string) {
    this.preparedSqls.push(sql);
    return new MockStatement(sql, [], this.mockResults);
  }

  async batch<T = unknown>(statements: PreparedStatementAdapter[]): Promise<DatabaseQueryResult<T>[]> {
    this.batchCalls++;
    this.lastBatchStatements = statements;
    // Simulate instanceof check like self-hosted-storage-adapter.ts:76
    for (const stmt of statements) {
      if (!(stmt instanceof MockStatement)) {
        throw new TypeError("Mock batches can only execute MockStatement instances");
      }
    }
    return statements.map(() => ({ results: [], success: true, meta: {} }));
  }
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe("9.4 HidingDatabaseAdapter", () => {
  const hiddenIds = new Set(["nb_secret_1", "nb_secret_2"]);

  // ── Empty set passthrough ──

  test("empty hidden set returns underlying db directly (passthrough)", () => {
    const underlying = new MockDatabaseAdapter();
    const result = createHidingDatabase(underlying, new Set());
    expect(result).toBe(underlying); // same reference, zero overhead
  });

  // ── memos SELECT ──

  test("memos SELECT with alias m → inject m.notebook_id NOT IN", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    hiding.prepare("SELECT m.id, m.title FROM memos m WHERE m.workspace_id = ?");
    expect(underlying.preparedSqls[0]).toContain("m.notebook_id NOT IN");
    expect(underlying.preparedSqls[0]).toContain("'nb_secret_1'");
    expect(underlying.preparedSqls[0]).toContain("'nb_secret_2'");
  });

  // ── notebooks SELECT ──

  test("notebooks SELECT with alias n → inject n.id NOT IN", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    hiding.prepare("SELECT n.id, n.name FROM notebooks n WHERE n.workspace_id = ?");
    expect(underlying.preparedSqls[0]).toContain("n.id NOT IN");
    expect(underlying.preparedSqls[0]).toContain("'nb_secret_1'");
  });

  // ── notebooks + memos JOIN (notebook-service notebookSelectSql pattern) ──

  test("notebooks LEFT JOIN memos → inject both n.id NOT IN + m.notebook_id NOT IN", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    hiding.prepare(
      "SELECT n.id, n.name FROM notebooks n LEFT JOIN memos m ON m.notebook_id = n.id AND m.is_deleted = 0 WHERE n.workspace_id = ?"
    );
    const sql = underlying.preparedSqls[0];
    expect(sql).toContain("n.id NOT IN");
    expect(sql).toContain("m.notebook_id NOT IN");
  });

  // ── memos + memo_contents JOIN ──

  test("memos JOIN memo_contents → inject m.notebook_id NOT IN", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    hiding.prepare(
      "SELECT m.id, m.title FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id WHERE m.workspace_id = ?"
    );
    expect(underlying.preparedSqls[0]).toContain("m.notebook_id NOT IN");
  });

  // ── memos JOIN memo_contents with alias mc ──

  test("memos JOIN memo_contents mc → inject m.notebook_id NOT IN", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    hiding.prepare(
      "SELECT m.id FROM memos m INNER JOIN memo_contents mc ON mc.memo_id = m.id WHERE m.workspace_id = ?"
    );
    expect(underlying.preparedSqls[0]).toContain("m.notebook_id NOT IN");
  });

  // ── resources SELECT ──

  test("resources SELECT → inject memo_id subquery NOT IN", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    hiding.prepare(
      "SELECT r.id, r.memo_id FROM resources r WHERE r.is_deleted = 0 AND r.memo_id IN (?, ?)"
    );
    expect(underlying.preparedSqls[0]).toContain("memo_id NOT IN");
    expect(underlying.preparedSqls[0]).toContain("SELECT id FROM memos WHERE notebook_id IN");
  });

  // ── memo_tags SELECT ──

  test("memo_tags SELECT → inject memo_id subquery NOT IN", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    hiding.prepare(
      "SELECT mt.name, COUNT(*) FROM memo_tags mt WHERE mt.workspace_id = ? GROUP BY mt.name"
    );
    expect(underlying.preparedSqls[0]).toContain("memo_id NOT IN");
    expect(underlying.preparedSqls[0]).toContain("SELECT id FROM memos WHERE notebook_id IN");
  });

  // ── FTS5 CTE query (memo-list-service pattern) ──

  test("FTS5 CTE query → inject memo_id NOT IN in FTS subquery", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    // Fixture must be VALID SQL (real CTE definitions) so that real-SQLite
    // execution assertions (BUG-001 fix) can run against it. The old fixture
    // referenced an undefined `search_matches` CTE — toContain assertions
    // passed but the SQL itself was broken (self-blind test, DOUBT 2).
    const sql = `WITH raw_matches(memo_id, rank) AS (
      SELECT memo_id, bm25(memos_fts) FROM memos_fts WHERE memos_fts MATCH ?
      UNION ALL
      SELECT m.id, 100.0 FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id
      WHERE m.title LIKE ? ESCAPE '\\\\'
    ), search_matches AS (
      SELECT memo_id, MIN(rank) AS rank FROM raw_matches GROUP BY memo_id
    )
    SELECT m.id, m.notebook_id FROM search_matches s
    INNER JOIN memos m ON m.id = s.memo_id
    INNER JOIN memo_contents mc ON mc.memo_id = m.id
    WHERE m.workspace_id = ?`;

    hiding.prepare(sql);
    const rewritten = underlying.preparedSqls[0];

    // FTS table should get memo_id NOT IN subquery
    expect(rewritten).toContain("memo_id NOT IN");
    // memos table should get m.notebook_id NOT IN
    expect(rewritten).toContain("m.notebook_id NOT IN");
    // BUG-001 fix: FTS injection must be INSIDE the CTE (after MATCH), not
    // appended as a bare memo_id to the outer WHERE (ambiguity source).
    // BUG-002b: the fragment is now NULL-safe, hence the parenthesised form.
    expect(rewritten).toMatch(/memos_fts MATCH \? AND \(memo_id IS NULL OR memo_id NOT IN/);
    expect(rewritten).not.toMatch(/WHERE m\.workspace_id = \? AND memo_id NOT IN/);
  });

  // ── stats COUNT query (workspace-stats-service pattern) ──

  test("stats COUNT FROM memos (no alias) → inject memos.notebook_id NOT IN", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    hiding.prepare("SELECT COUNT(*) AS total FROM memos WHERE workspace_id = ?");
    expect(underlying.preparedSqls[0]).toContain("NOT IN");
    expect(underlying.preparedSqls[0]).toContain("notebook_id");
  });

  test("stats COUNT FROM notebooks (no alias) → inject notebooks.id NOT IN", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    hiding.prepare("SELECT COUNT(*) AS count FROM notebooks WHERE workspace_id = ? AND is_deleted = 0");
    expect(underlying.preparedSqls[0]).toContain("NOT IN");
    expect(underlying.preparedSqls[0]).toContain("id NOT IN");
  });

  // ── INSERT/UPDATE/DELETE passthrough ──

  test("INSERT passthrough (no rewriting)", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    const sql = "INSERT INTO memos (id, notebook_id, workspace_id) VALUES (?, ?, ?)";
    hiding.prepare(sql);
    expect(underlying.preparedSqls[0]).toBe(sql); // unchanged
  });

  test("UPDATE passthrough (no rewriting)", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    const sql = "UPDATE memos SET is_deleted = 1 WHERE id = ? AND workspace_id = ?";
    hiding.prepare(sql);
    expect(underlying.preparedSqls[0]).toBe(sql); // unchanged
  });

  test("DELETE passthrough (no rewriting)", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    const sql = "DELETE FROM resources WHERE memo_id IN (?, ?)";
    hiding.prepare(sql);
    expect(underlying.preparedSqls[0]).toBe(sql); // unchanged
  });

  // ── Non-content table passthrough ──

  test("non-content table SELECT passthrough (api_tokens)", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    const sql = "SELECT id FROM api_tokens WHERE workspace_id = ?";
    hiding.prepare(sql);
    expect(underlying.preparedSqls[0]).toBe(sql); // unchanged
  });

  // ── fail-closed ──

  test("fail-closed: content table in subquery without alias → still injects", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    // This SQL has memos without alias in a subquery
    // The tokenizer should still find it
    const sql = "SELECT id FROM memos WHERE workspace_id = ? AND is_deleted = ?";
    hiding.prepare(sql);
    // Even without alias, we use table name as fallback
    expect(underlying.preparedSqls[0]).toContain("NOT IN");
  });

  // ── batch unwrap ──

  test("batch unwrap: wrapper statements unwrapped to inner for instanceof", async () => {
    const underlying = new MockDatabaseAdapter([]);
    const hiding = createHidingDatabase(underlying, hiddenIds);

    // Create wrapper statements via hiding.prepare
    const stmt1 = hiding.prepare("SELECT * FROM memos m WHERE m.workspace_id = ?");
    const stmt2 = hiding.prepare("SELECT * FROM notebooks n WHERE n.workspace_id = ?");

    // batch should not throw TypeError (because inner statements are MockStatement)
    await hiding.batch([stmt1, stmt2]);

    expect(underlying.batchCalls).toBe(1);
    // Verify inner statements are MockStatement (passed instanceof check)
    expect(underlying.lastBatchStatements.length).toBe(2);
    for (const stmt of underlying.lastBatchStatements) {
      expect(stmt instanceof MockStatement).toBe(true);
    }
  });

  // ── bind propagation ──

  test("bind() propagates through wrapper to inner statement", async () => {
    const underlying = new MockDatabaseAdapter([]);
    const hiding = createHidingDatabase(underlying, hiddenIds);

    const stmt = hiding.prepare("SELECT * FROM memos m WHERE m.workspace_id = ?");
    const bound = stmt.bind("ws1");

    // Should be able to call all() without error
    await bound.all();
    // Underlying received the SQL with injection
    expect(underlying.preparedSqls[0]).toContain("m.notebook_id NOT IN");
  });

  // ── Symbol-based hidden set access ──

  test("createHidingDatabaseWithSymbol + getHidingSet", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabaseWithSymbol(underlying, hiddenIds);

    const extracted = getHidingSet(hiding);
    expect(extracted).toBeDefined();
    expect(extracted!.has("nb_secret_1")).toBe(true);
    expect(extracted!.has("nb_secret_2")).toBe(true);
    expect(extracted!.has("nb_other")).toBe(false);
  });

  test("getHidingSet returns undefined for non-wrapped db", () => {
    const underlying = new MockDatabaseAdapter();
    expect(getHidingSet(underlying)).toBeUndefined();
  });

  // ── isNotebookHidden ──

  test("isNotebookHidden checks set membership", () => {
    expect(isNotebookHidden(hiddenIds, "nb_secret_1")).toBe(true);
    expect(isNotebookHidden(hiddenIds, "nb_other")).toBe(false);
  });

  // ── loadHiddenNotebookIds ──

  test("loadHiddenNotebookIds uses recursive CTE query", async () => {
    const underlying = new MockDatabaseAdapter([
      { id: "nb_root" },
      { id: "nb_child_a" },
      { id: "nb_grandchild" },
    ]);

    const result = await loadHiddenNotebookIds(underlying, "token1", "ws1");

    expect(result.size).toBe(3);
    expect(result.has("nb_root")).toBe(true);
    expect(result.has("nb_child_a")).toBe(true);
    expect(result.has("nb_grandchild")).toBe(true);

    // Verify SQL contains recursive CTE
    expect(underlying.preparedSqls[0]).toContain("WITH RECURSIVE");
    expect(underlying.preparedSqls[0]).toContain("mcp_token_hidden_notebooks");
    expect(underlying.preparedSqls[0]).toContain("token_id");
  });

  // ── SQL injection safety ──

  test("hidden IDs with single quotes are escaped", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, new Set(["nb'; DROP TABLE--"]));

    hiding.prepare("SELECT * FROM memos m WHERE m.workspace_id = ?");
    const sql = underlying.preparedSqls[0];
    // Single quote should be escaped to '' (preventing SQL injection)
    expect(sql).toContain("nb''");
    // The DROP TABLE is inside the escaped string literal, so it's safe
    // It appears as part of the string value, not as executable SQL
    expect(sql).toContain("'");
  });

  // ── Complex real-world queries ──

  test("sync-routes bootstrap: notebooks LEFT JOIN memos → both injected", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    const sql = `SELECT n.id, n.parent_id, n.name, n.slug, n.icon, n.color, n.sort_order,
      n.created_at, n.updated_at, COUNT(m.id) AS memo_count, MAX(m.updated_at) AS last_memo_updated_at
      FROM notebooks n
      LEFT JOIN memos m ON m.notebook_id = n.id AND m.workspace_id = n.workspace_id AND m.is_deleted = 0
      WHERE n.workspace_id = ? AND n.is_deleted = 0
      GROUP BY n.id, n.parent_id, n.name, n.slug, n.icon, n.color, n.sort_order, n.created_at, n.updated_at
      ORDER BY n.sort_order ASC, n.name ASC`;

    hiding.prepare(sql);
    const rewritten = underlying.preparedSqls[0];
    expect(rewritten).toContain("n.id NOT IN");
    expect(rewritten).toContain("m.notebook_id NOT IN");
  });

  test("backup-routes: memos JOIN memo_contents mc → m.notebook_id injected", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    const sql = `SELECT m.id, m.notebook_id, m.title FROM memos m
      INNER JOIN memo_contents mc ON mc.memo_id = m.id
      WHERE m.workspace_id = ? AND m.is_deleted = 0
      ORDER BY m.created_at ASC LIMIT ? OFFSET ?`;

    hiding.prepare(sql);
    expect(underlying.preparedSqls[0]).toContain("m.notebook_id NOT IN");
  });

  test("tag-service: memo_tags JOIN memos → both injected", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    const sql = `SELECT mt.name, COUNT(DISTINCT m.id) AS memo_count, MAX(m.updated_at) AS updated_at
      FROM memo_tags mt
      INNER JOIN memos m ON m.id = mt.memo_id AND m.workspace_id = mt.workspace_id
      WHERE mt.workspace_id = ? AND m.is_deleted = 0
      GROUP BY mt.name`;

    hiding.prepare(sql);
    const rewritten = underlying.preparedSqls[0];
    // memo_tags → memo_id subquery
    expect(rewritten).toContain("memo_id NOT IN");
    // memos → m.notebook_id NOT IN
    expect(rewritten).toContain("m.notebook_id NOT IN");
  });

  test("resources JOIN memos (workspace-stats pattern) → both injected", () => {
    const underlying = new MockDatabaseAdapter();
    const hiding = createHidingDatabase(underlying, hiddenIds);

    const sql = `SELECT COUNT(*) FROM resources r
      INNER JOIN memos m ON m.id = r.memo_id
      WHERE m.workspace_id = ? AND r.is_deleted = 0`;

    hiding.prepare(sql);
    const rewritten = underlying.preparedSqls[0];
    // resources → memo_id subquery
    expect(rewritten).toContain("memo_id NOT IN");
    // memos → m.notebook_id NOT IN
    expect(rewritten).toContain("m.notebook_id NOT IN");
  });
});

// ═════════════════════════════════════════════════════════════
// 11.7 (Q3) Real-SQLite execution sweep — every rewriting-class fixture
// above is re-run against a REAL bun:sqlite in-memory database.
//
// BUG-001 lesson: toContain assertions pass on ambiguous/broken SQL. This
// sweep prepares (and executes) every rewritten fixture so a broken rewrite
// FAILS here instead of on a remote server.
//
// The fixtures mirror the production SQL shapes found in:
// memo-service / memo-list-service / notebook-service / tag-service /
// workspace-stats-service / sync-routes / backup-routes / resources.
// ═════════════════════════════════════════════════════════════
import { Database } from "bun:sqlite";

function createSweepDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE notebooks (
      id TEXT PRIMARY KEY, parent_id TEXT REFERENCES notebooks(id), workspace_id TEXT,
      name TEXT, slug TEXT, icon TEXT, color TEXT, sort_order INTEGER DEFAULT 0,
      is_deleted INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE memos (
      id TEXT PRIMARY KEY, workspace_id TEXT, notebook_id TEXT REFERENCES notebooks(id),
      title TEXT, excerpt TEXT, tags_json TEXT DEFAULT '[]',
      is_pinned INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE memo_contents (
      memo_id TEXT PRIMARY KEY REFERENCES memos(id), content_text TEXT, content_json TEXT,
      content_markdown TEXT, content_hash TEXT, revision INTEGER DEFAULT 0,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE resources (
      id TEXT PRIMARY KEY, memo_id TEXT REFERENCES memos(id), is_deleted INTEGER DEFAULT 0,
      filename TEXT, byte_size INTEGER, kind TEXT, mime_type TEXT
    );
    CREATE TABLE memo_revisions (
      id TEXT PRIMARY KEY, memo_id TEXT REFERENCES memos(id), revision INTEGER, created_at TEXT
    );
    CREATE TABLE memo_tags (
      memo_id TEXT REFERENCES memos(id), workspace_id TEXT, name TEXT, normalized_name TEXT,
      PRIMARY KEY (memo_id, name)
    );
    CREATE TABLE memo_search_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, memo_id TEXT NOT NULL REFERENCES memos(id),
      title TEXT, content_text TEXT, tags TEXT
    );
    CREATE VIRTUAL TABLE memos_fts USING fts5(
      memo_id UNINDEXED, title, content_text, tags,
      content = 'memo_search_documents', content_rowid = 'id'
    );
    INSERT INTO notebooks VALUES ('n_ok', NULL, 'ws1', 'OK', 'ok', '', '', 0, 0, '', '');
    INSERT INTO notebooks VALUES ('n_hidden', NULL, 'ws1', 'H', 'h', '', '', 1, 0, '', '');
    INSERT INTO memos (id, workspace_id, notebook_id, title, is_pinned, updated_at) VALUES
      ('memo_ok', 'ws1', 'n_ok', 'OK memo', 0, ''),
      ('memo_hidden', 'ws1', 'n_hidden', 'Secret memo', 1, '');
    INSERT INTO memo_contents (memo_id, content_text) VALUES
      ('memo_ok', 'visible content'), ('memo_hidden', 'secret content');
    INSERT INTO memo_search_documents (memo_id, title, content_text) VALUES
      ('memo_ok', 'OK memo', 'visible content'), ('memo_hidden', 'Secret memo', 'secret content');
    INSERT INTO memos_fts(memos_fts) VALUES('rebuild');
    INSERT INTO resources VALUES ('res_ok', 'memo_ok', 0, 'f.png', 1, 'image', 'image/png');
    INSERT INTO memo_revisions VALUES ('rev_ok', 'memo_ok', 1, '');
    INSERT INTO memo_tags VALUES ('memo_ok', 'ws1', 't1', 't1');
  `);
  return db;
}

function wrapSweepDb(db: Database, hiddenIds: Set<string>): DatabaseAdapter {
  const adapter: DatabaseAdapter = {
    prepare(sql: string): PreparedStatementAdapter {
      const stmt = db.prepare(sql);
      return {
        bind(...vals: unknown[]) {
          const bound = db.prepare(sql);
          return {
            bind() { return this; },
            async all<T = Record<string, unknown>>() {
              return { results: bound.all(...vals) as T[], success: true as const, meta: {} };
            },
            async first<T = unknown>() {
              const row = bound.get(...vals) as T | undefined;
              return row ?? null;
            },
            async run() {
              bound.run(...vals);
              return { results: [], success: true as const, meta: {} };
            },
          } as PreparedStatementAdapter;
        },
        async all<T = Record<string, unknown>>() {
          return { results: stmt.all() as T[], success: true as const, meta: {} };
        },
        async first<T = unknown>() {
          return (stmt.get() as T | undefined) ?? null;
        },
        async run() {
          stmt.run();
          return { results: [], success: true as const, meta: {} };
        },
      };
    },
    async batch() { return []; },
  } as unknown as DatabaseAdapter;
  return createHidingDatabase(adapter, hiddenIds);
}

describe("11.7 real-SQLite sweep — every rewriting fixture executes", () => {
  const HIDDEN = new Set(["n_hidden"]);
  const okBind = { bind: (..._v: unknown[]) => [] };

  test("sweep: memos JOIN memo_contents executes", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      "SELECT m.id, m.title FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id WHERE m.workspace_id = ?"
    ).bind("ws1").all<{ id: string }>();
    expect(r.results.map((x) => x.id)).toEqual(["memo_ok"]);
  });

  test("sweep: memos JOIN memo_contents mc (alias collision variant) executes", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      "SELECT m.id FROM memos m INNER JOIN memo_contents mc ON mc.memo_id = m.id WHERE m.workspace_id = ?"
    ).bind("ws1").all<{ id: string }>();
    expect(r.results.map((x) => x.id)).toEqual(["memo_ok"]);
  });

  test("sweep: resources SELECT executes", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      "SELECT r.id, r.memo_id FROM resources r WHERE r.is_deleted = 0 AND r.memo_id IN (?, ?)"
    ).bind("memo_ok", "memo_hidden").all<{ id: string }>();
    // res_ok visible; hidden memo's resources filtered by memo_id subquery
    expect(r.results.map((x) => x.id)).toEqual(["res_ok"]);
  });

  test("sweep: memo_tags SELECT executes", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      "SELECT mt.name, COUNT(*) AS cnt FROM memo_tags mt WHERE mt.workspace_id = ? GROUP BY mt.name"
    ).bind("ws1").all<{ name: string }>();
    expect(r.results.map((x) => x.name)).toEqual(["t1"]);
  });

  test("sweep: FTS5 CTE search (real searchMemoSummaries shape) executes + isolates", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      `WITH raw_matches(memo_id, rank) AS (
        SELECT memo_id, bm25(memos_fts) FROM memos_fts WHERE memos_fts MATCH ?
        UNION ALL
        SELECT m.id, 100.0 FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id
        WHERE m.title LIKE ? ESCAPE '\\'
      ), search_matches AS (
        SELECT memo_id, MIN(rank) AS rank FROM raw_matches GROUP BY memo_id
      )
      SELECT m.id, m.notebook_id FROM search_matches s
      INNER JOIN memos m ON m.id = s.memo_id
      INNER JOIN memo_contents mc ON mc.memo_id = m.id
      WHERE m.workspace_id = ?`
    ).bind("memo", "%memo%", "ws1").all<{ id: string }>();
    expect(r.results.map((x) => x.id)).toEqual(["memo_ok"]); // hidden memo never leaks
  });

  test("sweep: stats COUNT FROM memos executes", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      "SELECT COUNT(*) AS total FROM memos WHERE workspace_id = ?"
    ).bind("ws1").first<{ total: number }>();
    expect(r!.total).toBe(1); // hidden memo not counted (stats 口径: hidden 不计入)
  });

  test("sweep: stats COUNT FROM notebooks executes", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      "SELECT COUNT(*) AS count FROM notebooks WHERE workspace_id = ? AND is_deleted = 0"
    ).bind("ws1").first<{ count: number }>();
    expect(r!.count).toBe(1); // hidden notebook not counted
  });

  test("sweep: notebooks LEFT JOIN memos (notebookSelectSql pattern) executes", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      `SELECT n.id, n.parent_id, n.name, n.slug, n.icon, n.color, n.sort_order,
        n.created_at, n.updated_at, COUNT(m.id) AS memo_count, MAX(m.updated_at) AS last_memo_updated_at
        FROM notebooks n
        LEFT JOIN memos m ON m.notebook_id = n.id AND m.workspace_id = n.workspace_id AND m.is_deleted = 0
        WHERE n.workspace_id = ? AND n.is_deleted = 0
        GROUP BY n.id, n.parent_id, n.name, n.slug, n.icon, n.color, n.sort_order, n.created_at, n.updated_at
        ORDER BY n.sort_order ASC, n.name ASC`
    ).bind("ws1").all<{ id: string }>();
    expect(r.results.map((x) => x.id)).toEqual(["n_ok"]);
  });

  test("sweep: backup-routes memos JOIN mc with LIMIT/OFFSET executes", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      `SELECT m.id, m.notebook_id, m.title FROM memos m
        INNER JOIN memo_contents mc ON mc.memo_id = m.id
        WHERE m.workspace_id = ? AND m.is_deleted = 0
        ORDER BY m.created_at ASC LIMIT ? OFFSET ?`
    ).bind("ws1", 50, 0).all<{ id: string }>();
    expect(r.results.map((x) => x.id)).toEqual(["memo_ok"]);
  });

  test("sweep: tag-service memo_tags JOIN memos executes", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      `SELECT mt.name, COUNT(DISTINCT m.id) AS memo_count, MAX(m.updated_at) AS updated_at
        FROM memo_tags mt
        INNER JOIN memos m ON m.id = mt.memo_id AND m.workspace_id = mt.workspace_id
        WHERE mt.workspace_id = ? AND m.is_deleted = 0
        GROUP BY mt.name`
    ).bind("ws1").all<{ name: string }>();
    expect(r.results.map((x) => x.name)).toEqual(["t1"]);
  });

  test("sweep: resources JOIN memos (stats pattern) executes", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      `SELECT COUNT(*) AS total FROM resources r
        INNER JOIN memos m ON m.id = r.memo_id
        WHERE m.workspace_id = ? AND r.is_deleted = 0`
    ).bind("ws1").first<{ total: number }>();
    expect(r!.total).toBe(1);
  });

  test("sweep: no-alias memos subquery (fail-closed fixture) executes", async () => {
    const db = wrapSweepDb(createSweepDb(), HIDDEN);
    const r = await db.prepare(
      "SELECT id FROM memos WHERE workspace_id = ? AND is_deleted = ?"
    ).bind("ws1", 0).all<{ id: string }>();
    expect(r.results.map((x) => x.id)).toEqual(["memo_ok"]);
  });
});
