/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove durable task routes cross to system identity only for the authenticated machine branch while session/node-token-style callers retain their request identity for RLS, and unready journals return 503.
 */

import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerRemoteClientTaskOperations,
} from '@/app/routes/remote-client-task-operations';
import {
  RemoteClientRegistryService,
  RemoteTaskJournalService,
  type EnqueueRemoteTaskInput,
  type EnqueueRemoteTaskOutcome,
} from '@/features/remote-client';
import {
  getRequestIdentity,
  runWithRequestIdentity,
  type RequestIdentity,
} from '@/shared/services/database/request-identity';
import { InMemoryRemoteTaskJournalFixture } from '../helpers/in-memory-remote-task-journal';

class IdentityCapturingJournal extends InMemoryRemoteTaskJournalFixture {
  readonly enqueueIdentities: Array<RequestIdentity | undefined> = [];

  override async enqueue(input: EnqueueRemoteTaskInput): Promise<EnqueueRemoteTaskOutcome> {
    this.enqueueIdentities.push(getRequestIdentity());
    return super.enqueue(input);
  }
}

const servers: Array<{ close: (callback: () => void) => void }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(resolve))));
});

async function listen(registry: RemoteClientRegistryService): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(identityMiddleware);
  const router = express.Router();
  registerRemoteClientTaskOperations(router, (_req, _res, next) => next(), {
    registry,
    isMachineCaller: (req) => req.header('x-test-mode') === 'machine',
  });
  app.use('/remote', router);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}/remote`;
}

function identityMiddleware(req: Request, _res: ExpressResponse, next: NextFunction): void {
  const sub = req.header('x-test-sub');
  if (!sub) {
    next();
    return;
  }
  runWithRequestIdentity({ sub, isOperator: false }, () => next());
}

async function configureRegistry(
  repository: IdentityCapturingJournal,
): Promise<RemoteClientRegistryService> {
  const registry = new RemoteClientRegistryService();
  await registry.configureTaskJournal(new RemoteTaskJournalService(repository), async () => undefined);
  await registry.register(registration('machine-client', 'owner-machine'));
  await registry.register(registration('session-client', 'owner-session'));
  return registry;
}

function registration(clientId: string, ownerSub: string) {
  return {
    clientId,
    ownerSub,
    name: clientId,
    transport: 'http' as const,
    platform: 'windows' as const,
    controlPlaneUrl: 'http://controller.test',
    capabilities: ['mcp.call-tool'],
    tags: ['remote-client'],
  };
}

function task(clientId: string, ownerSub: string) {
  return {
    taskId: `task-${clientId}`,
    correlationId: `correlation-${clientId}`,
    fromAgentId: 'controller',
    toAgentId: clientId,
    intent: 'mcp.call-tool',
    input: { name: 'shell.exec', arguments: { command: 'whoami' } },
    userSub: ownerSub,
    createdAt: new Date().toISOString(),
  };
}

describe('remote-client durable task identity boundary', () => {
  it('uses system identity for machine work and preserves session identity otherwise', async () => {
    const journal = new IdentityCapturingJournal();
    const origin = await listen(await configureRegistry(journal));
    const machine = await postTask(origin, 'machine-client', 'owner-machine', {
      'x-test-mode': 'machine',
    });
    const session = await postTask(origin, 'session-client', 'owner-session', {
      'x-test-mode': 'session',
      'x-test-sub': 'owner-session',
    });
    expect(machine.status).toBe(201);
    expect(session.status).toBe(201);
    expect(journal.enqueueIdentities[0]).toMatchObject({ system: true, isOperator: true });
    expect(journal.enqueueIdentities[1]).toMatchObject({ sub: 'owner-session', isOperator: false });
    expect(journal.enqueueIdentities[1]?.system).not.toBe(true);
  });

  it('returns 503 instead of using process memory when the journal is unready', async () => {
    const registry = new RemoteClientRegistryService();
    await registry.register(registration('unready-client', 'owner-a'));
    const origin = await listen(registry);
    const response = await postTask(origin, 'unready-client', 'owner-a', {
      'x-test-mode': 'machine',
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'remote_task_journal_unavailable' });
  });
});

async function postTask(
  origin: string,
  clientId: string,
  ownerSub: string,
  headers: Record<string, string>,
): Promise<globalThis.Response> {
  return fetch(`${origin}/${clientId}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(task(clientId, ownerSub)),
  });
}
