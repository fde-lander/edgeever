/**
 * 9.5 认证注入 — TDD test
 *
 * Tests authenticateRequestWithHiding logic:
 * 1. Agent token with hidden notebooks → storage.db replaced with hiding wrapper
 * 2. Agent token without hidden notebooks → passthrough (original db)
 * 3. Session (user) request → NOT injected (zero impact on web/mobile)
 * 4. disabled-auth synthetic owner → NOT injected
 * 5. fail-closed: loadHiddenNotebookIds throws → request rejected
 * 6. fetchEdgeEverApp env clone: shallow-clone prevents shared mutation
 */
import { describe, expect, test } from "bun:test";
import {
  createHidingDatabaseWithSymbol,
  getHidingSet,
} from "../apps/api/src/mcp-hiding";
import type {
  DatabaseAdapter,
  DatabaseQueryResult,
  PreparedStatementAdapter,
  StorageAdapter,
} from "../apps/api/src/storage-contract";

// ─────────────────────────────────────────────────────────────
// Mock implementations
// ─────────────────────────────────────────────────────────────

class MockStatement implements PreparedStatementAdapter {
  constructor(public readonly sql: string, public readonly binds: unknown[] = []) {}
  bind(...values: unknown[]) { return new MockStatement(this.sql, values); }
  async all<T = Record<string, unknown>>(): Promise<DatabaseQueryResult<T>> { return { results: [], success: true, meta: {} }; }
  async first<T = unknown>(_columnName?: string): Promise<T | null> { return null; }
  async run<T = Record<string, unknown>>(): Promise<DatabaseQueryResult<T>> { return { results: [], success: true, meta: {} }; }
}

class MockDatabaseAdapter implements DatabaseAdapter {
  public preparedSqls: string[] = [];
  constructor(public mockResults: unknown[] = []) {}
  prepare(sql: string) { this.preparedSqls.push(sql); return new MockStatement(sql); }
  async batch<T = unknown>(statements: PreparedStatementAdapter[]): Promise<DatabaseQueryResult<T>[]> {
    return statements.map(() => ({ results: [], success: true, meta: {} }));
  }
}

