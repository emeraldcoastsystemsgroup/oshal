/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard authoritative-runtime-config-precedence: direct clients cannot mutate a registry-pinned provider, model-only writes omit that provider, runtime refusal is explicit, and successful responses carry applied/pushed/version/effective truth
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: credential fields are rejected before config reads or push-down; successful runtime mutation carries provider/model only.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exercise mutations through an exact operator browser identity after the control-plane authorization gate became fail-closed.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | INVERTED, not deleted (BACKLOG "A bot's LLM provider is a row in a table"): the record this route writes IS the per-bot switch row, so a declared registry harness is no longer a ceiling — a provider write on a registry-pinned bot is ACCEPTED (200, pushed, and the switch snapshot re-read through onRuntimeChanged), while an id the build cannot run is refused by name with 400 provider_unknown before any push. The credential-carrier refusal, the model-only path and the 502 truth are unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createConfigRuntimeRoutes, type RuntimeRouteSwitchDeps } from '@/app/extensions/swarm/routes/config-runtime-routes';
import { HARNESS_FACTORIES } from '@/app/composition/provider-runtime';
import { buildProviderSwitchCatalog } from '@/app/composition/provider-switch-runtime';
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
  switches: RuntimeRouteSwitchDeps = {},
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
  app.use('/api/agents', createConfigRuntimeRoutes(configSync, agentConfig, switches));
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
  it('a declared registry harness is no longer a ceiling: a provider write is the switch row, an unknown id is refused by name', async () => {
    // INVERTED 2026-09-17. This case asserted 409 provider_pinned for exactly this write.
    const pinned = getActiveRegistry().find(
      (bot) => bot.agentId && bot.harnessType && bot.harnessType !== 'cline',
    );
    expect(pinned?.agentId, 'the shipped registry must retain a declared-harness bot for this guard').toBeTruthy();
    const agentId = pinned!.agentId!;
    const getConfig = vi.fn(async () => ({
      configId: 'config-1', agentId, schema: [], values: { configVersion: 1 }, updatedAt: '2026-09-17T00:00:00.000Z',
    }));
    const pushToBot = vi.fn().mockResolvedValue({ pushed: true, newVersion: 2 });
    const onRuntimeChanged = vi.fn(async () => undefined);
    const catalog = buildProviderSwitchCatalog(Object.keys(HARNESS_FACTORIES));
    const base = await listen(
      { pushToBot } as unknown as ConfigSyncService,
      { getConfig } as unknown as AgentConfigService,
      { catalog: () => catalog, onRuntimeChanged },
    );

    const unknown = await jsonPut(`${base}/${encodeURIComponent(agentId)}/runtime`, { providerId: 'gemini-3.8-flash' });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ applied: false, pushed: false, code: 'provider_unknown' });
    expect(pushToBot).not.toHaveBeenCalled();
    expect(onRuntimeChanged).not.toHaveBeenCalled();

    // A Cline-backed API provider id from provider-definitions is a valid switch: written and pushed.
    const accepted = await jsonPut(`${base}/${encodeURIComponent(agentId)}/runtime`, { providerId: 'gemini', modelId: 'gemini-3.8-flash' });
    expect(accepted.status).toBe(200);
    expect(pushToBot).toHaveBeenCalledWith(agentId, { providerId: 'gemini', modelId: 'gemini-3.8-flash' });
    expect(onRuntimeChanged).toHaveBeenCalledTimes(1);
    expect(await accepted.json()).toMatchObject({ applied: true, pushed: true, configVersion: 2 });
  });

  it('refuses credential carriers, accepts a provider-free model mutation, and reports a push refusal truthfully', async () => {
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
