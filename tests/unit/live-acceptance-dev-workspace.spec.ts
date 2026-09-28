/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the developer-workspace live-acceptance case's own logic over a doubled HTTP transport that keeps the package's dev-mode state: one tagged Jarvis conversation opened through the ask route, then a cited ADR answer in dev mode plus a refusal outside it, both in that conversation = pass, with dev mode left exactly as found (off or on) and the conversation removed and proven gone; a refused-but-still-cited answer = fail; a closed deployment gate or an unbuilt index = unavailable with the configuration step and no conversation; a dev mode that will not switch back = red cleanup; every action carries the page's same-origin headers. The package's own seam suites (store dev-workspace-index jarvis.core / refusal.core) prove the route and the refusal on the real core seam; the real companion for this case is `node scripts/operations/live-acceptance.js dev-workspace` on the box.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The completed case: four asks (ADR number, BACKLOG entry title, runbook, local-notes handover) in the one conversation, each passing only on a doc_id-carrying result of its path family; all four refused outside dev mode; an unauthenticated GET of the query route through the credential-free port answering 401/403. Red on: an uncited reply (a family hit with no doc_id), a wrong family (only the runbooks README), the anonymous probe answered 200, the anonymous port missing. Unavailable, with no conversation, on an index that holds no local-notes documents (naming --notes-dir), an index that does not report its sources, and a handover probe that was not supplied (naming OSHAL_VERIFY_DEV_NOTES_PROBE). The probe texts come from options or the injected env, never the host environment.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fakeApi, fakeClock, jarvisConversationRoutes, type FakeHandler, type FakeReply } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const devWorkspace = requireCjs('../../scripts/lib/live-acceptance-dev-workspace.js');

const ORIGIN = 'http://127.0.0.1:5000';
const OWNER = 'fixture|dev-owner';
const TAG = 'testlab-live-dev-workspace-0a1b2c3d';
const ADR_PATH = 'docs/adr/077-self-developing-platform.md';
const NOTES_PROBE = 'handover fixture night';
const BACKLOG_PROBE: string = devWorkspace.DEFAULT_PROBES.backlog;
const RUNBOOK_PROBE: string = devWorkspace.DEFAULT_PROBES.runbook;
const ENV = { OSHAL_VERIFY_DEV_NOTES_PROBE: NOTES_PROBE };

type Result = { doc_id?: string; path: string };
/** What the package tool answers per ask in dev mode: the runbook ranks second, as the lexical search does. */
const ANSWERS: Record<string, Result[]> = {
  'ADR-077': [{ doc_id: 'dw-5f2c', path: ADR_PATH }],
  [BACKLOG_PROBE]: [{ doc_id: 'dw-b001', path: 'docs/BACKLOG.md' }],
  [RUNBOOK_PROBE]: [{ doc_id: 'dw-c001', path: 'CLAUDE.md' }, { doc_id: 'dw-r001', path: 'docs/runbooks/localhost-wedge-wslrelay.md' }],
  [NOTES_PROBE]: [{ doc_id: 'dw-n001', path: 'local-notes/handover.md' }],
};

interface WorldOptions {
  initiallyOn?: boolean; gates?: Record<string, boolean>; indexPresent?: boolean; sources?: Record<string, number> | null;
  leakWhenOff?: boolean; stuckOn?: boolean; answers?: Record<string, Result[]>; anonymous?: FakeReply; over?: Record<string, FakeHandler>;
}

function world(options: WorldOptions = {}) {
  let on = options.initiallyOn === true;
  const proposals = new Map<string, string>();
  const gates = { superAdmin: true, devConsoleEnabled: true, packageEnabled: true, ...(options.gates || {}) };
  const answers = { ...ANSWERS, ...(options.answers || {}) };
  const sources = options.sources === undefined ? { checkout: 211, 'local-notes': 1 } : options.sources;
  const state = () => ({ enabled: on, expiresAt: on ? '2026-09-28T16:00:00Z' : null });
  const jarvis = jarvisConversationRoutes('ADR-077 is dw-5f2c and tonight\'s handover is dw-n001.');
  const api = fakeApi({
    ...jarvis.routes,
    'GET /api/dev-workspace-index/dev-mode': () => ({ status: 200, json: { ...gates, devMode: state(), ttlMinutes: 240 } }),
    'POST /api/dev-workspace-index/dev-mode': () => { on = true; return { status: 200, json: { devMode: state() } }; },
    'DELETE /api/dev-workspace-index/dev-mode': () => { if (!options.stuckOn) on = false; return { status: 200, json: { devMode: { enabled: false } } }; },
    'GET /api/dev-workspace-index/status': () => (on
      ? { status: 200, json: { indexPresent: options.indexPresent !== false, counts: { documents: 212 }, ...(sources === null ? {} : { sources }) } }
      : { status: 403, json: { error: 'dev_workspace_unavailable' } }),
    'POST /api/jarvis/package-tools/preview': ({ body }) => {
      const id = `00000000-0000-4000-8000-00000000000${proposals.size + 1}`;
      proposals.set(id, (body as { input: { query: string } }).input.query);
      return { status: 200, json: { id, mode: 'auto' } };
    },
    'POST /api/jarvis/package-tools/execute': ({ body }) => {
      const query = proposals.get((body as { proposalId: string }).proposalId) || '';
      return on || options.leakWhenOff
        ? { status: 200, json: { result: { results: answers[query] || [], citation: 'Cite doc_id for every claim.' } } }
        : { status: 403, json: { error: 'package_tool_refused' } };
    },
    ...(options.over || {}),
  });
  const anonymous = fakeApi({ 'GET /api/dev-workspace-index/query': () => options.anonymous || { status: 401, json: { error: 'unauthorized' } } });
  const statements: string[] = [];
  const removed: string[] = [];
  const ports = { api: api.api, anonymous: anonymous.api, origin: ORIGIN, ownerSub: OWNER, ...fakeClock(),
    sql: async (name: string) => { statements.push(name); return { rows: [{ chat_tasks: 0, chat_messages: 0, chat_tickets: 0, work_items: 0 }] }; },
    workspace: { state: async () => 'final', remove: async (id: string) => { removed.push(id); return null; } } };
  return { api, anonymous, ports, sessions: jarvis.sessions, statements, removed };
}

