/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the Antigravity operator-login push rail over a real Express server and real temporary filesystem: exact demo operator only, vendor shape validation, atomic 0600 adoption, token-free responses/logs, status, and sign-out.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import express, { type RequestHandler, type Router } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged: unknown[] = [];
vi.mock('@/shared/logger', () => {
  const record = (...args: unknown[]) => { logged.push(...args); };
  const child = { info: record, warn: record, error: record, debug: record, trace: record, fatal: record };
  return { logger: child, createChildLogger: () => child, LOG_REDACT_OPTIONS: { paths: [], censor: '[REDACTED]' } };
});

const { createAntigravityAuthRoutes } = await import('@/app/routes/antigravity-auth-routes');

const ACCESS_TOKEN = 'agy-fixture-access-never-log';
const REFRESH_TOKEN = 'agy-fixture-refresh-never-log';
const CREDENTIAL = {
  token: {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    token_type: 'Bearer',
    expiry: '2026-09-23T00:00:00.000Z',
  },
  auth_method: 'oauth-personal',
  id_token: 'agy-fixture-id-never-log',
};

interface Harness { url: string; close: () => Promise<void> }

const requiresAuth: RequestHandler = (req, res, next) => {
  if ((req as express.Request & { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub) next();
  else res.status(401).json({ error: 'Authentication required' });
};

async function serve(router: Router): Promise<Harness> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.get('x-test-sub');
    if (sub) (req as express.Request & { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
    next();
  });
  app.use('/api/antigravity/auth', router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/antigravity/auth`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function request(url: string, method: 'GET' | 'POST', sub?: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(sub ? { 'x-test-sub': sub } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

let root = '';
let credentialPath = '';

beforeEach(() => {
  logged.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-agy-adopt-'));
  credentialPath = path.join(root, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  vi.stubEnv('DEMO_MODE', 'true');
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-exact');
  vi.stubEnv('ANTIGRAVITY_OAUTH_TOKEN_PATH', credentialPath);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Antigravity authenticated login-push rail', () => {
  it('adopts the exact operator credential, exposes token-free status, and signs out', async () => {
    const harness = await serve(createAntigravityAuthRoutes(requiresAuth));
    try {
      const imported = await request(`${harness.url}/import`, 'POST', 'operator-exact', { credentials: CREDENTIAL });
      expect(imported.status).toBe(200);
      expect(imported.body).toMatchObject({ success: true, imported: true, expiresAt: CREDENTIAL.token.expiry });
      expect(JSON.parse(fs.readFileSync(credentialPath, 'utf8'))).toEqual(CREDENTIAL);
      if (process.platform !== 'win32') expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(path.dirname(credentialPath))).toEqual(['antigravity-oauth-token']);

      const status = await request(`${harness.url}/status`, 'GET', 'operator-exact');
      expect(status.body).toMatchObject({ success: true, authenticated: true });
      const signedOut = await request(`${harness.url}/signout`, 'POST', 'operator-exact', {});
      expect(signedOut.body).toMatchObject({ success: true, signedOut: true, removed: true, authenticated: false });
      expect(fs.existsSync(credentialPath)).toBe(false);

      const surfaces = [imported.text, status.text, signedOut.text, inspect(logged, { depth: null, maxStringLength: null })].join('\n');
      expect(surfaces).not.toContain(ACCESS_TOKEN);
      expect(surfaces).not.toContain(REFRESH_TOKEN);
    } finally {
      await harness.close();
    }
  });

  it('refuses non-operators, non-demo deployments, and malformed vendor shapes', async () => {
    const harness = await serve(createAntigravityAuthRoutes(requiresAuth));
    try {
      expect((await request(`${harness.url}/import`, 'POST', undefined, { credentials: CREDENTIAL })).status).toBe(401);
      expect((await request(`${harness.url}/import`, 'POST', 'ordinary-user', { credentials: CREDENTIAL })).status).toBe(403);
      vi.stubEnv('DEMO_MODE', '');
      expect((await request(`${harness.url}/import`, 'POST', 'operator-exact', { credentials: CREDENTIAL })).body)
        .toMatchObject({ imported: false, error: 'credential_distribution_disabled_pending_versioned_revocation_rail' });
      vi.stubEnv('DEMO_MODE', 'true');
      const invalid = await request(`${harness.url}/import`, 'POST', 'operator-exact', {
        credentials: { token: { access_token: ACCESS_TOKEN }, auth_method: 'oauth-personal' },
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({ imported: false, error: 'antigravity_login_file_invalid' });
      expect(fs.existsSync(credentialPath)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('names read-only and unconfigured targets', async () => {
    const harness = await serve(createAntigravityAuthRoutes(requiresAuth));
    try {
      const readOnly = Object.assign(new Error('read only'), { code: 'EROFS' });
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw readOnly; });
      const refused = await request(`${harness.url}/import`, 'POST', 'operator-exact', { credentials: CREDENTIAL });
      expect(refused.body).toMatchObject({ error: 'antigravity_credentials_path_read_only' });
      openSpy.mockRestore();

      vi.stubEnv('ANTIGRAVITY_OAUTH_TOKEN_PATH', '');
      vi.stubEnv('HOME', '');
      vi.stubEnv('USERPROFILE', '');
      const unset = await request(`${harness.url}/import`, 'POST', 'operator-exact', { credentials: CREDENTIAL });
      expect(unset.body).toMatchObject({ error: 'antigravity_credentials_path_unset' });
    } finally {
      await harness.close();
    }
  });
});
