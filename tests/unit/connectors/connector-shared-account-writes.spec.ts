/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard from the signed-in route review (2026-10-05): through the deployment's own connector account (CONNECTOR_<PROVIDER>_* env), a user with no connection of their own may still read (the swarm default, ADR-174 D3) but may not write; only the portal admin writes as the deployment. The refusal is audited and nothing reaches the provider.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/routes/connectors-routes', () => ({ getValidAccessToken: vi.fn(async () => null) }));

import { mountConnectorSpecRoutes } from '@/app/routes/connector-spec-routes';

const PROVIDER = 'shared-mail';
const SPEC = [
  `provider: ${PROVIDER}`, 'displayName: Shared Mail', 'version: 1.0.0', 'baseUrl: https://shared-mail.example.test',
  'auth:', '  type: apiKeyHeader', '  header: x-api-key',
  'rateLimit: { burst: 5, perSecond: 5 }', 'retry: { maxRetries: 0 }',
  'resources:',
  '  - name: status', '    tool: shared-mail-status', '    method: GET', '    path: /status',
  '  - name: send', '    tool: shared-mail-send', '    method: POST', '    path: /send', "    body: '{payload}'",
  'metadata:', '  category: Communication', '  description: Shared account fixture', '',
].join('\n');

const realFetch = globalThis.fetch;
const provider = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
const audit = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 1 }));
let dir = '';
let server: ReturnType<express.Express['listen']>;
let base = '';

beforeEach(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'portal-admin'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('CONNECTOR_SHARED_MAIL_KEY', 'placeholder-deployment-key');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-shared-account-'));
  fs.writeFileSync(path.join(dir, `${PROVIDER}.yaml`), SPEC);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: String(req.headers['x-test-sub'] ?? '') } } });
    next();
  });
  mountConnectorSpecRoutes(app, { pool: { query: audit } }, ((_req: unknown, _res: unknown, next: () => void) => next()) as never, { specDirs: [dir] });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => (String(url).startsWith(base) ? realFetch(url, init) : provider()));
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(resource: string, sub: string, body: Record<string, unknown> = {}) {
  return realFetch(`${base}/api/connectors/${PROVIDER}/${resource}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-sub': sub }, body: JSON.stringify(body),
  });
}

describe("the deployment's shared connector account", () => {
  it('refuses a write by a user with no connection of their own, audits it, and never calls the provider', async () => {
    const res = await call('send', 'alice', { confirm: true, payload: { to: 'someone@example.test' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_connected' });
    expect(provider).not.toHaveBeenCalled();
    expect(audit.mock.calls.some(([, params]) => Array.isArray(params) && params.includes('not_connected'))).toBe(true);
  });

  it('still serves that user a read, as the swarm default', async () => {
    expect((await call('status', 'alice')).status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('lets the portal admin write through it', async () => {
    expect((await call('send', 'portal-admin', { confirm: true, payload: { to: 'someone@example.test' } })).status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
