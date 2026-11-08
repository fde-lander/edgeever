/**
 * A-point TDD: isReadQuery() must NOT treat `WITH ... UPDATE/INSERT/DELETE`
 * as a read query.
 *
 * SPEC V1.2 §6.4 (MASTER directive 2026-11-08): the upstream
 * `deleteNotebookTree` guarded UPDATE starts with `WITH RECURSIVE`, and the
 * legacy `isReadQuery()` only inspected the FIRST token, so a CTE-prefixed
 * write statement was misclassified as a read query and got rewritten.
 * The run happened to be safe, but it was coincidence, not design.
 *
 * This suite pins the contract:
 *   - a statement is READ only when its first top-level statement keyword is SELECT
 *   - `WITH <cte> SELECT`            → READ  (injects hiding filters)
 *   - `WITH <cte> UPDATE/INSERT/DELETE` → WRITE (byte-identical passthrough)
 *
 * Pattern follows tests/mcp-hiding.test.ts (MockStatement + MockDatabaseAdapter).
 */
import { describe, expect, test } from "bun:test";
import { createHidingDatabase } from "../apps/api/src/mcp-hiding";
import type {
  DatabaseAdapter,
  DatabaseQueryResult,
  PreparedStatementAdapter,
} from "../apps/api/src/storage-contract";

// ─────────────────────────────────────────────────────────────
// Mock implementations (same shape as tests/mcp-hiding.test.ts)
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

/** Records the exact SQL string handed to the underlying adapter. */
class MockDatabaseAdapter implements DatabaseAdapter {
  public preparedSql: string[] = [];

  prepare(sql: string): PreparedStatementAdapter {
    this.preparedSql.push(sql);
    return new MockStatement(sql);
  }

  async batch<T = unknown>(
    statements: PreparedStatementAdapter[],
  ): Promise<DatabaseQueryResult<T>[]> {
    return statements.map(() => ({ results: [], success: true, meta: {} }) as DatabaseQueryResult<T>);
  }
}

const HIDDEN = new Set<string>(["nb_hidden"]);

/** Build a hiding db over a recorder adapter. */
const makeHidingDb = () => {
  const adapter = new MockDatabaseAdapter();
  const db = createHidingDatabase(adapter, HIDDEN);
  return { adapter, db };
};

// Wraps a statement so at least one content table is touched. Used to prove
// that a read query WOULD be injected (control case for T1/T5).
//
// IMPORTANT (TDD discipline, learned the hard way here): the WRITE cases below
// put a *memos* reference inside the CTE on purpose. A notebooks-only CTE is
// swallowed by the D4 tree-walk exemption and makes these tests pass for the
// wrong reason — the exact "false green" trap this suite exists to prevent.
const CTE_SELECT = `WITH RECURSIVE tree(id) AS (
  SELECT id FROM notebooks WHERE workspace_id = ? AND id = ?
  UNION ALL
  SELECT n.id FROM notebooks n JOIN tree t ON n.parent_id = t.id WHERE n.workspace_id = ?
)
SELECT n.id, n.slug FROM notebooks n JOIN tree t ON t.id = n.id WHERE n.workspace_id = ?`;

const CTE_UPDATE = `WITH RECURSIVE tree(id) AS (
  SELECT notebook_id AS id FROM memos WHERE workspace_id = ?
)
UPDATE notebooks SET is_deleted = 1, deleted_at = ?, updated_at = ?
WHERE workspace_id = ? AND is_deleted = 0 AND id IN (SELECT id FROM tree)`;

const CTE_INSERT = `WITH RECURSIVE tree(id) AS (
  SELECT notebook_id AS id FROM memos WHERE workspace_id = ?
)
INSERT INTO memo_tags(memo_id, name) SELECT id, ? FROM tree`;

const CTE_DELETE = `WITH RECURSIVE tree(id) AS (
  SELECT notebook_id AS id FROM memos WHERE workspace_id = ?
)
DELETE FROM memo_tags WHERE memo_id IN (SELECT id FROM tree)`;

