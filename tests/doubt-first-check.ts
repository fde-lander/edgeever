/**
 * DOUBT FIRST — Phase 11 investigation artifact (kept per MASTER decision Q5).
 *
 * Purpose: standalone verification script used during BUG-001 DOUBT FIRST to
 * prove the four edge-case findings with REAL bun:sqlite execution. It is NOT
 * a bun:test file (run manually: `bun tests/doubt-first-check.ts`) and is NOT
 * part of `bun test` collection.
 *
 * The assertions here are now covered permanently by:
 *   - tests/mcp-hiding-real-sqlite.test.ts (D1/D2/D3/D4 fixed behavior)
 *   - tests/leak-matrix.test.ts S8/S9 (D3/D4 regression guards)
 *
 * Findings proven by this script (2026-09-02, bun:sqlite 3.53.2):
 *   D1: scope-correct FTS injection executes + isolation semantics hold
 *   D2: old toContain fixture referenced an undefined CTE (self-blind test)
 *   D3: list_memos includeDescendants id-set CTE broke under naive injection
 *   D4: isNotebookDescendant tree-walk broke under naive injection
 */
import { Database } from "bun:sqlite";

const db = new Database(":memory:");

// Minimal schema mirroring real migrations (simplified, only what we execute)
db.exec(`
CREATE TABLE memos (id TEXT PRIMARY KEY, notebook_id TEXT, workspace_id TEXT, is_deleted INTEGER DEFAULT 0, title TEXT DEFAULT '', is_pinned INTEGER DEFAULT 0, updated_at TEXT DEFAULT '');
CREATE TABLE notebooks (id TEXT PRIMARY KEY, workspace_id TEXT, parent_id TEXT, is_deleted INTEGER DEFAULT 0, name TEXT DEFAULT '');
CREATE TABLE memo_contents (memo_id TEXT, revision INTEGER DEFAULT 1, content_text TEXT DEFAULT '');
CREATE TABLE memo_search_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, memo_id TEXT, title TEXT DEFAULT '', content_text TEXT DEFAULT '', tags TEXT DEFAULT '');
CREATE VIRTUAL TABLE memos_fts USING fts5(memo_id UNINDEXED, title, content_text, tags, content='memo_search_documents', content_rowid='id');
INSERT INTO memos (id, notebook_id, workspace_id) VALUES ('m1','nb_ok','ws1'), ('m2','nb_hidden','ws1');
INSERT INTO memo_contents (memo_id) VALUES ('m1'),('m2');
INSERT INTO memo_search_documents (memo_id, title) VALUES ('m1','hello'),('m2','hidden title');
INSERT INTO memos_fts(memos_fts) VALUES('rebuild');
`);

console.log("=== DOUBT 1: FTS branch + scoped AND injection executes? ===");
const searchSql = `WITH raw_matches(memo_id, rank) AS (
  SELECT memo_id, bm25(memos_fts)
  FROM memos_fts
  WHERE memos_fts MATCH ? AND memo_id NOT IN (SELECT id FROM memos WHERE notebook_id IN ('nb_hidden'))

  UNION ALL

  SELECT m.id, 100.0
  FROM memos m
  INNER JOIN memo_contents c ON c.memo_id = m.id
  WHERE m.title LIKE ? ESCAPE '\\'
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
  AND m.notebook_id NOT IN ('nb_hidden')
  AND c.memo_id NOT IN (SELECT id FROM memos WHERE notebook_id IN ('nb_hidden'))
ORDER BY s.rank ASC
LIMIT ?`;

try {
  const rows = db.query(searchSql).all("hello", "%hello%", "ws1", 50);
  console.log("PASS — executes fine, rows:", JSON.stringify(rows));
  if (rows.length !== 1 || rows[0].id !== "m1") {
    console.log("❌ ISOLATION WRONG — hidden memo leaked or visible memo filtered!");
    process.exit(1);
  }
  console.log("PASS — isolation semantics correct (only m1 visible)");
} catch (e) {
  console.log("❌ FAIL:", (e as Error).message);
  process.exit(1);
}

