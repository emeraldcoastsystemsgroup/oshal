/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the full-swarm build's pure readers headlessly over the shipped scripts: every canonical ticket state folds to a label one of the shared status groups places (approval gates and customer actions need the person, every in_process_* phase is Working, approved waits for the queue).
 * 2 | maintainer@emeraldcoastsystemsgroup.com | live-views.js readers: the day focus order, cron cadence words, routines with their switch rule, workflow definitions, membership with the chosen tenant, the caller's place, a ticket's workflow stages and progress, and Finance spend bars, each with its refusal state.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Classic browser scripts with a CommonJS export seam; the shipped files themselves are loaded.
const LIVE = require('../../src/experience/live-data.js') as Record<string, any>;

/** The canonical ticket states (OshalTicketStateSchema in src/entities/ticket/types.ts), copied so a new state shows up here as a failing case. */
const CANONICAL_STATES = ['backlog', 'approved', 'in_process', 'in_process_discovery', 'in_process_design', 'in_process_build', 'in_process_deploy', 'in_process_test',
  'in_process_release', 'approval_required', 'customer_action', 'complete', 'escalated', 'dead_letter', 'paused', 'cancelled'];

describe('status fold over the canonical ticket states', () => {
  it('places every canonical state in exactly one shared group', () => {
    const groups = LIVE.STATUS_GROUPS as Record<string, string[]>;
    for (const state of CANONICAL_STATES) {
      const label = LIVE.statusOf(state).label;
      const homes = Object.keys(groups).filter(g => groups[g].includes(label));
      expect(homes, `${state} -> ${label}`).toHaveLength(1);
    }
  });

  it('names the states that wait on a person and the phases that are moving', () => {
    expect(LIVE.statusOf('approval_required')).toMatchObject({ label: 'Approval required', tone: 'warn', open: true });
    expect(LIVE.statusOf('customer_action')).toMatchObject({ label: 'Needs you', tone: 'warn', open: true });
    expect(LIVE.statusOf('dead_letter')).toMatchObject({ label: 'Blocked', tone: 'warn', open: true });
    expect(LIVE.statusOf('approved')).toMatchObject({ label: 'Approved', open: true });
    for (const phase of ['in_process_discovery', 'in_process_build', 'in_process_release', 'In-Process-Test']) expect(LIVE.statusOf(phase).label, phase).toBe('Working');
    expect(LIVE.STATUS_GROUPS.attention).toEqual(expect.arrayContaining(['Approval required', 'Needs you', 'Review', 'Blocked']));
    expect(LIVE.STATUS_GROUPS.moving).toEqual(expect.arrayContaining(['Working', 'Queued', 'Approved']));
  });

  it('keeps an unknown status readable and outside every group', () => {
    expect(LIVE.statusOf('needs_owner_review').label).toBe('Needs owner review');
    const all = Object.values(LIVE.STATUS_GROUPS as Record<string, string[]>).flat();
    expect(all).not.toContain('Needs owner review');
  });
});

const VIEWS = require('../../src/experience/live-views.js') as Record<string, any>;
const ok = (body: unknown, status = 200) => ({ ok: true, status, body });
const refused = (status: number, body: unknown = { error: 'refused' }) => ({ ok: false, status, body });

