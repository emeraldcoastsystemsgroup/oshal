/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit spec for the tickets-in-tickets live case over a scripted box double (api, named SQL, directory probe, virtual clock). Pins the PASS sequence and each named failure signature (one child titled like the root, a root complete before any child, an escalated child, too many children, children out of order, a missing handover), and the cleanup rules: children before the root, a foreign workspace never cascaded, the wait for in-flight node calls, everything kept in place when that wait runs out, and an unavailable preflight that writes nothing.
 */

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tit = require('../../scripts/lib/live-acceptance-tickets-in-tickets.js') as {
  run(ports: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ state: string; detail: string; evidence: Record<string, unknown>; cleanup: { outstanding: string[]; errors: string[]; removed: string[] } }>;
};

const OWNER = 'tit-owner-sub';
const PM = 'a0000000-0000-0000-0000-000000000001';
const CODE_DEVELOPER = 'a0000000-0000-0000-0000-000000000002';
const TEST_ENGINEER = 'a0000000-0000-0000-0000-000000000005';
const TAG = 'testlab-live-tickets-in-tickets-0a1b2c3d';
const ROOT = '10000000-0000-4000-8000-000000000001';
const KIDS = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000004',
  '20000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000006'];
const BUDGETS = { claimBudgetMs: 60_000, planningBudgetMs: 120_000, childBudgetMs: 120_000, settleBudgetMs: 60_000, residueWaitMs: 1_000, pollMs: 1_000 };

interface Ticket { ticket_id: string; parent_ticket_id: string | null; title: string; status: string; ticket_type: string; owner_sub: string; metadata: Record<string, unknown> }
interface Item { external_id: string; unit_id: string; status: string; assigned_agent_id: string | null; provider: string | null; model: string | null }

/** A scripted box: each tree read advances one step of the script; deletions are recorded in order. */
class Box {
  clock = 0;
  step = 0;
  tickets = new Map<string, Ticket>();
  history: Array<{ ticket_id: string; to_status: string; reason: string | null; message: string | null; created_at: string }> = [];
  items: Item[] = [];
  files = new Set<string>();
  shadows = new Set<string>();
  deleted: string[] = [];
  posts = 0;
  workspaceName = `workspace-${`${TAG}: two-module build`.slice(0, 50).replace(/[^a-zA-Z0-9-_]/g, '-')}`;
  workspaceCreatedAt = 10;
  constructor(readonly script: Array<(box: Box) => void>, readonly whoami = { operator: true }, readonly queued = 0) {}

  move(id: string, status: string, reason: string | null = null, message: string | null = null) {
    const ticket = this.tickets.get(id)!;
    ticket.status = status;
    this.history.push({ ticket_id: id, to_status: status, reason, message, created_at: new Date(this.clock).toISOString() });
  }
  addChild(index: number, title = `Subtask ${index}`) {
    const id = KIDS[index - 1];
    this.tickets.set(id, { ticket_id: id, parent_ticket_id: ROOT, title, status: 'approved', ticket_type: 'build', owner_sub: OWNER, metadata: { depth: 1, subtaskIndex: index } });
    this.items.push({ external_id: id, unit_id: `${id}-unit-1`, status: 'pending', assigned_agent_id: null, provider: null, model: null });
    this.shadows.add(id);
  }
  completeChild(index: number, agent = CODE_DEVELOPER, handover = true) {
    const id = KIDS[index - 1];
    const unit = this.items.find((i) => i.unit_id === `${id}-unit-1`)!;
    Object.assign(unit, { status: 'completed', assigned_agent_id: agent, provider: 'antigravity-cli', model: 'node-model' });
    if (handover) this.files.add(`developer-handovers/${id}--${agent}_PHASE_1_ROUND_1.md`);
    this.files.add(`deliverables/src/step-${index}.ts`);
    this.move(id, 'complete');
  }
  advance() {
    if (this.step < this.script.length) this.script[this.step++](this);
  }
}

const CLAIM = (box: Box) => box.move(ROOT, 'in_process_discovery');
const PLAN = (n: number) => (box: Box) => {
  box.items.push({ external_id: ROOT, unit_id: `${ROOT}-phase-2-round-1`, status: 'completed', assigned_agent_id: PM, provider: null, model: null });
  for (let i = 1; i <= n; i += 1) box.addChild(i);
  box.files.add('IMPLEMENTATION-PLAN.md');
  box.move(ROOT, 'approval_required', 'planning_complete');
};
const RUN_CHILD = (index: number, agent = CODE_DEVELOPER, handover = true) => [
  (box: Box) => box.move(KIDS[index - 1], 'in_process_build'),
  (box: Box) => box.completeChild(index, agent, handover),
];
const ASSEMBLE = (box: Box) => box.move(ROOT, 'customer_action');
const PASS_SCRIPT = [CLAIM, PLAN(2), ...RUN_CHILD(1), ...RUN_CHILD(2, TEST_ENGINEER), ASSEMBLE];

