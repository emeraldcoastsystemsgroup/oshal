#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 evidence generator: derive the skill registry + app→skill matrix from the code, so classification is argued from real usage, not memory.
 *
 * Method (v2 — v1 under-reported badly and was discarded):
 *   1. Parse server.ts for `app.use('/api/x', …, createFooRoutes(ctx))` → mountPath → factory.
 *   2. Parse src/app/routes/index.ts for `export { createFooRoutes } from './foo-routes'` → factory → file.
 *      (Only 13 of 39 manifests declare routes[], so we can NOT rely on the manifests alone.)
 *   3. Attribute each mount to an app: the manifest that declares that mountPath in routes[]
 *      or whose ui.static iframeUrls sit under it; else by name.
 *   4. For every app's files, capture BOTH ways a route reaches a capability:
 *        a. `@/features/<x>` direct imports  (what a carved package does)
 *        b. `ctx.<service>` usage            (AppContext — the de-facto kernel-skill API)
 *   5. Count consumers per skill → propose a tier. The DECISION stays the operator's (ADR-090).
 *
 * Emits docs/apps/skill-registry.md. Read-only over the repo; safe to re-run after any carve.
 *   node scripts/skill-inventory.js [--print]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = process.cwd();
const ROUTES_DIR = path.join(ROOT, 'src', 'app', 'routes');
const FEATURES_DIR = path.join(ROOT, 'src', 'features');
const SERVER_TS = path.join(ROOT, 'src', 'app', 'server.ts');
const INDEX_TS = path.join(ROUTES_DIR, 'index.ts');
const SWARM_APPS = path.join(ROOT, 'swarm-apps');
// Carved-out packages live outside the repo; scan their bundled sources when present.
const CARVED = [{ app: 'little-monsters', dir: 'c:/Projects/oshal-applications/little-monsters/src-routes' }];

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

/** Capabilities a file reaches: `@/features/x` imports + `ctx.service` usages. */
function capabilitiesOf(file) {
  const src = read(file);
  const features = new Set();
  const ctxServices = new Set();
  for (const m of src.matchAll(/['"]@\/features\/([a-z0-9-]+)/g)) features.add(m[1]);
  for (const m of src.matchAll(/\bctx\.([a-zA-Z][a-zA-Z0-9]*)/g)) ctxServices.add(m[1]);
  return { features, ctxServices };
}

// ── factory → file (routes/index.ts barrel) ──────────────────────────────────
const factoryFile = new Map();
for (const m of read(INDEX_TS).matchAll(/export\s*\{([^}]+)\}\s*from\s*'\.\/([a-z0-9-]+)'/g)) {
  const file = path.join(ROUTES_DIR, `${m[2]}.ts`);
  for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)) {
    factoryFile.set(name, file);
  }
}

