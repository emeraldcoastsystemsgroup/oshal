/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Localhost-dispatch tests now capture via a real loopback /api/send-message stub — dispatch rides node:http.request (fa042a24, undici 5-min headersTimeout), so the old globalThis.fetch mock intercepted nothing; fetch is now poisoned to prove the localhost leg never regresses onto it
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InternalTicket } from '../../src/entities/ticket/internal-ticket';
import type { BotNodeClient } from '../../src/features/agent-management/services/bot-node-client';
import { createRegistryEndpointResolver } from '../../src/features/agent-management/services/bot-node-client';
import type { TicketService } from '../../src/features/ticketing';
import type { WorkflowDefinition } from '../../src/features/swarm-orchestration/services/dispatch-routing';
import { dispatchManifestWorkerTicket } from '../../src/features/swarm-orchestration/services/dispatch-manifest-worker';

const ENV_KEYS = ['RUNNING_IN_DOCKER', 'AGENT_ID', 'BOT_NAME', 'SWARM_REGISTRY', 'SWARM_SERVICE_SECRET'] as const;
const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const EATS_AGENT_ID = 'b0080000-0000-0000-0000-000000000001';
const SHOPPING_AGENT_ID = 'b0070000-0000-0000-0000-000000000001';
const endpointRegistry = [
  {
    agentId: 'a0000000-0000-0000-0000-000000000001',
    name: 'project-manager',
    port: 3010,
    container: 'oshal-api',
  },
  {
    agentId: 'a0000000-0000-0000-0000-0000000000e1',
    name: 'project-manager-stub',
    port: 3010,
    container: 'oshal-local-api',
  },
  {
    agentId: 'b0070000-0000-0000-0000-000000000001',
    name: 'shopping-concierge',
    port: 3069,
    container: 'oshal-api',
  },
  {
    agentId: 'b0080000-0000-0000-0000-000000000001',
    name: 'eats-concierge',
    port: 3071,
    container: 'eats-bot',
  },
  {
    agentId: 'b0090000-0000-0000-0000-000000000001',
    name: 'rides-concierge',
    port: 3072,
    container: 'rides-bot',
  },
];

