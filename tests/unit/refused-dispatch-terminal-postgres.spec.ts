/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com   | P4 real-boundary guard: a deterministic protected-dispatch refusal atomically terminalizes its ticket and linked tasks with an exact DLQ envelope under enforced owner RLS, while an injected DLQ failure rolls the entire transition back.
 * 2   | maintainer@emeraldcoastsystemsgroup.com   | Repeating deterministic quarantine is a true no-op: the first ticket metadata, status history, DLQ envelope and notification remain exact.
 * 3   | maintainer@emeraldcoastsystemsgroup.com   | Prove a throwing post-COMMIT status observer cannot starve a later observer or escape into the refusal fallback.
 * 4   | maintainer@emeraldcoastsystemsgroup.com   | Force two dead-letter callers past the same pre-read and prove the PostgreSQL compare-and-set loser becomes an idempotent false only after the typed conflict re-read confirms the winner's commit.
 * 5   | maintainer@emeraldcoastsystemsgroup.com   | Prove reverse requeue atomicity: an injected DLQ reset failure rolls back ticket/history/event state and evidence, while success commits both sides under the same GUC-stamped transaction.
 * 6   | maintainer@emeraldcoastsystemsgroup.com   | Prove retry-exhaustion uses the same atomic terminal transaction: a marker failure rolls back lifecycle writes but preserves the committed attempt row for a later successful retry.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BotNodeClient } from '@/features/agent-management';
import { TicketStatusConflictError, type InternalTicket } from '@/entities/ticket';
import { PostgresTicketStore, TicketService } from '@/features/ticketing';
import { DeadLetterService } from '@/features/swarm-orchestration/services/dead-letter-service';
import {
  deterministicManifestDispatchRefusal,
  dispatchManifestWorkerTicket,
} from '@/features/swarm-orchestration/services/dispatch-manifest-worker';
import { QueuedProtectedDispatchError } from '@/features/swarm-orchestration/services/manifest-worker-application-execution';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { RefusalError } from '@/shared/refusal-events';
import { ensureTicketSchema } from '@/shared/services/database';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { ticketEvents } from '@/shared/ticket-events';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const RUNTIME_ROLE = 'p4_refusal_runtime';
const OWNER_SUB = 'p4-refusal-owner';
const OTHER_SUB = 'p4-other-owner';
const AGENT_ID = 'a0000000-0000-0000-0000-0000000004f4';
const APP_NAME = 'p4-protected-fixture';
const REFUSAL_CODE = 'authorization_queued_protected_shape_required';
const REFUSAL_MESSAGE = `${REFUSAL_CODE}: the ticket owner has no usable configured AI brain; select a provider under Settings -> AI Providers`;

const database = new DisposablePostgres({
  purpose: 'refused-dispatch-terminal',
  roles: [RUNTIME_ROLE],
  migrations: [
    '001-multi-agent-foundation.sql',
    '005-conversation-history-and-usage.sql',
    '055-chat-tasks-owner-sub.sql',
    '081-queue-dlq.sql',
    '100-ticket-family-base-schema.sql',
    '113-derived-owner-rls-ticket-family.sql',
    '156-queue-dlq-refusal-details.sql',
  ],
});

let adminPool: Pool;
let runtimePool: Pool;
let ticketStore: PostgresTicketStore;
let ticketService: TicketService;
let deadLetterService: DeadLetterService;
let dispatchTicket: InternalTicket;
let rollbackTicket: InternalTicket;
let dispatchTaskIds: string[];
let rollbackTaskId: string;
let failingNotifier: ReturnType<typeof vi.fn>;

/**
 * The migrations establish the durable tables and ticket-family policies. Production's
 * conversation-schema bootstrap also widens the task status check to `paused` and installs this
 * owner policy; reproduce those exact two runtime-schema effects so both dormant task states and
 * the deployed FORCE-RLS boundary are exercised here.
 */
