/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-163's guard. The decision is about which of two real tables answers "why did this ticket escalate", so it is proven against a real server: a private postgres:16-alpine under DisposablePostgres, the shipped ticket and swarm-escalation schema bootstraps, a real PostgresTicketStore and TicketService, and a real PostgresSwarmEscalationStore. An escalation raised the way a non-run path raises one is read back OFF ticket_status_history, and the run-scoped store is shown to refuse a record that names no run while still accepting one that does. Self-validating: the history row is counted before anything about its contents is asserted, so a fixture that recorded nothing fails loudly instead of letting an empty read pass.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { ensureTicketSchema } from '@/shared/services/database';
import { PostgresTicketStore, TicketService } from '@/features/ticketing';
import { PostgresSwarmEscalationStore } from '@/features/swarm-orchestration/services/postgres-swarm-escalation-store';
import type { SwarmEscalationRecord } from '@/features/swarm-orchestration/services/swarm-cycle-policy';
import { deriveTicketEscalationDetail } from '@/entities/ticket';

const OWNER_SUB = 'auth0|adr163-owner';

/**
 * Exactly the metadata `dispatch-manifest-worker.ts` passes when a manifest dispatch fails: a
 * reason and a source, and no run id anywhere, because at that point no swarm run exists.
 */
const NON_RUN_ESCALATION = {
  reason: 'manifest_worker_dispatch_failed',
  source: 'dispatch-manifest-worker',
};

// The ticket schema hangs off both of these: `ticket_task_links` carries an FK to `chat_tasks`
// (005) and `ticket_agent_assignments` one to `agents` (001), so the shipped migrations that
// create them run before the ticket bootstrap mirrors the rest.
const fixture = new DisposablePostgres({
  purpose: 'escalation-record-canon',
  migrations: ['001-multi-agent-foundation.sql', '005-conversation-history-and-usage.sql'],
});

let pool: Pool;
let ticketService: TicketService;
let escalationStore: PostgresSwarmEscalationStore;

/**
 * @description Builds a run-scoped escalation record, with the run id under test.
 * @param runId - The run identifier the record claims.
 * @param ticketExternalId - Ticket the record is about.
 * @returns A complete escalation record.
 */
function buildRunRecord(runId: string, ticketExternalId: string): SwarmEscalationRecord {
  return {
    runId,
    ticketExternalId,
    target: 'human_review',
    severity: 'high',
    retryClass: 'deterministic',
    reason: 'Verification exhausted policy budget after attempt 2.',
    attemptState: { verificationAttempt: 2, buildRegressionCount: 1, designRegressionCount: 0 },
    createdAt: new Date().toISOString(),
  };
}

/**
 * @description Creates an approved ticket through the real service.
 * @returns The new ticket identifier.
 */
async function createApprovedTicket(): Promise<string> {
  const ticket = await ticketService.createTicket({
    title: 'Dispatch failed before a swarm run existed',
    ticketType: 'build',
    status: 'approved',
    priority: 'medium',
    labels: [],
    ownerSub: OWNER_SUB,
  });
  return ticket.ticketId;
}

beforeAll(async () => {
  pool = await fixture.start();
  await ensureTicketSchema(pool);
  ticketService = new TicketService(new PostgresTicketStore(pool));
  escalationStore = new PostgresSwarmEscalationStore(pool);
  // Force the escalation schema to exist before any assertion counts its rows: an activation that
  // never ran would leave the table missing and a "no row was written" claim would be vacuous.
  await escalationStore.list({ limit: 1 });
}, 240_000);

afterAll(async () => {
  await fixture.stop();
}, 60_000);

