/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify real PostgreSQL/canonical ticket and result authority/current-policy completion notices remain fixed and separate from private admission; create genuine foreign-principal ticket negatives and a readable ordinary completion through maintained service contracts, with deterministic stale-summary claim and recovery witnesses.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Keep actual operation observers through a partial logger mock without changing any protected Jarvis boundary assertion.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createProtectedJarvisFixture } from '../fixtures/protected-jarvis-results';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { RESULT_AGENT, RESULT_ISSUER } from '../fixtures/protected-results';
import { JARVIS_COMPLETION_NOTICE } from '@/app/routes/jarvis-completion-notice';
import { claimJarvisSummary, finishTask, saveTaskPending } from '@/app/routes/jarvis-task-store';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { configureProtectedResultAccess, PROTECTED_RESULT_EXECUTIONS } from '@/shared/protected-results';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { JARVIS_AGENT_ID, maskPendingComplexSummaries } from '@/app/routes/jarvis-orchestrator';

const execute = vi.hoisted(() => vi.fn(async () => ({ response: 'Ordinary fixture summary' })));
vi.mock('@/shared/logger', async importOriginal => ({
  ...await importOriginal<typeof import('@/shared/logger')>(),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));
vi.mock('@/app/routes/inline-bot-execution', async importOriginal => ({ ...await importOriginal<object>(), executeBotOrInline: execute }));
vi.mock('@/app/routes/user-brain-resolution', async importOriginal => ({ ...await importOriginal<object>(),
  resolveUserBrain: async () => ({ kind: 'hosted', connection: { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', model: 'fixture-model' } }) }));
vi.mock('@/features/user-model', async importOriginal => ({ ...await importOriginal<object>(),
  withHavenContext: async (_pool: unknown, _sub: string, message: string) => message, learnFromExchange: async () => {} }));

const WORK = 'notice-work-row', SESSION = 'notice-owner-session';
const database = new DisposableAlertPostgres();
let f: Awaited<ReturnType<typeof createProtectedJarvisFixture>>, ticketId: string;
beforeAll(async () => { await database.start(); }, 40_000);
afterAll(async () => { await database.stop(); }, 40_000);
beforeEach(async () => {
  vi.stubEnv('OSHAL_NO_AI', 'false');
  f = await createProtectedJarvisFixture(database);
  f.actors.pat = { ...f.actors.alice, issuer: '' };
  ticketId = await seedWork();
});
afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

/** @description Seed genuine completed owner-stamped source and PostgreSQL shelf, poisoning every private projection field.
 * @returns Actual canonical generated UUID; no execution grant or result is fabricated.
 */
async function seedWork(): Promise<string> {
  const actor = f.actors.alice, ticket = await f.seedCompletedTicket();
  await f.tasks.create({ taskId: ticket.ticketId, agentId: RESULT_AGENT, title: 'PRIVATE SOURCE TITLE', processingMode: 'direct',
    ownerSub: actor.sub, metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: actor.issuer } });
  await runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, async () => {
    expect(await saveTaskPending(f.pool, WORK, actor.sub, SESSION, 'PRIVATE SHELF TITLE', 'complex', ticket.ticketId)).toBe(true);
  });
  await f.pool.query("UPDATE jarvis_tasks SET status='done',error='PRIVATE ERROR',visual=$2,files=$3 WHERE id=$1",
    [WORK, JSON.stringify({ private: 'PRIVATE VISUAL' }), JSON.stringify([{ name: 'PRIVATE FILE' }])]);
  return ticket.ticketId;
}

/** @description Read real mounted shelf response, retaining its ordinary 200 envelope. */
async function poll(user = 'alice'): Promise<Array<Record<string, unknown>>> {
  const response = await f.call('/tasks', user); expect(response.status).toBe(200);
  return (await response.json() as { tasks: Array<Record<string, unknown>> }).tasks;
}

/** @description Read exact durable work claim state, without interpreting absence as success. */
async function row() {
  return (await f.pool.query<{ status: string; result: string | null }>('SELECT status,result FROM jarvis_tasks WHERE id=$1', [WORK])).rows[0];
}

/** @description Assert complete refusal before any new carrier, model, claim or thread write. */
async function noNotice(user = 'alice'): Promise<void> {
  expect(await poll(user)).toEqual([]);
  expect(await row()).toEqual({ status: 'done', result: null });
  expect(await f.tasks.get(SESSION)).toBeNull();
  expect(await f.messages.getByTask(SESSION)).toEqual([]);
  expect(execute).not.toHaveBeenCalled();
}

/** @description Canonically replace source metadata to reproduce malformed, lost-lineage or ownership failures. */
async function sourceMetadata(metadata: Record<string, unknown>): Promise<void> {
  const source = await f.tasks.get(ticketId);
  if (!source) throw new Error('Missing prepared fixture source');
  await f.tasks.replace({ ...source, metadata });
}

/** @description Bind the caller-owned shelf/source to a genuine completed foreign-principal ticket, preserving its immutable authority.
 * @param user Canonical fixture creator. @returns Resolves after exact ticket preconditions and durable source rebinding.
 */
async function foreignTicket(user: 'bob' | 'twin'): Promise<void> {
  const ticket = await f.seedCompletedTicket(user), caller = f.actors.alice, owner = f.actors[user];
  const stored = await f.tickets.getTicket(ticket.ticketId);
  expect(stored?.ownerSub).toBe(owner.sub);
  expect(stored?.metadata[OWNER_PRINCIPAL_ISSUER_METADATA_KEY]).toBe(owner.issuer);
  await f.tasks.create({ taskId: ticket.ticketId, agentId: RESULT_AGENT, title: 'PRIVATE SOURCE TITLE', processingMode: 'direct',
    ownerSub: caller.sub, metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: caller.issuer } });
  await f.pool.query('UPDATE jarvis_tasks SET ticket_id=$2 WHERE id=$1', [WORK, ticket.ticketId]);
  ticketId = ticket.ticketId;
}

it('returns only a fixed notice once across concurrent owner polls while the real ticket result remains refused', async () => {
  const responses = await Promise.all([poll(), poll(), poll()]);
  const expected = { id: WORK, title: 'Task completed', status: 'done', kind: 'complex', result: JARVIS_COMPLETION_NOTICE, delivered: false };
  expect(responses.flat()).toContainEqual(expected);
  expect(await poll()).toEqual([expected]); expect(await poll()).toEqual([expected]);
  expect(JSON.stringify(responses)).not.toContain('PRIVATE');
  const turns = await f.messages.getByTask(SESSION);
  expect(turns.map(turn => turn.text)).toEqual([JARVIS_COMPLETION_NOTICE]);
  expect(execute).not.toHaveBeenCalled();
  const ticket = await fetch(f.base + '/api/tickets/' + ticketId, { headers: { 'x-fixture-user': 'alice' } });
  expect(ticket.status).toBe(404);
  expect(JSON.stringify(await ticket.json())).not.toContain('PRIVATE');
  const delivered = await f.call('/tasks/' + WORK + '/delivered', 'alice', {});
  expect(delivered.status).toBe(200); expect(await delivered.json()).toEqual({ ok: true });
  expect(await poll()).toEqual([{ ...expected, delivered: true }]);
  expect((await f.messages.getByTask(SESSION)).map(turn => turn.text)).toEqual([JARVIS_COMPLETION_NOTICE]);
});

it.each(['bob', 'twin', 'admin', 'guest', 'pat', 'cli', 'delegated'])('withholds status notice and writes from the %s fixture rail', async user => {
  await noNotice(user);
  if (user === 'delegated') expect(f.rails.delegated).toBe(1);
});

it('refuses a currently inactive exact owner before creating a conversation', async () => {
  f.actors.alice.isActive = false; await noNotice();
});

it('refuses revoked current bot rights before the first notice', async () => {
  await f.change('alice', 'revoke'); await noNotice();
});

it('withholds a persisted notice after current bot revocation without reposting or projecting stored private fields', async () => {
  expect(await poll()).toHaveLength(1); await f.change('alice', 'revoke');
  expect(await poll()).toEqual([]);
  expect((await f.messages.getByTask(SESSION)).map(message => message.text)).toEqual([JARVIS_COMPLETION_NOTICE]);
  expect(execute).not.toHaveBeenCalled();
});

it.each([[], null, ['bad value'], ['duplicate', 'duplicate']])('never turns malformed declared execution lineage %j into a notice', async malformed => {
  await sourceMetadata({ [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: RESULT_ISSUER, [PROTECTED_RESULT_EXECUTIONS]: malformed });
  await noNotice();
});

it('withholds durable results with lost metadata instead of entering the old unbindable notice fallback', async () => {
  await f.complete(ticketId); expect(await f.authority.hasTaskResults(ticketId)).toBe(true);
  await noNotice();
});

it('does not infer a known empty result from an unconfigured result authority', async () => {
  configureProtectedResultAccess(undefined); await noNotice();
});

it('does not infer a known empty result from a durable authority storage fault', async () => {
  vi.spyOn(f.authority, 'hasTaskResults').mockRejectedValue(new Error('Isolated result store unavailable'));
  await noNotice();
});

it.each(['ticket', 'task', 'policy', 'shelf'])('withholds the notice when %s storage or authority cannot answer', async fault => {
  if (fault === 'ticket') vi.spyOn(f.tickets, 'getTicket').mockRejectedValue(new Error('Isolated ticket read fault'));
  if (fault === 'task') {
    const get = f.tasks.get.bind(f.tasks);
    vi.spyOn(f.tasks, 'get').mockImplementation(id => id === ticketId ? Promise.reject(new Error('Isolated task read fault')) : get(id));
  }
  if (fault === 'policy') vi.spyOn(f.ctx.applicationAuthorization!, 'authorize').mockRejectedValue(new Error('Isolated policy read fault'));
  if (fault === 'shelf') vi.spyOn(f.pool, 'query').mockRejectedValueOnce(new Error('Isolated shelf read fault'));
  await noNotice();
});

it.each(['runtime', 'owner', 'snapshot'])('refuses missing current %s authority without a permissive notice fallback', async missing => {
  if (missing === 'runtime') f.ctx.applicationAuthorization = undefined;
  else if (missing === 'owner') vi.spyOn(f.ctx.applicationAuthorization!, 'owner').mockReturnValue(undefined);
  else vi.spyOn(f.ctx.applicationAuthorization!, 'snapshot').mockReturnValue(null);
  await noNotice();
});

it('refuses a changed installed policy generation after its initial decision', async () => {
  const runtime = f.ctx.applicationAuthorization!, original = runtime.snapshot.bind(runtime);
  let reads = 0;
  vi.spyOn(runtime, 'snapshot').mockImplementation(app => {
    const snapshot = original(app);
    return snapshot && { ...snapshot, generation: ++reads === 1 ? snapshot.generation : 'changed-generation' };
  });
  await noNotice();
});

it('refuses a grant revoked during the current bot decision before session creation', async () => {
  const runtime = f.ctx.applicationAuthorization!, authorize = runtime.authorize.bind(runtime);
  let first = true;
  vi.spyOn(runtime, 'authorize').mockImplementation(async (actor, operation) => {
    const decision = await authorize(actor, operation);
    if (first) { first = false; await f.change('alice', 'revoke'); }
    return decision;
  });
  await noNotice();
});

it.each(['ticket', 'task', 'shelf'])('requires the %s issuer to match the current exact principal', async target => {
  if (target === 'ticket') await foreignTicket('twin');
  if (target === 'task') await sourceMetadata({ [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://other.fixture.test' });
  if (target === 'shelf') await f.pool.query('UPDATE jarvis_tasks SET principal_issuer=$2 WHERE id=$1', [WORK, 'https://other.fixture.test']);
  await noNotice();
});

it.each(['ticket', 'task'])('requires the actual %s owner rather than an operator or same-issuer override', async target => {
  if (target === 'ticket') await foreignTicket('bob');
  else {
    const source = await f.tasks.get(ticketId);
    if (!source) throw new Error('Missing prepared source');
    await f.tasks.replace({ ...source, ownerSub: 'bob' });
  }
  await noNotice();
});

it('requires the actual canonical ticket to be completed before issuing the completion sentence', async () => {
  await f.tickets.updateStatus(ticketId, 'backlog'); await noNotice();
});

it('refuses a missing actual source task without synthesizing ownership or opening a conversation', async () => {
  await f.tickets.updateTicket(ticketId, { assignedAgentId: RESULT_AGENT });
  await f.tasks.delete(ticketId); await noNotice();
});

it('refuses a missing canonical ticket without creating a replacement', async () => {
  await f.tickets.deleteTicket(ticketId); await noNotice();
});

it('refuses an existing foreign conversation before writing a status notice', async () => {
  await f.tasks.create({ taskId: SESSION, agentId: JARVIS_AGENT_ID, title: 'Foreign', processingMode: 'agentic', ownerSub: 'bob',
    metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: RESULT_ISSUER } });
  expect(await poll()).toEqual([]); expect((await row()).result).toBeNull();
  expect(await f.messages.getByTask(SESSION)).toEqual([]); expect(execute).not.toHaveBeenCalled();
});

it('refuses an unstamped existing conversation instead of assigning the requesting issuer to it', async () => {
  await f.tasks.create({ taskId: SESSION, agentId: JARVIS_AGENT_ID, title: 'Legacy', processingMode: 'agentic', ownerSub: 'alice', metadata: {} });
  expect(await poll()).toEqual([]); expect((await row()).result).toBeNull();
  expect(await f.messages.getByTask(SESSION)).toEqual([]); expect(execute).not.toHaveBeenCalled();
});

it('rechecks the actual foreign winner of a session creation race instead of appending to it', async () => {
  const create = f.tasks.create.bind(f.tasks);
  vi.spyOn(f.tasks, 'create').mockImplementation(async input => {
    if (input.taskId === SESSION) await create({ ...input, ownerSub: 'bob' });
    return create(input);
  });
  expect(await poll()).toEqual([]); expect((await row()).result).toBeNull();
  expect((await f.tasks.get(SESSION))?.ownerSub).toBe('bob');
  expect(await f.messages.getByTask(SESSION)).toEqual([]); expect(execute).not.toHaveBeenCalled();
});

it('never projects or overwrites an arbitrary private cached result in the notice path', async () => {
  await f.pool.query('UPDATE jarvis_tasks SET result=$2 WHERE id=$1', [WORK, 'PRIVATE CACHED RESULT']);
  expect(await poll()).toEqual([]); expect((await row()).result).toBe('PRIVATE CACHED RESULT');
  expect(await f.tasks.get(SESSION)).toBeNull(); expect(execute).not.toHaveBeenCalled();
});

it('withholds the new notice response on an actual message save fault and retains the partial claim truthfully', async () => {
  vi.spyOn(f.messages, 'save').mockRejectedValue(new Error('Isolated message persistence fault'));
  expect(await poll()).toEqual([]); expect((await row()).result).toBe(JARVIS_COMPLETION_NOTICE);
  expect(await f.messages.getByTask(SESSION)).toEqual([]); expect(execute).not.toHaveBeenCalled();
  expect(await poll()).toEqual([]); expect((await row()).result).toBe(JARVIS_COMPLETION_NOTICE);
  expect(f.messages.save).toHaveBeenCalledTimes(1);
  expect(await f.messages.getByTask(SESSION)).toEqual([]); expect(execute).not.toHaveBeenCalled();
});

it('preserves positively known unprotected work on the ordinary summary path', async () => {
  const source = await f.tasks.get(ticketId);
  if (!source) throw new Error('Missing prepared ordinary source');
  await f.tasks.replace({ ...source, agentId: 'unit-platform-agent' });
  await f.pool.query('UPDATE jarvis_tasks SET error=NULL WHERE id=$1', [WORK]);
  await f.messages.save({ taskId: ticketId, role: 'assistant', type: 'completion', text: 'Ordinary fixture work product with enough readable detail.', contentBlocks: [], metadata: {} });
  await poll();
  await vi.waitFor(async () => expect((await poll()).find(task => task.id === WORK)?.result).toBe('Ordinary fixture summary'), { timeout: 10_000 });
  expect(execute).toHaveBeenCalledTimes(1);
  expect((await row()).result).not.toBe(JARVIS_COMPLETION_NOTICE);
});

it('refuses a stale shelf snapshot after the actual durable summary has landed', async () => {
  const before = await row(); expect(before).toEqual({ status: 'done', result: null });
  const stale = [{ id: WORK, title: 'Fixture work', status: before.status, result: before.result, kind: 'complex', ticketId }];
  await finishTask(f.pool, WORK, true, 'Already persisted fixture summary');
  expect(await row()).toEqual({ status: 'done', result: 'Already persisted fixture summary' });
  const fire = vi.fn(async () => {});
  await maskPendingComplexSummaries(f.ctx, f.actors.alice.sub, stale, fire);
  expect(fire).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  expect(await row()).toEqual({ status: 'done', result: 'Already persisted fixture summary' });
});

it('claims an initial empty summary once for its actual owner and rejects a foreign owner', async () => {
  expect(await claimJarvisSummary(f.pool, WORK, f.actors.bob.sub)).toBe(false);
  expect(await row()).toEqual({ status: 'done', result: null });
  const pending = () => [{ id: WORK, title: 'Fixture work', status: 'done', result: null, kind: 'complex', ticketId }];
  const fire = vi.fn(async () => {});
  await maskPendingComplexSummaries(f.ctx, f.actors.alice.sub, pending(), fire);
  await maskPendingComplexSummaries(f.ctx, f.actors.alice.sub, pending(), fire);
  expect(fire).toHaveBeenCalledTimes(1);
  expect(fire).toHaveBeenCalledWith(f.ctx, f.actors.alice.sub, WORK, ticketId, 'Fixture work');
  expect(await row()).toEqual({ status: 'summarizing', result: null }); expect(execute).not.toHaveBeenCalled();
});

it('reclaims an expired empty summary once while retaining the fresh three-minute claim', async () => {
  await f.pool.query("UPDATE jarvis_tasks SET status='summarizing',result='',summarize_started_at=NOW()-INTERVAL '4 minutes' WHERE id=$1", [WORK]);
  expect(await row()).toEqual({ status: 'summarizing', result: '' });
  const pending = () => [{ id: WORK, title: 'Fixture work', status: 'done', result: '', kind: 'complex', ticketId }];
  const fire = vi.fn(async () => {});
  await maskPendingComplexSummaries(f.ctx, f.actors.alice.sub, pending(), fire);
  await maskPendingComplexSummaries(f.ctx, f.actors.alice.sub, pending(), fire);
  expect(fire).toHaveBeenCalledTimes(1);
  expect(fire).toHaveBeenCalledWith(f.ctx, f.actors.alice.sub, WORK, ticketId, 'Fixture work');
  expect(await row()).toEqual({ status: 'summarizing', result: '' }); expect(execute).not.toHaveBeenCalled();
});
