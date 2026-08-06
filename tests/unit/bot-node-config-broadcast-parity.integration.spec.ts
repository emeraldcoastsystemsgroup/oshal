/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove the complete in-memory ADR-034 bot-node parity chain: a local PUT broadcasts through the real mesh service, ConfigSyncService records one authoritative version, and the real BotNodeClient applies the accepted value to another live replica without an echo broadcast or restart.
 */

import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
}));

import {
  registerBotNodeLlmProviderRoute,
  type ActiveBotNodeProvider,
  type ConfigChangePublisher,
} from '../../src/app/bot-node-llm-provider-route';
import type { AgentConfigService } from '../../src/features/agent-management/services/agent-config-service';
import { BotNodeClient } from '../../src/features/agent-management/services/bot-node-client';
import {
  MeshCommunicationService,
  type ConsumedEnvelope,
  type MeshEnvelope,
  type MeshSubscription,
  type MeshTransport,
} from '../../src/features/agent-management/services/mesh-communication-service';
import { ConfigSyncService } from '../../src/features/config-sync/services/config-sync-service';

const LOGICAL_AGENT_ID = 'a0000000-0000-0000-0000-00000000cafe';
const allowInternalCall: RequestHandler = (_req, _res, next) => next();

/**
 * @description Deterministic mesh transport that executes subscribed consumers before publish
 * resolves. It keeps the production MeshCommunicationService in the path while replacing only
 * Redis persistence/polling, which this contract does not claim to test.
 */
class InMemoryMeshTransport implements MeshTransport {
  readonly published: MeshEnvelope[] = [];
  private readonly handlers = new Map<
    string,
    Set<(envelope: MeshEnvelope, entryId: string) => Promise<void>>
  >();

  async publish(envelope: MeshEnvelope): Promise<void> {
    this.published.push(envelope);
    const handlers = [...(this.handlers.get(envelope.channel) ?? [])];
    await Promise.all(
      handlers.map((handler, index) => handler(envelope, `memory-${this.published.length}-${index}`)),
    );
  }

  async consume(
    _channel: string,
    _consumerId: string,
    _count?: number,
  ): Promise<ConsumedEnvelope[]> {
    return [];
  }

  async ack(_channel: string, _entryId: string, _group?: string): Promise<void> {}

  subscribe(
    channel: string,
    _consumerId: string,
    handler: (envelope: MeshEnvelope, entryId: string) => Promise<void>,
    _pollIntervalMs?: number,
  ): MeshSubscription {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return {
      stop: () => {
        handlers.delete(handler);
      },
    };
  }
}

/** @description In-memory AgentConfigService contract with observable authoritative writes. */
function makeAgentConfigStore() {
  const values = new Map<string, Record<string, unknown>>();
  const writes: Array<{ agentId: string; values: Record<string, unknown> }> = [];
  const service = {
    async getConfig(agentId: string) {
      const current = values.get(agentId);
      return current
        ? {
            configId: 'in-memory-config',
            agentId,
            schema: [],
            values: current,
            updatedAt: new Date(0).toISOString(),
          }
        : null;
    },
    async setConfigValues(agentId: string, next: Record<string, unknown>) {
      writes.push({ agentId, values: { ...next } });
      values.set(agentId, { ...(values.get(agentId) ?? {}), ...next });
    },
  } as unknown as AgentConfigService;
  return { service, values, writes };
}

/** @description Mutable bot runtime seam used by both independently running route instances. */
function makeRuntime(provider: string, model: string) {
  const state: ActiveBotNodeProvider = { provider, model };
  const setActiveProvider = vi.fn((nextProvider: string, nextModel?: string) => {
    state.provider = nextProvider;
    if (nextModel) state.model = nextModel;
    return { ...state };
  });
  return { state, setActiveProvider };
}

/** @description Boots one real Express provider route on an ephemeral loopback port. */
async function bootBotRoute(
  runtime: ReturnType<typeof makeRuntime>,
  meshTransport: ConfigChangePublisher,
): Promise<{ server: Server; endpoint: string }> {
  const app = express();
  app.use(express.json());
  registerBotNodeLlmProviderRoute(app, {
    agentId: LOGICAL_AGENT_ID,
    authorize: allowInternalCall,
    setActiveProvider: runtime.setActiveProvider,
    meshTransport,
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { server, endpoint: `http://127.0.0.1:${port}` };
}

describe('bot-node config broadcast parity integration', () => {
  const servers: Server[] = [];
  const meshes: MeshCommunicationService[] = [];

  afterEach(async () => {
    for (const mesh of meshes.splice(0)) mesh.stopAll();
    await Promise.all(
      servers.splice(0).map(
        (server) => new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        }),
      ),
    );
  });

  it('propagates one local PUT through controller reconciliation to a second live replica', async () => {
    const transport = new InMemoryMeshTransport();
    const mesh = new MeshCommunicationService(transport);
    meshes.push(mesh);

    const peerRuntime = makeRuntime('cline-cli', 'cline-before');
    const peerPublish = vi.fn(async (_envelope: MeshEnvelope) => undefined);
    const peer = await bootBotRoute(peerRuntime, { publish: peerPublish });
    servers.push(peer.server);

    const authoritative = makeAgentConfigStore();
    const botNodeClient = new BotNodeClient(() => peer.endpoint, 2_000);
    const configSync = new ConfigSyncService({
      mesh,
      agentConfig: authoritative.service,
      botNodeClient,
    });
    configSync.start();

    const sourceRuntime = makeRuntime('openai-codex', 'gpt-before');
    const source = await bootBotRoute(sourceRuntime, {
      publish: (envelope) => mesh.send(envelope),
    });
    servers.push(source.server);

    const response = await fetch(`${source.endpoint}/api/llm-provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude-code', model: 'claude-sonnet-4-6' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: 'claude-code',
      model: 'claude-sonnet-4-6',
      active: true,
    });
    expect(sourceRuntime.state).toEqual({
      provider: 'claude-code',
      model: 'claude-sonnet-4-6',
    });
    expect(peerRuntime.state).toEqual({
      provider: 'claude-code',
      model: 'claude-sonnet-4-6',
    });

    expect(transport.published).toHaveLength(1);
    expect(transport.published[0]).toMatchObject({
      fromAgentId: LOGICAL_AGENT_ID,
      channel: 'swarm.config-change',
      messageType: 'broadcast',
      payload: {
        agentId: LOGICAL_AGENT_ID,
        params: { providerId: 'claude-code', modelId: 'claude-sonnet-4-6' },
        source: 'bot-local',
      },
    });
    expect(authoritative.writes).toHaveLength(1);
    expect(authoritative.values.get(LOGICAL_AGENT_ID)).toEqual({
      providerId: 'claude-code',
      modelId: 'claude-sonnet-4-6',
      configVersion: 1,
      configUpdatedBy: 'bot-local',
    });

    // The real BotNodeClient marks the peer PUT as oshal-push. The peer route therefore applies
    // once but does not publish, proving both convergence and the feedback-loop guard end to end.
    expect(peerRuntime.setActiveProvider).toHaveBeenCalledTimes(1);
    expect(peerPublish).not.toHaveBeenCalled();
  });
});
