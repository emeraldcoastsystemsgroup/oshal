/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the Gemini half of the ADR-137 amendment A rail: the real router over a real HTTP server and the real filesystem adopt a pushed `oauth_creds.json` ONLY under DEMO_MODE + the exact operator subject, write it atomically at 0600, refuse a read-only mount and an unconfigured path with their own 409s, refuse a wrong shape with a NAMED 400, and keep the SEC-05 409 for every other caller and every non-demo deployment. The credential's absence from every response body and every log line is asserted explicitly, because "it is only written to disk" is the claim this rail lives or dies on. The logger is the one doubled collaborator — it is recorded rather than replaced with a stub, so a log line that carried the token would go red here.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import express, { type RequestHandler, type Router } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every log argument any module under test emitted, so the token's absence is checkable. */
const logged: unknown[] = [];

vi.mock('@/shared/logger', () => {
  const record = (...args: unknown[]) => { logged.push(...args); };
  const child = { info: record, warn: record, error: record, debug: record, trace: record, fatal: record };
  return {
    logger: child,
    createChildLogger: () => child,
    LOG_REDACT_OPTIONS: { paths: [], censor: '[REDACTED]' },
  };
});

const { createGeminiAuthRoutes } = await import('@/app/routes/gemini-auth-routes');

interface Harness { url: string; close: () => Promise<void> }

const RAIL_REFUSAL = 'credential_distribution_disabled_pending_versioned_revocation_rail';

/** The google-auth-library Credentials object `gemini` caches after its browser sign-in. */
const ACCESS_TOKEN = 'ya29.test-access-token-value-not-a-real-credential';
const REFRESH_TOKEN = '1//test-refresh-token-value-not-a-real-credential';
const CREDS_FILE = {
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  scope: 'https://www.googleapis.com/auth/cloud-platform',
  token_type: 'Bearer',
  expiry_date: 1_800_000_000_000,
};

