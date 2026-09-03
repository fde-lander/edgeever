/**
 * BUG-002 DIAG — investigation artifact (kept per MASTER decision Q7 = keep).
 *
 * Purpose: capture the EXACT SQL the hiding wrapper produces for getNotebook,
 * using a fake adapter that logs (never executes) the statement it receives.
 * It is NOT a bun:test file (run manually: `bun tests/repro-create-notebook-diag.ts`)
 * and is NOT part of `bun test` collection.
 *
 * Why it exists: `repro-create-notebook.ts` proves the row disappears; this
 * script shows WHY by printing the rewritten SQL, so the offending fragment is
 * visible without guessing.
 *
 * Expected output BEFORE the fde-v1.50.0.3 NULL-safe fix (2026-09-02 verified):
 *   ... WHERE n.id = ? AND n.workspace_id = ? AND n.is_deleted = 0
 *       AND n.id NOT IN ('nb_hidden_1', 'nb_hidden_2')
 *       AND m.notebook_id NOT IN ('nb_hidden_1', 'nb_hidden_2')
 *                            ^^^ this fragment kills LEFT-JOIN NULL rows
 *
 * Expected output AFTER the fix:
 *   ... AND (m.notebook_id IS NULL OR m.notebook_id NOT IN ('nb_hidden_1', 'nb_hidden_2'))
 *
 * Permanent regression coverage lives in:
 *   - tests/mcp-hiding-null-join.test.ts
 */
import { Database } from "bun:sqlite";
import { createHidingDatabase } from "../apps/api/src/mcp-hiding";
import type { DatabaseAdapter } from "../apps/api/src/storage-contract";

const HIDDEN = ["nb_hidden_1", "nb_hidden_2"];

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

// Fake adapter that LOGS the SQL it receives
const loggingAdapter = {
  prepare(sql: string) {
    return {
      __sql: sql,
      bind(...args: unknown[]) {
        return {
          first: async () => ({ __sql: sql, args }),
          all: async () => ({ results: [], __sql: sql, args }),
        };
      },
      first: async () => ({ __sql: sql }),
      all: async () => ({ results: [] }),
      run: async () => ({}),
    };
  },
  async batch(statements: unknown[]) {
    return statements;
  },
} as unknown as DatabaseAdapter;

const wrapped = createHidingDatabase(loggingAdapter, new Set(HIDDEN));

console.log("=== ORIGINAL getNotebook SQL ===");
console.log(getNotebookSql.trim());

console.log("\n=== what the wrapper actually passes to the underlying DB ===");
const stmt = wrapped.prepare(getNotebookSql);
const bound = (stmt as unknown as { bind: (...a: unknown[]) => { first: () => Promise<{ __sql: string }> } }).bind(
  "nb_test_1",
  "ws_default",
);
const result = await bound.first();
console.log((result as unknown as { __sql: string }).__sql);
