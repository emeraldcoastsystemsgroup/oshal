/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard schedule-born ticket issuer persistence through TicketService and refuse missing, revoked or ambiguous observed principals.
 */
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/composition-root';
import { dispatchWorkflowTicketSchedule } from '@/app/workflow-ticket-schedule-dispatch';
import type { ScheduleRecord } from '@/features/scheduling';
import { TicketService } from '@/features/ticketing';
import { InMemoryTicketStore } from '@/features/ticketing/services/in-memory-ticket-store';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { getRequestIdentity, isSystemIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';

vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));
const issuer = 'https://schedule-identity.example.test/realm';
const schedule = (ownerSub: string | null = 'saved-owner'): ScheduleRecord => ({
  id: 'nightly-docs', taskType: 'workflow:oshal-dev', cron: '0 4 * * *',
  taskData: { prompt: 'Review docs', title: 'Docs', oshalOwnerPrincipalIssuer: 'https://forged.test' },
  ownerSub, status: 'active', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  nextRunAt: null, lastRunAt: null, executionCount: 0,
});
const row = (namespace = issuer, status = 'active') => ({ issuer: namespace, user_sub: 'saved-owner',
  provider: 'fixture', email: null, email_verified: false, display_name: null, canonical_local_sub: null,
  status, first_seen_at: new Date('2026-10-01T00:00:00Z'), last_seen_at: new Date('2026-10-01T00:00:00Z') });
function fixture(rows: ReturnType<typeof row>[]) {
  const query = vi.fn(async (sql: string, args: unknown[]) => {
    expect(isSystemIdentity(getRequestIdentity())).toBe(true);
    expect(sql).toBe('SELECT * FROM oshal_verified_principals WHERE user_sub=$1 LIMIT 2');
    expect(args).toEqual(['saved-owner']);
    return { rows };
  });
  const tickets = new InMemoryTicketStore(), ticketService = new TicketService(tickets);
  const create = vi.spyOn(ticketService, 'createTicket');
  return { ctx: { pool: { query } as unknown as Pool, ticketService } as AppContext, tickets, query, create };
}
describe('scheduled workflow verified issuer', () => {
  it('persists observed provenance through real ticket creation, ignoring task-data issuer claims', async () => {
    const f = fixture([row()]);
    const result = await runWithSystemIdentity(() => dispatchWorkflowTicketSchedule(f.ctx, schedule()));
    expect(result.success).toBe(true);
    const ticket = await f.tickets.get(result.taskId!);
    expect(ticket?.ownerSub).toBe('saved-owner');
    expect(ticket?.status).toBe('backlog');
    expect(readOwnerPrincipalIssuer(ticket?.metadata)).toBe(issuer);
    expect(ticket?.metadata).toMatchObject({ scheduleId: 'nightly-docs', workflowTrigger: true });
  });
  it.each([
    ['missing', []], ['disabled', [row(issuer, 'disabled')]],
    ['two active namespaces', [row(), row('https://another.test')]],
    ['disabled namespace collision', [row(), row('https://another.test', 'disabled')]],
  ])('refuses %s owner before ticket creation', async (_name, rows) => {
    const f = fixture(rows as ReturnType<typeof row>[]);
    const result = await runWithSystemIdentity(() => dispatchWorkflowTicketSchedule(f.ctx, schedule()));
    expect(result.success).toBe(false);
    expect(result.error).toContain('unambiguous active verified owner');
    expect(f.create).not.toHaveBeenCalled();
  });
  it('retains ownerless system workflow tickets without manufacturing a user issuer', async () => {
    const f = fixture([]);
    const result = await runWithSystemIdentity(() => dispatchWorkflowTicketSchedule(f.ctx, schedule(null)));
    expect(result.success).toBe(true);
    expect(f.query).not.toHaveBeenCalled();
    expect(readOwnerPrincipalIssuer((await f.tickets.get(result.taskId!))?.metadata)).toBeNull();
  });
  it('reports unavailable directory without creating an issuerless owned ticket', async () => {
    const f = fixture([]); f.query.mockRejectedValueOnce(new Error('directory unavailable'));
    const result = await runWithSystemIdentity(() => dispatchWorkflowTicketSchedule(f.ctx, schedule()));
    expect(result).toMatchObject({ success: false, error: 'directory unavailable' });
    expect(f.create).not.toHaveBeenCalled();
  });
});
