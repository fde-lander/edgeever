/**
 * MCP Per-Token Hiding Database Adapter
 *
 * Wraps a DatabaseAdapter to transparently filter out memos/notebooks belonging
 * to hidden notebook IDs for agent (API token) requests. Session requests are
 * unaffected (caller never wraps their db).
 *
 * Design principles (MASTER approved 2026-08-31):
 * - Only wraps db (prepare/batch); blob resources + diagnostics pass through.
 * - Deterministic SQL tokenization (NOT regex) + table alias whitelist.
 * - fail-closed: SELECT touching a content table but unable to resolve an
 *   injection point → throw (never silently allow).
 * - INSERT/UPDATE/DELETE are NOT rewritten — write guards handle those.
 * - Hidden IDs are inlined as literal strings (server-generated, not user input).
 * - batch() unwraps wrapper statements to inner real statements for instanceof.
 */

import type {
  DatabaseAdapter,
  DatabaseQueryResult,
  PreparedStatementAdapter,
} from "./storage-contract";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

/** A statement that may have been wrapped by our hiding adapter. */
interface WrappedStatement extends PreparedStatementAdapter {
  /** The underlying real statement (for batch unwrap). */
  readonly __inner: PreparedStatementAdapter;
}

// ─────────────────────────────────────────────────────────────
// Content table registry — maps table name → injection strategy
// ─────────────────────────────────────────────────────────────

interface InjectionRule {
  /** Table name as it appears in SQL (case-insensitive match). */
  table: string;
  /**
   * Given an alias (or null if no alias), return the SQL fragment to inject
   * as an additional WHERE condition, or null if this table's filtering is
   * handled via a subquery on memo_id.
   */
  getInjection: (alias: string | null, hiddenIds: string[]) => string | null;
}

// Build the NOT IN literal list from hidden IDs (server-generated, safe to inline)
const literalList = (ids: string[]): string =>
  ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");

const NOTEBOOKS_INJECTION = (alias: string | null, ids: string[]): string =>
  `${alias ?? "notebooks"}.id NOT IN (${literalList(ids)})`;

const MEMOS_INJECTION = (alias: string | null, ids: string[]): string =>
  `${alias ?? "memos"}.notebook_id NOT IN (${literalList(ids)})`;

/** For tables linked via memo_id (not notebook_id), inject a subquery. */
const MEMO_ID_SUBQUERY = (alias: string | null, ids: string[]): string =>
  `${alias ? `${alias}.memo_id` : "memo_id"} NOT IN (SELECT id FROM memos WHERE notebook_id IN (${literalList(ids)}))`;

const INJECTION_RULES: InjectionRule[] = [
  // Primary tables with direct notebook_id / id
  { table: "notebooks", getInjection: NOTEBOOKS_INJECTION },
  { table: "memos", getInjection: MEMOS_INJECTION },
  // Tables linked via memo_id → memos.id
  { table: "memo_contents", getInjection: MEMO_ID_SUBQUERY },
  { table: "memo_revisions", getInjection: MEMO_ID_SUBQUERY },
  { table: "resources", getInjection: MEMO_ID_SUBQUERY },
  { table: "memo_search_documents", getInjection: MEMO_ID_SUBQUERY },
  { table: "memo_tags", getInjection: MEMO_ID_SUBQUERY },
  // FTS5 virtual table — memo_id is UNINDEXED, supports WHERE
  { table: "memos_fts", getInjection: MEMO_ID_SUBQUERY },
];

const CONTENT_TABLES = new Set(INJECTION_RULES.map((r) => r.table.toLowerCase()));

// SQL reserved words — defined here (before tokenizer) because tokenizeSql references it
const RESERVED_WORDS = new Set([
  "WHERE", "GROUP", "ORDER", "LIMIT", "OFFSET", "HAVING", "UNION",
  "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "ON", "AND",
  "OR", "NOT", "IS", "NULL", "IN", "EXISTS", "BETWEEN", "LIKE",
  "ASC", "DESC", "AS", "JOIN", "FROM", "SELECT", "WITH", "RECURSIVE",
  "INSERT", "UPDATE", "DELETE", "INTO", "VALUES", "SET", "RETURNING",
  "CASE", "WHEN", "THEN", "ELSE", "END", "BY",
  "MATCH", "ESCAPE", "DISTINCT", "ALL", "COUNT", "SUM", "MAX", "MIN",
  "COALESCE", "NULLIF", "LOWER", "UPPER", "TRIM", "CAST",
]);

