#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Generate the product page's catalog data island from the REAL manifests. site-apps-catalog.js only ever read swarm-apps/, so the public site advertised 7 apps while 47 more shipped in the store — the exact under-selling the anti-drift rules call as dishonest as over-claiming. This reads both sources (kernel manifests + the store marketplace) and every count off the tree, so no number and no tile is ever hand-typed.
 */

/**
 * Product-page catalog generator.
 *
 *   node scripts/site-product-page.js            # rewrite the data island in the product page
 *   node scripts/site-product-page.js --check    # exit 1 if the page is stale (pre-deploy gate)
 *
 * Sources of truth:
 *   - kernel apps    swarm-apps/<app>.yaml           (displayName / description / suite / status)
 *   - store apps     <store>/marketplace.json        (displayName / description / suite / version)
 *   - every count    counted off the working tree, never asserted
 *
 * The island is rewritten between the <!-- PRODUCT-DATA:START --> / <!-- PRODUCT-DATA:END -->
 * markers. The page renders tiles from it, so the page carries no hand-typed catalog or count.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const PAGE = path.join(REPO, 'site', 'oswarm.ai', 'product', 'index.html');

/**
 * The store trunk. It is a SIBLING repo (Rule 0c: application code never mixes with swarm code),
 * so it is found by convention and overridable for a checkout laid out differently.
 */
const STORE_DIR = process.env.OSHAL_STORE_DIR || path.resolve(REPO, '..', 'oshal-applications');

/**
 * Kernel apps deliberately NOT advertised — same list, same reasoning as site-apps-catalog.js:
 * internal/operator-only tooling is not a user-facing capability to market. The key is the
 * manifest's `name:`, NOT the filename (keying off the filename once published security-center).
 */
const PRIVATE_APPS = new Set(['oshal-dev', 'oshal-engineering', 'security-center']);

/**
 * Commercial packages carved out to the private store repo (ADR-085 Wave 3). They are absent from
 * the store trunk today and build-store-public.sh refuses to cut a snapshot containing them — this
 * set is the belt-and-braces so a stale marketplace.json can never publish one from here.
 */
const COMMERCIAL_PACKAGES = new Set(['gov-contracting', 'federal-capture', 'capture-crm']);

/**
 * Catalog shelves (ADR-097). `platform` is reserved in the manifests; on this page it is given a
 * human label so the assistant still earns a tile — it is a thing you open, and a visitor looking
 * for "the assistant" should find it by searching. It ALSO renders as the closing platform box,
 * which is deliberate: it is both an application and the front door to all the others.
 */
const SUITES = [
  { id: 'ai-productivity', label: 'Productivity', blurb: 'Run the day — mail, messages, documents, money in and out.' },
  { id: 'ai-knowledge', label: 'Knowledge', blurb: 'Read the world for you and remember what it said.' },
  { id: 'ai-finance', label: 'Finance', blurb: 'Accounts, markets, payroll — reasoned over, never auto-traded.' },
  { id: 'ai-creative', label: 'Creative', blurb: 'Make things: video, images, characters, games.' },
  { id: 'ai-home', label: 'Home & life', blurb: 'The house, the family, the trip, the ride, the takeout.' },
  { id: 'ai-engineering', label: 'Engineering', blurb: 'Operate the swarm and build on top of it.' },
  { id: 'platform', label: 'Assistant', blurb: 'One way in — ask, and it routes to whichever specialist owns the answer.' },
];

/**
 * Minimal YAML field read — these manifests are flat at the top level, so no YAML dep is needed.
 * Handles `key: value` and folded/literal blocks (`key: >-` + indented lines). Ported verbatim
 * from site-apps-catalog.js, including its warning: do NOT try to exclude the block indicator with
 * a lookahead — regex backtracking defeats it and you silently capture the literal ">-" as the value.
 */
