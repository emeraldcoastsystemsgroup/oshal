/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Route-level regression guard for /login?returnTo (operator report: a /cockpit/?app=intelligent-sales shortcut double-logged-in and landed appless on the bare cockpit). The stock express-openid-connect login route hardcoded returnTo=baseURL; server.ts now registers the loginHandler from @/shared/middleware/oidc instead. Mock mode redirects straight to the sanitized returnTo — same handler shape as real mode — so these tests go red if the route ever stops honoring a deep link or starts honoring an off-origin one.
 */

import { test, expect } from '@playwright/test';

test.describe('/login returnTo contract', () => {
  test('honors a same-origin returnTo (?app= deep link survives login)', async ({ request }) => {
    const target = '/cockpit/?app=intelligent-sales';
    const res = await request.get(`/login?returnTo=${encodeURIComponent(target)}`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toBe(target);
  });

  test('bare /login falls back to the root landing', async ({ request }) => {
    const res = await request.get('/login', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toBe('/');
  });

  test('rejects off-origin and protocol-relative returnTo values (open-redirect gate)', async ({ request }) => {
    for (const evil of ['https://evil.example/phish', '//evil.example/phish']) {
      const res = await request.get(`/login?returnTo=${encodeURIComponent(evil)}`, {
        maxRedirects: 0,
      });
      expect(res.status()).toBe(302);
      expect(res.headers()['location']).toBe('/');
    }
  });
});
