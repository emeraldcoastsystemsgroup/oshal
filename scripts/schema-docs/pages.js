/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Page composition for the schema docs: core domain pages, the TimescaleDB page, the SQLite page, the README's generated blocks (inventory, domain index + domain map), one SCHEMA.md per package and the store-root SCHEMAS.md index. Cross-page links resolve to the page that documents the target table; a page never names a package from a more private repo.
 */

'use strict';

const { CORE_DOMAINS, OTHER_DOMAIN, domainFor } = require('./domains');
const { GENERATED_BANNER, mermaidDiagram, tableSection, viewSection, cell, plural } = require('./render');
const { summarizeRowAccess } = require('./row-access');
const { definersFor, coOwners } = require('./model');

const CORE_DOCS_URL = 'https://github.com/emeraldcoastsystemsgroup/oshal/blob/main/docs/architecture/data-model';

const KEY_LEGEND = 'The diagram shows key columns only: primary keys (PK), foreign keys (FK), single-column '
  + 'unique keys (UK) and the column an RLS policy scopes rows by ("owner"). A box with no columns is a table '
  + 'documented on another page. Every column is listed under Tables.';

const ABSENT_NOTE = 'These tables have a `CREATE TABLE` in source but are not in the reference database. '
  + 'Columns are parsed from the statement as written; later `ALTER TABLE` changes are not applied.';

/**
 * @description Core Postgres tables grouped onto domain pages (in rule order, "Other" last).
 * @param {object} model - buildModel output
 * @param {string} dbName - the platform database name
 * @returns {Array<{domain: object, tables: object[], absent: object[]}>} non-empty groups
 */
function coreDomainGroups(model, dbName) {
  const groups = new Map([...CORE_DOMAINS, OTHER_DOMAIN].map((d) => [d.slug, { domain: d, tables: [], views: [], absent: [] }]));
  for (const t of model.core.live.get(dbName) || []) groups.get(domainFor(t.name).slug).tables.push(t);
  for (const v of model.core.views.get(dbName) || []) groups.get(domainFor(v.name).slug).views.push(v);
  for (const t of model.core.absent) groups.get(domainFor(t.name).slug).absent.push(t);
  return [...groups.values()].filter((g) => g.tables.length || g.views.length || g.absent.length);
}

/**
 * @description Link resolver for core pages: core tables link to their domain page anchor.
 * @param {Map<string, string>} pageOf - table -> page file name
 * @returns {function(string, string): string} (table, column) -> markdown
 */
function coreLinker(pageOf) {
  return (table, column) => {
    const label = `\`${table}${column ? `.${column}` : ''}\``;
    return pageOf.has(table) ? `[${label}](${pageOf.get(table)}#${table})` : label;
  };
}

/**
 * @description Note naming the store packages that also declare a core table.
 * @param {object} model - buildModel output
 * @returns {function(string): string|null} table -> note
 */
function coreNoteFor(model) {
  return (table) => {
    const others = coOwners(model.byTable, table, { repo: 'core', pkg: null }).filter((o) => o.repo === 'store');
    return others.length ? `Also declared by store package ${others.map((o) => `\`${o.pkg}\``).join(', ')}.` : null;
  };
}

/**
 * @description Render a page body: diagram, table sections, views, and an absent-tables section.
 * @param {{tables: object[], views?: object[], absent: object[], ctx: object, viewDefiners?: function(string): string[]}} parts
 * @returns {string[]} markdown lines
 */
function tablesBody({ tables, views = [], absent, ctx, viewDefiners = () => [] }) {
  const out = [];
  if (tables.length) {
    out.push(KEY_LEGEND, '', '## Diagram', '', mermaidDiagram(tables), '', '## Tables', '');
    for (const t of tables) out.push(tableSection(t, ctx), '');
  }
  if (views.length) {
    out.push('## Views', '');
    for (const v of views) out.push(viewSection(v, viewDefiners(v.name)), '');
  }
  if (absent.length) {
    out.push('## Declared in source, not present in the reference database', '', ABSENT_NOTE, '');
    for (const t of absent) out.push(tableSection(t, ctx), '');
  }
  return out;
}

/**
 * @description Render every core domain page.
 * @param {object} model - buildModel output
 * @param {string} dbName - platform database name
 * @returns {Array<{file: string, text: string, group: object}>} pages
 */
function renderCorePages(model, dbName) {
  const groups = coreDomainGroups(model, dbName);
  const pageOf = new Map();
  for (const g of groups) for (const t of [...g.tables, ...g.views, ...g.absent]) pageOf.set(t.name, `${g.domain.slug}.md`);
  const ctx = {
    linkFor: coreLinker(pageOf),
    definersOf: (t) => definersFor(model.byTable, t, (s) => s.repo === 'core' && s.kind === 'table' && s.engine === 'postgres'),
    noteFor: coreNoteFor(model),
  };
  const viewDefiners = (v) => definersFor(model.byTable, v, (s) => s.repo === 'core' && s.kind === 'view');
  return groups.map((g) => {
    const lines = [GENERATED_BANNER, '', `# ${g.domain.title}`, '',
      `[Data model index](README.md) · database \`${dbName}\` · schema \`public\` · ${plural(g.tables.length, 'table')}`
        + (g.views.length ? `, ${plural(g.views.length, 'view')}` : '')
        + (g.absent.length ? ` (+${g.absent.length} declared, not present)` : ''), '',
      g.domain.blurb, '', ...tablesBody({ tables: g.tables, views: g.views, absent: g.absent, ctx, viewDefiners })];
    return { file: `${g.domain.slug}.md`, text: `${lines.join('\n').trimEnd()}\n`, group: g, pageOf };
  });
}

