/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-034 bot-node config-surface guard: PUT /api/llm-provider applies + broadcasts exactly one swarm.config-change envelope (source bot-local, shape ConfigSyncService.reconcile accepts); X-Config-Source: oshal-push applies WITHOUT broadcasting (echo-loop guard); unknown provider → 400 with NO switch and NO broadcast; broadcast failure never fails the request; service-secret gate enforced when configured; wiring assertions pin the route mounted in bot-node-server.ts and the setActiveProvider seam in bot-node-runtime.ts. Goes red if the route, the echo guard, or the broadcast disappears — i.e. if push-down 404s again or a bot-node stops reporting local changes up.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Align all route cases with the strict bot-node service-secret posture and guard credential-field rejection before runtime mutation.
 */

import express from 'express';
import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the route module's logger so the broadcast-failure ERROR is assertable
// (and so the real auth gate's fail-open WARNs stay silent in test output).
const logSpies = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
}));

import type { MeshEnvelope } from '@/features/agent-management';
import {
  UnknownBotNodeProviderError,
  broadcastBotNodeConfigChange,
  registerBotNodeLlmProviderRoute,
  type ActiveBotNodeProvider,
} from '../../src/app/bot-node-llm-provider-route';
import { authorizeBotNodeInternalCall } from '../../src/app/bot-node-request-auth';

const AGENT_ID = 'a0000000-0000-0000-0000-00000000beef';
const SECRET = 'llm-provider-route-secret';

/** Fake runtime seam mirroring bot-node-runtime's validation contract. */
function makeFakeRuntime(availableProviders: string[] = ['claude-code', 'openai-codex', 'cline-cli']) {
  const state: ActiveBotNodeProvider = { provider: 'openai-codex', model: 'gpt-5.5' };
  const setActiveProvider = vi.fn((provider: string, model?: string): ActiveBotNodeProvider => {
    if (!availableProviders.includes(provider)) {
      throw new UnknownBotNodeProviderError(provider, availableProviders);
    }
    state.provider = provider;
    if (model) state.model = model;
    return { ...state };
  });
  return { state, setActiveProvider };
}

