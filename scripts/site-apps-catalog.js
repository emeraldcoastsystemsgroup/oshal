#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Generate the public site's app grid FROM swarm-apps/*.yaml so it can never drift. The site used to hand-list 12 cards while 37 apps were live — it under-sold the platform and violated "docs describe what works today". Publishes every ACTIVE app except an explicit PRIVATE_APPS list (internal tooling + the operator's business pipeline), and PRINTS both lists every run so what is about to go public is always auditable.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Drop the dead 'capture-crm' PRIVATE_APPS row: the app carved to the oshal-applications store (ADR-085 Wave 3), so no in-repo manifest reaches this generator anymore. federal-capture + gov-contracting rows follow with their own rips.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Drop the dead 'federal-capture' PRIVATE_APPS row with its rip (ADR-085 Wave 3, same reasoning). gov-contracting's row follows with its own rip.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Drop the dead 'gov-contracting' PRIVATE_APPS row with its rip (ADR-085 Wave 3) — the capture-family carve complete; no in-repo capture manifests remain.
 */

/**
 * Site app-catalog generator.
 *
 *   node scripts/site-apps-catalog.js            # rewrite the grid in site/oswarm.ai/index.html
 *   node scripts/site-apps-catalog.js --check    # exit 1 if the site is stale (CI / pre-deploy gate)
 *
 * Source of truth: swarm-apps/<app>.yaml  (status + displayName + description).
 * The grid is rewritten between the <!-- APPS:START --> / <!-- APPS:END --> markers.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SITE = path.join(REPO, 'site', 'oswarm.ai', 'index.html');

/**
 * Where app manifests live. `swarm-apps/` is the main set; the `swarm-apps-*` variant dirs are
 * explicit-load bundles (CLAUDE.md). Little Monsters is a real, live, flagship app that happens to
 * live in its own dir — the site tells its story, so it must be catalogued. The other variant dir
 * (`swarm-apps-build` = the internal engineering bundle) is deliberately NOT a source for the
 * public grid.
 */
const APP_DIRS = [
  path.join(REPO, 'swarm-apps'),
  // swarm-apps-little-monsters/ was DELETED 2026-07-14 (ADR-085 D2): a pre-carve-out leftover whose
  // personas the carve had already removed, so it could not load. LM is a store package now
  // (github.com/emeraldcoastsystemsgroup/oshal-applications). If the public grid should list
  // store apps, it must read the store, not a stale in-repo manifest.
];

/**
 * Apps deliberately NOT advertised on the public product site (operator decision 2026-07-08).
 * Two reasons, both deliberate:
 *   - internal / operator-only tooling: not a user-facing capability to market.
 *   - the operator's own business pipeline: publishing it would expose commercial specifics.
 * Everything else that is `status: active` publishes automatically, so adding an app updates the
 * site. ADD A NEW BUSINESS/INTERNAL APP HERE or it WILL go public on the next deploy.
 */
const PRIVATE_APPS = new Set([
  'oshal-dev',           // OSHAL Development — internal, superadmin-gated
  'oshal-engineering',   // OSHAL Engineering — internal
  'security-center',     // Security Center — operator-only (maps the platform's own weak points).
                         //   NOTE the key is the manifest's `name:` (security-center), NOT the
                         //   filename (security.yaml). Keying off the filename silently PUBLISHED it.
  // ('capture-crm' + 'federal-capture' + 'gov-contracting' removed 2026-07-19: carved
  //  to the app store, ADR-085 Wave 3 — no in-repo manifests left to filter; store
  //  apps never reach this generator.)
]);

/**
 * Minimal YAML field read — these manifests are flat at the top level, so no YAML dep is needed.
 * Handles both `key: value` and a folded/literal block (`key: >-` followed by indented lines).
 * NOTE: do NOT try to exclude the block indicator with a lookahead — regex backtracking defeats it
 * and you silently capture the literal ">-" as the value. Read the inline value, then fall through
 * to block parsing when it is empty or is a block indicator.
 */
