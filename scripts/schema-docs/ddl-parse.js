/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Static CREATE TABLE parser for the schema-docs generator. Used ONLY where no catalog exists to read: SQLite stores (better-sqlite3 / python sqlite3) and tables a source file declares that the reference Postgres database does not hold. Extracts columns, types, nullability, defaults, PK, inline + table-level FKs and UNIQUE from the statement as written; it does not replay later ALTERs, and the rendered docs say so.
 */

'use strict';

const COLUMN_STOP = /^(NOT|NULL|DEFAULT|PRIMARY|REFERENCES|UNIQUE|CHECK|CONSTRAINT|GENERATED|COLLATE|AUTOINCREMENT|ON)$/i;
const TABLE_CONSTRAINT = /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE)\b/i;

/**
 * @description Return the index of the parenthesis that closes the one at `open`, skipping
 * `--` line comments, quoted strings and `${…}` template interpolations, so neither a default
 * like '(x)' nor an apostrophe in a comment ("the user's") can unbalance it.
 * @param {string} text - source text
 * @param {number} open - index of an opening parenthesis
 * @returns {number} index of the matching close, or -1 when the statement is truncated
 */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      if (end === -1) return -1;
      i = end;
    } else if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end === -1) return -1;
      i = end;
    } else if (ch === '$' && text[i + 1] === '{') {
      const end = text.indexOf('}', i);
      if (end === -1) return -1;
      i = end;
    } else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * @description Split a CREATE TABLE body on commas that sit at paren depth zero.
 * @param {string} body - text between the outer parentheses
 * @returns {string[]} trimmed, non-empty items with SQL line comments removed
 */
function splitTopLevel(body) {
  const cleaned = body.replace(/--[^\n]*/g, ' ');
  const items = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) { items.push(cleaned.slice(start, i)); start = i + 1; }
  }
  items.push(cleaned.slice(start));
  return items.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * @description Unquote an identifier list like `"a", b` into ['a', 'b'].
 * @param {string} list - comma-separated identifiers
 * @returns {string[]} bare identifiers
 */
function identList(list) {
  return list.split(',').map((s) => s.trim().replace(/^["`[]|["`\]]$/g, '')).filter(Boolean);
}

/**
 * @description Parse one column definition item.
 * @param {string} item - e.g. `user_sub TEXT NOT NULL REFERENCES users(sub)`
 * @returns {{column: object, pk: boolean, fk: object|null, unique: boolean}} parsed parts
 */
function parseColumn(item) {
  const tokens = item.split(' ');
  const name = tokens[0].replace(/^["`[]|["`\]]$/g, '');
  const typeTokens = [];
  let i = 1;
  for (; i < tokens.length && !COLUMN_STOP.test(tokens[i]); i += 1) typeTokens.push(tokens[i]);
  const rest = tokens.slice(i).join(' ');
  const def = rest.match(/\bDEFAULT\s+((?:\([^)]*\)|'[^']*'|[^\s,])+(?:\s*\([^)]*\))?)/i);
  const ref = rest.match(/\bREFERENCES\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(?:\(([^)]*)\))?/i);
  const pk = /\bPRIMARY\s+KEY\b/i.test(rest);
  return {
    column: {
      name,
      type: typeTokens.join(' ') || '(untyped)',
      nullable: !/\bNOT\s+NULL\b/i.test(rest) && !pk,
      default: def ? def[1] : null,
      comment: null,
    },
    pk,
    unique: /\bUNIQUE\b/i.test(rest),
    fk: ref ? { name: null, columns: [name], refTable: ref[1], refColumns: ref[2] ? identList(ref[2]) : [] } : null,
  };
}

/**
 * @description Apply one table-level constraint item to the table record.
 * @param {object} table - record being built
 * @param {string} item - e.g. `PRIMARY KEY (a, b)` or `CONSTRAINT x FOREIGN KEY (a) REFERENCES t(b)`
 * @returns {void}
 */
function applyTableConstraint(table, item) {
  const pk = item.match(/PRIMARY\s+KEY\s*\(([^)]*)\)/i);
  if (pk) table.primaryKey = identList(pk[1]);
  const fk = item.match(/FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(?:\(([^)]*)\))?/i);
  if (fk) table.foreignKeys.push({ name: null, columns: identList(fk[1]), refTable: fk[2], refColumns: fk[3] ? identList(fk[3]) : [] });
  const uq = !pk && !fk && item.match(/UNIQUE\s*\(([^)]*)\)/i);
  if (uq) table.uniques.push(identList(uq[1]));
}

/**
 * @description Parse a CREATE TABLE statement into the same record shape the catalog
 * introspection produces, flagged `source: 'parsed'`.
 * @param {string} name - resolved table name
 * @param {string} ddl - text starting at CREATE TABLE and containing the body's parentheses
 * @returns {object|null} table record, or null when the body cannot be delimited
 */
function parseCreateTable(name, ddl) {
  const open = ddl.indexOf('(');
  const close = open === -1 ? -1 : matchParen(ddl, open);
  if (close === -1) return null;
  const table = {
    name, comment: null, rls: false, forced: false, policies: [], columns: [], primaryKey: [],
    foreignKeys: [], uniques: [], hypertable: null, source: 'parsed',
  };
  for (const item of splitTopLevel(ddl.slice(open + 1, close))) {
    if (TABLE_CONSTRAINT.test(item)) { applyTableConstraint(table, item); continue; }
    if (item.startsWith('${')) continue;
    const parsed = parseColumn(item);
    table.columns.push(parsed.column);
    if (parsed.pk) table.primaryKey = [parsed.column.name];
    if (parsed.unique) table.uniques.push([parsed.column.name]);
    if (parsed.fk) table.foreignKeys.push(parsed.fk);
  }
  return table;
}

module.exports = { parseCreateTable, matchParen, splitTopLevel };
