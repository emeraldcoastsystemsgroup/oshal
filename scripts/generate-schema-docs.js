#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Schema-docs generator. Reads the reference Postgres databases' catalogs (read-only) and scans core + store + private source for CREATE TABLE, then writes: the core data-model pages (docs/architecture/data-model/*, README blocks refreshed in place), one SCHEMA.md per package that owns tables, and the store-root SCHEMAS.md. Hand-typed schema docs drift the day they are written; these regenerate to a zero diff when nothing changed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { introspectDatabase } = require('./schema-docs/introspect');
const { scanCore, scanPackageRepo } = require('./schema-docs/source-scan');
const { buildModel, definersFor } = require('./schema-docs/model');
const { replaceBlock, GENERATED_BANNER } = require('./schema-docs/render');
const { renderCorePages, renderSimplePage, renderSqlitePage, renderDomainIndex, coreLinker } = require('./schema-docs/pages');
const { renderPackagePage, renderStoreIndex } = require('./schema-docs/package-pages');

const USAGE = `Usage: node scripts/generate-schema-docs.js [options]
  --core-root <dir>      core checkout to scan (default: cwd)
  --core-out <dir>       core docs dir (default: <core-root>/docs/architecture/data-model)
  --store-root <dir>     store package repo to scan + write <pkg>/SCHEMA.md and SCHEMAS.md into
  --private-root <dir>   private package repo to scan + write <pkg>/SCHEMA.md into
  --store-out <dir>      write store pages here instead of --store-root (review before committing)
  --private-out <dir>    write private pages here instead of --private-root
  --pg-container <name>  platform Postgres container (default: oshal-local-db)
  --pg-db <name>         platform database (default: oshal)
  --pg-url <url>         read the platform database over a URL instead of docker exec
  --ts-container <name>  TimescaleDB container (default: oshal-local-tsdb)
  --ts-db <name>         TimescaleDB database (default: oshal_ts)
  --ts-url <url>         read TimescaleDB over a URL instead of docker exec
  --no-ts                skip the TimescaleDB database`;

/**
 * @description Parse argv into options.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {object} options
 */
