/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Behavior coverage for ConfigSyncService — push-down, broadcast-up reconcile, versioning, unreachable-bot safety (ADR-034)
 */

import { expect, test } from '@playwright/test';
import { ConfigSyncService } from '../src/features/config-sync';
import type { MeshCommunicationService } from '../src/features/agent-management/services/mesh-communication-service';
import type { AgentConfigService } from '../src/features/agent-management/services/agent-config-service';
import type { BotNodeClient } from '../src/features/agent-management/services/bot-node-client';

/**
 * @description Builds in-memory fakes for the three ConfigSyncService dependencies so the
 * bidirectional sync behavior can be exercised without Postgres, Redis, or a live bot.
 */
function buildHarness(opts: { hasEndpoint?: boolean; switchFails?: boolean } = {}) {
  const store = new Map<string, Record<string, unknown>>();
  const switchCalls: Array<{ agentId: string; providerId: string; model?: string }> = [];
  let capturedHandler:
    | ((envelope: { payload: Record<string, unknown> }) => Promise<void>)
    | null = null;
  let capturedChannel = '';

  const agentConfig = {
    async getConfig(agentId: string) {
      const values = store.get(agentId);
      return values
        ? { configId: 'c', agentId, schema: [], values, updatedAt: new Date(0).toISOString() }
        : null;
    },
    async setConfigValues(agentId: string, values: Record<string, unknown>) {
      store.set(agentId, { ...(store.get(agentId) ?? {}), ...values });
    },
  } as unknown as AgentConfigService;

  const mesh = {
    subscribe(channel: string, _consumerId: string, handler: typeof capturedHandler) {
      capturedChannel = channel;
      capturedHandler = handler;
      return { stop() {} };
    },
  } as unknown as MeshCommunicationService;

  const botNodeClient = {
    hasEndpoint() {
      return opts.hasEndpoint ?? true;
    },
    async switchProvider(agentId: string, providerId: string, model?: string) {
      if (opts.switchFails) {
        throw new Error('bot unreachable');
      }
      switchCalls.push({ agentId, providerId, model });
    },
  } as unknown as BotNodeClient;

  const service = new ConfigSyncService({ mesh, agentConfig, botNodeClient });
  return {
    service,
    store,
    switchCalls,
    getChannel: () => capturedChannel,
    fireConfigChange: (payload: Record<string, unknown>) => capturedHandler!({ payload }),
  };
}

test('push-down applies to the live bot and advances the authoritative version', async () => {
  const h = buildHarness({ hasEndpoint: true });
  const result = await h.service.pushToBot('bot-1', { providerId: 'gemini', modelId: 'gemini-3.1-pro' });

  expect(result.pushed).toBe(true);
  expect(result.newVersion).toBe(1);
  expect(h.switchCalls).toEqual([{ agentId: 'bot-1', providerId: 'gemini', model: 'gemini-3.1-pro' }]);
  expect(h.store.get('bot-1')).toMatchObject({ providerId: 'gemini', modelId: 'gemini-3.1-pro', configVersion: 1 });
});

test('push-down to an unreachable bot does NOT advance the authoritative record', async () => {
  const h = buildHarness({ hasEndpoint: true, switchFails: true });
  const result = await h.service.pushToBot('bot-1', { providerId: 'openai', modelId: 'gpt-x' });

  expect(result.pushed).toBe(false);
  expect(result.reason).toContain('unreachable');
  // Record must remain unset — a swallowed failure here is exactly the ownership-fight bug.
  expect(h.store.get('bot-1')).toBeUndefined();
});

test('push-down to a local bot (no endpoint) records authoritatively without an HTTP push', async () => {
  const h = buildHarness({ hasEndpoint: false });
  const result = await h.service.pushToBot('pm-bot', { providerId: 'anthropic', modelId: 'claude-x' });

  expect(result.pushed).toBe(false); // no remote push happened...
  expect(result.newVersion).toBe(1); // ...but the record advanced
  expect(h.switchCalls).toHaveLength(0);
  expect(h.store.get('pm-bot')).toMatchObject({ providerId: 'anthropic', configVersion: 1 });
});

test('broadcast-up reconcile records the bot-reported change and bumps version each time', async () => {
  const h = buildHarness();
  const v1 = await h.service.reconcile({ agentId: 'bot-2', params: { providerId: 'ollama' }, source: 'bot-local' });
  const v2 = await h.service.reconcile({ agentId: 'bot-2', params: { modelId: 'llama-4' }, source: 'bot-local' });

  expect(v1).toBe(1);
  expect(v2).toBe(2);
  expect(h.store.get('bot-2')).toMatchObject({ providerId: 'ollama', modelId: 'llama-4', configVersion: 2 });
});

test('start() subscribes to the config-change channel and reconciles incoming broadcasts', async () => {
  const h = buildHarness();
  h.service.start();
  expect(h.getChannel()).toBe('swarm.config-change');

  await h.fireConfigChange({ agentId: 'bot-3', params: { providerId: 'bedrock' }, source: 'bot-local' });
  expect(h.store.get('bot-3')).toMatchObject({ providerId: 'bedrock', configVersion: 1 });
});

test('malformed broadcast envelope is ignored, not recorded', async () => {
  const h = buildHarness();
  h.service.start();
  await h.fireConfigChange({ nonsense: true });
  expect(h.store.size).toBe(0);
});
