/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit coverage for the queue DLQ policy state machine (DeadLetterService over mocked persistence): attempt accumulation, QM_MAX_ATTEMPTS quarantine (default + env override), escalation-cycle counting (system loops count, manual operator escalations don't), operator notification on topic queue-dlq, quarantine idempotence, fail-open without a pool, non-rolled-back quarantine when the status flip fails, and operator requeue (attempts reset + actor recorded). Plus the extended lifecycle model: dead_letter transitions and terminalChildStatusForParentState.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: escalation-count case now drives the real production actors (operator email + bot agentId are both NON-system and must not count) instead of the fabricated changedBy:'user' event no producer ever emits — matching the guard's move to a positive changedBy === 'system' gate.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DeadLetterService,
  readQmMaxAttempts,
  DEFAULT_QM_MAX_ATTEMPTS,
  type DeadLetterPg,
} from '../../src/features/swarm-orchestration/services/dead-letter-service';
import { terminalChildStatusForParentState } from '../../src/features/swarm-orchestration/services/queue-manager-sweeps';
import { TicketService } from '../../src/features/ticketing/services/ticket-service';
import { InMemoryTicketStore } from '../../src/features/ticketing/services/in-memory-ticket-store';

/** In-memory stand-in for the oshal_queue_dlq table, keyed on the service's actual SQL. */
class FakeDlqPool implements DeadLetterPg {
  rows = new Map<string, {
    ticket_id: string; attempts: number; last_error: string | null;
    quarantined_at: Date | null; reason: string | null;
    requeued_by: string | null; requeued_at: Date | null; last_failure_at: Date | null;
  }>();
  failNextQuery = false;

  async query(text: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    if (this.failNextQuery) {
      this.failNextQuery = false;
      throw new Error('relation "oshal_queue_dlq" does not exist');
    }
    const ticketId = String(params[0] ?? '');
    if (text.includes('INSERT INTO oshal_queue_dlq')) {
      const existing = this.rows.get(ticketId);
      const lastError = (params[1] as string | null) ?? null;
      if (existing) {
        existing.attempts += 1;
        existing.last_error = lastError ?? existing.last_error;
        existing.last_failure_at = new Date();
      } else {
        this.rows.set(ticketId, {
          ticket_id: ticketId, attempts: 1, last_error: lastError,
          quarantined_at: null, reason: null, requeued_by: null, requeued_at: null,
          last_failure_at: new Date(),
        });
      }
      const row = this.rows.get(ticketId)!;
      return { rows: [{ attempts: row.attempts, quarantined_at: row.quarantined_at, reason: row.reason }] };
    }
    if (text.includes('SET quarantined_at = NOW()')) {
      const row = this.rows.get(ticketId);
      if (row) { row.quarantined_at = new Date(); row.reason = String(params[1]); }
      return { rows: [] };
    }
    if (text.includes('SET attempts = 0')) {
      const row = this.rows.get(ticketId);
      if (row) {
        row.attempts = 0; row.quarantined_at = null; row.reason = null;
        row.requeued_by = String(params[1]); row.requeued_at = new Date();
      }
      return { rows: [] };
    }
    if (text.includes('LEFT JOIN tickets')) {
      const includeAll = params[0] === true;
      const rows = [...this.rows.values()]
        .filter((r) => includeAll || r.quarantined_at !== null)
        .map((r) => ({ ...r, title: `Ticket ${r.ticket_id}`, status: 'dead_letter', ticket_type: 'build' }));
      return { rows };
    }
    if (text.includes('FROM oshal_queue_dlq WHERE ticket_id')) {
      const row = this.rows.get(ticketId);
      return { rows: row ? [{ ...row }] : [] };
    }
    throw new Error(`FakeDlqPool: unrecognized SQL: ${text.slice(0, 80)}`);
  }
}

function makeTicketGateway(overrides: Partial<Record<'updateStatus' | 'updateStatusAs', unknown>> = {}) {
  return {
    getTicket: vi.fn(async () => null),
    updateStatus: (overrides.updateStatus as ReturnType<typeof vi.fn>) ?? vi.fn(async () => undefined),
    updateStatusAs: (overrides.updateStatusAs as ReturnType<typeof vi.fn>) ?? vi.fn(async () => undefined),
  } as unknown as Pick<TicketService, 'getTicket' | 'updateStatus' | 'updateStatusAs'>;
}

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('readQmMaxAttempts', () => {
  it('defaults to 3 and honors a positive QM_MAX_ATTEMPTS override', () => {
    expect(readQmMaxAttempts({} as NodeJS.ProcessEnv)).toBe(DEFAULT_QM_MAX_ATTEMPTS);
    expect(readQmMaxAttempts({ QM_MAX_ATTEMPTS: '5' } as NodeJS.ProcessEnv)).toBe(5);
    expect(readQmMaxAttempts({ QM_MAX_ATTEMPTS: '0' } as NodeJS.ProcessEnv)).toBe(3);
    expect(readQmMaxAttempts({ QM_MAX_ATTEMPTS: 'junk' } as NodeJS.ProcessEnv)).toBe(3);
  });
});

