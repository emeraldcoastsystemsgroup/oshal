/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Security-audit coverage for shared-secret bot-node execution gates.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 strict posture: missing configuration returns 503 and fails startup; invalid callers return 401; TS and any-bot runtimes remain in parity.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove the non-health machine gate runs before JSON parsing, including invalid and oversized unauthenticated bodies, while exact GET health/metrics probes remain public.
 */

import express from 'express';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

import {
  authorizeBotNodeBeforeBody,
  authorizeBotNodeExecutionCall,
  authorizeBotNodeInternalCall,
  logBotNodeAuthPosture,
} from '../../src/app/bot-node-request-auth';

const requireModule = createRequire(import.meta.url);
const anyBotAuth = requireModule('../../any-bot/server/services/codebase/swarm-execute-auth.js') as {
  assertServiceSecretConfigured: () => void;
  authorizeSwarmExecute: typeof authorizeBotNodeExecutionCall;
};

const SECRET = 'bot-node-test-secret';
const servers: Array<{ close: (cb: () => void) => void }> = [];
let savedSecret: string | undefined;
let savedInsecureFlag: string | undefined;

beforeEach(() => {
  savedSecret = process.env.SWARM_SERVICE_SECRET;
  savedInsecureFlag = process.env.OSHAL_ALLOW_INSECURE_ANY_BOT_TEST_AUTH;
  delete process.env.SWARM_SERVICE_SECRET;
  delete process.env.OSHAL_ALLOW_INSECURE_ANY_BOT_TEST_AUTH;
  for (const spy of Object.values(logSpies)) spy.mockClear();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve))));
  if (savedSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
  else process.env.SWARM_SERVICE_SECRET = savedSecret;
  if (savedInsecureFlag === undefined) delete process.env.OSHAL_ALLOW_INSECURE_ANY_BOT_TEST_AUTH;
  else process.env.OSHAL_ALLOW_INSECURE_ANY_BOT_TEST_AUTH = savedInsecureFlag;
});

async function listen(app: express.Application): Promise<string> {
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function bootRoute(middleware: express.RequestHandler): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post('/api/swarm-execute', middleware, (_req, res) => res.json({ success: true }));
  return `${await listen(app)}/api/swarm-execute`;
}

function post(url: string, headers: Record<string, string> = {}, body: unknown = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('strict bot-node service authentication', () => {
  it('returns 503 for every execution request when the secret is unconfigured', async () => {
    for (const middleware of [authorizeBotNodeExecutionCall, authorizeBotNodeInternalCall, anyBotAuth.authorizeSwarmExecute]) {
      const url = await bootRoute(middleware);
      expect((await post(url)).status).toBe(503);
      expect((await post(url, { 'x-service-secret': 'untrusted' }, { userSub: 'owner-1' })).status).toBe(503);
    }
  });

  it('returns 401 for absent/wrong credentials and accepts the exact configured secret', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    for (const middleware of [authorizeBotNodeExecutionCall, authorizeBotNodeInternalCall, anyBotAuth.authorizeSwarmExecute]) {
      const url = await bootRoute(middleware);
      expect((await post(url)).status).toBe(401);
      expect((await post(url, { 'x-service-secret': `${SECRET}-wrong` })).status).toBe(401);
      expect((await post(url, { 'x-service-secret': SECRET })).status).toBe(200);
    }
  });

  it('rejects a length-mismatched secret without throwing', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    const url = await bootRoute(authorizeBotNodeExecutionCall);
    expect((await post(url, { 'x-service-secret': '' })).status).toBe(401);
    expect((await post(url, { 'x-service-secret': `${SECRET}x` })).status).toBe(401);
  });

  it('fails TS and any-bot startup with the same machine-readable code', () => {
    expect(() => logBotNodeAuthPosture()).toThrowError(/SWARM_SERVICE_SECRET is required/);
    try {
      logBotNodeAuthPosture();
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBe('SERVICE_AUTH_NOT_CONFIGURED');
    }
    expect(logSpies.error).toHaveBeenCalled();

    expect(() => anyBotAuth.assertServiceSecretConfigured()).toThrowError(/SWARM_SERVICE_SECRET is required/);
    try {
      anyBotAuth.assertServiceSecretConfigured();
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBe('SERVICE_AUTH_NOT_CONFIGURED');
    }
  });

  it('logs the strict startup posture when configured', () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    expect(() => logBotNodeAuthPosture()).not.toThrow();
    expect(logSpies.warn).not.toHaveBeenCalled();
    expect(logSpies.info).toHaveBeenCalledTimes(1);
    expect(String(logSpies.info.mock.calls[0][0])).toContain('FAIL-CLOSED');
  });
});

describe('bot-node pre-parser machine gate', () => {
  async function bootPreParserApp(): Promise<string> {
    const app = express();
    app.use(authorizeBotNodeBeforeBody);
    app.use(express.json({ limit: '1kb' }));
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
    app.get('/metrics', (_req, res) => res.type('text/plain').send('up 1\n'));
    app.post('/api/swarm-execute', (_req, res) => res.json({ success: true }));
    return listen(app);
  }

  it('rejects invalid and oversized unauthenticated JSON before the parser', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    const base = await bootPreParserApp();
    const invalid = '{not-json';
    const oversized = JSON.stringify({ value: 'x'.repeat(4096) });

    for (const body of [invalid, oversized]) {
      const denied = await fetch(`${base}/api/swarm-execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(denied.status).toBe(401);
    }

    const authenticatedInvalid = await fetch(`${base}/api/swarm-execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-secret': SECRET },
      body: invalid,
    });
    expect(authenticatedInvalid.status).toBe(400);

    const authenticatedOversized = await fetch(`${base}/api/swarm-execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-secret': SECRET },
      body: oversized,
    });
    expect(authenticatedOversized.status).toBe(413);
  });

  it('keeps only exact GET health and metrics probes public', async () => {
    const base = await bootPreParserApp();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await fetch(`${base}/metrics`)).status).toBe(200);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(503);
    expect((await fetch(`${base}/not-health`)).status).toBe(503);
  });
});
