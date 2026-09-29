#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The AI usage and requirements ledger (ADR-170 D10): one generated markdown table per repo from every manifest's `rating:` block (container memory low/high, per-feature unit/tier/generation/degrade), with the token and model columns reserved and reading "not yet measured" until the P0/P1 generators exist. `--check` fails on a stale ledger or an unrated manifest, so the label is never typed by hand and no application ships without one.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Drop the Version column: a version bump by any lane made the ledger stale and failed that lane's push, and the rating does not depend on version. Complete the declared-memory rule for the store: bot containers count per application (not additive), off-box services are not counted, and a package engine container with a declared mem_limit counts it as high and a quarter as low.
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
const TIERS = new Set(['T1', 'T2', 'T3', 'T4']);
const GENERATIONS = new Set(['none', 'local', 'hosted']);
const DEGRADES = new Set(['template', 'hosted', 'disable', 'reduced']);

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

/** @description Light shape check; the loader (swarm-app-rating.ts) is the authority, this only names what the ledger cannot render. */
function ratingProblems(rating, label) {
  const problems = [];
  if (rating === undefined) return problems;
  if (typeof rating !== 'object' || rating === null || Array.isArray(rating)) return [`${label}: rating must be a mapping`];
  const mem = rating.memoryMb;
  if (typeof mem !== 'object' || mem === null || !Number.isInteger(mem.low) || !Number.isInteger(mem.high) || mem.low > mem.high) {
    problems.push(`${label}: rating.memoryMb needs integer low <= high`);
  }
  if (!Array.isArray(rating.features)) problems.push(`${label}: rating.features must be a list`);
  else rating.features.forEach((f, i) => {
    if (!f || typeof f.id !== 'string' || typeof f.unit !== 'string') problems.push(`${label}: rating.features[${i}] needs id and unit`);
    else if (!TIERS.has(f.tier) || !GENERATIONS.has(f.generation) || !DEGRADES.has(f.degrade)) {
      problems.push(`${label}: rating.features[${i}] (${f.id}) has an unknown tier, generation or degrade`);
    }
  });
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
    'renders, T3 grounded reasoning over retrieved context, T4 long tool loops. A package with no model in the loop is T0.',
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { entries, problems } = collect(opts);
  const unrated = entries.filter((e) => !e.rating).map((e) => e.label);
  const output = render(entries, opts);
  if (opts.out) {
    fs.writeFileSync(opts.out, output, 'utf8');
    console.log(`ai-usage-ledger: wrote ${opts.out} (${entries.length} manifests, ${unrated.length} unrated)`);
  }
  if (opts.check) {
    const committed = fs.existsSync(opts.check) ? fs.readFileSync(opts.check, 'utf8') : '';
    if (normalise(committed) !== normalise(output)) {
      problems.push(`${opts.check} is stale; regenerate with --out ${opts.check}`);
    }
    if (unrated.length > 0 && !opts.allowUnrated) problems.push(`unrated manifest(s): ${unrated.join(', ')}`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`ai-usage-ledger: ${p}`);
    process.exit(1);
  }
  if (!opts.out && !opts.check) process.stdout.write(output);
  if (opts.check) console.log(`ai-usage-ledger: ${opts.check} is current (${entries.length} manifests, ${unrated.length} unrated)`);
}

main();
