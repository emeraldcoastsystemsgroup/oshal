/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the public product page's catalog
 *   generator. Two failure shapes are being pinned. (1) UNDER-CLAIMING: the index grid only ever
 *   read swarm-apps/, so the site advertised 7 apps while 54 shipped — the anti-drift rules call
 *   that as dishonest as over-claiming, so the committed island must stay equal to a fresh build.
 *   (2) OVER-PUBLISHING: site-apps-catalog.js once keyed its withhold list off the FILENAME
 *   (security.yaml) instead of the manifest `name:` (security-center) and silently published an
 *   operator-only app. Both assertions run against the REAL manifests, not a fixture of them —
 *   a guard over a hand-made copy of the app list could not have caught either bug.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gen = require('../../scripts/site-product-page.js') as {
  blurb: (description: string, max?: number) => string;
  collectKernel: () => { published: App[]; withheld: App[] };
  collectStore: () => { published: App[]; withheld: string[] } | null;
  build: () => BuildResult;
  readCommittedIsland: () => Island;
  PRIVATE_APPS: Set<string>;
  COMMERCIAL_PACKAGES: Set<string>;
  SUITES: Array<{ id: string; label: string; blurb: string }>;
  STORE_DIR: string;
};

interface App { name: string; title: string; suite: string; blurb: string; detail: string; origin: string; version?: string }
interface Island { counts: Record<string, number>; suites: Array<{ id: string }>; apps: App[]; platformApps: App[] }
interface BuildResult { missingStore?: boolean; counts: Record<string, number>; apps: App[]; platformApps: App[] }

const REPO = path.resolve(__dirname, '..', '..');
const island = gen.readCommittedIsland();
const storePresent = fs.existsSync(path.join(gen.STORE_DIR, 'marketplace.json'));