const isReservedWord = (word: string): boolean =>
  RESERVED_WORDS.has(word.toUpperCase());

// ─────────────────────────────────────────────────────────────
// SQL Tokenizer — deterministic, NOT regex
// ─────────────────────────────────────────────────────────────

interface Token {
  text: string;
  upper: string;
  type: "keyword" | "identifier" | "punct" | "string" | "number" | "whitespace";
}

/**
 * Tokenize SQL into a stream of tokens. Handles:
 * - Single-quoted strings (with '' escape)
 * - Double-quoted identifiers
 * - Line/block comments
 * - Keywords, identifiers, numbers, punctuation
 */
function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];

    // Whitespace
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < len && /\s/.test(sql[j])) j++;
      tokens.push({ text: sql.slice(i, j), upper: "", type: "whitespace" });
      i = j;
      continue;
    }

    // Line comment --
    if (ch === "-" && sql[i + 1] === "-") {
      let j = i + 2;
      while (j < len && sql[j] !== "\n") j++;
      tokens.push({ text: sql.slice(i, j), upper: "", type: "whitespace" });
      i = j;
      continue;
    }

    // Block comment /* */
    if (ch === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      while (j < len - 1 && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      j += 2;
      tokens.push({ text: sql.slice(i, Math.min(j, len)), upper: "", type: "whitespace" });
      i = j;
      continue;
    }

    // Single-quoted string
    if (ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2; // escaped ''
            continue;
          }
          j++; // closing quote
          break;
        }
        j++;
      }
      tokens.push({ text: sql.slice(i, j), upper: "", type: "string" });
      i = j;
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      let j = i + 1;
      while (j < len && sql[j] !== '"') j++;
      j++; // closing quote
      tokens.push({ text: sql.slice(i, j), upper: sql.slice(i + 1, j - 1).toUpperCase(), type: "identifier" });
      i = j;
      continue;
    }

    // Number
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[0-9.eE+\-]/.test(sql[j])) j++;
      tokens.push({ text: sql.slice(i, j), upper: "", type: "number" });
      i = j;
      continue;
    }

    // Identifier or keyword (starts with letter or underscore)
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[a-zA-Z0-9_]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      // Keep original case for identifiers (aliases matter!), but track upper for keyword matching
      const isKeyword = /^[A-Z_]+$/i.test(word) && RESERVED_WORDS.has(word.toUpperCase());
      tokens.push({ text: word, upper: word.toUpperCase(), type: isKeyword ? "keyword" : "identifier" });
      i = j;
      continue;
    }

    // Punctuation
    tokens.push({ text: ch, upper: ch, type: "punct" });
    i++;
  }

  return tokens;
}

// ─────────────────────────────────────────────────────────────
// SQL Parser — find table references + aliases, decide injection points
// ─────────────────────────────────────────────────────────────

interface TableRef {
  tableName: string;
  alias: string | null;
}

/**
 * Parse a SELECT (or WITH...SELECT) statement to find all table references
 * in FROM/JOIN clauses and their aliases.
 *
 * Strategy: walk tokens, find FROM/JOIN keywords, then read the next
 * identifier as table name and optionally the following identifier as alias
 * (skipping optional AS).
 */
