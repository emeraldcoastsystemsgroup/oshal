/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Generate the source-backed core inventory and expose unassigned feature directories, skill contracts and ADRs instead of silently treating a dated catalog as complete.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const yaml = require('js-yaml');
const log = require('../any-bot/server/utils/logger').child({ module: 'core-feature-inventory' });
const ROOT = path.resolve(__dirname, '..');
const DATA = 'docs/architecture/core-feature-inventory.json';
const OUTPUT = 'docs/architecture/core-feature-inventory.md';
const CATEGORIES = {
  identity: 'Users, identities and tenancy', security: 'Authorization and security',
  execution: 'Tickets, orchestration and workflows', providers: 'Models and inference providers',
  harnesses: 'Agent harnesses and runtime adapters', tools: 'Tools, MCP and selectors',
  connectors: 'Connectors, accounts and actions', a2a: 'A2A and external agents',
  nodes: 'Remote nodes and devices', channels: 'Channels, notifications and schedules',
  monitoring: 'Monitoring, logging, traces and cost', data: 'Data, storage, search and artifacts',
  learning: 'Memory, personal learning and ambient evidence', profiles: 'Profiles and personalization',
  quality: 'Quality, evaluation and optimization', 'self-extension': 'Agent creation and governed extension',
  applications: 'Application installation and package contracts', ux: 'Cockpit and application UX',
  media: 'Voice, vision and media engines', engines: 'Retained shared and device engines',
  lifecycle: 'Configuration, deployment and data operations', governance: 'Engineering and diagnostic governance',
};
const CORE_STATES = ['wired', 'implemented', 'gated', 'partial', 'retired'];
const RUST_STATES = ['wired', 'implemented', 'partial', 'not-located', 'not-reviewed'];
const TIERS = ['platform', 'shared-engine', 'node', 'package-boundary', 'resident-application'];

/** @description Reject ambiguous arguments before scanning or writing repository files.
 * @param {string[]} args CLI arguments. @returns {object} Validated output/check options. */
function options(args) {
  const result = { check: false, rustRoot: null, help: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--check') result.check = true;
    else if (args[i] === '--help') result.help = true;
    else if (args[i] === '--rust-root' && args[i + 1]) result.rustRoot = path.resolve(args[++i]);
    else throw new Error('Unknown or incomplete inventory option; use --help');
  }
  return result;
}

/** @description Reject private or traversal paths even when the Rust checkout is unavailable in CI.
 * @param {string} file Repository-relative reference. @returns {void} Throws on noncanonical paths. */
function relativeReference(file) {
  if (typeof file !== 'string' || !/^[A-Za-z0-9_.@/-]+$/.test(file)
    || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Inventory source must be a canonical repository-relative path');
  }
}

/** @description Keep published references portable and prevent paths outside a checkout.
 * @param {string} root Checkout root. @param {string} file Repository-relative reference.
 * @returns {string} Existing confined file path. */
function reference(root, file) {
  relativeReference(file);
  const target = path.join(root, file);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`Missing inventory reference: ${file}`);
  const resolved = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  if (resolved.startsWith('..') || path.isAbsolute(resolved)) throw new Error(`Unconfined inventory reference: ${file}`);
  return target;
}

/** @description Refuse contradictory or unsupported row states before producing an as-built document.
 * @param {object} row Curated capability. @param {Set<string>} ids Seen identifiers.
 * @param {object} opts Validation options. @returns {void} Throws on invalid metadata. */
