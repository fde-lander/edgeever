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
  /**
   * Paren depth at which this table reference appears (0 = outermost query).
   * BUG-001 fix: refs inside CTE subqueries (depth > 0) must NOT get their
   * conditions appended to the outer WHERE — that caused
   * "ambiguous column name: memo_id" and "no such column" errors.
   */
  depth: number;
  /**
   * Token index of the table-name token (for locating the owning SELECT block
   * when injecting scoped conditions into CTE subqueries).
   */
  tokenIndex: number;
  /**
   * True when this ref sits inside an `IN ( ... )` id-set subquery
   * (e.g. `notebook_id IN (WITH RECURSIVE ... SELECT id FROM notebooks)`).
   * Such tables compute a value consumed by the enclosing predicate — they
   * are NOT content-row sources, so injecting a hiding filter there is
   * wrong (and breaks the SQL). The outer `m.notebook_id IN (...)` result is
   * already intersected with the outer `m.notebook_id NOT IN (hidden)` guard.
   */
  insideInSubquery: boolean;
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

  // Track paren depth and whether each "(" is preceded by IN (IN-subquery marker)
  let depth = 0;
  // Stack: for each open paren at depth 1..N, whether it is an IN-subquery paren
  const inSubqueryStack: boolean[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === "punct" && tok.text === "(") {
      // Look backwards for the nearest meaningful token: IN ⇒ id-set subquery
      let p = i - 1;
      while (p >= 0 && tokens[p].type === "whitespace") p--;
      const prev = p >= 0 ? tokens[p] : null;
      const prevIsIn =
        !!prev && prev.type === "keyword" && prev.upper === "IN";
      inSubqueryStack[depth] = prevIsIn;
      depth++;
      continue;
    }
    if (tok.type === "punct" && tok.text === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
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

      // Determine whether this ref is inside an IN-subquery paren
      // (i.e. we are within a paren opened right after IN, possibly nested deeper)
      let insideInSubquery = false;
      for (let d = 0; d < depth; d++) {
        if (inSubqueryStack[d]) {
          insideInSubquery = true;
          break;
        }
      }

      refs.push({ tableName, alias, depth, tokenIndex: j, insideInSubquery });
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
 * Strategy (BUG-001 fix — scope-aware injection):
 * 1. Find all table refs (FROM/JOIN) with their aliases AND paren depths.
 * 2. D4 exemption (Q2=A): if every content-table ref is `notebooks` (tree-walk
 *    utility SQL like isNotebookDescendant — no content rows exposed), pass
 *    through unchanged. Write guards still protect writes.
 * 3. D3 exemption (Q1=A): refs inside an `IN ( ... )` id-set subquery are
 *    skipped — they compute a value consumed by the enclosing predicate, and
 *    the outer level already carries its own hiding guard.
 * 4. Scope-aware injection: refs at depth > 0 (CTE / subquery) get their
 *    fragment injected into THEIR OWN subquery's WHERE (e.g. memos_fts MATCH
 *    ... AND memo_id NOT IN ...); refs at depth 0 go to the outer WHERE.
 * 5. Dedup: same (table, alias, depth-bucket) injects only once.
 * 6. fail-closed: content table touched but no injection point resolvable →
 *    throw (never silently allow).
 */
