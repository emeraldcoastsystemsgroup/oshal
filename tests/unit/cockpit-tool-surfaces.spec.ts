/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the four new cockpit tool surfaces (budgets/notify/dlq/my-data). Pins the two properties the whole deploy-free approach rests on: (1) the cockpit's own express.static mount serves src/pages/cockpit/tools/*.html at /cockpit/tools/<name>.html AND it is behind requiresAuth, so no Express route and no image rebuild are needed and the pages are never anonymously readable; (2) each page consumes framework theme tokens read-only via the shared bootstrap (data-theme default on <html>, surface-themes.css, surface-theme.js) with surface-glass.css loaded AFTER its own styles, and composites any element that covers scrolling content over an opaque colour instead of using the deliberately-translucent --bg-card directly. Also pins that each ribbon entry's iframeUrl resolves to a file that exists — a typo there is a blank tool nobody notices.
 */

import { describe, expect, it } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { registerCockpitStaticRoutes } from '@/app/routes/cockpit-static-routes';

/** Native fetch captured before any test could stub the global. */
const realFetch = globalThis.fetch;

const SURFACES = ['budgets', 'notify', 'dlq', 'my-data'] as const;
const TOOLS_DIR = path.join(process.cwd(), 'src/pages/cockpit/tools');
const RIBBON_NAV = path.join(process.cwd(), 'src/pages/cockpit/js/components/RibbonNav.js');

function readSurface(name: string): string {
  return readFileSync(path.join(TOOLS_DIR, `${name}.html`), 'utf8');
}

/** requiresAuth stub mirroring OIDC: 401 without a session, pass through with one. */
function requiresAuthFor(user: Record<string, string> | null) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (!user) { res.status(401).send('unauthorized'); return; }
    next();
  };
}

/** Mount the REAL cockpit static registration over the real source tree and fetch one path. */
async function fetchThroughCockpitMount(
  user: Record<string, string> | null,
  urlPath: string,
): Promise<{ status: number; body: string }> {
  const app = express();
  registerCockpitStaticRoutes({
    app,
    requiresAuth: requiresAuthFor(user),
    cockpitDir: path.join(process.cwd(), 'src/pages/cockpit'),
    uiEnhancedDir: path.join(process.cwd(), 'any-bot/ui-enhanced'),
    codiconFontsDir: path.join(process.cwd(), 'node_modules/@vscode/codicons/dist'),
    sharedUiCssDir: path.join(process.cwd(), 'src/shared/ui/css'),
    sharedUiJsDir: path.join(process.cwd(), 'src/shared/ui/js'),
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}${urlPath}`);
    return { status: res.status, body: await res.text() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('cockpit tool surfaces — served by the cockpit static mount, behind auth', () => {
  it.each(SURFACES)('serves /cockpit/tools/%s.html to an authenticated caller with no new route', async (name) => {
    const res = await fetchThroughCockpitMount({ sub: 'a-user' }, `/cockpit/tools/${name}.html`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<!doctype html>');
    expect(res.body).toContain('/shared/ui/css/surface-themes.css');
  });

  it.each(SURFACES)('refuses /cockpit/tools/%s.html to an anonymous caller (401, no body)', async (name) => {
    const res = await fetchThroughCockpitMount(null, `/cockpit/tools/${name}.html`);
    expect(res.status).toBe(401);
    expect(res.body).not.toContain('<!doctype html>');
  });
});

describe('cockpit tool surfaces — theming contract', () => {
  it.each(SURFACES)('%s.html sets a default data-theme on <html> (theme files have no :root fallback)', (name) => {
    const html = readSurface(name);
    expect(html).toMatch(/<html[^>]+data-theme="[a-z-]+"/);
  });

  it.each(SURFACES)('%s.html loads the shared theme bootstrap so it follows the cockpit theme live', (name) => {
    const html = readSurface(name);
    expect(html).toContain('/shared/ui/css/surface-themes.css');
    expect(html).toContain('/shared/ui/js/surface-theme.js');
  });

  it.each(SURFACES)('%s.html loads surface-glass.css AFTER its own <style> block', (name) => {
    const html = readSurface(name);
    const styleEnd = html.indexOf('</style>');
    const glass = html.indexOf('/shared/ui/css/surface-glass.css');
    expect(styleEnd).toBeGreaterThan(-1);
    expect(glass).toBeGreaterThan(styleEnd);
  });

  it.each(SURFACES)('%s.html derives its palette from framework tokens, never a hardcoded one', (name) => {
    const html = readSurface(name);
    expect(html).toContain('--bg-primary');
    expect(html).toContain('--text-primary');
    expect(html).toContain('--border-color');
  });

  it.each(SURFACES)('%s.html never paints a covering element with the translucent --bg-card alone', (name) => {
    // --bg-card is DELIBERATELY translucent (cockpit chrome is glass over the page). Anything that
    // covers the surface's own scrolling content — a sticky header, a tile, a modal — must composite
    // its themed tint over an opaque colour. The repo's own shipped bug was doing this the naive way
    // and only noticing against CSS fallbacks, which are opaque. Every rule here that sets
    // `position: sticky` must therefore also carry the composite.
    const html = readSurface(name);
    const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const rules = styleBlock.split('}');
    for (const rule of rules) {
      if (!/position:\s*sticky/.test(rule)) continue;
      expect(rule, `sticky rule in ${name}.html must composite over an opaque colour`).toMatch(
        /background:\s*var\(--bg\)\s*var\(--solid-panel\)/,
      );
    }
  });
});

describe('ribbon registration — every new tool entry points at a file that exists', () => {
  const ribbon = readFileSync(RIBBON_NAV, 'utf8');
  const urls = [...ribbon.matchAll(/iframeUrl:\s*'(\/cockpit\/tools\/[^']+)'/g)].map((m) => m[1]);

  it('registers all four tool surfaces in the platform-tools list', () => {
    expect(urls).toHaveLength(SURFACES.length);
    for (const name of SURFACES) {
      expect(urls).toContain(`/cockpit/tools/${name}.html`);
    }
  });

  it('every registered /cockpit/tools/ url resolves to a real file on disk', () => {
    for (const url of urls) {
      const onDisk = path.join(process.cwd(), 'src/pages', url.replace(/^\/cockpit\//, 'cockpit/'));
      expect(existsSync(onDisk), `${url} -> ${onDisk}`).toBe(true);
    }
  });

  it('the operator-only Dead Letters entry is gated on the resolved operator flag', () => {
    // The DLQ routes are all requiresOperator, so pinning it into a basic user's rail would offer a
    // tool that can only ever answer 403. The surface self-gates too; this keeps the rail honest.
    const gate = ribbon.indexOf('if (this.isOperator)');
    const dlqEntry = ribbon.indexOf("id: 'tool-dlq'");
    expect(gate).toBeGreaterThan(-1);
    expect(dlqEntry).toBeGreaterThan(gate);
    expect(ribbon).toContain('/api/cli-tokens/whoami');
  });
});