function validateRow(row, ids, opts) {
  if (!/^[A-Z][A-Z0-9]*-\d{2,3}$/.test(row.id) || ids.has(row.id)) throw new Error('Invalid or duplicate inventory ID');
  ids.add(row.id);
  if (!Object.hasOwn(CATEGORIES, row.category) || !TIERS.includes(row.tier)) throw new Error(`Invalid classification: ${row.id}`);
  if (!CORE_STATES.includes(row.core_state) || !RUST_STATES.includes(row.rust_state)) throw new Error(`Invalid state: ${row.id}`);
  for (const key of ['title', 'description', 'core_note', 'rust_note']) {
    if (typeof row[key] !== 'string' || !row[key].trim() || /[\r\n]/.test(row[key])) throw new Error(`Invalid ${key}: ${row.id}`);
  }
  for (const key of ['core_sources', 'core_routes', 'adrs', 'rust_sources', 'tests', 'user_capabilities']) {
    if (!Array.isArray(row[key]) || row[key].some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error(`Invalid ${key}: ${row.id}`);
    }
    if (new Set(row[key]).size !== row[key].length) throw new Error(`Duplicate ${key}: ${row.id}`);
  }
  if (!row.core_sources.length || !row.user_capabilities.length) throw new Error(`Unsubstantiated capability: ${row.id}`);
  for (const key of ['core_sources', 'adrs', 'tests']) row[key].forEach(file => reference(ROOT, file));
  row.rust_sources.forEach(relativeReference);
  if (opts.rustRoot) row.rust_sources.forEach(file => reference(opts.rustRoot, file));
}

/** @description Require stable source metadata and valid aliases rather than interpolating unchecked prose.
 * @param {object} data Parsed inventory. @param {object} opts Validation options.
 * @returns {void} Throws when the inventory cannot support a review snapshot. */
function validateInventory(data, opts) {
  if (data.schema_version !== 1 || !Array.isArray(data.features) || !data.features.length) throw new Error('Unsupported inventory schema');
  if (typeof data.review_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.review_date)
    || new Date(data.review_date).toISOString().slice(0, 10) !== data.review_date) throw new Error('Invalid review date');
  for (const key of ['core_revision', 'rust_revision']) {
    if (typeof data[key] !== 'string' || !/^[a-f0-9]{40}$/.test(data[key])) throw new Error(`Invalid ${key}`);
  }
  const ids = new Set();
  data.features.forEach(row => validateRow(row, ids, opts));
  if (!data.aliases || typeof data.aliases !== 'object' || Array.isArray(data.aliases)) throw new Error('Invalid capability aliases');
  for (const [alias, canonical] of Object.entries(data.aliases)) {
    if (!/^[A-Z][A-Z0-9]*-\d{2,3}$/.test(alias) || ids.has(alias) || !ids.has(canonical)) throw new Error('Invalid capability alias');
  }
  for (const [file, review] of Object.entries(data.adr_review || {})) {
    reference(ROOT, file);
    if (!file.startsWith('docs/adr/') || typeof review.classification !== 'string' || typeof review.reason !== 'string'
      || /[\r\n]/.test(review.classification + review.reason) || !Array.isArray(review.related_features)
      || review.related_features.some(id => !ids.has(id))) throw new Error('Invalid decision review');
  }
}

/** @description Extract declarations as data without executing the platform registry or booting services.
 * @param {ts.Node} node Literal registry expression. @returns {unknown} Plain declaration data. */
function literal(node) {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    const entries = node.properties.map(property => {
      if (!ts.isPropertyAssignment(property)) throw new Error('Kernel skill registry must contain literal properties');
      return [property.name.text, literal(property.initializer)];
    });
    return Object.fromEntries(entries);
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literal(node.expression);
  throw new Error('Kernel skill registry contains an unsupported expression');
}

/** @description Use the current registry array instead of copying historical skill counts from prose.
 * @returns {object[]} Declared kernel skills, including their guaranteed import modules. */
