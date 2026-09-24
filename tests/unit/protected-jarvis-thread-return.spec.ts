/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove a SUCCESSFUL protected ticket returns its answer to the owner's Jarvis thread exactly once, with recorded lineage, and to nobody else. Crosses both boundaries the defect spans: isolated real PostgreSQL for the durable shelf and conversation, and the real ApplicationRemoteExecutionService installed through configureProtectedResultAccess for the authorization decision. Only the model rail is doubled - no boundary this file makes a claim about is mocked.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove a protected-classified task with no bindable executions returns either an answer (unprotected work product) or a stated sentence (protected work product) to the owner's thread, while an unverified reader produces nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createProtectedJarvisFixture } from '../fixtures/protected-jarvis-results';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { RESULT_AGENT } from '../fixtures/protected-results';
import { persistProtectedResultTask } from '@/app/routes/protected-result-persistence';
import { saveTaskPending } from '@/app/routes/jarvis-task-store';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';

const SUMMARY = 'PRIVATE TRADING SUMMARY 42';
const WORK_PRODUCT = 'PRIVATE WORK PRODUCT: the book closed the session ahead, carried by the core sleeve.';
const WORK_ID = 'protected-work-row';
const TICKET_ID = 'protected-return-ticket';
const SESSION_ID = 'protected-return-thread';