function readField(text, key) {
  const inline = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text);
  if (inline) {
    const value = inline[1].trim().replace(/\s+#.*$/, '');
    if (value && !value.startsWith('>') && !value.startsWith('|')) {
      return value.replace(/^['"]|['"]$/g, '');
    }
  }
  const block = new RegExp(`^${key}:[ \\t]*[>|]-?[ \\t]*\\r?\\n((?:[ \\t]+\\S.*\\r?\\n?)+)`, 'm').exec(text);
  if (!block) return '';
  return block[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' ').trim();
}

/**
 * First whole sentence(s) up to a cap, never cut mid-clause — the tile blurb. The full description
 * is kept separately for the Learn-more panel, so this only has to earn the click.
 */
function blurb(description, max = 150) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const sentences = text.split(/(?<=[.;])\s+/);
  let out = '';
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (out.length >= 90) break;                          // enough to read — stop on a clean boundary
    // Never leave a fragment. "Ask what someone said." is 22 characters; bailing here because the
    // NEXT sentence is long strands it alone on a tile. Below the floor, take the next sentence
    // anyway and let the truncation below cut it mid-way with an ellipsis.
    if (out && next.length > max && out.length >= 55) break;
    out = next;
  }
  if (out.length > max) out = out.slice(0, max).replace(/[\s,;(]+\S*$/, '') + '…';
  return out.replace(/[.;]$/, '');
}

/** Reads the in-repo kernel manifests: the platform's own resident apps. */
function collectKernel() {
  const dir = path.join(REPO, 'swarm-apps');
  const published = [];
  const withheld = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    // Absent status means ACTIVE. Only an explicit `inactive` is skipped.
    if ((readField(text, 'status') || 'active') !== 'active') continue;
    const name = readField(text, 'name') || path.basename(file, '.yaml');
    const description = readField(text, 'description');
    const app = {
      name,
      title: readField(text, 'displayName') || name,
      suite: (readField(text, 'suite') || 'platform').replace(/\s+#.*$/, '').trim(),
      blurb: blurb(description),
      detail: description,
      origin: 'kernel',
    };
    (PRIVATE_APPS.has(name) ? withheld : published).push(app);
  }
  return { published, withheld };
}

/**
 * Reads the store catalog. Returns null (not an empty list) when the store trunk is absent, so the
 * caller can refuse to rewrite rather than silently publishing a gutted 7-app page from a checkout
 * that simply does not have the sibling repo.
 */
function collectStore() {
  const registry = path.join(STORE_DIR, 'marketplace.json');
  if (!fs.existsSync(registry)) return null;
  const parsed = JSON.parse(fs.readFileSync(registry, 'utf8'));
  const published = [];
  const withheld = [];
  for (const entry of parsed.apps || []) {
    if (entry.status && entry.status !== 'ready') { withheld.push(entry.name); continue; }
    if (COMMERCIAL_PACKAGES.has(entry.name)) { withheld.push(entry.name); continue; }
    published.push({
      name: entry.name,
      title: entry.displayName || entry.name,
      suite: entry.suite || 'ai-productivity',
      version: entry.version || '',
      blurb: blurb(entry.description),
      detail: String(entry.description || '').replace(/\s+/g, ' ').trim(),
      origin: 'store',
    });
  }
  published.sort((a, b) => a.title.localeCompare(b.title));
  return { published, withheld };
}

/**
 * Every number the page shows, counted off the tree. A count that cannot be taken is a hard failure.
 * `shelves` counts POPULATED user-facing shelves only — the reserved `platform` shelf is a routing
 * label, not a catalog shelf, and counting it would overstate the catalog by one.
 */
function counts(kernelCount, storeCount, shelves) {
  const filesIn = (rel, ext) => {
    const dir = path.join(REPO, rel);
    if (!fs.existsSync(dir)) throw new Error(`cannot count ${rel} — directory is missing`);
    return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).length;
  };
  const providersFile = path.join(REPO, 'src/features/llm-provider/services/provider-definitions.ts');
  // Same expression the site-apps-catalog claims gate uses, so both surfaces count providers identically.
  const providers = (fs.readFileSync(providersFile, 'utf8').match(/^ {4}id: '/gm) || []).length;
  if (!providers) throw new Error('provider count came back 0 — PROVIDER_DEFINITIONS shape changed');
  return {
    apps: kernelCount + storeCount,
    storeApps: storeCount,
    kernelApps: kernelCount,
    suites: shelves,
    connectors: filesIn('swarm-apps/connectors', '.yaml'),
    providers,
    personas: filesIn('ai-lab/bot-personas', '.yaml'),
    adrs: filesIn('docs/adr', '.md'),
  };
}

function build() {
  const kernel = collectKernel();
  const store = collectStore();
  if (!store) return { missingStore: true };

  // Every published app gets a tile — including the `platform`-shelved assistant, so the grid count
  // and the headline count can never disagree. platformApps is the SAME entry rendered a second
  // time as the closing platform box; it is not a separate app and is not counted twice.
  const gridApps = [...store.published, ...kernel.published]
    .sort((a, b) => a.title.localeCompare(b.title));
  const platformApps = kernel.published.filter((a) => a.suite === 'platform');

  const populatedShelves = SUITES
    .filter((s) => s.id !== 'platform' && gridApps.some((a) => a.suite === s.id)).length;

  return {
    counts: counts(kernel.published.length, store.published.length, populatedShelves),
    suites: SUITES,
    apps: gridApps,
    platformApps,
    withheld: {
      kernel: kernel.withheld.map((a) => a.title),
      store: store.withheld,
    },
  };
}

function main() {
  const check = process.argv.includes('--check');
  const data = build();

  if (data.missingStore) {
    // Fail SAFE, not open: keep whatever island is committed. A missing sibling repo must never be
    // able to shrink the public catalog, and --check must not call a page stale it cannot verify.
    console.warn(`[site-product] store trunk not found at ${STORE_DIR} — leaving the committed catalog untouched.`);
    console.warn('[site-product] set OSHAL_STORE_DIR to regenerate from a checkout elsewhere.');
    return;
  }

  const html = fs.readFileSync(PAGE, 'utf8');
  const START = '<!-- PRODUCT-DATA:START -->';
  const END = '<!-- PRODUCT-DATA:END -->';
  if (!html.includes(START) || !html.includes(END)) {
    console.error(`[site-product] ${PAGE} is missing the ${START} / ${END} markers.`);
    process.exit(2);
  }

  const island = [
    START,
    '<script id="product-data" type="application/json">',
    JSON.stringify({ counts: data.counts, suites: data.suites, apps: data.apps, platformApps: data.platformApps }, null, 0),
    '</script>',
    END,
  ].join('\n');
  const next = html.replace(new RegExp(`${START}[\\s\\S]*?${END}`), island);

  const c = data.counts;
  console.log(`[site-product] catalog: ${c.apps} apps (${c.storeApps} store + ${c.kernelApps} kernel) across ${c.suites} suites`);
  console.log(`[site-product] counts: ${c.connectors} connectors, ${c.providers} providers, ${c.personas} personas, ${c.adrs} ADRs`);
  console.log(`[site-product] deliberately withheld: ${[...data.withheld.kernel, ...data.withheld.store].join(', ') || '(none)'}`);

  if (next === html) { console.log('[site-product] page already current.'); return; }
  if (check) {
    console.error('[site-product] STALE — the page does not match the manifests. Run: node scripts/site-product-page.js');
    process.exit(1);
  }
  fs.writeFileSync(PAGE, next);
  console.log(`[site-product] rewrote the catalog island in ${path.relative(REPO, PAGE)}`);
}

main();