function findTableRefs(tokens: Token[]): TableRef[] {
  const refs: TableRef[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== "keyword") continue;
    const upper = tok.upper;

    if (upper === "FROM" || upper === "JOIN") {
      // Find next non-whitespace token after FROM/JOIN
      let j = i + 1;
      while (j < tokens.length && tokens[j].type === "whitespace") j++;
      if (j >= tokens.length) continue;

      const tableTok = tokens[j];
      if (tableTok.type !== "identifier" && tableTok.type !== "keyword") continue;

      const tableName = tableTok.text; // preserve original case
      // Match case-insensitively against content tables
      if (!tableTok.upper) continue;

      // Check if next token is an alias
      let alias: string | null = null;
      let k = j + 1;
      while (k < tokens.length && tokens[k].type === "whitespace") k++;

      if (k < tokens.length) {
        const next = tokens[k];
        if (next.upper === "AS") {
          // Skip AS, read alias
          k++;
          while (k < tokens.length && tokens[k].type === "whitespace") k++;
          if (k < tokens.length && (tokens[k].type === "identifier" || tokens[k].type === "keyword")) {
            alias = tokens[k].text; // preserve original case
          }
        } else if (next.type === "identifier" || (next.type === "keyword" && !isReservedWord(next.upper))) {
          // Alias without AS (e.g., "FROM memos m")
          alias = next.text; // preserve original case
        }
      }

      refs.push({ tableName, alias });
    }
  }

  return refs;
}

// ─────────────────────────────────────────────────────────────
// SQL Rewriter — the core logic
// ─────────────────────────────────────────────────────────────

/**
 * Determine if SQL is a read query (SELECT or WITH...SELECT).
 * INSERT/UPDATE/DELETE are NOT rewritten.
 */
function isReadQuery(tokens: Token[]): boolean {
  for (const tok of tokens) {
    if (tok.type === "whitespace") continue;
    return tok.upper === "SELECT" || tok.upper === "WITH";
  }
  return false;
}

/**
 * Rewrite a SELECT SQL to inject hiding filters.
 *
 * Strategy:
 * 1. Find all table refs (FROM/JOIN) and their aliases.
 * 2. For each content table found, compute the injection fragment.
 * 3. If any content table is referenced but we can't inject → fail-closed.
 * 4. Inject all fragments as additional WHERE conditions.
 *
 * Injection point: after existing WHERE clause (append AND), or add new WHERE
 * if no WHERE exists. For CTE queries, inject at the outermost SELECT level.
 */
function rewriteSelectSql(sql: string, hiddenIds: string[]): string {
  if (hiddenIds.length === 0) return sql;

  const tokens = tokenizeSql(sql);
  const refs = findTableRefs(tokens);

  // Build injection fragments for each content table found
  const injections: string[] = [];
  let touchedContentTable = false;

  for (const ref of refs) {
    const tableLower = ref.tableName.toLowerCase();
    if (!CONTENT_TABLES.has(tableLower)) continue;

    touchedContentTable = true;
    const rule = INJECTION_RULES.find((r) => r.table.toLowerCase() === tableLower)!;
    const fragment = rule.getInjection(ref.alias, hiddenIds);
    if (fragment) {
      injections.push(fragment);
    }
  }
  if (touchedContentTable && injections.length === 0) {
    throw new Error(
      `[mcp-hiding] fail-closed: SQL touches content table but no injection point could be resolved.\nSQL: ${sql.slice(0, 200)}`
    );
  }

  if (injections.length === 0) return sql; // no content tables, passthrough

  // Inject into SQL: find the right insertion point
  // Strategy: find the last top-level WHERE clause and append AND ...
  // If no WHERE, find the right place to insert WHERE before GROUP BY/ORDER BY/LIMIT
  // For simplicity and safety, we append to existing WHERE or add a new one.

  return injectWhereClause(sql, tokens, injections);
}

/**
 * Inject the hiding conditions into the SQL.
 *
 * For a simple SELECT (no CTE): append to existing WHERE or add new WHERE.
 * For CTE (WITH...SELECT): we need to inject at the outermost SELECT's WHERE.
 *
 * Simplified approach: find the last WHERE keyword at the top level (not inside
 * subqueries) and append AND <conditions>. If no WHERE, insert WHERE <conditions>
 * before GROUP BY / ORDER BY / LIMIT / OFFSET / closing paren.
 */
