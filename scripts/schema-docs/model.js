/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Ownership model for the schema docs: joins the catalog (what the reference databases hold) with the source scan (who declares each table) into one core view and one view per package (tables, views, SQLite stores). A live table belongs to whoever has a Postgres CREATE TABLE for it; SQLite declarations and tables absent from every reference database are parsed statically and labelled as such. A live table nobody declares is reported, never guessed.
 */

'use strict';

const { parseCreateTable } = require('./ddl-parse');

const REPO_RANK = { core: 0, store: 1, private: 2 };

/**
 * @description Index CREATE TABLE sites by table name.
 * @param {Array<object>} sites - from source-scan
 * @returns {Map<string, Array<object>>} table -> sites
 */
function indexSites(sites) {
  const map = new Map();
  for (const s of sites) {
    if (!map.has(s.table)) map.set(s.table, []);
    map.get(s.table).push(s);
  }
  return map;
}

/**
 * @description Order definer files so migrations read first, then runtime code.
 * @param {string[]} files - repo- or package-relative paths
 * @returns {string[]} unique, sorted paths
 */
function sortDefiners(files) {
  const rank = (f) => (/(^|\/)migrations\//.test(f) ? 0 : 1);
  return [...new Set(files)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * @description Statically parse the first parseable site for a table (SQLite or absent tables).
 * @param {string} table - table name
 * @param {Array<object>} sites - candidate sites, best first
 * @returns {object|null} parsed table record
 */
function parseFromSites(table, sites) {
  for (const s of sites) {
    const parsed = parseCreateTable(table, s.ddl);
    if (parsed && parsed.columns.length) return parsed;
  }
  return null;
}

/**
 * @description Build the view for one owner (core, or one package).
 * @param {(s: object) => boolean} isMine - selects this owner's sites
 * @param {Map<string, Array<object>>} byTable - all sites by table
 * @param {Array<{name: string, tables: Map<string, object>, views: Map<string, object>}>} databases - introspected reference DBs
 * @returns {{live: Map<string, object[]>, views: Map<string, object[]>, absent: object[], sqlite: object[], unparsed: string[]}}
 *   live / views: database -> records; absent/sqlite: parsed records with `sites`
 */
function ownerView(isMine, byTable, databases) {
  const view = { live: new Map(databases.map((d) => [d.name, []])), views: new Map(databases.map((d) => [d.name, []])), absent: [], sqlite: [], unparsed: [] };
  for (const [table, sites] of byTable) {
    const mine = sites.filter(isMine);
    if (!mine.length) continue;
    const pgSites = mine.filter((s) => s.kind === 'table' && s.engine === 'postgres');
    const liteSites = mine.filter((s) => s.kind === 'table' && s.engine === 'sqlite');
    const db = pgSites.length ? databases.find((d) => d.tables.has(table)) : null;
    if (db) view.live.get(db.name).push(db.tables.get(table));
    else if (pgSites.length && !databases.some((d) => d.views.has(table))) pushParsed(view.absent, view.unparsed, table, pgSites);
    if (liteSites.length) pushParsed(view.sqlite, view.unparsed, table, liteSites);
    const viewDb = mine.some((s) => s.kind === 'view') ? databases.find((d) => d.views.has(table)) : null;
    if (viewDb) view.views.get(viewDb.name).push(viewDb.views.get(table));
  }
  for (const list of [...view.live.values(), ...view.views.values(), view.absent, view.sqlite]) list.sort((a, b) => a.name.localeCompare(b.name));
  return view;
}

/**
 * @description Parse a table from its sites and append it (or record the failure).
 * @param {object[]} into - destination list
 * @param {string[]} failures - unparsed table names
 * @param {string} table - table name
 * @param {object[]} sites - its sites for this owner
 * @returns {void}
 */
function pushParsed(into, failures, table, sites) {
  const parsed = parseFromSites(table, sites);
  if (!parsed) { failures.push(table); return; }
  parsed.sites = sites;
  into.push(parsed);
}

/**
 * @description Build the whole model.
 * @param {{databases: Array<object>, coreSites: object[], storeScan: object|null, privateScan: object|null}} input
 * @returns {object} {byTable, core, packages: [{repo, dir, manifest, view}], unowned: string[]}
 */
function buildModel({ databases, coreSites, storeScan, privateScan }) {
  const allSites = [...coreSites, ...(storeScan?.sites || []), ...(privateScan?.sites || [])];
  const byTable = indexSites(allSites);
  const core = ownerView((s) => s.repo === 'core', byTable, databases);
  const packages = [];
  for (const [repo, scan] of [['store', storeScan], ['private', privateScan]]) {
    if (!scan) continue;
    for (const [dir, manifest] of [...scan.packages].sort((a, b) => a[0].localeCompare(b[0]))) {
      const view = ownerView((s) => s.repo === repo && s.pkg === dir, byTable, databases);
      packages.push({ repo, dir, manifest, view });
    }
  }
  const declaredTables = new Set(allSites.filter((s) => s.kind === 'table' && s.engine === 'postgres').map((s) => s.table));
  const declaredViews = new Set(allSites.filter((s) => s.kind === 'view').map((s) => s.table));
  const unowned = databases.flatMap((d) => [
    ...[...d.tables.keys()].filter((t) => !declaredTables.has(t)).map((t) => `${d.name}.${t}`),
    ...[...d.views.keys()].filter((v) => !declaredViews.has(v)).map((v) => `${d.name}.${v} (view)`),
  ]);
  return { byTable, core, packages, unowned };
}

/**
 * @description Definer files for a table, restricted to one owner, for the "Defined in" line.
 * @param {Map<string, object[]>} byTable - all sites
 * @param {string} table - table name
 * @param {(s: object) => boolean} isMine - owner filter
 * @returns {string[]} sorted relative paths
 */
function definersFor(byTable, table, isMine) {
  return sortDefiners((byTable.get(table) || []).filter(isMine).map((s) => s.file));
}

/**
 * @description Other owners of a table that a page may name. Visibility only flows toward the
 * more private repo: core and store pages never name a private package.
 * @param {Map<string, object[]>} byTable - all sites
 * @param {string} table - table name
 * @param {{repo: string, pkg: string|null}} self - the page's owner
 * @returns {Array<{repo: string, pkg: string|null, files: string[]}>} co-owners, core first
 */
function coOwners(byTable, table, self) {
  const groups = new Map();
  for (const s of byTable.get(table) || []) {
    if (s.kind !== 'table' || s.engine !== 'postgres' || (s.repo === self.repo && s.pkg === self.pkg)) continue;
    if (REPO_RANK[s.repo] > REPO_RANK[self.repo]) continue;
    const key = `${s.repo}:${s.pkg || ''}`;
    if (!groups.has(key)) groups.set(key, { repo: s.repo, pkg: s.pkg, files: [] });
    groups.get(key).files.push(s.file);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, files: sortDefiners(g.files) }))
    .sort((a, b) => REPO_RANK[a.repo] - REPO_RANK[b.repo] || String(a.pkg).localeCompare(String(b.pkg)));
}

module.exports = { buildModel, definersFor, coOwners, sortDefiners, indexSites };
