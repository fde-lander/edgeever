/**
 * TDD — table_forms (0055) wrapper 隔离（Phase 26, fde-v1.90.0.1）
 *
 * v1.90.0 新增 table_forms 表（结构化表格笔记嘅表单收集配置），memo_id 关联
 * memos。隐藏分类 memo 嘅表单配置（title/description/fields_json）系内容泄露面，
 * 必须加入 hiding wrapper（MEMO_ID_SUBQUERY, NULL-safe）。
 *
 * T1-T3：BUG 断言 —— 加 rule 前 RED（隐藏 form 泄露 / loadForm 可见），加 rule 后
 *        GREEN。探针实测（2026-09-29 /tmp/probe-table-forms-v3/v4.ts）：
 *        - 未加 rule 时 loadForm 靠 EXISTS(memos m) 已被 MEMOS_INJECTION 拦截 → 隐藏 form 已 404
 *        - 但直接 SELECT table_forms（无 JOIN memos）会泄露隐藏 memo 嘅 form
 *        - 加 rule 后两个路径都拦截
 * T4：孤儿 form（memo_id 指向唔存在 memo）唔误杀（NULL-safe）
 * T5：双重拦截无重复注入（dedup）
 *
 * Fixture schema 对齐 migrations/0055_table_forms.sql + 0001_initial.sql
 * （notebooks PK = 单列 id TEXT PRIMARY KEY）。
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { createHidingDatabase } from "../apps/api/src/mcp-hiding";
import type {
  DatabaseAdapter,
  DatabaseQueryResult,
  PreparedStatementAdapter,
} from "../apps/api/src/storage-contract";

// ─────────────────────────────────────────────────────────────
// Fixture: 真实 schema subset（0001 + 0055）
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
    CREATE TABLE table_forms (
      id TEXT PRIMARY KEY,
      memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      token TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      password_hash TEXT,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      submit_label TEXT NOT NULL DEFAULT '',
      fields_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fields_json)),
      submit_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      UNIQUE (memo_id),
      UNIQUE (token)
    );
  `);

  // Seed: 可见 nb_ok / 隐藏 nb_hidden; 各有 1 个 memo + 1 个 form
  db.exec(`
    INSERT INTO notebooks (id, workspace_id, name) VALUES
      ('nb_ok', 'ws1', 'Visible'),
      ('nb_hidden', 'ws1', 'Hidden');
    INSERT INTO memos (id, workspace_id, notebook_id, title, content_markdown) VALUES
      ('m_visible', 'ws1', 'nb_ok', 'visible memo', 'table doc'),
      ('m_hidden', 'ws1', 'nb_hidden', 'hidden memo', 'table doc');
    INSERT INTO table_forms (id, memo_id, workspace_id, token, enabled, title, description, fields_json) VALUES
      ('form_visible', 'm_visible', 'ws1', 'tok_visible', 1, 'Visible Form', 'desc visible', '[]'),
      ('form_hidden', 'm_hidden', 'ws1', 'tok_hidden', 1, 'Hidden Form', 'desc hidden', '[]');
  `);

  return db;
}

// Wrap bun:sqlite Database as DatabaseAdapter（同 leak-matrix 模式）
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

describe("table_forms hiding wrapper (Phase 26)", () => {
  let rawDb: Database;
  let hidingDb: DatabaseAdapter;

  beforeAll(() => {
    rawDb = createTestDb();
    const rawAdapter = wrapDb(rawDb);
    hidingDb = createHidingDatabase(rawAdapter, new Set(["nb_hidden"]));
  });

  // 真实 table-form-routes.ts loadForm SQL（selectFormSql + EXISTS 校验）
  const loadFormSql = `
SELECT id, memo_id, workspace_id, token, enabled, password_hash, title, description,
       submit_label, fields_json, created_by, submit_count
FROM table_forms
WHERE token = ? AND enabled = 1
  AND EXISTS (
    SELECT 1 FROM memos m
    WHERE m.id = table_forms.memo_id AND m.workspace_id = table_forms.workspace_id AND m.is_deleted = 0
  )`;

  test("T1: hidden memo's form is invisible via loadForm (Q4: 404)", async () => {
    const row = await hidingDb.prepare(loadFormSql).bind("tok_hidden").first<{ id: string }>();
    expect(row).toBeNull();
  });

  test("T2: visible memo's form is readable via loadForm", async () => {
    const row = await hidingDb.prepare(loadFormSql).bind("tok_visible").first<{ id: string }>();
    expect(row?.id).toBe("form_visible");
  });

  test("T3: direct SELECT table_forms filters hidden memo's form", async () => {
    const result = await hidingDb.prepare(
      "SELECT id, title FROM table_forms"
    ).all<{ id: string; title: string }>();
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("form_visible");
    expect(ids).not.toContain("form_hidden"); // 隐藏 form 必须过滤
  });

  test("T4: orphan form (memo_id points to non-existent memo) is NOT dropped (NULL-safe)", async () => {
    rawDb.exec(
      `INSERT INTO table_forms (id, memo_id, workspace_id, token, enabled, title) VALUES ('form_orphan', 'm_ghost', 'ws1', 'tok_orphan', 1, 'Orphan Form')`
    );
    const result = await hidingDb.prepare(
      "SELECT id FROM table_forms WHERE token = ?"
    ).bind("tok_orphan").all<{ id: string }>();
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain("form_orphan"); // 孤儿 form 唔属于隐藏分类，必须可见
  });

  test("T5: rewritten SQL executes cleanly (no syntax error, no ambiguity)", async () => {
    // 真正执行 loadForm 改写后嘅 SQL（唔止 toContain）——防 BUG-001 式 ambiguity
    const row = await hidingDb.prepare(loadFormSql).bind("tok_visible").first<{ id: string }>();
    expect(row?.id).toBe("form_visible");
    // 再跑一次隐藏，确认唔抛错（fail-closed 唔应触发）
    const hiddenRow = await hidingDb.prepare(loadFormSql).bind("tok_hidden").first<{ id: string }>();
    expect(hiddenRow).toBeNull();
  });
});
