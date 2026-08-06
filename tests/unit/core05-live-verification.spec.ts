/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real HTTP proof that CORE-05 live verification requires an operator PAT, performs one direct generation, and requires persisted cost attribution.
 */

import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInstallVerificationRoutes } from '../../src/app/routes/install-verification-routes';
import type { AppContext } from '../../src/app/composition/app-context';
import type { SwarmAppService } from '../../src/features/swarm-apps';

const PAT = `oshal_pat_${'a'.repeat(48)}`;
const originalOperators = process.env.OSHAL_OPERATOR_SUBS;
const originalNoAi = process.env.OSHAL_NO_AI;
let targetServer: Server;
let verifierServer: Server;
let targetBaseUrl: string;
let verifierBaseUrl: string;
let generationCalls = 0;
let lastGeneration: { authorization?: string; body?: Record<string, unknown> } = {};
let costQuery: { sql: string; params: unknown[] } | undefined;

/** Listen on a loopback-only ephemeral port. */
async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  process.env.OSHAL_OPERATOR_SUBS = 'operator-1';
  delete process.env.OSHAL_NO_AI;

  const target = express();
  target.use(express.json());
  target.post('/api/send-message', (req, res) => {
    generationCalls += 1;
    lastGeneration = { authorization: req.headers.authorization, body: req.body };
    res.json({ success: true, response: 'OSHAL_LIVE_OK', taskIdUsed: req.body.taskId });
  });
  const targetRuntime = await listen(target);
  targetServer = targetRuntime.server;
  targetBaseUrl = targetRuntime.baseUrl;

  const pool = {
    async query(sql: string, params: unknown[]) {
      costQuery = { sql, params };
      return {
        rows: [{
          provider_id: 'openai-codex',
          total_input_tokens: 12,
          total_output_tokens: 3,
          total_cost: 0.001,
          total_requests: 1,
          usage_by_model: { 'gpt-live': { requestCount: 1 } },
        }],
      };
    },
  };
  const swarmApps = { getApp: async () => null } as unknown as SwarmAppService;
  const verifier = express();
  verifier.use(express.json());
  verifier.use((req, _res, next) => {
    (req as express.Request & { oidc?: unknown }).oidc = {
      isAuthenticated: () => true,
      user: { sub: 'operator-1', email: 'operator@example.test' },
    };
    next();
  });
  verifier.use('/api/install-verification', createInstallVerificationRoutes(
    { pool } as unknown as AppContext,
    swarmApps,
    { apiBaseUrl: targetBaseUrl, randomUUID: () => 'fixed-live-id' },
  ));
  const verifierRuntime = await listen(verifier);
  verifierServer = verifierRuntime.server;
  verifierBaseUrl = verifierRuntime.baseUrl;
});

afterAll(async () => {
  await Promise.all([targetServer, verifierServer].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  if (originalOperators === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
  else process.env.OSHAL_OPERATOR_SUBS = originalOperators;
  if (originalNoAi === undefined) delete process.env.OSHAL_NO_AI;
  else process.env.OSHAL_NO_AI = originalNoAi;
});

describe('CORE-05 bounded live verifier', () => {
  it('rejects session/operator auth that is not explicitly a PAT', async () => {
    const response = await fetch(`${verifierBaseUrl}/api/install-verification/live`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'live_verification_requires_pat' });
    expect(generationCalls).toBe(0);
  });

  it('sends exactly one direct-mode generation and verifies its owner-scoped ledger row', async () => {
    const response = await fetch(`${verifierBaseUrl}/api/install-verification/live`, {
      method: 'POST',
      headers: { authorization: `Bearer ${PAT}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      taskId: 'oshal-live-verify-fixed-live-id',
      provider: 'openai-codex',
      requests: 1,
      inputTokens: 12,
      outputTokens: 3,
      models: ['gpt-live'],
    });
    expect(generationCalls).toBe(1);
    expect(lastGeneration.authorization).toBe(`Bearer ${PAT}`);
    expect(lastGeneration.body).toMatchObject({
      taskId: 'oshal-live-verify-fixed-live-id',
      agenticMode: false,
      chatOnly: true,
      source: 'oshal-verify-live',
    });
    expect(costQuery?.sql).toContain('FROM chat_tasks');
    expect(costQuery?.params).toEqual(['oshal-live-verify-fixed-live-id', 'operator-1']);
  });

  it('does not spend a generation when OSHAL_NO_AI=true', async () => {
    process.env.OSHAL_NO_AI = 'true';
    const response = await fetch(`${verifierBaseUrl}/api/install-verification/live`, {
      method: 'POST',
      headers: { authorization: `Bearer ${PAT}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'ai_disabled', code: 'ai_disabled' });
    expect(generationCalls).toBe(1);
    delete process.env.OSHAL_NO_AI;
  });
});
