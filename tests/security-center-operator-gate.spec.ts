/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Security Center is operator-only (operator decision 2026-07-07): a signed-in BASIC user must get 403 from every /api/security endpoint — the findings map the platform's own weak points (secret previews, ungated routes).
 */

/**
 * @description
 * Live gate check against the isolated MOCK_OIDC server: the mock session user
 * (mock-user-001) is authenticated but NOT on the operator allowlist, so the whole
 * /api/security mount — page, status, findings, and the scan trigger — must deny
 * with 403. This is the boundary that keeps basic users from reading the platform's
 * own vulnerability map; the manifest's scope:operator only hides the catalog entry.
 */

import { test, expect } from '@playwright/test';

test.describe('Security Center — operator-only mount', () => {
  test('a signed-in basic user is denied on every /api/security surface', async ({ request }) => {
    for (const probe of [
      { method: 'get' as const, url: '/api/security/' },          // the app page itself
      { method: 'get' as const, url: '/api/security/status' },    // finding counts
      { method: 'get' as const, url: '/api/security/findings' },  // the findings list
    ]) {
      const res = await request[probe.method](probe.url);
      expect(res.status(), `${probe.url} must be operator-only`).toBe(403);
    }
    const scan = await request.post('/api/security/scan', { data: {} });
    expect(scan.status(), 'running a scan must be operator-only').toBe(403);
    expect(await scan.json()).toEqual({ error: 'Operator privilege required' });
  });
});