async function applyConversationRuntimeContract(): Promise<void> {
  await adminPool.query('ALTER TABLE chat_tasks DROP CONSTRAINT IF EXISTS chat_tasks_status_check');
  await adminPool.query(`ALTER TABLE chat_tasks ADD CONSTRAINT chat_tasks_status_check CHECK (status IN (
    'created', 'active', 'processing', 'waiting_for_input', 'paused', 'completed', 'failed', 'cancelled'
  ))`);
  await adminPool.query('ALTER TABLE chat_tasks ENABLE ROW LEVEL SECURITY');
  await adminPool.query('ALTER TABLE chat_tasks FORCE ROW LEVEL SECURITY');
  await adminPool.query('DROP POLICY IF EXISTS chat_tasks_owner_or_operator ON chat_tasks');
  await adminPool.query(`CREATE POLICY chat_tasks_owner_or_operator ON chat_tasks
    AS PERMISSIVE FOR ALL
    USING (
      owner_sub = current_setting('oshal.current_sub', true)
      OR current_setting('oshal.is_operator', true) = 'on'
    )
    WITH CHECK (
      owner_sub = current_setting('oshal.current_sub', true)
      OR current_setting('oshal.is_operator', true) = 'on'
    )`);
}

/** Grant the application role the deployed DML contract; RLS, not missing table grants, is under test. */
async function grantRuntimeContract(): Promise<void> {
  await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE}`);
  await adminPool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`);
}

/** Create one real ticket plus linked real chat tasks under the trusted queue identity. */
async function seedTicket(taskStatuses: Array<'waiting_for_input' | 'paused'>): Promise<{
  ticket: InternalTicket;
  taskIds: string[];
}> {
  return runWithSystemIdentity(async () => {
    const ticket = await ticketService.createTicket({
      title: `P4 deterministic-refusal fixture ${randomUUID()}`,
      ticketType: 'trading-decision',
      description: 'A protected manifest worker must refuse before execution.',
      status: 'approved',
      priority: 'medium',
      labels: ['p4-refusal-guard'],
      workspaceId: null,
      assignedAgentId: AGENT_ID,
      parentTicketId: null,
      externalProvider: null,
      externalId: null,
      externalUrl: null,
      ownerSub: OWNER_SUB,
      metadata: {},
    });
    const taskIds: string[] = [];
    for (const status of taskStatuses) {
      const taskId = `p4-${status}-${randomUUID()}`;
      await runtimePool.query(
        `INSERT INTO chat_tasks (task_id, title, status, processing_mode, owner_sub, metadata)
         VALUES ($1, $2, $3, 'agentic', $4, '{}'::jsonb)`,
        [taskId, `P4 ${status} linked task`, status, OWNER_SUB],
      );
      await ticketService.linkTask(ticket.ticketId, taskId, 'primary');
      taskIds.push(taskId);
    }
    return { ticket, taskIds };
  });
}

beforeAll(async () => {
  adminPool = await database.start();
  // Complete the real store's lazy-DDL safety net as the fixture owner before constructing the
  // least-privilege store. Its constructor then observes this settled bootstrap instead of racing
  // an ownership-denied ALTER on the runtime role while the first ticket is being inserted.
  await ensureTicketSchema(adminPool);
  await applyConversationRuntimeContract();
  await grantRuntimeContract();
  runtimePool = wrapPoolWithGuc(database.rolePool(RUNTIME_ROLE));

  ticketStore = runWithSystemIdentity(() => new PostgresTicketStore(runtimePool));
  ticketService = new TicketService(ticketStore);
  failingNotifier = vi.fn(async () => { throw new Error('p4 injected notifier failure'); });
  deadLetterService = new DeadLetterService({ pool: runtimePool, ticketService, notify: failingNotifier });

  ({ ticket: dispatchTicket, taskIds: dispatchTaskIds } = await seedTicket(['waiting_for_input', 'paused']));
  ({ ticket: rollbackTicket, taskIds: [rollbackTaskId] } = await seedTicket(['waiting_for_input']));

  configureApplicationExecutionPolicy({
    owner: async (_kind, id) => id === AGENT_ID ? APP_NAME : undefined,
    protectedApp: async app => app === APP_NAME,
    authorize: async () => ({ allowed: false, reason: 'not_reached' }),
  });
}, 240_000);

afterAll(async () => {
  configureApplicationExecutionPolicy(undefined);
  await database.stop();
});