function rewriteSelectSql(sql: string, hiddenIds: string[]): string {
  if (hiddenIds.length === 0) return sql;

  const tokens = tokenizeSql(sql);
  const refs = findTableRefs(tokens);

  // ── D4 exemption: notebooks-only TREE-WALK utility SQL ──
  // (Q2=A narrow whitelist) Only exempt when the OUTER (depth 0) query has NO
  // content-table refs at all and the content refs are exclusively
  // `notebooks` inside CTE definitions (e.g. isNotebookDescendant: outer
  // `SELECT id FROM descendants d` + recursive CTE over notebooks). Such SQL
  // computes an id set — it exposes no content rows, and injecting
  // `notebooks.id NOT IN` into the CTE breaks both SQL and semantics.
  // Direct reads (SELECT ... FROM notebooks at depth 0) still get injected.
  if (refs.length > 0) {
    const outerContentRefs = refs.filter(
      (r) => r.depth === 0 && CONTENT_TABLES.has(r.tableName.toLowerCase())
    );
    const allContentRefs = refs.filter((r) => CONTENT_TABLES.has(r.tableName.toLowerCase()));
    const isTreeWalk =
      outerContentRefs.length === 0 &&
      allContentRefs.length > 0 &&
      allContentRefs.every((r) => r.tableName.toLowerCase() === "notebooks");
    if (isTreeWalk) return sql;
  }

  // ── Build scoped injection fragments (group-based dedup, MASTER rule 4) ──
  // Group eligible refs by (table, alias). Per group, inject ONCE:
  //   - depth 0 ref present → inject at OUTER WHERE (final guard before rows
  //     leave the query)
  //   - otherwise → inject into the subquery block of the shallowest depth
  //     (e.g. memos_fts inside a CTE gets its own WHERE condition)
  const outerInjections: string[] = [];
  const scopedInjections: Array<{ depth: number; fragment: string; refTokenIndex: number }> = [];
  let touchedContentTable = false;

  interface RefGroup {
    fragment: string;
    hasDepth0: boolean;
    minDepth: number;
    refTokenIndex: number; // token index of the shallowest-depth ref
  }
  const groups = new Map<string, RefGroup>();

  for (const ref of refs) {
    const tableLower = ref.tableName.toLowerCase();
    if (!CONTENT_TABLES.has(tableLower)) continue;

    touchedContentTable = true;

    // ── D3 exemption: refs inside an IN ( ... ) id-set subquery ──
    // e.g. `m.notebook_id IN (WITH RECURSIVE ... SELECT id FROM notebooks)`.
    // The table there computes the consumed set; hiding it would corrupt the
    // SQL. The outer `IN` result is intersected with the outer NOT IN guard.
    if (ref.insideInSubquery) continue;

    const rule = INJECTION_RULES.find((r) => r.table.toLowerCase() === tableLower)!;
    const fragment = rule.getInjection(ref.alias, hiddenIds);
    if (!fragment) continue;

    const key = `${tableLower}|${ref.alias ?? ""}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        fragment,
        hasDepth0: ref.depth === 0,
        minDepth: ref.depth,
        refTokenIndex: ref.tokenIndex,
      });
    } else {
      g.hasDepth0 = g.hasDepth0 || ref.depth === 0;
      if (ref.depth < g.minDepth) {
        g.minDepth = ref.depth;
        g.refTokenIndex = ref.tokenIndex;
      }
    }
  }

  for (const g of groups.values()) {
    if (g.hasDepth0) {
      outerInjections.push(g.fragment);
    } else {
      scopedInjections.push({
        depth: g.minDepth,
        fragment: g.fragment,
        refTokenIndex: g.refTokenIndex,
      });
    }
  }

  if (touchedContentTable && outerInjections.length === 0 && scopedInjections.length === 0) {
    // Only IN-subquery refs were touched and nothing else — that means the
    // query reads content rows ONLY through id-set subqueries, which the
    // outer level must already guard. If there is no outer guard possible
    // (no other content table), fail-closed to be safe.
    throw new Error(
      `[mcp-hiding] fail-closed: SQL touches content table only inside IN-subqueries and no outer injection point could be resolved.\nSQL: ${sql.slice(0, 200)}`
    );
  }

  if (!touchedContentTable) return sql; // no content tables, passthrough
  if (outerInjections.length === 0 && scopedInjections.length === 0) return sql;

  // ── Inject scoped fragments first (inner subqueries) ──
  let workingSql = sql;
  if (scopedInjections.length > 0) {
    workingSql = injectWhereAtDepth(workingSql, scopedInjections);
  }

  // ── Inject outer fragments (depth 0) ──
  if (outerInjections.length > 0) {
    const outerTokens = scopedInjections.length > 0 ? tokenizeSql(workingSql) : tokens;
    workingSql = injectWhereClause(workingSql, outerTokens, outerInjections);
  }

  return workingSql;
}

/**
 * Inject hiding fragments into the SELECT block OWNING each target table ref.
 *
 * BUG-001 fix: refs inside a CTE/subquery (e.g. memos_fts inside
 * `WITH raw_matches AS (SELECT ... FROM memos_fts WHERE memos_fts MATCH ? ...)`)
 * must get their fragment injected into THAT subquery's own WHERE — appending
 * a bare `memo_id NOT IN` to the outer depth-0 WHERE caused
 * "ambiguous column name: memo_id" and silently disabled FTS filtering.
 *
 * Block-locating algorithm (per injection target, ordered by ref position so
 * later insertions shift earlier indices — we therefore process targets from
 * the LAST token position backwards and apply each insertion immediately on a
 * re-tokenized stream):
 *
 * 1. From the table-ref token, walk BACKWARD at the same paren depth to find
 *    the block start: the nearest SELECT keyword at the ref's depth.
 * 2. From the block start, walk FORWARD at the same depth to find the block
 *    end: the first UNION/GROUP/ORDER/LIMIT/OFFSET/HAVING keyword, or the
 *    closing paren that ends the block, or end of tokens.
 * 3. Within [blockStart, blockEnd): if a WHERE exists → append
 *    `AND fragment` after the WHERE condition list (end of condition list =
 *    first sub-expression boundary: UNION/ORDER/GROUP/LIMIT at depth, or a
 *    closing paren dropping below block depth, or block end). Otherwise
 *    insert `WHERE fragment` right before the block end.
 *
 * This keeps the fragment INSIDE the owning block (e.g. after
 * `memos_fts MATCH ?`), never leaking bare columns into other scopes.
 */
function injectWhereAtDepth(
  sql: string,
  scopedInjections: Array<{ depth: number; fragment: string; refTokenIndex: number }>,
): string {
  const afterWhereKeywords = new Set(["UNION", "GROUP", "ORDER", "LIMIT", "OFFSET", "HAVING"]);

  // Process from the LAST ref position backwards: each insertion is applied
  // immediately on a re-tokenized stream, so earlier token indices remain
  // valid while later positions are already finalized.
  const targets = [...scopedInjections].sort((a, b) => b.refTokenIndex - a.refTokenIndex);
  let workingSql = sql;

  for (const target of targets) {
    const tokens = tokenizeSql(workingSql);
    const { depth: blockDepth, fragment, refTokenIndex } = target;

    // ── 1. Find block start: nearest SELECT at blockDepth at or before ref ──
    let blockStart = -1;
    let d = 0;
    for (let i = 0; i <= refTokenIndex; i++) {
      const tok = tokens[i];
      if (tok.type === "punct" && tok.text === "(") d++;
      else if (tok.type === "punct" && tok.text === ")") d = Math.max(0, d - 1);
      else if (d === blockDepth && tok.type === "keyword" && tok.upper === "SELECT") {
        blockStart = i;
      }
    }
    if (blockStart < 0) {
      throw new Error(
        `[mcp-hiding] fail-closed: could not locate owning SELECT block for scoped injection.\nSQL: ${workingSql.slice(0, 200)}`
      );
    }

    // ── 2. Find block end: first afterWhere keyword / closing paren below depth / end ──
    let blockEnd = tokens.length;
    d = 0;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.type === "punct" && tok.text === "(") {
        if (i > blockStart && d === blockDepth) {
          // nested paren inside the block — skip its content later via depth tracking
        }
        d++;
      } else if (tok.type === "punct" && tok.text === ")") {
        if (d === blockDepth && i > blockStart) {
          blockEnd = i;
          break;
        }
        d = Math.max(0, d - 1);
      } else if (i > blockStart && d === blockDepth && tok.type === "keyword" && afterWhereKeywords.has(tok.upper)) {
        blockEnd = i;
        break;
      }
    }

    // ── 3. Locate WHERE within [blockStart, blockEnd) at blockDepth ──
    let whereIdx = -1;
    let insertBeforeIdx = -1; // first afterWhere keyword inside block
    d = 0;
    for (let i = 0; i <= blockEnd; i++) {
      const tok = tokens[i];
      if (tok.type === "punct" && tok.text === "(") d++;
      else if (tok.type === "punct" && tok.text === ")") d = Math.max(0, d - 1);
      else if (i > blockStart && i < blockEnd && d === blockDepth && tok.type === "keyword") {
        if (tok.upper === "WHERE") whereIdx = i;
        else if (insertBeforeIdx < 0 && afterWhereKeywords.has(tok.upper)) insertBeforeIdx = i;
      }
    }

    if (whereIdx >= 0) {
      // Append AND after the WHERE condition list:
      // condition list ends at insertBeforeIdx (if inside block after WHERE),
      // or at blockEnd, or at the closing paren below blockDepth after WHERE.
      let condEnd = insertBeforeIdx > whereIdx ? insertBeforeIdx : blockEnd;
      if (condEnd >= blockEnd) {
        // walk from WHERE for a paren that closes the block depth
        d = blockDepth;
        for (let i = whereIdx + 1; i < blockEnd; i++) {
          const tok = tokens[i];
          if (tok.type === "punct" && tok.text === "(") d++;
          else if (tok.type === "punct" && tok.text === ")") {
            d = Math.max(0, d - 1);
            if (d < blockDepth) {
              condEnd = i;
              break;
            }
          } else if (d === blockDepth && tok.type === "keyword" && afterWhereKeywords.has(tok.upper)) {
            condEnd = i;
            break;
          }
        }
      }

      // Trim whitespace before condEnd
      let j = condEnd;
      while (j > blockStart && tokens[j - 1].type === "whitespace") j--;
      const before = tokens.slice(0, j).map((t) => t.text).join("");
      const after = tokens.slice(j).map((t) => t.text).join("");
      workingSql = `${before} AND ${fragment}${after}`;
    } else {
      // No WHERE in block — insert `WHERE fragment` before block end
      let j = insertBeforeIdx >= 0 ? insertBeforeIdx : blockEnd;
      while (j > blockStart && tokens[j - 1].type === "whitespace") j--;
      const before = tokens.slice(0, j).map((t) => t.text).join("");
      const after = tokens.slice(j).map((t) => t.text).join("");
      workingSql = `${before} WHERE ${fragment}${after}`;
    }
  }

  return workingSql;
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
