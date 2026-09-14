/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove immutable queued creators, current permission refusal and restricted exact-principal dispatch using real ticket and authorization services.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getApplicationAuthorizationActor, runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { configureApplicationExecutionPolicy, runWithApplicationExecution } from '@/shared/application-authorization-execution';
import { configureQueuedApplicationPrincipals, runWithQueuedApplicationPrincipal } from '@/shared/queued-application-principal';
import { getRequestIdentity, runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY, readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { createProtectedResultFixture, RESULT_AGENT, RESULT_APP, RESULT_ISSUER } from '../fixtures/protected-results';

let fixture: Awaited<ReturnType<typeof createProtectedResultFixture>>;
let service: TicketService;
let records: Map<string, AuthorizationActor>;
beforeEach(async () => {
  fixture = await createProtectedResultFixture(); service = new TicketService(new InMemoryTicketStore()); records = new Map();
  configureQueuedApplicationPrincipals({ capture: async (id, actor) => { if (!records.has(id)) records.set(id, structuredClone(actor)); },
    read: async id => structuredClone(records.get(id) ?? null) });
  configureApplicationExecutionPolicy({ owner: () => RESULT_APP, protectedApp: () => true,
    authorize: (actor, operation) => fixture.policy.authorize(actor, operation) });
});
afterEach(async () => { configureQueuedApplicationPrincipals(undefined); configureApplicationExecutionPolicy(undefined); await fixture?.close(); });

function authenticated<T>(actor: AuthorizationActor, work: () => T): T {
  return runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
    principalIssuer: actor.issuer, isOperator: actor.isSwarmAdmin }, work));
}
function create(ownerSub = 'alice', metadata: Record<string, unknown> = {}) {
  return authenticated(fixture.actors.alice, () => service.createTicket({ title: 'Protected queued reasoning',
    ownerSub, ticketType: 'task', status: 'approved', metadata }));
}
async function dispatch(ticketId: string, execute = async () => ({ identity: getRequestIdentity(), actor: getApplicationAuthorizationActor() })) {
  const ticket = (await service.getTicket(ticketId))!;
  return runWithSystemIdentity(() => runWithQueuedApplicationPrincipal({ ticketId, ownerSub: ticket.ownerSub,
    issuer: readOwnerPrincipalIssuer(ticket.metadata) }, true,
  () => runWithApplicationExecution({ kind: 'bots', operation: RESULT_AGENT, userSub: ticket.ownerSub! }, execute)));
}

it('captures the authenticated creator independently from forged ticket metadata and owner assignment', async () => {
  const ticket = await create('alice', { actor: { sub: 'admin', isSwarmAdmin: true },
    [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://forged.test', oshalProtectedExecutions: ['forged'] });
  expect(records.get(ticket.ticketId)).toMatchObject({ sub: 'alice', issuer: RESULT_ISSUER, isSwarmAdmin: false });
  expect(ticket.metadata).not.toHaveProperty('oshalProtectedExecutions');
  const other = await create('bob');
  expect(records.has(other.ticketId)).toBe(false);
  await expect(dispatch(other.ticketId)).rejects.toThrow('authorization_queue_provenance_required');
});

it('preserves exact owner issuer and refuses owner reassignment while allowing ordinary edits', async () => {
  const ticket = await create();
  await service.updateTicket(ticket.ticketId, { title: 'Updated work', metadata: { note: 'reviewed',
    [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://other.test', oshalProtectedExecutions: ['forged'] } });
  const updated = (await service.getTicket(ticket.ticketId))!;
  expect(updated.title).toBe('Updated work'); expect(readOwnerPrincipalIssuer(updated.metadata)).toBe(RESULT_ISSUER);
  expect(updated.metadata).not.toHaveProperty('oshalProtectedExecutions');
  await expect(service.updateTicket(ticket.ticketId, { ownerSub: 'admin' })).rejects.toThrow('ticket_owner_immutable');
  expect((await service.getTicket(ticket.ticketId))!.ownerSub).toBe('alice');
});

it('restores the exact issuer and subject under nonoperator database context after queue detachment', async () => {
  const ticket = await create(); const result = await dispatch(ticket.ticketId);
  expect(result.identity).toEqual({ sub: 'alice', principalIssuer: RESULT_ISSUER, isOperator: false });
  expect(result.actor).toMatchObject({ sub: 'alice', issuer: RESULT_ISSUER, isSwarmAdmin: false });
});

it('refuses revoked and disabled queued users before invoking the worker', async () => {
  const ticket = await create(), worker = vi.fn(async () => ({ identity: getRequestIdentity(), actor: getApplicationAuthorizationActor() }));
  await fixture.change('alice', 'revoke');
  await expect(dispatch(ticket.ticketId, worker)).rejects.toThrow(); expect(worker).not.toHaveBeenCalled();
  await fixture.change('alice', 'grant'); fixture.actors.alice.isActive = false;
  await expect(dispatch(ticket.ticketId, worker)).rejects.toThrow(); expect(worker).not.toHaveBeenCalled();
});

it('does not refresh captured directory timestamps or widen an explicit permission ceiling', async () => {
  fixture.actors.alice.directory = [{ issuer: RESULT_ISSUER, tenantId: 'tenant', groups: ['group'],
    observedAt: '2026-01-01T00:00:00.000Z', complete: true }];
  fixture.actors.alice.allowedPermissions = [];
  const ticket = await create();
  fixture.actors.alice.directory[0].observedAt = new Date().toISOString(); fixture.actors.alice.allowedPermissions = undefined;
  expect(records.get(ticket.ticketId)?.directory?.[0].observedAt).toBe('2026-01-01T00:00:00.000Z');
  await expect(dispatch(ticket.ticketId)).rejects.toThrow('authorization_executor_scope_denied');
});

it('refuses legacy tickets and same-subject records from another issuer', async () => {
  const legacy = await runWithSystemIdentity(() => service.createTicket({ title: 'Legacy', ownerSub: 'alice',
    metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: RESULT_ISSUER } }));
  await expect(dispatch(legacy.ticketId)).rejects.toThrow('authorization_queue_provenance_required');
  const ticket = await create(); records.get(ticket.ticketId)!.issuer = 'https://other.test';
  await expect(dispatch(ticket.ticketId)).rejects.toThrow('authorization_queue_provenance_required');
});
