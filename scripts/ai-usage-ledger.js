#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The AI usage and requirements ledger (ADR-170 D10): one generated markdown table per repo from every manifest's `rating:` block (container memory low/high, per-feature unit/tier/generation/degrade), with the token and model columns reserved and reading "not yet measured" until the P0/P1 generators exist. `--check` fails on a stale ledger or an unrated manifest, so the label is never typed by hand and no application ships without one.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Drop the Version column: a version bump by any lane made the ledger stale and failed that lane's push, and the rating does not depend on version. Complete the declared-memory rule for the store: bot containers count per application (not additive), off-box services are not counted, and a package engine container with a declared mem_limit counts it as high and a quarter as low.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Accept T0 with a generation backend, refuse it without one, and say so in the ledger header.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Match the loader's declaration boundary and refuse unknown measurement fields or invalid values before rendering or writing a ledger; keep unmeasured evidence explicit.
 */
/**
 * @description Generate or check the ledger for a core checkout (`swarm-apps/*.yaml`) or a store
 * checkout (`* /oshal-app.yaml`, one level deep).
 *
 *   node scripts/ai-usage-ledger.js --core <dir> --out docs/apps/ai-usage-ledger.md
 *   node scripts/ai-usage-ledger.js --store <dir> --out AI-USAGE-LEDGER.md
 *   node scripts/ai-usage-ledger.js --core <dir> --check docs/apps/ai-usage-ledger.md
 *
 * `--check` regenerates in memory and exits 1 when the committed file differs, when any manifest
 * has no `rating:` block (pass `--allow-unrated` during a store rollout), or when a block is
 * malformed. Output is deterministic: sorted by package name, no timestamps, no commit ids.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const NOT_MEASURED = 'not yet measured';
const NONE_RECORDED = 'none recorded';
const TIERS = new Set(['T0', 'T1', 'T2', 'T3', 'T4']);
const GENERATIONS = new Set(['none', 'local', 'hosted']);
const DEGRADES = new Set(['template', 'hosted', 'disable', 'reduced']);
const MEMORY_BASES = new Set(['declared', 'observed']);
const RATING_KEYS = new Set(['memoryMb', 'features']);
const MEMORY_KEYS = new Set(['low', 'high', 'basis']);
const FEATURE_KEYS = new Set(['id', 'unit', 'tier', 'generation', 'degrade', 'contextFloor', 'reducedEdition']);
const FEATURE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEMORY_MAX_MB = 1_048_576;

/** @description Parse `--flag value` pairs and bare flags. */
function parseArgs(argv) {
  const opts = { allowUnrated: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--allow-unrated') opts.allowUnrated = true;
    else if (arg === '--core' || arg === '--store' || arg === '--out' || arg === '--check' || arg === '--title') {
      opts[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.core && !opts.store) throw new Error('pass --core <dir> or --store <dir>');
  if (opts.core && opts.store) throw new Error('pass one of --core or --store, not both');
  return opts;
}

/** @description The manifests a ledger covers, sorted for deterministic output. */
function listManifests(opts) {
  if (opts.core) {
    const dir = path.join(opts.core, 'swarm-apps');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()
      .map((f) => ({ file: path.join(dir, f), label: `swarm-apps/${f}` }));
  }
  return fs.readdirSync(opts.store, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(opts.store, d.name, 'oshal-app.yaml')))
    .map((d) => d.name).sort()
    .map((name) => ({ file: path.join(opts.store, name, 'oshal-app.yaml'), label: `${name}/oshal-app.yaml` }));
}

/** @description YAML mappings only, matching the authoritative loader's declaration contract. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** @description Generated measurements have no manifest field; never silently discard invented evidence. */
function unknownFields(record, allowed, at) {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  return unknown.length ? [`${at} has unknown field(s): ${unknown.join(', ')}`] : [];
}

/** @description Match loader memory validation without loading a TypeScript runtime into this standalone CLI. */
function memoryProblems(value, at) {
  if (!isRecord(value)) return [`${at} must be a mapping`];
  const problems = unknownFields(value, MEMORY_KEYS, at);
  if (!isPositiveInteger(value.low) || !isPositiveInteger(value.high) || value.low > value.high) {
    problems.push(`${at} needs positive integer low <= high (MiB)`);
  }
  if (value.high > MEMORY_MAX_MB) problems.push(`${at}.high exceeds ${MEMORY_MAX_MB} MiB`);
  if (value.basis !== undefined && !MEMORY_BASES.has(value.basis)) problems.push(`${at}.basis must be declared or observed`);
  return problems;
}

/** @description Refuse malformed or invented feature declarations; parity is exercised against swarm-app-rating.ts. */
function featureProblems(value, at, seen) {
  if (!isRecord(value)) return [`${at} must be a mapping`];
  const problems = unknownFields(value, FEATURE_KEYS, at);
  if (typeof value.id !== 'string' || !FEATURE_ID.test(value.id)) problems.push(`${at}.id must be a kebab-case string`);
  else if (seen.has(value.id)) problems.push(`${at}.id is declared twice: ${value.id}`);
  else seen.add(value.id);
  if (typeof value.unit !== 'string' || !value.unit.trim()) problems.push(`${at}.unit must be non-empty text`);
  if (!TIERS.has(value.tier) || !GENERATIONS.has(value.generation) || !DEGRADES.has(value.degrade)) {
    problems.push(`${at} has an unknown tier, generation or degrade`);
  }
  if (value.tier === 'T0' && value.generation === 'none') problems.push(`${at} declares T0 with no generation backend`);
  if (value.contextFloor !== undefined && !isPositiveInteger(value.contextFloor)) problems.push(`${at}.contextFloor must be a positive integer`);
  if (value.reducedEdition !== undefined && (typeof value.reducedEdition !== 'string' || !value.reducedEdition.trim())) {
    problems.push(`${at}.reducedEdition must be non-empty text`);
  }
  if (value.degrade === 'reduced' && value.reducedEdition === undefined) problems.push(`${at} requires reducedEdition for degrade: reduced`);
  return problems;
}

/** @description Validate the declared rating before rendering; missing ratings remain a separate rollout check. */
function ratingProblems(rating, label) {
  if (rating === undefined) return [];
  if (!isRecord(rating)) return [`${label}: rating must be a mapping`];
  const problems = unknownFields(rating, RATING_KEYS, `${label}: rating`);
  problems.push(...memoryProblems(rating.memoryMb, `${label}: rating.memoryMb`));
  const seen = new Set();
  if (!Array.isArray(rating.features)) problems.push(`${label}: rating.features must be a list`);
  else rating.features.forEach((f, i) => problems.push(...featureProblems(f, `${label}: rating.features[${i}]`, seen)));
  return problems;
}

/** @description Read every manifest into a ledger entry. */
function collect(opts) {
  const entries = [];
  const problems = [];
  for (const { file, label } of listManifests(opts)) {
    const manifest = yaml.load(fs.readFileSync(file, 'utf8')) || {};
    problems.push(...ratingProblems(manifest.rating, label));
    entries.push({ name: manifest.name || label, displayName: manifest.displayName || '', rating: manifest.rating, label });
  }
  return { entries, problems };
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** @description One markdown row per feature, or one row saying the package declares no model-touching feature. */
function renderRows(entry) {
  const { rating } = entry;
  const mem = rating ? `${rating.memoryMb.low} / ${rating.memoryMb.high} (${rating.memoryMb.basis || 'declared'})` : 'unrated';
  const head = `| ${cell(entry.name)} | ${mem} |`;
  if (!rating) return [`${head} unrated | | | | | | |`];
  if (rating.features.length === 0) return [`${head} none (T0, no model in the loop) | | | | | | |`];
  return rating.features.map((f) => {
    const degrade = f.degrade === 'reduced' && f.reducedEdition ? `reduced: ${cell(f.reducedEdition)}` : f.degrade;
    const floor = f.contextFloor ? ` (context ≥ ${f.contextFloor})` : '';
    return `${head} ${cell(f.id)} | ${cell(f.unit)} | ${f.tier}${floor} | ${f.generation} | ${degrade} | ${NOT_MEASURED} | ${NONE_RECORDED} |`;
  });
}

/** @description The whole ledger as markdown. */
function render(entries, opts) {
  const rated = entries.filter((e) => e.rating).length;
  const unrated = entries.filter((e) => !e.rating).map((e) => e.name);
  const title = opts.title || (opts.core ? 'AI usage and requirements ledger — core' : 'AI usage and requirements ledger — store');
  const source = opts.core ? '`swarm-apps/*.yaml`' : '`*/oshal-app.yaml`';
  const runbook = opts.core
    ? '[the sizing runbook](../runbooks/docker-engine-memory-sizing.md)'
    : 'the core sizing runbook (`docs/runbooks/docker-engine-memory-sizing.md`)';
  const lines = [
    `# ${title}`,
    '',
    `Generated by \`scripts/ai-usage-ledger.js\` from every manifest's \`rating:\` block (${source}). Do not edit by hand:`,
    'the `--check` gate fails when this file is stale or a manifest has no rating. Field meaning: ADR-170 D2, D9, D10.',
    'Memory is container MiB the application needs on the swarm host, including any engine container it owns;',
    '`low` runs it, `high` is the ceiling to plan for. Each application counts every bot container it uses, even one',
    'another application shares, so the figures describe one application and do not add up across applications.',
    'Services on another machine (a GPU box, a desktop worker node) are not counted.',
    '',
    'Declared memory (basis `declared`) follows one rule until an observed run replaces it (basis `observed`):',
    `a bot-node container is 64 MiB low (${runbook} measures 43–50 MiB idle per worker bot) and 256 high;`,
    'an application with no bot container of its own is 32 low and 128 high (its load lands in the api process);',
    'a core engine container is its runbook idle rounded up to the next 32 MiB, times 4 for high; a package engine',
    'container with a declared `mem_limit` counts that limit as its high and a quarter of it as its low.',
    'These are declared ceilings, not measurements.',
    '',
    'Tier is the capability the feature asks of a model today (ADR-170 D1): T1 pick from a set, T2 a bounded plan code',
    'renders, T3 grounded reasoning over retrieved context, T4 long tool loops. T0 means no language model: a feature',
    'declares it only when a template prompt drives an image, audio or video model (generation local or hosted).',
    'A package with no model at all shows "none (T0, no model in the loop)".',
    `Tokens per unit and models verified read "${NOT_MEASURED}" / "${NONE_RECORDED}" until the P0 and P1 generators exist;`,
    'a number in those columns is never typed by hand.',
    '',
    `Coverage: ${entries.length} manifests, ${rated} rated, ${unrated.length} unrated.`,
    '',
    '| Package | Memory MiB low / high (basis) | Feature | Unit | Tier | Generation | Degrade | Tokens per unit | Models verified |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const entry of entries) lines.push(...renderRows(entry));
  if (unrated.length > 0) lines.push('', `Unrated: ${unrated.join(', ')}.`);
  return `${lines.join('\n')}\n`;
}

function normalise(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
}

/** @description Failed declarations/checks never authorize rendering or replacing output files. */
function refuseProblems(problems) {
  if (problems.length === 0) return;
  for (const p of problems) console.error(`ai-usage-ledger: ${p}`);
  process.exit(1);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { entries, problems } = collect(opts);
  refuseProblems(problems);
  const unrated = entries.filter((e) => !e.rating).map((e) => e.label);
  const output = render(entries, opts);
  if (opts.check) {
    const committed = fs.existsSync(opts.check) ? fs.readFileSync(opts.check, 'utf8') : '';
    if (normalise(committed) !== normalise(output)) {
      problems.push(`${opts.check} is stale; regenerate with --out ${opts.check}`);
    }
    if (unrated.length > 0 && !opts.allowUnrated) problems.push(`unrated manifest(s): ${unrated.join(', ')}`);
  }
  refuseProblems(problems);
  if (opts.out) {
    fs.writeFileSync(opts.out, output, 'utf8');
    console.log(`ai-usage-ledger: wrote ${opts.out} (${entries.length} manifests, ${unrated.length} unrated)`);
  }
  if (!opts.out && !opts.check) process.stdout.write(output);
  if (opts.check) console.log(`ai-usage-ledger: ${opts.check} is current (${entries.length} manifests, ${unrated.length} unrated)`);
}

main();