function injectWhereClause(sql: string, tokens: Token[], injections: string[]): string {
  const condition = injections.join(" AND ");

  // Find the outermost WHERE (depth 0)
  let depth = 0;
  let whereIndex = -1;
  let insertBeforeIndex = -1;

  // Keywords that can appear after WHERE clause ends
  const afterWhereKeywords = new Set(["GROUP", "ORDER", "LIMIT", "OFFSET", "HAVING", "UNION"]);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === "punct" && tok.text === "(") depth++;
    if (tok.type === "punct" && tok.text === ")") depth--;

    if (depth === 0 && tok.type === "keyword" && tok.upper === "WHERE") {
      whereIndex = i;
    }

    // If we have a WHERE, find where it ends (first GROUP/ORDER/LIMIT/etc at depth 0 after WHERE)
    if (whereIndex >= 0 && depth === 0 && tok.type === "keyword" && afterWhereKeywords.has(tok.upper)) {
      if (insertBeforeIndex < 0) insertBeforeIndex = i;
    }

    // If no WHERE, find insertion point before GROUP/ORDER/LIMIT
    if (whereIndex < 0 && depth === 0 && tok.type === "keyword" && afterWhereKeywords.has(tok.upper)) {
      if (insertBeforeIndex < 0) insertBeforeIndex = i;
    }
  }

  if (whereIndex >= 0) {
    // Append AND to existing WHERE
    // Find the position right before the next clause (or end)
    let endPos: number;
    if (insertBeforeIndex >= 0) {
      // Insert before this token, after any whitespace
      let j = insertBeforeIndex;
      while (j > 0 && tokens[j - 1].type === "whitespace") j--;
      endPos = j;
    } else {
      // WHERE goes to the end — find the closing paren or end of string
      // For CTE, the last token might be )
      endPos = tokens.length;
      // Trim trailing whitespace
      while (endPos > 0 && tokens[endPos - 1].type === "whitespace") endPos--;
    }

    // Reconstruct: original up to endPos + " AND condition" + rest
    const before = tokens.slice(0, endPos).map((t) => t.text).join("");
    const after = tokens.slice(endPos).map((t) => t.text).join("");
    return `${before} AND ${condition}${after}`;
  }

  // No WHERE — insert WHERE before GROUP/ORDER/LIMIT or at end
  if (insertBeforeIndex >= 0) {
    // Find whitespace before this keyword
    let j = insertBeforeIndex;
    while (j > 0 && tokens[j - 1].type === "whitespace") j--;
    const before = tokens.slice(0, j).map((t) => t.text).join("");
    const after = tokens.slice(j).map((t) => t.text).join("");
    return `${before} WHERE ${condition}${after}`;
  }

  // No WHERE, no GROUP/ORDER/LIMIT — append at end
  // For CTE queries ending with ), this is tricky.
  // Find the last closing paren at depth 0 that ends the main query
  // Simpler: just append to the end (works for most cases)
  let endIdx = tokens.length;
  while (endIdx > 0 && tokens[endIdx - 1].type === "whitespace") endIdx--;
  const before = tokens.slice(0, endIdx).map((t) => t.text).join("");
  const after = tokens.slice(endIdx).map((t) => t.text).join("");
  return `${before} WHERE ${condition}${after}`;
}

// ─────────────────────────────────────────────────────────────
// Hiding Database Adapter
// ─────────────────────────────────────────────────────────────

/**
 * Load the hidden notebook IDs for a token (including descendants via recursive CTE).
 * Returns a Set of notebook IDs that should be hidden.
 */
export const loadHiddenNotebookIds = async (
  db: DatabaseAdapter,
  tokenId: string,
  workspaceId: string,
): Promise<Set<string>> => {
  const result = await db
    .prepare(
      `WITH RECURSIVE hidden_tree AS (
        SELECT notebook_id AS id FROM mcp_token_hidden_notebooks
        WHERE token_id = ? AND workspace_id = ?
        UNION ALL
        SELECT n.id FROM notebooks n
        INNER JOIN hidden_tree h ON n.parent_id = h.id
        WHERE n.is_deleted = 0
      )
      SELECT id FROM hidden_tree`
    )
    .bind(tokenId, workspaceId)
    .all<{ id: string }>();

  return new Set(result.results.map((row) => row.id));
};

/**
 * Wrapping PreparedStatement — holds the inner real statement for batch unwrap.
 */
class HidingPreparedStatement implements PreparedStatementAdapter {
  readonly __inner: PreparedStatementAdapter;

  constructor(inner: PreparedStatementAdapter) {
    this.__inner = inner;
  }