describe('day focus', () => {
  it('orders the focus suites first, keeps each group in its base order and never drops an item', () => {
    const items = [{ id: 'a', suite: 'ai-home' }, { id: 'b', suite: 'ai-finance' }, { id: 'c', suite: null }, { id: 'd', suite: 'ai-creative' }, { id: 'e', suite: 'ai-engineering' }];
    const ids = (scene: string) => VIEWS.sceneOrder(items, scene, (i: { suite: string | null }) => i.suite).map((i: { id: string }) => i.id);
    expect(ids('evening')).toEqual(['a', 'c', 'd', 'b', 'e']);
    expect(ids('workday')).toEqual(['b', 'c', 'e', 'a', 'd']);
    expect(ids('nonsense')).toEqual(ids('workday'));
    expect(VIEWS.sceneOf('evening').label).toBe('An evening at home');
    expect(items.map(i => i.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('routines and workflows', () => {
  it('words the common cron shapes, keeps the timezone and marks a one-shot', () => {
    expect(VIEWS.cadence({ cron: '0 8 * * 1-5', timezone: 'America/Chicago' })).toBe('Weekdays at 08:00 (America/Chicago)');
    expect(VIEWS.cadence({ cron: '*/15 * * * *' })).toBe('Every 15 minutes');
    expect(VIEWS.cadence({ cron: '5 * * * *' })).toBe('Every hour at :05');
    expect(VIEWS.cadence({ cron: '30 18 * * *' })).toBe('Every day at 18:30');
    expect(VIEWS.cadence({ cron: '0 9 * * 0,6' })).toBe('Weekends at 09:00');
    expect(VIEWS.cadence({ cron: '30 7 * * 1', once: true })).toBe('Once · Every Monday at 07:30');
    expect(VIEWS.cadence({ cron: '0 6 15 * *' })).toBe('Monthly on day 15 at 06:00');
    expect(VIEWS.cadence({ cron: '0 6 1 1 *' })).toBe('Schedule 0 6 1 1 *');
  });

  it('offers a switch only for the caller’s own prompt schedules and orders active ones first', () => {
    const view = VIEWS.routinesView(ok({ schedules: [
      { id: 'p1', taskType: 'jarvis-routine', cron: '0 8 * * 1-5', taskData: { prompt: 'Brief me on my queue' }, status: 'paused', nextRunAt: null, lastRunAt: null, executionCount: 2, ownerSub: 'me' },
      { id: 'a1', taskType: 'app:finance', cron: '0 6 * * *', taskData: { kind: 'manifest-service-route', scheduleKey: 'sync' }, status: 'active', nextRunAt: '2026-10-01T06:00:00.000Z', lastRunAt: null, executionCount: 0 },
      { id: 'w1', taskType: 'workflow:ledger', cron: '0 7 * * *', taskData: { prompt: 'Open the ledger review' }, status: 'active', nextRunAt: '2026-10-01T07:00:00.000Z', lastRunAt: null, executionCount: 0 },
    ] }));
    expect(view.routines.map((r: { id: string }) => r.id)).toEqual(['a1', 'w1', 'p1']);
    expect(view.routines.map((r: { managed: string }) => r.managed)).toEqual(['app', 'workflow', '']);
    expect(view.routines.map((r: { switchable: boolean }) => r.switchable)).toEqual([false, false, true]);
    expect(view.routines[2]).toMatchObject({ title: 'Brief me on my queue', on: false, runs: 2, cadence: 'Weekdays at 08:00' });
    expect(VIEWS.routinesView(refused(401))).toMatchObject({ ok: false, status: 401, routines: [] });
  });

  it('lists workflow definitions by name and version and keeps a refusal', () => {
    const view = VIEWS.workflowsView(ok({ count: 1, success: true, definitions: [{ id: 'd1', name: 'Synthetic flow', description: '', version: 3, updatedAt: '2026-09-01T00:00:00.000Z', nodeCount: 7, edgeCount: 8 }] }));
    expect(view.workflows[0]).toMatchObject({ id: 'd1', name: 'Synthetic flow', version: 3, nodeCount: 7 });
    expect(VIEWS.workflowsView(refused(500))).toMatchObject({ ok: false, status: 500, workflows: [] });
  });
});

describe('membership and place', () => {
  it('names an organisation first, lists its members with roles and marks the caller', () => {
    const tenants = ok({ tenants: [{ tenant_id: 't1', kind: 'space', name: 'Synthetic home', role: 'member' }, { tenant_id: 't2', kind: 'org', name: 'Synthetic team', role: 'admin' }] });
    const view = VIEWS.membershipView(tenants, ok({ members: [{ user_sub: 'me', role: 'admin' }, { user_sub: 'other', role: 'member' }] }), 'me');
    expect(view.tenant).toMatchObject({ id: 't2', name: 'Synthetic team', kind: 'org', role: 'admin' });
    expect(view.members).toEqual([{ sub: 'me', role: 'admin', self: true }, { sub: 'other', role: 'member', self: false }]);
    expect(VIEWS.membershipView(ok({ tenants: [] }), null, 'me')).toMatchObject({ ok: true, tenant: null, members: [], membersStatus: 0 });
    expect(VIEWS.membershipView(refused(401), null, 'me')).toMatchObject({ ok: false, status: 401, tenant: null });
  });

  it('says where the caller is by place name and age, whether sharing is on, or why it cannot say', () => {
    expect(VIEWS.placeView(ok({ current: { ageSeconds: 300, place: { placeId: 'p', name: 'Synthetic home', label: 'home' } }, devices: [] })).text).toBe('At Synthetic home · 5 min ago');
    expect(VIEWS.placeView(ok({ current: { ageSeconds: 7200, place: null }, devices: [] })).state).toBe('located');
    expect(VIEWS.placeView(ok({ current: null, devices: [{ reportingEnabled: true }] })).text).toBe('Location sharing on · no recent place');
    expect(VIEWS.placeView(ok({ current: null, devices: [] })).text).toBe('Location sharing is off');
    expect(VIEWS.placeView(refused(403))).toMatchObject({ state: 'refused', text: 'Location is not available to this session (HTTP 403)' });
  });
});

describe('ticket workflow and spend', () => {
  it('reads stages from the registered definition with the run’s step states, and progress only from a run', () => {
    const body = { definition: { name: 'Flow', nodes: [{ id: 'a', type: 'intake', title: 'A' }, { id: 'b', type: 'review', title: 'B' }, { id: 'c', type: 'deliver', title: 'C' }] },
      run: { status: 'suspended', steps: [{ nodeId: 'a', status: 'completed' }, { nodeId: 'b', status: 'suspended' }] }, history: [], approvalGates: [], children: [] };
    const view = VIEWS.workflowView(ok(body));
    expect(view.stages.map((s: { state: string }) => s.state)).toEqual(['done', 'waiting', 'pending']);
    expect(view.progress).toEqual({ done: 1, total: 3, pct: 33 }); expect(view.current.title).toBe('B');
    const noRun = VIEWS.workflowView(ok({ ...body, run: null }));
    expect(noRun.progress).toBeNull(); expect(noRun.current).toBeNull(); expect(noRun.stages.every((s: { state: string }) => s.state === 'pending')).toBe(true);
    const runOnly = VIEWS.workflowView(ok({ definition: null, run: { status: 'error', steps: [{ nodeId: 'x', nodeTitle: 'X', nodeType: 'execute-agent', status: 'error' }] } }));
    expect(runOnly.stages).toEqual([{ id: 'x', title: 'X', type: 'execute-agent', state: 'failed' }]);
    expect(VIEWS.workflowView(refused(404))).toEqual({ ok: false, status: 404 });
  });

  it('turns the Finance summary into the last seven months of spend and names the no-data state', () => {
    const months = Array.from({ length: 9 }, (_, i) => ({ month: `2026-0${i + 1}`, spend: (i + 1) * 10, income: 0 }));
    const bars = VIEWS.spendBars(ok({ aggregate: { spendByMonth: months }, syncedAt: '2026-09-20T00:00:00.000Z' }));
    expect(bars.state).toBe('ready'); expect(bars.bars.map((b: { label: string }) => b.label)).toEqual(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
    expect(bars.bars[6]).toMatchObject({ value: 90, pct: 100 });
    expect(VIEWS.spendBars(refused(404, { error: 'no_data' }))).toMatchObject({ state: 'no-data', bars: [] });
    expect(VIEWS.spendBars(refused(503))).toMatchObject({ state: 'failed', status: 503 });
    expect(VIEWS.spendBars(ok({ aggregate: { spendByMonth: [] } })).state).toBe('empty');
  });
});