function parseArgs(argv) {
  const opts = { coreRoot: process.cwd(), pgContainer: 'oshal-local-db', pgDb: 'oshal', tsContainer: 'oshal-local-tsdb', tsDb: 'oshal_ts', ts: true };
  const keys = { '--core-root': 'coreRoot', '--core-out': 'coreOut', '--store-root': 'storeRoot', '--private-root': 'privateRoot',
    '--store-out': 'storeOut', '--private-out': 'privateOut',
    '--pg-container': 'pgContainer', '--pg-db': 'pgDb', '--pg-url': 'pgUrl', '--ts-container': 'tsContainer', '--ts-db': 'tsDb', '--ts-url': 'tsUrl' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--no-ts') opts.ts = false;
    else if (argv[i] === '--help' || argv[i] === '-h') { console.log(USAGE); process.exit(0); }
    else if (keys[argv[i]] && argv[i + 1]) { opts[keys[argv[i]]] = argv[i + 1]; i += 1; }
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}\n${USAGE}`);
  }
  opts.coreOut = opts.coreOut || path.join(opts.coreRoot, 'docs/architecture/data-model');
  return opts;
}

/**
 * @description Write a file only when its content changed; report what was written.
 * @param {string} file - absolute path
 * @param {string} text - content (LF line endings)
 * @param {string[]} written - collector of changed paths
 * @returns {void}
 */
function writeIfChanged(file, text, written) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  written.push(file);
}

/**
 * @description Delete a previously generated page this run no longer produces (a domain that
 * emptied, a package that dropped its tables). Only files carrying the generated banner are
 * touched, so a hand-written file with the same name is never removed.
 * @param {string} file - absolute path
 * @param {string[]} removed - collector of deleted paths
 * @returns {void}
 */
function pruneGenerated(file, removed) {
  if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').startsWith(GENERATED_BANNER)) return;
  fs.unlinkSync(file);
  removed.push(file);
}

/**
 * @description Introspect the reference databases.
 * @param {object} opts - parsed options
 * @returns {Promise<Array<{name: string, tables: Map}>>} databases, platform DB first
 */
async function readDatabases(opts) {
  const pg = await introspectDatabase({ container: opts.pgContainer, database: opts.pgDb, url: opts.pgUrl });
  const dbs = [{ name: opts.pgDb, tables: pg.tables, views: pg.views }];
  if (opts.ts) {
    const ts = await introspectDatabase({ container: opts.tsContainer, database: opts.tsDb, url: opts.tsUrl });
    dbs.push({ name: opts.tsDb, tables: ts.tables, views: ts.views });
  }
  return dbs;
}

/**
 * @description The README "inventory" block: what each store holds, with generated counts.
 * @param {object} model - buildModel output
 * @param {Array<object>} dbs - introspected databases
 * @param {object} opts - options
 * @returns {string} markdown
 */
function inventoryBlock(model, dbs, opts) {
  const coreSet = new Set((model.core.live.get(opts.pgDb) || []).map((t) => t.name));
  const pkgSet = new Set(model.packages.flatMap((p) => (p.view.live.get(opts.pgDb) || []).map((t) => t.name)));
  const both = [...coreSet].filter((t) => pkgSet.has(t)).length;
  const unowned = model.unowned.filter((t) => t.startsWith(`${opts.pgDb}.`)).length;
  const rows = ['| Store | Engine | Holds | Documented in |', '|---|---|---|---|',
    `| \`${opts.pgDb}\` | Postgres + pgvector | ${dbs[0].tables.size} tables and ${dbs[0].views.size} views in schema \`public\`. Tables: ${coreSet.size} declared by core, `
      + `${pkgSet.size} by application packages${both ? ` (${both} by both)` : ''}`
      + `${unowned ? `, ${unowned} by no scanned source` : ''} | [core domain pages](#core-postgres-domains) · each package's \`SCHEMA.md\` |`];
  if (opts.ts) rows.push(`| \`${opts.tsDb}\` | TimescaleDB (Postgres) | ${(model.core.live.get(opts.tsDb) || []).length} core tables (world data, trading signal labels) | [timeseries.md](timeseries.md) |`);
  rows.push(`| SQLite files | SQLite | ${model.core.sqlite.length} core tables declared in ${new Set(model.core.sqlite.map((t) => t.sites.filter((s) => s.repo === 'core')[0].file)).size} source files | [sqlite.md](sqlite.md) |`);
  rows.push('| ArangoDB | graph | one database per person and per tenant, `nodes` + `edges` collections | [below](#graph-vector-and-cache-stores) |');
  rows.push('| ChromaDB | vector | named collections, server-side embeddings | [below](#graph-vector-and-cache-stores) |');
  rows.push('| Redis | streams / keys | mesh transport, heartbeats, subtask registry, replay guards | [below](#graph-vector-and-cache-stores) |');
  return rows.join('\n');
}

/**
 * @description Write every core page and refresh the README's generated blocks.
 * @param {object} model - buildModel output
 * @param {Array<object>} dbs - databases
 * @param {object} opts - options
 * @param {string[]} written - collector
 * @returns {Array<object>} the domain pages (for reporting)
 */