/**
 * @description The ports a runner binds, over the box.
 * @param box - The scripted box.
 * @returns The ports.
 */
function ports(box: Box) {
  return {
    ownerSub: OWNER,
    now: () => box.clock,
    sleep: async (ms: number) => { box.clock += ms; },
    api: async (method: string, route: string) => api(box, method, route),
    sql: async (name: string) => ({ rows: sql(box, name) }),
    files: { dir: async (_name: string, id: string) => dir(box, id) },
  };
}

function ticketJson(box: Box, id: string) {
  const ticket = box.tickets.get(id);
  return ticket ? { ticketId: id, title: ticket.title, createdAt: new Date(20).toISOString(), workspaceId: id === ROOT ? 'ws-1' : null, status: ticket.status } : null;
}

function api(box: Box, method: string, route: string): { status: number; json: Record<string, unknown> } {
  const url = new URL(route, 'http://box');
  const id = url.pathname.split('/')[3];
  if (route === '/api/cli-tokens/whoami') return { status: 200, json: box.whoami };
  if (method === 'GET' && route.startsWith('/api/tickets?status=approved')) return { status: 200, json: { tickets: Array.from({ length: box.queued }, () => ({})) } };
  if (method === 'GET' && route.startsWith('/api/tickets?status=backlog')) {
    return { status: 200, json: { tickets: [...box.shadows].map((externalId) => ({ ticketId: `shadow-${externalId}`, externalProvider: 'direct', externalId, ownerSub: null })) } };
  }
  if (method === 'POST' && route === '/api/tickets') return post(box);
  if (method === 'PUT') return { status: 400, json: {} };
  if (method === 'DELETE' && id) return del(box, id);
  if (method === 'GET' && route.startsWith('/api/workspaces/')) return { status: 200, json: { name: box.workspaceName, createdAt: new Date(box.workspaceCreatedAt + 20).toISOString() } };
  if (method === 'GET' && route.startsWith('/api/v1/tickets/')) return { status: 200, json: { usage: { totalCost: 0.25, totalTokens: 1200 } } };
  if (method === 'GET' && id) {
    if (id.startsWith('shadow-')) return box.shadows.has(id.slice(7)) ? { status: 200, json: {} } : { status: 404, json: {} };
    const json = ticketJson(box, id);
    return json ? { status: 200, json } : { status: 404, json: {} };
  }
  return { status: 404, json: {} };
}

function post(box: Box) {
  box.posts += 1;
  box.tickets.set(ROOT, { ticket_id: ROOT, parent_ticket_id: null, title: `${TAG}: two-module build`, status: 'approved', ticket_type: 'build', owner_sub: OWNER, metadata: {} });
  return { status: 201, json: { ticketId: ROOT } };
}

function del(box: Box, id: string) {
  box.deleted.push(id);
  if (id.startsWith('shadow-')) box.shadows.delete(id.slice(7));
  else box.tickets.delete(id);
  if (id === ROOT) box.files.clear();
  return { status: 200, json: { status: 'deleted' } };
}

function sql(box: Box, name: string): unknown[] {
  const tree = [...box.tickets.values()].filter((t) => t.ticket_id === ROOT || t.parent_ticket_id === ROOT);
  if (name === 'tickets-in-tickets.tree') { box.advance(); return box.tickets.has(ROOT) ? tree : []; }
  if (name === 'tickets-in-tickets.history') return box.history;
  if (name === 'tickets-in-tickets.work-items') return box.items;
  if (name === 'tickets-in-tickets.delete-leftovers') { const count = box.items.length; box.items = []; return [{ work_items: count }]; }
  if (name === 'tickets-in-tickets.residue') return [{ tickets: tree.length, work_items: box.items.length }];
  throw new Error(`unexpected statement ${name}`);
}

function dir(box: Box, id: string) {
  if (id !== ROOT || !box.tickets.has(ROOT) || box.files.size === 0) return { path: `/ws/${id}`, exists: false, files: [], truncated: false };
  return { path: `/ws/${id}`, exists: true, files: [...box.files].sort(), truncated: false };
}

const runBox = (box: Box) => tit.run(ports(box), { ...BUDGETS, tag: TAG });