// ── mountPath → [files] (server.ts hard mounts) ──────────────────────────────
const mountFiles = new Map();
for (const m of read(SERVER_TS).matchAll(/app\.use\(\s*'(\/api\/[a-z0-9-]+)'[^)]*?\b(create[A-Za-z0-9]+)\s*\(/g)) {
  const [, mount, factory] = m;
  const file = factoryFile.get(factory);
  if (!file || !fs.existsSync(file)) continue;
  if (!mountFiles.has(mount)) mountFiles.set(mount, new Set());
  mountFiles.get(mount).add(file);
}

// ── apps → their mounts → their files ────────────────────────────────────────
const appFiles = new Map();   // app -> Set(file)
const appNotes = new Map();
const manifests = new Map();

if (fs.existsSync(SWARM_APPS)) {
  for (const f of fs.readdirSync(SWARM_APPS).filter((x) => /\.ya?ml$/.test(x))) {
    let m; try { m = yaml.load(read(path.join(SWARM_APPS, f))); } catch { continue; }
    if (m && m.name) manifests.set(m.name, m);
  }
}

/** Mount paths an app owns: declared routes[] + the /api/x prefixes of its ui.static iframes. */
function mountsOf(m) {
  const out = new Set();
  for (const r of (Array.isArray(m.routes) ? m.routes : [])) if (r.mountPath) out.add(r.mountPath);
  for (const s of ((m.ui && Array.isArray(m.ui.static)) ? m.ui.static : [])) {
    const mm = /^(\/api\/[a-z0-9-]+)/.exec(String(s.iframeUrl || ''));
    if (mm) out.add(mm[1]);
  }
  if (m.ui && m.ui.dynamic) {
    const mm = /^(\/api\/[a-z0-9-]+)/.exec(String(m.ui.dynamic.iframeUrlTemplate || ''));
    if (mm) out.add(mm[1]);
  }
  return out;
}

for (const [name, m] of manifests) {
  const files = new Set();
  const mounts = mountsOf(m);
  for (const mt of mounts) for (const f of (mountFiles.get(mt) || [])) files.add(f);
  // Fallback: name-matched route file (covers apps that declare neither routes[] nor an /api iframe).
  const guess = path.join(ROUTES_DIR, `${name}-routes.ts`);
  if (!files.size && fs.existsSync(guess)) files.add(guess);
  appFiles.set(name, files);
  if (!files.size) appNotes.set(name, '⚠ no server routes found — reaches skills via bots/tools only; needs a manual pass');
}

for (const { app, dir } of CARVED) {
  if (!fs.existsSync(dir)) continue;
  const files = new Set(fs.readdirSync(dir).filter((x) => x.endsWith('.ts')).map((x) => path.join(dir, x)));
  appFiles.set(app, files);
  appNotes.set(app, 'CARVED to the store — scanned from its package src-routes/');
}

// ── roll up per app ──────────────────────────────────────────────────────────
const appCaps = new Map(); // app -> {features:Set, ctx:Set}
for (const [app, files] of appFiles) {
  const features = new Set(); const ctx = new Set();
  for (const f of files) {
    const c = capabilitiesOf(f);
    c.features.forEach((x) => features.add(x));
    c.ctxServices.forEach((x) => ctx.add(x));
  }
  appCaps.set(app, { features, ctx });
}

// ── invert: skill -> consumers ───────────────────────────────────────────────
const featureApps = new Map();
const ctxApps = new Map();
for (const [app, { features, ctx }] of appCaps) {
  for (const f of features) { if (!featureApps.has(f)) featureApps.set(f, new Set()); featureApps.get(f).add(app); }
  for (const s of ctx) { if (!ctxApps.has(s)) ctxApps.set(s, new Set()); ctxApps.get(s).add(app); }
}

// core (non-app-route) usage of each feature
const appRouteFileSet = new Set([...appFiles.values()].flatMap((s) => [...s]));
const coreUsed = new Set();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'features') walk(p); continue; }
    if (!p.endsWith('.ts') || appRouteFileSet.has(p)) continue;
    capabilitiesOf(p).features.forEach((x) => coreUsed.add(x));
  }
})(path.join(ROOT, 'src'));

const allFeatures = fs.readdirSync(FEATURES_DIR)
  .filter((f) => { try { return fs.statSync(path.join(FEATURES_DIR, f)).isDirectory(); } catch { return false; } })
  .sort();

// AppContext's exposed services = the de-facto kernel-skill API surface.
const ctxSurface = [...read(path.join(ROOT, 'src', 'app', 'composition', 'app-context.ts'))
  .matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]);

function tierOf(f) {
  const n = (featureApps.get(f) || new Set()).size;
  if (n >= 2) return ['**KERNEL SKILL**', `${n} apps import it`];
  if (n === 1 && coreUsed.has(f)) return ['KERNEL SKILL?', '1 app + core — decide: shared service or app-owned'];
  if (n === 1) return ['APP-OWNED?', `only \`${[...featureApps.get(f)][0]}\` — vendor into that package on carve, unless a 2nd consumer is expected → publish as a skill package`];
  if (coreUsed.has(f)) return ['KERNEL (platform)', 'core-only — never carves'];
  return ['UNUSED?', 'no importer found — verify (may be CLI/script-only)'];
}

// ── emit ─────────────────────────────────────────────────────────────────────
const L = [];
const shared = allFeatures.filter((f) => (featureApps.get(f) || new Set()).size >= 2);
const single = allFeatures.filter((f) => (featureApps.get(f) || new Set()).size === 1);
const coreOnly = allFeatures.filter((f) => !(featureApps.get(f) || new Set()).size && coreUsed.has(f));
const orphan = allFeatures.filter((f) => !(featureApps.get(f) || new Set()).size && !coreUsed.has(f));
const noRoutes = [...appNotes.entries()].filter(([, n]) => n.startsWith('⚠')).map(([a]) => a);

