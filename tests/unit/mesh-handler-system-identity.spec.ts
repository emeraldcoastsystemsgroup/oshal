/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Behavioral guard for the two mesh-subscription handlers the live OSHAL_DB_GUC_STRICT=deny audit caught running identity-less (guc-bypass item): the remote task-result landing (WorkItemRepository.findByExternalIdAnyProvider — the DENIED site in docker logs) and the config-sync config-change handler (same shape, found by inspection). Mesh poll callbacks carry no AsyncLocalStorage identity, so without the runWithSystemIdentity wrap their DB work is stamped anonymous non-operator under deny (zero rows under RLS = silent data loss the day work_items/config_sync_log gain policies). Proves the subscription-level wrap stamps is_operator=on under deny, and that the bare (unwrapped) handler is the denied branch — so removing either wrap turns this spec red. Complements the static SYSTEM_SEAMS assertions in tests/unit/background-system-identity.spec.ts.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { Pool } from 'pg';
import { wrapPoolWithGuc, _resetFailOpenAudit } from '../../src/shared/services/database/guc-pool';
import {
  subscribeRemoteTaskResults,
  createRemoteTaskResultHandler,
  type RemoteTaskResultLandingRepository,
} from '../../src/app/routes/remote-client-task-results';
import { ConfigSyncService } from '../../src/features/config-sync/services/config-sync-service';
import type {
  MeshCommunicationService,
  MeshEnvelope,
  MeshSubscription,
} from '../../src/features/agent-management/services/mesh-communication-service';

const ENV = 'OSHAL_DB_GUC_STRICT';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV];
  process.env[ENV] = 'deny'; // the live security posture — identity-less = anonymous, zero rows
  _resetFailOpenAudit();
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  vi.restoreAllMocks();
});

/** A fake pg client that records every set_config call so the stamped is_operator is readable. */
function fakeClient() {
  const setConfigCalls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    setConfigCalls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('set_config')) setConfigCalls.push({ sql, params });
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

function fakePool(client: ReturnType<typeof fakeClient>): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

/** Reads the FIRST is_operator value the guc wrapper stamped on the connection. */
function stampedIsOperator(client: ReturnType<typeof fakeClient>): string | undefined {
  const stamp = client.setConfigCalls.find((c) => String(c.sql).includes('is_operator'));
  if (!stamp) return undefined;
  if (Array.isArray(stamp.params) && stamp.params.length > 0) return String(stamp.params[stamp.params.length - 1]);
  const m = String(stamp.sql).match(/is_operator',\s*'(on|off)'/);
  return m ? m[1] : undefined;
}

/** A mesh fake that captures the subscription callback so the test can fire envelopes through it. */
function captureMesh() {
  let captured: ((envelope: MeshEnvelope, entryId: string) => Promise<void>) | undefined;
  const mesh = {
    subscribe: vi.fn(
      (
        _channel: string,
        _consumerId: string,
        handler: (envelope: MeshEnvelope, entryId: string) => Promise<void>,
      ): MeshSubscription => {
        captured = handler;
        return { stop: vi.fn() };
      },
    ),
  };
  return { mesh, fire: (envelope: MeshEnvelope) => captured!(envelope, '0-0') };
}

/** A landing repository whose every method runs a query on the given (guc-wrapped) pool. */
function poolBackedLandingRepo(pool: Pool): RemoteTaskResultLandingRepository {
  return {
    async findByExternalIdAnyProvider(externalId: string) {
      await pool.query('SELECT work_item_id, status FROM work_items WHERE external_id = $1', [externalId]);
      return [{ workItemId: 'wi-1', status: 'executing' }];
    },
    async setExecutionOutput(workItemId: string, output: unknown) {
      await pool.query('UPDATE work_items SET execution_output = $2 WHERE work_item_id = $1', [workItemId, output]);
    },
    async updateStatus(workItemId: string, status: string) {
      await pool.query('UPDATE work_items SET status = $2 WHERE work_item_id = $1', [workItemId, status]);
    },
  };
}

function taskResultEnvelope(): MeshEnvelope {
  return {
    correlationId: 'ticket-ext-1',
    fromAgentId: 'edge-node-1',
    toAgentId: 'swarm-controller',
    channel: 'oshal:mesh:remote-task-result',
    payload: {
      type: 'remote-client.task-result',
      taskId: 'task-1',
      intent: 'browser.apply',
      correlationId: 'ticket-ext-1',
      result: { status: 'completed', clientId: 'edge-node-1', output: 'done' },
    },
    messageType: 'event',
  };
}

describe('remote task-result mesh landing runs under the SYSTEM identity sentinel', () => {
  it('subscribeRemoteTaskResults stamps trusted operator under strict=deny (the wrap is present)', async () => {
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    const { mesh, fire } = captureMesh();

    subscribeRemoteTaskResults(
      mesh as unknown as Pick<MeshCommunicationService, 'subscribe'>,
      { workItemRepository: poolBackedLandingRepo(pool) },
    );
    await fire(taskResultEnvelope());

    // The landing queries (findByExternalIdAnyProvider + setExecutionOutput + updateStatus)
    // must run as trusted SYSTEM — never the denied anonymous branch that starves work_items
    // to zero rows once it gains an RLS policy.
    expect(stampedIsOperator(client)).toBe('on');
    for (const stamp of client.setConfigCalls) {
      expect(String(stamp.sql)).toMatch(/is_operator',\s*'on'/);
    }
  });

  it('the BARE handler (no wrap) is the denied branch — proving the subscription wrap is load-bearing', async () => {
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    const handler = createRemoteTaskResultHandler({ workItemRepository: poolBackedLandingRepo(pool) });

    // Invoked exactly the way redis-mesh-transport invokes handlers: no ALS identity in scope.
    await handler(taskResultEnvelope());

    expect(stampedIsOperator(client)).toBe('off');
  });
});

describe('config-sync config-change mesh handler runs under the SYSTEM identity sentinel', () => {
  it('the subscribed handler reaches its audit pool query stamped trusted operator under strict=deny', async () => {
    const client = fakeClient();
    const pool = wrapPoolWithGuc(fakePool(client));
    const { mesh, fire } = captureMesh();

    const service = new ConfigSyncService({
      mesh: mesh as unknown as MeshCommunicationService,
      agentConfig: {
        getConfig: vi.fn(async () => ({ values: {} })),
        setConfigValues: vi.fn(async () => undefined),
      } as never,
      botNodeClient: { hasEndpoint: vi.fn(() => false) } as never,
      pool,
    });
    service.start();

    await fire({
      correlationId: 'cfg-1',
      fromAgentId: 'bot-1',
      toAgentId: 'swarm-controller',
      channel: 'oshal:mesh:config-change',
      payload: { agentId: 'bot-1', params: { providerId: 'anthropic' }, source: 'bot-local' },
      messageType: 'event',
    });

    // writeAudit's agents-lookup query must have run, stamped as trusted SYSTEM (never denied).
    expect(client.setConfigCalls.length).toBeGreaterThan(0);
    expect(stampedIsOperator(client)).toBe('on');
  });
});
