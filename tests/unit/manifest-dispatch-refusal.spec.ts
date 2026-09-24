/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | Prove manifest dispatch terminalizes only explicitly typed deterministic refusals and never refusal-looking generic error text.
 * 2   | maintainer@emeraldcoastsystemsgroup.com   | Exercise the complete bot-node manifest boundary: every typed refusal skips localhost and preserves exact quarantine evidence, while a transient protected brain lookup remains a generic escalation.
 * 3   | maintainer@emeraldcoastsystemsgroup.com   | Prove endpoint-less single-owner signed and trusted-provider dispatches emit the reviewed remote-dispatch refusal and reach terminal quarantine without an unsigned localhost downgrade.
 * 4   | maintainer@emeraldcoastsystemsgroup.com   | Cover bounded multi-owner refusal disposition: all typed failures dead-letter exact owner facts, mixed failures stay generic, and any successful peer still produces the durable customer-action partial result.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternalTicket } from '@/entities/ticket';
import type { BotNodeClient } from '@/features/agent-management';
import type { TicketService } from '@/features/ticketing';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { RefusalError, remedyForRefusal } from '@/shared/refusal-events';
import { QueuedProtectedDispatchError } from '@/features/swarm-orchestration/services/manifest-worker-application-execution';
import type { WorkflowDefinition } from '@/features/swarm-orchestration/services/dispatch-routing';
import {
  deterministicManifestDispatchRefusal,
  dispatchManifestWorkerTicket,
} from '@/features/swarm-orchestration/services/dispatch-manifest-worker';

const PUSH_FLAG = 'OSHAL_PUSH_ON_DISPATCH';
const originalPushFlag = process.env[PUSH_FLAG];
const TICKET_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const EATS_AGENT_ID = 'b0080000-0000-0000-0000-000000000001';
const SHOPPING_AGENT_ID = 'b0070000-0000-0000-0000-000000000001';

afterEach(() => {
  configureApplicationExecutionPolicy(undefined);
  if (originalPushFlag === undefined) delete process.env[PUSH_FLAG];
  else process.env[PUSH_FLAG] = originalPushFlag;
});

function ticket(overrides: Partial<InternalTicket> = {}): InternalTicket {
  return {
    ticketId: TICKET_ID,
    ticketType: 'refusal-fixture',
    title: 'Run refusal fixture',
    description: 'Exercise the manifest bot-node boundary.',
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
    ownerSub: 'fixture-owner',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    ticketType: 'refusal-fixture',
    name: 'Refusal fixture',
    pipeline: 'manifest-worker',
    workerBot: 'refusal-worker',
    ...overrides,
  };
}

function mixedDomainCallOut() {
  return {
    agentId: EATS_AGENT_ID,
    agentName: 'eats-concierge',
    strategy: 'bid' as const,
    confident: true,
    owners: [
      { agentId: EATS_AGENT_ID, agentName: 'eats-concierge', confidence: 0.65 },
      { agentId: SHOPPING_AGENT_ID, agentName: 'shopping-concierge', confidence: 0.60 },
    ],
  };
}

function conversationStores() {
  let task: { taskId: string; ownerSub?: string | null } | null = null;
  const messages: Array<Record<string, unknown>> = [];
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
    save: vi.fn(async (input: Record<string, unknown>) => {
      messages.push(input);
      return input;
    }),
  };
  return { taskStore, messageStore };
}

function ticketService() {
  return {
    updateStatus: vi.fn(async () => undefined),
  } as unknown as TicketService & { updateStatus: ReturnType<typeof vi.fn> };
}