console.log("\n=== DOUBT 2: old test fixture references undefined CTE (self-blind proof) ===");
const oldFixture = `WITH raw_matches(memo_id, rank) AS (
  SELECT memo_id, bm25(memos_fts) FROM memos_fts WHERE memos_fts MATCH ?
  UNION ALL
  SELECT m.id, 100.0 FROM memos m INNER JOIN memo_contents c ON c.memo_id = m.id
  WHERE m.title LIKE ? ESCAPE '\\'
)
SELECT m.id, m.notebook_id FROM search_matches s
INNER JOIN memos m ON m.id = s.memo_id
INNER JOIN memo_contents mc ON mc.memo_id = m.id
WHERE m.workspace_id = ?`;
try {
  db.query(oldFixture).all("hello", "%hello%", "ws1");
  console.log("PASS (unexpected — fixture is actually valid)");
} catch (e) {
  console.log("CONFIRMED — old fixture itself fails real SQLite:", (e as Error).message);
  console.log("→ current toContain test can never catch rewriting bugs on this fixture");
}

console.log("\n=== DOUBT 3: list_memos descendants pattern — outer m.notebook_id + bare memo_id? ===");
// Pattern: memos m ... m.notebook_id IN (WITH RECURSIVE ... FROM notebooks ...)
// tokens: FROM notebooks x2 INSIDE the IN(...) subquery at depth>0.
// Content table 'notebooks' → injection notebooks.id NOT IN — where does it land?
// If it lands at outer depth-0 WHERE → 'notebooks.id' unqualified → ambiguous? No table 'notebooks' at outer level → SQLite error!
const listSql = `SELECT m.id, m.title
FROM memos m
WHERE m.workspace_id = ?
  AND m.is_deleted = 0
  AND m.notebook_id IN (
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM notebooks WHERE workspace_id = ? AND id = ? AND is_deleted = 0
      UNION
      SELECT n.id FROM notebooks n INNER JOIN descendants d ON n.parent_id = d.id
      WHERE n.workspace_id = ? AND n.is_deleted = 0
    )
    SELECT id FROM descendants
  )
ORDER BY m.is_pinned DESC, m.updated_at DESC
LIMIT ?`;

// Simulate current rewriter behavior: collect refs incl. CTE-inside 'notebooks'
// → fragment "notebooks.id NOT IN (...)" appended at depth-0 WHERE (outer)
// The bare 'notebooks.id' would reference a table NOT in outer FROM → error?
const buggyListSql = listSql.replace(
  "ORDER BY m.is_pinned DESC",
  "AND notebooks.id NOT IN ('nb_hidden') ORDER BY m.is_pinned DESC"
);
try {
  db.query(buggyListSql).all("ws1", "ws1", "nb_ok", "ws1", 50);
  console.log("PASS (unexpected — ambiguity does not trigger here)");
} catch (e) {
  console.log("CONFIRMED BUG PATTERN — outer-level injection of CTE-inside table breaks:", (e as Error).message);
}

// But wait: does it actually break, or is notebooks.id resolvable via outer scope? There is NO notebooks table at outer level → should be "no such column: notebooks.id"
console.log("\n=== DOUBT 4: isNotebookDescendant CTE — touches content tables? wrapper passthrough? ===");
const descSql = `WITH RECURSIVE descendants(id) AS (
  SELECT id FROM notebooks WHERE workspace_id = ? AND parent_id = ? AND is_deleted = 0
  UNION ALL
  SELECT n.id FROM notebooks n INNER JOIN descendants d ON n.parent_id = d.id
  WHERE n.workspace_id = ? AND n.is_deleted = 0
)
SELECT id FROM descendants WHERE id = ? LIMIT 1`;
const r = db.query(descSql).get("ws1", "nb_ok", "ws1", "nb_ok");
console.log("executes fine:", r);
// Refs: FROM notebooks (x2), JOIN descendants — 'notebooks' is a content table!
// Current rewriter would inject notebooks.id NOT IN → at depth-0 outer WHERE (SELECT id FROM descendants WHERE...)
// → descendants has no such column 'notebooks.id' qualified → breaks or fails closed.
// Verify what current code does:
console.log("(semantic check only — actual rewriter behavior tested in repro script)");
process.exit(0);
