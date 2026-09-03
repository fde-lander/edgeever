/**
 * TDD RED-2 — BUG-003 tag rename/delete outcome verification (fde-v1.50.0.3).
 *
 * BUG-003: `updateTagAcrossMemos` counted `updated` with a JS loop counter and
 * threw away the return value of `db.batch(statements)`. So `{ok:true,
 * updated:1}` only ever meant "assembled 1 statement" — never "1 row landed in
 * the database". MASTER observed a rename responding successfully while
 * list_tags ground truth was unchanged (~1 in 20 renames); that observation is
 * fully explained by this response-semantics hole.
 *
 * The fix re-reads ground truth after the write and reports `verified` +
 * `remainingOldTag`. Q3 = lenient: a failed verification does NOT throw (409
 * would abort long batch runs) — the caller sees verified:false and can retry,
 * since rename is idempotent.
 *
 * NOT fixed / NOT claimed: the trigger condition for a real single write loss is
 * still unreproduced. These tests lock in "silent failure becomes visible
 * failure", not "loss is eliminated".
 *
 * Uses a REAL bun:sqlite database with the REAL trigger from
 * migrations/0035_normalized_memo_tags.sql:24, because the whole point is
 * ground-truth re-reading. `swallowWrites` simulates a batch that reports
 * success without persisting — the silent-loss shape.
 *
 * ⚠️ SQLite `changes` is NOT usable to detect the write: the trigger's
 * DELETE+INSERT on memo_tags inflates it (a single-row UPDATE measured
 * changes=5). Ground-truth re-read is the only reliable signal.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { previewTagRename, updateTagAcrossMemos } from "../apps/api/src/tag-service";
import type { AuditActor } from "../apps/api/src/api-context";
import type {
  DatabaseAdapter,
  DatabaseQueryResult,
  PreparedStatementAdapter,
} from "../apps/api/src/storage-contract";

const ACTOR: AuditActor = { actorType: "agent", actorId: "tok_test" };
const ACTOR_LABEL = "agent:tok_test";

type Harness = {
  db: Database;
  adapter: DatabaseAdapter;
  /** When true, batch() reports success without persisting anything. */
  setSwallowWrites: (value: boolean) => void;
  tagRows: () => { memo_id: string; name: string }[];
};

