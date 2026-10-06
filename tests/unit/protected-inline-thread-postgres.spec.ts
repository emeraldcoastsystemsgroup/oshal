/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard protected app concierge creation, genuine empty history, real inline reply and reconstructed PostgreSQL route reload. Prove exact issuer/owner, enforcing runtime role, live grant/dependency revocation, untracked-result denial and revocation during the provider turn. Only the model provider is doubled; no deployment database or provider is contacted.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove a real SSE subscription to the fresh protected thread stays open while the provider is pending, flushes only after durable completion and releases no revoked result.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProtectedInlinePostgresFixture, INLINE_AGENT, INLINE_APP, INLINE_DEPENDENCY,
  INLINE_ISSUER, INLINE_REPLY, INLINE_RUNTIME_ROLE, type ProtectedInlinePostgresFixture } from '../fixtures/protected-inline-postgres';
import { PROTECTED_RESULT_EXECUTIONS } from '@/shared/protected-results';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { executeBotOrInline } from '@/app/routes/inline-bot-execution';
import { ApprovalWorkflowService, APPROVAL_EVENTS } from '@/features/tool-approval/services/approval-workflow-service';

let fixture: ProtectedInlinePostgresFixture;
beforeAll(async () => { fixture = await createProtectedInlinePostgresFixture(); }, 120_000);
afterAll(async () => { if (fixture) await fixture.close(); }, 60_000);
beforeEach(async () => {
  fixture.actors.owner.isActive = true;
  await fixture.change('owner', 'grant', INLINE_APP);
  await fixture.change('owner', 'grant', INLINE_DEPENDENCY);
});

async function createThread(metadata: Record<string, unknown> = {}): Promise<string> {
  const response = await fixture.call('/api/tasks', 'owner', { title: 'Private fixture thread',
    agentId: INLINE_AGENT, processingMode: 'direct', metadata });
  expect(response.status).toBe(201);
  const task = await response.json();
  expect(task.ownerSub).toBe(fixture.actors.owner.sub);
  expect(task.metadata[OWNER_PRINCIPAL_ISSUER_METADATA_KEY]).toBe(INLINE_ISSUER);
  return task.taskId;
}

function sendTurn(taskId: string, user = 'owner') {
  return fixture.call(`/api/tasks/${taskId}/messages`, user, { text: 'Read my fixture record',
    agentId: INLINE_AGENT, agenticMode: false, chatOnly: true, interactionMode: 'chat' });
}

async function assertDenied(taskId: string, user = 'owner'): Promise<void> {
  for (const path of [`/api/tasks/${taskId}`, `/api/${taskId}/messages`]) {
    const response = await fixture.call(path, user);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(INLINE_REPLY);
  }
  const stream = await fixture.openStream(taskId, user);
  try { expect(stream.status).toBe(404); expect(stream.text()).not.toContain(INLINE_REPLY); }
  finally { stream.destroy(); }
}

async function answerThread(): Promise<string> {
  const id = await createThread(), response = await sendTurn(id);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, response: INLINE_REPLY });
  return id;
}

type InlineStream = Awaited<ReturnType<ProtectedInlinePostgresFixture['openStream']>>;
async function assertOnlyConnection(stream: InlineStream): Promise<void> {
  await new Promise<void>(done => setTimeout(done, 150));
  expect(stream.closed()).toBe(false);
  expect(stream.text()).toContain('Connected to streaming');
  expect(stream.text()).not.toContain(INLINE_REPLY);
  const events = stream.text().split('\n\n').filter(event => event.trim());
  expect(events).toHaveLength(1); expect(events[0]).toContain('"type":"connection"');
}

async function enterProvider(barrier: { entered: Promise<void> }, pending: Promise<Response>): Promise<void> {
  await Promise.race([barrier.entered, pending.then(response => {
    throw new Error(`Inline request ended before the fixture provider: HTTP ${response.status}`);
  })]);
}

