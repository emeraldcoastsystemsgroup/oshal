/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of authentication tests
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BASE_URL follows PLAYWRIGHT_PORT via the shared baseOrigin() helper instead of a hardcoded localhost:3456 (byte-identical under the default env)
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as path from 'path';
import { baseOrigin } from './helpers';

const BASE_URL = baseOrigin();
const TEST_API_KEY = 'test-api-key-12345';

// ============================================================
// Helpers
// ============================================================

/**
 * Start a test server with AUTH_API_KEY set, returns the child process.
 * We use a separate port to avoid conflicts with the default server.
 */
const AUTH_PORT = 3457;
const AUTH_BASE_URL = `http://localhost:${AUTH_PORT}`;

function startAuthServer(): ReturnType<typeof import('child_process').spawn> {
  const { spawn } = require('child_process');
  const serverPath = path.resolve(__dirname, '../src/api/server.js');
  const outputDir = path.resolve(__dirname, '../output/auth-test');
  
  const child = spawn('node', [serverPath], {
    env: {
      ...process.env,
      AUTH_API_KEY: TEST_API_KEY,
      PORT: String(AUTH_PORT),
      CONFIG_OUTPUT_DIR: outputDir,
      CONFIG_WRITE_MODE: 'split',
    },
    stdio: 'pipe',
  });

  return child;
}

async function waitForServer(url: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${url}/api/status`);
      if (resp.ok || resp.status === 401) return;
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

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
// 3. Auth-Enabled Server: Rejection & Acceptance
// ============================================================

test.describe('Auth-Enabled Server — Protected Routes', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn>;

  test.beforeAll(async () => {
    // Clean up output dir
    const fs = require('fs');
    const outputDir = path.resolve(__dirname, '../output/auth-test');
    if (fs.existsSync(outputDir)) {
      fs.rmSync(outputDir, { recursive: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });

    serverProcess = startAuthServer();
    await waitForServer(AUTH_BASE_URL);
  });

  test.afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      // Wait for process to exit
      await new Promise<void>(resolve => {
        serverProcess.on('exit', () => resolve());
        setTimeout(() => resolve(), 2000);
      });
    }
  });

  // --- Rejection tests ---

  test('GET /api/status returns 401 without auth header', async ({ request }) => {
    const response = await request.get(`${AUTH_BASE_URL}/api/status`);
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Missing or invalid');
  });

  test('POST /api/config returns 401 without auth header', async ({ request }) => {
    const response = await request.post(`${AUTH_BASE_URL}/api/config`, {
      data: { test: 'value' },
    });
    expect(response.status()).toBe(401);
  });

  test('GET /api/config returns 401 with wrong key', async ({ request }) => {
    const response = await request.get(`${AUTH_BASE_URL}/api/config`, {
      headers: { Authorization: 'Bearer wrong-key' },
    });
    expect(response.status()).toBe(401);
    const body = await response.json();
    expect(body.error).toContain('Invalid API key');
  });

  test('DELETE /api/config returns 401 without auth', async ({ request }) => {
    const response = await request.delete(`${AUTH_BASE_URL}/api/config`);
    expect(response.status()).toBe(401);
  });

  // --- Acceptance tests ---

  test('GET /api/status succeeds with correct auth header', async ({ request }) => {
    const response = await request.get(`${AUTH_BASE_URL}/api/status`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  test('POST /api/config succeeds with correct auth header', async ({ request }) => {
    const response = await request.post(`${AUTH_BASE_URL}/api/config`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
      data: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  test('GET /api/config succeeds with correct auth header', async ({ request }) => {
    const response = await request.get(`${AUTH_BASE_URL}/api/config`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.config).toBeDefined();
  });

  test('DELETE /api/config succeeds with correct auth header', async ({ request }) => {
    const response = await request.delete(`${AUTH_BASE_URL}/api/config`, {
      headers: { Authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  test('static files served without auth even when auth enabled', async ({ request }) => {
    const response = await request.get(`${AUTH_BASE_URL}/ui.html`);
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain('Cline API Configuration');
  });

  test('OPTIONS requests pass without auth (CORS preflight)', async ({ request }) => {
    const response = await request.fetch(`${AUTH_BASE_URL}/api/config`, {
      method: 'OPTIONS',
    });
    expect(response.status()).toBe(200);
  });
});

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