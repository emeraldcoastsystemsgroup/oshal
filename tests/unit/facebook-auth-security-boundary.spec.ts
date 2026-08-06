/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard Facebook OAuth's operator-only control plane, single-use browser-bound callback state, fixed callback HTML, retired browser secret inputs, and absent raw Redis token publication.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove OAuth state/provider work fails closed when encrypted Facebook credential storage is not configured.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFacebookAuthRoutes } from '@/app/routes/facebook-auth-routes';
import { requiresOperator } from '@/shared/middleware/authz';

const routeSource = fs.readFileSync('src/app/routes/facebook-auth-routes.ts', 'utf8');
const appSource = fs.readFileSync(
  'any-bot/server/services/tools/facebook/facebook-app.html',
  'utf8',
);
const storeSource = fs.readFileSync(
  'any-bot/server/services/tools/facebook/facebookCredentialStore.js',
  'utf8',
);

const originalOperatorSubs = process.env.OSHAL_OPERATOR_SUBS;
const originalFacebookAppId = process.env.FACEBOOK_APP_ID;
const originalFacebookAppSecret = process.env.FACEBOOK_APP_SECRET;
const originalOutputDir = process.env.OUTPUT_DIR;
const originalEncryptionKey = process.env.ENCRYPTION_KEY;

let server: Server | undefined;
let baseUrl = '';
let outputDir = '';

/** Test-only auth wall; identity comes from a header only inside this isolated app. */
function requiresAuth(req: Request, res: Response, next: NextFunction): void {
  const oidc = (req as Request & {
    oidc?: { isAuthenticated?: () => boolean };
  }).oidc;
  if (oidc?.isAuthenticated?.() === true) {
    next();
    return;
  }
  res.status(401).json({ error: 'authentication required' });
}

function authHeaders(sub = 'operator-1'): Record<string, string> {
  return { 'x-test-user-sub': sub };
}

function cookiePair(response: globalThis.Response): string {
  const setCookie = response.headers.get('set-cookie') || '';
  return setCookie.split(';', 1)[0];
}

async function startFlow(): Promise<{ state: string; cookie: string }> {
  const response = await fetch(`${baseUrl}/api/facebook-auth/start`, {
    headers: authHeaders(),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { authUrl: string };
  const state = new URL(body.authUrl).searchParams.get('state') || '';
  expect(state).toMatch(/^[a-f0-9]{64}$/);
  const cookie = cookiePair(response);
  expect(cookie).toContain(`oshal_fb_oauth_${state}=`);
  return { state, cookie };
}

beforeEach(async () => {
  process.env.OSHAL_OPERATOR_SUBS = 'operator-1,operator-2';
  process.env.FACEBOOK_APP_ID = 'facebook-test-app';
  process.env.FACEBOOK_APP_SECRET = 'facebook-test-secret';
  process.env.ENCRYPTION_KEY = 'facebook-test-encryption-key-with-sufficient-entropy';
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'facebook-auth-boundary-'));
  process.env.OUTPUT_DIR = outputDir;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.get('x-test-user-sub');
    if (sub) {
      (req as Request & { oidc?: unknown }).oidc = {
        isAuthenticated: () => true,
        user: { sub },
      };
    }
    next();
  });
  app.use('/api/facebook-auth', createFacebookAuthRoutes(requiresAuth));

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
  }
  server = undefined;
  if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
  outputDir = '';

  if (originalOperatorSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
  else process.env.OSHAL_OPERATOR_SUBS = originalOperatorSubs;
  if (originalFacebookAppId === undefined) delete process.env.FACEBOOK_APP_ID;
  else process.env.FACEBOOK_APP_ID = originalFacebookAppId;
  if (originalFacebookAppSecret === undefined) delete process.env.FACEBOOK_APP_SECRET;
  else process.env.FACEBOOK_APP_SECRET = originalFacebookAppSecret;
  if (originalOutputDir === undefined) delete process.env.OUTPUT_DIR;
  else process.env.OUTPUT_DIR = originalOutputDir;
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
});