/**
 * @description Render a single-database page (TimescaleDB) or the SQLite page.
 * @param {{title: string, subtitle: string, intro: string, tables: object[], views?: object[], ctx: object, viewDefiners?: function}} p
 * @returns {string} markdown
 */
function renderSimplePage({ title, subtitle, intro, tables, views = [], ctx, viewDefiners }) {
  const lines = [GENERATED_BANNER, '', `# ${title}`, '', subtitle, '', intro, '', ...tablesBody({ tables, views, absent: [], ctx, viewDefiners })];
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * @description Render the SQLite page: one section per source file, since each file opens its
 * own database and no FK crosses files.
 * @param {object[]} tables - parsed sqlite table records (with `sites`)
 * @param {function(object): string[]} filesOf - table -> the definer files this page may show
 * @returns {string} markdown
 */
function renderSqlitePage(tables, filesOf) {
  const byFile = new Map();
  for (const t of tables) {
    const file = filesOf(t)[0];
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(t);
  }
  const plain = { linkFor: (t, c) => `\`${t}${c ? `.${c}` : ''}\``, definersOf: () => [], noteFor: null };
  const lines = [GENERATED_BANNER, '', '# SQLite stores (core)', '', '[Data model index](README.md)', '',
    'Each file below opens its own SQLite database, so relationships never cross files. There is no catalog to read, '
      + 'so columns are parsed from each `CREATE TABLE` as written; later `ALTER TABLE` changes are not applied.', ''];
  for (const [file, list] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## \`${file}\``, '', mermaidDiagram(list), '');
    for (const t of list) lines.push(tableSection(t, plain), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * @description Count FKs between domain pages for the README's domain map.
 * @param {Array<object>} pages - renderCorePages output
 * @returns {Map<string, number>} "from|to" slug pair -> FK count
 */
function domainEdges(pages) {
  const slugOf = pages[0]?.pageOf ? new Map([...pages[0].pageOf].map(([t, f]) => [t, f.replace(/\.md$/, '')])) : new Map();
  const edges = new Map();
  for (const p of pages) {
    for (const t of p.group.tables) {
      for (const fk of t.foreignKeys) {
        const to = slugOf.get(fk.refTable);
        if (!to || to === p.group.domain.slug) continue;
        const key = `${p.group.domain.slug}|${to}`;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
  }
  return edges;
}

/**
 * @description The README "domains" block: index table + a domain-level map of FK references.
 * @param {Array<object>} pages - renderCorePages output
 * @returns {string} markdown
 */
function renderDomainIndex(pages) {
  const rows = ['| Domain | Tables | RLS forced | What it holds |', '|---|---|---|---|'];
  const nodes = [];
  for (const p of pages) {
    const forced = p.group.tables.filter((t) => summarizeRowAccess(t).state === 'forced').length;
    const extra = p.group.absent.length ? ` (+${p.group.absent.length})` : '';
    rows.push(`| [${p.group.domain.title}](${p.file}) | ${p.group.tables.length}${extra} | ${forced} | ${cell(p.group.domain.blurb)} |`);
    nodes.push(`  ${p.group.domain.slug.replace(/-/g, '_')}["${p.group.domain.title} (${p.group.tables.length})"]`);
  }
  const edges = [...domainEdges(pages)].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, n]) => { const [a, b] = k.split('|'); return `  ${a.replace(/-/g, '_')} -->|${n}| ${b.replace(/-/g, '_')}`; });
  return [...rows, '', '"(+N)" counts tables declared in source but not present in the reference database; each page lists them last. '
    + 'In the map below, arrows point from the domain holding a foreign key to the domain it references; the label is the number of foreign keys.', '',
    '```mermaid', 'flowchart LR', ...nodes, ...edges, '```'].join('\n');
}

module.exports = {
  renderCorePages, renderSimplePage, renderSqlitePage, renderDomainIndex, tablesBody, coreLinker, CORE_DOCS_URL, KEY_LEGEND, ABSENT_NOTE,
};
