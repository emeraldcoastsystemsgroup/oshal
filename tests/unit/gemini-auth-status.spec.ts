/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Plan E gemini connect-state probe: every layout the surface can meet (absent / unreadable / invalid / valid / expired-with-refresh / expired-without-refresh oauth_creds.json, env-key fallbacks, path resolution) exercised against FAKE fs layouts in a temp dir — the operator's real home directory is never read. Also pins the operator doctrine on the route: createGeminiAuthRoutes exposes status ONLY (goes red if anyone adds a /start / /callback Google-OAuth-brokering route) and /status carries the requiresAuth middleware.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getGeminiAuthStatus,
  resolveGeminiCredsPath,
} from '@/features/llm-provider';
import { createGeminiAuthRoutes } from '@/app/routes/gemini-auth-routes';

/** Env base that guarantees NO fallback lane is accidentally live in a test. */
const EMPTY_ENV: Record<string, string | undefined> = {};

describe('gemini-auth-status-service (Plan E connect-state probe)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-auth-spec-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Writes a fake oauth_creds.json into the temp dir and returns its path. */
  function writeCreds(contents: string): string {
    const credsPath = path.join(tmpDir, 'oauth_creds.json');
    fs.writeFileSync(credsPath, contents, 'utf-8');
    return credsPath;
  }

  describe('oauth_creds.json layouts', () => {
    it('reports missing when the creds file does not exist', () => {
      const status = getGeminiAuthStatus({ credsPath: path.join(tmpDir, 'nope.json'), env: EMPTY_ENV });
      expect(status).toEqual({ connected: false, method: 'none', reason: 'missing' });
    });

    it('reports unreadable for a file that is not valid JSON', () => {
      const credsPath = writeCreds('this is not json {');
      const status = getGeminiAuthStatus({ credsPath, env: EMPTY_ENV });
      expect(status).toEqual({ connected: false, method: 'none', reason: 'unreadable' });
    });

    it('reports unreadable for JSON that is not an object (array / scalar)', () => {
      const credsPath = writeCreds('["ya29.token"]');
      const status = getGeminiAuthStatus({ credsPath, env: EMPTY_ENV });
      expect(status).toEqual({ connected: false, method: 'none', reason: 'unreadable' });
    });

    it('reports invalid when the file parses but has no access token', () => {
      const credsPath = writeCreds(JSON.stringify({ refresh_token: '1//refresh', expiry_date: Date.now() + 3_600_000 }));
      const status = getGeminiAuthStatus({ credsPath, env: EMPTY_ENV });
      expect(status).toEqual({ connected: false, method: 'none', reason: 'invalid' });
    });

    it('reports invalid when the access token is an empty string', () => {
      const credsPath = writeCreds(JSON.stringify({ access_token: '   ' }));
      const status = getGeminiAuthStatus({ credsPath, env: EMPTY_ENV });
      expect(status).toEqual({ connected: false, method: 'none', reason: 'invalid' });
    });

    it('reports connected oauth for an unexpired token, with the ISO expiry', () => {
      const expiryMs = Date.now() + 3_600_000;
      const credsPath = writeCreds(JSON.stringify({
        access_token: 'ya29.valid-token',
        refresh_token: '1//refresh',
        token_type: 'Bearer',
        expiry_date: expiryMs,
      }));
      const status = getGeminiAuthStatus({ credsPath, env: EMPTY_ENV });
      expect(status.connected).toBe(true);
      expect(status.method).toBe('oauth');
      expect(status.reason).toBe('valid');
      expect(status.expiresAt).toBe(new Date(expiryMs).toISOString());
    });

    it('reports connected oauth (no expiresAt) when the file declares no expiry_date', () => {
      const credsPath = writeCreds(JSON.stringify({ access_token: 'ya29.valid-token' }));
      const status = getGeminiAuthStatus({ credsPath, env: EMPTY_ENV });
      expect(status.connected).toBe(true);
      expect(status.method).toBe('oauth');
      expect(status.reason).toBe('valid');
      expect(status.expiresAt).toBeUndefined();
    });

    it('still counts an EXPIRED access token as connected when a refresh token exists (the CLI refreshes silently)', () => {
      const expiryMs = Date.now() - 60_000;
      const credsPath = writeCreds(JSON.stringify({
        access_token: 'ya29.stale-token',
        refresh_token: '1//still-good',
        expiry_date: expiryMs,
      }));
      const status = getGeminiAuthStatus({ credsPath, env: EMPTY_ENV });
      expect(status.connected).toBe(true);
      expect(status.method).toBe('oauth');
      expect(status.reason).toBe('refreshable');
      expect(status.expiresAt).toBe(new Date(expiryMs).toISOString());
    });

    it('reports expired (disconnected) when the token is stale and there is NO refresh token', () => {
      const expiryMs = Date.now() - 60_000;
      const credsPath = writeCreds(JSON.stringify({ access_token: 'ya29.stale-token', expiry_date: expiryMs }));
      const status = getGeminiAuthStatus({ credsPath, env: EMPTY_ENV });
      expect(status.connected).toBe(false);
      expect(status.method).toBe('none');
      expect(status.reason).toBe('expired');
      expect(status.expiresAt).toBe(new Date(expiryMs).toISOString());
    });
  });

  describe('env API-key fallback (adapter priority order)', () => {
    it('GEMINI_API_KEY connects with method api-key even with no creds file', () => {
      const status = getGeminiAuthStatus({
        credsPath: path.join(tmpDir, 'nope.json'),
        env: { GEMINI_API_KEY: 'AIza-fake-key' },
      });
      expect(status).toEqual({ connected: true, method: 'api-key', reason: 'api-key' });
    });

    it('GOOGLE_API_KEY is honoured as the second env fallback', () => {
      const status = getGeminiAuthStatus({
        credsPath: path.join(tmpDir, 'nope.json'),
        env: { GOOGLE_API_KEY: 'AIza-fake-key' },
      });
      expect(status).toEqual({ connected: true, method: 'api-key', reason: 'api-key' });
    });

    it('a whitespace-only env key is ignored and the file lane is consulted instead', () => {
      const status = getGeminiAuthStatus({
        credsPath: path.join(tmpDir, 'nope.json'),
        env: { GEMINI_API_KEY: '   ' },
      });
      expect(status).toEqual({ connected: false, method: 'none', reason: 'missing' });
    });

    it('the env key takes priority over a valid oauth file (mirrors the adapter docs)', () => {
      const credsPath = writeCreds(JSON.stringify({ access_token: 'ya29.valid-token' }));
      const status = getGeminiAuthStatus({ credsPath, env: { GEMINI_API_KEY: 'AIza-fake-key' } });
      expect(status.method).toBe('api-key');
      expect(status.connected).toBe(true);
    });
  });

  describe('creds path resolution', () => {
    it('honours the GEMINI_OAUTH_CREDS_PATH override', () => {
      const override = path.join(tmpDir, 'custom-creds.json');
      expect(resolveGeminiCredsPath({ GEMINI_OAUTH_CREDS_PATH: override, HOME: '/somewhere/else' })).toBe(override);
    });

    it('derives <HOME>/.gemini/oauth_creds.json from HOME', () => {
      expect(resolveGeminiCredsPath({ HOME: tmpDir })).toBe(path.join(tmpDir, '.gemini', 'oauth_creds.json'));
    });

    it('falls back to USERPROFILE when HOME is unset (Windows host)', () => {
      expect(resolveGeminiCredsPath({ USERPROFILE: tmpDir })).toBe(path.join(tmpDir, '.gemini', 'oauth_creds.json'));
    });

    it('returns null when no home directory is resolvable', () => {
      expect(resolveGeminiCredsPath(EMPTY_ENV)).toBeNull();
    });

    it('end-to-end: a fake HOME with a valid file at .gemini/oauth_creds.json connects via the default path', () => {
      const geminiDir = path.join(tmpDir, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });
      fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify({ access_token: 'ya29.valid-token' }), 'utf-8');
      const status = getGeminiAuthStatus({ env: { HOME: tmpDir } });
      expect(status.connected).toBe(true);
      expect(status.method).toBe('oauth');
    });
  });
});

describe('createGeminiAuthRoutes (status-only doctrine + auth gate)', () => {
  /** Express router internals: each layer with a .route is a registered endpoint. */
  interface RouterLayer {
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  }

  it('registers exactly ONE route — GET /status — and it carries the requiresAuth middleware', () => {
    const marker = (_req: unknown, _res: unknown, next: () => void): void => next();
    const router = createGeminiAuthRoutes(marker as never);
    const routes = ((router as unknown as { stack: RouterLayer[] }).stack)
      .filter((layer) => !!layer.route)
      .map((layer) => layer.route as NonNullable<RouterLayer['route']>);

    // Doctrine guard: this surface must stay status-only. If a /start, /callback,
    // or token-exchange route ever appears here (a brokered Google OAuth flow),
    // this goes red — the vendor's own CLI login on the HOST is the only connect path.
    expect(routes.map((r) => r.path)).toEqual(['/status']);
    expect(routes[0].methods.get).toBe(true);

    // Auth gate: the requiresAuth middleware passed to the factory must be wired
    // onto the route itself (the mount in server.ts is classified 'oidc' from this).
    const handles = routes[0].stack.map((entry) => entry.handle);
    expect(handles).toContain(marker);
  });
});