async function resolveLiveApproval(approvals: ApprovalWorkflowService, streams: InlineStream[]): Promise<void> {
  await vi.waitFor(() => streams.forEach(stream => expect(stream.text()).toContain(APPROVAL_EVENTS.REQUEST)), { timeout: 5000 });
  const packets = streams[0].text().split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const request = packets.find(packet => packet.type === APPROVAL_EVENTS.REQUEST);
  expect(request).toMatchObject({ toolName: 'Read fixture record', toolInput: { record: 'mine' } });
  expect(approvals.getPendingCount()).toBe(1);
  const actor = fixture.actors.owner;
  const accepted = runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
    principalIssuer: actor.issuer, isOperator: false }, () => approvals.resolveApproval({ requestId: request.requestId,
    approved: true, decidedBy: actor.sub })));
  expect(accepted).toBe(true);
  await vi.waitFor(() => streams.forEach(stream => expect(stream.text()).toContain(APPROVAL_EVENTS.RESPONSE)), { timeout: 5000 });
  streams.forEach(stream => { expect(stream.closed()).toBe(false); expect(stream.text()).not.toContain(INLINE_REPLY); });
  expect(approvals.getPendingCount()).toBe(0);
}

function streamedReplies(stream: InlineStream): string[] {
  return stream.text().split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
    .filter(packet => packet.type === 'message' && packet.message?.role === 'assistant')
    .map(packet => packet.message.text as string);
}

