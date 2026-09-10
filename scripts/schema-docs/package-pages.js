/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-package SCHEMA.md rendering for the schema docs, plus the store-root SCHEMAS.md index. A package page shows the package's Postgres tables (from the catalog), how they are created (manifest migrations vs runtime code), co-owners it may name, tables declared but not present, and any SQLite stores. FKs into core link to the public core docs.
 */

'use strict';

const { GENERATED_BANNER, mermaidDiagram, tableSection, plural } = require('./render');
const { tablesBody, CORE_DOCS_URL, KEY_LEGEND } = require('./pages');
const { definersFor, coOwners } = require('./model');
const { domainFor } = require('./domains');

/**
 * @description Link resolver for a package page.
 * @param {object} pkg - {repo, dir, view}
 * @param {object} model - buildModel output
 * @param {Map<string, string>} repoPages - table -> "<pkgdir>" for packages in the SAME repo
 * @returns {function(string, string): string} (table, column) -> markdown
 */
function packageLinker(pkg, model, repoPages) {
  const mine = new Set([...pkg.view.live.values()].flat().map((t) => t.name));
  const coreTables = new Set([...model.core.live.values()].flat().map((t) => t.name));
  return (table, column) => {
    const label = `\`${table}${column ? `.${column}` : ''}\``;
    if (mine.has(table)) return `[${label}](#${table})`;
    if (coreTables.has(table)) return `[${label}](${CORE_DOCS_URL}/${domainFor(table).slug}.md#${table}) (core)`;
    const other = repoPages.get(table);
    return other ? `[${label}](../${other}/SCHEMA.md#${table}) (\`${other}\`)` : label;
  };
}

/**
 * @description Co-owner note for a package table (core files are named; packages by dir).
 * @param {object} model - buildModel output
 * @param {object} pkg - the page's package
 * @returns {function(string): string|null} table -> note
 */
function packageNoteFor(model, pkg) {
  return (table) => {
    const others = coOwners(model.byTable, table, { repo: pkg.repo, pkg: pkg.dir });
    if (!others.length) return null;
    const parts = others.map((o) => (o.repo === 'core'
      ? `core (${o.files.map((f) => `\`${f}\``).join(', ')})`
      : `package \`${o.pkg}\``));
    return `Also declared by ${parts.join(' and ')}.`;
  };
}

/**
 * @description The "how this schema is created" paragraph for a package.
 * @param {object} pkg - {manifest, view}
 * @param {object} model - buildModel output
 * @returns {string[]} markdown lines
 */
function creationLines(pkg, model) {
  const isMine = (s) => s.repo === pkg.repo && s.pkg === pkg.dir && s.kind === 'table' && s.engine === 'postgres';
  const tables = [...pkg.view.live.values()].flat().concat(pkg.view.absent);
  const runtime = new Set();
  for (const t of tables) definersFor(model.byTable, t.name, isMine).filter((f) => !/(^|\/)migrations\//.test(f)).forEach((f) => runtime.add(f));
  const lines = [];
  const migs = pkg.manifest.migrations;
  lines.push(migs.length
    ? `**Migrations** (declared in \`oshal-app.yaml\`, applied on activation, recorded in \`app_package_migrations\`): ${migs.map((m) => `\`${m}\``).join(', ')}`
    : '**Migrations:** none declared in `oshal-app.yaml`.');
  if (runtime.size) lines.push('', `**Created at runtime by package code** (\`CREATE TABLE IF NOT EXISTS\`): ${[...runtime].sort().map((f) => `\`${f}\``).join(', ')}`);
  return lines;
}

/**
 * @description Opening sentence: where the package's data lives and how much of it there is.
 * @param {{pgTables: object[], views: object[], absent: object[], sqlite: object[], dbName: string}} parts
 * @returns {string} markdown sentence
 */
function leadSentence({ pgTables, views, absent, sqlite, dbName }) {
  if (!pgTables.length && !views.length && !absent.length) {
    return `This package keeps its data in SQLite (${plural(sqlite.length, 'table')}); it declares no Postgres tables.`;
  }
  const counts = [plural(pgTables.length, 'table'), views.length ? plural(views.length, 'view') : null].filter(Boolean).join(' and ');
  const extra = [absent.length ? `${absent.length} declared but not present` : null, sqlite.length ? plural(sqlite.length, 'SQLite table') : null].filter(Boolean);
  return `Postgres database \`${dbName}\`, schema \`public\` - shared with the platform and every other installed package. `
    + `${counts} in the reference database${extra.length ? `, ${extra.join(', ')}` : ''}.`;
}