const execute = vi.hoisted(() => vi.fn(async () => ({ response: SUMMARY })));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));
// The model rail only. The authorization authority, the execution store, the task store, the durable
// shelf and the conversation are all real here, because those are the boundaries under test.
vi.mock('@/app/routes/inline-bot-execution', async importOriginal => ({ ...await importOriginal<object>(), executeBotOrInline: execute }));
vi.mock('@/app/routes/user-brain-resolution', async importOriginal => ({ ...await importOriginal<object>(),
  resolveUserBrain: async () => ({ kind: 'hosted', connection: { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', model: 'fixture-model' } }) }));
vi.mock('@/features/user-model', async importOriginal => ({ ...await importOriginal<object>(),
  withHavenContext: async (_pool: unknown, _sub: string, message: string) => message, learnFromExchange: async () => {} }));

let fixture: Awaited<ReturnType<typeof createProtectedJarvisFixture>>;
const database = new DisposableAlertPostgres();
beforeAll(async () => { await database.start(); }, 40_000);
afterAll(async () => { await database.stop(); }, 40_000);

beforeEach(async () => {
  vi.stubEnv('OSHAL_NO_AI', 'false');
  fixture = await createProtectedJarvisFixture(database);
  // A principal holding no verified issuer at all — the PAT-style shape the delegated-principal
  // comparison in specialist-context/index.ts exists to refuse.
  fixture.actors.pat = { sub: 'alice', issuer: '', isActive: true, isSwarmAdmin: false };
  const actor = fixture.actors.alice;
  // A protected ticket that SUCCEEDED: real signed execution lineage plus the worker's work product.
  const executionId = await fixture.complete(TICKET_ID);
  await persistProtectedResultTask(fixture.ctx, TICKET_ID, RESULT_AGENT, executionId, actor);
  await fixture.messages.save({ taskId: TICKET_ID, role: 'assistant', type: 'completion', text: WORK_PRODUCT,
    contentBlocks: [], metadata: { source: 'manifest-worker-bot-node', manifestWorkerResult: true } });
  await runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, async () => {
    expect(await saveTaskPending(fixture.pool as never, WORK_ID, actor.sub, SESSION_ID, 'How did we do in the stock market today?', 'complex', TICKET_ID)).toBe(true);
  });
  await fixture.pool.query("UPDATE jarvis_tasks SET status='done' WHERE id=$1", [WORK_ID]);
});
afterEach(async () => { await fixture?.close(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

const poll = async (user = 'alice') => (await (await fixture.call('/tasks', user)).json()).tasks as Array<{ id: string; status: string; result: string | null }>;
const thread = async (user = 'alice') => (await (await fixture.call('/history?sessionId=' + SESSION_ID, user)).json()).turns as Array<{ text: string }>;
const summarized = async (user = 'alice') => {
  await poll(user);
  await vi.waitFor(async () => expect((await poll(user)).find(task => task.id === WORK_ID)?.result).toContain(SUMMARY), { timeout: 10_000 });
};

it('returns a successful protected result to the owner thread exactly once, with lineage recorded', async () => {
  expect(await thread()).toEqual([]);
  await summarized();
  // The answer is in the conversation the operator asked in, not only on the shelf.
  expect((await thread()).filter(turn => turn.text.includes(SUMMARY))).toHaveLength(1);
  // Re-polling is what the surface actually does; the claim must not re-summarize or re-post.
  await poll(); await poll();
  expect((await thread()).filter(turn => turn.text.includes(SUMMARY))).toHaveLength(1);
  expect(execute).toHaveBeenCalledTimes(1);
  // The lineage the withheld comment asked for: the conversation and the durable work row now
  // answer to the same executions as the ticket they were derived from.
  for (const destination of [SESSION_ID, WORK_ID]) expect(await fixture.authority.hasTaskResults(destination)).toBe(true);
});

it('never returns the derived answer to a different subject, a different issuer or a revoked owner', async () => {
  await summarized();
  for (const user of ['bob', 'twin', 'admin']) {
    expect(await thread(user)).toEqual([]);
    expect(JSON.stringify(await poll(user))).not.toContain('PRIVATE');
  }
  await fixture.change('alice', 'revoke');
  expect(await thread()).toEqual([]);
  expect(JSON.stringify(await poll())).not.toContain('PRIVATE');
});

it('never derives or returns the answer for a principal carrying no verified issuer', async () => {
  // The PAT-shaped principal polls first: it must neither read the thread nor cause the summary.
  expect(await thread('pat')).toEqual([]);
  await poll('pat'); await poll('pat');
  expect(execute).not.toHaveBeenCalled();
  expect(await thread('pat')).toEqual([]);
  expect((await fixture.pool.query('SELECT status, result FROM jarvis_tasks WHERE id=$1', [WORK_ID])).rows[0]).toMatchObject({ status: 'done', result: null });
  expect(await fixture.authority.hasTaskResults(SESSION_ID)).toBe(false);
  // The owner still gets it, and the PAT principal still cannot read what the owner produced.
  await summarized();
  expect(await thread('pat')).toEqual([]);
  expect(JSON.stringify(await poll('pat'))).not.toContain('PRIVATE');
});

it('summarizes an unprotected ticket to the thread when classified protected only by its session', async () => {
  const actor = fixture.actors.alice;
  const unprotectedWorkId = 'unbound-unprotected-work';
  const unprotectedTicketId = 'unbound-unprotected-ticket';
  const deliverable = 'Deliverable from an unprotected team ticket.';
  await fixture.messages.save({
    taskId: unprotectedTicketId, role: 'assistant', type: 'completion', text: deliverable,
    contentBlocks: [], metadata: { source: 'manifest-worker-bot-node', manifestWorkerResult: true },
  });
  await runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, async () => {
    expect(await saveTaskPending(fixture.pool as never, unprotectedWorkId, actor.sub, SESSION_ID, 'General team task', 'complex', unprotectedTicketId)).toBe(true);
  });
  await fixture.pool.query("UPDATE jarvis_tasks SET status='done' WHERE id=$1", [unprotectedWorkId]);

  // PAT-shaped principal polls first: unauthorized reader must neither receive summary nor see work
  expect(await thread('pat')).toEqual([]);
  await poll('pat');
  expect((await fixture.pool.query('SELECT status, result FROM jarvis_tasks WHERE id=$1', [unprotectedWorkId])).rows[0]).toMatchObject({ status: 'done', result: null });
  expect(await thread('pat')).toEqual([]);

  // Owner polls: since work product is unprotected, automatic summarizer runs and returns answer to thread
  await poll();
  await vi.waitFor(async () => expect((await poll()).find(task => task.id === unprotectedWorkId)?.result).toContain(SUMMARY), { timeout: 10_000 });
  expect((await thread()).some(turn => turn.text.includes(SUMMARY))).toBe(true);
  expect(await thread('pat')).toEqual([]);
});

it('writes an honest stated sentence to the thread when a protected ticket has no executions to bind', async () => {
  const actor = fixture.actors.alice;
  const noExecWorkId = 'no-exec-work-row';
  const noExecTicketId = 'no-exec-ticket-row';
  await fixture.ctx.taskStore.create({
    taskId: noExecTicketId,
    agentId: RESULT_AGENT,
    title: 'Protected task with no executions',
    processingMode: 'direct',
    ownerSub: actor.sub,
    metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: actor.issuer },
  });
  await runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, async () => {
    expect(await saveTaskPending(fixture.pool as never, noExecWorkId, actor.sub, SESSION_ID, 'Protected query with no executions', 'complex', noExecTicketId)).toBe(true);
  });
  await fixture.pool.query("UPDATE jarvis_tasks SET status='done' WHERE id=$1", [noExecWorkId]);

  // PAT-shaped principal polls first: unauthorized reader must neither cause sentence write nor see thread
  expect(await thread('pat')).toEqual([]);
  await poll('pat');
  expect((await fixture.pool.query('SELECT status, result FROM jarvis_tasks WHERE id=$1', [noExecWorkId])).rows[0]).toMatchObject({ status: 'done', result: null });
  expect(await thread('pat')).toEqual([]);

  // Owner polls: unbindable protected ticket produces the honest stated sentence in thread and on shelf
  const tasks = await poll();
  const found = tasks.find(t => t.id === noExecWorkId);
  expect(found?.status).toBe('done');
  expect(found?.result).toContain('carries no verifiable execution lineage');
  expect((await thread()).some(turn => turn.text.includes('carries no verifiable execution lineage'))).toBe(true);
  expect(await thread('pat')).toEqual([]);
});