describe('protected inline conversations at the real HTTP/PostgreSQL boundary', () => {
  it('creates and reloads an owned protected inline conversation', async () => {
    const id = await createThread({ [PROTECTED_RESULT_EXECUTIONS]: [randomUUID()],
      [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://forged.fixture.test' });
    const initial = (await fixture.owner.query('SELECT owner_sub, metadata FROM chat_tasks WHERE task_id=$1', [id])).rows[0];
    expect(initial.owner_sub).toBe(fixture.actors.owner.sub);
    expect(initial.metadata[OWNER_PRINCIPAL_ISSUER_METADATA_KEY]).toBe(INLINE_ISSUER);
    expect(initial.metadata).not.toHaveProperty(PROTECTED_RESULT_EXECUTIONS);
    expect((await fixture.owner.query('SELECT COUNT(*)::int AS count FROM oshal_application_remote_executions')).rows[0].count).toBe(0);
    const empty = await fixture.call(`/api/${id}/messages`);
    expect(empty.status, 'fresh owned protected history must be readable before a model turn').toBe(200);
    expect(await empty.json()).toMatchObject({ messages: [], count: 0 });
    expect((await fixture.call(`/api/tasks/${id}`)).status).toBe(200);
    const before = fixture.provider.calls, sent = await sendTurn(id);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ success: true, response: INLINE_REPLY });
    expect(fixture.provider.calls).toBe(before + 1);
    const task = (await fixture.owner.query('SELECT metadata FROM chat_tasks WHERE task_id=$1', [id])).rows[0];
    expect(task.metadata[PROTECTED_RESULT_EXECUTIONS]).toHaveLength(1);
    const execution = (await fixture.owner.query('SELECT payload FROM oshal_application_remote_executions WHERE execution_id=$1',
      [task.metadata[PROTECTED_RESULT_EXECUTIONS][0]])).rows[0].payload;
    expect(execution).toMatchObject({ transport: 'inline', status: 'completed', binding: {
      app: INLINE_APP, agentId: INLINE_AGENT, taskId: id, workspaceId: id, sub: fixture.actors.owner.sub, issuer: INLINE_ISSUER } });
    expect(execution.actor).toMatchObject({ isSwarmAdmin: false, allowedPermissions: [`${INLINE_APP}:records.ask`] });
    expect(execution).not.toHaveProperty('claims'); expect(execution).not.toHaveProperty('tokenHash');
    const sql = await fixture.owner.query('SELECT role, text FROM chat_messages WHERE task_id=$1 ORDER BY created_at', [id]);
    expect(sql.rows).toEqual([{ role: 'user', text: 'Read my fixture record' }, { role: 'assistant', text: INLINE_REPLY }]);
    await fixture.reload();
    const reloaded = await fixture.call(`/api/${id}/messages`);
    expect(reloaded.status).toBe(200);
    const history = await reloaded.json(); expect(history.count).toBe(2);
    expect(history.messages.map((message: { role: string; text: string }) => ({ role: message.role, text: message.text }))).toEqual(sql.rows);
    expect((await fixture.call(`/api/tasks/${id}`)).status).toBe(200);
  });

  it('persists readable lineage through the other canonical executeBotOrInline entry point', async () => {
    const id = await createThread(), actor = fixture.actors.owner;
    const client = new BotNodeClient(createRegistryEndpointResolver());
    expect(client.hasEndpoint(INLINE_AGENT)).toBe(false);
    const result = await runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
      principalIssuer: actor.issuer, isOperator: false }, () => executeBotOrInline(fixture.ctx, client, INLINE_AGENT, {
      text: 'Read my fixture record', agentId: INLINE_AGENT, taskId: id, workspaceFolderId: id,
      agenticMode: false, direct: true, userSub: actor.sub,
    })));
    expect(result).toMatchObject({ success: true, response: INLINE_REPLY });
    const task = (await fixture.owner.query('SELECT metadata FROM chat_tasks WHERE task_id=$1', [id])).rows[0];
    expect(task.metadata[PROTECTED_RESULT_EXECUTIONS]).toHaveLength(1);
    const record = await fixture.records.read(task.metadata[PROTECTED_RESULT_EXECUTIONS][0]);
    expect(record).toMatchObject({ transport: 'inline', status: 'completed', binding: { taskId: id, workspaceId: id } });
    await fixture.reload();
    const history = await fixture.call(`/api/${id}/messages`);
    expect(history.status).toBe(200);
    expect((await history.json()).messages.map((message: { text: string }) => message.text)).toContain(INLINE_REPLY);
  });

  it('enforces the private runtime role rather than silently using superuser or memory storage', async () => {
    const role = await fixture.owner.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1', [INLINE_RUNTIME_ROLE]);
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    expect((await fixture.runtime.query('SELECT current_user AS role')).rows[0].role).toBe(INLINE_RUNTIME_ROLE);
    const policies = await fixture.owner.query("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('chat_tasks','oshal_application_remote_executions') ORDER BY relname");
    expect(policies.rows).toEqual([{ relname: 'chat_tasks', relforcerowsecurity: true },
      { relname: 'oshal_application_remote_executions', relforcerowsecurity: true }]);
    await expect(runWithRequestIdentity({ sub: fixture.actors.foreign.sub, principalIssuer: INLINE_ISSUER, isOperator: false },
      () => fixture.runtime.query('INSERT INTO chat_tasks(task_id,owner_sub) VALUES($1,$2)', [randomUUID(), fixture.actors.owner.sub])))
      .rejects.toMatchObject({ code: '42501' });
    const protectedRows = await runWithRequestIdentity({ sub: fixture.actors.owner.sub, principalIssuer: INLINE_ISSUER, isOperator: false },
      () => fixture.runtime.query('SELECT execution_id FROM oshal_application_remote_executions'));
    expect(protectedRows.rows).toEqual([]);
    await expect(runWithRequestIdentity({ sub: fixture.actors.owner.sub, principalIssuer: INLINE_ISSUER, isOperator: false },
      () => fixture.runtime.query('INSERT INTO oshal_application_remote_executions(execution_id,payload) VALUES($1,$2)', [randomUUID(), {}])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('denies unrelated owners, issuer twins, administrators and inactive actors on empty and answered threads', async () => {
    const empty = await createThread(), answered = await answerThread();
    for (const user of ['foreign', 'twin', 'admin']) {
      await assertDenied(empty, user); await assertDenied(answered, user);
      const before = fixture.provider.calls, response = await sendTurn(empty, user);
      expect(response.status).toBe(404); expect(fixture.provider.calls).toBe(before);
      expect((await fixture.owner.query("SELECT payload FROM oshal_application_remote_executions WHERE payload->'binding'->>'taskId'=$1", [empty])).rows).toEqual([]);
    }
    const legitimate = await sendTurn(empty);
    expect(legitimate.status).toBe(200); expect(await legitimate.json()).toMatchObject({ success: true, response: INLINE_REPLY });
    const execution = (await fixture.records.byTask(empty));
    expect(execution).toHaveLength(1); expect(execution[0].binding.sub).toBe(fixture.actors.owner.sub);
    const inactiveEmpty = await createThread();
    fixture.actors.owner.isActive = false;
    await assertDenied(inactiveEmpty); await assertDenied(empty); await assertDenied(answered);
    const before = fixture.provider.calls; expect((await sendTurn(inactiveEmpty)).status).toBe(404);
    expect(fixture.provider.calls).toBe(before);
  });

  it.each([INLINE_APP, INLINE_DEPENDENCY])('rechecks live %s grants for empty admission and completed reply reload', async app => {
    const empty = await createThread(), answered = await answerThread();
    await fixture.change('owner', 'revoke', app);
    await assertDenied(empty); await assertDenied(answered);
    await fixture.reload(); await assertDenied(answered);
    const before = fixture.provider.calls, response = await sendTurn(empty);
    expect(response.status).not.toBe(200); expect(await response.text()).not.toContain(INLINE_REPLY);
    expect(fixture.provider.calls).toBe(before);
  });

  it('refuses a nonempty untracked protected result even when the task counter says zero', async () => {
    const id = await createThread();
    await runWithRequestIdentity({ sub: fixture.actors.owner.sub, principalIssuer: INLINE_ISSUER, isOperator: false },
      () => fixture.messages.save({ taskId: id, role: 'assistant', type: 'completion', text: INLINE_REPLY, metadata: {}, contentBlocks: [] }));
    expect((await fixture.owner.query('SELECT message_count FROM chat_tasks WHERE task_id=$1', [id])).rows[0].message_count).toBe(0);
    expect((await fixture.owner.query('SELECT COUNT(*)::int AS count FROM chat_messages WHERE task_id=$1', [id])).rows[0].count).toBe(1);
    await assertDenied(id); await fixture.reload(); await assertDenied(id);
  });

  it('keeps the real fresh-thread SSE open and flushes the reply only after durable inline completion', async () => {
    const id = await createThread(), stream = await fixture.openStream(id);
    expect(stream.status).toBe(200);
    const approvals = new ApprovalWorkflowService({ streamManager: fixture.ctx.streamManager });
    let beginApproval!: () => void, cancelled = false, reconnected: InlineStream | undefined;
    const requested = new Promise<void>(done => { beginApproval = done; });
    const barrier = fixture.provider.holdNext(async () => {
      await requested;
      if (!cancelled) await approvals.requestApproval({ taskId: id, agentId: INLINE_AGENT, toolId: 'fixture-read',
        toolName: 'Read fixture record', toolInput: { record: 'mine' }, timeoutMs: 10_000 });
    }), pending = sendTurn(id);
    try {
      await enterProvider(barrier, pending); await assertOnlyConnection(stream);
      expect(fixture.ctx.streamManager.getStats().clientCount).toBe(1);
      reconnected = await fixture.openStream(id); expect(reconnected.status).toBe(200);
      await assertOnlyConnection(reconnected);
      expect((await fixture.call(`/api/${id}/messages`)).status).toBe(404);
      beginApproval(); await resolveLiveApproval(approvals, [stream, reconnected]);
      expect((await fixture.call(`/api/${id}/messages`)).status).toBe(404);
      barrier.release(); const response = await pending;
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ success: true, response: INLINE_REPLY });
      await vi.waitFor(() => [stream, reconnected!].forEach(value => expect(value.text()).toContain(INLINE_REPLY)), { timeout: 5000 });
      [stream, reconnected].forEach(value => { expect(value.closed()).toBe(false); expect(streamedReplies(value)).toEqual([INLINE_REPLY]); });
      const records = (await fixture.records.byTask(id));
      expect(records).toHaveLength(1); expect(records[0].status).toBe('completed');
    } finally { cancelled = true; beginApproval(); approvals.cancelAll(); barrier.release(); await pending;
      stream.destroy(); reconnected?.destroy(); }
  });

  it.each([INLINE_APP, INLINE_DEPENDENCY])('withholds inline output when %s is revoked during the real provider turn', async app => {
    const id = await createThread(), stream = await fixture.openStream(id);
    expect(stream.status).toBe(200);
    const barrier = fixture.provider.holdNext(), pending = sendTurn(id);
    try {
      await enterProvider(barrier, pending); await assertOnlyConnection(stream);
      await fixture.change('owner', 'revoke', app); barrier.release();
      const response = await pending;
      expect(response.status).not.toBe(200); expect(await response.text()).not.toContain(INLINE_REPLY);
      await assertOnlyConnection(stream); stream.destroy();
      const records = await fixture.owner.query("SELECT payload->>'status' AS status FROM oshal_application_remote_executions WHERE payload->'binding'->>'taskId'=$1", [id]);
      expect(records.rows).toHaveLength(1); expect(records.rows[0].status).not.toBe('completed');
      await assertDenied(id); await fixture.reload(); await assertDenied(id);
    } finally { barrier.release(); await pending; stream.destroy(); }
  });
});