async function startLocalhostStub(): Promise<{
  readonly calls: number;
  port: string;
  close(): Promise<void>;
}> {
  let calls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      calls += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, response: 'localhost fallback' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    get calls() { return calls; },
    port: String((server.address() as AddressInfo).port),
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

describe('typed manifest dispatch refusals', () => {
  it('preserves exact code, detail, message and the reviewed catalog remedy', () => {
    const refusal = new RefusalError('authorization_recorded_delegation_required', 'controller signing is absent');

    expect(deterministicManifestDispatchRefusal(refusal)).toBe(refusal);
    expect(refusal).toMatchObject({
      code: 'authorization_recorded_delegation_required',
      detail: 'controller signing is absent',
      message: 'authorization_recorded_delegation_required: controller signing is absent',
      remedy: remedyForRefusal('authorization_recorded_delegation_required'),
    });
  });

  it('keeps the protected queue refusal compatible while making it explicitly typed', () => {
    const refusal = new QueuedProtectedDispatchError('the owner has no configured brain');

    expect(refusal).toBeInstanceOf(RefusalError);
    expect(deterministicManifestDispatchRefusal(refusal)).toBe(refusal);
    expect(refusal.code).toBe('authorization_queued_protected_shape_required');
    expect(refusal.reason).toBe('the owner has no configured brain');
  });

  it('does not infer a deterministic refusal from generic error or transport text', () => {
    expect(deterministicManifestDispatchRefusal(
      new Error('authorization_recorded_delegation_required: upstream returned this text'),
    )).toBeNull();
    expect(deterministicManifestDispatchRefusal(
      new Error('ECONNRESET: authorization_queued_protected_shape_required'),
    )).toBeNull();
    expect(deterministicManifestDispatchRefusal('authorization_tenant_denied')).toBeNull();
  });

  it('preserves an exact BotNodeClient refusal and never attempts compatibility localhost fallback', async () => {
    process.env[PUSH_FLAG] = 'off';
    const exactRemedy = 'Reconnect the recorded delegation authority and retry the same ticket.';
    const refusal = new RefusalError(
      'authorization_recorded_delegation_required',
      'the controller did not provide a recorded delegation issuer',
      exactRemedy,
    );
    const service = ticketService();
    const quarantineRefusal = vi.fn(async () => undefined);
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      isDelegationEnforced: vi.fn(() => false),
      execute: vi.fn(async () => { throw refusal; }),
    } as unknown as BotNodeClient;
    const localhost = await startLocalhostStub();

    try {
      await dispatchManifestWorkerTicket(ticket(), workflow(), {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveAgentIdByName: async () => AGENT_ID,
        botNodeClient,
        ticketService: service,
        deadLetterService: { quarantineRefusal } as never,
        port: localhost.port,
      });
    } finally {
      await localhost.close();
    }

    expect(botNodeClient.execute).toHaveBeenCalledOnce();
    expect(botNodeClient.isDelegationEnforced).not.toHaveBeenCalled();
    expect(localhost.calls).toBe(0);
    expect(quarantineRefusal).toHaveBeenCalledWith(TICKET_ID, {
      code: refusal.code,
      message: refusal.message,
      remedy: exactRemedy,
      source: 'dispatch-manifest-worker',
      metadata: {
        workerBot: 'refusal-worker',
        workerAgentId: AGENT_ID,
        routedBy: 'workflow-default',
      },
    });
    expect(service.updateStatus).not.toHaveBeenCalled();
  });

  it('terminally quarantines an endpoint-less single owner when signed delegation is enforced', async () => {
    const service = ticketService();
    const quarantineRefusal = vi.fn(async () => undefined);
    const botNodeClient = {
      hasEndpoint: vi.fn(() => false),
      isDelegationEnforced: vi.fn(() => true),
      execute: vi.fn(async () => { throw new Error('must not execute without an endpoint'); }),
    } as unknown as BotNodeClient;
    const localhost = await startLocalhostStub();

    try {
      await dispatchManifestWorkerTicket(ticket(), workflow(), {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveAgentIdByName: async () => AGENT_ID,
        botNodeClient,
        ticketService: service,
        deadLetterService: { quarantineRefusal } as never,
        port: localhost.port,
      });
    } finally {
      await localhost.close();
    }

    expect(botNodeClient.execute).not.toHaveBeenCalled();
    expect(localhost.calls).toBe(0);
    expect(service.updateStatus).not.toHaveBeenCalled();
    expect(quarantineRefusal).toHaveBeenCalledWith(TICKET_ID, {
      code: 'authorization_remote_dispatch_required',
      message: 'authorization_remote_dispatch_required: signed HTTP delegation requires a dedicated bot-node endpoint',
      source: 'dispatch-manifest-worker',
      metadata: {
        workerBot: 'refusal-worker',
        workerAgentId: AGENT_ID,
        routedBy: 'workflow-default',
      },
    });
  });

  it('terminally quarantines a trusted-provider intent whose dedicated owner has no endpoint', async () => {
    const providerAgentId = 'a0000000-0000-0000-0000-000000000036';
    const service = ticketService();
    const quarantineRefusal = vi.fn(async () => undefined);
    const resolveBotCreds = vi.fn(async () => ({ OSHAL_CRED_WEATHER: 'must-not-resolve' }));
    const botNodeClient = {
      hasEndpoint: vi.fn(() => false),
      isDelegationEnforced: vi.fn(() => false),
      execute: vi.fn(async () => { throw new Error('must not execute without an endpoint'); }),
    } as unknown as BotNodeClient;
    const localhost = await startLocalhostStub();

    try {
      await dispatchManifestWorkerTicket(ticket({
        metadata: {
          providerIntent: {
            schemaVersion: 1,
            kind: 'weather',
            operation: 'current-forecast',
            location: 'Destin, FL',
          },
        },
      }), workflow(), {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveAgentIdByName: async () => 'wrong-workflow-agent',
        resolveBotCreds,
        botNodeClient,
        ticketService: service,
        deadLetterService: { quarantineRefusal } as never,
        port: localhost.port,
      });
    } finally {
      await localhost.close();
    }

    expect(botNodeClient.hasEndpoint).toHaveBeenCalledWith(providerAgentId);
    expect(botNodeClient.execute).not.toHaveBeenCalled();
    expect(resolveBotCreds).not.toHaveBeenCalled();
    expect(localhost.calls).toBe(0);
    expect(service.updateStatus).not.toHaveBeenCalled();
    expect(quarantineRefusal).toHaveBeenCalledWith(TICKET_ID, {
      code: 'authorization_remote_dispatch_required',
      message: 'authorization_remote_dispatch_required: trusted provider intent requires a dedicated bot-node endpoint',
      source: 'dispatch-manifest-worker',
      metadata: {
        workerBot: 'refusal-worker',
        workerAgentId: providerAgentId,
        routedBy: 'trusted-provider-intent',
      },
    });
  });

  it('keeps a typed owner refusal on the partial-result customer-action rail when its peer succeeds', async () => {
    const service = ticketService();
    const stores = conversationStores();
    const refusal = new RefusalError(
      'authorization_queued_protected_shape_required',
      'shopping owner has no configured brain',
      'Configure the shopping owner brain and retry.',
    );
    const quarantineRefusal = vi.fn(async () => undefined);
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async (agentId: string) => {
        if (agentId === SHOPPING_AGENT_ID) throw refusal;
        return {
          success: true,
          response: 'Uber Eats options survived the deterministic peer refusal.',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: 0,
          model: 'eats-model',
          provider: 'test-provider',
          durationMs: 1,
        };
      }),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(
      ticket({ ticketType: 'task', ownerSub: 'owner-123' }),
      workflow({ ticketType: 'task', workerBot: 'general-bot' }),
      {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveTaskWorker: vi.fn(async () => mixedDomainCallOut()),
        botNodeClient,
        ticketService: service,
        deadLetterService: { quarantineRefusal } as never,
        taskStore: stores.taskStore as never,
        messageStore: stores.messageStore as never,
        port: '5555',
      },
    );

    expect(quarantineRefusal).not.toHaveBeenCalled();
    expect(stores.messageStore.save).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining(refusal.message),
    }));
    expect(service.updateStatus).toHaveBeenLastCalledWith(
      TICKET_ID,
      'customer_action',
      expect.objectContaining({
        reason: 'multi_owner_partial_failure',
        disposition: 'partial_result_requires_followup',
      }),
    );
  });

  it('terminally quarantines all-typed multi-owner refusals with stable primary and exact owner facts', async () => {
    const service = ticketService();
    const stores = conversationStores();
    const eatsRefusal = new RefusalError(
      'authorization_recorded_delegation_required',
      'eats owner is missing the recorded delegation issuer',
      'Reconnect the Eats delegation authority.',
    );
    const shoppingRefusal = new RefusalError(
      'authorization_queued_protected_shape_required',
      'shopping owner has no configured brain',
      'Configure the shopping owner brain and retry.',
    );
    const quarantineRefusal = vi.fn(async () => undefined);
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async (agentId: string) => {
        throw agentId === EATS_AGENT_ID ? eatsRefusal : shoppingRefusal;
      }),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(
      ticket({ ticketType: 'task', ownerSub: 'owner-123' }),
      workflow({ ticketType: 'task', workerBot: 'general-bot' }),
      {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveTaskWorker: vi.fn(async () => mixedDomainCallOut()),
        botNodeClient,
        ticketService: service,
        deadLetterService: { quarantineRefusal } as never,
        taskStore: stores.taskStore as never,
        messageStore: stores.messageStore as never,
        port: '5555',
      },
    );

    expect(stores.taskStore.create).not.toHaveBeenCalled();
    expect(stores.messageStore.save).not.toHaveBeenCalled();
    expect(service.updateStatus).not.toHaveBeenCalled();
    expect(quarantineRefusal).toHaveBeenCalledOnce();
    expect(quarantineRefusal).toHaveBeenCalledWith(
      TICKET_ID,
      {
        code: eatsRefusal.code,
        message: eatsRefusal.message,
        remedy: eatsRefusal.remedy,
        source: 'dispatch-manifest-worker',
        metadata: expect.objectContaining({
          routedBy: 'multi-bid',
          successfulWorkerAgentIds: [],
          ownerRefusals: [
            {
              agentId: EATS_AGENT_ID,
              agentName: 'eats-concierge',
              code: eatsRefusal.code,
              message: eatsRefusal.message,
              remedy: eatsRefusal.remedy,
            },
            {
              agentId: SHOPPING_AGENT_ID,
              agentName: 'shopping-concierge',
              code: shoppingRefusal.code,
              message: shoppingRefusal.message,
              remedy: shoppingRefusal.remedy,
            },
          ],
        }),
      },
    );
  });

  it('keeps all-failed mixed typed and generic owner errors on generic escalation', async () => {
    const service = ticketService();
    const stores = conversationStores();
    const typedRefusal = new RefusalError(
      'authorization_recorded_delegation_required',
      'eats owner is missing the recorded delegation issuer',
    );
    const quarantineRefusal = vi.fn(async () => undefined);
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      execute: vi.fn(async (agentId: string) => {
        if (agentId === EATS_AGENT_ID) throw typedRefusal;
        throw new Error('shopping connector unavailable');
      }),
    } as unknown as BotNodeClient;

    await dispatchManifestWorkerTicket(
      ticket({ ticketType: 'task', ownerSub: 'owner-123' }),
      workflow({ ticketType: 'task', workerBot: 'general-bot' }),
      {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveTaskWorker: vi.fn(async () => mixedDomainCallOut()),
        botNodeClient,
        ticketService: service,
        deadLetterService: { quarantineRefusal } as never,
        taskStore: stores.taskStore as never,
        messageStore: stores.messageStore as never,
        port: '5555',
      },
    );

    expect(quarantineRefusal).not.toHaveBeenCalled();
    expect(stores.taskStore.create).not.toHaveBeenCalled();
    expect(stores.messageStore.save).not.toHaveBeenCalled();
    expect(service.updateStatus).toHaveBeenCalledOnce();
    expect(service.updateStatus).toHaveBeenCalledWith(
      TICKET_ID,
      'escalated',
      expect.objectContaining({
        reason: 'multi_owner_dispatch_failed',
        failedWorkers: [
          expect.objectContaining({ agentId: EATS_AGENT_ID, message: typedRefusal.message }),
          expect.objectContaining({ agentId: SHOPPING_AGENT_ID, message: 'shopping connector unavailable' }),
        ],
      }),
    );
  });

  it('keeps a protected configured-brain outage generic and uses legacy escalation without localhost or quarantine', async () => {
    process.env[PUSH_FLAG] = 'off';
    configureApplicationExecutionPolicy({
      owner: async (_kind, id) => id === AGENT_ID ? 'refusal-fixture-app' : undefined,
      protectedApp: async app => app === 'refusal-fixture-app',
      authorize: async () => ({ allowed: false, reason: 'not_reached' }),
    });
    const lookupFailure = new Error('configured brain database unavailable');
    const service = ticketService();
    const quarantineRefusal = vi.fn(async () => undefined);
    const botNodeClient = {
      hasEndpoint: vi.fn(() => true),
      isDelegationEnforced: vi.fn(() => false),
      execute: vi.fn(async () => { throw new Error('bot execution must not be reached'); }),
    } as unknown as BotNodeClient;
    const localhost = await startLocalhostStub();

    try {
      await dispatchManifestWorkerTicket(ticket(), workflow(), {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveAgentIdByName: async () => AGENT_ID,
        botNodeClient,
        ticketService: service,
        deadLetterService: { quarantineRefusal } as never,
        resolveBrain: async () => { throw lookupFailure; },
        port: localhost.port,
      });
    } finally {
      await localhost.close();
    }

    expect(botNodeClient.execute).not.toHaveBeenCalled();
    expect(localhost.calls).toBe(0);
    expect(quarantineRefusal).not.toHaveBeenCalled();
    expect(service.updateStatus).toHaveBeenCalledOnce();
    expect(service.updateStatus).toHaveBeenCalledWith(TICKET_ID, 'escalated', {
      reason: 'manifest_worker_dispatch_failed',
      source: 'dispatch-manifest-worker',
      workerBot: 'refusal-worker',
      workerAgentId: AGENT_ID,
      routedBy: 'workflow-default',
      message: lookupFailure.message,
    });
  });
});