/**
 * @description Render one package's SCHEMA.md, or null when the package owns no tables.
 * @param {object} pkg - {repo, dir, manifest, view}
 * @param {object} model - buildModel output
 * @param {Map<string, string>} repoPages - table -> package dir, same repo only
 * @param {string} dbName - platform database name
 * @returns {string|null} markdown
 */
function renderPackagePage(pkg, model, repoPages, dbName) {
  const pgTables = [...pkg.view.live.values()].flat().sort((a, b) => a.name.localeCompare(b.name));
  const { absent, sqlite } = pkg.view;
  const views = [...pkg.view.views.values()].flat().sort((a, b) => a.name.localeCompare(b.name));
  if (!pgTables.length && !absent.length && !sqlite.length && !views.length) return null;
  const isMine = (s) => s.repo === pkg.repo && s.pkg === pkg.dir;
  const ctx = {
    linkFor: packageLinker(pkg, model, repoPages),
    definersOf: (t) => definersFor(model.byTable, t, (s) => isMine(s) && s.kind === 'table' && s.engine === 'postgres'),
    noteFor: packageNoteFor(model, pkg),
  };
  const viewDefiners = (v) => definersFor(model.byTable, v, (s) => isMine(s) && s.kind === 'view');
  const title = pkg.manifest.displayName ? `${pkg.manifest.displayName} (\`${pkg.dir}\`)` : `\`${pkg.dir}\``;
  const lines = [GENERATED_BANNER, '', `# ${title} - database schema`, '', leadSentence({ pgTables, views, absent, sqlite, dbName }), '',
    ...creationLines(pkg, model), '',
    `Platform conventions (ownership, RLS, how migrations run): [core data model](${CORE_DOCS_URL}/README.md).`, '',
    ...tablesBody({ tables: pgTables, views, absent, ctx, viewDefiners })];
  if (sqlite.length) lines.push(...sqliteSection(sqlite, isMine));
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * @description SQLite section for a package page.
 * @param {object[]} tables - parsed sqlite records
 * @param {(s: object) => boolean} isMine - owner filter
 * @returns {string[]} markdown lines
 */
function sqliteSection(tables, isMine) {
  const files = [...new Set(tables.flatMap((t) => t.sites.filter(isMine).map((s) => s.file)))].sort();
  const plain = { linkFor: (t, c) => `\`${t}${c ? `.${c}` : ''}\``, definersOf: (name) => files.filter((f) => tables.find((t) => t.name === name)?.sites.some((s) => s.file === f)), noteFor: null };
  const out = ['## SQLite', '', `Declared in ${files.map((f) => `\`${f}\``).join(', ')}. There is no catalog to read, so columns are parsed from each \`CREATE TABLE\` as written.`, '',
    KEY_LEGEND, '', mermaidDiagram(tables), ''];
  for (const t of tables) out.push(tableSection(t, plain), '');
  return out;
}

/**
 * @description Render the store-root SCHEMAS.md index.
 * @param {Array<{dir: string, manifest: object, view: object, hasPage: boolean}>} pkgs - store packages
 * @returns {string} markdown
 */
function renderStoreIndex(pkgs) {
  const withTables = pkgs.filter((p) => p.hasPage);
  const rows = ['| Package | Postgres tables | Views | Declared, not present | SQLite tables | Schema |', '|---|---|---|---|---|---|'];
  for (const p of withTables) {
    const live = [...p.view.live.values()].flat().length;
    rows.push(`| \`${p.dir}\` | ${live} | ${[...p.view.views.values()].flat().length || ''} | ${p.view.absent.length || ''} | ${p.view.sqlite.length || ''} | [SCHEMA.md](${p.dir}/SCHEMA.md) |`);
  }
  const lines = [GENERATED_BANNER, '', '# Application database schemas', '',
    'Every package that owns tables carries a `SCHEMA.md` beside its `oshal-app.yaml`: an entity-relationship diagram, '
      + 'every column, and the RLS rule that scopes each row. Package tables live in the platform\'s Postgres database '
      + `(schema \`public\`); the conventions they follow are in the [core data model](${CORE_DOCS_URL}/README.md).`, '',
    `${withTables.length} of ${pkgs.length} packages own tables.`, '', ...rows];
  return `${lines.join('\n')}\n`;
}

module.exports = { renderPackagePage, renderStoreIndex };