describe("A-point: isReadQuery classification (WITH...UPDATE must be WRITE)", () => {
  // ── T1: control — WITH ... SELECT is a READ and MUST be injected ──
  test("T1: WITH RECURSIVE ... SELECT is READ and receives hiding injection", () => {
    const { adapter, db } = makeHidingDb();
    db.prepare(CTE_SELECT);
    const sql = adapter.preparedSql[0];
    expect(sql).toContain("NOT IN");
    expect(sql).toContain("nb_hidden");
  });

  // ── T2: the bug — WITH ... UPDATE must pass through untouched ──
  test("T2: WITH RECURSIVE ... UPDATE is WRITE and passes through unchanged", () => {
    const { adapter, db } = makeHidingDb();
    db.prepare(CTE_UPDATE);
    const sql = adapter.preparedSql[0];
    expect(sql).not.toContain("NOT IN");
    expect(sql).not.toContain("nb_hidden");
  });

  // ── T3: WITH ... INSERT ──
  test("T3: WITH ... INSERT is WRITE and passes through unchanged", () => {
    const { adapter, db } = makeHidingDb();
    db.prepare(CTE_INSERT);
    const sql = adapter.preparedSql[0];
    expect(sql).not.toContain("NOT IN");
    expect(sql).not.toContain("nb_hidden");
  });

  // ── T4: WITH ... DELETE ──
  test("T4: WITH ... DELETE is WRITE and passes through unchanged", () => {
    const { adapter, db } = makeHidingDb();
    db.prepare(CTE_DELETE);
    const sql = adapter.preparedSql[0];
    expect(sql).not.toContain("NOT IN");
    expect(sql).not.toContain("nb_hidden");
  });

  // ── T5: real CTE + outer SELECT over a content table → READ + injected ──
  test("T5: WITH CTE then outer SELECT over content table is READ and injected", () => {
    const { adapter, db } = makeHidingDb();
    const sqlIn = `WITH RECURSIVE hidden(id) AS (
      SELECT id FROM notebooks WHERE workspace_id = ?
    )
    SELECT m.id, m.title FROM memos m WHERE m.notebook_id IN (SELECT id FROM hidden)`;
    db.prepare(sqlIn);
    const sql = adapter.preparedSql[0];
    expect(sql).toContain("NOT IN");
    expect(sql).toContain("nb_hidden");
  });

  // ── T6: byte-identical passthrough is the hard proof ──
  test("T6: WITH ... UPDATE is passed through byte-for-byte identical", () => {
    const { adapter, db } = makeHidingDb();
    db.prepare(CTE_UPDATE);
    expect(adapter.preparedSql[0]).toBe(CTE_UPDATE);
  });

  // ── T7: regression — plain leading keywords keep their old classification ──
  test("T7a: plain SELECT over content table is READ and injected", () => {
    const { adapter, db } = makeHidingDb();
    db.prepare(`SELECT * FROM memos WHERE workspace_id = ?`);
    expect(adapter.preparedSql[0]).toContain("NOT IN");
  });

  test("T7b: plain UPDATE stays byte-identical (WRITE)", () => {
    const { adapter, db } = makeHidingDb();
    const sqlIn = `UPDATE memos SET title = ? WHERE id = ?`;
    db.prepare(sqlIn);
    expect(adapter.preparedSql[0]).toBe(sqlIn);
  });

  test("T7c: plain INSERT stays byte-identical (WRITE)", () => {
    const { adapter, db } = makeHidingDb();
    const sqlIn = `INSERT INTO memos(id, title) VALUES (?, ?)`;
    db.prepare(sqlIn);
    expect(adapter.preparedSql[0]).toBe(sqlIn);
  });

  test("T7d: plain DELETE stays byte-identical (WRITE)", () => {
    const { adapter, db } = makeHidingDb();
    const sqlIn = `DELETE FROM memos WHERE id = ?`;
    db.prepare(sqlIn);
    expect(adapter.preparedSql[0]).toBe(sqlIn);
  });
});
