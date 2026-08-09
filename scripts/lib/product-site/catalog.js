/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Catalog model for the multi-page product site. Reads the kernel manifests, the store registry AND each store package's own oshal-app.yaml, because a marketing page built from the one-paragraph registry blurb is exactly the thin page that has fallen flat three times. The per-package manifest is where the substance lives: the screens the app actually gives you (ui.static), the bot that runs it and what it is accountable for (bots[].capabilities), and the accounts it needs.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REPO = path.resolve(__dirname, '..', '..', '..');

/** The store trunk is a SIBLING repo (Rule 0c). Found by convention, overridable for other layouts. */
const STORE_DIR = process.env.OSHAL_STORE_DIR || path.resolve(REPO, '..', 'oshal-applications');

/**
 * Kernel apps deliberately NOT advertised — same list, same reasoning as site-apps-catalog.js:
 * internal/operator-only tooling is not a user-facing capability to market. The key is the
 * manifest's `name:`, NOT the filename (keying off the filename once published security-center).
 */
const PRIVATE_APPS = new Set(['oshal-dev', 'oshal-engineering', 'security-center']);

/** Carved commercial packages (ADR-085 Wave 3). Belt-and-braces against a stale registry. */
const COMMERCIAL_PACKAGES = new Set(['gov-contracting', 'federal-capture', 'capture-crm']);

/**
 * The catalog shelves (ADR-097). `slug` is the URL segment; the tagline is the shelf's point of
 * view, which is the thing a bare grid of tiles never has. `platform` is reserved in the manifests
 * — the assistant lives on it, and gets a page like everything else.
 */
const SHELVES = [
  {
    id: 'ai-productivity', slug: 'productivity', label: 'Productivity',
    tagline: 'Run the day.',
    blurb: 'Mail, messages, documents, money in and money out. The apps you would otherwise keep eleven browser tabs open for.',
  },
  {
    id: 'ai-knowledge', slug: 'knowledge', label: 'Knowledge',
    tagline: 'Read the world, and remember it.',
    blurb: 'Feeds, corpora and recall. These apps do the reading you do not have time for, and can tell you where every claim came from.',
  },
  {
    id: 'ai-finance', slug: 'finance', label: 'Finance',
    tagline: 'Accounts, markets, payroll.',
    blurb: 'Money apps that reason out loud and stop at the point of action. Nothing here moves a dollar without you saying so.',
  },
  {
    id: 'ai-creative', slug: 'creative', label: 'Creative',
    tagline: 'Make things.',
    blurb: 'Video, images, characters, game nights. The output is the point, and the render is real — not a mock-up of one.',
  },
  {
    id: 'ai-home', slug: 'home', label: 'Home & life',
    tagline: 'The house, the family, the trip.',
    blurb: 'Devices, meals, rides, travel and the people you run a household with. The domestic half of the day, on the same rails as the work half.',
  },
  {
    id: 'ai-engineering', slug: 'engineering', label: 'Engineering',
    tagline: 'Operate it, and build on it.',
    blurb: 'The apps that run the swarm itself and the ones that turn it into a workbench — design labs, bake-offs, and the factory that packs new bots.',
  },
  {
    id: 'platform', slug: 'assistant', label: 'Assistant',
    tagline: 'One way in.',
    blurb: 'Ask in plain language and it works out which specialist owns the answer. The front door to every other app on this page.',
  },
];

/**
 * Minimal YAML field read for the FLAT top-level keys of a kernel manifest. Ported from
 * site-apps-catalog.js with its warning intact: do NOT try to exclude the block indicator with a
 * lookahead — regex backtracking defeats it and you silently capture the literal ">-" as the value.
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

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/**
 * The one-line promise at the top of a card and a page. Whole sentences only, and never a
 * fragment: a 22-character first sentence takes the next one rather than standing alone.
 */
function summarize(description, max = 150) {
  const text = clean(description);
  if (!text) return '';
  const sentences = text.split(/(?<=[.;])\s+/);
  let out = '';
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (out.length >= 90) break;
    if (out && next.length > max && out.length >= 55) break;
    out = next;
  }
  if (out.length > max) out = out.slice(0, max).replace(/[\s,;(]+\S*$/, '') + '…';
  return out.replace(/[.;]$/, '');
}

/** Splits a description into the lead sentence and whatever follows, for a two-tier page header. */
function splitLead(description) {
  const text = clean(description);
  const m = /^(.+?[.!?])(\s+|$)/.exec(text);
  if (!m) return { lead: text, rest: '' };
  return { lead: m[1].trim(), rest: text.slice(m[0].length).trim() };
}

/**
 * Reads a store package's own manifest. This is the substance the registry blurb does not carry:
 * the screens, the accountable bot and what it is trusted to do. Parse failure degrades to an
 * empty extras object — a package with an unusual manifest still gets its page.
 */