function skills() {
  const file = 'src/shared/kernel-skills/registry.ts';
  const tree = ts.createSourceFile(file, fs.readFileSync(reference(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
  let result;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'KERNEL_SKILLS') result = literal(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!Array.isArray(result) || !result.length) throw new Error('Kernel skill registry not found');
  return result;
}

/** @description Read declaration syntax without executing provider modules or loading credentials.
 * @param {string} file Declaration source. @param {string} name Constant name.
 * @returns {ts.Expression} Constant initializer. */
function declaration(file, name) {
  const tree = ts.createSourceFile(file, fs.readFileSync(reference(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) found = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!found) throw new Error(`Declaration not found: ${name}`);
  return found;
}

/** @description Project only requested literal properties rather than evaluating prices, endpoints or environment expressions.
 * @param {ts.ObjectLiteralExpression} node Declaration object. @param {string} key Desired field.
 * @returns {ts.Expression|undefined} Field expression. */
function property(node, key) {
  if (!ts.isObjectLiteralExpression(node)) throw new Error('Catalog entry must be an object literal');
  return node.properties.find(item => ts.isPropertyAssignment(item) && item.name.text === key)?.initializer;
}

/** @description Preserve only literal identity labels in the public declaration appendix.
 * @param {ts.Expression} node Identity/name expression. @returns {string} Literal value. */
function nameLiteral(node) {
  if (!node || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) throw new Error('Catalog identity must be literal');
  return node.text;
}

/** @description Count the declarations actually present, keeping compatibility maps separate from selectable providers.
 * @param {string} file Catalog source. @param {string} constant Declaration name.
 * @param {string} label Name field. @param {boolean} withModels Include literal model identities.
 * @returns {object[]} Names-only catalog projection. */
function namedCatalog(file, constant, label, withModels = false) {
  const node = declaration(file, constant);
  const entries = ts.isArrayLiteralExpression(node) ? node.elements.map(entry => ({ entry, key: null }))
    : ts.isObjectLiteralExpression(node) ? node.properties.map(item => {
      if (!ts.isPropertyAssignment(item)) throw new Error('Catalog map must contain literal assignments');
      return { entry: item.initializer, key: item.name.text };
    }) : [];
  if (!entries.length) throw new Error(`Unsupported catalog declaration: ${constant}`);
  const rows = entries.map(({ entry, key }) => {
    const identifier = property(entry, 'id');
    const row = { id: identifier ? nameLiteral(identifier) : key, name: nameLiteral(property(entry, label)), source: file, models: [] };
    if (!row.id) throw new Error('Catalog entry has no identity');
    if (withModels) {
      const models = property(entry, 'models');
      if (!models || !ts.isArrayLiteralExpression(models)) throw new Error('Provider model catalog must be a literal array');
      row.models = models.elements.map(model => {
        if (!ts.isCallExpression(model) || model.expression.getText() !== 'm') throw new Error('Unsupported model declaration');
        return { id: nameLiteral(model.arguments[0]), name: nameLiteral(model.arguments[1]) };
      });
    }
    return row;
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error(`Duplicate catalog identities: ${constant}`);
  return rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** @description Read connector resource names without interpolation, application imports or network requests.
 * @returns {object[]} Current names-only connector specifications. */
function connectorSpecs() {
  const dir = 'swarm-apps/connectors';
  return fs.readdirSync(path.join(ROOT, dir)).filter(file => /\.ya?ml$/.test(file)).sort().map(file => {
    const source = `${dir}/${file}`;
    const spec = yaml.load(fs.readFileSync(reference(ROOT, source), 'utf8'), { schema: yaml.FAILSAFE_SCHEMA });
    if (typeof spec?.provider !== 'string' || typeof spec.displayName !== 'string' || !Array.isArray(spec.resources)) throw new Error(`Invalid connector declaration: ${source}`);
    const resources = spec.resources.map(item => {
      if (typeof item.name !== 'string') throw new Error(`Invalid connector resource name: ${source}`);
      return item.name;
    });
    return { id: spec.provider, name: spec.displayName, source, resources };
  });
}

/** @description Escape row text so route syntax cannot corrupt Markdown tables.
 * @param {unknown} value Cell value. @returns {string} Single-line escaped text. */
function cell(value) { return String(value).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' '); }

/** @description Link an existing core source relative to this generated topic document.
 * @param {string} file Core repository-relative file. @returns {string} Portable Markdown link. */
function link(file) { return `[${file}](../../${file})`; }

/** @description Preserve IDs as navigation links across coverage appendices.
 * @param {string[]} ids Capability IDs. @returns {string} Linked IDs or an explicit unassigned state. */
function idLinks(ids) { return ids.length ? ids.map(id => `[${id}](#${id.toLowerCase()})`).join(', ') : '**unassigned**'; }

/** @description Read directory names deterministically so source additions produce visible inventory drift.
 * @param {string} dir Core directory. @returns {string[]} Current immediate subdirectories. */
function directories(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort();
}

/** @description Cover every source slice even when its capabilities have not yet been assigned a row.
 * @param {object[]} rows Curated capabilities. @param {string} dir Source layer.
 * @returns {object[]} Directory coverage records. */
function coverage(rows, dir) {
  return directories(dir).map(name => ({ name, ids: rows.filter(row => row.core_sources.some(file => file.startsWith(`${dir}/${name}/`))).map(row => row.id) }));
}

/** @description Keep the entire numbered ADR corpus visible without adopting draft retirement classifications.
 * @param {object[]} rows Curated capabilities. @returns {object[]} ADR coverage records. */
function decisions(rows, review) {
  return fs.readdirSync(path.join(ROOT, 'docs/adr')).filter(file => /^\d{3}[a-z]?-.*\.md$/.test(file)).sort().map(file => {
    const ref = `docs/adr/${file}`;
    return { file: ref, ids: rows.filter(row => row.adrs.includes(ref)).map(row => row.id), review: review[ref] };
  });
}

/** @description Count classifications from rows rather than creating a second mutable fact source.
 * @param {object[]} rows Capability records. @param {string} key Classification key.
 * @returns {string} Count summary. */
function counts(rows, key) {
  const found = rows.reduce((result, row) => { result[row[key]] = (result[row[key]] || 0) + 1; return result; }, {});
  return Object.entries(found).sort().map(([name, count]) => `${name}: ${count}`).join('; ');
}

/** @description Define implementation evidence accurately before readers see the capability totals.
 * @param {object} data Inventory and reviewed source metadata. @param {object} scan Measured coverage.
 * @returns {string[]} Introductory document lines. */
function introduction(data, scan) {
  const assigned = scan.features.filter(item => item.ids.length).length;
  return ['<!-- GENERATED by scripts/core-feature-inventory.js; edit core-feature-inventory.json. -->',
    '# Current core feature inventory', '',
    `Source review: **${data.review_date}**. Core baseline: \`${data.core_revision}\`; Rust baseline: \`${data.rust_revision}\`.`, '',
    'This is the existing core capability inventory. Rust notes describe inspected implementation sources, not the draft Rust specification or a live parity certificate. Both repositories can change during rollout; these baseline revisions identify the review window, not a pinned running binary.', '',
    `**${data.features.length} capability records**, **${assigned}/${scan.features.length} feature directories referenced**, **${scan.skills.length} declared kernel skills**, **${scan.adrs.length} numbered ADR files**. Counts are generated from source and curated records. A referenced directory is coverage of that subsystem, not proof that every function or user journey has passed.`, '',
    `Core classifications: ${counts(data.features, 'core_state')}.`, '',
    'Evidence states: **wired** = a caller/boot/package path uses the implementation; **implemented** = a concrete exported implementation exists; **gated** = configuration, consent, credentials or activation controls availability; **partial** = the named contract is incomplete or narrower; **retired** = compatibility remains but deliberately refuses execution. Existing test references are acceptance entry points; they were not rerun as part of this source inventory.', '',
    'Rust **not-located** means the equivalent was not found in the bounded inspected sources; **not-reviewed** means no individual mapping was attempted. Neither means proven absence. A Rust **wired** entry is not a full equivalence verdict.', '',
    'Boundaries: **platform** is the control plane; **shared-engine** is reusable package-facing functionality retained in core; **node** is worker/device execution; **package-boundary** is hosting and SDK behavior; **resident-application** is an application deliberately retained in this repository. An application screen or a catalog registration does not by itself establish its backend.', '',
    'The Rust builder subsequently reported remediation of the preliminary RK findings. That report is separate from this feature inventory and requires independent deployed-build revalidation; its certification language is not adopted here.', '',
    '## How the provider, harness and tool contracts fit', '',
    '- **Inference/model provider:** `LLMService` and provider resolution select the model, credentials and completion port (MODEL records).',
    '- **Agent harness:** `HarnessAdapter`, `HarnessTask` and `HarnessResult` select an agent runtime and execution policy (HARNESS records).',
    '- **Tools/connectors:** tool registry, switches, selectors and execution bridges control callable operations; connector adapters supply scoped provider access (TOOL/CONN records).',
    '- Persona composition, layered bot brains and capability-provider selection are additional contracts. “Layer” also names FSD imports and prompt sections; these are not interchangeable three-layer APIs. See [the architecture layer glossary](./README.md#layer-means-five-different-things-in-this-codebase).', '',
    '## Conversion and import capabilities', '',
    '| Input → resulting contract | Record |', '|---|---|',
    '| OpenAPI → connector resources and translated tools | [CONN-03](#conn-03) |',
    '| n8n JSON → reviewable native workflow draft | [EXEC-07](#exec-07) |',
    '| Agent-Skills SKILL.md → audited persona, manifest and reference artifacts | [BUILD-02](#build-02) |',
    '| Office documents ↔ supported content outlines and themed documents; exotic formatting can be lost | [MEDIA-06](#media-06) |',
    '| Supported documents → extracted text for ingestion | [DATA-10](#data-10) |',
    '| Print input → swarm task or knowledge intake | [NODE-06](#node-06) |',
    '| Rust package importer/converter → generated host artifacts; original-handler behavior requires independent acceptance | [APP-04 Rust snapshot](#app-04) |', '',
    '## Core contracts requiring completion', '',
    '| Record | Current source limitation |', '|---|---|',
    ...data.features.filter(row => row.core_state === 'partial').map(row => `| [${row.id}: ${cell(row.title)}](#${row.id.toLowerCase()}) | ${cell(row.core_note)} |`), '',
    '## Capability groups', '', '| Group | Records |', '|---|---:|',
    ...Object.entries(CATEGORIES).filter(([key]) => data.features.some(row => row.category === key)).map(([key, title]) => `| [${title}](#${key}) | ${data.features.filter(row => row.category === key).length} |`), '',
  ];
}

/** @description Render one capability with evidence, availability limits and its independent Rust mapping.
 * @param {object} row Capability record. @returns {string[]} Detailed row lines. */
function detail(row) {
  const lines = [`<a id="${row.id.toLowerCase()}"></a>`, `### ${row.id} — ${row.title}`, '',
    `${row.description} **Core: ${row.core_state}; boundary: ${row.tier}.** ${row.core_note}`, '',
    `User operations: ${row.user_capabilities.map(cell).join('; ')}.`, '',
    `Core evidence: ${row.core_sources.map(link).join(', ')}.`, '',
    `Rust: **${row.rust_state}**. ${row.rust_note}${row.rust_sources.length ? ` Sources in \`oshal-kernel\`: ${row.rust_sources.map(file => `\`${file}\``).join(', ')}.` : ''}`, '',
  ];
  if (row.core_routes.length) lines.push(`Core route references: ${row.core_routes.map(route => `\`${route}\``).join(', ')}.`, '');
  if (row.adrs.length) lines.push(`Decisions: ${row.adrs.map(link).join(', ')}.`, '');
  if (row.tests.length) lines.push(`Existing acceptance sources: ${row.tests.map(link).join(', ')}.`, '');
  return lines;
}

/** @description Separate a scanning overview from detailed source records for fast operator reading.
 * @param {object[]} rows Curated capabilities. @returns {string[]} Grouped capability tables and evidence. */
function groups(rows) {
  const lines = [];
  for (const [key, title] of Object.entries(CATEGORIES)) {
    const selected = rows.filter(row => row.category === key);
    if (!selected.length) continue;
    lines.push(`<a id="${key}"></a>`, `## ${title}`, '', '| Capability | Core | Boundary | Rust snapshot |', '|---|---|---|---|');
    selected.forEach(row => lines.push(`| [${row.id}: ${cell(row.title)}](#${row.id.toLowerCase()}) | ${row.core_state} | ${row.tier} | ${row.rust_state} |`));
    lines.push('');
    selected.forEach(row => lines.push(...detail(row)));
  }
  return lines;
}

/** @description Expose guaranteed shared imports and baseline application declarations without booting them.
 * @param {object[]} declared Registry declarations. @returns {string[]} Contract appendix. */
function contractAppendix(declared) {
  const lines = ['## Package-facing kernel skills', '',
    `Generated from ${link('src/shared/kernel-skills/registry.ts')}; build anchor ${link('src/app/composition/kernel-skills.ts')}. Declaring a skill guarantees a compatible import, not a configured provider or authority grant.`, '',
    '| Skill | Title | Supported imports |', '|---|---|---|'];
  declared.forEach(skill => lines.push(`| \`${skill.id}\` | ${cell(skill.title)} | ${skill.modules.map(module => `\`${module.specifier}\``).join('<br>')} |`));
  const manifests = fs.readdirSync(path.join(ROOT, 'swarm-apps')).filter(file => /\.ya?ml$/.test(file)).sort();
  lines.push('', '## Core-resident manifest declarations', '',
    `There are **${manifests.length}** baseline YAML declarations under \`swarm-apps/\`. This list is source registration, not a live bot or installed-package health count.`, '',
    ...manifests.map(file => `- ${link(`swarm-apps/${file}`)}`), '');
  return lines;
}

