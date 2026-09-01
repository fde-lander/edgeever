/**
 * 9.6 写入守卫 — TDD test
 *
 * Tests hiding-guards.ts write guard logic:
 * 1. assertNotebookWritable: hidden notebook → throws HiddenNotebookError
 * 2. assertNotebookWritable: non-hidden notebook → no-op
 * 3. assertNotebookWritable: no hiding set (session) → no-op
 * 4. assertNotebooksWritable: batch check
 * 5. Guards integrated in Record functions (via mock verification)
 */
import { describe, expect, test } from "bun:test";
import {
  assertNotebookWritable,
  assertNotebooksWritable,
  HiddenNotebookError,
} from "../apps/api/src/hiding-guards";
import { createHidingDatabaseWithSymbol } from "../apps/api/src/mcp-hiding";
import type {
  DatabaseAdapter,
  DatabaseQueryResult,
  PreparedStatementAdapter,
} from "../apps/api/src/storage-contract";

// ─────────────────────────────────────────────────────────────
// Mock
// ─────────────────────────────────────────────────────────────

class MockStatement implements PreparedStatementAdapter {
  constructor(public readonly sql: string) {}
  bind(..._v: unknown[]) { return this; }
  async all<T = Record<string, unknown>>(): Promise<DatabaseQueryResult<T>> { return { results: [], success: true, meta: {} }; }
  async first<T = unknown>(_c?: string): Promise<T | null> { return null; }
  async run<T = Record<string, unknown>>(): Promise<DatabaseQueryResult<T>> { return { results: [], success: true, meta: {} }; }
}

class MockDatabaseAdapter implements DatabaseAdapter {
  prepare(sql: string) { return new MockStatement(sql); }
  async batch<T = unknown>(s: PreparedStatementAdapter[]): Promise<DatabaseQueryResult<T>[]> {
    return s.map(() => ({ results: [], success: true, meta: {} }));
  }
}

describe("9.6 写入守卫", () => {
  const hiddenIds = new Set(["nb_secret_1", "nb_secret_2"]);

  test("assertNotebookWritable: hidden notebook → throws", () => {
    const db = createHidingDatabaseWithSymbol(new MockDatabaseAdapter(), hiddenIds);
    expect(() => assertNotebookWritable(db, "nb_secret_1")).toThrow(HiddenNotebookError);
    expect(() => assertNotebookWritable(db, "nb_secret_1")).toThrow(/restricted/);
  });

  test("assertNotebookWritable: non-hidden notebook → no-op", () => {
    const db = createHidingDatabaseWithSymbol(new MockDatabaseAdapter(), hiddenIds);
    expect(() => assertNotebookWritable(db, "nb_public")).not.toThrow();
  });

  test("assertNotebookWritable: no hiding set (session) → no-op", () => {
    // Raw db without hiding wrapper = session request
    const db = new MockDatabaseAdapter();
    expect(() => assertNotebookWritable(db, "nb_secret_1")).not.toThrow();
  });

  test("assertNotebooksWritable: batch check throws on first hidden", () => {
    const db = createHidingDatabaseWithSymbol(new MockDatabaseAdapter(), hiddenIds);
    expect(() => assertNotebooksWritable(db, ["nb_public", "nb_secret_1", "nb_secret_2"])).toThrow(HiddenNotebookError);
  });

  test("assertNotebooksWritable: all public → no-op", () => {
    const db = createHidingDatabaseWithSymbol(new MockDatabaseAdapter(), hiddenIds);
    expect(() => assertNotebooksWritable(db, ["nb_public1", "nb_public2"])).not.toThrow();
  });

  test("assertNotebooksWritable: empty list → no-op", () => {
    const db = createHidingDatabaseWithSymbol(new MockDatabaseAdapter(), hiddenIds);
    expect(() => assertNotebooksWritable(db, [])).not.toThrow();
  });

  test("HiddenNotebookError message includes notebook ID", () => {
    try {
      const db = createHidingDatabaseWithSymbol(new MockDatabaseAdapter(), hiddenIds);
      assertNotebookWritable(db, "nb_secret_1");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HiddenNotebookError);
      expect((err as Error).message).toContain("nb_secret_1");
    }
  });
});
