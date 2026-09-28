/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the in-memory `api` port the live-acceptance case specs drive: routes keyed `METHOD /path` (query string stripped, `:param` segments matched), every call recorded with its body and extra headers, and an unrouted call answering 404 like an unmounted package. It doubles only the HTTP transport; each spec says which product boundary it stands in for, and the live run through scripts/operations/live-acceptance.js is the real companion.
 */

/** One recorded call. */
export interface RecordedCall { method: string; path: string; query: string; body: unknown; headers: Record<string, string> }
/** What a route handler returns; `json` becomes the reply body, `text` defaults to its JSON. */
export interface FakeReply { status: number; json?: unknown; text?: string; contentType?: string; location?: string | null }
/** A route handler. */
export type FakeHandler = (call: RecordedCall & { params: Record<string, string> }) => FakeReply | Promise<FakeReply>;

/**
 * @description Build a fake `api` port over a route table.
 * @param routes - `METHOD /path/:param` to handler.
 * @returns The port plus the recorded calls.
 */
export function fakeApi(routes: Record<string, FakeHandler>) {
  const calls: RecordedCall[] = [];
  const table = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    const names: string[] = [];
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_m, name: string) => { names.push(name); return '([^/]+)'; })}$`);
    return { method, re, names, handler };
  });
  const api = async (method: string, route: string, body?: unknown, options: { headers?: Record<string, string> } = {}) => {
    const [pathPart, query = ''] = route.split('?');
    const call: RecordedCall = { method, path: pathPart, query, body, headers: options.headers || {} };
    calls.push(call);
    for (const entry of table) {
      const match = entry.method === method ? pathPart.match(entry.re) : null;
      if (!match) continue;
      const params = Object.fromEntries(entry.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
      const reply = await entry.handler({ ...call, params });
      const json = reply.json === undefined ? {} : reply.json;
      return { status: reply.status, json, text: reply.text ?? JSON.stringify(json), contentType: reply.contentType ?? 'application/json', location: reply.location ?? null };
    }
    return { status: 404, json: { error: 'not_found' }, text: '{"error":"not_found"}', contentType: 'application/json', location: null };
  };
  return { api, calls };
}

/** A clock whose sleep advances time instantly, so bounded polls finish in microseconds. */
export function fakeClock(start = Date.parse('2026-09-28T12:00:00Z')) {
  let now = start;
  return { now: () => now, sleep: async (ms: number) => { now += ms; }, advance: (ms: number) => { now += ms; } };
}

/**
 * @description The Jarvis conversation routes a live-acceptance case opens and removes a thread through:
 * an ask that answers 202 with a job and chat ticket, a finished job, a history holding the answer, and
 * the four removal routes answering as done.
 * @param answer - The Jarvis turn the history returns.
 * @returns Route handlers to spread into a fakeApi table, plus the session ids asked.
 */
export function jarvisConversationRoutes(answer = 'Done.') {
  const sessions: string[] = [];
  const routes: Record<string, FakeHandler> = {
    'POST /api/jarvis/ask': ({ body }) => {
      const { sessionId } = body as { sessionId: string };
      sessions.push(sessionId);
      return { status: 202, json: { jobId: `job-${sessions.length}`, sessionId, chatTicketId: `ticket-${sessions.length}` } };
    },
    'GET /api/jarvis/ask/result': () => ({ status: 200, json: { status: 'done', answer } }),
    'GET /api/jarvis/history': () => ({ status: 200, json: { turns: [{ role: 'user', text: 'q' }, { role: 'assistant', text: answer }] } }),
    'POST /api/jarvis/thread/close': () => ({ status: 200 }),
    'DELETE /api/tickets/:id': () => ({ status: 200 }),
    'DELETE /api/tasks/:id': () => ({ status: 200 }),
    'POST /api/jarvis/ask/dismiss': () => ({ status: 200 }),
  };
  return { routes, sessions };
}