function readField(text, key) {
  const inline = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text);
  if (inline) {
    const value = inline[1].trim().replace(/\s+#.*$/, '');   // strip a trailing comment
    if (value && !value.startsWith('>') && !value.startsWith('|')) {
      return value.replace(/^['"]|['"]$/g, '');
    }
  }
  const block = new RegExp(`^${key}:[ \\t]*[>|]-?[ \\t]*\\r?\\n((?:[ \\t]+\\S.*\\r?\\n?)+)`, 'm').exec(text);
  if (!block) return '';
  return block[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' ').trim();
}

/**
 * Turns a manifest description into a short card blurb: take whole sentences up to the cap, never
 * cut mid-clause. A one-liner like "The bot factory." is too thin on its own, so keep adding
 * sentences until it reads. Lower-cases the first letter to match the grid's voice.
 */
function blurb(description, max = 105) {
  const text = description.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const sentences = text.split(/(?<=[.;])\s+/);
  let out = '';
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (out && next.length > max) break;
    out = next;
    if (out.length >= 45) break;      // long enough to stand alone
  }
  if (out.length > max) out = out.slice(0, max).replace(/[\s,;(]+\S*$/, '') + '…';
  return out.replace(/[.;]$/, '').replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Reads every manifest and splits it into what publishes and what is deliberately held back. */
function collect() {
  const published = [];
  const withheld = [];
  for (const dir of APP_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      // Absent status is ACTIVE, not inactive: every swarm-apps/ manifest declares it, but the
      // little-monsters variant omits it — and it is live. Only an explicit `inactive` is skipped.
      if ((readField(text, 'status') || 'active') !== 'active') continue;
      const name = readField(text, 'name') || path.basename(file, '.yaml');
      const app = {
        name,
        title: readField(text, 'displayName') || name,
        blurb: blurb(readField(text, 'description')),
      };
      (PRIVATE_APPS.has(name) ? withheld : published).push(app);
    }
  }
  published.sort((a, b) => a.title.localeCompare(b.title));
  return { published, withheld };
}

/** Renders the card grid + the honest count line. */
function render(apps) {
  const cards = apps.map((a) =>
    `      <div class="day-app"><b>${esc(a.title)}</b><span>${esc(a.blurb)}</span></div>`).join('\n');
  return [
    `    <p class="eyebrow apps-label">Applications — built on the framework, ${apps.length} live in the repo today</p>`,
    '    <div class="day-apps">',
    cards,
    '    </div>',
  ].join('\n');
}

/**
 * The site also makes NUMERIC claims ("42 providers", "306 hand-audited connectors"). Those are
 * marketing numbers that drift silently as the repo grows — and a public claim we cannot substantiate
 * is worse than no claim. So: count the truth, and FAIL THE DEPLOY on a mismatch.
 *
 * Each claim carries the file it is counted from, so a failure tells you which side is wrong. A
 * pattern that stops matching is ALSO a failure (someone reworded the sentence out from under the
 * gate) — that is deliberate, not a bug.
 *
 * NOTE the deliberate absence of a "1,306 connectors" claim: the extra 1,000 OpenAPI-imported specs
 * live in gitignored output/, so a fresh clone shows 306 and every committed evidence artifact says
 * 306. The site says 306 + "a bulk importer takes it further", which is true of what you download.
 */
function verifyClaims(html) {
  const countMatches = (file, re) => ((fs.readFileSync(path.join(REPO, file), 'utf8').match(re) || []).length);
  const claims = [
    {
      what: 'LLM providers',
      actual: countMatches('src/features/llm-provider/services/provider-definitions.ts', /^ {4}id: '/gm),
      source: 'PROVIDER_DEFINITIONS in src/features/llm-provider/services/provider-definitions.ts',
      patterns: [/(\d+) providers wired in/, /<strong>(\d+) model providers<\/strong>/],
    },
    {
      what: 'hand-audited connectors',
      actual: fs.existsSync(path.join(REPO, 'swarm-apps', 'connectors'))
        ? fs.readdirSync(path.join(REPO, 'swarm-apps', 'connectors')).filter((f) => f.endsWith('.yaml')).length
        : 0,
      source: 'swarm-apps/connectors/*.yaml',
      // The stat tile carries the SAME number and was the one instance no pattern covered —
      // it could have drifted alone while the two prose claims stayed green (2026-07-28).
      patterns: [
        /<strong>(\d+) hand-audited connectors ship in the repo/,
        /(\d+) hand-audited specs/,
        /<div class="n">(\d+)<\/div><div class="l">Connectors in catalog/,
      ],
    },
  ];

  const errors = [];
  for (const c of claims) {
    for (const re of c.patterns) {
      const m = re.exec(html);
      if (!m) {
        errors.push(`  ${c.what}: the site no longer contains the phrase this gate checks (${re}).\n` +
                    `    Someone reworded the claim. Re-point the pattern, or the number stops being verified.`);
        continue;
      }
      const claimed = Number(m[1]);
      if (claimed !== c.actual) {
        errors.push(`  ${c.what}: site claims ${claimed}, repo has ${c.actual}.\n` +
                    `    Truth: ${c.source}. Fix the site copy (or the count) — do not publish an unsubstantiated number.`);
      }
    }
  }
  if (errors.length) {
    console.error('[site-apps] NUMERIC CLAIMS FAILED — refusing to publish:\n' + errors.join('\n'));
    process.exit(3);
  }
  console.log(`[site-apps] numeric claims verified: ${claims.map((c) => `${c.actual} ${c.what}`).join(', ')}`);
}

function main() {
  const check = process.argv.includes('--check');
  const { published, withheld } = collect();
  const html = fs.readFileSync(SITE, 'utf8');
  verifyClaims(html);

  const START = '<!-- APPS:START -->';
  const END = '<!-- APPS:END -->';
  if (!html.includes(START) || !html.includes(END)) {
    console.error(`[site-apps] ${SITE} is missing the ${START} / ${END} markers — add them around the app grid.`);
    process.exit(2);
  }

  const block = `${START}\n${render(published)}\n    ${END}`;
  const next = html.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);

  console.log(`[site-apps] publishing ${published.length} live apps:`);
  console.log('  ' + published.map((a) => a.title).join(', '));
  console.log(`[site-apps] deliberately withheld ${withheld.length} (internal / business):`);
  console.log('  ' + (withheld.map((a) => a.title).join(', ') || '(none)'));

  if (next === html) { console.log('[site-apps] site already current.'); return; }
  if (check) {
    console.error('[site-apps] STALE — the site does not match swarm-apps/. Run: node scripts/site-apps-catalog.js');
    process.exit(1);
  }
  fs.writeFileSync(SITE, next);
  console.log(`[site-apps] rewrote the app grid in ${path.relative(REPO, SITE)}`);
}

main();