  bind(...values: unknown[]): PreparedStatementAdapter {
    return new HidingPreparedStatement(this.__inner.bind(...values));
  }

  async first<T = unknown>(columnName?: string): Promise<T | null> {
    return this.__inner.first<T>(columnName as string);
  }

  async run<T = Record<string, unknown>>(): Promise<DatabaseQueryResult<T>> {
    return this.__inner.run<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<DatabaseQueryResult<T>> {
    return this.__inner.all<T>();
  }
}

/**
 * Create a hiding wrapper around a DatabaseAdapter.
 *
 * - prepare(): rewrites SELECT SQL to inject NOT IN filters, then delegates
 *   to the underlying adapter's prepare. Non-read queries pass through.
 * - batch(): unwraps wrapper statements to inner real statements before
 *   passing to the underlying adapter's batch (for instanceof checks).
 *
 * @param underlyingDb The original DatabaseAdapter
 * @param hiddenIds Set of notebook IDs to hide (including descendants)
 * @returns A wrapped DatabaseAdapter
 */
export const createHidingDatabase = (
  underlyingDb: DatabaseAdapter,
  hiddenIds: Set<string>,
): DatabaseAdapter => {
  // Empty set = passthrough (no overhead)
  if (hiddenIds.size === 0) {
    return underlyingDb;
  }

  const idArray = Array.from(hiddenIds);

  const hidingDb: DatabaseAdapter = {
    prepare(sql: string): PreparedStatementAdapter {
      // Only rewrite SELECT/WITH queries; INSERT/UPDATE/DELETE pass through
      const tokens = tokenizeSql(sql);
      if (!isReadQuery(tokens)) {
        // Non-read query — pass through unchanged (write guards handle protection)
        return new HidingPreparedStatement(underlyingDb.prepare(sql));
      }

      try {
        const rewritten = rewriteSelectSql(sql, idArray);
        const inner = underlyingDb.prepare(rewritten);
        return new HidingPreparedStatement(inner);
      } catch (err) {
        // fail-closed: if rewriting fails, throw (never allow through)
        if (err instanceof Error && err.message.startsWith("[mcp-hiding]")) {
          throw err;
        }
        throw err;
      }
    },

    async batch<T = unknown>(
      statements: PreparedStatementAdapter[],
    ): Promise<DatabaseQueryResult<T>[]> {
      // Unwrap: replace each wrapper statement with its inner real statement
      const inners = statements.map((stmt) => {
        if (stmt instanceof HidingPreparedStatement) {
          return stmt.__inner;
        }
        return stmt; // already a real statement (e.g., from underlyingDb.prepare directly)
      });
      return underlyingDb.batch<T>(inners);
    },
  };

  return hidingDb;
};

// ─────────────────────────────────────────────────────────────
// Write guard helper
// ─────────────────────────────────────────────────────────────

/**
 * Check if a notebook ID is in the hidden set.
 * Used by write guards to reject agent writes to hidden notebooks.
 */
export const isNotebookHidden = (hiddenIds: Set<string>, notebookId: string): boolean =>
  hiddenIds.has(notebookId);

/**
 * Attach a Symbol to a wrapped db so callers can verify it's a hiding wrapper
 * and extract the hidden set for write guards.
 */
const HIDING_SET = Symbol.for("mcp-hiding-set");

/**
 * Create a hiding database with a symbol-attached hidden set.
 * Write guards can use getHidingSet() to check if a notebook is hidden.
 */
export const createHidingDatabaseWithSymbol = (
  underlyingDb: DatabaseAdapter,
  hiddenIds: Set<string>,
): DatabaseAdapter => {
  const hidingDb = createHidingDatabase(underlyingDb, hiddenIds);
  // Attach symbol for write guard access
  Object.defineProperty(hidingDb, HIDING_SET, {
    value: hiddenIds,
    enumerable: false,
    writable: false,
  });
  return hidingDb;
};

/**
 * Extract the hidden set from a wrapped db (if present).
 * Returns undefined if the db is not a hiding wrapper.
 */
export const getHidingSet = (db: DatabaseAdapter): Set<string> | undefined => {
  const sym = (db as Record<symbol, unknown>)[HIDING_SET];
  return sym instanceof Set ? sym : undefined;
};
