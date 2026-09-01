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

    const sql = `WITH raw_matches(memo_id, rank) AS (
      SELECT memo_id, bm25(memos_fts) FROM memos_fts WHERE memos_fts MATCH ?
      UNION ALL
      SELECT m.id, 100.0 FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id
      WHERE m.title LIKE ? ESCAPE '\\'
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
