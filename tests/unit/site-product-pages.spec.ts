/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the multi-page product site. Replaces the single-page site-product-page.spec.ts. Four failure shapes are pinned, all against the REAL manifests rather than a fixture of them: UNDER-CLAIMING (the committed pages must equal a fresh render, because the index grid advertised 7 apps while 54 shipped), OVER-PUBLISHING (withheld apps must not get a page — the withhold list once keyed off the filename and silently published an internal app), BROKEN NAVIGATION (every internal link must resolve to a file that exists, which is the failure a single-page build could not have), and ORPHANS (a delisted app must not keep a live page).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gen = require('../../scripts/site-product-pages.js') as {
  renderAll: (model: Model) => Map<string, string>;
  existingPages: () => string[];
  SITE: string;
  ROOTS: string[];
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const catalog = require('../../scripts/lib/product-site/catalog.js') as {
  build: () => Model;
  collectKernel: () => { published: App[]; withheld: App[] };
  summarize: (d: string, max?: number) => string;
  splitLead: (d: string) => { lead: string; rest: string };
  PRIVATE_APPS: Set<string>;
  COMMERCIAL_PACKAGES: Set<string>;
  STORE_DIR: string;
};

interface App { name: string; title: string; suite: string; summary: string; lead: string; origin: string; shelf?: { slug: string } }
interface Shelf { id: string; slug: string; label: string; apps: App[] }
interface Model { missingStore?: boolean; counts: Record<string, number>; shelves: Shelf[]; apps: App[] }

const REPO = path.resolve(__dirname, '..', '..');
const storePresent = fs.existsSync(path.join(catalog.STORE_DIR, 'marketplace.json'));
const model = catalog.build();

/** Every generated page, keyed by its site-relative path. Empty when the store trunk is absent. */
const rendered: Map<string, string> = model.missingStore ? new Map() : gen.renderAll(model);
const onDisk = gen.existingPages();

describe('product site: the committed pages match the manifests', () => {
  it.runIf(storePresent)('renders one page per app, per shelf, per platform topic, plus two hubs', () => {
    expect(model.missingStore).toBeFalsy();
    const paths = [...rendered.keys()].map((p) => p.split(path.sep).join('/'));
    expect(paths).toContain('product/index.html');
    expect(paths).toContain('platform/index.html');
    for (const app of model.apps) expect(paths).toContain(`product/apps/${app.name}/index.html`);
    for (const shelf of model.shelves) expect(paths).toContain(`product/${shelf.slug}/index.html`);
    // 2 hubs + shelves + apps + the 9 platform topics + the 2 guides
    expect(paths).toContain('install/index.html');
    expect(paths).toContain('build/index.html');
    expect(rendered.size).toBe(2 + model.shelves.length + model.apps.length + 9 + 2);
  });

  it.runIf(storePresent)('is byte-identical to what a fresh render produces', () => {
    const stale: string[] = [];
    for (const [rel, html] of rendered) {
      const full = path.join(gen.SITE, rel);
      if (!fs.existsSync(full) || fs.readFileSync(full, 'utf8') !== html) stale.push(rel);
    }
    expect(stale, `run: node scripts/site-product-pages.js`).toEqual([]);
  });

  it.runIf(storePresent)('leaves no orphaned page whose app has been delisted', () => {
    const orphans = onDisk.filter((rel) => !rendered.has(rel));
    expect(orphans, 'a delisted app must not keep selling itself on the public site').toEqual([]);
  });

  it('never lets a checkout without the store trunk shrink the site', () => {
    // The fail-SAFE property: a missing sibling repo must yield missingStore, NOT a model with
    // 47 application pages quietly absent.
    const original = process.env.OSHAL_STORE_DIR;
    process.env.OSHAL_STORE_DIR = path.join(REPO, 'does-not-exist');
    try {
      const mod = path.resolve(REPO, 'scripts', 'lib', 'product-site', 'catalog.js');
      delete require.cache[mod];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const reloaded = require(mod) as { build: () => Model };
      expect(reloaded.build().missingStore).toBe(true);
      delete require.cache[mod];
    } finally {
      if (original === undefined) delete process.env.OSHAL_STORE_DIR;
      else process.env.OSHAL_STORE_DIR = original;
    }
  });
});

describe('product site: nothing withheld ever gets a page', () => {
  it('gives no page to an app on the PRIVATE_APPS list', () => {
    expect(catalog.PRIVATE_APPS.size).toBeGreaterThan(0);
    const paths = onDisk.map((p) => p.split(path.sep).join('/'));
    for (const name of catalog.PRIVATE_APPS) {
      expect(paths).not.toContain(`product/apps/${name}/index.html`);
      expect(fs.existsSync(path.join(gen.SITE, 'product', 'apps', name))).toBe(false);
    }
  });

  it('withholds by manifest `name:`, not by filename — security-center lives in security.yaml', () => {
    // The exact shape of the original defect. A withhold list keyed on the filename passes a naive
    // test and publishes the app.
    expect(catalog.PRIVATE_APPS.has('security-center')).toBe(true);
    expect(fs.existsSync(path.join(REPO, 'swarm-apps', 'security.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(REPO, 'swarm-apps', 'security-center.yaml'))).toBe(false);
    const kernel = catalog.collectKernel();
    // The manifest must be READ and then withheld — not merely absent from the scan.
    expect(kernel.withheld.map((a) => a.name)).toContain('security-center');
    expect(kernel.published.map((a) => a.name)).not.toContain('security-center');
  });

  it('gives no page to a carved commercial package', () => {
    for (const name of catalog.COMMERCIAL_PACKAGES) {
      expect(fs.existsSync(path.join(gen.SITE, 'product', 'apps', name))).toBe(false);
    }
  });
});

describe('product site: every internal link resolves', () => {
  const linkRe = /href="(\/[^"#?]*)/g;

  it('has no dead internal link on any committed page', () => {
    expect(onDisk.length).toBeGreaterThan(0);
    const dead: string[] = [];
    for (const rel of onDisk) {
      const html = fs.readFileSync(path.join(gen.SITE, rel), 'utf8');
      for (const m of html.matchAll(linkRe)) {
        const href = m[1];
        // Directory URLs resolve to their index.html; a bare "/" is the site root page.
        const target = href.endsWith('/') ? `${href}index.html` : href;
        const full = path.join(gen.SITE, target);
        if (!fs.existsSync(full)) dead.push(`${rel} -> ${href}`);
      }
    }
    expect([...new Set(dead)]).toEqual([]);
  });

  it('every referenced screenshot exists and is tracked in git', () => {
    // A page that references /assets/foo.png with no such file publishes a broken image (and the
    // deploy's asset gate would fail). Assert every referenced asset is a real, tracked file.
    const tracked = new Set(
      execFileSync('git', ['ls-files', '--', 'site/oswarm.ai/assets'], { cwd: REPO, encoding: 'utf8' })
        .split(/\r?\n/).filter(Boolean),
    );
    const missing: string[] = [];
    for (const rel of onDisk) {
      const html = fs.readFileSync(path.join(gen.SITE, rel), 'utf8');
      for (const m of html.matchAll(/src="(\/assets\/[^"]+)"/g)) {
        const assetPath = `site/oswarm.ai${m[1]}`.replace(/\//g, path.sep === '\\' ? '/' : '/');
        const onDiskPath = path.join(gen.SITE, m[1]);
        if (!fs.existsSync(onDiskPath)) missing.push(`${rel} -> ${m[1]} (file missing)`);
        else if (!tracked.has(`site/oswarm.ai${m[1]}`)) missing.push(`${rel} -> ${m[1]} (untracked)`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it.runIf(storePresent)('the connectors page shows EVERY connector, not just the count', () => {
    // "308 connectors" as a number is a claim; the directory is the proof. The rendered directory
    // must carry exactly as many names as the tree has connector specs, or the page is under-showing.
    const html = fs.readFileSync(path.join(gen.SITE, 'platform', 'connectors', 'index.html'), 'utf8');
    const dir = html.split('class="directory"')[1] || '';
    const names = (dir.match(/<span>/g) || []).length;
    expect(names).toBe(model.counts.connectors);
    expect(dir).toContain('GitHub');
    expect(dir).toContain('Stripe');
  });

  it.runIf(storePresent)('the harnesses page names EVERY provider', () => {
    const html = fs.readFileSync(path.join(gen.SITE, 'platform', 'harnesses', 'index.html'), 'utf8');
    const seg = html.split('Every lane, named')[1] || '';
    const pills = (seg.match(/class="pill"/g) || []).length;
    expect(pills).toBe(model.counts.providers);
    expect(seg).toContain('Anthropic');
    expect(seg).toContain('OpenAI');
  });

  it('the catalog orb lists every app, each linking to a real app page', () => {
    // The hub orb is the completeness showcase — it must be the WHOLE catalog, and every node must
    // point at a page that exists. A silently-missing app (or a node linking nowhere) turns this red.
    const html = fs.readFileSync(path.join(gen.SITE, 'product', 'index.html'), 'utf8');
    const m = /<script id="orb-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    expect(m, 'the hub has no orb data island').toBeTruthy();
    const orb = JSON.parse(m![1]) as Array<{ t: string; u: string; c: string }>;
    expect(orb.length).toBe(model.apps.length);
    for (const node of orb) {
      expect(node.t.length, 'orb node title').toBeGreaterThan(0);
      expect(node.c, `orb node colour for ${node.t}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      const target = path.join(gen.SITE, node.u.replace(/\/$/, ''), 'index.html');
      expect(fs.existsSync(target), `orb node ${node.t} -> ${node.u} (page missing)`).toBe(true);
    }
  });

  it('declares a unique canonical URL on every page — no duplicate-content pages', () => {
    const seen = new Map<string, string>();
    for (const rel of onDisk) {
      const html = fs.readFileSync(path.join(gen.SITE, rel), 'utf8');
      const m = /<link rel="canonical" href="([^"]+)"/.exec(html);
      expect(m, `${rel} has no canonical`).toBeTruthy();
      const canonical = m![1];
      expect(seen.has(canonical), `${canonical} claimed by both ${seen.get(canonical)} and ${rel}`).toBe(false);
      seen.set(canonical, rel);
    }
  });

  it('has every generated page TRACKED in git, not just present on disk', () => {
    // The site deploys from the working tree, so a page can exist locally, publish fine, and be
    // absent from a fresh clone. That is exactly what happened to /build/: .gitignore's generic
    // `build/` artifact rule silently untracked it. On disk is not the same as shipped.
    const tracked = new Set(
      execFileSync('git', ['ls-files', '--', 'site/oswarm.ai'], { cwd: REPO, encoding: 'utf8' })
        .split(/\r?\n/).filter(Boolean).map((p) => p.replace(/\//g, path.sep)),
    );
    const untracked = onDisk.filter((rel) => !tracked.has(path.join('site', 'oswarm.ai', rel)));
    expect(
      untracked,
      'these generated pages are ignored or unstaged — a fresh clone would deploy without them',
    ).toEqual([]);
  });

  it('reaches the install and build guides from the shared nav on every page', () => {
    // The guides are the two pages a first-time visitor most needs, and they live outside the
    // /product and /platform trees — so a nav regression would strand them with no inbound link.
    for (const rel of onDisk) {
      const html = fs.readFileSync(path.join(gen.SITE, rel), 'utf8');
      expect(html.includes('href="/install/"'), `${rel} has no install link`).toBe(true);
      expect(html.includes('href="/build/"'), `${rel} has no build link`).toBe(true);
    }
  });

  it('gives every page a title and a meta description a search result can use', () => {
    for (const rel of onDisk) {
      const html = fs.readFileSync(path.join(gen.SITE, rel), 'utf8');
      const title = /<title>([^<]+)<\/title>/.exec(html);
      const desc = /<meta name="description" content="([^"]+)"/.exec(html);
      expect(title, `${rel} title`).toBeTruthy();
      expect(desc, `${rel} description`).toBeTruthy();
      expect(desc![1].length, `${rel} description too short`).toBeGreaterThan(50);
    }
  });
});

describe('product site: no page ships a hand-typed number or an unresolved token', () => {
  it('substitutes every %token% in the platform prose', () => {
    for (const rel of onDisk) {
      const html = fs.readFileSync(path.join(gen.SITE, rel), 'utf8');
      expect(/%(connectors|providers|apps|personas|adrs|shelves)%/.test(html), `${rel}`).toBe(false);
    }
  });

  it.runIf(storePresent)('takes the connector and persona counts off the tree', () => {
    const connectors = fs.readdirSync(path.join(REPO, 'swarm-apps', 'connectors')).filter((f) => f.endsWith('.yaml')).length;
    const personas = fs.readdirSync(path.join(REPO, 'ai-lab', 'bot-personas')).filter((f) => f.endsWith('.yaml')).length;
    expect(model.counts.connectors).toBe(connectors);
    expect(model.counts.personas).toBe(personas);
  });

  it.runIf(storePresent)('keeps the headline app count equal to the pages actually built', () => {
    expect(model.counts.apps).toBe(model.apps.length);
    expect(model.counts.apps).toBe(model.counts.kernelApps + model.counts.storeApps);
    const appPages = [...rendered.keys()].filter((p) => p.includes(`product${path.sep}apps${path.sep}`)).length;
    expect(appPages).toBe(model.counts.apps);
  });
});

describe('product site: copy never strands a fragment', () => {
  it('takes the next sentence when the first is too short to stand alone', () => {
    // "Ask what someone said." is a whole sentence and 22 characters; an earlier implementation
    // stopped there whenever the second sentence would overflow, leaving a fragment on a card.
    const short = 'Ask what someone said. Search every meeting transcript you own for the moment it came up, with the speaker and the timestamp attached.';
    expect(catalog.summarize(short).length).toBeGreaterThanOrEqual(55);
  });

  it('splits a description into a lead sentence and the remainder', () => {
    const { lead, rest } = catalog.splitLead('First thing it does. Second thing it does.');
    expect(lead).toBe('First thing it does.');
    expect(rest).toBe('Second thing it does.');
  });

  it.runIf(storePresent)('gives every app a usable card summary and page lead', () => {
    for (const app of model.apps) {
      expect(app.summary.length, `${app.name} summary`).toBeGreaterThanOrEqual(55);
      expect(app.lead.length, `${app.name} lead`).toBeGreaterThan(0);
      expect(app.shelf, `${app.name} has no shelf`).toBeTruthy();
    }
  });
});