async function serve(router: Router, mount: string): Promise<Harness> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sub = req.get('x-test-sub');
    if (sub) (req as express.Request & { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
    next();
  });
  app.use(mount, router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}${mount}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function post(url: string, sub: string | undefined, body: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sub ? { 'x-test-sub': sub } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Same session shape the production mount uses: an OIDC user must be present. */
const requiresAuth: RequestHandler = (req, res, next) => {
  if ((req as express.Request & { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub) next();
  else res.status(401).json({ error: 'Authentication required' });
};

function tempCredsPath(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-gemini-adopt-'));
  return { root, file: path.join(root, 'mounted', 'oauth_creds.json') };
}

/**
 * Every string anywhere in the recorded log arguments, flattened for a containment check.
 *
 * `util.inspect` with unlimited depth, NOT JSON.stringify with a property-name replacer: a
 * replacer array filters recursively, so a credential nested one level down (`{ creds }`) is
 * silently dropped and the absence assertion passes on a log line that leaked. Found by the
 * mutation proof, which is exactly what it is for.
 */
function loggedText(): string {
  return logged.map((entry) => inspect(entry, { depth: null, maxStringLength: null })).join('\n');
}

beforeEach(() => {
  logged.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/gemini/auth/import — the Google seeding rail (ADR-137 A, ADR-127 gates)', () => {
  it('adopts the operator sign-in under DEMO_MODE + exact operator, atomically and 0600', async () => {
    const { root, file } = tempCredsPath();
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-exact');
    vi.stubEnv('GEMINI_OAUTH_CREDS_PATH', file);
    const harness = await serve(createGeminiAuthRoutes(requiresAuth), '/api/gemini/auth');
    try {
      const reply = await post(`${harness.url}/import`, 'operator-exact', { credentials: CREDS_FILE });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        success: true,
        imported: true,
        expiresAt: new Date(CREDS_FILE.expiry_date).toISOString(),
      });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(CREDS_FILE);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // No temp file left behind after the rename.
      expect(fs.readdirSync(path.dirname(file))).toEqual(['oauth_creds.json']);

      // A raw string body is accepted too — the node may post the file verbatim.
      const asString = await post(`${harness.url}/import`, 'operator-exact', { credentials: JSON.stringify(CREDS_FILE) });
      expect(asString.status).toBe(200);
    } finally {
      await harness.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('never puts the credential in a response body, and never in a log line', async () => {
    const { root, file } = tempCredsPath();
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-exact');
    vi.stubEnv('GEMINI_OAUTH_CREDS_PATH', file);
    const harness = await serve(createGeminiAuthRoutes(requiresAuth), '/api/gemini/auth');
    try {
      const bodies = [
        (await post(`${harness.url}/import`, 'operator-exact', { credentials: CREDS_FILE })).text,
        (await post(`${harness.url}/signout`, 'operator-exact', {})).text,
        // A refused push must not echo what it refused either.
        (await post(`${harness.url}/import`, 'ordinary-user', { credentials: CREDS_FILE })).text,
      ];
      // Status is the other model-visible surface on this router.
      const status = await fetch(`${harness.url}/status`, { headers: { 'x-test-sub': 'operator-exact' } });
      bodies.push(await status.text());

      for (const body of bodies) {
        expect(body).not.toContain(ACCESS_TOKEN);
        expect(body).not.toContain(REFRESH_TOKEN);
      }
      // The route did log — so an empty recorder cannot be what makes this pass.
      expect(logged.length).toBeGreaterThan(0);
      expect(loggedText()).not.toContain(ACCESS_TOKEN);
      expect(loggedText()).not.toContain(REFRESH_TOKEN);
    } finally {
      await harness.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the SEC-05 refusal off demo, for a non-operator, and for an identity-less request', async () => {
    const { root, file } = tempCredsPath();
    vi.stubEnv('GEMINI_OAUTH_CREDS_PATH', file);
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-exact');
    const harness = await serve(createGeminiAuthRoutes(requiresAuth), '/api/gemini/auth');
    try {
      vi.stubEnv('DEMO_MODE', '');
      const offDemo = await post(`${harness.url}/import`, 'operator-exact', { credentials: CREDS_FILE });
      expect(offDemo.status).toBe(409);
      expect(offDemo.body).toMatchObject({ imported: false, error: RAIL_REFUSAL });

      vi.stubEnv('DEMO_MODE', 'true');
      expect((await post(`${harness.url}/import`, 'ordinary-user', { credentials: CREDS_FILE })).status).toBe(403);
      expect((await post(`${harness.url}/import`, undefined, { credentials: CREDS_FILE })).status).toBe(401);

      // requiresOperator admits an allowlisted email; the credential carve still wants the exact sub.
      vi.stubEnv('OSHAL_OPERATOR_SUBS', 'someone-else');
      vi.stubEnv('OSHAL_OPERATOR_EMAILS', 'op@example.com');
      const emailOnly = await post(`${harness.url}/import`, 'operator-by-email', { credentials: CREDS_FILE });
      expect([403, 409]).toContain(emailOnly.status);

      // Nothing was written by any refused call.
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      await harness.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a malformed payload with a NAMED 400 and writes nothing', async () => {
    const { root, file } = tempCredsPath();
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-exact');
    vi.stubEnv('GEMINI_OAUTH_CREDS_PATH', file);
    const harness = await serve(createGeminiAuthRoutes(requiresAuth), '/api/gemini/auth');
    try {
      const cases: Array<[unknown, string]> = [
        [{ tokens: { access_token: 'a', refresh_token: 'r' } }, 'a codex auth.json'],
        [{ claudeAiOauth: { accessToken: 'sk-ant-oat01' } }, 'a claude .credentials.json'],
        [{ access_token: ACCESS_TOKEN }, 'access token with no refresh token'],
        [{ access_token: '', refresh_token: REFRESH_TOKEN }, 'blank access token'],
        [{ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expiry_date: 'soon' }, 'non-numeric expiry'],
        ['not json', 'unparseable text'],
        ['AIzaSyBareApiKeyPastedByMistake', 'a bare API key'],
        [[], 'an array'],
      ];
      for (const [credentials, what] of cases) {
        const reply = await post(`${harness.url}/import`, 'operator-exact', { credentials });
        expect(reply.status, what).toBe(400);
        expect(reply.body, what).toMatchObject({ imported: false, error: 'gemini_login_file_invalid' });
        expect(String(reply.body.detail), what).not.toHaveLength(0);
      }
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      await harness.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('names a read-only mount and an unconfigured path with their own 409s', async () => {
    const { root, file } = tempCredsPath();
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-exact');
    vi.stubEnv('GEMINI_OAUTH_CREDS_PATH', file);
    const harness = await serve(createGeminiAuthRoutes(requiresAuth), '/api/gemini/auth');
    try {
      const readOnly = Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw readOnly; });
      const refused = await post(`${harness.url}/import`, 'operator-exact', { credentials: CREDS_FILE });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ imported: false, error: 'gemini_credentials_path_read_only' });
      expect(String(refused.body.hint)).toContain('GEMINI_AUTH_MOUNT_MODE=rw');
      openSpy.mockRestore();

      // No path at all: neither the override nor a home directory.
      vi.stubEnv('GEMINI_OAUTH_CREDS_PATH', '');
      vi.stubEnv('HOME', '');
      vi.stubEnv('USERPROFILE', '');
      const unset = await post(`${harness.url}/import`, 'operator-exact', { credentials: CREDS_FILE });
      expect(unset.status).toBe(409);
      expect(unset.body).toMatchObject({ imported: false, error: 'gemini_credentials_path_unset' });
      expect(String(unset.body.hint)).toContain('GEMINI_OAUTH_CREDS_PATH');
    } finally {
      await harness.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('POST /api/gemini/auth/signout — taking the adopted identity back off the swarm', () => {
  it('removes the credential and the cached account name, and is idempotent', async () => {
    const { root, file } = tempCredsPath();
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-exact');
    vi.stubEnv('GEMINI_OAUTH_CREDS_PATH', file);
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GOOGLE_API_KEY', '');
    const harness = await serve(createGeminiAuthRoutes(requiresAuth), '/api/gemini/auth');
    try {
      expect((await post(`${harness.url}/import`, 'operator-exact', { credentials: CREDS_FILE })).status).toBe(200);
      const accounts = path.join(path.dirname(file), 'google_accounts.json');
      fs.writeFileSync(accounts, JSON.stringify({ active: 'operator@example.com' }), 'utf8');

      const first = await post(`${harness.url}/signout`, 'operator-exact', {});
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ success: true, signedOut: true, removed: true, connected: false });
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(accounts)).toBe(false);

      const second = await post(`${harness.url}/signout`, 'operator-exact', {});
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ signedOut: true, removed: false });
    } finally {
      await harness.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a non-operator and an identity-less caller', async () => {
    const { root, file } = tempCredsPath();
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-exact');
    vi.stubEnv('GEMINI_OAUTH_CREDS_PATH', file);
    const harness = await serve(createGeminiAuthRoutes(requiresAuth), '/api/gemini/auth');
    try {
      expect((await post(`${harness.url}/signout`, 'ordinary-user', {})).status).toBe(403);
      expect((await post(`${harness.url}/signout`, undefined, {})).status).toBe(401);
    } finally {
      await harness.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