/** @description Show every declared provider/spec while avoiding claims about configured accounts or vendor model availability.
 * @returns {string[]} Names and resources appendix generated from current source catalogs. */
function catalogAppendix() {
  const providers = namedCatalog('src/features/llm-provider/services/provider-definitions.ts', 'PROVIDER_DEFINITIONS', 'displayName', true);
  const compatibility = namedCatalog('src/features/llm-provider/services/provider-catalog.ts', 'PROVIDER_CATALOG', 'name');
  const accounts = namedCatalog('src/app/routes/connector-provider-registry.ts', 'PROVIDERS', 'label');
  const specs = connectorSpecs();
  const lines = ['## Declared provider and connector names', '',
    'These overlapping catalogs serve different contracts and must not be summed as connected services. Literal declaration names are read without executing catalog modules or resolving environment credentials. They do not establish configured accounts, current upstream model availability, successful connectivity or equivalent executable behavior.', '',
    `### Selectable model definitions (${providers.length} providers, ${providers.reduce((sum, row) => sum + row.models.length, 0)} model declarations)`, '',
    `Source: ${link(providers[0].source)}.`, '',
    '| Provider ID | Label | Declared model IDs |', '|---|---|---|'];
  providers.forEach(row => lines.push(`| \`${cell(row.id)}\` | ${cell(row.name)} | ${row.models.map(model => `\`${cell(model.id)}\``).join(', ')} |`));
  for (const [title, rows] of [['Cline compatibility map', compatibility], ['Connector account-provider registry', accounts]]) {
    lines.push('', `### ${title} (${rows.length} entries)`, '', `Source: ${link(rows[0].source)}.`, '', '| ID | Label |', '|---|---|');
    rows.forEach(row => lines.push(`| \`${cell(row.id)}\` | ${cell(row.name)} |`));
  }
  lines.push('', `### Connector resource specifications (${specs.length} specs, ${specs.reduce((sum, row) => sum + row.resources.length, 0)} declared resources)`, '',
    '| Spec | Label | Declared resource names |', '|---|---|---|');
  specs.forEach(row => lines.push(`| [${cell(row.id)}](../../${row.source}) | ${cell(row.name)} | ${row.resources.map(cell).join(', ')} |`));
  lines.push('');
  return lines;
}

