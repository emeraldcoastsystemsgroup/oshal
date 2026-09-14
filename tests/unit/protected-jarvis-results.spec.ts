/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify exact principal and current rights for real Jarvis caches, history and durable shelf with signed result capture.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createProtectedJarvisFixture } from '../fixtures/protected-jarvis-results';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { captureRemoteExecutionResult } from '@/shared/remote-execution-results';
import { PROTECTED_RESULT_EXECUTIONS } from '@/shared/protected-results';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { buildOpenWorkBlock, finishTask, saveTaskPending } from '@/app/routes/jarvis-task-store';
import { VisualResponseService } from '@/features/visual-response';

const bot = vi.hoisted(() => vi.fn());
const automatic = vi.hoisted(() => ({ summaries: vi.fn(async () => {}), visuals: vi.fn(async () => {}) }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));
vi.mock('@/app/routes/jarvis-orchestrator', async importOriginal => ({ ...await importOriginal<object>(),
  runJarvisBot: bot, buildCatalogBlock: async () => '', loadEffectiveRoutes: async () => [],
  maskPendingComplexSummaries: automatic.summaries, repairCompletedTaskTableVisuals: automatic.visuals }));
let fixture: Awaited<ReturnType<typeof createProtectedJarvisFixture>>;
const database = new DisposableAlertPostgres();
beforeAll(async () => { await database.start(); }, 40_000);
afterAll(async () => { await database.stop(); }, 40_000);
beforeEach(async () => {
  vi.stubEnv('OSHAL_NO_AI', 'false'); fixture = await createProtectedJarvisFixture(database);
  bot.mockImplementation(async () => {
    const executionId = await fixture.complete('signed-specialist-child');
    await captureRemoteExecutionResult(fixture.authority, executionId, fixture.actors.alice);
    return { answer: 'PRIVATE SPECIALIST RESULT 42' };
  });
});
afterEach(async () => { await fixture?.close(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

async function ask() {
  const response = await fixture.call('/ask', 'alice', { message: 'Read my permitted fixture record', sessionId: 'exact-conversation' });
  expect(response.status).toBe(202);
  const { jobId } = await response.json();
  await vi.waitFor(async () => expect((await (await fixture.call('/ask/result?jobId=' + jobId)).json()).status).toBe('done'));
  return jobId as string;
}

it('captures signed child lineage before real Jarvis cache and history responses', async () => {
  const jobId = await ask();
  expect((await fixture.tasks.get('exact-conversation'))?.metadata[PROTECTED_RESULT_EXECUTIONS]).toHaveLength(1);
  expect(await fixture.authority.hasTaskResults('exact-conversation')).toBe(true);
  expect(await (await fixture.call('/ask/result?jobId=' + jobId)).text()).toContain('PRIVATE SPECIALIST RESULT 42');
  expect(await (await fixture.call('/history?sessionId=exact-conversation')).text()).toContain('PRIVATE SPECIALIST RESULT 42');
});

it('withholds completed cached and historical answers from foreign issuer, administrator and revoked owner', async () => {
  const jobId = await ask(); await fixture.change('twin'); await fixture.change('admin');
  for (const user of ['twin', 'admin', 'bob']) {
    expect(await (await fixture.call('/ask/result?jobId=' + jobId, user)).json()).toEqual({ status: 'expired' });
    expect(await (await fixture.call('/history?sessionId=exact-conversation', user)).json()).toEqual({ turns: [] });
  }
  await fixture.change('alice', 'revoke');
  expect(await (await fixture.call('/ask/result?jobId=' + jobId)).json()).toEqual({ status: 'expired' });
  expect(await (await fixture.call('/history?sessionId=exact-conversation')).json()).toEqual({ turns: [] });
});

it('guards durable shelf and delivery while withholding protected results from automatic new prompts', async () => {
  await ask(); const actor = fixture.actors.alice;
  await runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, async () => {
    expect(await saveTaskPending(fixture.pool as never, 'durable-result', actor.sub, 'exact-conversation', 'Protected fixture')).toBe(true);
    await finishTask(fixture.pool as never, 'durable-result', true, 'PRIVATE SPECIALIST RESULT 42');
    expect(await saveTaskPending(fixture.pool as never, 'ordinary-result', actor.sub, 'ordinary-session', 'Ordinary task')).toBe(true);
    await finishTask(fixture.pool as never, 'ordinary-result', true, 'ORDINARY ANSWER');
  });
  expect(await (await fixture.call('/tasks')).text()).toContain('PRIVATE SPECIALIST RESULT 42');
  expect(automatic.summaries.mock.calls.at(-1)?.[2].map((row: { id: string }) => row.id)).toEqual(['ordinary-result']);
  expect(automatic.visuals.mock.calls.at(-1)?.[3].map((row: { id: string }) => row.id)).toEqual(['ordinary-result']);
  const block = await runWithApplicationAuthorizationActor(actor, () => buildOpenWorkBlock(fixture.ctx, actor.sub));
  expect(block).not.toContain('PRIVATE'); expect(block).toContain('ORDINARY ANSWER');
  await fixture.change('alice', 'revoke');
  expect(await (await fixture.call('/tasks')).text()).not.toContain('PRIVATE');
  expect(await (await fixture.call('/tasks/durable-result/delivered', 'alice', {})).json()).toEqual({ ok: false });
  expect((await fixture.pool.query("SELECT delivered FROM jarvis_tasks WHERE id='durable-result'")).rows[0].delivered).toBe(false);
});

it('refuses reuse of unqualified legacy sessions and cross-issuer durable task replacement', async () => {
  await fixture.tasks.create({ taskId: 'legacy-conversation', ownerSub: 'alice', agentId: 'jarvis' });
  expect((await fixture.call('/ask', 'alice', { message: 'Hello fixture', sessionId: 'legacy-conversation' })).status).toBe(404);
  const save = (user: string) => runWithRequestIdentity({ sub: 'alice', principalIssuer: fixture.actors[user].issuer, isOperator: false },
    () => saveTaskPending(fixture.pool as never, 'same-row', 'alice', 'same-session', user));
  expect(await save('alice')).toBe(true); expect(await save('twin')).toBe(false);
  expect((await fixture.pool.query("SELECT title FROM jarvis_tasks WHERE id='same-row'")).rows[0].title).toBe('alice');
  expect(bot).not.toHaveBeenCalled();
});

it('rechecks protected visual source rights before returning persisted SVG bytes', async () => {
  await ask();
  const service = new VisualResponseService(fixture.pool);
  const artifact = await service.createArtifact('alice', { factLocked: true, sourceSurface: 'fixture',
    sourceSessionId: 'exact-conversation', sourceJobId: 'protected-visual', request: 'Show result', answer: 'PRIVATE COUNT 42',
    visualSpec: { schemaVersion: 1, kind: 'timeline', title: 'PRIVATE COUNT 42', sourceRefs: [],
      items: [{ label: 'Now', title: 'PRIVATE COUNT 42' }, { label: 'Next', title: 'Review' }] } });
  expect(await (await fixture.call('/visuals/' + artifact.artifactId)).text()).toContain('PRIVATE COUNT 42');
  expect((await fixture.call('/visuals/' + artifact.artifactId, 'twin')).status).toBe(404);
  await fixture.change('alice', 'revoke');
  const response = await fixture.call('/visuals/' + artifact.artifactId);
  expect(response.status).toBe(404); expect(await response.text()).not.toContain('PRIVATE COUNT 42');
});