L.push('# Skill registry + app→skill matrix  *(DERIVED — evidence for ADR-090)*');
L.push('');
L.push('**Generated: `node scripts/skill-inventory.js`. Re-run after every carve.**');
L.push('');
L.push('This is **evidence, not a decision.** Tiers below are *proposals* computed from real usage;');
L.push('the classification is the operator\'s call ([ADR-090](../adr/090-skills-as-first-class-packages.md)).');
L.push('');
L.push('**Two ways a route reaches a capability — both are counted:**');
L.push('1. **`@/features/<x>` import** — what a *carved package* does (little-monsters imports');
L.push('   `presentation-generation` + `voice-providers` at runtime today).');
L.push('2. **`ctx.<service>`** — the AppContext handed to every route factory. **AppContext is the');
L.push('   de-facto kernel-skill API already** — see §3; formalizing it *is* Wave-0 item D8.');
L.push('');
L.push('**Reading the tiers:** `≥2 apps` → **kernel skill** (Tier-0b). `exactly 1 app` → **app-owned');
L.push('candidate**: vendor it into that package on carve (the google-calendar lesson) *unless* you');
L.push('expect a second consumer — then publish it as a **skill package** rather than bury it.');
L.push('`core-only` → platform internals, never carve.');
L.push('');
L.push(`> **Blind spot:** ${noRoutes.length} apps expose no server routes and reach skills via bots/tools`);
L.push('> instead. They are flagged in §2 and need a manual pass (persona `allowed_tools` + manifest `tools:`).');
L.push('');
L.push('## 1. Skill registry — every feature, its consumers, a proposed tier');
L.push('');
L.push('| Skill (`src/features/`) | Apps importing it | # | Core? | Proposed tier | Basis |');
L.push('|---|---|---|---|---|---|');
for (const f of allFeatures) {
  const apps = [...(featureApps.get(f) || [])].sort();
  const [tier, why] = tierOf(f);
  L.push(`| \`${f}\` | ${apps.length ? apps.map((a) => `\`${a}\``).join(', ') : '—'} | ${apps.length} | ${coreUsed.has(f) ? 'yes' : 'no'} | ${tier} | ${why} |`);
}
L.push('');
L.push('## 2. App → skill matrix');
L.push('');
L.push('| App | `@/features` imports | `ctx.*` services used | Note |');
L.push('|---|---|---|---|');
for (const app of [...appCaps.keys()].sort()) {
  const { features, ctx } = appCaps.get(app);
  const fl = [...features].sort().map((x) => `\`${x}\``).join(', ') || '—';
  const cl = [...ctx].sort().map((x) => `\`${x}\``).join(', ') || '—';
  L.push(`| \`${app}\` | ${fl} | ${cl} | ${appNotes.get(app) || ''} |`);
}
L.push('');
L.push('## 3. AppContext — the de-facto kernel-skill API (D8)');
L.push('');
L.push('Every route factory receives `ctx`. Its fields ARE the capability surface core already');
L.push('hands to apps — an uncurated, undeclared kernel API. **D8 should formalize THIS**, not');
L.push('invent a new barrel: decide which fields are a stable, package-callable contract, and which');
L.push('are platform internals a package must never touch.');
L.push('');
L.push(`Exposed today (${ctxSurface.length}): ${ctxSurface.map((s) => `\`${s}\``).join(', ')}`);
L.push('');
L.push('| `ctx` service | Apps using it | # |');
L.push('|---|---|---|');
for (const s of [...ctxApps.keys()].sort((a, b) => (ctxApps.get(b).size - ctxApps.get(a).size) || a.localeCompare(b))) {
  const apps = [...ctxApps.get(s)].sort();
  L.push(`| \`ctx.${s}\` | ${apps.map((a) => `\`${a}\``).join(', ')} | ${apps.length} |`);
}
L.push('');
L.push('## 4. Summary');
L.push('');
L.push(`- **${shared.length}** skills imported by 2+ apps → **kernel-skill candidates**: ${shared.map((x) => `\`${x}\``).join(', ') || '—'}`);
L.push(`- **${single.length}** imported by exactly 1 app → **app-owned candidates** (vendor on carve, or promote to a skill package if a 2nd consumer is expected).`);
L.push(`- **${coreOnly.length}** core-only → platform internals.`);
L.push(`- **${orphan.length}** with no importer found → verify (CLI/script-only, or dead).`);
L.push(`- **${appCaps.size}** apps inventoried; **${noRoutes.length}** need the manual bots/tools pass: ${noRoutes.map((a) => `\`${a}\``).join(', ') || '—'}`);
L.push('');

const out = L.join('\n') + '\n';
if (process.argv.includes('--print')) { console.log(out); process.exit(0); }
const dest = path.join(ROOT, 'docs', 'apps', 'skill-registry.md');
fs.writeFileSync(dest, out);
console.log(`wrote ${dest}`);
console.log(`  ${allFeatures.length} skills | ${appCaps.size} apps | shared(2+)=${shared.length} | single=${single.length} | core-only=${coreOnly.length} | orphan=${orphan.length} | no-routes=${noRoutes.length}`);