/** @description Surface unassigned directories rather than allowing totals to hide new or omitted slices.
 * @param {object} scan Source coverage. @returns {string[]} Feature/shared coverage tables. */
function coverageAppendix(scan) {
  const lines = ['## Source coverage audit', '',
    'Every current immediate directory is listed. “Unassigned” requires an explicit review; some shared helpers support features through callers rather than being standalone capabilities. A directory assignment proves a source reference, not exhaustive implementation coverage.', ''];
  for (const [dir, entries] of [['src/features', scan.features], ['src/shared', scan.shared], ['packages', scan.packages]]) {
    lines.push(`### ${dir}`, '', '| Source directory | Capability records |', '|---|---|');
    entries.forEach(item => lines.push(`| \`${dir}/${item.name}\` | ${idLinks(item.ids)} |`));
    lines.push('');
  }
  return lines;
}

/** @description Preserve full ADR visibility even where an application-specific decision is outside this review.
 * @param {object[]} adrs ADR records. @returns {string[]} Decision coverage appendix. */
function adrAppendix(adrs) {
  return ['## Current ADR coverage', '',
    'All numbered ADR files are listed by exact filename, preserving duplicate numbers and suffix variants. Assignments mean a feature cites that decision; they are not a claim that all of its requirements are met. The initial unassigned set received a separate bounded review: classifications distinguish already-covered core, package domains, proposals, governance, superseded history and numerical reference implementations. Related records indicate capability coverage without pretending that a missing citation is an implementation omission.', '',
    'The September clean-kernel import map is a dated draft. Its proposed “superseded” labels do not retire current features, and its maximum ADR number does not bound this inventory.', '',
    '| ADR file | Cited capability records | Additional bounded classification |', '|---|---|---|',
    ...adrs.map(adr => `| ${link(adr.file)} | ${idLinks(adr.ids)} | ${adr.review ? `${cell(adr.review.classification)}: ${cell(adr.review.reason)}${adr.review.related_features.length ? ` Related: ${idLinks(adr.review.related_features)}.` : ''}` : 'See cited capability boundaries; no separate whole-decision classification.'} |`), '',
  ];
}