describe('product catalog: nothing withheld ever reaches the page', () => {
  it('publishes no app on the PRIVATE_APPS list', () => {
    expect(gen.PRIVATE_APPS.size).toBeGreaterThan(0);
    const published = new Set(island.apps.map((a) => a.name));
    for (const name of gen.PRIVATE_APPS) expect(published.has(name)).toBe(false);
  });

  it('withholds by manifest `name:`, not by filename — security-center lives in security.yaml', () => {
    // The exact shape of the original defect: the file is security.yaml, the app is security-center.
    // A withhold list keyed on the filename passes a naive test and publishes the app.
    expect(gen.PRIVATE_APPS.has('security-center')).toBe(true);
    expect(fs.existsSync(path.join(REPO, 'swarm-apps', 'security.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(REPO, 'swarm-apps', 'security-center.yaml'))).toBe(false);

    const kernel = gen.collectKernel();
    // The manifest must actually be READ and then withheld — not simply absent from the scan.
    expect(kernel.withheld.map((a) => a.name)).toContain('security-center');
    expect(kernel.published.map((a) => a.name)).not.toContain('security-center');
  });

  it('publishes no carved commercial package', () => {
    const published = new Set(island.apps.map((a) => a.name));
    for (const name of gen.COMMERCIAL_PACKAGES) expect(published.has(name)).toBe(false);
  });
});

describe('product catalog: the committed page matches the manifests', () => {
  it('lists every published kernel app, with the blurb the manifest yields today', () => {
    // Runs everywhere, store trunk or not: kernel manifests live in THIS repo. Editing a manifest
    // description without regenerating, or hand-editing a tile, turns this red.
    const kernel = gen.collectKernel();
    expect(kernel.published.length).toBeGreaterThan(0);
    const byName = new Map(island.apps.map((a) => [a.name, a]));
    for (const app of kernel.published) {
      const shipped = byName.get(app.name);
      expect(shipped, `${app.name} is missing from the committed catalog`).toBeDefined();
      expect(shipped!.title).toBe(app.title);
      expect(shipped!.blurb).toBe(app.blurb);
      expect(shipped!.origin).toBe('kernel');
    }
  });

  it.runIf(storePresent)('is byte-identical to a fresh full build when the store trunk is present', () => {
    const fresh = gen.build();
    expect(fresh.missingStore).toBeFalsy();
    expect(JSON.stringify(fresh.apps)).toBe(JSON.stringify(island.apps));
    expect(fresh.counts).toEqual(island.counts);
  });

  it('never lets a checkout without the store trunk shrink the published catalog', () => {
    // The fail-SAFE property: main() must leave the committed island alone rather than rewriting it
    // from kernel manifests only. Proven by pointing the collector at a directory with no registry.
    const original = process.env.OSHAL_STORE_DIR;
    process.env.OSHAL_STORE_DIR = path.join(REPO, 'does-not-exist');
    try {
      // A fresh module instance picks up the env var at load time.
      const isolated = path.resolve(REPO, 'scripts', 'site-product-page.js');
      delete require.cache[isolated];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const reloaded = require(isolated) as { build: () => BuildResult };
      expect(reloaded.build().missingStore).toBe(true);
      delete require.cache[isolated];
    } finally {
      if (original === undefined) delete process.env.OSHAL_STORE_DIR;
      else process.env.OSHAL_STORE_DIR = original;
    }
  });
});

describe('product catalog: counts come off the tree', () => {
  it('counts connectors by reading the directory, not by asserting a number', () => {
    const actual = fs.readdirSync(path.join(REPO, 'swarm-apps', 'connectors'))
      .filter((f) => f.endsWith('.yaml')).length;
    expect(island.counts.connectors).toBe(actual);
  });

  it('counts personas and ADRs off the tree', () => {
    const personas = fs.readdirSync(path.join(REPO, 'ai-lab', 'bot-personas'))
      .filter((f) => f.endsWith('.yaml')).length;
    const adrs = fs.readdirSync(path.join(REPO, 'docs', 'adr')).filter((f) => f.endsWith('.md')).length;
    expect(island.counts.personas).toBe(personas);
    expect(island.counts.adrs).toBe(adrs);
  });

  it('headline app count equals the tiles actually rendered — the page cannot claim more than it shows', () => {
    expect(island.counts.apps).toBe(island.apps.length);
    expect(island.counts.apps).toBe(island.counts.kernelApps + island.counts.storeApps);
  });

  it('counts only POPULATED user-facing shelves — the reserved `platform` shelf is not one', () => {
    const shelves = new Set(island.apps.map((a) => a.suite));
    const populated = gen.SUITES.filter((s) => s.id !== 'platform' && shelves.has(s.id)).length;
    expect(island.counts.suites).toBe(populated);
    // The assistant still earns a tile, and is the only thing on the reserved shelf.
    expect(island.apps.filter((a) => a.suite === 'platform').length).toBe(island.platformApps.length);
  });
});

describe('product catalog: every tile is renderable', () => {
  it('gives every app a title, a blurb and a full detail body', () => {
    expect(island.apps.length).toBeGreaterThan(0);
    for (const app of island.apps) {
      expect(app.title.length, `${app.name} title`).toBeGreaterThan(0);
      expect(app.blurb.length, `${app.name} blurb`).toBeGreaterThan(0);
      expect(app.detail.length, `${app.name} detail`).toBeGreaterThanOrEqual(app.blurb.length);
      expect(app.suite.length, `${app.name} suite`).toBeGreaterThan(0);
    }
  });

  it('assigns every app to a shelf the page can label', () => {
    const known = new Set(gen.SUITES.map((s) => s.id));
    for (const app of island.apps) expect(known.has(app.suite), `${app.name} → ${app.suite}`).toBe(true);
  });
});

describe('product catalog: blurbs never strand a fragment on a tile', () => {
  it('takes the next sentence when the first one is too short to stand alone', () => {
    // The real regression: "Ask what someone said." is a whole sentence and 22 characters. The
    // first implementation stopped there whenever the SECOND sentence would overflow the cap,
    // leaving a tile with a fragment on it.
    const short = 'Ask what someone said. ' + 'Search every meeting transcript you own for the moment it came up, with the speaker and the timestamp attached.';
    expect(gen.blurb(short).length).toBeGreaterThanOrEqual(55);
  });

  it('stops on a sentence boundary once it has enough, rather than always truncating', () => {
    const long = 'A complete first sentence that comfortably carries the whole idea on its own without help. Second sentence that should never be reached.';
    expect(gen.blurb(long)).not.toContain('Second sentence');
    expect(gen.blurb(long)).not.toContain('…');
  });

  it('caps the blurb and marks the cut, so a tile cannot grow without bound', () => {
    const runOn = 'A single enormous sentence with no terminator in sight that just keeps going and going well past any reasonable tile width and shows no sign at all of ever stopping anywhere near soon';
    const out = gen.blurb(runOn);
    expect(out.length).toBeLessThanOrEqual(151);
    expect(out.endsWith('…')).toBe(true);
  });

  it('every shipped blurb clears the fragment floor', () => {
    for (const app of island.apps) {
      expect(app.blurb.length, `${app.name}: "${app.blurb}"`).toBeGreaterThanOrEqual(55);
    }
  });
});