for (const key of ENV_KEYS) {
  originalEnv.set(key, process.env[key]);
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function defaultResolverEnv(): void {
  delete process.env.AGENT_ID;
  delete process.env.BOT_NAME;
  delete process.env.SWARM_REGISTRY;
  process.env.RUNNING_IN_DOCKER = 'true';
}

function buildTicket(overrides: Partial<InternalTicket> = {}): InternalTicket {
  return {
    ticketId: '11111111-1111-4111-8111-111111111111',
    ticketType: 'task',
    title: 'Summarize the inbox',
    description: 'Find the important stuff.',
    status: 'approved',
    stateGroup: 'active',
    executionPhase: null,
    priority: 'medium',
    labels: [],
    workspaceId: null,
    assignedAgentId: null,
    parentTicketId: null,
    externalProvider: null,
    externalId: null,
    externalUrl: null,
    metadata: {},
    ownerSub: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function buildWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    ticketType: 'task',
    name: 'Jarvis Assistant Task',
    pipeline: 'manifest-worker',
    workerBot: 'project-manager',
    ...overrides,
  };
}

function mixedDomainCallOut() {
  return {
    agentId: EATS_AGENT_ID,
    agentName: 'eats-concierge',
    strategy: 'bid',
    confident: true,
    owners: [
      { agentId: EATS_AGENT_ID, agentName: 'eats-concierge', confidence: 0.65 },
      { agentId: SHOPPING_AGENT_ID, agentName: 'shopping-concierge', confidence: 0.60 },
    ],
  };
}

function buildTicketService() {
  return {
    updateStatus: vi.fn(async () => undefined),
  } as unknown as TicketService & { updateStatus: ReturnType<typeof vi.fn> };
}

function buildConversationStores(initialTask: { taskId: string; ownerSub?: string | null } | null = null) {
  let task: { taskId: string; ownerSub?: string | null } | null = initialTask;
  const messages: Array<{
    messageId: string;
    taskId: string;
    role: 'assistant';
    type: 'completion';
    text: string;
    contentBlocks: [];
    metadata: Record<string, unknown>;
    createdAt: string;
  }> = [];
  const taskStore = {
    get: vi.fn(async () => task),
    create: vi.fn(async (input: { taskId: string; ownerSub?: string }) => {
      task = { taskId: input.taskId, ownerSub: input.ownerSub ?? null };
      return task;
    }),
    incrementMessageCount: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
  };
  const messageStore = {
    getByTask: vi.fn(async () => [...messages]),
    save: vi.fn(async (input: Omit<(typeof messages)[number], 'messageId' | 'createdAt'>) => {
      const stored = {
        ...input,
        messageId: '22222222-2222-4222-8222-222222222222',
        createdAt: new Date(0).toISOString(),
      };
      messages.push(stored);
      return stored;
    }),
  };
  return { taskStore, messageStore, messages };
}

interface CapturedSendMessage {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/**
 * Real loopback stand-in for the controller's /api/send-message endpoint.
 * dispatchManifestWorkerTicket posts the localhost leg over node:http.request
 * (NOT global fetch — undici's ~5-minute headersTimeout aborted long worker
 * runs), so only a listening server can observe the dispatch.
 */
async function startSendMessageStub(
  status: number,
  responseBody: Record<string, unknown>,
): Promise<{ port: string; calls: CapturedSendMessage[]; close: () => Promise<void> }> {
  const calls: CapturedSendMessage[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => {
      calls.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: data.trim() ? JSON.parse(data) as Record<string, unknown> : {},
      });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = String((server.address() as AddressInfo).port);
  const close = (): Promise<void> => new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
  return { port, calls, close };
}

describe('bot-node endpoint boundary', () => {
  beforeEach(() => {
    defaultResolverEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('does not expose controller-inline registry entries as bot-node endpoints', () => {
    const resolve = createRegistryEndpointResolver(() => endpointRegistry);

    expect(resolve('a0000000-0000-0000-0000-000000000001')).toBeNull();
    expect(resolve('a0000000-0000-0000-0000-0000000000e1')).toBeNull();
    expect(resolve('b0070000-0000-0000-0000-000000000001')).toBeNull();
  });

  it('still resolves dedicated bot-node containers', () => {
    const resolve = createRegistryEndpointResolver(() => endpointRegistry);

    expect(resolve('b0080000-0000-0000-0000-000000000001')).toBe('http://eats-bot:5000');
    expect(resolve('b0090000-0000-0000-0000-000000000001')).toBe('http://rides-bot:5000');
  });
});

describe('dispatchManifestWorkerTicket bot-node boundary', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('uses localhost dispatch without remote execution when the target has no bot-node endpoint', async () => {
    process.env.SWARM_SERVICE_SECRET = 'unit-secret';
    // The localhost leg must ride node:http.request, never fetch — undici's
    // ~5-minute headersTimeout aborts long-running worker dispatches.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('localhost dispatch must not use fetch');
    }) as typeof fetch;
    const stub = await startSendMessageStub(200, { success: true, response: 'done' });

    const ticketService = buildTicketService();
    const stores = buildConversationStores();
    const botNodeClient = {
      hasEndpoint: vi.fn(() => false),
      execute: vi.fn(async () => {
        throw new Error('should not execute remotely');
      }),
    } as unknown as BotNodeClient;

    try {
      await dispatchManifestWorkerTicket(buildTicket(), buildWorkflow(), {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveAgentIdByName: async () => 'inline-agent',
        botNodeClient,
        ticketService,
        taskStore: stores.taskStore as never,
        messageStore: stores.messageStore as never,
        port: stub.port,
      });
    } finally {
      await stub.close();
    }

    expect(botNodeClient.hasEndpoint).toHaveBeenCalledWith('inline-agent');
    expect(botNodeClient.execute).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(stores.taskStore.create).not.toHaveBeenCalled();
    expect(stores.messageStore.save).not.toHaveBeenCalled();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/send-message',
      body: {
        taskId: '11111111-1111-4111-8111-111111111111',
        ticketId: '11111111-1111-4111-8111-111111111111',
        agentId: 'inline-agent',
        interactionMode: 'task',
        source: 'dispatch-manifest-worker',
      },
    });
    expect(stub.calls[0].headers['x-service-secret']).toBe('unit-secret');
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'complete',
      expect.objectContaining({ source: 'dispatch-manifest-worker', workerAgentId: 'inline-agent' }),
    );
  });

  it('uses remote bot-node execution when the target has a real endpoint', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('localhost fallback should not run');
    }) as typeof fetch;

    const ticketService = buildTicketService();
    const stores = buildConversationStores();
    const resolveBotCreds = vi.fn(async () => ({ OSHAL_CRED_GOOGLE: 'owner-google-token' }));
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async () => ({
        success: true,
        response: 'done',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0,
        model: 'test',
        provider: 'test',
        durationMs: 1,
      })),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(buildTicket({ ownerSub: 'owner-123' }), buildWorkflow({ workerBot: 'rides-concierge' }), {
      activeTicketIds: new Set(),
      dispatchStartTimes: new Map(),
      resolveAgentIdByName: async () => 'rides-agent',
      resolveBotCreds,
      botNodeClient,
      ticketService,
      taskStore: stores.taskStore as never,
      messageStore: stores.messageStore as never,
      port: '5555',
    });

    expect(botNodeClient.hasEndpoint).toHaveBeenCalledWith('rides-agent');
    expect(botNodeClient.execute).toHaveBeenCalledWith('rides-agent', expect.objectContaining({
      taskId: '11111111-1111-4111-8111-111111111111',
      workspaceFolderId: '11111111-1111-4111-8111-111111111111',
      agentId: 'rides-agent',
      agenticMode: true,
      userSub: 'owner-123',
      creds: { OSHAL_CRED_GOOGLE: 'owner-google-token' },
    }));
    expect(resolveBotCreds).toHaveBeenCalledWith('owner-123', 'rides-agent');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'complete',
      expect.objectContaining({ source: 'dispatch-manifest-worker', workerAgentId: 'rides-agent' }),
    );
  });

  it('fans out near-tied Eats .65 and Shopping .60 bids into one durable aggregate', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('localhost fallback should not run');
    }) as typeof fetch;

    const ticketService = buildTicketService();
    const stores = buildConversationStores();
    const resolveAgentIdByName = vi.fn(async () => 'general-agent');
    const resolveBotCreds = vi.fn(async (_ownerSub: string, agentId: string) => (
      agentId === EATS_AGENT_ID
        ? { OSHAL_CRED_UBER: 'eats-owner-token' }
        : { OSHAL_CRED_WALMART: 'shopping-owner-token' }
    ));
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async (agentId: string) => ({
        success: true,
        response: agentId === EATS_AGENT_ID
          ? 'Uber Eats options are ready.'
          : 'Fish food shopping options are ready.',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0,
        model: agentId === EATS_AGENT_ID ? 'eats-model' : 'shopping-model',
        provider: 'test-provider',
        durationMs: 1,
        providerRecords: Array.from({ length: 5 }, (_, index) => ({
          kind: agentId === EATS_AGENT_ID ? 'uber-eats' : 'shopping',
          index,
        })),
      })),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(
      buildTicket({
        title: "Order Ben & Jerry's ice cream + fish food",
        description: 'Use Uber Eats for the ice cream and a shopping provider for fish food.',
        ownerSub: 'owner-123',
      }),
      buildWorkflow({ workerBot: 'general-bot' }),
      {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveAgentIdByName,
        resolveTaskWorker: vi.fn(async () => mixedDomainCallOut()),
        botNodeClient,
        resolveBotCreds,
        ticketService,
        taskStore: stores.taskStore as never,
        messageStore: stores.messageStore as never,
        port: '5555',
      },
    );

    expect(resolveAgentIdByName).not.toHaveBeenCalled();
    expect(resolveBotCreds).toHaveBeenCalledTimes(2);
    expect(resolveBotCreds).toHaveBeenCalledWith('owner-123', EATS_AGENT_ID);
    expect(resolveBotCreds).toHaveBeenCalledWith('owner-123', SHOPPING_AGENT_ID);
    expect(botNodeClient.execute).toHaveBeenCalledTimes(2);
    expect(botNodeClient.execute).toHaveBeenCalledWith(
      EATS_AGENT_ID,
      expect.objectContaining({
        agentId: EATS_AGENT_ID,
        creds: { OSHAL_CRED_UBER: 'eats-owner-token' },
        text: expect.stringMatching(/\*\*Your assigned domain:\*\* eats-concierge[\s\S]*Handle only the portion/),
      }),
    );
    expect(botNodeClient.execute).toHaveBeenCalledWith(
      SHOPPING_AGENT_ID,
      expect.objectContaining({
        agentId: SHOPPING_AGENT_ID,
        creds: { OSHAL_CRED_WALMART: 'shopping-owner-token' },
        text: expect.stringMatching(/\*\*Your assigned domain:\*\* shopping-concierge[\s\S]*Handle only the portion/),
      }),
    );
    const workerRequests = botNodeClient.execute.mock.calls.map((call) => call[1] as {
      taskId: string;
      workspaceFolderId: string;
      agentId: string;
    });
    expect(workerRequests).toHaveLength(2);
    for (const request of workerRequests) {
      expect(request.taskId).toBe(request.workspaceFolderId);
      expect(request.taskId).toContain(request.agentId);
      expect(request.taskId).not.toBe('11111111-1111-4111-8111-111111111111');
    }
    expect(workerRequests[0].taskId).not.toBe(workerRequests[1].taskId);
    expect(stores.taskStore.create).toHaveBeenCalledTimes(1);
    expect(stores.taskStore.create).toHaveBeenCalledWith(expect.objectContaining({
      agentId: EATS_AGENT_ID,
      metadata: expect.objectContaining({
        workerBot: 'eats-concierge',
        workerBots: ['eats-concierge', 'shopping-concierge'],
        workerAgentIds: [EATS_AGENT_ID, SHOPPING_AGENT_ID],
        routedBy: 'multi-bid',
      }),
    }));
    expect(stores.messageStore.save).toHaveBeenCalledTimes(1);
    expect(stores.messageStore.save).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/eats-concierge[\s\S]*Uber Eats options[\s\S]*shopping-concierge[\s\S]*Fish food shopping options/),
      metadata: expect.objectContaining({
        workerBot: 'eats-concierge',
        workerAgentId: EATS_AGENT_ID,
        workerBots: ['eats-concierge', 'shopping-concierge'],
        workerAgentIds: [EATS_AGENT_ID, SHOPPING_AGENT_ID],
        routedBy: 'multi-bid',
      }),
    }));
    const providerRecords = stores.messageStore.save.mock.calls[0][0].metadata.providerRecords as unknown[];
    expect(providerRecords).toHaveLength(8);
    expect(providerRecords).toEqual([
      ...Array.from({ length: 5 }, (_, index) => ({ kind: 'uber-eats', index })),
      ...Array.from({ length: 3 }, (_, index) => ({ kind: 'shopping', index })),
    ]);
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'complete',
      expect.objectContaining({
        workerBot: 'eats-concierge',
        workerAgentId: EATS_AGENT_ID,
        workerBots: ['eats-concierge', 'shopping-concierge'],
        workerAgentIds: [EATS_AGENT_ID, SHOPPING_AGENT_ID],
        routedBy: 'multi-bid',
      }),
    );
  });

  it('preserves a successful owner result and requests customer action when its peer fails', async () => {
    const ticketService = buildTicketService();
    const stores = buildConversationStores();
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async (agentId: string) => {
        if (agentId === SHOPPING_AGENT_ID) throw new Error('shopping connector unavailable');
        return {
          success: true,
          response: 'Uber Eats options survived the partial failure.',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: 0,
          model: 'eats-model',
          provider: 'test-provider',
          durationMs: 1,
          providerRecords: [{ kind: 'uber-eats' }],
        };
      }),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(
      buildTicket({ ownerSub: 'owner-123' }),
      buildWorkflow({ workerBot: 'general-bot' }),
      {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveTaskWorker: vi.fn(async () => mixedDomainCallOut()),
        botNodeClient,
        ticketService,
        taskStore: stores.taskStore as never,
        messageStore: stores.messageStore as never,
        port: '5555',
      },
    );

    expect(stores.messageStore.save).toHaveBeenCalledTimes(1);
    expect(stores.messageStore.save).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/Uber Eats options survived[\s\S]*shopping connector unavailable/),
      metadata: expect.objectContaining({
        routedBy: 'multi-bid',
        providerRecords: [{ kind: 'uber-eats' }],
      }),
    }));
    expect(ticketService.updateStatus).toHaveBeenNthCalledWith(
      1,
      '11111111-1111-4111-8111-111111111111',
      'in_process_discovery',
      expect.objectContaining({ reason: 'multi_owner_partial_result_staged' }),
    );
    expect(ticketService.updateStatus).toHaveBeenNthCalledWith(
      2,
      '11111111-1111-4111-8111-111111111111',
      'customer_action',
      expect.objectContaining({
        reason: 'multi_owner_partial_failure',
        disposition: 'partial_result_requires_followup',
      }),
    );
    expect(ticketService.updateStatus).not.toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'complete',
      expect.anything(),
    );
  });

  it('escalates without writing a false aggregate when every selected owner fails', async () => {
    const ticketService = buildTicketService();
    const stores = buildConversationStores();
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async (agentId: string) => {
        throw new Error(`${agentId} unavailable`);
      }),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(
      buildTicket({ ownerSub: 'owner-123' }),
      buildWorkflow({ workerBot: 'general-bot' }),
      {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveTaskWorker: vi.fn(async () => mixedDomainCallOut()),
        botNodeClient,
        ticketService,
        taskStore: stores.taskStore as never,
        messageStore: stores.messageStore as never,
        port: '5555',
      },
    );

    expect(stores.taskStore.create).not.toHaveBeenCalled();
    expect(stores.messageStore.save).not.toHaveBeenCalled();
    expect(ticketService.updateStatus).toHaveBeenCalledTimes(1);
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'escalated',
      expect.objectContaining({
        reason: 'multi_owner_dispatch_failed',
        routedBy: 'multi-bid',
        failedWorkers: expect.arrayContaining([
          expect.objectContaining({ agentId: EATS_AGENT_ID }),
          expect.objectContaining({ agentId: SHOPPING_AGENT_ID }),
        ]),
      }),
    );
  });

  it('falls back to the single bid winner when any near-tied owner lacks a dedicated endpoint', async () => {
    const ticketService = buildTicketService();
    const stores = buildConversationStores();
    const botNodeClient = {
      hasEndpoint: vi.fn((agentId: string) => agentId === EATS_AGENT_ID),
      execute: vi.fn(async () => ({
        success: true,
        response: 'Single Eats winner result.',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0,
        model: 'eats-model',
        provider: 'test-provider',
        durationMs: 1,
      })),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(
      buildTicket({ ownerSub: 'owner-123' }),
      buildWorkflow({ workerBot: 'general-bot' }),
      {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveTaskWorker: vi.fn(async () => mixedDomainCallOut()),
        botNodeClient,
        ticketService,
        taskStore: stores.taskStore as never,
        messageStore: stores.messageStore as never,
        port: '5555',
      },
    );

    expect(botNodeClient.execute).toHaveBeenCalledTimes(1);
    expect(botNodeClient.execute).toHaveBeenCalledWith(
      EATS_AGENT_ID,
      expect.objectContaining({ agentId: EATS_AGENT_ID }),
    );
    expect(stores.messageStore.save).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        workerBot: 'eats-concierge',
        workerAgentId: EATS_AGENT_ID,
        routedBy: 'bid',
      }),
    }));
    const savedMetadata = stores.messageStore.save.mock.calls[0][0].metadata;
    expect(savedMetadata).not.toHaveProperty('workerBots');
    expect(savedMetadata).not.toHaveProperty('workerAgentIds');
  });

  it('escalates a successful remote result when durable conversation stores are not injected', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('localhost fallback should not run');
    }) as typeof fetch;
    const ticketService = buildTicketService();
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async () => ({
        success: true,
        response: 'A result that must not be marked complete until durable.',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0, model: 'test-model', provider: 'test-provider', durationMs: 1,
      })),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(
      buildTicket({ ownerSub: 'durability-owner' }),
      buildWorkflow({ workerBot: 'weather-bot' }),
      {
        activeTicketIds: new Set(), dispatchStartTimes: new Map(),
        resolveAgentIdByName: async () => 'weather-agent',
        botNodeClient, ticketService, port: '5555',
      },
    );

    expect(ticketService.updateStatus).not.toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111', 'complete', expect.anything(),
    );
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'escalated',
      expect.objectContaining({
        reason: 'manifest_worker_dispatch_failed',
        message: 'shared task/message stores are required for durable bot-node completion',
      }),
    );
  });

  it('durably persists a remote bot-node deliverable before completion and skips it on retry', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('localhost fallback should not run');
    }) as typeof fetch;

    const response = 'Weather result: Destin is sunny and 84 F. '.padEnd(704, 'Forecast detail. ');
    const providerRecord = {
      schemaVersion: 1,
      kind: 'nws-weather',
      provider: 'nws',
      sourceRef: 'nws:forecast:destin-2026-07-10',
      retrievedAt: '2026-07-10T14:00:00.000Z',
      record: {
        location: 'Destin, FL',
        timestamp: '2026-07-10T14:00:00.000Z',
        current: { tempF: 84, tempC: 28.9, condition: 'Sunny' },
        periods: [],
      },
    };
    const stores = buildConversationStores();
    const ticketService = buildTicketService();
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async () => ({
        success: true,
        response,
        usage: { inputTokens: 20, outputTokens: 150, totalTokens: 170, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0.01,
        model: 'weather-model',
        provider: 'openai-codex',
        durationMs: 100,
        taskId: 'bot-node-task-1',
        providerRecords: [providerRecord],
      })),
    } as unknown as BotNodeClient;
    const deps = {
      activeTicketIds: new Set<string>(),
      dispatchStartTimes: new Map<string, number>(),
      resolveAgentIdByName: async () => 'weather-agent',
      botNodeClient,
      ticketService,
      taskStore: stores.taskStore as never,
      messageStore: stores.messageStore as never,
      resolveTaskWorker: vi.fn(async () => ({
        agentId: 'wrong-callout-agent', strategy: 'keyword', confident: true,
      })),
      port: '5555',
    };

    const providerIntent = {
      schemaVersion: 1 as const,
      kind: 'weather' as const,
      operation: 'current-forecast' as const,
      location: 'Destin, FL',
    };
    const ownedTicket = buildTicket({
      title: 'Weather today', ownerSub: 'weather-owner', metadata: { providerIntent },
    });
    await dispatchManifestWorkerTicket(ownedTicket, buildWorkflow({ workerBot: 'weather-bot' }), deps);
    await dispatchManifestWorkerTicket(ownedTicket, buildWorkflow({ workerBot: 'weather-bot' }), deps);

    expect(deps.resolveTaskWorker).not.toHaveBeenCalled();
    expect(botNodeClient.execute).toHaveBeenCalledWith('a0000000-0000-0000-0000-000000000036', expect.objectContaining({
      userSub: 'weather-owner',
      providerIntent,
    }));

    expect(stores.taskStore.create).toHaveBeenCalledTimes(1);
    expect(stores.taskStore.create).toHaveBeenCalledWith(expect.objectContaining({
      taskId: '11111111-1111-4111-8111-111111111111',
      title: 'Weather today',
      agentId: 'a0000000-0000-0000-0000-000000000036',
      ownerSub: 'weather-owner',
      metadata: expect.objectContaining({ source: 'dispatch-manifest-worker' }),
    }));
    expect(stores.messageStore.save).toHaveBeenCalledTimes(1);
    expect(stores.messageStore.save).toHaveBeenCalledWith(expect.objectContaining({
      taskId: '11111111-1111-4111-8111-111111111111',
      role: 'assistant',
      type: 'completion',
      text: response,
      metadata: expect.objectContaining({
        source: 'manifest-worker-bot-node',
        manifestWorkerResult: true,
        workerBot: 'weather-bot',
        workerAgentId: 'a0000000-0000-0000-0000-000000000036',
        provider: 'openai-codex',
        model: 'weather-model',
        botNodeTaskId: 'bot-node-task-1',
        providerIntent,
        providerRecords: [providerRecord],
      }),
    }));
    expect(stores.messages).toHaveLength(1);
    expect(stores.messages[0].text).toBe(response);
    await expect(stores.messageStore.getByTask('11111111-1111-4111-8111-111111111111'))
      .resolves.toEqual([expect.objectContaining({ text: response, type: 'completion' })]);
    expect(stores.messageStore.save.mock.invocationCallOrder[0])
      .toBeLessThan(ticketService.updateStatus.mock.invocationCallOrder[0]);
    expect(ticketService.updateStatus).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fails closed before saving or completing when an existing result task is foreign or ownerless', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('localhost fallback should not run');
    }) as typeof fetch;
    const providerRecord = { kind: 'nws-weather', sourceRef: 'nws:forecast:private' };

    for (const existingOwner of ['different-owner', null]) {
      const stores = buildConversationStores({
        taskId: '11111111-1111-4111-8111-111111111111',
        ownerSub: existingOwner,
      });
      const ticketService = buildTicketService();
      const botNodeClient = {
        hasEndpoint: vi.fn(() => true),
        execute: vi.fn(async () => ({
          success: true,
          response: 'Private provider-backed result.',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: 0,
          model: 'test-model', provider: 'openai-codex', durationMs: 1,
          providerRecords: [providerRecord],
        })),
      } as unknown as BotNodeClient;

      await dispatchManifestWorkerTicket(
        buildTicket({ ownerSub: 'ticket-owner' }),
        buildWorkflow({ workerBot: 'weather-bot' }),
        {
          activeTicketIds: new Set(), dispatchStartTimes: new Map(),
          resolveAgentIdByName: async () => 'weather-agent',
          botNodeClient, ticketService,
          taskStore: stores.taskStore as never,
          messageStore: stores.messageStore as never,
          port: '5555',
        },
      );

      expect(stores.messageStore.getByTask).not.toHaveBeenCalled();
      expect(stores.messageStore.save).not.toHaveBeenCalled();
      expect(ticketService.updateStatus).not.toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111', 'complete', expect.anything(),
      );
      expect(ticketService.updateStatus).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        'escalated',
        expect.objectContaining({
          reason: 'manifest_worker_dispatch_failed',
          message: 'manifest-worker result task owner mismatch',
        }),
      );
    }
  });

  it('does not mark a remote ticket complete when its deliverable cannot be persisted', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('localhost fallback should not run');
    }) as typeof fetch;

    const stores = buildConversationStores();
    stores.messageStore.save.mockRejectedValueOnce(new Error('message store unavailable'));
    const ticketService = buildTicketService();
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async () => ({
        success: true,
        response: 'A complete worker response that must be durable before the ticket completes.',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0,
        model: 'test-model',
        provider: 'test-provider',
        durationMs: 1,
      })),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(buildTicket({ ownerSub: 'message-store-owner' }), buildWorkflow(), {
      activeTicketIds: new Set(),
      dispatchStartTimes: new Map(),
      resolveAgentIdByName: async () => 'remote-agent',
      botNodeClient,
      ticketService,
      taskStore: stores.taskStore as never,
      messageStore: stores.messageStore as never,
      port: '5555',
    });

    expect(ticketService.updateStatus).not.toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'complete',
      expect.anything(),
    );
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'escalated',
      expect.objectContaining({
        reason: 'manifest_worker_dispatch_failed',
        message: 'message store unavailable',
      }),
    );
  });

  it('escalates instead of completing when localhost dispatch does not prove success', async () => {
    const stub = await startSendMessageStub(200, { success: false, error: 'nope' });

    const ticketService = buildTicketService();
    const botNodeClient = {
      hasEndpoint: vi.fn(() => false),
      execute: vi.fn(async () => {
        throw new Error('should not execute remotely');
      }),
    } as unknown as BotNodeClient;

    try {
      await dispatchManifestWorkerTicket(buildTicket(), buildWorkflow(), {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveAgentIdByName: async () => 'inline-agent',
        botNodeClient,
        ticketService,
        port: stub.port,
      });
    } finally {
      await stub.close();
    }

    expect(botNodeClient.execute).not.toHaveBeenCalled();
    expect(stub.calls).toHaveLength(1);
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'escalated',
      expect.objectContaining({
        reason: 'manifest_worker_dispatch_failed',
        source: 'dispatch-manifest-worker',
        message: 'nope',
      }),
    );
  });

  it('rejects widened provider intents before dispatch and never falls back to localhost', async () => {
    const ticketService = buildTicketService();
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async () => { throw new Error('must not execute'); }),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(buildTicket({
      ownerSub: 'weather-owner',
      metadata: {
        providerIntent: {
          schemaVersion: 1,
          kind: 'weather',
          operation: 'current-forecast',
          location: 'Destin, FL; env',
          command: 'node /tmp/attack.js',
        },
      },
    }), buildWorkflow({ workerBot: 'weather-bot' }), {
      activeTicketIds: new Set(),
      dispatchStartTimes: new Map(),
      resolveAgentIdByName: async () => 'weather-agent',
      botNodeClient,
      ticketService,
      port: '1',
    });

    expect(botNodeClient.execute).not.toHaveBeenCalled();
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'escalated',
      expect.objectContaining({ reason: 'invalid_provider_intent' }),
    );
  });

  it('does not downgrade a trusted provider intent to the unstructured localhost path', async () => {
    const ticketService = buildTicketService();
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async () => { throw new Error('weather bot unavailable'); }),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(buildTicket({
      ownerSub: 'weather-owner',
      metadata: { providerIntent: {
        schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location: 'Destin, FL',
      } },
    }), buildWorkflow({ workerBot: 'weather-bot' }), {
      activeTicketIds: new Set(),
      dispatchStartTimes: new Map(),
      resolveAgentIdByName: async () => 'weather-agent',
      botNodeClient,
      ticketService,
      port: '1',
    });

    expect(botNodeClient.execute).toHaveBeenCalledTimes(1);
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'escalated',
      expect.objectContaining({
        reason: 'manifest_worker_dispatch_failed', message: 'weather bot unavailable',
      }),
    );
  });

  it('escalates instead of completing when bot-node returns success false', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('localhost fallback should not run');
    }) as typeof fetch;

    const ticketService = buildTicketService();
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async () => ({
        success: false,
        response: 'bot refused',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
        cost: 0,
        model: 'test',
        provider: 'test',
        durationMs: 1,
      })),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(buildTicket(), buildWorkflow({ workerBot: 'rides-concierge' }), {
      activeTicketIds: new Set(),
      dispatchStartTimes: new Map(),
      resolveAgentIdByName: async () => 'rides-agent',
      botNodeClient,
      ticketService,
      port: '5555',
    });

    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'escalated',
      expect.objectContaining({
        reason: 'manifest_worker_dispatch_failed',
        source: 'dispatch-manifest-worker',
        message: 'bot refused',
      }),
    );
  });

  it('escalates when the manifest worker bot cannot be resolved', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('dispatch should not run without a worker agent');
    }) as typeof fetch;

    const ticketService = buildTicketService();
    const activeTicketIds = new Set<string>();
    const dispatchStartTimes = new Map<string, number>();

    await dispatchManifestWorkerTicket(buildTicket(), buildWorkflow({ workerBot: 'missing-bot' }), {
      activeTicketIds,
      dispatchStartTimes,
      resolveAgentIdByName: async () => undefined,
      ticketService,
      port: '5555',
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'escalated',
      expect.objectContaining({
        reason: 'manifest_worker_agent_unresolved',
        source: 'dispatch-manifest-worker',
        workerBot: 'missing-bot',
        nextAction: 'check_agent_registry_or_manifest_worker_bot',
      }),
    );
    expect(activeTicketIds.size).toBe(0);
    expect(dispatchStartTimes.size).toBe(0);
  });
});
