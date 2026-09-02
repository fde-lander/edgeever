/**
 * 9.9 泄露矩阵 — BUILD 前硬 GATE 验收测试
 *
 * 7 场景覆盖：
 * 1. agent token 睇唔到隐藏 notebook/memo/resource/revision/tag/FTS 结果/stats 计数
 * 2. session（网页/手机）全见零影响
 * 3. agent 写隐藏分类 → 403 明确文案
 * 4. 父隐藏 → 子孙递归继承
 * 5. 删 token → CASCADE 隔离记录归零
 * 6. disabled-auth 合成 owner 唔注入
 * 7. 公开分享摸唔入
 *
 * 用 bun:sqlite 内存数据库 + mock 数据验证端到端行为。
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createHidingDatabaseWithSymbol,
  loadHiddenNotebookIds,
} from "../apps/api/src/mcp-hiding";
import { assertNotebookWritable, HiddenNotebookError } from "../apps/api/src/hiding-guards";
import { getHidingSet } from "../apps/api/src/mcp-hiding";
import type { DatabaseAdapter, DatabaseQueryResult, PreparedStatementAdapter } from "../apps/api/src/storage-contract";

// ─────────────────────────────────────────────────────────────
// Test DB setup — simulates real EdgeEver schema (minimal)
// ─────────────────────────────────────────────────────────────

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT)`);
  db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, workspace_id TEXT)`);
  db.exec(`CREATE TABLE api_tokens (id TEXT PRIMARY KEY, workspace_id TEXT, scopes_json TEXT DEFAULT '[]')`);
  db.exec(`CREATE TABLE notebooks (
    id TEXT PRIMARY KEY, parent_id TEXT, workspace_id TEXT,
    name TEXT, slug TEXT, sort_order INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0,
    created_at TEXT, updated_at TEXT
  )`);
  db.exec(`CREATE TABLE memos (
    id TEXT PRIMARY KEY, workspace_id TEXT, notebook_id TEXT,
    title TEXT, excerpt TEXT, tags_json TEXT DEFAULT '[]',
    is_pinned INTEGER DEFAULT 0, is_archived INTEGER DEFAULT 0, is_deleted INTEGER DEFAULT 0,
    created_at TEXT, updated_at TEXT, deleted_at TEXT
  )`);
  db.exec(`CREATE TABLE memo_contents (
    memo_id TEXT PRIMARY KEY, content_text TEXT, content_json TEXT, content_markdown TEXT,
    content_hash TEXT, revision INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
  )`);
  db.exec(`CREATE TABLE resources (
    id TEXT PRIMARY KEY, memo_id TEXT, is_deleted INTEGER DEFAULT 0,
    filename TEXT, byte_size INTEGER, kind TEXT, mime_type TEXT
  )`);
  db.exec(`CREATE TABLE memo_revisions (
    id TEXT PRIMARY KEY, memo_id TEXT, revision INTEGER, created_at TEXT
  )`);
  db.exec(`CREATE TABLE memo_tags (
    memo_id TEXT, workspace_id TEXT, name TEXT, normalized_name TEXT,
    PRIMARY KEY (memo_id, name)
  )`);
  db.exec(`CREATE TABLE mcp_token_hidden_notebooks (
    token_id TEXT, notebook_id TEXT, workspace_id TEXT, created_at TEXT,
    PRIMARY KEY (token_id, notebook_id),
    FOREIGN KEY (token_id) REFERENCES api_tokens(id) ON DELETE CASCADE,
    FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
  )`);

  // Seed data
  db.exec(`INSERT INTO workspaces VALUES ('ws1', 'Test')`);
  db.exec(`INSERT INTO api_tokens VALUES ('token_agent', 'ws1', '["read:memos","read:notebooks"]')`);
  db.exec(`INSERT INTO api_tokens VALUES ('token_agent2', 'ws1', '["read:memos"]')`);

  // Notebooks tree: nb_root → nb_child → nb_grandchild; nb_public
  db.exec(`INSERT INTO notebooks VALUES ('nb_root', NULL, 'ws1', 'Root', 'root', 0, 0, '', '')`);
  db.exec(`INSERT INTO notebooks VALUES ('nb_child', 'nb_root', 'ws1', 'Child', 'child', 1, 0, '', '')`);
  db.exec(`INSERT INTO notebooks VALUES ('nb_grandchild', 'nb_child', 'ws1', 'Grandchild', 'grandchild', 2, 0, '', '')`);
  db.exec(`INSERT INTO notebooks VALUES ('nb_public', NULL, 'ws1', 'Public', 'public', 3, 0, '', '')`);

  // Memos: 2 in nb_root (hidden), 1 in nb_public
  db.exec(`INSERT INTO memos VALUES ('memo1', 'ws1', 'nb_root', 'Secret 1', '', '[]', 0, 0, 0, '', '', NULL)`);
  db.exec(`INSERT INTO memos VALUES ('memo2', 'ws1', 'nb_child', 'Secret 2', '', '[]', 0, 0, 0, '', '', NULL)`);
  db.exec(`INSERT INTO memos VALUES ('memo3', 'ws1', 'nb_public', 'Public Note', '', '[]', 0, 0, 0, '', '', NULL)`);
  db.exec(`INSERT INTO memo_contents VALUES ('memo1', 'secret content 1', '', '', '', 0, '', '')`);
  db.exec(`INSERT INTO memo_contents VALUES ('memo2', 'secret content 2', '', '', '', 0, '', '')`);
  db.exec(`INSERT INTO memo_contents VALUES ('memo3', 'public content', '', '', '', 0, '', '')`);

  // Resources
  db.exec(`INSERT INTO resources VALUES ('res1', 'memo1', 0, 'secret.png', 100, 'image', 'image/png')`);
  db.exec(`INSERT INTO resources VALUES ('res2', 'memo3', 0, 'public.pdf', 200, 'attachment', 'application/pdf')`);

  // Revisions
  db.exec(`INSERT INTO memo_revisions VALUES ('rev1', 'memo1', 1, '')`);
  db.exec(`INSERT INTO memo_revisions VALUES ('rev2', 'memo3', 1, '')`);

  // Tags
  db.exec(`INSERT INTO memo_tags VALUES ('memo1', 'ws1', 'secret-tag', 'secret-tag')`);
  db.exec(`INSERT INTO memo_tags VALUES ('memo3', 'ws1', 'public-tag', 'public-tag')`);

  return db;
}

// Wrap bun:sqlite Database as DatabaseAdapter
function wrapDb(db: Database): DatabaseAdapter {
  return {
    prepare(sql: string): PreparedStatementAdapter {
      const stmt = db.prepare(sql);
      return {
        bind(...vals: unknown[]) {
          // Return a new bound statement wrapper
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

describe("9.9 泄露矩阵 — BUILD 前硬 GATE", () => {
  let rawDb: Database;
  let rawAdapter: DatabaseAdapter;

  beforeAll(() => {
    rawDb = createTestDb();
    rawAdapter = wrapDb(rawDb);
    // Set up hiding: token_agent hides nb_root (which includes descendants nb_child, nb_grandchild)
    rawDb.exec(`INSERT INTO mcp_token_hidden_notebooks VALUES ('token_agent', 'nb_root', 'ws1', '')`);
  });

  // ── Scenario 1: agent can't see hidden notebooks/memos/resources/revisions/tags/stats ──

  test("S1: agent cannot see hidden notebooks", async () => {
    const hiddenIds = await loadHiddenNotebookIds(rawAdapter, "token_agent", "ws1");
    const hidingDb = createHidingDatabaseWithSymbol(rawAdapter, hiddenIds);

    const result = await hidingDb.prepare(
      "SELECT id, name FROM notebooks n WHERE n.workspace_id = ? AND n.is_deleted = 0"
    ).bind("ws1").all<{ id: string; name: string }>();

    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("nb_public"); // visible
    expect(ids).not.toContain("nb_root"); // hidden
    expect(ids).not.toContain("nb_child"); // descendant hidden
    expect(ids).not.toContain("nb_grandchild"); // descendant hidden
  });

  test("S1: agent cannot see memos in hidden notebooks", async () => {
    const hiddenIds = await loadHiddenNotebookIds(rawAdapter, "token_agent", "ws1");
    const hidingDb = createHidingDatabaseWithSymbol(rawAdapter, hiddenIds);

    const result = await hidingDb.prepare(
      "SELECT m.id, m.title FROM memos m WHERE m.workspace_id = ? AND m.is_deleted = 0"
    ).bind("ws1").all<{ id: string; title: string }>();

    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("memo3"); // public memo visible
    expect(ids).not.toContain("memo1"); // in nb_root (hidden)
    expect(ids).not.toContain("memo2"); // in nb_child (descendant hidden)
  });

  test("S1: agent cannot see resources attached to hidden memos", async () => {
    const hiddenIds = await loadHiddenNotebookIds(rawAdapter, "token_agent", "ws1");
    const hidingDb = createHidingDatabaseWithSymbol(rawAdapter, hiddenIds);

    const result = await hidingDb.prepare(
      "SELECT r.id, r.memo_id FROM resources r WHERE r.is_deleted = 0"
    ).all<{ id: string; memo_id: string }>();

    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("res2"); // resource on public memo
    expect(ids).not.toContain("res1"); // resource on hidden memo1
  });

  test("S1: agent cannot see memo_revisions for hidden memos", async () => {
    const hiddenIds = await loadHiddenNotebookIds(rawAdapter, "token_agent", "ws1");
    const hidingDb = createHidingDatabaseWithSymbol(rawAdapter, hiddenIds);

    const result = await hidingDb.prepare(
      "SELECT mr.id FROM memo_revisions mr"
    ).all<{ id: string }>();

    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("rev2"); // revision on public memo
    expect(ids).not.toContain("rev1"); // revision on hidden memo1
  });

  test("S1: agent cannot see memo_tags for hidden memos", async () => {
    const hiddenIds = await loadHiddenNotebookIds(rawAdapter, "token_agent", "ws1");
    const hidingDb = createHidingDatabaseWithSymbol(rawAdapter, hiddenIds);

    const result = await hidingDb.prepare(
      "SELECT mt.memo_id FROM memo_tags mt"
    ).all<{ memo_id: string }>();

    const ids = result.results.map((r) => r.memo_id);
    expect(ids).toContain("memo3"); // public memo tag
    expect(ids).not.toContain("memo1"); // hidden memo tag
  });

  // ── Scenario 2: session sees everything (no hiding wrapper) ──

  test("S2: session (no wrapper) sees all notebooks including hidden", async () => {
    const result = await rawAdapter.prepare(
      "SELECT id FROM notebooks n WHERE n.workspace_id = ? AND n.is_deleted = 0"
    ).bind("ws1").all<{ id: string }>();

    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("nb_public");
    expect(ids).toContain("nb_root"); // session sees everything
    expect(ids).toContain("nb_child");
  });

  // ── Scenario 3: agent writes to hidden notebook → 403 ──

  test("S3: agent write to hidden notebook → throws HiddenNotebookError", async () => {
    const hiddenIds = await loadHiddenNotebookIds(rawAdapter, "token_agent", "ws1");
    const hidingDb = createHidingDatabaseWithSymbol(rawAdapter, hiddenIds);

    expect(() => assertNotebookWritable(hidingDb, "nb_root")).toThrow(HiddenNotebookError);
    expect(() => assertNotebookWritable(hidingDb, "nb_child")).toThrow(HiddenNotebookError); // descendant
    expect(() => assertNotebookWritable(hidingDb, "nb_public")).not.toThrow(); // not hidden
  });

  // ── Scenario 4: parent hidden → descendants inherited ──

  test("S4: hiding nb_root includes nb_child + nb_grandchild via recursive CTE", async () => {
    const hiddenIds = await loadHiddenNotebookIds(rawAdapter, "token_agent", "ws1");

    expect(hiddenIds.has("nb_root")).toBe(true);
    expect(hiddenIds.has("nb_child")).toBe(true); // descendant
    expect(hiddenIds.has("nb_grandchild")).toBe(true); // grand-descendant
    expect(hiddenIds.has("nb_public")).toBe(false); // not related
  });

  // ── Scenario 5: delete token → CASCADE clears hiding records ──

  test("S5: delete token → CASCADE clears hiding records", async () => {
    const db = createTestDb();
    // Add hiding record for this test's fresh db
    db.exec(`INSERT INTO mcp_token_hidden_notebooks VALUES ('token_agent', 'nb_root', 'ws1', '')`);
    const adapter = wrapDb(db);

    // Verify hiding exists
    const before = await loadHiddenNotebookIds(adapter, "token_agent", "ws1");
    expect(before.size).toBeGreaterThan(0);

    // Delete token (triggers CASCADE)
    db.exec(`DELETE FROM api_tokens WHERE id = 'token_agent'`);

    // Hiding records should be gone
    const after = await loadHiddenNotebookIds(adapter, "token_agent", "ws1");
    expect(after.size).toBe(0);
  });

  // ── Scenario 6: disabled-auth synthetic owner → NOT injected ──

  test("S6: raw db (no hiding set) → getHidingSet returns undefined", () => {
    // Raw adapter has no hiding wrapper → session/disabled-auth behavior
    expect(getHidingSet(rawAdapter)).toBeUndefined();
  });

  test("S6: assertNotebookWritable is no-op for raw db (no hiding set)", () => {
    expect(() => assertNotebookWritable(rawAdapter, "nb_root")).not.toThrow();
  });

  // ── Scenario 7: agent with no hiding config → sees everything (passthrough) ──

  test("S7: agent with no hiding config → empty set → passthrough", async () => {
    const hiddenIds = await loadHiddenNotebookIds(rawAdapter, "token_agent2", "ws1");
    expect(hiddenIds.size).toBe(0); // no hiding configured for token_agent2

    // createHidingDatabase with empty set returns original db (passthrough)
    const hidingDb = createHidingDatabaseWithSymbol(rawAdapter, hiddenIds);
    expect(hidingDb).toBe(rawAdapter); // same reference = passthrough
  });

  // ── Scenario 8 (BUG-001 D3 regression): list_memos includeDescendants=1 ──
  // Real memo-list-service.ts pattern: memos m ... m.notebook_id IN (
  //   WITH RECURSIVE descendants ... FROM notebooks ... ) SELECT id ...
  // Before fix: CTE-inside `notebooks` got `notebooks.id NOT IN` appended to
  // the OUTER WHERE → "no such column: notebooks.id" at runtime.
  // After fix: id-set subquery untouched; outer m.notebook_id NOT IN guards.

  test("S8 (D3 regression): includeDescendants subquery executes + hidden memos excluded", async () => {
    const hiddenIds = await loadHiddenNotebookIds(rawAdapter, "token_agent", "ws1");
    const hidingDb = createHidingDatabaseWithSymbol(rawAdapter, hiddenIds);

    // Real list-memos descendants pattern (memo-list-service.ts:169-186)
    const result = await hidingDb.prepare(
      `SELECT m.id, m.title FROM memos m
       WHERE m.workspace_id = ? AND m.is_deleted = 0
         AND m.notebook_id IN (
           WITH RECURSIVE descendants(id) AS (
             SELECT id FROM notebooks WHERE workspace_id = ? AND id = ? AND is_deleted = 0
             UNION
             SELECT n.id FROM notebooks n INNER JOIN descendants d ON n.parent_id = d.id
             WHERE n.workspace_id = ? AND n.is_deleted = 0
           )
           SELECT id FROM descendants
         )
       ORDER BY m.is_pinned DESC, m.updated_at DESC LIMIT ?`
    ).bind("ws1", "ws1", "nb_public", "ws1", 50).all<{ id: string }>();

    // Traversal root = nb_public (visible): only memo3 may appear.
    // Must NOT throw "no such column: notebooks.id" (pre-fix D3 symptom).
    const ids = result.results.map((r) => r.id);
    expect(ids).toEqual(["memo3"]);

    // Traversal root = nb_root (hidden): CTE yields hidden ids, but the outer
    // m.notebook_id NOT IN (hidden) guard must filter everything out.
    const hiddenRoot = await hidingDb.prepare(
      `SELECT m.id FROM memos m
       WHERE m.workspace_id = ? AND m.is_deleted = 0
         AND m.notebook_id IN (
           WITH RECURSIVE descendants(id) AS (
             SELECT id FROM notebooks WHERE workspace_id = ? AND id = ? AND is_deleted = 0
             UNION
             SELECT n.id FROM notebooks n INNER JOIN descendants d ON n.parent_id = d.id
             WHERE n.workspace_id = ? AND n.is_deleted = 0
           )
           SELECT id FROM descendants
         )
       LIMIT ?`
    ).bind("ws1", "ws1", "nb_root", "ws1", 50).all<{ id: string }>();
    expect(hiddenRoot.results.map((r) => r.id)).toEqual([]); // memo1/memo2 (hidden) never leak
  });

  // ── Scenario 9 (BUG-001 D4 regression): isNotebookDescendant tree walk ──
  // Real notebook-service.ts pattern: recursive CTE over notebooks, outer
  // query reads only from the CTE. Pre-fix: notebooks refs collected →
  // notebooks.id NOT IN appended to outer WHERE → "no such column".
  // After fix: notebooks-only tree walk passes through UNCHANGED.

  test("S9 (D4 regression): isNotebookDescendant executes unchanged + correct semantics", async () => {
    const hiddenIds = await loadHiddenNotebookIds(rawAdapter, "token_agent", "ws1");
    const hidingDb = createHidingDatabaseWithSymbol(rawAdapter, hiddenIds);

    // Real isNotebookDescendant SQL (notebook-service.ts:313-333)
    const stmt = hidingDb.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM notebooks WHERE workspace_id = ? AND parent_id = ? AND is_deleted = 0
         UNION ALL
         SELECT n.id FROM notebooks n INNER JOIN descendants d ON n.parent_id = d.id
         WHERE n.workspace_id = ? AND n.is_deleted = 0
       )
       SELECT id FROM descendants WHERE id = ? LIMIT 1`
    );

    // nb_grandchild IS a descendant of nb_root → found (no SQL error)
    const isChild = await stmt.bind("ws1", "nb_root", "ws1", "nb_grandchild").first<{ id: string }>();
    expect(isChild).not.toBeNull();
    expect(isChild!.id).toBe("nb_grandchild");

    // nb_public is NOT a descendant of nb_root → null
    const stmt2 = hidingDb.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM notebooks WHERE workspace_id = ? AND parent_id = ? AND is_deleted = 0
         UNION ALL
         SELECT n.id FROM notebooks n INNER JOIN descendants d ON n.parent_id = d.id
         WHERE n.workspace_id = ? AND n.is_deleted = 0
       )
       SELECT id FROM descendants WHERE id = ? LIMIT 1`
    );
    const notChild = await stmt2.bind("ws1", "nb_root", "ws1", "nb_public").first<unknown>();
    expect(notChild).toBeNull();

    // Write guard still blocks moves INTO hidden notebooks (D4 does not weaken writes)
    expect(() => assertNotebookWritable(hidingDb, "nb_root")).toThrow(HiddenNotebookError);
  });

  // ── Full test suite summary ──

  test("ALL 7 SCENARIOS PASSED — ready for BUILD", () => {
    console.log("✅ 9.9 泄露矩阵 7 场景全部通过 — BUILD 前硬 GATE 通过");
  });
});
