/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the /api JSON 404 catch-all. Unknown /api/* paths used to fall through to Express's default HTML "<!DOCTYPE" 404 page, which cockpit fetch handlers surfaced to the operator as `SyntaxError: Unexpected token '<'` (seen live on the super-admin dev-console pane when a conditionally-mounted route was absent). These tests go red if any unmatched /api path ever answers HTML again.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Boot-window awareness (sat-ops /api/sat/app 404-during-autoload report): the fallback now answers 503 until swarm-app auto-load settles, so the live tests first wait out any 503s (asserting the boot-window JSON shape while doing so), then assert the settled JSON 404. Source guard re-anchored on createApiFallbackHandler. Unit-level coverage of both regimes: tests/unit/api-fallback.spec.ts.
 */

import { test, expect, APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @description Waits out the server's boot window: until swarm-app auto-load settles, the /api
 * fallback answers 503 (asserted JSON + Retry-After here — the fetch shape must never get HTML
 * in EITHER regime). Returns the first non-503 response.
 * @param request - Playwright API request context.
 * @param bogusPath - An /api path guaranteed to match no route.
 * @returns The first non-503 response for bogusPath.
 */
async function getSettledResponse(request: APIRequestContext, bogusPath: string) {
  // Upper bound: the fallback's own safety valve (OSHAL_API_BOOT_WINDOW_MS, default 180s)
  // guarantees 404s by then even on a box whose DB never comes up (CI is DB-less, and the
  // bounded bootstrap wait alone can hold the window open for minutes without the valve).
  const deadline = Date.now() + 240_000;
  for (;;) {
    const res = await request.get(bogusPath);
    if (res.status() !== 503) return res;
    // Boot-window contract: fallback 503s are JSON + Retry-After for fetch callers.
    expect(res.headers()['content-type'] ?? '').toContain('application/json');
    expect(res.headers()['retry-after']).toBeTruthy();
    expect(Date.now(), 'swarm-app auto-load never settled — /api fallback stuck on 503').toBeLessThan(deadline);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// The first test may legitimately spend up to the full boot window polling before the
// fallback settles (see getSettledResponse); the default 30s test timeout cannot cover it.
test.describe.configure({ timeout: 300_000 });

// ── Live behavior: an unmatched /api path answers JSON, never "<!DOCTYPE" ──
test.describe('unknown /api paths return JSON 404, never HTML', () => {
  const bogusPath = '/api/definitely-not-a-registered-route-guard';

  test('GET unknown /api path → 404 application/json with an error field', async ({ request }) => {
    const res = await getSettledResponse(request, bogusPath);
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type'] ?? '').toContain('application/json');
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('<!DOCTYPE');
  });

  test('POST unknown /api path → 404 application/json (the DOCTYPE repro shape)', async ({ request }) => {
    // POST is the shape that bit the super-admin dev-console pane: a fetch().then(r => r.json())
    // against an unmounted route. The body must parse as JSON — an HTML page here regresses
    // the operator-facing `Unexpected token '<'` bug.
    await getSettledResponse(request, bogusPath);
    const res = await request.post(bogusPath, { data: { probe: true } });
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type'] ?? '').toContain('application/json');
    const text = await res.text();
    expect(text).not.toContain('<!DOCTYPE');
    expect(() => JSON.parse(text)).not.toThrow();
  });

  test('unknown nested /api path (conditional-mount shape) → JSON 404', async ({ request }) => {
    // Mirrors a conditionally-mounted namespace being absent (e.g. /api/dev-console when
    // OSHAL_DEV_CONSOLE_ENABLED is unset) without depending on this box's flag state.
    await getSettledResponse(request, bogusPath);
    const res = await request.post('/api/never-mounted-namespace/sessions', { data: {} });
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type'] ?? '').toContain('application/json');
  });
});

// ── Source-level guard: the catch-all stays registered LAST in the /api chain ──
test.describe('server.ts keeps the /api JSON 404 catch-all', () => {
  test('catch-all exists and precedes only the final error handler', async () => {
    const src = fs.readFileSync(
      path.join(path.resolve(__dirname, '..'), 'src/app/server.ts'),
      'utf-8',
    );
    const catchAllIdx = src.indexOf("app.use('/api', createApiFallbackHandler(");
    expect(catchAllIdx, 'the /api fallback (boot-window 503 / settled JSON 404) must exist in server.ts').toBeGreaterThan(-1);
    // No route mounts may be registered after it (dynamic app-package routes ride the
    // ManifestRouteMounterImpl dispatcher installed earlier, so they are unaffected).
    const after = src.slice(catchAllIdx);
    const laterApiMounts = after.match(/app\.use\('\/api\//g) ?? [];
    expect(laterApiMounts.length, 'no /api mounts may come after the JSON 404 catch-all').toBe(0);
  });

  test('jarvis-orb parses dev-console responses tolerantly (no raw r.json())', async () => {
    const orb = fs.readFileSync(
      path.join(path.resolve(__dirname, '..'), 'src/pages/cockpit/js/jarvis-orb.js'),
      'utf-8',
    );
    expect(orb).toContain('function parseJsonResponse(');
    // The two calls that used to surface "<!DOCTYPE" as a SyntaxError must stay on the
    // tolerant parser: session start + commit.
    expect(orb).not.toMatch(/sessions',\s*\{[\s\S]{0,200}?\}\)\.then\(function \(r\) \{ return r\.json\(\)/);
  });
});