const run = (w: ReturnType<typeof world>, options: Record<string, unknown> = {}) => devWorkspace.run(w.ports, { tag: TAG, env: ENV, ...options });
const writes = (w: ReturnType<typeof world>) => w.api.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

describe('developer workspace index live acceptance', () => {
  it('passes on four cited asks in dev mode, four refusals outside it and an anonymous 401, in one owned conversation', async () => {
    const w = world();
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain(`ADR-077 ask returned doc_id dw-5f2c (${ADR_PATH}, rank 1)`);
    expect(result.detail).toContain('BACKLOG entry title ask returned doc_id dw-b001 (docs/BACKLOG.md, rank 1)');
    expect(result.detail).toContain('runbook ask returned doc_id dw-r001 (docs/runbooks/localhost-wedge-wslrelay.md, rank 2)');
    expect(result.detail).toContain('handover ask returned doc_id dw-n001 (local-notes/handover.md, rank 1)');
    for (const label of ['ADR-077', 'BACKLOG entry title', 'runbook', 'handover']) {
      expect(result.detail).toContain(`outside dev mode the ${label} ask was refused (preview 200, execute 403: package_tool_refused)`);
    }
    expect(result.detail).toContain('an unauthenticated GET /api/dev-workspace-index/query?q=ADR-077 answered 401');
    expect(w.anonymous.calls.map((c) => [c.method, c.path, c.query, c.headers])).toEqual([['GET', '/api/dev-workspace-index/query', 'q=ADR-077', {}]]);
    expect(w.sessions).toEqual([`${TAG}-1`]);
    const ask = w.api.calls.find((c) => c.path === '/api/jarvis/ask')!.body as { message: string };
    expect(ask.message).toContain(NOTES_PROBE);
    const previews = w.api.calls.filter((c) => c.path.endsWith('/preview')).map((c) => c.body as { sessionId: string; toolName: string; input: { query: string; limit: number } });
    const queries = ['ADR-077', BACKLOG_PROBE, RUNBOOK_PROBE, NOTES_PROBE];
    expect(previews.map((p) => [p.sessionId, p.toolName, p.input.query, p.input.limit])).toEqual([...queries, ...queries].map((q) => [`${TAG}-1`, 'dev_workspace_search', q, 5]));
    expect(w.api.calls.filter((c) => c.path.endsWith('/dev-mode') && c.method !== 'GET').every((c) => c.headers['x-oshal-dev-workspace'] === '1' && c.headers.origin === ORIGIN)).toBe(true);
    expect(w.api.calls.filter((c) => c.path.startsWith('/api/jarvis/package-tools/')).every((c) => c.headers['x-oshal-package-tool'] === '1')).toBe(true);
    expect(result.evidence).toMatchObject({ initialDevMode: false, anonymousStatus: 401, jarvisAnswerCitedDocIds: ['adr', 'notes'], sources: { 'local-notes': 1 } });
    expect(result.evidence.citations.runbook).toEqual({ docId: 'dw-r001', path: 'docs/runbooks/localhost-wedge-wslrelay.md', rank: 2 });
    expect(w.removed).toEqual([`${TAG}-1`]);
    expect(w.statements).toEqual(['jarvis.residue']);
    expect(result.cleanup.removed).toEqual(expect.arrayContaining(['dev-mode-change restored-off', `jarvis-thread ${TAG}-1`, 'chat-ticket ticket-1', 'ask-job job-1']));
    expect(result.cleanup.outstanding).toEqual([]);
  });

  it('turns dev mode back on when it was on before the run, and takes the probes from options over env', async () => {
    const w = world({ initiallyOn: true, answers: { 'deploy parity': [{ doc_id: 'dw-r009', path: 'docs/runbooks/deploy-parity.md' }] } });
    const result = await run(w, { runbookProbe: 'deploy parity', env: { ...ENV, OSHAL_VERIFY_DEV_RUNBOOK_PROBE: 'ignored words' } });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('runbook ask returned doc_id dw-r009 (docs/runbooks/deploy-parity.md, rank 1)');
    expect(w.api.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/dev-mode'))).toHaveLength(2);
    expect(result.cleanup.removed).toContain('dev-mode-change restored-on');
  });

  it('fails when an ask still returns cited documents with dev mode off', async () => {
    const result = await run(world({ leakWhenOff: true }));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('outside dev mode the handover ask still returned 1 cited result(s)');
  });

  it('fails an uncited reply: a result of the right family with no doc_id', async () => {
    const result = await run(world({ answers: { [NOTES_PROBE]: [{ path: 'local-notes/handover.md' }] } }));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('the dev-mode handover ask returned local-notes/handover.md with no doc_id (an uncited reply)');
    expect(result.evidence.citations.notes).toEqual({ docId: null, path: 'local-notes/handover.md', rank: 1 });
  });

  it('fails an ask whose results hold no document of its family (the runbooks README is not a runbook)', async () => {
    const result = await run(world({ answers: { [RUNBOOK_PROBE]: [{ doc_id: 'dw-rm01', path: 'docs/runbooks/README.md' }, { doc_id: 'dw-c001', path: 'CLAUDE.md' }] } }));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('the dev-mode runbook ask returned no docs/runbooks/*.md result (got docs/runbooks/README.md, CLAUDE.md)');
  });

  it('fails when the unauthenticated query is answered, and reports a missing anonymous port as unavailable', async () => {
    const answered = await run(world({ anonymous: { status: 200, json: { results: [{ doc_id: 'dw-5f2c', path: ADR_PATH }] } } }));
    expect(answered.state).toBe('fail');
    expect(answered.detail).toContain('an unauthenticated GET /api/dev-workspace-index/query?q=ADR-077 answered HTTP 200 with 1 result(s) instead of 401 or 403');
    expect(answered.evidence.anonymousStatus).toBe(200);
    const redirected = await run(world({ anonymous: { status: 302, location: '/login' } }));
    expect(redirected.state).toBe('fail');
    const w = world();
    const noPort = await devWorkspace.run({ ...w.ports, anonymous: undefined }, { tag: TAG, env: ENV });
    expect(noPort.state).toBe('unavailable');
    expect(noPort.detail).toContain('This runner has no anonymous port.');
    expect(w.api.calls).toEqual([]);
  });

  it('reports a closed gate or an unbuilt index as unavailable with the configuration step and no conversation', async () => {
    const closed = world({ gates: { packageEnabled: false } });
    const off = await run(closed);
    expect(off.state).toBe('unavailable');
    expect(off.detail).toContain('OSHAL_DEV_WORKSPACE_INDEX_ENABLED is off');
    expect(off.detail).toContain('restart the api');
    expect(closed.api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    const missing = await run(world({ over: { 'GET /api/dev-workspace-index/dev-mode': () => ({ status: 404 }) } }));
    expect(missing.detail).toContain('dev-workspace-index is not installed');
    const unbuiltWorld = world({ indexPresent: false });
    const unbuilt = await run(unbuiltWorld);
    expect(unbuilt.state).toBe('unavailable');
    expect(unbuilt.detail).toContain('the index is not built');
    expect(unbuiltWorld.sessions).toEqual([]);
    expect(unbuilt.cleanup.removed).toEqual(['dev-mode-change restored-off']);
  });

  it('reports an index with no local-notes documents as unavailable, naming the --notes-dir build step', async () => {
    const w = world({ sources: { checkout: 212 } });
    const result = await run(w);
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('the index holds no local-notes documents');
    expect(result.detail).toContain('--notes-dir <local notes directory>');
    expect(w.sessions).toEqual([]);
    expect(w.anonymous.calls).toEqual([]);
    expect(writes(w)).toEqual(['POST /api/dev-workspace-index/dev-mode', 'DELETE /api/dev-workspace-index/dev-mode']);
    expect(result.cleanup.removed).toEqual(['dev-mode-change restored-off']);
    const old = await run(world({ sources: null }));
    expect(old.state).toBe('unavailable');
    expect(old.detail).toContain('does not report its index sources');
  });

  it('reports a handover probe that was not supplied as unavailable, naming its variable, never a pass', async () => {
    const w = world();
    const result = await devWorkspace.run(w.ports, { tag: TAG, env: {} });
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('the handover ask needs OSHAL_VERIFY_DEV_NOTES_PROBE');
    expect(w.sessions).toEqual([]);
    const both = await devWorkspace.run(world({ sources: { checkout: 212 } }).ports, { tag: TAG, env: {} });
    expect(both.detail).toContain('no local-notes documents');
    expect(both.detail).toContain('OSHAL_VERIFY_DEV_NOTES_PROBE');
    const tooLong = await run(world(), { notesProbe: 'x'.repeat(201) });
    expect(tooLong.state).toBe('unavailable');
  });

  it('turns a dev mode that will not switch back into a red cleanup', async () => {
    const result = await run(world({ stuckOn: true }));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('CLEANUP INCOMPLETE');
    expect(result.cleanup.outstanding).toEqual(['dev-mode-change restored-off']);
  });
});
