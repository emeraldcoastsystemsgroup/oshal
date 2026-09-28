/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the developer-workspace live-acceptance case's own logic over a doubled HTTP transport that keeps the package's dev-mode state: one tagged Jarvis conversation opened through the ask route, then a cited ADR answer in dev mode plus a refusal outside it, both in that conversation = pass, with dev mode left exactly as found (off or on) and the conversation removed and proven gone; a refused-but-still-cited answer = fail; a closed deployment gate or an unbuilt index = unavailable with the configuration step and no conversation; a dev mode that will not switch back = red cleanup; every action carries the page's same-origin headers. The package's own seam suites (store dev-workspace-index jarvis.core / refusal.core) prove the route and the refusal on the real core seam; the real companion for this case is `node scripts/operations/live-acceptance.js dev-workspace` on the box.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fakeApi, fakeClock, jarvisConversationRoutes, type FakeHandler } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const devWorkspace = requireCjs('../../scripts/lib/live-acceptance-dev-workspace.js');

const ORIGIN = 'http://127.0.0.1:5000';
const OWNER = 'fixture|dev-owner';
const TAG = 'testlab-live-dev-workspace-0a1b2c3d';
const ADR_PATH = 'docs/adr/077-self-developing-platform.md';

function world(options: { initiallyOn?: boolean; gates?: Record<string, boolean>; indexPresent?: boolean; leakWhenOff?: boolean; stuckOn?: boolean; over?: Record<string, FakeHandler> } = {}) {
  let on = options.initiallyOn === true;
  let proposals = 0;
  const gates = { superAdmin: true, devConsoleEnabled: true, packageEnabled: true, ...(options.gates || {}) };
  const state = () => ({ enabled: on, expiresAt: on ? '2026-09-28T16:00:00Z' : null });
  const jarvis = jarvisConversationRoutes('ADR-077 is dw-5f2c: the self-developing platform.');
  const api = fakeApi({
    ...jarvis.routes,
    'GET /api/dev-workspace-index/dev-mode': () => ({ status: 200, json: { ...gates, devMode: state(), ttlMinutes: 240 } }),
    'POST /api/dev-workspace-index/dev-mode': () => { on = true; return { status: 200, json: { devMode: state() } }; },
    'DELETE /api/dev-workspace-index/dev-mode': () => { if (!options.stuckOn) on = false; return { status: 200, json: { devMode: { enabled: false } } }; },
    'GET /api/dev-workspace-index/status': () => (on ? { status: 200, json: { indexPresent: options.indexPresent !== false, counts: { documents: 212 } } } : { status: 403, json: { error: 'dev_workspace_unavailable' } }),
    'POST /api/jarvis/package-tools/preview': () => { proposals += 1; return { status: 200, json: { id: `00000000-0000-4000-8000-00000000000${proposals}`, mode: 'auto' } }; },
    'POST /api/jarvis/package-tools/execute': () => (on || options.leakWhenOff
      ? { status: 200, json: { result: { results: [{ doc_id: 'dw-5f2c', path: ADR_PATH }], citation: 'Cite doc_id for every claim.' } } }
      : { status: 403, json: { error: 'package_tool_refused' } }),
    ...(options.over || {}),
  });
  const statements: string[] = [];
  const removed: string[] = [];
  const ports = { api: api.api, origin: ORIGIN, ownerSub: OWNER, ...fakeClock(),
    sql: async (name: string) => { statements.push(name); return { rows: [{ chat_tasks: 0, chat_messages: 0, chat_tickets: 0, work_items: 0 }] }; },
    workspace: { state: async () => 'final', remove: async (id: string) => { removed.push(id); return null; } } };
  return { api, ports, sessions: jarvis.sessions, statements, removed };
}

const run = (w: ReturnType<typeof world>) => devWorkspace.run(w.ports, { tag: TAG });

describe('developer workspace index live acceptance', () => {
  it('passes on a cited ADR answer in dev mode and a refusal outside it, in one owned conversation', async () => {
    const w = world();
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain(`ADR-077 ask returned doc_id dw-5f2c (${ADR_PATH})`);
    expect(result.detail).toContain('outside dev mode the same ask was refused (preview 200, execute 403: package_tool_refused)');
    expect(w.sessions).toEqual([`${TAG}-1`]);
    const previews = w.api.calls.filter((c) => c.path.endsWith('/preview')).map((c) => c.body as { sessionId: string; toolName: string; input: { query: string } });
    expect(previews.map((p) => [p.sessionId, p.toolName, p.input.query])).toEqual([[`${TAG}-1`, 'dev_workspace_search', 'ADR-077'], [`${TAG}-1`, 'dev_workspace_search', 'ADR-077']]);
    expect(w.api.calls.filter((c) => c.path.endsWith('/dev-mode') && c.method !== 'GET').every((c) => c.headers['x-oshal-dev-workspace'] === '1' && c.headers.origin === ORIGIN)).toBe(true);
    expect(w.api.calls.filter((c) => c.path.startsWith('/api/jarvis/package-tools/')).every((c) => c.headers['x-oshal-package-tool'] === '1')).toBe(true);
    expect(result.evidence).toMatchObject({ initialDevMode: false, jarvisAnswerCitedDocId: true });
    expect(w.removed).toEqual([`${TAG}-1`]);
    expect(w.statements).toEqual(['jarvis.residue']);
    expect(result.cleanup.removed).toEqual(expect.arrayContaining(['dev-mode-change restored-off', `jarvis-thread ${TAG}-1`, 'chat-ticket ticket-1', 'ask-job job-1']));
    expect(result.cleanup.outstanding).toEqual([]);
  });

  it('turns dev mode back on when it was on before the run', async () => {
    const w = world({ initiallyOn: true });
    const result = await run(w);
    expect(result.state).toBe('pass');
    expect(w.api.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/dev-mode'))).toHaveLength(2);
    expect(result.cleanup.removed).toContain('dev-mode-change restored-on');
  });

  it('fails when the ask still returns cited documents with dev mode off', async () => {
    const result = await run(world({ leakWhenOff: true }));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('outside dev mode the ask still returned 1 cited result(s)');
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

  it('turns a dev mode that will not switch back into a red cleanup', async () => {
    const result = await run(world({ stuckOn: true }));
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('CLEANUP INCOMPLETE');
    expect(result.cleanup.outstanding).toEqual(['dev-mode-change restored-off']);
  });
});