function readPackageExtras(name) {
  const file = path.join(STORE_DIR, name, 'oshal-app.yaml');
  if (!fs.existsSync(file)) return {};
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (!doc || typeof doc !== 'object') return {};

  const screens = [];
  for (const entry of (doc.ui && doc.ui.static) || []) {
    if (!entry || !entry.label) continue;
    // The ribbon can carry the same surface twice (top + overflow); the page wants it once.
    if (screens.some((s) => s.label === clean(entry.label))) continue;
    screens.push({ label: clean(entry.label), tool: clean(entry.toolName) });
  }

  const capabilities = [];
  const bots = [];
  for (const bot of doc.bots || []) {
    if (!bot || !bot.name) continue;
    bots.push({ name: clean(bot.name), role: clean(bot.role) });
    for (const cap of bot.capabilities || []) {
      const c = clean(cap);
      if (c && !capabilities.includes(c)) capabilities.push(c);
    }
  }

  const tools = [];
  for (const tool of doc.tools || []) {
    if (!tool || !tool.displayName) continue;
    tools.push({ label: clean(tool.displayName), description: summarize(tool.description, 190) });
  }

  return {
    screens,
    bots,
    capabilities,
    tools,
    chatBot: clean(doc.chatBot),
    defaultView: clean(doc.ribbon && doc.ribbon.defaultView),
    ticketType: clean(doc.ticketType),
    uses: (doc.uses || []).map(clean).filter(Boolean),
  };
}

/** The in-repo kernel manifests: the platform's own resident apps. */
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
      version: '',
      origin: 'kernel',
      summary: summarize(description),
      description: clean(description),
      ...splitLead(description),
      screens: [], bots: [], capabilities: [], tools: [], uses: [],
      connectors: [],
    };
    (PRIVATE_APPS.has(name) ? withheld : published).push(app);
  }
  return { published, withheld };
}

/**
 * The store catalog. Returns null (not an empty list) when the trunk is absent, so the caller can
 * refuse to regenerate rather than silently publishing a site with 47 pages missing.
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
    const deps = entry.dependencies || {};
    published.push({
      name: entry.name,
      title: entry.displayName || entry.name,
      suite: entry.suite || 'ai-productivity',
      version: entry.version || '',
      origin: 'store',
      summary: summarize(entry.description),
      description: clean(entry.description),
      ...splitLead(entry.description),
      connectors: (deps.connectors || []).map(clean).filter(Boolean),
      requiresApps: (deps.apps || []).map(clean).filter(Boolean),
      ...readPackageExtras(entry.name),
    });
  }
  return { published, withheld };
}

/** Every number the site shows, counted off the tree. A count that cannot be taken is a failure. */
function countTree(appCount, kernelCount, storeCount, shelfCount) {
  const filesIn = (rel, ext) => {
    const dir = path.join(REPO, rel);
    if (!fs.existsSync(dir)) throw new Error(`cannot count ${rel} — directory is missing`);
    return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).length;
  };
  const providersFile = path.join(REPO, 'src/features/llm-provider/services/provider-definitions.ts');
  // The same expression site-apps-catalog.js's claims gate uses, so both surfaces agree.
  const providers = (fs.readFileSync(providersFile, 'utf8').match(/^ {4}id: '/gm) || []).length;
  if (!providers) throw new Error('provider count came back 0 — PROVIDER_DEFINITIONS shape changed');
  return {
    apps: appCount,
    kernelApps: kernelCount,
    storeApps: storeCount,
    shelves: shelfCount,
    connectors: filesIn('swarm-apps/connectors', '.yaml'),
    providers,
    personas: filesIn('ai-lab/bot-personas', '.yaml'),
    adrs: filesIn('docs/adr', '.md'),
  };
}

/**
 * The whole model the renderers draw from. Returns { missingStore: true } and nothing else when the
 * store trunk is absent — the caller must fail safe rather than publish a gutted site.
 */
function build() {
  const kernel = collectKernel();
  const store = collectStore();
  if (!store) return { missingStore: true };

  const apps = [...store.published, ...kernel.published].sort((a, b) => a.title.localeCompare(b.title));
  const byName = new Map(apps.map((a) => [a.name, a]));

  const shelves = SHELVES
    .map((shelf) => ({ ...shelf, apps: apps.filter((a) => a.suite === shelf.id) }))
    .filter((shelf) => shelf.apps.length > 0);

  // Each app knows its shelf and its neighbours, so an app page can end somewhere instead of
  // dead-ending — the "learn more, then what?" problem every flat catalog page has.
  for (const shelf of shelves) {
    for (const app of shelf.apps) {
      app.shelf = shelf;
      app.related = shelf.apps.filter((o) => o.name !== app.name).slice(0, 4);
      app.requires = (app.requiresApps || []).map((n) => byName.get(n)).filter(Boolean);
    }
  }

  // The shape flags the renderer narrates from. Derived from what the manifest actually declares —
  // an app "runs unattended" only if it really registered a ticket type, and so on. Nothing here is
  // a marketing assertion; each flag corresponds to a declaration you can read in the manifest.
  for (const app of apps) {
    app.shape = {
      surfaces: (app.screens || []).length,
      bots: (app.bots || []).length,
      tools: (app.tools || []).length,
      connectors: (app.connectors || []).length,
      capabilities: (app.capabilities || []).length,
      queued: Boolean(app.ticketType),
      conversational: Boolean(app.chatBot) || (app.capabilities || []).length > 0,
    };
  }

  const userFacingShelves = shelves.filter((s) => s.id !== 'platform').length;
  return {
    counts: countTree(apps.length, kernel.published.length, store.published.length, userFacingShelves),
    shelves,
    apps,
    withheld: { kernel: kernel.withheld.map((a) => a.title), store: store.withheld },
  };
}

module.exports = {
  build, collectKernel, collectStore, summarize, splitLead, readPackageExtras,
  SHELVES, PRIVATE_APPS, COMMERCIAL_PACKAGES, STORE_DIR, REPO,
};