function writeCore(model, dbs, opts, written) {
  const pages = renderCorePages(model, opts.pgDb);
  for (const p of pages) writeIfChanged(path.join(opts.coreOut, p.file), p.text, written);
  const produced = new Set([...pages.map((p) => p.file), 'timeseries.md', 'sqlite.md']);
  for (const f of fs.existsSync(opts.coreOut) ? fs.readdirSync(opts.coreOut) : []) {
    if (f.endsWith('.md') && !produced.has(f)) pruneGenerated(path.join(opts.coreOut, f), written);
  }
  const coreCtx = {
    linkFor: coreLinker(new Map()),
    definersOf: (t) => definersFor(model.byTable, t, (s) => s.repo === 'core' && s.kind === 'table' && s.engine === 'postgres'),
    noteFor: null,
  };
  if (opts.ts) {
    writeIfChanged(path.join(opts.coreOut, 'timeseries.md'), renderSimplePage({
      title: `Time-series database (\`${opts.tsDb}\`)`,
      subtitle: `[Data model index](README.md) · TimescaleDB · schema \`public\` · ${(model.core.live.get(opts.tsDb) || []).length} tables`
        + `, ${(model.core.views.get(opts.tsDb) || []).length} views`,
      intro: 'A separate TimescaleDB instance for high-volume time-series. It shares no foreign keys with the platform database.',
      tables: model.core.live.get(opts.tsDb) || [], views: model.core.views.get(opts.tsDb) || [], ctx: coreCtx,
      viewDefiners: (v) => definersFor(model.byTable, v, (s) => s.repo === 'core' && s.kind === 'view') }), written);
  }
  const coreFiles = (t) => t.sites.filter((s) => s.repo === 'core').map((s) => s.file).sort();
  writeIfChanged(path.join(opts.coreOut, 'sqlite.md'), renderSqlitePage(model.core.sqlite, coreFiles), written);
  const readmePath = path.join(opts.coreOut, 'README.md');
  let readme = fs.readFileSync(readmePath, 'utf8');
  readme = replaceBlock(readme, 'inventory', inventoryBlock(model, dbs, opts));
  readme = replaceBlock(readme, 'domains', renderDomainIndex(pages));
  writeIfChanged(readmePath, readme, written);
  return pages;
}

/**
 * @description Write each package's SCHEMA.md (and the store index).
 * @param {object} model - buildModel output
 * @param {object} opts - options
 * @param {string[]} written - collector
 * @returns {void}
 */
function writePackages(model, opts, written) {
  for (const repo of ['store', 'private']) {
    const scanned = repo === 'store' ? opts.storeRoot : opts.privateRoot;
    if (!scanned) continue;
    const root = (repo === 'store' ? opts.storeOut : opts.privateOut) || scanned;
    const pkgs = model.packages.filter((p) => p.repo === repo);
    const repoPages = new Map();
    for (const p of pkgs) for (const t of [...p.view.live.values()].flat()) if (!repoPages.has(t.name)) repoPages.set(t.name, p.dir);
    for (const p of pkgs) {
      const text = renderPackagePage(p, model, repoPages, opts.pgDb);
      p.hasPage = !!text;
      if (text) writeIfChanged(path.join(root, p.dir, 'SCHEMA.md'), text, written);
      else pruneGenerated(path.join(root, p.dir, 'SCHEMA.md'), written);
    }
    if (repo === 'store') writeIfChanged(path.join(root, 'SCHEMAS.md'), renderStoreIndex(pkgs), written);
  }
}

/**
 * @description Entry point.
 * @returns {Promise<void>}
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbs = await readDatabases(opts);
  const model = buildModel({
    databases: dbs,
    coreSites: scanCore(opts.coreRoot),
    storeScan: opts.storeRoot ? scanPackageRepo(opts.storeRoot, 'store') : null,
    privateScan: opts.privateRoot ? scanPackageRepo(opts.privateRoot, 'private') : null,
  });
  const written = [];
  const pages = writeCore(model, dbs, opts, written);
  writePackages(model, opts, written);
  const other = pages.find((p) => p.group.domain.slug === 'other');
  if (other) console.warn(`WARN core tables on the "Other" page (extend scripts/schema-docs/domains.js): ${[...other.group.tables, ...other.group.absent].map((t) => t.name).join(', ')}`);
  if (model.unowned.length) console.warn(`WARN live tables no scanned source declares (not documented): ${model.unowned.join(', ')}`);
  const unparsed = [...model.core.unparsed, ...model.packages.flatMap((p) => p.view.unparsed.map((t) => `${p.dir}:${t}`))];
  if (unparsed.length) console.warn(`WARN declarations that could not be parsed: ${unparsed.join(', ')}`);
  console.log(written.length ? `Wrote or pruned ${written.length} file(s):\n  ${written.join('\n  ')}` : 'Schema docs already up to date.');
}

if (require.main === module) {
  main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
}

module.exports = { parseArgs };