function createHarness(): Harness {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE memos (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      notebook_id TEXT NOT NULL DEFAULT 'nb_ok',
      title TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE memo_contents (
      memo_id TEXT PRIMARY KEY,
      content_text TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE memo_tags (
      memo_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      PRIMARY KEY (memo_id, name),
      FOREIGN KEY (memo_id) REFERENCES memos(id) ON UPDATE CASCADE ON DELETE CASCADE
    );
    CREATE TABLE memo_search_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memo_id TEXT NOT NULL UNIQUE,
      title TEXT,
      content_text TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      actor_type TEXT,
      actor_id TEXT,
      action TEXT,
      entity_type TEXT,
      entity_id TEXT,
      metadata_json TEXT,
      created_at TEXT
    );
  `);
  // Real trigger, verbatim from migrations/0035_normalized_memo_tags.sql:24
  db.exec(
    `CREATE TRIGGER trg_memo_tags_update AFTER UPDATE OF tags_json, workspace_id ON memos WHEN OLD.tags_json <> NEW.tags_json OR OLD.workspace_id <> NEW.workspace_id BEGIN DELETE FROM memo_tags WHERE memo_id = NEW.id; INSERT OR IGNORE INTO memo_tags (memo_id, workspace_id, name, normalized_name) SELECT NEW.id, NEW.workspace_id, trim(CAST(value AS TEXT)), lower(trim(CAST(value AS TEXT))) FROM json_each(NEW.tags_json) WHERE trim(CAST(value AS TEXT)) <> ''; END;`
  );

  db.exec(`
    INSERT INTO memos (id, workspace_id, title, tags_json) VALUES
      ('m1', 'ws1', 'First', '["server","health"]'),
      ('m2', 'ws1', 'Second', '["server"]'),
      ('m3', 'ws1', 'Third', '["unrelated"]');
    INSERT INTO memo_contents (memo_id, content_text) VALUES
      ('m1', 'body one'), ('m2', 'body two'), ('m3', 'body three');
    INSERT INTO memo_tags (memo_id, workspace_id, name, normalized_name)
      SELECT m.id, m.workspace_id, trim(CAST(t.value AS TEXT)), lower(trim(CAST(t.value AS TEXT)))
      FROM memos m, json_each(m.tags_json) AS t;
  `);

  let swallowWrites = false;

  class Stmt implements PreparedStatementAdapter {
    constructor(readonly sql: string, readonly boundValues: unknown[] = []) {}
    bind(...values: unknown[]): PreparedStatementAdapter {
      return new Stmt(this.sql, values);
    }
    async first<T = unknown>(): Promise<T | null> {
      return (db.prepare(this.sql).get(...(this.boundValues as never[])) ?? null) as T | null;
    }
    async run<T = unknown>(): Promise<DatabaseQueryResult<T>> {
      const result = db.prepare(this.sql).run(...(this.boundValues as never[]));
      return { results: [], success: true, meta: { ...result } as Record<string, unknown> } as unknown as DatabaseQueryResult<T>;
    }
    async all<T = unknown>(): Promise<DatabaseQueryResult<T>> {
      return {
        results: db.prepare(this.sql).all(...(this.boundValues as never[])) as T[],
        success: true,
        meta: {},
      } as unknown as DatabaseQueryResult<T>;
    }
  }

  const adapter: DatabaseAdapter = {
    prepare: (sql: string) => new Stmt(sql),
    async batch<T = unknown>(statements: PreparedStatementAdapter[]): Promise<DatabaseQueryResult<T>[]> {
      const out: DatabaseQueryResult<T>[] = [];
      if (swallowWrites) {
        // Reports success for every statement while persisting nothing —
        // exactly the shape of the silent loss MASTER observed.
        return statements.map(
          () => ({ results: [], success: true, meta: {} }) as unknown as DatabaseQueryResult<T>
        );
      }
      db.transaction(() => {
        for (const statement of statements) {
          const stmt = statement as Stmt;
          db.prepare(stmt.sql).run(...(stmt.boundValues as never[]));
          out.push({ results: [], success: true, meta: {} } as unknown as DatabaseQueryResult<T>);
        }
      })();
      return out;
    },
  } as unknown as DatabaseAdapter;

  return {
    db,
    adapter,
    setSwallowWrites: (value: boolean) => {
      swallowWrites = value;
    },
    tagRows: () =>
      db.query("SELECT memo_id, name FROM memo_tags ORDER BY memo_id, name").all() as {
        memo_id: string;
        name: string;
      }[],
  };
}

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

describe("tag rename/delete outcome verification (BUG-003)", () => {
  test("T9 normal rename across 2 memos reports verified with ground truth updated", async () => {
    const outcome = await updateTagAcrossMemos(
      harness.adapter,
      "ws1",
      "server",
      "srv",
      ACTOR,
      ACTOR_LABEL
    );

    expect(outcome).toEqual({ updated: 2, verified: true, remainingOldTag: 0 });

    const names = harness.tagRows().map((r) => `${r.memo_id}:${r.name}`);
    expect(names).toContain("m1:srv");
    expect(names).toContain("m2:srv");
    expect(names).not.toContain("m1:server");
    expect(names).not.toContain("m2:server");
  });

  test("T10 a batch that silently drops writes must report verified:false", async () => {
    harness.setSwallowWrites(true);

    const outcome = await updateTagAcrossMemos(
      harness.adapter,
      "ws1",
      "server",
      "srv",
      ACTOR,
      ACTOR_LABEL
    );

    expect(outcome.verified).toBe(false);
    expect(outcome.remainingOldTag).toBe(2);
    expect(outcome.updated).toBe(2);

    // Ground truth confirms nothing moved — the response no longer lies.
    const names = harness.tagRows().map((r) => `${r.memo_id}:${r.name}`);
    expect(names).toContain("m1:server");
    expect(names).toContain("m2:server");
  });

  test("T11 delete_tag (nextTag null) removes the tag and reports verified", async () => {
    const outcome = await updateTagAcrossMemos(
      harness.adapter,
      "ws1",
      "health",
      null,
      ACTOR,
      ACTOR_LABEL
    );

    expect(outcome).toEqual({ updated: 1, verified: true, remainingOldTag: 0 });
    expect(harness.tagRows().map((r) => r.name)).not.toContain("health");
  });

  test("T12 renaming a tag that does not exist is a verified no-op", async () => {
    const outcome = await updateTagAcrossMemos(
      harness.adapter,
      "ws1",
      "does_not_exist",
      "whatever",
      ACTOR,
      ACTOR_LABEL
    );

    expect(outcome).toEqual({ updated: 0, verified: true, remainingOldTag: 0 });
  });

  test("T13 renaming a tag to itself short-circuits as a verified no-op", async () => {
    const outcome = await updateTagAcrossMemos(
      harness.adapter,
      "ws1",
      "server",
      "server",
      ACTOR,
      ACTOR_LABEL
    );

    expect(outcome).toEqual({ updated: 0, verified: true, remainingOldTag: 0 });
    expect(harness.tagRows().map((r) => r.name)).toContain("server");
  });

  test("T14 dryRun preview keeps its existing shape and writes nothing", async () => {
    const preview = await previewTagRename(harness.adapter, "ws1", "server", "srv");

    expect(preview.dryRun).toBe(true);
    expect(preview.updated).toBe(2);
    expect(preview.changes.map((c) => c.memoId).sort()).toEqual(["m1", "m2"]);
    expect(preview.changes.find((c) => c.memoId === "m2")!.nextTags).toEqual(["srv"]);

    // Preview must not mutate ground truth.
    expect(harness.tagRows().map((r) => r.name)).toContain("server");
  });
});