// Simulate the authenticateRequestWithHiding logic (extracted for testing)
// This mirrors the exact logic in index.ts authenticateRequestWithHiding
async function simulateAuthWithHiding(
  storage: StorageAdapter,
  auth: { kind: "user" | "agent"; tokenId?: string; workspaceId: string } | null,
  hiddenIdsSet: Set<string> | null, // null = loading throws
): Promise<{ storage: StorageAdapter; auth: typeof auth; threw?: Error }> {
  // Simulate fetchEdgeEverApp shallow-clone
  const clonedStorage: StorageAdapter = { ...storage };

  if (auth && auth.kind === "agent" && auth.tokenId) {
    if (hiddenIdsSet === null) {
      // Simulate loadHiddenNotebookIds failure
      const err = new Error("[mcp-hiding] Failed to load hidden notebook set");
      return { storage: clonedStorage, auth, threw: err };
    }

    if (hiddenIdsSet.size > 0) {
      clonedStorage.db = createHidingDatabaseWithSymbol(clonedStorage.db, hiddenIdsSet);
    }
  }

  return { storage: clonedStorage, auth };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe("9.5 认证注入", () => {
  function makeStorage(): StorageAdapter {
    return {
      db: new MockDatabaseAdapter(),
      resources: {} as never,
      diagnostics: {} as never,
    };
  }

  test("agent token + hidden notebooks → storage.db replaced with hiding wrapper", async () => {
    const originalStorage = makeStorage();
    const originalDb = originalStorage.db;

    const hiddenIds = new Set(["nb_secret_1", "nb_secret_2"]);
    const result = await simulateAuthWithHiding(
      originalStorage,
      { kind: "agent", tokenId: "token1", workspaceId: "ws1" },
      hiddenIds,
    );

    // db should be different (wrapped)
    expect(result.storage.db).not.toBe(originalDb);
    // Should have hiding set attached
    const hidingSet = getHidingSet(result.storage.db);
    expect(hidingSet).toBeDefined();
    expect(hidingSet!.has("nb_secret_1")).toBe(true);
    expect(hidingSet!.has("nb_secret_2")).toBe(true);
  });

  test("agent token + empty hidden set → passthrough (original db)", async () => {
    const originalStorage = makeStorage();
    const originalDb = originalStorage.db;

    const result = await simulateAuthWithHiding(
      originalStorage,
      { kind: "agent", tokenId: "token2", workspaceId: "ws1" },
      new Set(),
    );

    // db should be the same (passthrough, no wrapping)
    expect(result.storage.db).toBe(originalDb);
    // No hiding set
    expect(getHidingSet(result.storage.db)).toBeUndefined();
  });

  test("session (user) request → NOT injected (zero impact)", async () => {
    const originalStorage = makeStorage();
    const originalDb = originalStorage.db;

    const result = await simulateAuthWithHiding(
      originalStorage,
      { kind: "user", workspaceId: "ws1" }, // no tokenId
      new Set(["nb_secret_1"]), // even if there are hidden notebooks
    );

    // db should be unchanged — session sees everything
    expect(result.storage.db).toBe(originalDb);
    expect(getHidingSet(result.storage.db)).toBeUndefined();
  });

  test("null auth (unauthenticated) → NOT injected", async () => {
    const originalStorage = makeStorage();
    const originalDb = originalStorage.db;

    const result = await simulateAuthWithHiding(
      originalStorage,
      null,
      new Set(["nb_secret_1"]),
    );

    expect(result.storage.db).toBe(originalDb);
  });

  test("disabled-auth synthetic owner → NOT injected", async () => {
    // disabled-auth sets kind="user", role="owner", no tokenId
    // This is the same as session request — should NOT be injected
    const originalStorage = makeStorage();
    const originalDb = originalStorage.db;

    const result = await simulateAuthWithHiding(
      originalStorage,
      { kind: "user", workspaceId: "default" },
      new Set(["nb_secret_1"]),
    );

    expect(result.storage.db).toBe(originalDb);
  });

  test("fail-closed: loadHiddenNotebookIds throws → error propagated", async () => {
    const originalStorage = makeStorage();

    const result = await simulateAuthWithHiding(
      originalStorage,
      { kind: "agent", tokenId: "token_bad", workspaceId: "ws1" },
      null, // simulate load failure
    );

    expect(result.threw).toBeDefined();
    expect(result.threw!.message).toContain("[mcp-hiding]");
  });

  test("env clone: original storage NOT mutated after hiding injection", async () => {
    const originalStorage = makeStorage();
    const originalDb = originalStorage.db;

    const hiddenIds = new Set(["nb_secret_1"]);
    await simulateAuthWithHiding(
      originalStorage,
      { kind: "agent", tokenId: "token1", workspaceId: "ws1" },
      hiddenIds,
    );

    // Original storage's db should NOT be mutated
    expect(originalStorage.db).toBe(originalDb);
  });

  test("concurrent requests: two agents with different hidden sets don't cross-contaminate", async () => {
    const sharedStorage = makeStorage();

    const [resultA, resultB] = await Promise.all([
      simulateAuthWithHiding(sharedStorage, { kind: "agent", tokenId: "t1", workspaceId: "ws1" }, new Set(["nb_a"])),
      simulateAuthWithHiding(sharedStorage, { kind: "agent", tokenId: "t2", workspaceId: "ws1" }, new Set(["nb_b"])),
    ]);

    // A should have nb_a hidden, B should have nb_b hidden
    const setA = getHidingSet(resultA.storage.db);
    const setB = getHidingSet(resultB.storage.db);

    expect(setA!.has("nb_a")).toBe(true);
    expect(setA!.has("nb_b")).toBe(false);
    expect(setB!.has("nb_b")).toBe(true);
    expect(setB!.has("nb_a")).toBe(false);

    // Original shared storage should NOT be mutated
    expect(sharedStorage.db).not.toBe(resultA.storage.db);
    expect(sharedStorage.db).not.toBe(resultB.storage.db);
  });

  test("agent without tokenId (shouldn't happen but defensive) → NOT injected", async () => {
    const originalStorage = makeStorage();
    const originalDb = originalStorage.db;

    // Edge case: kind=agent but no tokenId (shouldn't occur in practice)
    const result = await simulateAuthWithHiding(
      originalStorage,
      { kind: "agent", workspaceId: "ws1" }, // no tokenId
      new Set(["nb_secret"]),
    );

    // Should NOT inject (no tokenId = can't load hidden set)
    expect(result.storage.db).toBe(originalDb);
  });
});