describe('tickets-in-tickets live case', () => {
  it('passes the full sequence and leaves nothing behind but the kept cost rows', async () => {
    const box = new Box(PASS_SCRIPT);
    const result = await runBox(box);
    expect(result.state, result.detail).toBe('pass');
    expect(result.cleanup.outstanding).toEqual([]);
    expect(result.cleanup.errors).toEqual([]);
    expect(box.tickets.size).toBe(0);
    expect(box.shadows.size).toBe(0);
    expect(box.deleted.indexOf(ROOT)).toBe(box.deleted.length - 1);
    expect((result.evidence.children as unknown[])).toHaveLength(2);
  });

  it.each([
    ['one child titled like the root', [CLAIM, (box: Box) => { PLAN(0)(box); box.addChild(1, `${TAG}: two-module build`); }], 'planning produced one child titled like the root'],
    ['a root complete before any child', [CLAIM, (box: Box) => box.move(ROOT, 'complete')], 'the root reached complete before any child existed'],
    ['an escalated child', [CLAIM, PLAN(2), (box: Box) => box.move(KIDS[0], 'escalated', 'swarm_worker_execution_failed', 'node refused')], 'reached escalated (swarm_worker_execution_failed: node refused)'],
    ['too many children', [CLAIM, PLAN(6)], 'planning produced 6 children (expected 2-5)'],
    ['children out of order', [CLAIM, PLAN(2), (box: Box) => box.move(KIDS[1], 'in_process_build'), (box: Box) => box.completeChild(2), ...RUN_CHILD(1), ASSEMBLE], 'entered in_process_build before child'],
    ['a missing handover', [CLAIM, PLAN(2), ...RUN_CHILD(1), ...RUN_CHILD(2, TEST_ENGINEER, false), ASSEMBLE], `no developer handover starts with ${KIDS[1]}--`],
  ])('fails by name on %s, and still cleans up', async (_label, script, signature) => {
    const box = new Box(script as Array<(box: Box) => void>);
    const result = await runBox(box);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(signature);
    expect(box.tickets.size).toBe(0);
  });

  it('never cascades the root into a workspace this run did not create', async () => {
    const box = new Box(PASS_SCRIPT);
    box.workspaceCreatedAt = -1_000_000;
    const result = await runBox(box);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('the root is linked to a workspace older than the root');
    expect(box.deleted).not.toContain(ROOT);
    expect(box.deleted).toEqual(expect.arrayContaining(KIDS.slice(0, 2)));
  });

  it('waits for a child node call to return before removing anything', async () => {
    const box = new Box([CLAIM, PLAN(2), (b: Box) => { b.move(KIDS[0], 'in_process_build'); b.items[1].status = 'assigned'; }]);
    const p = ports(box);
    let cancels = 0;
    let readsAfterCancel = 0;
    let deletedBeforeRelease = -1;
    const api0 = p.api;
    p.api = async (method: string, route: string) => { if (method === 'PUT') cancels += 1; return api0(method, route); };
    const sql0 = p.sql;
    p.sql = async (name: string) => {
      // The node call returns on the third read after cleanup cancelled the tree.
      if (name === 'tickets-in-tickets.work-items' && cancels > 0 && ++readsAfterCancel === 3) {
        deletedBeforeRelease = box.deleted.length;
        box.items[1].status = 'failed';
      }
      return sql0(name);
    };
    const result = await tit.run(p, { ...BUDGETS, planningBudgetMs: 5_000, childBudgetMs: 2_000, tag: TAG });
    expect(result.state).toBe('fail');
    expect(readsAfterCancel).toBeGreaterThanOrEqual(3);
    expect(deletedBeforeRelease).toBe(0);
    expect(box.deleted).toEqual(expect.arrayContaining([...KIDS.slice(0, 2), ROOT]));
    expect(result.detail).not.toContain('was still running');
  });

  it('keeps the root, its children and the folder in place when a node call never returns', async () => {
    const box = new Box([CLAIM, PLAN(2), (b: Box) => { b.move(KIDS[0], 'in_process_build'); b.items[1].status = 'assigned'; }]);
    const result = await tit.run(ports(box), { ...BUDGETS, planningBudgetMs: 5_000, childBudgetMs: 2_000, settleBudgetMs: 3_000, tag: TAG });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('was still running');
    expect(box.deleted).toEqual([]);
    expect(box.tickets.has(ROOT)).toBe(true);
  });

  it.each([
    ['a non-operator caller', { operator: false }, 0, 'the caller is not an operator'],
    ['a queued build ticket', { operator: true }, 1, '1 approved build ticket(s) are already queued'],
  ])('reports %s as unavailable and writes nothing', async (_label, whoami, queued, gap) => {
    const box = new Box(PASS_SCRIPT, whoami, queued);
    const result = await runBox(box);
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain(gap);
    expect(box.posts).toBe(0);
  });
});