describe('Facebook auth route authorization', () => {
  it('puts authentication and the exact operator allowlist on every route except callback', () => {
    const router = createFacebookAuthRoutes(requiresAuth);
    const layers = (router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          stack: Array<{ handle: unknown }>;
        };
      }>;
    }).stack.filter((layer) => layer.route).map((layer) => layer.route!);

    expect(layers.map((route) => route.path)).toEqual([
      '/app', '/login', '/credentials', '/status', '/start',
      '/callback', '/disconnect', '/pages', '/switch-page',
    ]);

    for (const route of layers) {
      const handles = route.stack.map((entry) => entry.handle);
      if (route.path === '/callback') {
        expect(handles).not.toContain(requiresAuth);
        expect(handles).not.toContain(requiresOperator);
      } else {
        expect(handles).toContain(requiresAuth);
        expect(handles).toContain(requiresOperator);
      }
    }
  });

  it('denies an authenticated non-operator before every non-callback handler', async () => {
    const probes: Array<{ method: string; path: string }> = [
      { method: 'GET', path: '/app' },
      { method: 'POST', path: '/login' },
      { method: 'POST', path: '/credentials' },
      { method: 'GET', path: '/status' },
      { method: 'GET', path: '/start' },
      { method: 'POST', path: '/disconnect' },
      { method: 'GET', path: '/pages' },
      { method: 'POST', path: '/switch-page' },
    ];

    for (const probe of probes) {
      const response = await fetch(`${baseUrl}/api/facebook-auth${probe.path}`, {
        method: probe.method,
        headers: {
          ...authHeaders('ordinary-user'),
          'content-type': 'application/json',
        },
        body: probe.method === 'POST' ? '{}' : undefined,
      });
      expect(response.status, `${probe.method} ${probe.path}`).toBe(403);
    }

    const publicCallback = await fetch(`${baseUrl}/api/facebook-auth/callback`);
    expect(publicCallback.status).toBe(400);
  });

  it('keeps legacy browser password and App-Secret writes as operator-gated 410s', async () => {
    const login = await fetch(`${baseUrl}/api/facebook-auth/login`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'victim@example.test', password: 'must-not-be-read' }),
    });
    expect(login.status).toBe(410);
    expect(await login.json()).toEqual({
      success: false,
      error: 'browser_password_login_disabled',
    });

    const credentials = await fetch(`${baseUrl}/api/facebook-auth/credentials`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ appId: 'id', appSecret: 'must-not-be-written' }),
    });
    expect(credentials.status).toBe(410);
    expect(await credentials.json()).toEqual({
      success: false,
      error: 'browser_app_secret_write_disabled',
    });
  });

  it('rejects OAuth start before state creation when encrypted storage is unavailable', async () => {
    delete process.env.ENCRYPTION_KEY;
    const response = await fetch(`${baseUrl}/api/facebook-auth/start`, {
      headers: authHeaders(),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: 'facebook_encrypted_storage_required',
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('Facebook OAuth callback state and rendering', () => {
  it('accepts only the initiating browser binding, consumes state once, and never reflects provider HTML', async () => {
    const axiosGet = vi.spyOn(axios, 'get');
    const { state, cookie } = await startFlow();
    const injected = '<img src=x onerror=globalThis.pwned=true>';
    const callback = new URL(`${baseUrl}/api/facebook-auth/callback`);
    callback.searchParams.set('state', state);
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set('error_description', injected);

    const response = await fetch(callback, { headers: { cookie } });
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain('The authorization could not be completed');
    expect(html).not.toContain(injected);
    expect(html).not.toContain('error_description');
    expect(axiosGet).not.toHaveBeenCalled();

    const replay = await fetch(callback, { headers: { cookie } });
    expect(replay.status).toBe(400);
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('consumes a state after a wrong binding or different authenticated session', async () => {
    const axiosGet = vi.spyOn(axios, 'get');
    const first = await startFlow();
    const firstCookieName = first.cookie.split('=', 1)[0];
    const wrongBinding = await fetch(
      `${baseUrl}/api/facebook-auth/callback?state=${first.state}&code=unused`,
      { headers: { cookie: `${firstCookieName}=wrong-binding` } },
    );
    expect(wrongBinding.status).toBe(400);
    const afterWrongBinding = await fetch(
      `${baseUrl}/api/facebook-auth/callback?state=${first.state}&code=unused`,
      { headers: { cookie: first.cookie } },
    );
    expect(afterWrongBinding.status).toBe(400);

    const second = await startFlow();
    const wrongSession = await fetch(
      `${baseUrl}/api/facebook-auth/callback?state=${second.state}&code=unused`,
      { headers: { cookie: second.cookie, ...authHeaders('operator-2') } },
    );
    expect(wrongSession.status).toBe(400);
    expect(axiosGet).not.toHaveBeenCalled();
  });
});

describe('Facebook credential distribution source boundary', () => {
  it('contains no browser secret store, raw Redis token publication, or hot-reload envelope', () => {
    expect(appSource).not.toContain('localStorage');
    expect(appSource).not.toContain('fb_app_secret');
    expect(appSource).not.toContain("fetch('/api/facebook-auth/credentials'");
    expect(routeSource).not.toContain("publish('facebook.credentials.update'");
    expect(routeSource).not.toContain('errorDescription || errorParam');
    expect(storeSource).not.toContain('function hotReload(');
    expect(storeSource).not.toContain('hotReload,');
    expect(storeSource).not.toContain('plain mode');
    expect(storeSource).not.toContain('process.env.ENCRYPTION_KEY || null');
    expect(storeSource).toContain('requires an encryption-backed manager');
  });
});
