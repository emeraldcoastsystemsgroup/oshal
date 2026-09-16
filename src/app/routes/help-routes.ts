/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The in-product help hub (BACKLOG "End-user guides and an in-app way to reach them"): docs/guides/*.md rendered to themed HTML at /api/help, with /api/help/:slug per guide and a ?for=<surface> deep link so a screen can hand the reader straight to its own page. Guides were unreachable from inside the product — no /help route existed, /docs serves Swagger, and the first-run strip hides itself on the full framework profile — so the docs existed but nobody in the cockpit could find them. Markdown is rendered server-side with `marked`; the guide corpus is trusted repo content, but output is still escaped-by-construction for the pieces we interpolate (title, nav labels) and the slug is allowlisted against the on-disk set so no path can be traversed. The surface links surface-themes.css and derives every colour from framework tokens — the pattern BUG-12 exists to enforce, applied here rather than adding a 21st themeless page.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Per-surface affordance support (BACKLOG "In-app help: per-surface affordances and first-run"): `?for=` now normalises the cockpit ribbon's `tool-<id>` spelling onto the documented surface vocabulary, so the id a screen actually carries resolves instead of falling through to the index; `devices`, `global-search` and `notify` were reachable screens with no mapping at all. GET /api/help/surfaces answers the surfaces that reach a guide PRESENT on this deployment (both spellings), so the header affordance can claim "help for this screen" only when that is true, rather than re-implementing the mapping in the browser and drifting from it. Registered before /:slug — the slug route would otherwise swallow it.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Thirteen more ribbon ids reach the guide that documents them. Files, Cloud, Kalshi Edge, Sports Edge and the nine maker-lab tiles all ship a guide, but the ribbon spells them `tool-storage-files`/`tool-kalshi-home`/`tool-circuit-lab` and the map keyed the slug, so their help button quietly fell through to the index - the screens with the MOST to explain were the ones the affordance helped least. Drone Ops stays unmapped on purpose: maker-labs.md documents Drone Relay, and pointing a reader at a page about a different screen is worse than the index.
 */

import { Router, type Request, type Response } from 'express';
import type { marked as MarkedApi } from 'marked' with { 'resolution-mode': 'import' };
import fs from 'node:fs';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'help-routes' });

// `marked` v18 declares itself ESM-only, so a static import fails to COMPILE from this CommonJS
// build (TS1479) even though Node's require(esm) support loads it fine at runtime — verified on the
// container's Node 20.20. Binding it at runtime keeps the types and keeps the build honest; the
// floor is Node >= 20.19, which is where require(esm) landed.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { marked } = require('marked') as { marked: typeof MarkedApi };

/** Slug shape a guide file may have — also the traversal guard (no dots, no separators). */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Maps a cockpit surface/tool identifier to the guide that documents it (the `?for=` contract). */
const SURFACE_TO_GUIDE: Record<string, string> = {
  'intelligent-processing': 'intelligent-processing',
  'tool-token-chase': 'optimizer',
  optimizer: 'optimizer',
  'token-chase': 'optimizer',
  jarvis: 'jarvis',
  tickets: 'tickets',
  calendar: 'calendar',
  chat: 'swarm-messages',
  'swarm-messages': 'swarm-messages',
  settings: 'settings',
  'config-admin': 'settings',
  security: 'security-center',
  'security-center': 'security-center',
  devops: 'devops-vault',
  'devops-vault': 'devops-vault',
  cloud: 'cloud-and-connections',
  utilities: 'cloud-and-connections',
  connectors: 'cloud-and-connections',
  identity: 'identity-hub',
  'identity-home': 'identity-hub',
  files: 'files',
  storage: 'files',
  'test-lab': 'ai-test-lab',
  'ai-test-lab': 'ai-test-lab',
  'eval-wall': 'eval-wall',
  search: 'platform-tools',
  'run-trace': 'platform-tools',
  budgets: 'platform-tools',
  notifications: 'platform-tools',
  'my-data': 'platform-tools',
  dlq: 'platform-tools',
  // The cockpit ribbon's own ids for the same screens. The ribbon names its platform tools
  // `tool-<id>` (RibbonNav PLATFORM_TOOLS) and those ids are what the per-surface affordance
  // hands us, so the two vocabularies have to meet here rather than in the browser.
  devices: 'devices',
  'global-search': 'platform-tools',
  notify: 'platform-tools',
  // Core swarm-apps manifests register their screens as `tool-<toolName>` (swarm-app-group.ts),
  // so the toolName is the id the affordance carries for those surfaces.
  'intelligent-processing-queue': 'intelligent-processing',
  'devops-vault-console': 'devops-vault',
  'jarvis-home': 'jarvis',
  'security-center-home': 'security-center',
  // Screens that ship a guide but whose ribbon id never matched its slug, so their '?' landed on
  // the index. Each one is mapped onto the guide that names it by name: files.md documents the
  // Files icon, cloud-and-connections.md the Cloud/Connections tab, kalshi.md the Kalshi Edge
  // tile, fantasy-football.md the Fantasy tab of Sports Edge.
  'storage-files': 'files',
  'cloud-accounts': 'cloud-and-connections',
  'kalshi-home': 'kalshi',
  'sports-edge-home': 'fantasy-football',
  // One guide, eight labs, nine rail tiles - the set maker-labs.md "Where they are" enumerates.
  // Drone Ops is deliberately NOT here: that guide covers Drone RELAY, a different screen.
  embodied: 'maker-labs',
  animatronics: 'maker-labs',
  'drone-relay': 'maker-labs',
  'cad-studio': 'maker-labs',
  'circuit-lab': 'maker-labs',
  'scan-to-print': 'maker-labs',
  'aero-lab': 'maker-labs',
  'ocean-lab-harvest-console': 'maker-labs',
  'ocean-lab-blade-studio': 'maker-labs',
};

