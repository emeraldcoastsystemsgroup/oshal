/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove default-on authoritative bot dispatch cannot downgrade to the unstamped localhost path after a transport failure, while explicit compatibility-off retains the legacy fallback.
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternalTicket } from '../../src/entities/ticket/internal-ticket';
import type { BotNodeClient } from '../../src/features/agent-management/services/bot-node-client';
import type { TicketService } from '../../src/features/ticketing';
import type { WorkflowDefinition } from '../../src/features/swarm-orchestration/services/dispatch-routing';
import { dispatchManifestWorkerTicket } from '../../src/features/swarm-orchestration/services/dispatch-manifest-worker';

const FLAG = 'OSHAL_PUSH_ON_DISPATCH';
const originalFlag = process.env[FLAG];

function restoreFlag(): void {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
}

function ticket(): InternalTicket {
  return {
    ticketId: '11111111-1111-4111-8111-111111111111',
    ticketType: 'task',
    title: 'Run guarded work',
    description: 'Use the assigned worker.',
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
  };
}

function workflow(): WorkflowDefinition {
  return {
    ticketType: 'task',
    name: 'Guarded task',
    pipeline: 'manifest-worker',
    workerBot: 'weather-bot',
  };
}

function ticketService() {
  return {
    updateStatus: vi.fn(async () => undefined),
  } as unknown as TicketService & { updateStatus: ReturnType<typeof vi.fn> };
}

function failingBot(message: string): BotNodeClient & {
  execute: ReturnType<typeof vi.fn>;
} {
  return {
    hasEndpoint: vi.fn(() => true),
    execute: vi.fn(async () => { throw new Error(message); }),
    isDelegationEnforced: vi.fn(() => false),
  } as unknown as BotNodeClient & { execute: ReturnType<typeof vi.fn> };
}

async function startLocalhostStub(): Promise<{
  port: string;
  calls: number;
  close(): Promise<void>;
}> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, response: 'legacy complete' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    port: String((server.address() as AddressInfo).port),
    get calls() { return calls; },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

describe('authoritative dispatch fallback boundary', () => {
  afterEach(restoreFlag);

  it('refuses transport downgrade when authoritative stamping is default-on', async () => {
    delete process.env[FLAG];
    const service = ticketService();
    const bot = failingBot('authoritative bot transport unavailable');

    await dispatchManifestWorkerTicket(ticket(), workflow(), {
      activeTicketIds: new Set(),
      dispatchStartTimes: new Map(),
      resolveAgentIdByName: async () => 'weather-agent',
      botNodeClient: bot,
      ticketService: service,
      port: '1',
    });

    expect(bot.execute).toHaveBeenCalledWith(
      'weather-agent',
      expect.objectContaining({ providerConfigRequired: true }),
    );
    expect(service.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'escalated',
      expect.objectContaining({
        reason: 'manifest_worker_dispatch_failed',
        message: 'authoritative bot transport unavailable',
      }),
    );
  });

  it('permits localhost fallback only when compatibility mode is explicitly off', async () => {
    process.env[FLAG] = 'off';
    const service = ticketService();
    const bot = failingBot('legacy bot transport unavailable');
    const stub = await startLocalhostStub();

    try {
      await dispatchManifestWorkerTicket(ticket(), workflow(), {
        activeTicketIds: new Set(),
        dispatchStartTimes: new Map(),
        resolveAgentIdByName: async () => 'weather-agent',
        botNodeClient: bot,
        ticketService: service,
        port: stub.port,
      });
    } finally {
      await stub.close();
    }

    expect(stub.calls).toBe(1);
    expect(service.updateStatus).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'complete',
      expect.anything(),
    );
  });
});