describe('bot-node PUT /api/llm-provider (ADR-034 push-down + broadcast-up)', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.SWARM_SERVICE_SECRET;
    process.env.SWARM_SERVICE_SECRET = SECRET;
    logSpies.warn.mockClear();
    logSpies.info.mockClear();
    logSpies.error.mockClear();
  });
  afterEach(async () => {
    if (savedSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
    else process.env.SWARM_SERVICE_SECRET = savedSecret;
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(r))));
    servers.length = 0;
  });

  async function boot(overrides: {
    setActiveProvider?: ReturnType<typeof makeFakeRuntime>['setActiveProvider'];
    publish?: (envelope: MeshEnvelope) => Promise<void>;
  } = {}): Promise<{ url: string; publish: ReturnType<typeof vi.fn>; runtime: ReturnType<typeof makeFakeRuntime> }> {
    const runtime = makeFakeRuntime();
    const publish = vi.fn(overrides.publish ?? (async () => undefined));
    const app = express();
    app.use(express.json());
    registerBotNodeLlmProviderRoute(app, {
      agentId: AGENT_ID,
      authorize: authorizeBotNodeInternalCall,
      setActiveProvider: overrides.setActiveProvider ?? runtime.setActiveProvider,
      meshTransport: { publish },
    });
    const server = app.listen(0);
    servers.push(server);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    return { url: `http://127.0.0.1:${addr.port}/api/llm-provider`, publish, runtime };
  }

  const put = (url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-service-secret': SECRET, ...headers },
      body: JSON.stringify(body),
    });

  it('applies a valid switch and publishes exactly one swarm.config-change envelope (source bot-local)', async () => {
    const { url, publish, runtime } = await boot();
    const res = await put(url, { provider: 'claude-code', model: 'claude-sonnet-4-6' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: 'claude-code', model: 'claude-sonnet-4-6', active: true });
    expect(runtime.setActiveProvider).toHaveBeenCalledWith('claude-code', 'claude-sonnet-4-6');

    expect(publish).toHaveBeenCalledTimes(1);
    const envelope = publish.mock.calls[0][0] as MeshEnvelope;
    expect(envelope.channel).toBe('swarm.config-change');
    expect(envelope.fromAgentId).toBe(AGENT_ID);
    expect(envelope.messageType).toBe('broadcast');
    // The exact shape ConfigSyncService.handleConfigChange requires to reconcile:
    // a string agentId plus a params object — malformed payloads are dropped there.
    expect(envelope.payload).toMatchObject({
      agentId: AGENT_ID,
      params: { providerId: 'claude-code', modelId: 'claude-sonnet-4-6' },
      source: 'bot-local',
      runtime: 'bot-node',
    });
  });

  it('applies but does NOT broadcast when X-Config-Source: oshal-push (echo-loop guard)', async () => {
    const { url, publish, runtime } = await boot();
    const res = await put(url, { provider: 'cline-cli' }, { 'X-Config-Source': 'oshal-push' });
    expect(res.status).toBe(200);
    expect(runtime.setActiveProvider).toHaveBeenCalledTimes(1);
    // The guard is load-bearing: without it a controller push-down bounces back as a
    // broadcast-up and re-bumps the authoritative configVersion forever.
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider with 400 — no switch, no broadcast', async () => {
    const { url, publish, runtime } = await boot();
    const res = await put(url, { provider: 'bedrock' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("Unknown or unavailable provider 'bedrock'");
    expect(runtime.state.provider).toBe('openai-codex'); // unchanged
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a missing/blank provider and a non-string model with 400 before touching the runtime', async () => {
    const { url, publish, runtime } = await boot();
    expect((await put(url, {})).status).toBe(400);
    expect((await put(url, { provider: '   ' })).status).toBe(400);
    expect((await put(url, { provider: 'claude-code', model: 42 })).status).toBe(400);
    expect(runtime.setActiveProvider).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects any credential carrier before switching or broadcasting', async () => {
    const { url, publish, runtime } = await boot();
    const res = await put(url, {
      provider: 'claude-code',
      credentials: { ANTHROPIC_API_KEY: 'sentinel-secret' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'credential fields are not accepted on runtime configuration mutations',
    });
    expect(runtime.setActiveProvider).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('still answers 200 when the broadcast fails (best-effort, logged at ERROR)', async () => {
    const { url } = await boot({ publish: async () => { throw new Error('redis down'); } });
    const res = await put(url, { provider: 'claude-code' });
    expect(res.status).toBe(200);
    expect((await res.json() as { active: boolean }).active).toBe(true);
    expect(logSpies.error).toHaveBeenCalled();
  });

  it('enforces the service secret when configured (401 without/wrong header, 200 with)', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    const { url, publish } = await boot();
    expect((await put(url, { provider: 'claude-code' }, { 'x-service-secret': '' })).status).toBe(401);
    expect((await put(url, { provider: 'claude-code' }, { 'x-service-secret': 'wrong' })).status).toBe(401);
    expect(publish).not.toHaveBeenCalled();
    expect((await put(url, { provider: 'claude-code' }, { 'x-service-secret': SECRET })).status).toBe(200);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('broadcastBotNodeConfigChange', () => {
  it('returns true and publishes the MeshEnvelope wire format on success', async () => {
    const publish = vi.fn(async () => undefined);
    const ok = await broadcastBotNodeConfigChange({ publish }, AGENT_ID, { providerId: 'openai-codex', modelId: 'gpt-5.5' });
    expect(ok).toBe(true);
    const envelope = publish.mock.calls[0][0] as MeshEnvelope;
    expect(envelope.toAgentId).toBe('*');
    expect(envelope.channel).toBe('swarm.config-change');
    expect(typeof envelope.correlationId).toBe('string');
  });

  it('returns false (never throws) when publishing fails', async () => {
    const ok = await broadcastBotNodeConfigChange(
      { publish: async () => { throw new Error('boom'); } },
      AGENT_ID,
      { providerId: 'cline-cli' },
    );
    expect(ok).toBe(false);
  });
});

describe('wiring: the route + seam are actually mounted (source assertions)', () => {
  it('bot-node-server.ts registers the route behind authorizeBotNodeCall with the live runtime seam', () => {
    const source = fs.readFileSync('src/app/bot-node-server.ts', 'utf8');
    expect(source).toContain('registerBotNodeLlmProviderRoute(app, {');
    expect(source).toContain('authorize: authorizeBotNodeCall');
    expect(source).toContain('runtime.setActiveProvider(provider, model)');
  });

  it('bot-node-runtime.ts exposes the mutable setActiveProvider seam over the built provider map', () => {
    const source = fs.readFileSync('src/app/bot-node-runtime.ts', 'utf8');
    expect(source).toContain('let activeProviderName');
    expect(source).toContain('getCurrentProvider: () => activeProviderName');
    expect(source).toContain('UnknownBotNodeProviderError');
    // The env overlay must go through the SAME path the boot pull uses, so every
    // downstream env resolver agrees with the switch.
    expect(source).toContain('applyPulledBotConfigToEnv({ providerId: normalized');
  });
});