/** @description Make consolidated records discoverable without counting the same capability twice.
 * @param {object} aliases Superseded fragment IDs mapped to canonical capability records.
 * @returns {string[]} Alias appendix. */
function aliasAppendix(aliases) {
  return ['## Consolidated record aliases', '', '| Fragment ID | Canonical capability |', '|---|---|',
    ...Object.entries(aliases).map(([alias, canonical]) => `| ${alias} | ${idLinks([canonical])} |`), ''];
}

/** @description Make regeneration and the deliberate live-verification boundary reproducible.
 * @returns {string[]} Maintenance and verification instructions. */
function maintenance() {
  return ['## Maintenance and acceptance', '',
    'Edit [core-feature-inventory.json](./core-feature-inventory.json), then regenerate. Keep each user capability tied to concrete implementation/caller sources and mark configuration or rollout gates. When changing a source baseline, reassess its claims; changing a revision string alone is not verification.', '',
    '```sh', 'node scripts/core-feature-inventory.js', 'node scripts/core-feature-inventory.js --check',
    'node scripts/core-feature-inventory.js --check --rust-root ../../oshal-kernel', 'node scripts/docs-link-check.js', '```', '',
    'The generator validates core source, ADR and test file references, row IDs/states, current skill declarations and source/ADR coverage, and checks generated Markdown determinism. The optional Rust root validates the cited Rust paths without requiring a sibling repository in CI. It executes no application, provider request, migration or database mutation.', '',
    'A full replacement verdict still requires authorized browser journeys, real execution, dependency/composite-role provisioning, result/accounting lineage and preserved ownership/data semantics on an identified deployed build. Use the existing test references as a starting acceptance matrix; this document supplies inventory coverage rather than that verdict.', '',
  ];
}

