/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Static CREATE TABLE parser for the data-model explorer, used ONLY where no catalog exists: SQLite declarations and Postgres tables a source declares that the reference database does not hold. Same rules as the schema-docs generator's scripts/schema-docs/ddl-parse.js (parity held by tests/unit/data-model-catalog.spec.ts): skips `--` comments, quoted strings and `${...}` interpolations; later ALTERs are not replayed.
 */

import type { ForeignKeyInfo, RelationInfo } from '../types';

const COLUMN_STOP = /^(NOT|NULL|DEFAULT|PRIMARY|REFERENCES|UNIQUE|CHECK|CONSTRAINT|GENERATED|COLLATE|AUTOINCREMENT|ON)$/i;
const TABLE_CONSTRAINT = /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE)\b/i;
const UNQUOTE = /^["`[]|["`\]]$/g;

/**
 * @description Index of the parenthesis closing the one at `open`, skipping `--` comments,
 * quoted strings and `${...}` interpolations so neither a default like '(x)' nor an apostrophe
 * in a comment can unbalance it.
 * @param text - source text
 * @param open - index of an opening parenthesis
 * @returns index of the matching close, or -1 when the statement is truncated
 */
export function matchParen(text: string, open: number): number {
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
 * @description Split a CREATE TABLE body on commas at paren depth zero.
 * @param body - text between the outer parentheses
 * @returns trimmed, non-empty items with line comments removed
 */
export function splitTopLevel(body: string): string[] {
  const cleaned = body.replace(/--[^\n]*/g, ' ');
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
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
 * @param list - comma-separated identifiers
 * @returns bare identifiers
 */
function identList(list: string): string[] {
  return list.split(',').map((s) => s.trim().replace(UNQUOTE, '')).filter(Boolean);
}

/**
 * @description Parse one column definition item.
 * @param item - e.g. `user_sub TEXT NOT NULL REFERENCES users(sub)`
 * @returns the column plus any inline PK / UNIQUE / FK it declares
 */
function parseColumn(item: string): { column: RelationInfo['columns'][number]; pk: boolean; unique: boolean; fk: ForeignKeyInfo | null } {
  const tokens = item.split(' ');
  const name = tokens[0].replace(UNQUOTE, '');
  const typeTokens: string[] = [];
  let i = 1;
  for (; i < tokens.length && !COLUMN_STOP.test(tokens[i]); i += 1) typeTokens.push(tokens[i]);
  const rest = tokens.slice(i).join(' ');
  const def = rest.match(/\bDEFAULT\s+((?:\([^)]*\)|'[^']*'|[^\s,])+(?:\s*\([^)]*\))?)/i);
  const ref = rest.match(/\bREFERENCES\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(?:\(([^)]*)\))?/i);
  const pk = /\bPRIMARY\s+KEY\b/i.test(rest);
  return {
    column: { name, type: typeTokens.join(' ') || '(untyped)', nullable: !/\bNOT\s+NULL\b/i.test(rest) && !pk, default: def ? def[1] : null, comment: null },
    pk,
    unique: /\bUNIQUE\b/i.test(rest),
    fk: ref ? { name: null, columns: [name], refTable: ref[1], refColumns: ref[2] ? identList(ref[2]) : [] } : null,
  };
}

/**
 * @description Apply one table-level constraint item to the relation being built.
 * @param rel - relation under construction
 * @param item - e.g. `PRIMARY KEY (a, b)` or `FOREIGN KEY (a) REFERENCES t(b)`
 * @returns nothing; mutates `rel`
 */
function applyTableConstraint(rel: RelationInfo, item: string): void {
  const pk = item.match(/PRIMARY\s+KEY\s*\(([^)]*)\)/i);
  if (pk) rel.primaryKey = identList(pk[1]);
  const fk = item.match(/FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*(?:\(([^)]*)\))?/i);
  if (fk) rel.foreignKeys.push({ name: null, columns: identList(fk[1]), refTable: fk[2], refColumns: fk[3] ? identList(fk[3]) : [] });
  const uq = !pk && !fk && item.match(/UNIQUE\s*\(([^)]*)\)/i);
  if (uq) rel.uniques.push(identList(uq[1]));
}

/**
 * @description Parse a CREATE TABLE statement into the catalog's relation shape, flagged
 * `source: 'parsed'`.
 * @param name - resolved table name
 * @param ddl - text starting at CREATE TABLE and containing the body's parentheses
 * @returns the relation, or null when the body cannot be delimited
 */
export function parseCreateTable(name: string, ddl: string): RelationInfo | null {
  const open = ddl.indexOf('(');
  const close = open === -1 ? -1 : matchParen(ddl, open);
  if (close === -1) return null;
  const rel: RelationInfo = {
    name, kind: 'table', comment: null, rls: false, forced: false, policies: [], columns: [], primaryKey: [],
    foreignKeys: [], uniques: [], hypertable: null, materialized: false, source: 'parsed',
  };
  for (const item of splitTopLevel(ddl.slice(open + 1, close))) {
    if (TABLE_CONSTRAINT.test(item)) { applyTableConstraint(rel, item); continue; }
    if (item.startsWith('${')) continue;
    const parsed = parseColumn(item);
    rel.columns.push(parsed.column);
    if (parsed.pk) rel.primaryKey = [parsed.column.name];
    if (parsed.unique) rel.uniques.push([parsed.column.name]);
    if (parsed.fk) rel.foreignKeys.push(parsed.fk);
  }
  return rel;
}
