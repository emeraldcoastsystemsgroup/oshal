/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard trusted ticket-owner issuer stamping, spoof stripping, system inheritance, and legacy absence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove new ordinary task stamps through real public orchestration and isolated stores, including exact identity, guest/system absence and unchanged existing metadata.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Supply canonical creation-schema defaults to fixture inputs without changing ownership assertions.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  OWNER_PRINCIPAL_ISSUER_METADATA_KEY,
  bindOwnerPrincipalIssuer,
  readOwnerPrincipalIssuer,
} from '@/shared/security/owner-principal-issuer';
import {
  runWithRequestIdentity,
  runWithSystemIdentity,
  type RequestIdentity,
} from '@/shared/services/database/request-identity';
import { TicketService } from '@/features/ticketing';
import { CreateInternalTicketSchema, type ITicketStore } from '@/entities/ticket';
import { InMemoryTaskStore } from '@/entities/task';
import { InMemoryMessageStore } from '@/entities/message';
import { TaskOrchestrator } from '@/features/chat-orchestration';
import { NoopProvider } from '@/features/llm-provider';
import { StreamManager } from '@/features/streaming';
import { GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';

// Only the optional external database is removed; the creator, binder, stores and turn path are real.
vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));

const OWNER = 'oidc|owner';
const ISSUER = 'https://identity.example.test/realms/main';

