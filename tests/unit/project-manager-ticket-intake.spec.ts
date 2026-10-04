/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added focused project-manager intake behavior coverage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove the authenticated owner is copied to both canonical ticket and chat-task rows so RLS ownership agrees with the request identity.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove verified issuer stamps on real precreated PM tasks while preserving ticket linkage/project metadata and no invented or guest-dispatched authority.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveProjectManagerTicketExecutionContext } from '@/features/chat-orchestration';
import { InMemoryTaskStore } from '@/entities/task';
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME } from '@/entities/ticket';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY, readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';

vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));

const OWNER = 'auth0|pm-owner';
const ISSUER = 'https://pm.identity.fixture.test';

describe('project-manager ticket intake', () => {
  it('creates approved work so QueueManager can pick it up immediately', async () => {
    const createdTicket = {
      ticketId: '11111111-1111-4111-8111-111111111111',
      title: 'Build a validation dashboard',
      status: 'approved',
      metadata: { queueId: 'default', queueName: 'Default' },
    };
    const taskStore = {
      create: vi.fn(async () => ({ taskId: 'pm-task-1' })),
    };
    const ticketService = {
      createTicket: vi.fn(async (input: Record<string, unknown>) => ({
        ...createdTicket,
        title: input.title,
        status: input.status,
        metadata: input.metadata,
      })),
      linkTask: vi.fn(async () => {}),
    };

    const result = await resolveProjectManagerTicketExecutionContext(
      { taskStore, ticketService } as never,
      {
        requestedTaskId: 'requested-task',
        resolvedAgentId: 'a0000000-0000-0000-0000-000000000001',
        source: 'swarmbot-chat',
        text: 'please create a ticket to build a validation dashboard',
        ownerSub: 'auth0|pm-owner',
      },
    );

    expect(ticketService.createTicket).toHaveBeenCalledWith(expect.objectContaining({
      status: 'approved',
      ticketType: 'build',
      ownerSub: 'auth0|pm-owner',
    }));
    expect(taskStore.create).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'auth0|pm-owner' }));
    expect(result.ticketCreated).toBe(true);
    expect(result.ticketStatus).toBe('approved');
    expect(result.taskId).toBe('pm-task-1');
  });
});

/**
 * @description Use the public intake resolver over real canonical stores without external persistence.
 * @returns Owned stores and the public PM creation path with the original requested conversation ID.
 */
function canonicalIntakeFixture() {
  const taskStore = new InMemoryTaskStore();
  const ticketStore = new InMemoryTicketStore();
  const ticketService = new TicketService(ticketStore);
  return { taskStore, ticketStore, ticketService, intake: (ownerSub?: string, chatOnly = false) =>
    resolveProjectManagerTicketExecutionContext({ taskStore, ticketService }, {
      requestedTaskId: 'requested-pm-conversation', resolvedAgentId: 'a0000000-0000-0000-0000-000000000001',
      source: 'swarmbot-chat', text: 'please create a ticket to build a validation dashboard', ownerSub, chatOnly,
    }) };
}

describe('PM precreated task owner issuer provenance', () => {
  it('stamps the persisted task and ticket while preserving real linkage and canonical project metadata', async () => {
    const fixture = canonicalIntakeFixture();
    const exactOwner = ` ${OWNER} `;
    const result = await runWithRequestIdentity({ sub: exactOwner, principalIssuer: ISSUER, isOperator: false },
      () => fixture.intake(exactOwner));
    if (!result.ticketId) throw new Error('PM intake did not create its canonical ticket');
    const task = await fixture.taskStore.get(result.taskId);
    const ticket = await fixture.ticketService.getTicket(result.ticketId);
    expect(result).toMatchObject({ ticketCreated: true, ticketStatus: 'approved', source: 'swarmbot-ticket-intake' });
    expect(task).toMatchObject({ taskId: result.taskId, ownerSub: exactOwner,
      metadata: { source: 'project-manager-ticket-intake', ticketId: result.ticketId,
        requestedTaskId: 'requested-pm-conversation', queueId: DEFAULT_PROJECT_ID, queueName: DEFAULT_PROJECT_NAME,
        [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER } });
    expect(ticket).toMatchObject({ ownerSub: exactOwner, metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER } });
    expect((await fixture.ticketStore.getTicketLinksForTask(result.taskId)).map(link => link.ticketId)).toEqual([result.ticketId]);
  });

  it('stamps each new PM task with its actual issuer even when the subject text is shared', async () => {
    const fixture = canonicalIntakeFixture();
    const ids: string[] = [];
    for (const issuer of [ISSUER, 'https://other.pm.fixture.test']) {
      const result = await runWithRequestIdentity({ sub: OWNER, principalIssuer: issuer, isOperator: false },
        () => fixture.intake(OWNER));
      ids.push(result.taskId);
      expect(readOwnerPrincipalIssuer((await fixture.taskStore.get(result.taskId))?.metadata)).toBe(issuer);
    }
    expect(new Set(ids).size).toBe(2);
  });

  it.each([
    { sub: 'auth0|other', principalIssuer: ISSUER },
    { sub: OWNER, principalIssuer: null },
  ])('does not stamp an unverified owner binding %#', async (identity) => {
    const fixture = canonicalIntakeFixture();
    const result = await runWithRequestIdentity({ ...identity, isOperator: false }, () => fixture.intake(OWNER));
    const task = await fixture.taskStore.get(result.taskId);
    expect(task?.ownerSub).toBe(OWNER);
    expect(readOwnerPrincipalIssuer(task?.metadata)).toBeNull();
    expect(task?.metadata).toMatchObject({ source: 'project-manager-ticket-intake', ticketId: result.ticketId,
      requestedTaskId: 'requested-pm-conversation', queueId: DEFAULT_PROJECT_ID, queueName: DEFAULT_PROJECT_NAME });
    expect(task?.metadata).not.toHaveProperty(OWNER_PRINCIPAL_ISSUER_METADATA_KEY);
  });

  it('does not invent provenance on a system-created PM task', async () => {
    const fixture = canonicalIntakeFixture();
    const result = await runWithSystemIdentity(() => fixture.intake(OWNER));
    expect(readOwnerPrincipalIssuer((await fixture.taskStore.get(result.taskId))?.metadata)).toBeNull();
  });

  it('keeps guest chatOnly intake from creating a ticket or precreated PM task', async () => {
    const fixture = canonicalIntakeFixture();
    const sub = 'guest-pm-stamp-fixture';
    const result = await runWithRequestIdentity({ sub, principalIssuer: GUEST_PRINCIPAL_ISSUER, isOperator: false },
      () => fixture.intake(sub, true));
    expect(result).toEqual({ taskId: 'requested-pm-conversation', ticketCreated: false, source: 'swarmbot-chat' });
    expect(await fixture.taskStore.list()).toEqual([]);
    expect(await fixture.ticketService.listTickets()).toEqual([]);
  });
});
