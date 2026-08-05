/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the machine-only LLM governance check so an unset or incorrect internal secret is rejected and only the exact configured credential reaches quota evaluation.
 */

import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { registerLlmGovernanceRoutes } from '@/app/routes/llm-governance-routes';

const SAVED_INTERNAL_TOKEN = process.env.OSHAL_INTERNAL_TOKEN;
const SAVED_SESSION_SECRET = process.env.SESSION_SECRET;
let server: Server | undefined;

/** @description Restores one environment value without converting absence into text. */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** @description Starts only the governance router on an ephemeral loopback port. */
async function startGovernanceApp(): Promise<string> {
  const app = express();
  app.use(express.json());
  registerLlmGovernanceRoutes(app, { pool: null });
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
});