describe('deterministic dispatch refusal terminalization against real PostgreSQL', () => {
  it('dispatches through the protected gate, then atomically writes terminal ticket/task/history/DLQ state under FORCE RLS', async () => {
    const typedRefusal = new QueuedProtectedDispatchError(
      'the ticket owner has no usable configured AI brain; select a provider under Settings -> AI Providers',
    );
    expect(typedRefusal).toBeInstanceOf(RefusalError);
    expect(deterministicManifestDispatchRefusal(typedRefusal)).toBe(typedRefusal);
    expect(deterministicManifestDispatchRefusal(new Error(REFUSAL_MESSAGE))).toBeNull();

    const rolePosture = await adminPool.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [RUNTIME_ROLE],
    );
    expect(rolePosture.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const rlsPosture = await adminPool.query(`SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
    [['chat_tasks', 'ticket_status_history', 'tickets']]);
    expect(rlsPosture.rows).toEqual([
      { relname: 'chat_tasks', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'ticket_status_history', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'tickets', relrowsecurity: true, relforcerowsecurity: true },
    ]);

    const execute = vi.fn();
    const botNodeClient = {
      hasEndpoint: (agentId: string) => agentId === AGENT_ID,
      isDelegationEnforced: () => true,
      execute,
    } as unknown as BotNodeClient;

    // Both observer classes fail after COMMIT. Neither is allowed to make dispatch attempt the
    // legacy `escalated` fallback after the durable terminal transition has already landed.
    const legacyFallback = vi.spyOn(ticketService, 'updateStatus');
    const throwingObserver = vi.fn(() => { throw new Error('p4 injected status observer failure'); });
    const laterObserver = vi.fn();
    ticketEvents.onStatusChanged(throwingObserver);
    ticketEvents.onStatusChanged(laterObserver);

    try {
      await runWithSystemIdentity(() => dispatchManifestWorkerTicket(
        dispatchTicket,
        {
          ticketType: 'trading-decision',
          name: 'P4 protected refusal fixture',
          pipeline: 'manifest-worker',
          workerBot: 'p4-protected-worker',
        } as never,
        {
          activeTicketIds: new Set<string>(),
          dispatchStartTimes: new Map<string, number>(),
          resolveAgentIdByName: async () => AGENT_ID,
          botNodeClient,
          ticketService,
          deadLetterService,
          resolveBrain: async () => ({ kind: 'none' }),
        },
      ));
      await Promise.resolve();
    } finally {
      ticketEvents.removeListener('status-changed', throwingObserver);
      ticketEvents.removeListener('status-changed', laterObserver);
    }

    expect(execute).not.toHaveBeenCalled();
    expect(throwingObserver).toHaveBeenCalledOnce();
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(laterObserver).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: dispatchTicket.ticketId,
      fromStatus: 'approved',
      toStatus: 'dead_letter',
    }));
    expect(failingNotifier).toHaveBeenCalledOnce();
    expect(legacyFallback).not.toHaveBeenCalled();
    legacyFallback.mockRestore();

    const systemState = await runWithSystemIdentity(async () => {
      const [ticket, tasks, history, dlq] = await Promise.all([
        runtimePool.query('SELECT status, state_group, metadata FROM tickets WHERE ticket_id = $1', [dispatchTicket.ticketId]),
        runtimePool.query('SELECT task_id, status, metadata FROM chat_tasks WHERE task_id = ANY($1::text[]) ORDER BY task_id', [dispatchTaskIds]),
        runtimePool.query(`SELECT from_status, to_status, changed_by, metadata
          FROM ticket_status_history WHERE ticket_id = $1 AND to_status = 'dead_letter'`, [dispatchTicket.ticketId]),
        runtimePool.query(`SELECT attempts, quarantined_at, reason, last_error, remedy
          FROM oshal_queue_dlq WHERE ticket_id = $1`, [dispatchTicket.ticketId]),
      ]);
      return { ticket: ticket.rows, tasks: tasks.rows, history: history.rows, dlq: dlq.rows };
    });

    expect(systemState.ticket).toHaveLength(1);
    expect(systemState.ticket[0]).toMatchObject({ status: 'dead_letter', state_group: 'escalated' });
    expect(systemState.ticket[0].metadata).toMatchObject({
      reason: REFUSAL_CODE,
      failureClass: 'deterministic_refusal',
      lastStatusTransition: {
        reason: REFUSAL_CODE,
        message: REFUSAL_MESSAGE,
        failureClass: 'deterministic_refusal',
      },
    });
    expect(systemState.tasks).toHaveLength(2);
    expect(systemState.tasks.every(task => task.status === 'failed')).toBe(true);
    for (const task of systemState.tasks) {
      expect(task.metadata).toMatchObject({
        ticketTerminalStatus: 'dead_letter',
        ticketTerminalId: dispatchTicket.ticketId,
        ticketTerminalSyncReason: REFUSAL_CODE,
        ticketTerminalMessage: REFUSAL_MESSAGE,
      });
    }
    expect(systemState.history).toEqual([
      expect.objectContaining({
        from_status: 'approved',
        to_status: 'dead_letter',
        changed_by: 'system',
        metadata: expect.objectContaining({ reason: REFUSAL_CODE, message: REFUSAL_MESSAGE }),
      }),
    ]);
    expect(systemState.dlq).toEqual([
      expect.objectContaining({
        attempts: 1,
        reason: REFUSAL_CODE,
        last_error: REFUSAL_MESSAGE,
        remedy: null,
      }),
    ]);
    expect(systemState.dlq[0].quarantined_at).not.toBeNull();

    const repeated = await runWithSystemIdentity(() => deadLetterService.quarantineRefusal(
      dispatchTicket.ticketId,
      {
        code: 'authorization_later_refusal_must_not_replace_first',
        message: 'A repeated refusal must not overwrite the committed envelope.',
        remedy: 'This later remedy must not replace the first remedy.',
        source: 'refused-dispatch-terminal-postgres-repeat',
      },
    ));
    expect(repeated).toMatchObject({ quarantined: true, transitioned: false });
    await Promise.resolve();
    expect(failingNotifier).toHaveBeenCalledOnce();

    const repeatedState = await runWithSystemIdentity(async () => {
      const [ticket, history, dlq] = await Promise.all([
        runtimePool.query('SELECT status, state_group, metadata FROM tickets WHERE ticket_id = $1', [dispatchTicket.ticketId]),
        runtimePool.query(`SELECT from_status, to_status, changed_by, metadata
          FROM ticket_status_history WHERE ticket_id = $1 AND to_status = 'dead_letter'`, [dispatchTicket.ticketId]),
        runtimePool.query(`SELECT attempts, quarantined_at, reason, last_error, remedy
          FROM oshal_queue_dlq WHERE ticket_id = $1`, [dispatchTicket.ticketId]),
      ]);
      return { ticket: ticket.rows, history: history.rows, dlq: dlq.rows };
    });
    expect(repeatedState).toEqual({
      ticket: systemState.ticket,
      history: systemState.history,
      dlq: systemState.dlq,
    });

    const ownerCounts = await runWithRequestIdentity(
      { sub: OWNER_SUB, principalIssuer: 'urn:oshal:local-auth', isOperator: false },
      async () => Promise.all([
        runtimePool.query('SELECT count(*)::int AS n FROM tickets WHERE ticket_id = $1', [dispatchTicket.ticketId]),
        runtimePool.query('SELECT count(*)::int AS n FROM chat_tasks WHERE task_id = ANY($1::text[])', [dispatchTaskIds]),
        runtimePool.query(`SELECT count(*)::int AS n FROM ticket_status_history
          WHERE ticket_id = $1 AND to_status = 'dead_letter'`, [dispatchTicket.ticketId]),
      ]),
    );
    expect(ownerCounts.map(result => result.rows[0].n)).toEqual([1, 2, 1]);

    const otherCounts = await runWithRequestIdentity(
      { sub: OTHER_SUB, principalIssuer: 'urn:oshal:local-auth', isOperator: false },
      async () => Promise.all([
        runtimePool.query('SELECT count(*)::int AS n FROM tickets WHERE ticket_id = $1', [dispatchTicket.ticketId]),
        runtimePool.query('SELECT count(*)::int AS n FROM chat_tasks WHERE task_id = ANY($1::text[])', [dispatchTaskIds]),
        runtimePool.query('SELECT count(*)::int AS n FROM ticket_status_history WHERE ticket_id = $1', [dispatchTicket.ticketId]),
      ]),
    );
    expect(otherCounts.map(result => result.rows[0].n)).toEqual([0, 0, 0]);

    const operatorCounts = await runWithRequestIdentity(
      { sub: 'p4-operator', principalIssuer: 'urn:oshal:local-auth', isOperator: true },
      async () => Promise.all([
        runtimePool.query('SELECT count(*)::int AS n FROM tickets WHERE ticket_id = $1', [dispatchTicket.ticketId]),
        runtimePool.query('SELECT count(*)::int AS n FROM chat_tasks WHERE task_id = ANY($1::text[])', [dispatchTaskIds]),
        runtimePool.query('SELECT count(*)::int AS n FROM ticket_status_history WHERE ticket_id = $1', [dispatchTicket.ticketId]),
      ]),
    );
    expect(operatorCounts.map(result => result.rows[0].n)).toEqual([1, 2, 2]);
  });

  it('makes concurrent dead-letter callers one committed winner and one confirmed idempotent loser', async () => {
    const { ticket } = await seedTicket([]);
    const originalGet = ticketStore.get.bind(ticketStore);
    const originalUpdateStatus = ticketStore.updateStatus.bind(ticketStore);
    let initialReads = 0;
    let releaseInitialReads!: () => void;
    const bothInitialReads = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    const conflicts: unknown[] = [];
    const getSpy = vi.spyOn(ticketStore, 'get').mockImplementation(async (ticketId) => {
      const result = await originalGet(ticketId);
      if (ticketId === ticket.ticketId && result?.status === 'approved' && initialReads < 2) {
        initialReads += 1;
        if (initialReads === 2) releaseInitialReads();
        await bothInitialReads;
      }
      return result;
    });
    const updateSpy = vi.spyOn(ticketStore, 'updateStatus').mockImplementation(async (...args) => {
      try {
        await originalUpdateStatus(...args);
      } catch (error) {
        conflicts.push(error);
        throw error;
      }
    });

    let outcomes: boolean[];
    try {
      outcomes = await runWithSystemIdentity(() => Promise.all([
        ticketService.quarantineToDeadLetter(ticket.ticketId, {
          reason: 'authorization_concurrent_fixture_refused',
          lastError: 'authorization_concurrent_fixture_refused: exact concurrent detail',
          remedy: 'Repair the concurrent fixture authority.',
          attempts: 1,
        }, { source: 'concurrent-refusal-fixture' }),
        ticketService.quarantineToDeadLetter(ticket.ticketId, {
          reason: 'authorization_concurrent_fixture_refused',
          lastError: 'authorization_concurrent_fixture_refused: exact concurrent detail',
          remedy: 'Repair the concurrent fixture authority.',
          attempts: 1,
        }, { source: 'concurrent-refusal-fixture' }),
      ]));
    } finally {
      getSpy.mockRestore();
      updateSpy.mockRestore();
    }

    expect(initialReads).toBe(2);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toBeInstanceOf(TicketStatusConflictError);
    expect(conflicts[0]).toMatchObject({
      ticketId: ticket.ticketId,
      expectedStatus: 'approved',
      actualStatus: 'dead_letter',
    });

    const state = await runWithSystemIdentity(async () => {
      const [persistedTicket, history, dlq] = await Promise.all([
        runtimePool.query('SELECT status FROM tickets WHERE ticket_id = $1', [ticket.ticketId]),
        runtimePool.query(`SELECT from_status, to_status FROM ticket_status_history
          WHERE ticket_id = $1 AND to_status = 'dead_letter'`, [ticket.ticketId]),
        runtimePool.query(`SELECT attempts, reason, last_error, remedy FROM oshal_queue_dlq
          WHERE ticket_id = $1`, [ticket.ticketId]),
      ]);
      return { ticket: persistedTicket.rows, history: history.rows, dlq: dlq.rows };
    });
    expect(state).toEqual({
      ticket: [{ status: 'dead_letter' }],
      history: [{ from_status: 'approved', to_status: 'dead_letter' }],
      dlq: [{
        attempts: 1,
        reason: 'authorization_concurrent_fixture_refused',
        last_error: 'authorization_concurrent_fixture_refused: exact concurrent detail',
        remedy: 'Repair the concurrent fixture authority.',
      }],
    });
  });

  it('keeps retry-exhaustion fail-open when its atomic quarantine marker fails, then retries cleanly', async () => {
    const { ticket, taskIds: [taskId] } = await seedTicket(['waiting_for_input']);
    const notify = vi.fn(async () => undefined);
    const retryService = new DeadLetterService({
      pool: runtimePool,
      ticketService,
      notify,
      env: { QM_MAX_ATTEMPTS: '1' } as NodeJS.ProcessEnv,
    });
    try {
      await adminPool.query(`CREATE OR REPLACE FUNCTION p4_reject_retry_quarantine_marker()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.quarantined_at IS NULL AND NEW.quarantined_at IS NOT NULL THEN
            RAISE EXCEPTION 'p4 injected retry quarantine marker failure';
          END IF;
          RETURN NEW;
        END
        $$`);
      await adminPool.query(`CREATE TRIGGER p4_reject_retry_quarantine_marker
        BEFORE UPDATE ON oshal_queue_dlq
        FOR EACH ROW EXECUTE FUNCTION p4_reject_retry_quarantine_marker()`);

      const failed = await runWithSystemIdentity(() => retryService.recordFailureCycle(
        ticket.ticketId,
        'dispatch_failure',
        'exact retry exhaustion failure',
      ));
      expect(failed).toEqual({ attempts: 1, quarantined: false });
    } finally {
      await adminPool.query('DROP TRIGGER IF EXISTS p4_reject_retry_quarantine_marker ON oshal_queue_dlq');
      await adminPool.query('DROP FUNCTION IF EXISTS p4_reject_retry_quarantine_marker()');
    }

    const rolledBack = await runWithSystemIdentity(async () => {
      const [persistedTicket, task, history, dlq] = await Promise.all([
        runtimePool.query('SELECT status FROM tickets WHERE ticket_id = $1', [ticket.ticketId]),
        runtimePool.query('SELECT status FROM chat_tasks WHERE task_id = $1', [taskId]),
        runtimePool.query(`SELECT to_status FROM ticket_status_history
          WHERE ticket_id = $1 ORDER BY created_at`, [ticket.ticketId]),
        runtimePool.query(`SELECT attempts, last_error, quarantined_at, reason, remedy
          FROM oshal_queue_dlq WHERE ticket_id = $1`, [ticket.ticketId]),
      ]);
      return { ticket: persistedTicket.rows, task: task.rows, history: history.rows, dlq: dlq.rows };
    });
    expect(rolledBack).toEqual({
      ticket: [{ status: 'approved' }],
      task: [{ status: 'waiting_for_input' }],
      history: [{ to_status: 'approved' }],
      dlq: [{
        attempts: 1,
        last_error: 'exact retry exhaustion failure',
        quarantined_at: null,
        reason: null,
        remedy: null,
      }],
    });
    expect(notify).not.toHaveBeenCalled();

    const retried = await runWithSystemIdentity(() => retryService.recordFailureCycle(
      ticket.ticketId,
      'dispatch_failure',
      'exact retry exhaustion failure after repair',
    ));
    expect(retried).toEqual({
      attempts: 2,
      quarantined: true,
      reason: 'max_dispatch_attempts_poison',
    });
    const committed = await runWithSystemIdentity(async () => Promise.all([
      runtimePool.query('SELECT status FROM tickets WHERE ticket_id = $1', [ticket.ticketId]),
      runtimePool.query('SELECT status FROM chat_tasks WHERE task_id = $1', [taskId]),
      runtimePool.query(`SELECT attempts, last_error, quarantined_at, reason
        FROM oshal_queue_dlq WHERE ticket_id = $1`, [ticket.ticketId]),
    ]));
    expect(committed[0].rows).toEqual([{ status: 'dead_letter' }]);
    expect(committed[1].rows).toEqual([{ status: 'failed' }]);
    expect(committed[2].rows).toEqual([expect.objectContaining({
      attempts: 2,
      last_error: 'exact retry exhaustion failure after repair',
      reason: 'max_dispatch_attempts_poison',
    })]);
    expect(committed[2].rows[0].quarantined_at).not.toBeNull();
    expect(notify).toHaveBeenCalledOnce();
  });

  it('atomically rolls back a failed DLQ reset and commits a successful operator requeue', async () => {
    const [{ ticket: rejectedTicket }, { ticket: releasedTicket }] = await Promise.all([
      seedTicket([]),
      seedTicket([]),
    ]);
    await runWithSystemIdentity(() => Promise.all([
      ticketService.quarantineToDeadLetter(rejectedTicket.ticketId, {
        reason: 'authorization_requeue_rollback_fixture',
        lastError: 'authorization_requeue_rollback_fixture: preserve this evidence',
        remedy: 'Repair the rollback fixture before requeue.',
        attempts: 4,
      }, { source: 'requeue-rollback-fixture' }),
      ticketService.quarantineToDeadLetter(releasedTicket.ticketId, {
        reason: 'authorization_requeue_success_fixture',
        lastError: 'authorization_requeue_success_fixture: preserve last error after release',
        remedy: 'Repair the success fixture before requeue.',
        attempts: 5,
      }, { source: 'requeue-success-fixture' }),
    ]));

    const readState = (ticketId: string) => runWithSystemIdentity(async () => {
      const [ticket, history, dlq] = await Promise.all([
        runtimePool.query('SELECT status, metadata, updated_at FROM tickets WHERE ticket_id = $1', [ticketId]),
        runtimePool.query(`SELECT from_status, to_status, changed_by, changed_by_label, metadata, created_at
          FROM ticket_status_history WHERE ticket_id = $1 ORDER BY created_at, id`, [ticketId]),
        runtimePool.query(`SELECT attempts, last_error, last_failure_at, quarantined_at, reason, remedy,
            requeued_by, requeued_at, updated_at
          FROM oshal_queue_dlq WHERE ticket_id = $1`, [ticketId]),
      ]);
      return { ticket: ticket.rows, history: history.rows, dlq: dlq.rows };
    });
    const rejectedBefore = await readState(rejectedTicket.ticketId);
    const statusObserver = vi.fn();
    ticketEvents.onStatusChanged(statusObserver);

    let rejectedResult: Awaited<ReturnType<DeadLetterService['requeue']>>;
    let releasedResult: Awaited<ReturnType<DeadLetterService['requeue']>>;
    try {
      await adminPool.query(`CREATE OR REPLACE FUNCTION p4_reject_dlq_reset()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.quarantined_at IS NOT NULL AND NEW.quarantined_at IS NULL THEN
            RAISE EXCEPTION 'p4 injected DLQ reset failure';
          END IF;
          RETURN NEW;
        END
        $$`);
      await adminPool.query(`CREATE TRIGGER p4_reject_dlq_reset
        BEFORE UPDATE ON oshal_queue_dlq
        FOR EACH ROW EXECUTE FUNCTION p4_reject_dlq_reset()`);

      rejectedResult = await runWithSystemIdentity(() => deadLetterService.requeue(
        rejectedTicket.ticketId,
        'rollback-operator@example.com',
      ));

      await adminPool.query('DROP TRIGGER p4_reject_dlq_reset ON oshal_queue_dlq');
      await adminPool.query('DROP FUNCTION p4_reject_dlq_reset()');

      releasedResult = await runWithSystemIdentity(() => deadLetterService.requeue(
        releasedTicket.ticketId,
        'release-operator@example.com',
      ));
    } finally {
      ticketEvents.removeListener('status-changed', statusObserver);
      await adminPool.query('DROP TRIGGER IF EXISTS p4_reject_dlq_reset ON oshal_queue_dlq');
      await adminPool.query('DROP FUNCTION IF EXISTS p4_reject_dlq_reset()');
    }

    expect(rejectedResult).toEqual({ ok: false, error: 'invalid-state' });
    expect(await readState(rejectedTicket.ticketId)).toEqual(rejectedBefore);
    expect(statusObserver).not.toHaveBeenCalledWith(expect.objectContaining({
      ticketId: rejectedTicket.ticketId,
      toStatus: 'approved',
    }));

    expect(releasedResult).toMatchObject({
      ok: true,
      entry: {
        ticketId: releasedTicket.ticketId,
        attempts: 0,
        quarantinedAt: null,
        reason: null,
        remedy: null,
        requeuedBy: 'release-operator@example.com',
      },
    });
    const releasedState = await readState(releasedTicket.ticketId);
    expect(releasedState.ticket).toEqual([expect.objectContaining({ status: 'approved' })]);
    expect(releasedState.history).toContainEqual(expect.objectContaining({
      from_status: 'dead_letter',
      to_status: 'approved',
      changed_by: 'release-operator@example.com',
      changed_by_label: 'Operator release-operator@example.com',
      metadata: expect.objectContaining({
        reason: 'dlq_requeue',
        source: 'dead-letter-service',
        requeuedBy: 'release-operator@example.com',
        previousAttempts: 5,
      }),
    }));
    expect(releasedState.dlq).toEqual([expect.objectContaining({
      attempts: 0,
      last_error: 'authorization_requeue_success_fixture: preserve last error after release',
      quarantined_at: null,
      reason: null,
      remedy: null,
      requeued_by: 'release-operator@example.com',
    })]);
    expect(releasedState.dlq[0].requeued_at).not.toBeNull();
    expect(statusObserver).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: releasedTicket.ticketId,
      fromStatus: 'dead_letter',
      toStatus: 'approved',
      changedBy: 'release-operator@example.com',
    }));
  });

  it('rolls back the ticket and history when atomic requeue finds no quarantined DLQ row', async () => {
    const { ticket } = await seedTicket([]);
    await runWithSystemIdentity(() => ticketService.updateStatus(ticket.ticketId, 'dead_letter', {
      reason: 'legacy_orphan_dead_letter_fixture',
      source: 'refused-dispatch-terminal-postgres-spec',
    }));
    const observer = vi.fn();
    ticketEvents.onStatusChanged(observer);
    try {
      await expect(runWithSystemIdentity(() => ticketService.requeueFromDeadLetter(
        ticket.ticketId,
        'orphan-requeue-operator@example.com',
      ))).rejects.toThrow(`Quarantined DLQ row not found for atomic requeue: ${ticket.ticketId}`);
    } finally {
      ticketEvents.removeListener('status-changed', observer);
    }

    const state = await runWithSystemIdentity(async () => {
      const [persistedTicket, history, dlq] = await Promise.all([
        runtimePool.query('SELECT status FROM tickets WHERE ticket_id = $1', [ticket.ticketId]),
        runtimePool.query(`SELECT from_status, to_status FROM ticket_status_history
          WHERE ticket_id = $1 ORDER BY created_at`, [ticket.ticketId]),
        runtimePool.query('SELECT ticket_id FROM oshal_queue_dlq WHERE ticket_id = $1', [ticket.ticketId]),
      ]);
      return { ticket: persistedTicket.rows, history: history.rows, dlq: dlq.rows };
    });
    expect(state).toEqual({
      ticket: [{ status: 'dead_letter' }],
      history: [
        { from_status: null, to_status: 'approved' },
        { from_status: 'approved', to_status: 'dead_letter' },
      ],
      dlq: [],
    });
    expect(observer).not.toHaveBeenCalled();
  });

  it('rejects and rolls back every ticket/task/history/DLQ write when the DLQ upsert fails mid-transition', async () => {
    await adminPool.query(`CREATE OR REPLACE FUNCTION p4_reject_selected_dlq_write()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'p4 injected DLQ failure';
      END
      $$`);
    await adminPool.query(`CREATE TRIGGER p4_reject_selected_dlq_write
      BEFORE INSERT OR UPDATE ON oshal_queue_dlq
      FOR EACH ROW EXECUTE FUNCTION p4_reject_selected_dlq_write()`);

    await expect(runWithSystemIdentity(() => deadLetterService.quarantineRefusal(rollbackTicket.ticketId, {
      code: 'authorization_fixture_transaction_refused',
      message: 'The fixture refusal must remain exact across rollback.',
      remedy: 'Repair the fixture dependency, then explicitly requeue.',
      source: 'refused-dispatch-terminal-postgres-spec',
    }))).rejects.toThrow(/p4 injected DLQ failure/);

    const state = await runWithSystemIdentity(async () => {
      const [ticket, task, history, dlq] = await Promise.all([
        runtimePool.query('SELECT status, metadata FROM tickets WHERE ticket_id = $1', [rollbackTicket.ticketId]),
        runtimePool.query('SELECT status, metadata FROM chat_tasks WHERE task_id = $1', [rollbackTaskId]),
        runtimePool.query('SELECT to_status, metadata FROM ticket_status_history WHERE ticket_id = $1 ORDER BY created_at', [rollbackTicket.ticketId]),
        runtimePool.query('SELECT reason, last_error, remedy FROM oshal_queue_dlq WHERE ticket_id = $1', [rollbackTicket.ticketId]),
      ]);
      return { ticket: ticket.rows, task: task.rows, history: history.rows, dlq: dlq.rows };
    });

    expect(state.ticket).toEqual([expect.objectContaining({ status: 'approved' })]);
    expect(state.ticket[0].metadata).not.toHaveProperty('failureClass');
    expect(state.task).toEqual([expect.objectContaining({ status: 'waiting_for_input' })]);
    expect(state.task[0].metadata).not.toHaveProperty('ticketTerminalStatus');
    expect(state.history).toEqual([expect.objectContaining({ to_status: 'approved' })]);
    expect(state.dlq).toEqual([]);
  });
});
