/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-137 amendment A guard: the real router + real service adopt a satellite's `claude auth login` file ONLY under DEMO_MODE + the exact operator subject, write it atomically at 0600 to the configured path, refuse a read-only mount with its own 409, refuse a wrong shape with 400, and keep the SEC-05 409 for every other caller and every non-demo deployment.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler, type Router } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeCodeAuthRoutes } from '@/app/routes/claude-code-auth-routes';

interface Harness { url: string; close: () => Promise<void> }

const RAIL_REFUSAL = 'credential_distribution_disabled_pending_versioned_revocation_rail';
const LOGIN_FILE = {
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-satellite',
    refreshToken: 'sk-ant-ort01-satellite',
    expiresAt: 1_800_000_000_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
  },
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
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Same session shape the production mount uses: an OIDC user must be present. */
const requiresAuth: RequestHandler = (req, res, next) => {
  if ((req as express.Request & { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub) next();
  else res.status(401).json({ error: 'Authentication required' });
};

function tempCredentialsPath(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-claude-adopt-'));
  return { root, file: path.join(root, 'mounted', '.credentials.json') };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/claude-code/auth/import — demo portal fallback (ADR-137 A)', () => {
  it('adopts the operator login file under DEMO_MODE + exact operator, atomically and 0600', async () => {
    const { root, file } = tempCredentialsPath();
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-exact');
    vi.stubEnv('CLAUDE_CODE_CREDENTIALS_PATH', file);
    const harness = await serve(createClaudeCodeAuthRoutes(requiresAuth), '/api/claude-code/auth');
    try {
      const reply = await post(`${harness.url}/import`, 'operator-exact', { credentials: LOGIN_FILE });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ success: true, imported: true, expiresAt: LOGIN_FILE.claudeAiOauth.expiresAt });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(LOGIN_FILE);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // No temp file left behind after the rename.
      expect(fs.readdirSync(path.dirname(file))).toEqual(['.credentials.json']);

      // A raw string body is accepted too — the node may post the file verbatim.
      const asString = await post(`${harness.url}/import`, 'operator-exact', { credentials: JSON.stringify(LOGIN_FILE) });
      expect(asString.status).toBe(200);
    } finally {
      await harness.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the SEC-05 refusal off demo, for operator emails without the exact sub, and for ordinary users', async () => {
    const { root, file } = tempCredentialsPath();
    vi.stubEnv('CLAUDE_CODE_CREDENTIALS_PATH', file);
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-exact');
    const harness = await serve(createClaudeCodeAuthRoutes(requiresAuth), '/api/claude-code/auth');
    try {
      vi.stubEnv('DEMO_MODE', '');
      const offDemo = await post(`${harness.url}/import`, 'operator-exact', { credentials: LOGIN_FILE });
      expect(offDemo.status).toBe(409);
      expect(offDemo.body).toMatchObject({ imported: false, error: RAIL_REFUSAL });

      vi.stubEnv('DEMO_MODE', 'true');
      expect((await post(`${harness.url}/import`, 'ordinary-user', { credentials: LOGIN_FILE })).status).toBe(403);
      expect((await post(`${harness.url}/import`, undefined, { credentials: LOGIN_FILE })).status).toBe(401);

      // requiresOperator admits an allowlisted email; the credential carve still wants the exact sub.
      vi.stubEnv('OSHAL_OPERATOR_SUBS', 'someone-else');
      vi.stubEnv('OSHAL_OPERATOR_EMAILS', 'op@example.com');
      const emailOnly = await fetch(`${harness.url}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-sub': 'operator-by-email' },
        body: JSON.stringify({ credentials: LOGIN_FILE }),
      });
      expect([403, 409]).toContain(emailOnly.status);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      await harness.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a wrong shape with 400 and names a read-only mount with its own 409', async () => {
    const { root, file } = tempCredentialsPath();
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-exact');
    vi.stubEnv('CLAUDE_CODE_CREDENTIALS_PATH', file);
    const harness = await serve(createClaudeCodeAuthRoutes(requiresAuth), '/api/claude-code/auth');
    try {
      for (const bad of [
        { credentials: { tokens: { access_token: 'a', refresh_token: 'r' } } }, // a codex auth.json
        { credentials: { claudeAiOauth: { accessToken: '' } } },
        { credentials: 'not json' },
        { credentials: 'sk-ant-api03-bare-key' },
      ]) {
        const reply = await post(`${harness.url}/import`, 'operator-exact', bad);
        expect(reply.status).toBe(400);
        expect(reply.body).toMatchObject({ imported: false, error: 'claude_login_file_invalid' });
      }
      expect(fs.existsSync(file)).toBe(false);

      const readOnly = Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      vi.spyOn(fs, 'openSync').mockImplementation(() => { throw readOnly; });
      const reply = await post(`${harness.url}/import`, 'operator-exact', { credentials: LOGIN_FILE });
      expect(reply.status).toBe(409);
      expect(reply.body).toMatchObject({ imported: false, error: 'claude_credentials_path_read_only' });
      expect(String(reply.body.hint)).toContain('CLAUDE_AUTH_MOUNT_MODE=rw');
    } finally {
      await harness.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