/** @description Generate only the claimed artifact, logging operation outcome through the shared JSON logger.
 * @returns {void} Updates Markdown or throws when --check finds drift. */
function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('Usage: node scripts/core-feature-inventory.js [--check] [--rust-root <checkout>]\n');
    return;
  }
  const started = Date.now();
  log.info({ check: opts.check, validateRust: !!opts.rustRoot }, 'Inventory operation started');
  const data = JSON.parse(fs.readFileSync(reference(ROOT, DATA), 'utf8'));
  validateInventory(data, opts);
  const scan = { features: coverage(data.features, 'src/features'), shared: coverage(data.features, 'src/shared'), packages: coverage(data.features, 'packages'), skills: skills(), adrs: decisions(data.features, data.adr_review || {}) };
  const markdown = [...introduction(data, scan), ...groups(data.features), ...contractAppendix(scan.skills), ...catalogAppendix(), ...coverageAppendix(scan), ...adrAppendix(scan.adrs), ...aliasAppendix(data.aliases), ...maintenance()].join('\n');
  const output = path.join(ROOT, OUTPUT);
  const previous = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : null;
  if (opts.check && previous !== markdown) throw new Error('Generated core inventory is stale; regenerate and review the diff');
  if (!opts.check && previous !== markdown) fs.writeFileSync(output, markdown);
  log.info({ records: data.features.length, features: scan.features.length, skills: scan.skills.length, adrs: scan.adrs.length, durationMs: Date.now() - started }, 'Inventory operation completed');
}

try { main(); } catch (err) {
  log.error({ err }, 'Inventory operation failed');
  process.exitCode = 1;
}
