/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of Mock OIDC mode E2E tests
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BASE_URL fallback follows PLAYWRIGHT_PORT via the shared baseOrigin() helper instead of a hardcoded localhost:3456; APP_URL still wins when set (byte-identical under the default env)
 */

import { test, expect } from '@playwright/test';
import { baseOrigin } from './helpers';

/**
 * @description E2E tests for Mock OIDC mode. These tests verify that when
 * MOCK_OIDC=true, the application is fully accessible without Keycloak.
 * The server must be started with MOCK_OIDC=true for these tests to pass.
 */

const BASE_URL = process.env.APP_URL ?? baseOrigin();

test.describe('Mock OIDC Mode', () => {
  test('should serve the root page without authentication redirect', async ({ page }) => {
    const response = await page.goto(BASE_URL);
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    // Should NOT redirect to Keycloak login — should serve content directly
    expect(page.url()).not.toContain('keycloak');
    expect(page.url()).not.toContain('/login');
  });

  test('should serve chat.html without authentication redirect', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/chat.html`);
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    expect(page.url()).not.toContain('keycloak');
  });

  test('should return mock user from /api/user endpoint', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/user`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.authenticated).toBe(true);
    expect(body.user).toBeDefined();
    expect(body.user.preferred_username).toBe('devuser');
    expect(body.user.email).toBe('dev@localhost');
    expect(body.user.name).toBe('Dev User');
  });

  test('should allow access to /api/health without issues', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/health`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  test('should allow access to protected config API', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/config/providers`);
    // Should not return 401/302 — mock auth should allow through
    expect(response.status()).not.toBe(401);
    expect(response.status()).not.toBe(302);
  });

  test('should serve index.html without redirect', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/index.html`);
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    expect(page.url()).not.toContain('keycloak');
  });
});