describe('ticket owner principal issuer provenance', () => {
  it('uses verified request identity and overwrites a forged metadata value', () => {
    const metadata = runWithRequestIdentity(
      { sub: OWNER, principalIssuer: ISSUER, isOperator: false },
      () => bindOwnerPrincipalIssuer({
        visible: true,
        [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://forged.example.test',
      }, OWNER),
    );
    expect(metadata).toEqual({
      visible: true,
      [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER,
    });
  });

  it('strips a supplied issuer when the request identity does not own the ticket', () => {
    const metadata = runWithRequestIdentity(
      { sub: 'oidc|other', principalIssuer: ISSUER, isOperator: false },
      () => bindOwnerPrincipalIssuer({
        [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://forged.example.test',
      }, OWNER),
    );
    expect(metadata).toEqual({});
  });

  it('allows only the positive system sentinel to preserve trusted persisted provenance', () => {
    const inherited = runWithSystemIdentity(() => bindOwnerPrincipalIssuer({
      [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER,
    }, OWNER));
    const absent = runWithSystemIdentity(() => bindOwnerPrincipalIssuer({}, OWNER));
    expect(readOwnerPrincipalIssuer(inherited)).toBe(ISSUER);
    expect(readOwnerPrincipalIssuer(absent)).toBeNull();
  });

  it('treats malformed or legacy metadata as issuer-less', () => {
    expect(readOwnerPrincipalIssuer({ [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: '' })).toBeNull();
    expect(readOwnerPrincipalIssuer(undefined)).toBeNull();
  });

  it('wires the trusted provenance through TicketService creation', async () => {
    const create = vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      ticketId: '11111111-1111-4111-8111-111111111111',
      ticketType: input.ticketType ?? 'build',
      description: input.description ?? '',
      stateGroup: 'backlog',
      executionPhase: null,
      priority: input.priority ?? 'none',
      labels: input.labels ?? [],
      workspaceId: null,
      assignedAgentId: null,
      parentTicketId: null,
      externalProvider: null,
      externalId: null,
      externalUrl: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    }));
    const service = new TicketService({ create } as unknown as ITicketStore);
    await runWithRequestIdentity(
      { sub: OWNER, principalIssuer: ISSUER, isOperator: false },
      () => service.createTicket(CreateInternalTicketSchema.parse({
        title: 'issuer-bound ticket',
        ownerSub: OWNER,
        metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://forged.example.test' },
      })),
    );
    expect(create.mock.calls[0][0].metadata).toMatchObject({
      [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER,
    });
  });
});

/**
 * @description Exercise the public ordinary turn path with real stores and the maintained no-op provider.
 * @returns Isolated stored rows and the real public creator; no network, database or tool is invoked.
 */
function ordinaryTaskFixture() {
  const tasks = new InMemoryTaskStore();
  const messages = new InMemoryMessageStore();
  const provider = new NoopProvider();
  const orchestrator = new TaskOrchestrator({
    taskStore: tasks,
    messageStore: messages,
    streamManager: new StreamManager(),
    getProvider: () => provider,
    getTools: async () => [],
    executeTool: async () => 'Unused by the direct no-op fixture',
    getSystemPrompt: async () => 'Isolated issuer-stamp fixture',
  });
  return { tasks, messages, turn: (taskId: string, ownerSub?: string) => orchestrator.processMessage(taskId, 'fixture hello', {
    agenticMode: false, autoApprove: false, source: 'test', agentId: 'ordinary-stamp-fixture-bot', userSub: ownerSub,
  }) };
}

const UNQUALIFIED_TASK_CASES: Array<{ label: string; identity: RequestIdentity | null; ownerSub?: string }> = [
  { label: 'another subject', identity: { sub: 'oidc|other', principalIssuer: ISSUER, isOperator: false }, ownerSub: OWNER },
  { label: 'missing verified issuer', identity: { sub: OWNER, principalIssuer: null, isOperator: false }, ownerSub: OWNER },
  { label: 'ownerless task', identity: { sub: OWNER, principalIssuer: ISSUER, isOperator: false } },
  { label: 'absent request identity', identity: null, ownerSub: OWNER },
];

describe('ordinary task creator owner principal provenance', () => {
  it('stamps the new stored task from matching verified identity without changing its identifiers', async () => {
    const fixture = ordinaryTaskFixture();
    const exactOwner = ` ${OWNER} `;
    const result = await runWithRequestIdentity({ sub: exactOwner, principalIssuer: ISSUER, isOperator: false },
      () => fixture.turn('ordinary-requested-id', exactOwner));
    expect(result.success).toBe(true);
    const task = await fixture.tasks.get('ordinary-requested-id');
    expect(task).toMatchObject({ taskId: 'ordinary-requested-id', ownerSub: exactOwner, agentId: 'ordinary-stamp-fixture-bot' });
    expect(task?.metadata).toEqual({ [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER });
    expect((await fixture.messages.getByTask('ordinary-requested-id')).map(row => row.role)).toEqual(['user', 'assistant']);
  });

  it('keeps two new tasks with the same subject bound to their actual different verified issuers', async () => {
    const fixture = ordinaryTaskFixture();
    for (const [taskId, issuer] of [['issuer-a-task', ISSUER], ['issuer-b-task', 'https://other.example.test']]) {
      expect((await runWithRequestIdentity({ sub: OWNER, principalIssuer: issuer, isOperator: false },
        () => fixture.turn(taskId, OWNER))).success).toBe(true);
      expect(readOwnerPrincipalIssuer((await fixture.tasks.get(taskId))?.metadata)).toBe(issuer);
    }
  });

  it.each(UNQUALIFIED_TASK_CASES)('does not invent an issuer for $label', async ({ identity, ownerSub }) => {
    const fixture = ordinaryTaskFixture();
    const turn = () => fixture.turn('unqualified-task', ownerSub);
    const result = identity ? await runWithRequestIdentity(identity, turn) : await turn();
    expect(result.success).toBe(true);
    const task = await fixture.tasks.get('unqualified-task');
    expect(task?.ownerSub).toBe(ownerSub);
    expect(task?.metadata).toEqual({});
  });

  it('retains the canonical guest issuer for a new guest-owned task', async () => {
    const fixture = ordinaryTaskFixture();
    const sub = 'guest-stamp-fixture';
    expect((await runWithRequestIdentity({ sub, principalIssuer: GUEST_PRINCIPAL_ISSUER, isOperator: false },
      () => fixture.turn('guest-task', sub))).success).toBe(true);
    expect((await fixture.tasks.get('guest-task'))?.metadata).toEqual({ [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: GUEST_PRINCIPAL_ISSUER });
  });

  it('does not invent owner issuer provenance from the positive system sentinel', async () => {
    const fixture = ordinaryTaskFixture();
    expect((await runWithSystemIdentity(() => fixture.turn('system-task', OWNER))).success).toBe(true);
    expect((await fixture.tasks.get('system-task'))?.metadata).toEqual({});
  });

  it.each(['stamped', 'legacy'])('never restamps existing %s task metadata', async (kind) => {
    const fixture = ordinaryTaskFixture();
    const metadata = { origin: 'existing fixture', nested: { keep: true },
      ...(kind === 'stamped' ? { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ISSUER } : {}) };
    await fixture.tasks.create({ taskId: 'existing-task', title: '', processingMode: 'agentic', ownerSub: OWNER, agentId: 'existing-bot', metadata });
    const before = structuredClone((await fixture.tasks.get('existing-task'))?.metadata);
    expect((await runWithRequestIdentity({ sub: OWNER, principalIssuer: 'https://new.example.test', isOperator: false },
      () => fixture.turn('existing-task', OWNER))).success).toBe(true);
    const task = await fixture.tasks.get('existing-task');
    expect(task).toMatchObject({ taskId: 'existing-task', ownerSub: OWNER, agentId: 'existing-bot' });
    expect(task?.metadata).toEqual(before);
  });
});
