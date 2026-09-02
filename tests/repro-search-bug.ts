/**
 * Reproduce search SQL rewriting with the REAL mcp-hiding.ts tokenizer logic.
 * Goal: verify the "ambiguous column name: memo_id" root cause (BUG-001).
 *
 * NOTE (Phase 11, fde-v1.50.0.2): this repro documents the PRE-FIX bug state
 * and is kept as investigation evidence (run manually: `bun tests/repro-search-bug.ts`).
 * After the scope-aware injection fix, the "ambiguous bare memo_id" assertions
 * below describe what the OLD (broken) behavior looked like — the fixed
 * behavior is asserted in tests/mcp-hiding-real-sqlite.test.ts.
 *
 * Original search SQL (memo-service.ts searchMemoSummaries FTS branch):
 *   WITH raw_matches(memo_id, rank) AS (
 *     SELECT memo_id, bm25(memos_fts) FROM memos_fts WHERE memos_fts MATCH ?
 *     UNION ALL
 *     SELECT m.id, 100.0 FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id ...
 *   ), search_matches AS (...)
 *   SELECT ... FROM search_matches s INNER JOIN memos m ... INNER JOIN memo_contents c ...
 *   WHERE m.workspace_id = ? AND m.is_deleted = 0 LIMIT ?
 */
import { createHidingDatabase } from "../apps/api/src/mcp-hiding";
import type { DatabaseAdapter, PreparedStatementAdapter } from "../apps/api/src/storage-contract";

// Fake underlying adapter that captures the rewritten SQL
const captured: string[] = [];
const fakeInnerStmt = {
  bind: (..._v: unknown[]) => fakeInnerStmt,
  first: async () => null,
  run: async () => ({ results: [], meta: {} }),
  all: async () => ({ results: [], meta: {} }),
} as unknown as PreparedStatementAdapter;

const fakeDb: DatabaseAdapter = {
  prepare(sql: string): PreparedStatementAdapter {
    captured.push(sql);
    return fakeInnerStmt;
  },
  async batch<T = unknown>(statements: PreparedStatementAdapter[]) {
    return [] as DatabaseQueryResult<T>[];
  },
} as unknown as DatabaseAdapter;

const hidingDb = createHidingDatabase(fakeDb, new Set(["nb_hidden_1"]));

const SEARCH_SQL = `WITH raw_matches(memo_id, rank) AS (
  SELECT memo_id, bm25(memos_fts)
  FROM memos_fts
  WHERE memos_fts MATCH ?
  UNION ALL
  SELECT m.id, 100.0
  FROM memos m
  INNER JOIN memo_contents c ON c.memo_id = m.id
  WHERE m.title LIKE ? ESCAPE '\\\\'
), search_matches AS (
  SELECT memo_id, MIN(rank) AS rank
  FROM raw_matches
  GROUP BY memo_id
)
SELECT m.id, m.notebook_id, m.title
FROM search_matches s
INNER JOIN memos m ON m.id = s.memo_id
INNER JOIN memo_contents c ON c.memo_id = m.id
WHERE m.workspace_id = ? AND m.is_deleted = 0
LIMIT ?`;

console.log("=== REWRITTEN SQL ===\n");
hidingDb.prepare(SEARCH_SQL);
console.log(captured[0]);
console.log("\n=== ANALYSIS ===\n");

// Key checks
const s = captured[0];
const checks: Array<[string, boolean]> = [
  ["outer WHERE got AND injection (memos m)", s.includes("m.notebook_id NOT IN")],
  ["memo_contents c got alias injection", s.includes("c.memo_id NOT IN")],
  ["memos_fts got bare memo_id subquery", s.includes(" memo_id NOT IN (SELECT id FROM memos WHERE notebook_id IN ('nb_hidden_1'))")],
  ["bare memo_id injected (ambiguous!)", /(^|\s)memo_id NOT IN/.test(s)],
];

let fail = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}`);
  if (!ok) fail = true;
}

console.log("\n=== ROOT CAUSE CONFIRMATION ===\n");
// The bare memo_id injection inside CTE raw_matches:
//   SELECT memo_id, bm25(memos_fts) FROM memos_fts WHERE memos_fts MATCH ? AND memo_id NOT IN (...)
// memos_fts HAS memo_id column → OK there? BUT it also gets injected in the outer query!
// Outer query: FROM search_matches s INNER JOIN memos m INNER JOIN memo_contents c
//   → both search_matches (alias s) and memo_contents c have memo_id
//   → "AND memo_id NOT IN (...)" appended to outer WHERE is ambiguous → SQLite error.
const outerWhereHasBare = /WHERE m\.workspace_id = \? AND m\.is_deleted = 0 AND memo_id NOT IN/.test(s);
console.log(`Outer WHERE has ambiguous bare memo_id injection: ${outerWhereHasBare}`);
process.exit(fail ? 1 : 0);
