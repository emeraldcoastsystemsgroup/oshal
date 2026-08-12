/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the in-product help hub. The defects this exists to catch: (a) a `?for=<surface>` deep link that points at a guide nobody wrote, which sends a stuck user to a 404 — the whole reason the hub exists; (b) slug traversal reaching outside docs/guides; (c) the image shipping WITHOUT docs/guides, which renders the hub 503 on a deployed box while it works perfectly from a checkout — the config/artifact boundary the real-boundary rule says to probe rather than assume; (d) a guide file that exists but is a stub. Uses the real filesystem and the real Dockerfile, not mocks, because those are precisely the boundaries that fail.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  guideForSurface,
  listGuides,
  resolveGuideFile,
  resolveGuidesDir,
} from '@/app/routes/help-routes';

describe('in-product help hub', () => {
  const dir = resolveGuidesDir();

  it('resolves the guides corpus from a checkout', () => {
    expect(dir).toBeTruthy();
    expect(listGuides(dir as string).length).toBeGreaterThan(0);
  });

  it('lists guides with real titles and excludes the hub README', () => {
    const guides = listGuides(dir as string);
    expect(guides.some((g) => g.slug === 'README')).toBe(false);
    for (const g of guides) {
      expect(g.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(g.title.trim().length).toBeGreaterThan(2);
      // The hub strips the "— user guide (as-built)" suffix; a title left carrying it means the
      // nav renders the boilerplate instead of the screen name.
      expect(g.title).not.toMatch(/user guide \(as-built\)/i);
    }
  });

  // The deep-link contract is the point of the hub: a screen hands the reader to its own page.
  // A mapping to a guide nobody wrote is a 404 at exactly the moment the user needed help.
  it('every surface deep link resolves to a guide that exists', () => {
    const surfaces = [
      'intelligent-processing', 'tool-token-chase', 'optimizer', 'jarvis', 'tickets', 'calendar',
      'chat', 'swarm-messages', 'settings', 'config-admin', 'security', 'security-center',
      'devops', 'devops-vault', 'cloud', 'utilities', 'connectors', 'identity', 'identity-home',
      'files', 'storage', 'test-lab', 'ai-test-lab', 'eval-wall', 'search', 'run-trace',
      'budgets', 'notifications', 'my-data', 'dlq',
    ];
    const dead: string[] = [];
    for (const surface of surfaces) {
      const slug = guideForSurface(surface);
      if (!slug || !resolveGuideFile(dir as string, slug)) dead.push(`${surface} → ${slug ?? '(unmapped)'}`);
    }
    expect(dead).toEqual([]);
  });

  it('refuses traversal and unknown slugs instead of reading arbitrary files', () => {
    for (const bad of ['../README', '../../package', 'a/b', '.env', '', 'UPPER', 'has.dot', '/etc/passwd']) {
      expect(resolveGuideFile(dir as string, bad)).toBeNull();
    }
    expect(resolveGuideFile(dir as string, 'definitely-not-a-guide')).toBeNull();
  });

  it('serves every guide as substantive content, not a stub', () => {
    for (const g of listGuides(dir as string)) {
      const body = readFileSync(resolveGuideFile(dir as string, g.slug) as string, 'utf8');
      expect(body.length, `${g.slug} is a stub`).toBeGreaterThan(1200);
      // Every guide must tell the reader how to reach the screen — the first thing they need.
      expect(body.slice(0, 900), `${g.slug} does not open with how to reach it`).toMatch(/open|click|cockpit|ribbon|\/api\//i);
    }
  });

  // Artifact probe, not an assumption: docs/ is a COPY allowlist in the image, so a help hub that
  // reads docs/guides at runtime is 503 on a deployed box unless the Dockerfile ships the corpus.
  it('the image ships the guides the hub reads', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile.oshal'), 'utf8');
    expect(dockerfile).toMatch(/^COPY docs\/guides\/ \.\/docs\/guides\/$/m);
  });

  it('is reachable from the cockpit ribbon', () => {
    const ribbon = readFileSync(resolve(process.cwd(), 'src/pages/cockpit/js/components/RibbonNav.js'), 'utf8');
    expect(ribbon).toContain("id: 'tool-help'");
    expect(ribbon).toContain("iframeUrl: '/api/help'");
  });

  it('is mounted auth-gated, never anonymous-callable', () => {
    const server = readFileSync(resolve(process.cwd(), 'src/app/server.ts'), 'utf8');
    expect(server).toMatch(/app\.use\('\/api\/help',\s*requiresAuth,\s*createHelpRoutes\(\)\)/);
  });
});
