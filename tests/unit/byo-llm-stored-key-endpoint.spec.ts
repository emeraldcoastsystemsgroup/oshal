/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard from the signed-in route review (2026-10-05): with no apiKey in the request, the BYO-LLM routes reuse a stored key only for the exact endpoint it was saved for, so a household member's shared key is never sent to a URL the caller chose.
 */

import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SAVED = 'https://saved-llm.example.test/v1';
const OTHER = 'https://other-llm.example.test/v1';

vi.mock('@/app/routes/connector-tenancy', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/routes/connector-tenancy')>(),
  // A household-shared connection that belongs to another member and is the default.
  accessibleConnections: vi.fn(async () => [
    { account_id: SAVED, is_default: true, access_token: 'sealed', user_sub: 'bob', tenant_id: 'home-1', provider: 'any-llm' },
  ]),
}));
vi.mock('@/app/routes/connector-token-crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/routes/connector-token-crypto')>(),
  decryptToken: vi.fn(async () => 'placeholder-household-key'),
}));
vi.mock('@/shared/security/ssrf-guard', () => ({ assertPublicHttpUrl: vi.fn(async () => undefined) }));

import { createByoLlmRoutes } from '@/app/routes/byo-llm-routes';

const realFetch = globalThis.fetch;
const upstream = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 }));
let server: ReturnType<express.Express['listen']>;
let base = '';
beforeEach(async () => {
  const app = express();
  app.use((req, _res, next) => { Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: 'alice' } } }); next(); });
  app.use('/api/connect/any-llm', createByoLlmRoutes({ pool: {} } as never));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Requests to the fixture server go through; the route's outbound call to the LLM endpoint is captured.
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => (String(url).startsWith(base) ? realFetch(url, init) : upstream(String(url), init)));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.clearAllMocks();
});

const bearer = () => (upstream.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined)?.Authorization;

describe('a stored key goes only to the endpoint it was saved for', () => {
  it('sends no stored key to a URL the caller chose', async () => {
    const res = await realFetch(`${base}/api/connect/any-llm/models?baseUrl=${encodeURIComponent(OTHER)}`);
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith(`${OTHER}/models`, expect.anything());
    expect(bearer()).toBe('Bearer ');
  });

  it('still reuses the key for its own endpoint', async () => {
    await realFetch(`${base}/api/connect/any-llm/models?baseUrl=${encodeURIComponent(SAVED)}`);
    expect(bearer()).toBe('Bearer placeholder-household-key');
  });
});