describe('the canonical escalation record is the transition (ADR-163)', () => {
  it('an escalation raised with no swarm run lands in ticket_status_history', async () => {
    const ticketId = await createApprovedTicket();

    await ticketService.updateStatus(ticketId, 'escalated', NON_RUN_ESCALATION);

    // Self-validation FIRST. Every assertion below reads this table; if nothing was written they
    // would all pass on an empty result and prove nothing.
    const rows = await pool.query<{ from_status: string; changed_by: string; metadata: Record<string, string> }>(
      `SELECT from_status, changed_by, metadata
         FROM ticket_status_history
        WHERE ticket_id = $1 AND to_status = 'escalated'`,
      [ticketId],
    );
    expect(
      rows.rowCount,
      'no escalating row in ticket_status_history — the canonical escalation record was not written',
    ).toBe(1);

    const [row] = rows.rows;
    expect(row.from_status).toBe('approved');
    expect(row.metadata.reason).toBe('manifest_worker_dispatch_failed');
    expect(row.metadata.source).toBe('dispatch-manifest-worker');
    // Filled by the escalation backstop, so an escalation always says how bad it is and what to do.
    expect(row.metadata.severity).toBe('medium');
    expect(row.metadata.nextAction, 'the escalation records no next action').toBeTruthy();
    expect(row.metadata.previousStatus).toBe('approved');
    expect(Number.isFinite(Date.parse(String(row.metadata.escalatedAt)))).toBe(true);

    // The ticket row's mirror of the same transition, for a reader that cannot join history.
    const ticketRow = await pool.query<{ metadata: Record<string, Record<string, string>> }>(
      'SELECT metadata FROM tickets WHERE ticket_id = $1',
      [ticketId],
    );
    expect(ticketRow.rows[0].metadata.lastStatusTransition?.status).toBe('escalated');
    expect(ticketRow.rows[0].metadata.lastStatusTransition?.reason).toBe('manifest_worker_dispatch_failed');

    // And what the cockpit reads back is that reason, sourced from the append-only history.
    const detail = deriveTicketEscalationDetail(
      await ticketService.getStatusHistory(ticketId),
      ticketRow.rows[0].metadata as never,
    );
    expect(detail?.reason).toBe('manifest_worker_dispatch_failed');
    expect(detail?.origin).toBe('status-history');

    // The other half of the decision: this escalation produces NO run-scoped record, and that is
    // correct rather than a gap — there was no run.
    const durable = await pool.query(
      'SELECT id FROM swarm_escalations WHERE ticket_external_id = $1',
      [ticketId],
    );
    expect(durable.rowCount, 'a non-run escalation must not invent a run-scoped record').toBe(0);
  }, 120_000);

  it('the run-scoped store refuses a record that names no run, and writes nothing', async () => {
    const ticketId = await createApprovedTicket();
    const before = await pool.query('SELECT count(*)::int AS n FROM swarm_escalations');

    await expect(escalationStore.save(buildRunRecord('', ticketId))).rejects.toThrow(/runId/);
    await expect(escalationStore.save(buildRunRecord('   ', ticketId))).rejects.toThrow(/run-scoped/);

    const after = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM swarm_escalations');
    expect(after.rows[0].n, 'a refused save still wrote a row').toBe(before.rows[0].n);
  }, 120_000);

  it('a record that names its run is still persisted and listed', async () => {
    const ticketId = await createApprovedTicket();

    await escalationStore.save(buildRunRecord('run-adr163', ticketId));

    const stored = await pool.query<{ run_id: string; retry_class: string; attempt_state: Record<string, number> }>(
      'SELECT run_id, retry_class, attempt_state FROM swarm_escalations WHERE ticket_external_id = $1',
      [ticketId],
    );
    expect(stored.rowCount, 'the run-scoped write was refused for a record that names its run').toBe(1);
    expect(stored.rows[0].run_id).toBe('run-adr163');
    expect(stored.rows[0].retry_class).toBe('deterministic');
    expect(stored.rows[0].attempt_state.verificationAttempt).toBe(2);

    const listed = await escalationStore.list({ ticketExternalId: ticketId });
    expect(listed).toHaveLength(1);
    expect(listed[0].runId).toBe('run-adr163');
  }, 120_000);
});