describe('DeadLetterService policy state machine', () => {
  it('accumulates attempts and quarantines on the Nth failed dispatch cycle', async () => {
    const pool = new FakeDlqPool();
    const gateway = makeTicketGateway();
    const notify = vi.fn(async () => undefined);
    const svc = new DeadLetterService({ pool, ticketService: gateway, notify, env: {} as NodeJS.ProcessEnv });

    expect(await svc.recordFailureCycle(UUID, 'dispatch_failure', 'boom 1')).toEqual({ attempts: 1, quarantined: false });
    expect(await svc.recordFailureCycle(UUID, 'dispatch_failure', 'boom 2')).toEqual({ attempts: 2, quarantined: false });
    const third = await svc.recordFailureCycle(UUID, 'dispatch_failure', 'boom 3');
    expect(third).toEqual({ attempts: 3, quarantined: true, reason: 'max_dispatch_attempts_poison' });

    // Terminal status flip carried reason metadata (never a bare flip).
    expect(gateway.updateStatus).toHaveBeenCalledTimes(1);
    expect(gateway.updateStatus).toHaveBeenCalledWith(UUID, 'dead_letter', expect.objectContaining({
      reason: 'max_dispatch_attempts_poison',
      source: 'dead-letter-service',
      attempts: 3,
      lastError: 'boom 3',
    }));
    // Row is marked quarantined with the reason.
    expect(pool.rows.get(UUID)?.quarantined_at).not.toBeNull();
    expect(pool.rows.get(UUID)?.reason).toBe('max_dispatch_attempts_poison');
    // Operator notified on topic queue-dlq.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('queue-dlq');
    expect(String((notify.mock.calls[0][1] as { subject: string }).subject)).toContain(UUID);
  });

  it('honors the QM_MAX_ATTEMPTS env override', async () => {
    const pool = new FakeDlqPool();
    const gateway = makeTicketGateway();
    const svc = new DeadLetterService({ pool, ticketService: gateway, env: { QM_MAX_ATTEMPTS: '2' } as NodeJS.ProcessEnv });

    expect((await svc.recordFailureCycle(UUID, 'dispatch_failure')).quarantined).toBe(false);
    expect((await svc.recordFailureCycle(UUID, 'dispatch_failure')).quarantined).toBe(true);
    expect(gateway.updateStatus).toHaveBeenCalledWith(UUID, 'dead_letter', expect.objectContaining({ maxAttempts: 2 }));
  });

  it('counts system escalation cycles (the auto-escalate loop) but never manual operator escalations', async () => {
    const pool = new FakeDlqPool();
    const gateway = makeTicketGateway();
    const notify = vi.fn(async () => undefined);
    const svc = new DeadLetterService({ pool, ticketService: gateway, notify, env: {} as NodeJS.ProcessEnv });

    const systemEscalation = {
      ticketId: UUID, fromStatus: 'in_process_build', toStatus: 'escalated',
      changedBy: 'system', changedByLabel: 'System', timestamp: new Date().toISOString(),
    };
    // Manual operator escalation carries the operator's own identity (the cockpit status
    // routes call updateStatusAs with the caller) — it must NOT count as a poison cycle.
    svc.handleTicketStatusEvent({ ...systemEscalation, changedBy: 'op@example.com', changedByLabel: 'Operator op@example.com' });
    // A bot self-escalation carries its agentId — also NOT the auto-loop, must NOT count.
    svc.handleTicketStatusEvent({ ...systemEscalation, changedBy: 'agent-code-developer', changedByLabel: 'Swarm Worker' });
    // Non-escalation transitions must NOT count.
    svc.handleTicketStatusEvent({ ...systemEscalation, toStatus: 'complete' });
    await vi.waitFor(() => expect(pool.rows.has(UUID)).toBe(false));

    // Three system escalation cycles = poison.
    svc.handleTicketStatusEvent(systemEscalation);
    await vi.waitFor(() => expect(pool.rows.get(UUID)?.attempts).toBe(1));
    svc.handleTicketStatusEvent(systemEscalation);
    await vi.waitFor(() => expect(pool.rows.get(UUID)?.attempts).toBe(2));
    svc.handleTicketStatusEvent(systemEscalation);
    await vi.waitFor(() => expect(pool.rows.get(UUID)?.quarantined_at).not.toBeNull());

    expect(pool.rows.get(UUID)?.reason).toBe('escalation_loop_poison');
    expect(gateway.updateStatus).toHaveBeenCalledWith(UUID, 'dead_letter', expect.objectContaining({ reason: 'escalation_loop_poison' }));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('is idempotent once quarantined — trailing failures neither re-flip status nor re-notify', async () => {
    const pool = new FakeDlqPool();
    const gateway = makeTicketGateway();
    const notify = vi.fn(async () => undefined);
    const svc = new DeadLetterService({ pool, ticketService: gateway, notify, env: { QM_MAX_ATTEMPTS: '1' } as NodeJS.ProcessEnv });

    expect((await svc.recordFailureCycle(UUID, 'dispatch_failure')).quarantined).toBe(true);
    const trailing = await svc.recordFailureCycle(UUID, 'escalation_cycle');
    expect(trailing.quarantined).toBe(true);
    expect(gateway.updateStatus).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('fails open without a pool: never quarantines, never throws', async () => {
    const gateway = makeTicketGateway();
    const svc = new DeadLetterService({ pool: null, ticketService: gateway, env: {} as NodeJS.ProcessEnv });
    for (let i = 0; i < 10; i++) {
      expect(await svc.recordFailureCycle(UUID, 'dispatch_failure')).toEqual({ attempts: 0, quarantined: false });
    }
    expect(gateway.updateStatus).not.toHaveBeenCalled();
    expect(await svc.listEntries()).toEqual([]);
    expect(await svc.requeue(UUID, 'op@example.com')).toEqual({ ok: false, error: 'unavailable' });
  });

  it('fails open when the DLQ table is missing/unreadable', async () => {
    const pool = new FakeDlqPool();
    pool.failNextQuery = true;
    const svc = new DeadLetterService({ pool, ticketService: makeTicketGateway(), env: {} as NodeJS.ProcessEnv });
    expect(await svc.recordFailureCycle(UUID, 'dispatch_failure')).toEqual({ attempts: 0, quarantined: false });
  });

  it('does NOT mark the row quarantined when the terminal status flip fails', async () => {
    const pool = new FakeDlqPool();
    const failingUpdate = vi.fn(async () => { throw new Error('Invalid state transition: cancelled → dead_letter'); });
    const gateway = makeTicketGateway({ updateStatus: failingUpdate });
    const notify = vi.fn(async () => undefined);
    const svc = new DeadLetterService({ pool, ticketService: gateway, notify, env: { QM_MAX_ATTEMPTS: '1' } as NodeJS.ProcessEnv });

    const verdict = await svc.recordFailureCycle(UUID, 'dispatch_failure', 'boom');
    expect(verdict.quarantined).toBe(false);
    expect(pool.rows.get(UUID)?.quarantined_at).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('requeue releases a quarantined ticket to approved with the actor recorded and attempts reset', async () => {
    const pool = new FakeDlqPool();
    const gateway = makeTicketGateway();
    const svc = new DeadLetterService({ pool, ticketService: gateway, env: { QM_MAX_ATTEMPTS: '1' } as NodeJS.ProcessEnv });
    await svc.recordFailureCycle(UUID, 'dispatch_failure', 'boom');
    expect(pool.rows.get(UUID)?.quarantined_at).not.toBeNull();

    const result = await svc.requeue(UUID, 'maintainer@emeraldcoastsystemsgroup.com');
    expect(result.ok).toBe(true);
    expect(gateway.updateStatusAs).toHaveBeenCalledWith(
      UUID, 'approved',
      'maintainer@emeraldcoastsystemsgroup.com',
      expect.stringContaining('maintainer@emeraldcoastsystemsgroup.com'),
      expect.objectContaining({ reason: 'dlq_requeue', requeuedBy: 'maintainer@emeraldcoastsystemsgroup.com' }),
    );
    const row = pool.rows.get(UUID)!;
    expect(row.attempts).toBe(0);
    expect(row.quarantined_at).toBeNull();
    expect(row.requeued_by).toBe('maintainer@emeraldcoastsystemsgroup.com');
    if (result.ok) {
      expect(result.entry.attempts).toBe(0);
      expect(result.entry.requeuedBy).toBe('maintainer@emeraldcoastsystemsgroup.com');
    }
  });

  it('requeue of an unknown or non-quarantined ticket is not-found; a rejected transition is invalid-state', async () => {
    const pool = new FakeDlqPool();
    const gateway = makeTicketGateway();
    const svc = new DeadLetterService({ pool, ticketService: gateway, env: {} as NodeJS.ProcessEnv });

    expect(await svc.requeue(UUID, 'op')).toEqual({ ok: false, error: 'not-found' });
    await svc.recordFailureCycle(UUID, 'dispatch_failure'); // attempts=1, not quarantined
    expect(await svc.requeue(UUID, 'op')).toEqual({ ok: false, error: 'not-found' });

    const svc2 = new DeadLetterService({
      pool,
      ticketService: makeTicketGateway({ updateStatusAs: vi.fn(async () => { throw new Error('Invalid state transition'); }) }),
      env: { QM_MAX_ATTEMPTS: '2' } as NodeJS.ProcessEnv,
    });
    await svc2.recordFailureCycle(UUID, 'dispatch_failure'); // attempts=2 → quarantined
    expect(await svc2.requeue(UUID, 'op')).toEqual({ ok: false, error: 'invalid-state' });
  });

  it('lists quarantined entries only by default, all rows with includeUnquarantined', async () => {
    const pool = new FakeDlqPool();
    const svc = new DeadLetterService({ pool, ticketService: makeTicketGateway(), env: { QM_MAX_ATTEMPTS: '1' } as NodeJS.ProcessEnv });
    await svc.recordFailureCycle(UUID, 'dispatch_failure', 'poison'); // quarantines
    const other = '11111111-2222-3333-4444-555555555555';
    const svcHighCap = new DeadLetterService({ pool, ticketService: makeTicketGateway(), env: { QM_MAX_ATTEMPTS: '99' } as NodeJS.ProcessEnv });
    await svcHighCap.recordFailureCycle(other, 'dispatch_failure', 'still trying');

    const quarantinedOnly = await svc.listEntries();
    expect(quarantinedOnly.map((e) => e.ticketId)).toEqual([UUID]);
    expect(quarantinedOnly[0].reason).toBe('max_dispatch_attempts_poison');

    const all = await svc.listEntries(true);
    expect(all.map((e) => e.ticketId).sort()).toEqual([other, UUID].sort());
  });

  it('a failing notifier never unwinds or blocks the quarantine', async () => {
    const pool = new FakeDlqPool();
    const gateway = makeTicketGateway();
    const notify = vi.fn(async () => { throw new Error('telegram down'); });
    const svc = new DeadLetterService({ pool, ticketService: gateway, notify, env: { QM_MAX_ATTEMPTS: '1' } as NodeJS.ProcessEnv });
    const verdict = await svc.recordFailureCycle(UUID, 'dispatch_failure');
    expect(verdict.quarantined).toBe(true);
    expect(pool.rows.get(UUID)?.quarantined_at).not.toBeNull();
  });
});

describe('extended ticket lifecycle model', () => {
  it('allows escalated → dead_letter and dead_letter → approved, and backstops quarantine metadata', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticket = await service.createTicket({
      title: 'poison', ticketType: 'build', description: '', status: 'backlog',
      priority: 'none', labels: [], workspaceId: null, assignedAgentId: null,
      parentTicketId: null, externalProvider: null, externalId: null, externalUrl: null,
      metadata: {},
    } as Parameters<TicketService['createTicket']>[0]);

    await service.updateStatus(ticket.ticketId, 'escalated', { reason: 'loop' });
    await service.updateStatus(ticket.ticketId, 'dead_letter'); // no metadata on purpose
    let current = await service.getTicket(ticket.ticketId);
    expect(current?.status).toBe('dead_letter');
    const history = await service.getStatusHistory(ticket.ticketId);
    const quarantineRow = history.find((h) => h.toStatus === 'dead_letter');
    // The backstop guarantees a reason-less quarantine is structurally impossible.
    expect(quarantineRow?.metadata.reason).toBe('unspecified_dead_letter');
    expect(quarantineRow?.metadata.nextAction).toBe('operator_requeue_or_cancel');

    await service.updateStatus(ticket.ticketId, 'approved', { reason: 'dlq_requeue' });
    current = await service.getTicket(ticket.ticketId);
    expect(current?.status).toBe('approved');
  });

  it('rejects dispatch re-entry from dead_letter into in_process phases', async () => {
    const store = new InMemoryTicketStore();
    const service = new TicketService(store);
    const ticket = await service.createTicket({
      title: 'poison', ticketType: 'build', description: '', status: 'backlog',
      priority: 'none', labels: [], workspaceId: null, assignedAgentId: null,
      parentTicketId: null, externalProvider: null, externalId: null, externalUrl: null,
      metadata: {},
    } as Parameters<TicketService['createTicket']>[0]);
    await service.updateStatus(ticket.ticketId, 'approved');
    await service.updateStatus(ticket.ticketId, 'in_process_build');
    await service.updateStatus(ticket.ticketId, 'dead_letter', { reason: 'max_dispatch_attempts_poison' });
    await expect(service.updateStatus(ticket.ticketId, 'in_process_build')).rejects.toThrow(/Invalid state transition/);
  });

  it('parks approved children of a dead_letter parent as escalated', () => {
    expect(terminalChildStatusForParentState('dead_letter')).toBe('escalated');
    expect(terminalChildStatusForParentState('escalated')).toBe('escalated');
    expect(terminalChildStatusForParentState('cancelled')).toBe('cancelled');
    expect(terminalChildStatusForParentState('complete')).toBeNull();
  });
});
