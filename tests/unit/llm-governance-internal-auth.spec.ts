/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the machine-only LLM governance check so an unset or incorrect internal secret is rejected and only the exact configured credential reaches quota evaluation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | requiresAuth is now a required parameter of registerLlmGovernanceRoutes: the app is built with a denying session guard, a new case proves GET /status refuses an anonymous caller through that guard (the former optional guard mounted it anonymous when omitted), and the /check cases prove the internal-token route is not behind the session guard.
 */

import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { registerLlmGovernanceRoutes } from '@/app/routes/llm-governance-routes';

const SAVED_INTERNAL_TOKEN = process.env.OSHAL_INTERNAL_TOKEN;
const SAVED_SESSION_SECRET = process.env.SESSION_SECRET;
let server: Server | undefined;
let sessionGuardCalls = 0;

/** @description A session guard that refuses every caller, the way requiresAuth refuses an anonymous one. */
const denyingSessionGuard: RequestHandler = (_req, res) => {
  sessionGuardCalls += 1;
  res.status(401).json({ error: 'not_authenticated' });
};

/** @description Restores one environment value without converting absence into text. */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** @description Starts only the governance router on an ephemeral loopback port. */
async function startGovernanceApp(): Promise<string> {
  const app = express();
  app.use(express.json());
  registerLlmGovernanceRoutes(app, { pool: null }, denyingSessionGuard);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Governance auth spec did not bind');
  return `http://127.0.0.1:${address.port}`;
}

/** @description Posts one internal governance pre-flight with an optional credential. */
function postCheck(base: string, token?: string): Promise<Response> {
  return fetch(`${base}/api/llm-governance/check`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-oshal-internal': token } : {}),
    },
    body: JSON.stringify({ requestedModel: 'test-model' }),
  });
}

afterEach(async () => {
  restoreEnv('OSHAL_INTERNAL_TOKEN', SAVED_INTERNAL_TOKEN);
  restoreEnv('SESSION_SECRET', SAVED_SESSION_SECRET);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  sessionGuardCalls = 0;
});

describe('LLM governance internal caller authentication', () => {
  it('fails closed when neither supported secret is configured', async () => {
    delete process.env.OSHAL_INTERNAL_TOKEN;
    delete process.env.SESSION_SECRET;
    const base = await startGovernanceApp();
    expect((await postCheck(base)).status).toBe(403);
  });

  it('rejects an incorrect credential and accepts the exact configured token', async () => {
    process.env.OSHAL_INTERNAL_TOKEN = 'governance-machine-token';
    delete process.env.SESSION_SECRET;
    const base = await startGovernanceApp();
    expect((await postCheck(base, 'governance-machine-tokeN')).status).toBe(403);
    const accepted = await postCheck(base, 'governance-machine-token');
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, allowed: true });
  });

  it('applies the session guard to GET /status, so an anonymous caller is refused', async () => {
    const base = await startGovernanceApp();
    const status = await fetch(`${base}/api/llm-governance/status`);
    expect(status.status).toBe(401);
    expect(sessionGuardCalls).toBe(1);
  });

  it('keeps /check on its internal token alone, never behind the session guard', async () => {
    process.env.OSHAL_INTERNAL_TOKEN = 'governance-machine-token';
    const base = await startGovernanceApp();
    expect((await postCheck(base, 'governance-machine-token')).status).toBe(200);
    expect(sessionGuardCalls).toBe(0);
  });
});
