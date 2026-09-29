/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of authentication tests
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BASE_URL follows PLAYWRIGHT_PORT via the shared baseOrigin() helper instead of a hardcoded localhost:3456 (byte-identical under the default env)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Retired the 'Auth-Enabled Server — Protected Routes' block. It spawned `node src/api/server.js` on a fixed localhost:3457, but that server no longer exists and ADR-003's API-key mechanism is superseded (ADR-003 status, corrected 2026-09-14): no product code imports src/api/auth-middleware.js and the real server authenticates through OIDC requiresAuth. The block could only fail on a spawn of a missing file; the disposition is recorded in tests/e2e-dispositions.json. The block's spawn/wait helpers and its self-built origin went with it.
 */

import { test, expect } from '@playwright/test';
import { baseOrigin } from './helpers';

const BASE_URL = baseOrigin();

// ============================================================
// 1. Unit Tests: Auth Middleware (no server needed)
// ============================================================

test.describe('Unit — Auth Middleware', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    validateRequest,
    extractBearerToken,
    timingSafeCompare,
  } = require('../src/api/auth-middleware');

  test('validateRequest allows all when no key configured', () => {
    const mockReq = { headers: {}, method: 'GET', url: '/api/config' };
    const result = validateRequest(mockReq, null);
    expect(result.authenticated).toBe(true);
  });

  test('validateRequest rejects missing Authorization header', () => {
    const mockReq = { headers: {}, method: 'GET', url: '/api/config' };
    const result = validateRequest(mockReq, 'my-secret-key');
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain('Missing or invalid');
  });

  test('validateRequest rejects wrong key', () => {
    const mockReq = {
      headers: { authorization: 'Bearer wrong-key' },
      method: 'GET',
      url: '/api/config',
    };
    const result = validateRequest(mockReq, 'correct-key');
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain('Invalid API key');
  });

  test('validateRequest accepts correct key', () => {
    const mockReq = {
      headers: { authorization: 'Bearer correct-key' },
      method: 'GET',
      url: '/api/config',
    };
    const result = validateRequest(mockReq, 'correct-key');
    expect(result.authenticated).toBe(true);
  });

  test('extractBearerToken returns null for missing header', () => {
    expect(extractBearerToken({ headers: {} })).toBeNull();
  });

  test('extractBearerToken returns null for non-Bearer scheme', () => {
    expect(extractBearerToken({ headers: { authorization: 'Basic abc123' } })).toBeNull();
  });

  test('extractBearerToken extracts token correctly', () => {
    expect(extractBearerToken({ headers: { authorization: 'Bearer my-token' } })).toBe('my-token');
  });

  test('timingSafeCompare returns true for equal strings', () => {
    expect(timingSafeCompare('hello', 'hello')).toBe(true);
  });

  test('timingSafeCompare returns false for different strings', () => {
    expect(timingSafeCompare('hello', 'world')).toBe(false);
  });

  test('timingSafeCompare returns false for different lengths', () => {
    expect(timingSafeCompare('short', 'a-much-longer-string')).toBe(false);
  });

  test('timingSafeCompare handles non-string inputs', () => {
    expect(timingSafeCompare(null as any, 'hello')).toBe(false);
    expect(timingSafeCompare('hello', undefined as any)).toBe(false);
  });
});

// ============================================================
// 2. Default Server: Auth Disabled (no AUTH_API_KEY)
// ============================================================

test.describe('Default Server — Auth Disabled', () => {
  // The default test server (started by playwright.config.ts) has no AUTH_API_KEY
  // All requests should succeed without auth headers

  test('GET /api/status succeeds without auth header', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/status`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  test('POST /api/config succeeds without auth header', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/config`, {
      data: { testKey: 'testValue' },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  test('GET /api/config succeeds without auth header', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/config`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  test('DELETE /api/config succeeds without auth header', async ({ request }) => {
    const response = await request.delete(`${BASE_URL}/api/config`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  test('static files served without auth', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/ui.html`);
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain('Cline API Configuration');
  });
});

// ============================================================
// 3. Auth-Enabled Server — RETIRED
// ============================================================
// This block spawned `node src/api/server.js` with AUTH_API_KEY on localhost:3457 and asserted
// the ADR-003 bearer-key contract. That server no longer exists and ADR-003 is superseded: the real
// server (src/app/server.ts) authenticates through OIDC requiresAuth, and no product code
// imports src/api/auth-middleware.js. Route authentication is guarded where it now lives
// (tests/security-review-fixes.spec.ts, tests/unit/server-route-auth-inventory.spec.ts). The
// disposition is recorded in tests/e2e-dispositions.json.

// ============================================================
// 4. UI — Auth Key Input
// ============================================================

test.describe('UI — Authentication Key Input', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui.html');
  });

  test('auth section is visible on page load', async ({ page }) => {
    await expect(page.locator('#auth-section')).toBeVisible();
    await expect(page.locator('#auth-api-key')).toBeVisible();
  });

  test('auth input is password type by default', async ({ page }) => {
    const input = page.locator('#auth-api-key');
    await expect(input).toHaveAttribute('type', 'password');
  });

  test('toggle button switches input visibility', async ({ page }) => {
    const input = page.locator('#auth-api-key');
    const toggleBtn = page.locator('#auth-toggle-btn');

    await expect(input).toHaveAttribute('type', 'password');
    await toggleBtn.click();
    await expect(input).toHaveAttribute('type', 'text');
    await toggleBtn.click();
    await expect(input).toHaveAttribute('type', 'password');
  });

  test('auth status updates when key is entered', async ({ page }) => {
    const input = page.locator('#auth-api-key');
    const status = page.locator('#auth-status');

    await expect(status).toHaveText('Not set');
    await input.fill('my-test-key');
    await expect(status).toHaveText('Key set');
  });

  test('auth key persists in localStorage', async ({ page }) => {
    const input = page.locator('#auth-api-key');
    await input.fill('persisted-key');

    const stored = await page.evaluate(() => localStorage.getItem('authApiKey'));
    expect(stored).toBe('persisted-key');
  });

  test('auth key is restored from localStorage on reload', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('authApiKey', 'restored-key'));
    await page.reload();
    
    const input = page.locator('#auth-api-key');
    await expect(input).toHaveValue('restored-key');
    
    const status = page.locator('#auth-status');
    await expect(status).toHaveText('Key loaded from storage');
  });
});