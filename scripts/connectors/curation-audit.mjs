#!/usr/bin/env node
/**
 * Connector curation-coverage audit — measures the gap between "imported" and "shelf-ready".
 *
 * The market re-assessment flagged the connector catalog as raw imports (breadth without
 * curation): no categories, no plain-language use cases, ~half without verified icons, and no
 * setup-state guidance. You cannot curate what you do not measure, so this reports, over every
 * swarm-apps/connectors/*.yaml, how much shelf-ready metadata exists and derives each connector's
 * setup lane from its auth type. Read-only; prints a summary (and JSON with --json).
 *
 * Setup lanes (what a user needs to connect):
 *   no-auth                  auth.type = none
 *   bring-your-own-key       apiKey / basic / bearer: user pastes a key or token
 *   needs-operator-oauth-app oauth* — the operator must register an OAuth app first
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../swarm-apps/connectors');
const asJson = process.argv.includes('--json');

function setupLane(authType) {
  const t = String(authType || 'none').toLowerCase();
  if (t === 'none' || t === '') return 'no-auth';
  if (t.includes('oauth')) return 'needs-operator-oauth-app';
  return 'bring-your-own-key';
}

const files = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f));
const rows = [];
for (const file of files) {
  let spec;
  try {
    spec = yaml.load(readFileSync(path.join(dir, file), 'utf8')) || {};
  } catch {
    rows.push({ file, provider: file, parseError: true });
    continue;
  }
  const meta = spec.metadata || {};
  rows.push({
    file,
    provider: spec.provider || path.basename(file, path.extname(file)),
    iconVerified: meta.iconVerified === true,
    hasCategory: Boolean(spec.category || meta.category),
    hasDescription: Boolean(spec.description || meta.description),
    hasRiskLevel: Boolean(spec.riskLevel || meta.riskLevel),
    lane: setupLane(spec.auth?.type),
  });
}

const valid = rows.filter((r) => !r.parseError);
const pct = (n) => (valid.length ? Math.round((n / valid.length) * 100) : 0);
const count = (pred) => valid.filter(pred).length;

// "Shelf-ready" minimum = verified icon + category + plain-language description.
const shelfReady = (r) => r.iconVerified && r.hasCategory && r.hasDescription;
const fullyUncurated = valid.filter((r) => !r.iconVerified && !r.hasCategory && !r.hasDescription);

const lanes = valid.reduce((acc, r) => ((acc[r.lane] = (acc[r.lane] || 0) + 1), acc), {});

const summary = {
  total: rows.length,
  parseErrors: rows.length - valid.length,
  coverage: {
    iconVerified: { n: count((r) => r.iconVerified), pct: pct(count((r) => r.iconVerified)) },
    category: { n: count((r) => r.hasCategory), pct: pct(count((r) => r.hasCategory)) },
    description: { n: count((r) => r.hasDescription), pct: pct(count((r) => r.hasDescription)) },
    riskLevel: { n: count((r) => r.hasRiskLevel), pct: pct(count((r) => r.hasRiskLevel)) },
  },
  shelfReady: count(shelfReady),
  curationBacklog: valid.length - count(shelfReady),
  setupLanes: lanes,
  fullyUncuratedCount: fullyUncurated.length,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify({ summary, connectors: rows }, null, 2)}\n`);
} else {
  const c = summary.coverage;
  console.log(`Connector curation coverage — ${summary.total} connectors (${summary.parseErrors} parse errors)\n`);
  console.log(`  verified icon:      ${c.iconVerified.n}/${valid.length} (${c.iconVerified.pct}%)`);
  console.log(`  category:           ${c.category.n}/${valid.length} (${c.category.pct}%)`);
  console.log(`  plain description:  ${c.description.n}/${valid.length} (${c.description.pct}%)`);
  console.log(`  risk level:         ${c.riskLevel.n}/${valid.length} (${c.riskLevel.pct}%)`);
  console.log(`\n  shelf-ready (icon + category + description): ${summary.shelfReady}/${valid.length}`);
  console.log(`  curation backlog: ${summary.curationBacklog}`);
  console.log('\n  setup lanes (from auth):');
  for (const [lane, n] of Object.entries(lanes).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${lane.padEnd(26)} ${n}`);
  }
  console.log(`\n  fully uncurated (no icon, category, or description): ${fullyUncurated.length}`);
  console.log(`  e.g. ${fullyUncurated.slice(0, 12).map((r) => r.provider).join(', ')}`);
}