/** One guide as listed in the hub nav. */
interface GuideEntry { slug: string; title: string }

/** Escape text destined for HTML (titles and nav labels are interpolated, so they are escaped). */
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * @description Resolve the guides directory. Prefers the repo layout (docs/guides) and falls back to
 * the image layout, so the route works both under ts-node in a checkout and inside the container.
 * @returns Absolute path to the guides directory, or null when the corpus is not present.
 */
export function resolveGuidesDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'docs/guides'),
    path.resolve(__dirname, '../../../docs/guides'),
    '/app/docs/guides',
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // fall through to the next candidate — an unreadable candidate is not fatal
    }
  }
  return null;
}

/** First markdown H1 in the file, falling back to a title-cased slug. */
function titleOf(markdown: string, slug: string): string {
  const h1 = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (h1) return h1.replace(/\s+—\s+(user|operator) guide \(as-built\)\s*$/i, '');
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * @description List the guides on disk (README excluded — it is the hub's own content).
 * @param dir - The resolved guides directory.
 * @returns Guide entries sorted by title.
 */
export function listGuides(dir: string): GuideEntry[] {
  const out: GuideEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md') || file === 'README.md') continue;
    const slug = file.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    try {
      out.push({ slug, title: titleOf(fs.readFileSync(path.join(dir, file), 'utf8'), slug) });
    } catch (err) {
      logger.error({ err, file }, 'Failed to read guide while listing');
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * @description Resolve a requested slug against the guides actually on disk. This is the traversal
 * guard: an unknown or malformed slug never becomes a filesystem path.
 * @param dir - The guides directory. @param slug - The requested slug.
 * @returns The absolute file path, or null when the slug is not an existing guide.
 */
export function resolveGuideFile(dir: string, slug: string): string | null {
  if (!SLUG_RE.test(slug)) return null;
  const file = path.join(dir, `${slug}.md`);
  if (!file.startsWith(dir) || !fs.existsSync(file)) return null;
  return file;
}

/** Map a `?for=<surface>` hint onto a guide slug (null when the surface has no guide yet). */
export function guideForSurface(surface: string): string | null {
  const key = surface.toLowerCase().trim();
  // A cockpit platform tool arrives as `tool-<id>`; the bare id is the documented vocabulary.
  return SURFACE_TO_GUIDE[key] ?? SURFACE_TO_GUIDE[key.replace(/^tool-/, '')] ?? null;
}

/**
 * @description The surface identifiers that actually reach a guide PRESENT on this deployment —
 * both the bare id and the cockpit ribbon's `tool-<id>` spelling, so a caller only has to test
 * membership rather than re-implement the normalisation rule. A surface whose guide file is not
 * installed is deliberately absent: the affordance must not promise a page that 404s.
 * @param dir - The resolved guides directory.
 * @returns Sorted surface identifiers, each of which resolves to an existing guide.
 */
export function coveredSurfaces(dir: string): string[] {
  const covered = new Set<string>();
  for (const [surface, slug] of Object.entries(SURFACE_TO_GUIDE)) {
    if (!resolveGuideFile(dir, slug)) continue;
    covered.add(surface);
    if (!surface.startsWith('tool-')) covered.add(`tool-${surface}`);
  }
  return [...covered].sort();
}

/** The page chrome — framework theme tokens only (no bespoke palette; see BUG-12). */
function page(title: string, nav: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="midnight">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} — oshal help</title>
<link rel="stylesheet" href="/shared/ui/css/surface-themes.css" />
<link rel="stylesheet" href="/shared/ui/css/surface-reading.css" />
<script>
  // Inherit the cockpit's active theme (same-origin localStorage), like every themed surface.
  try { var t = localStorage.getItem('cockpit-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (e) {}
</script>
<style>
  :root { --ink: var(--text-primary); --dim: var(--text-secondary); --edge: var(--border-color); --accent: var(--accent-primary); }
  * { box-sizing: border-box; }
  body { margin:0; background: var(--bg-primary); color: var(--ink);
         font:15px/1.65 Inter,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { display:grid; grid-template-columns: minmax(200px,260px) minmax(0,1fr); min-height:100vh; }
  nav { border-right:1px solid var(--edge); padding:18px 14px; background: var(--bg-secondary); overflow:auto; }
  nav h2 { font-size:11px; text-transform:uppercase; letter-spacing:1px; color:var(--dim); margin:0 0 10px; }
  nav a { display:block; padding:7px 9px; border-radius:6px; color:var(--ink); text-decoration:none; font-size:13.5px; }
  nav a:hover { background: var(--bg-card, var(--bg-primary)); }
  nav a.active { background: var(--accent); color: var(--bg-primary); font-weight:600; }
  main { padding:26px 30px 70px; overflow:auto; }
  article { max-width: 78ch; }
  h1 { font-size:26px; line-height:1.25; margin:0 0 6px; }
  h2 { font-size:18px; margin:30px 0 8px; padding-top:6px; border-top:1px solid var(--edge); }
  h3 { font-size:15px; margin:20px 0 6px; }
  p, li { color: var(--ink); }
  code { background: var(--bg-secondary); border:1px solid var(--edge); border-radius:4px; padding:1px 5px; font-size:.9em; }
  pre { background: var(--bg-secondary); border:1px solid var(--edge); border-radius:8px; padding:12px; overflow-x:auto; }
  pre code { border:0; background:none; padding:0; }
  a { color: var(--accent); }
  table { border-collapse:collapse; width:100%; margin:14px 0; display:block; overflow-x:auto; }
  th, td { border:1px solid var(--edge); padding:7px 10px; text-align:left; font-size:13.5px; vertical-align:top; }
  th { background: var(--bg-secondary); }
  blockquote { margin:14px 0; padding:8px 14px; border-left:3px solid var(--accent); color:var(--dim); }
  .crumb { font-size:12px; color:var(--dim); margin-bottom:14px; }
  .crumb a { text-decoration:none; }
  @media (max-width: 720px) {
    .wrap { display:block; }
    nav { border-right:0; border-bottom:1px solid var(--edge); }
    main { padding:18px 16px 60px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <nav><h2>User guides</h2>${nav}</nav>
  <main><article>${body}</article></main>
</div>
</body>
</html>`;
}

/** Build the nav list, marking the active slug. */
function navHtml(guides: GuideEntry[], active: string): string {
  const home = `<a href="/api/help"${active === '' ? ' class="active"' : ''}>Overview</a>`;
  return home + guides.map((g) =>
    `<a href="/api/help/${esc(g.slug)}"${g.slug === active ? ' class="active"' : ''}>${esc(g.title)}</a>`).join('');
}

/** Render markdown to HTML (repo-authored corpus; marked runs synchronously here). */
function render(markdown: string): string {
  return marked.parse(markdown, { async: false }) as string;
}

/**
 * @description Creates the in-product help routes. `GET /` renders the guides index (the hub),
 * `GET /:slug` renders one guide, and `GET /?for=<surface>` redirects to the guide for a cockpit
 * surface so a screen can link straight to its own page. Read-only over repo-authored markdown —
 * no user content, no writes, no LLM.
 * @returns Express router intended to mount at /api/help behind the caller's auth wrapper.
 */
export function createHelpRoutes(): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response): void => {
    const dir = resolveGuidesDir();
    if (!dir) { res.status(503).send('Help content is not installed on this deployment.'); return; }
    const forSurface = typeof req.query.for === 'string' ? guideForSurface(req.query.for) : null;
    if (forSurface && resolveGuideFile(dir, forSurface)) { res.redirect(`/api/help/${forSurface}`); return; }
    try {
      const guides = listGuides(dir);
      const readme = path.join(dir, 'README.md');
      const body = fs.existsSync(readme)
        ? render(fs.readFileSync(readme, 'utf8'))
        : `<h1>User guides</h1><p>Pick a screen from the list.</p>`;
      res.type('html').send(page('User guides', navHtml(guides, ''), body));
    } catch (err) {
      logger.error({ err }, 'Failed to render help index');
      res.status(500).send('Failed to render help.');
    }
  });

  // Registered BEFORE '/:slug' on purpose — otherwise the slug route swallows it and answers 404.
  router.get('/surfaces', (_req: Request, res: Response): void => {
    const dir = resolveGuidesDir();
    res.json({ surfaces: dir ? coveredSurfaces(dir) : [] });
  });

  router.get('/:slug', (req: Request, res: Response): void => {
    const dir = resolveGuidesDir();
    if (!dir) { res.status(503).send('Help content is not installed on this deployment.'); return; }
    const slug = String(req.params.slug);
    const file = resolveGuideFile(dir, slug);
    if (!file) { res.status(404).send('No guide by that name.'); return; }
    try {
      const md = fs.readFileSync(file, 'utf8');
      const crumb = '<div class="crumb"><a href="/api/help">← All guides</a></div>';
      res.type('html').send(page(titleOf(md, slug), navHtml(listGuides(dir), slug), crumb + render(md)));
    } catch (err) {
      logger.error({ err, slug }, 'Failed to render help guide');
      res.status(500).send('Failed to render this guide.');
    }
  });

  return router;
}
