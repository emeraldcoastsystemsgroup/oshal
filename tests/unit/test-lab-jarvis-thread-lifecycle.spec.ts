/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the signed-in Jarvis legacy fixture, deterministic fresh ask and exact owner-bound cleanup.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { runJarvisLegacyThreadLifecycle } from '@/app/routes/test-lab-jarvis-thread-lifecycle';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import type { ScenarioRunContext } from '@/app/routes/test-lab-scenarios';

afterEach(() => vi.unstubAllGlobals());

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(options: { refusal?: number; answer?: string; failCleanup?: boolean } = {}) {
  const rows = new Map<string, { owner_sub: string; metadata: Record<string, unknown> }>();
  const tickets = new Map<string, { ownerSub: string; ticketType: string; workspaceId: null; metadata: Record<string, unknown> }>();
  const deletedMessages: string[] = [];
  const calls: Array<{ path: string; method: string; sessionId?: string }> = [];
  const ctx = {
    pool: { query: vi.fn(async (sql: string, params: string[]) => {
      if (sql.includes('FROM chat_tasks')) return { rows: rows.has(params[0]) ? [rows.get(params[0])] : [] };
      if (sql.includes('FROM tickets')) return { rows: [...tickets.entries()]
        .filter(([, ticket]) => ticket.ownerSub === params[0] && ticket.metadata.taskId === params[1])
        .map(([ticket_id]) => ({ ticket_id })) };
      throw new Error(`Unexpected query: ${sql}`);
    }) },
    taskStore: {
      create: vi.fn(async (input: { taskId: string; ownerSub: string; metadata: Record<string, unknown> }) => {
        rows.set(input.taskId, { owner_sub: input.ownerSub, metadata: input.metadata });
        return { ownerSub: input.ownerSub, metadata: input.metadata };
      }),
      delete: vi.fn(async (id: string) => { if (!options.failCleanup) rows.delete(id); }),
      get: vi.fn(async (id: string) => { const row = rows.get(id); return row ? { ownerSub: row.owner_sub, metadata: row.metadata } : null; }),
    },
    messageStore: { deleteByTask: vi.fn(async (id: string) => { deletedMessages.push(id); }) },
    ticketService: {
      getTicket: vi.fn(async (id: string) => tickets.get(id) ?? null),
      deleteTicket: vi.fn(async (id: string) => { tickets.delete(id); }),
    },
  };
  const runtime: ScenarioRunContext = { ctx: ctx as never, ownerSub: 'owner-1', issuer: 'https://fixture.test', apiBaseUrl: 'http://fixture.test' };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    calls.push({ path, method: String(init.method), sessionId: body.sessionId });
    if (path === '/api/jarvis/ask' && body.sessionId.includes('-legacy-')) {
      return reply(options.refusal ?? 404, { error: options.refusal === undefined ? 'session_not_found' : 'unexpected' });
    }
    if (path === '/api/jarvis/ask' && body.sessionId.includes('-fresh-')) {
      rows.set(body.sessionId, { owner_sub: 'owner-1', metadata: { origin: 'jarvis-chat', [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://fixture.test' } });
      tickets.set('ticket-1', { ownerSub: 'owner-1', ticketType: 'chat', workspaceId: null,
        metadata: { kind: 'chat-thread', taskId: body.sessionId } });
      return reply(202, { sessionId: body.sessionId, jobId: 'job-1', chatTicketId: 'ticket-1' });
    }
    if (path === '/api/jarvis/ask/result') return reply(200, { status: 'done', taskId: [...rows.keys()].find(id => id.includes('-fresh-')),
      answer: options.answer ?? 'What city or ZIP code should I use for the live weather check?', dispatched: [], handoffs: [] });
    if (path === '/api/jarvis/thread/close' || path === '/api/jarvis/ask/dismiss') return reply(200, { ok: true });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { ctx, runtime, rows, tickets, deletedMessages, calls, fetcher };
}

it('writes nothing without a verified signed-in session', async () => {
  const fixture = setup();
  expect((await runJarvisLegacyThreadLifecycle('', fixture.runtime)).state).toBe('degraded');
  expect((await runJarvisLegacyThreadLifecycle('session=fixture', { ...fixture.runtime, issuer: null })).state).toBe('degraded');
  expect(fixture.ctx.taskStore.create).not.toHaveBeenCalled();
  expect(fixture.fetcher).not.toHaveBeenCalled();
});

it('refuses the issuer-less row, accepts an issuer-stamped fresh row, and removes both plus the ticket', async () => {
  const fixture = setup();
  const outcome = await runJarvisLegacyThreadLifecycle('session=fixture', fixture.runtime);
  expect(outcome).toMatchObject({ state: 'pass', status: 202 });
  expect(fixture.calls.filter(call => call.path === '/api/jarvis/ask').map(call => call.sessionId?.includes('-legacy-'))).toEqual([true, false]);
  expect(fixture.rows.size).toBe(0);
  expect(fixture.tickets.size).toBe(0);
  expect(fixture.deletedMessages).toHaveLength(2);
  expect(fixture.ctx.ticketService.deleteTicket).toHaveBeenCalledWith('ticket-1');
});

it('does not start a fresh ask when the protected refusal is wrong, but removes its own legacy row', async () => {
  const fixture = setup({ refusal: 200 });
  const outcome = await runJarvisLegacyThreadLifecycle('session=fixture', fixture.runtime);
  expect(outcome.state).toBe('fail');
  expect(outcome.detail).toContain('not refused');
  expect(fixture.calls.filter(call => call.path === '/api/jarvis/ask')).toHaveLength(1);
  expect(fixture.rows.size).toBe(0);
});

it('reports a wrong fresh answer and a cleanup failure instead of a false pass', async () => {
  const wrong = setup({ answer: 'wrong answer' });
  const wrongResult = await runJarvisLegacyThreadLifecycle('session=fixture', wrong.runtime);
  expect(wrongResult.state).toBe('fail');
  expect(wrong.rows.size).toBe(0);
  const failed = setup({ failCleanup: true });
  const failedResult = await runJarvisLegacyThreadLifecycle('session=fixture', failed.runtime);
  expect(failedResult.state).toBe('fail');
  expect(failedResult.detail).toContain('Synthetic task remains');
});
