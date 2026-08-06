/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard authoritative-runtime-config-precedence: direct clients cannot mutate a registry-pinned provider, model-only writes omit that provider, runtime refusal is explicit, and successful responses carry applied/pushed/version/effective truth
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: credential fields are rejected before config reads or push-down; successful runtime mutation carries provider/model only.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exercise mutations through an exact operator browser identity after the control-plane authorization gate became fail-closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createConfigRuntimeRoutes } from '@/app/extensions/swarm/routes/config-runtime-routes';
import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import type { ConfigSyncService } from '@/features/config-sync';
import type { AgentConfigService } from '@/features/agent-management';

let activeServer: Server | undefined;
let savedOperatorSubs: string | undefined;

beforeEach(() => {
  savedOperatorSubs = process.env.OSHAL_OPERATOR_SUBS;
  process.env.OSHAL_OPERATOR_SUBS = 'runtime-config-operator';
});

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve, reject) => {
      activeServer?.close((err) => (err ? reject(err) : resolve()));
    });
    activeServer = undefined;
  }
  if (savedOperatorSubs === undefined) delete process.env.OSHAL_OPERATOR_SUBS;
  else process.env.OSHAL_OPERATOR_SUBS = savedOperatorSubs;
});

async function listen(
  configSync: ConfigSyncService,
  agentConfig: AgentConfigService,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { oidc?: unknown }).oidc = {
      isAuthenticated: () => true,
      user: { sub: 'runtime-config-operator' },
    };
    next();
  });
  app.use('/api/agents', createConfigRuntimeRoutes(configSync, agentConfig));
  activeServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => activeServer?.once('listening', resolve));
  return `http://127.0.0.1:${(activeServer.address() as AddressInfo).port}/api/agents`;
}

function jsonPut(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('authoritative-runtime-config-precedence', () => {
  it('rejects pinned providers and accepts a provider-free model mutation with truthful output', async () => {
    const pinned = getActiveRegistry().find(
      (bot) => bot.agentId && bot.harnessType && bot.harnessType !== 'cline',
    );
    expect(pinned?.agentId, 'the shipped registry must retain a pinned bot for this guard').toBeTruthy();
    const agentId = pinned!.agentId!;
    const values = { providerId: 'stale-profile-provider', modelId: 'old-model', configVersion: 7 };
    const getConfig = vi.fn(async () => ({
      configId: 'config-1',
      agentId,
      schema: [],
      values,
      updatedAt: '2026-08-05T00:00:00.000Z',
    }));
    const pushToBot = vi.fn()
      .mockResolvedValueOnce({ pushed: true, newVersion: 8 })
      .mockResolvedValueOnce({ pushed: false, reason: 'worker unreachable' });
    const agentConfig = { getConfig } as unknown as AgentConfigService;
    const configSync = { pushToBot } as unknown as ConfigSyncService;
    const base = await listen(configSync, agentConfig);

    const conflict = await jsonPut(`${base}/${encodeURIComponent(agentId)}/runtime`, {
      providerId: 'anthropic',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      applied: false,
      pushed: false,
      code: 'provider_pinned',
    });
    expect(pushToBot).not.toHaveBeenCalled();

    const readsBeforeCredentialCarrier = getConfig.mock.calls.length;
    const credentialCarrier = await jsonPut(`${base}/${encodeURIComponent(agentId)}/runtime`, {
      modelId: 'must-not-apply',
      credentials: { API_KEY: 'sentinel-secret' },
    });
    expect(credentialCarrier.status).toBe(400);
    expect(await credentialCarrier.json()).toMatchObject({
      success: false,
      applied: false,
      error: 'credential fields are not accepted on runtime configuration mutations',
    });
    expect(getConfig).toHaveBeenCalledTimes(readsBeforeCredentialCarrier);
    expect(pushToBot).not.toHaveBeenCalled();

    const accepted = await jsonPut(`${base}/${encodeURIComponent(agentId)}/runtime`, {
      modelId: 'new-model',
    });
    expect(accepted.status).toBe(200);
    expect(pushToBot).toHaveBeenCalledWith(agentId, { modelId: 'new-model' });
    expect(await accepted.json()).toMatchObject({
      applied: true,
      pushed: true,
      configVersion: 8,
      effectiveProvider: pinned!.apiType ?? pinned!.harnessType,
      effectiveModel: 'new-model',
    });

    const refused = await jsonPut(`${base}/${encodeURIComponent(agentId)}/runtime`, {
      modelId: 'refused-model',
    });
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({
      applied: false,
      pushed: false,
      error: 'worker unreachable',
      effectiveModel: 'old-model',
    });
  });
});
