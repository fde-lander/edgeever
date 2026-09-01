/**
 * 9.3 Migration test — 验证 0036_mcp_token_hidden.sql
 *
 * 用 bun:sqlite 内存数据库，模拟 self-hosted-server.mjs 嘅 migration apply 流程。
 * 验证：
 * 1. SQL 语法正确（能 apply 唔报错）
 * 2. 表结构正确（列名、PK、FK）
 * 3. CASCADE 行为（删 token → 隔离记录归零；删 notebook → 隔离记录归零）
 * 4. 递归 CTE 父→子孙展开（核心功能）
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "migrations");

// 创建最小化 schema（只包含 0036 依赖嘅表：api_tokens + notebooks）
// 注意：按真实 0001_initial.sql 风格，notebooks.id 系单列 PK
function createMinimalSchema(db: Database) {
  db.exec("PRAGMA foreign_keys = ON;");

  // workspaces（notebooks/api_tokens FK 需要）
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);

  // users（api_tokens FK 需要）
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
  `);

  // api_tokens（简化版，含 0036 需要嘅 id + workspace_id）
  db.exec(`
    CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
  `);

  // notebooks（按真实 0001 schema：id 单列 PK，parent_id 自引用）
  db.exec(`
    CREATE TABLE notebooks (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      workspace_id TEXT,
      name TEXT NOT NULL,
      slug TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      CHECK (parent_id IS NULL OR parent_id <> id),
      FOREIGN KEY (parent_id) REFERENCES notebooks(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
    );
  `);
}

// apply 0036 migration
function applyMigration0036(db: Database) {
  const sql = readFileSync(join(migrationsDir, "0036_mcp_token_hidden.sql"), "utf8");
  db.exec(sql);
}

describe("9.3 Migration 0036", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    createMinimalSchema(db);
    applyMigration0036(db);
  });

  test("表创建成功 + 列结构正确", () => {
    const columns = db.query("PRAGMA table_info(mcp_token_hidden_notebooks)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain("token_id");
    expect(colNames).toContain("notebook_id");
    expect(colNames).toContain("workspace_id");
    expect(colNames).toContain("created_at");

    // PK 系组合键 (token_id, notebook_id)
    const pkCols = columns.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pkCols).toEqual(["token_id", "notebook_id"]);
  });

  test("插入 + 查询正常", () => {
    db.exec("INSERT INTO workspaces (id, name) VALUES ('ws1', 'Test Workspace')");
    db.exec("INSERT INTO users (id, workspace_id) VALUES ('user1', 'ws1')");
    db.exec("INSERT INTO api_tokens (id, workspace_id) VALUES ('token1', 'ws1')");
    db.exec("INSERT INTO notebooks (id, workspace_id, name, slug) VALUES ('nb1', 'ws1', 'Inbox', 'inbox')");

    db.exec(`
      INSERT INTO mcp_token_hidden_notebooks (token_id, notebook_id, workspace_id)
      VALUES ('token1', 'nb1', 'ws1')
    `);

    const rows = db.query("SELECT * FROM mcp_token_hidden_notebooks").all();
    expect(rows.length).toBe(1);
    expect((rows[0] as { token_id: string }).token_id).toBe("token1");
    expect((rows[0] as { notebook_id: string }).notebook_id).toBe("nb1");
  });

  test("CASCADE：删 token → 隔离记录归零", () => {
    db.exec("DELETE FROM api_tokens WHERE id = 'token1'");
    const rows = db.query("SELECT * FROM mcp_token_hidden_notebooks WHERE token_id = 'token1'").all();
    expect(rows.length).toBe(0);
  });

  test("CASCADE：删 notebook → 隔离记录归零", () => {
    // 重新插入数据
    db.exec("INSERT INTO api_tokens (id, workspace_id) VALUES ('token2', 'ws1')");
    db.exec("INSERT INTO notebooks (id, workspace_id, name, slug) VALUES ('nb2', 'ws1', 'Projects', 'projects')");
    db.exec(`
      INSERT INTO mcp_token_hidden_notebooks (token_id, notebook_id, workspace_id)
      VALUES ('token2', 'nb2', 'ws1')
    `);

    // 删 notebook
    db.exec("DELETE FROM notebooks WHERE id = 'nb2'");
    const rows = db.query("SELECT * FROM mcp_token_hidden_notebooks WHERE notebook_id = 'nb2'").all();
    expect(rows.length).toBe(0);
  });

  test("递归 CTE：父隐藏 → 子孙自动继承展开", () => {
    // 构建树状结构：
    // nb_root (parent: null)
    //   ├── nb_child_a (parent: nb_root)
    //   │   └── nb_grandchild (parent: nb_child_a)
    //   └── nb_child_b (parent: nb_root)

    db.exec("INSERT INTO notebooks (id, workspace_id, name, slug, parent_id) VALUES ('nb_root', 'ws1', 'Root', 'root', NULL)");
    db.exec("INSERT INTO notebooks (id, workspace_id, name, slug, parent_id) VALUES ('nb_child_a', 'ws1', 'Child A', 'child-a', 'nb_root')");
    db.exec("INSERT INTO notebooks (id, workspace_id, name, slug, parent_id) VALUES ('nb_grandchild', 'ws1', 'Grandchild', 'grandchild', 'nb_child_a')");
    db.exec("INSERT INTO notebooks (id, workspace_id, name, slug, parent_id) VALUES ('nb_child_b', 'ws1', 'Child B', 'child-b', 'nb_root')");

    // 隐藏 nb_root
    db.exec("INSERT INTO api_tokens (id, workspace_id) VALUES ('token3', 'ws1')");
    db.exec(`
      INSERT INTO mcp_token_hidden_notebooks (token_id, notebook_id, workspace_id)
      VALUES ('token3', 'nb_root', 'ws1')
    `);

    // 递归 CTE 展开：从直接隐藏嘅 nb_root 出发，沿 parent_id 找全部后代
    const cteResult = db.query(`
      WITH RECURSIVE hidden_tree AS (
        -- 起点：直接隐藏嘅 notebook
        SELECT notebook_id AS id FROM mcp_token_hidden_notebooks WHERE token_id = 'token3'
        UNION ALL
        -- 递归：找所有 parent 喺 hidden_tree 嘅 notebook
        SELECT n.id FROM notebooks n
        INNER JOIN hidden_tree h ON n.parent_id = h.id
        WHERE n.is_deleted = 0
      )
      SELECT id FROM hidden_tree
    `).all() as Array<{ id: string }>;

    const expandedIds = cteResult.map((r) => r.id);

    // 应该包含 nb_root + nb_child_a + nb_grandchild + nb_child_b（全部后代）
    expect(expandedIds).toContain("nb_root");
    expect(expandedIds).toContain("nb_child_a");
    expect(expandedIds).toContain("nb_grandchild");
    expect(expandedIds).toContain("nb_child_b");
    expect(expandedIds.length).toBe(4);
  });

  test("重复插入同一条记录 → UNIQUE 约束报错", () => {
    db.exec("INSERT INTO api_tokens (id, workspace_id) VALUES ('token4', 'ws1')");
    db.exec(`
      INSERT INTO mcp_token_hidden_notebooks (token_id, notebook_id, workspace_id)
      VALUES ('token4', 'nb_root', 'ws1')
    `);

    // 第二次插入同一条 → 应该报错
    expect(() => {
      db.exec(`
        INSERT INTO mcp_token_hidden_notebooks (token_id, notebook_id, workspace_id)
        VALUES ('token4', 'nb_root', 'ws1')
      `);
    }).toThrow();
  });
});
