/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Ownership model for the data-model explorer: joins what the catalogs hold with who declares it. A live relation belongs to every owner (core or an installed app) with a Postgres CREATE for it; a relation nobody declares stays visible but is listed as unowned, never guessed. Declared-but-absent Postgres tables and SQLite tables are parsed statically. Also derives the database-level links between owners: shared tables and foreign keys that cross an owner boundary.
 */

import { parseCreateTable } from './ddl-parser';
import { summarizeRowAccess } from './row-access';
import {
  CORE_OWNER,
  type CatalogSnapshot, type DeclarationSite, type DeclaredRelation, type IntegrationEdge,
  type ModelRelation, type RelationInfo,
} from '../types';

/** The ownership view of every relation the catalogs hold, plus what only source knows about. */
export interface OwnershipResult {
  tables: ModelRelation[];
  views: ModelRelation[];
  declaredAbsent: DeclaredRelation[];
  sqlite: DeclaredRelation[];
  unowned: string[];
}

/**
 * @description Order owners with core first, then alphabetically.
 * @param owners - owner ids
 * @returns a new, de-duplicated, sorted array
 */
export function sortOwners(owners: Iterable<string>): string[] {
  return [...new Set(owners)].sort((a, b) => (a === CORE_OWNER ? -1 : b === CORE_OWNER ? 1 : a.localeCompare(b)));
}

/**
 * @description Group declaring files by owner, migrations listed first within each owner.
 * @param sites - declaration sites for one relation
 * @returns owner -> files
 */
function definersByOwner(sites: DeclarationSite[]): Record<string, string[]> {
  const rank = (f: string) => (/(^|\/)migrations\//.test(f) ? 0 : 1);
  const out: Record<string, string[]> = {};
  for (const s of sites) (out[s.owner] ||= []).push(s.file);
  for (const owner of Object.keys(out)) out[owner] = [...new Set(out[owner])].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return out;
}

/**
 * @description Index declaration sites by `kind:engine:name`.
 * @param sites - all sites
 * @returns index
 */
function indexSites(sites: DeclarationSite[]): Map<string, DeclarationSite[]> {
  const index = new Map<string, DeclarationSite[]>();
  for (const s of sites) {
    const key = `${s.kind}:${s.engine}:${s.name}`;
    if (!index.has(key)) index.set(key, []);
    (index.get(key) as DeclarationSite[]).push(s);
  }
  return index;
}

/**
 * @description Place one catalog relation: owners, definers and RLS summary.
 * @param rel - catalog relation
 * @param database - database it lives in
 * @param sites - Postgres declaration sites of the same kind and name
 * @returns the model relation
 */
function placeRelation(rel: RelationInfo, database: string, sites: DeclarationSite[]): ModelRelation {
  return {
    ...rel, database, owners: sortOwners(sites.map((s) => s.owner)),
    definers: definersByOwner(sites), access: summarizeRowAccess(rel),
  };
}

/**
 * @description Parse declared relations per owner (for absent Postgres tables and SQLite tables).
 * @param sites - sites for one name and engine
 * @returns one parsed relation per owner that has a parseable statement
 */
function parsePerOwner(sites: DeclarationSite[]): DeclaredRelation[] {
  const byOwner = new Map<string, DeclarationSite[]>();
  for (const s of sites) byOwner.set(s.owner, [...(byOwner.get(s.owner) ?? []), s]);
  const out: DeclaredRelation[] = [];
  for (const [owner, own] of byOwner) {
    const parsed = own.map((s) => parseCreateTable(s.name, s.ddl)).find((r) => r && r.columns.length);
    if (parsed) out.push({ ...parsed, owner, files: [...new Set(own.map((s) => s.file))].sort(), engine: own[0].engine });
  }
  return out;
}

/**
 * @description Attribute every catalog relation to its declaring owners.
 * @param catalogs - introspected databases (platform first)
 * @param sites - declaration sites from core and every installed app
 * @returns owned relations, unowned names, declared-but-absent and SQLite tables
 */
export function attributeOwnership(catalogs: CatalogSnapshot[], sites: DeclarationSite[]): OwnershipResult {
  const index = indexSites(sites);
  const result: OwnershipResult = { tables: [], views: [], declaredAbsent: [], sqlite: [], unowned: [] };
  const present = new Set<string>();
  for (const cat of catalogs) {
    for (const [list, kind] of [[cat.tables, 'table'], [cat.views, 'view']] as const) {
      for (const rel of list) {
        present.add(rel.name);
        const placed = placeRelation(rel, cat.database, index.get(`${kind}:postgres:${rel.name}`) ?? []);
        if (!placed.owners.length) result.unowned.push(`${cat.database}.${rel.name}${kind === 'view' ? ' (view)' : ''}`);
        (kind === 'table' ? result.tables : result.views).push(placed);
      }
    }
  }
  for (const [key, group] of index) {
    const [kind, engine, name] = key.split(':');
    if (kind !== 'table') continue;
    if (engine === 'sqlite') result.sqlite.push(...parsePerOwner(group));
    else if (!present.has(name)) result.declaredAbsent.push(...parsePerOwner(group));
  }
  for (const list of [result.declaredAbsent, result.sqlite]) list.sort((a, b) => a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner));
  return result;
}

/**
 * @description Database-level links between owners: tables two owners both declare, and foreign
 * keys whose child and parent share no owner.
 * @param tables - owned platform tables
 * @returns raw edges (one per table or FK; the integration map aggregates them)
 */
export function databaseLinks(tables: ModelRelation[]): IntegrationEdge[] {
  const ownersOf = new Map(tables.map((t) => [t.name, t.owners]));
  const edges: IntegrationEdge[] = [];
  for (const t of tables) {
    for (let i = 0; i < t.owners.length; i += 1) {
      for (let j = i + 1; j < t.owners.length; j += 1) edges.push({ from: t.owners[i], to: t.owners[j], kind: 'shared-table', label: t.name });
    }
    for (const fk of t.foreignKeys) {
      const parents = ownersOf.get(fk.refTable) ?? [];
      if (!t.owners.length || !parents.length || t.owners.some((o) => parents.includes(o))) continue;
      for (const from of t.owners) for (const to of parents) edges.push({ from, to, kind: 'foreign-key', label: `${t.name} → ${fk.refTable}` });
    }
  }
  return edges;
}
