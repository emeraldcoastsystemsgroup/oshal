/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The review fixes: the wait also covers the root's planning round; a cleanup call that throws is recorded while the rest of the cleanup still runs; the root is kept when a child could not be removed; an in-process build ticket defers the run; a filing whose reply was lost is found by its tag and cleaned up; the interrupt hook cancels the tree and names the cleanup command; a cleanup-only run removes an earlier root and refuses a root that is not this case's; a shadow left after the deletes is reported.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The box answers the cockpit hierarchy, the child detail and the code-server handoff; the PASS sequence requires them, and a hierarchy that drops the children or a handoff that does not redirect fails by name.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | A 401 on the settle re-read is reported as "could not be re-checked", never as "readable again".
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The post-cleanup re-reads retry an inconclusive answer: one that times out once and then answers is clean; one that stays refused is an error naming the attempts.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit spec for the tickets-in-tickets live case over a scripted box double (api, named SQL, directory probe, virtual clock). Pins the PASS sequence and each named failure signature (one child titled like the root, a root complete before any child, an escalated child, too many children, children out of order, a missing handover), and the cleanup rules: children before the root, a foreign workspace never cascaded, the wait for in-flight node calls, everything kept in place when that wait runs out, and an unavailable preflight that writes nothing.
 */

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
type CaseResult = { state: string; detail: string; evidence: Record<string, unknown>; cleanup: { outstanding: string[]; errors: string[]; removed: string[] } };
const tit = require('../../scripts/lib/live-acceptance-tickets-in-tickets.js') as {
  run(ports: Record<string, unknown>, options?: Record<string, unknown>): Promise<CaseResult>;
  cleanupRoot(ports: Record<string, unknown>, rootId: string, options?: Record<string, unknown>): Promise<CaseResult>;
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
const BUDGETS = { claimBudgetMs: 60_000, planningBudgetMs: 120_000, childBudgetMs: 120_000, settleBudgetMs: 60_000, residueWaitMs: 1_000, pollMs: 1_000, recheckPauseMs: 500 };

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
  cancelled: string[] = [];
  posts = 0;
  /** DELETE answers for named ids, when a delete must fail. */
  deleteStatus = new Map<string, number>();
  /** A build-ticket state the box reports busy, for the preflight. */
  busy: string | null = null;
  /** When set, the cockpit hierarchy lists the root without its children. */
  hideChildren = false;
  /** When set, the code-server handoff answers 200 instead of redirecting. */
  noCodeRedirect = false;
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

function api(box: Box, method: string, route: string): { status: number; json: Record<string, unknown>; location?: string } {
  const url = new URL(route, 'http://box');
  const id = url.pathname.split('/')[3];
  if (route === '/api/cli-tokens/whoami') return { status: 200, json: box.whoami };
  if (method === 'GET' && route.startsWith('/api/tickets?status=approved')) return { status: 200, json: { tickets: Array.from({ length: box.queued }, () => ({})) } };
  if (method === 'GET' && route.startsWith('/api/tickets?status=backlog')) {
    const offset = Number(url.searchParams.get('offset') || 0);
    const tickets = offset > 0 ? [] : [...box.shadows].map((externalId) => ({ ticketId: `shadow-${externalId}`, externalProvider: 'direct', externalId, ownerSub: null }));
    return { status: 200, json: { tickets } };
  }
  if (method === 'GET' && route.startsWith('/api/tickets?status=')) {
    return { status: 200, json: { tickets: url.searchParams.get('status') === box.busy ? [{}] : [] } };
  }
  if (method === 'POST' && route === '/api/tickets') return post(box);
  if (method === 'PUT' && id && box.tickets.has(id)) { box.cancelled.push(id); box.move(id, 'cancelled'); return { status: 200, json: {} }; }
  if (method === 'PUT') return { status: 400, json: {} };
  if (method === 'DELETE' && id) return del(box, id);
  if (method === 'GET' && route.startsWith('/api/workspaces/')) return { status: 200, json: { name: box.workspaceName, createdAt: new Date(box.workspaceCreatedAt + 20).toISOString() } };
  if (method === 'GET' && route.startsWith('/api/v1/tickets/hierarchy')) {
    if (!box.tickets.has(ROOT)) return { status: 200, json: { tickets: [] } };
    const children = box.hideChildren ? [] : [...box.tickets.values()].filter((t) => t.parent_ticket_id === ROOT).map((t) => ({ id: t.ticket_id, parentId: ROOT, children: [] }));
    return { status: 200, json: { tickets: [{ id: ROOT, parentId: null, children, childCount: children.length }] } };
  }
  if (method === 'GET' && route.startsWith('/api/v1/tickets/') && route.endsWith('/activity')) return { status: 200, json: { usage: { totalCost: 0.25, totalTokens: 1200 } } };
  if (method === 'GET' && route.startsWith('/api/v1/tickets/')) {
    const ticket = box.tickets.get(url.pathname.split('/')[4]);
    return ticket ? { status: 200, json: { ticket: { ticketId: ticket.ticket_id, parentTicketId: ticket.parent_ticket_id, status: ticket.status } } } : { status: 404, json: {} };
  }
  if (method === 'GET' && route.startsWith('/code?folder=')) {
    const folder = decodeURIComponent(route.slice('/code?folder='.length));
    return box.noCodeRedirect ? { status: 200, json: {} } : { status: 302, json: {}, location: `http://code-server.invalid/?folder=${encodeURIComponent(folder)}` };
  }
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
  const refused = box.deleteStatus.get(id);
  if (refused) return { status: refused, json: {} };
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
  if (name === 'tickets-in-tickets.residue') return [{ tickets: tree.length, work_items: box.items.length, swarm_runs: 0 }];
  if (name === 'tickets-in-tickets.find-root') return box.tickets.has(ROOT) ? [{ ticket_id: ROOT }] : [];
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
    expect(result.evidence.codeFolder).toBe(`http://code-server.invalid/?folder=/workspace/${ROOT}`);
  });

  it.each([
    ['a hierarchy that drops the children', (box: Box) => { box.hideChildren = true; }, 'the cockpit hierarchy lists 0 child row(s) under the root, not its 2 children'],
    ['a code-server handoff that does not redirect', (box: Box) => { box.noCodeRedirect = true; }, 'the code-server handoff for the root folder answered HTTP 200, not a redirect onto the root folder'],
  ])('fails by name on %s, and still cleans up', async (_label, arrange, signature) => {
    const box = new Box(PASS_SCRIPT);
    arrange(box);
    const result = await runBox(box);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(signature);
    expect(box.tickets.size).toBe(0);
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

  it('defers the run while a build ticket is in flight, and writes nothing', async () => {
    const box = new Box(PASS_SCRIPT);
    box.busy = 'in_process_build';
    const result = await runBox(box);
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('a build ticket is in_process_build');
    expect(box.posts).toBe(0);
  });

  it('waits for the root planning round to return before removing anything', async () => {
    const box = new Box([CLAIM, (b: Box) => { b.items.push({ external_id: ROOT, unit_id: `${ROOT}-phase-2-round-1`, status: 'assigned', assigned_agent_id: PM, provider: null, model: null }); }]);
    const p = ports(box);
    let cancels = 0;
    let readsAfterCancel = 0;
    let deletedBeforeReturn = -1;
    const api0 = p.api;
    p.api = async (method: string, route: string) => { if (method === 'PUT') cancels += 1; return api0(method, route); };
    const sql0 = p.sql;
    p.sql = async (name: string) => {
      if (name === 'tickets-in-tickets.work-items' && cancels > 0 && ++readsAfterCancel === 3) {
        deletedBeforeReturn = box.deleted.length;
        box.items[0].status = 'completed';
      }
      return sql0(name);
    };
    const result = await tit.run(p, { ...BUDGETS, planningBudgetMs: 3_000, tag: TAG });
    expect(result.state).toBe('fail');
    expect(readsAfterCancel).toBeGreaterThanOrEqual(3);
    expect(deletedBeforeReturn).toBe(0);
    expect(box.deleted).toContain(ROOT);
  });

  it('records a cleanup call that throws and still removes the rest', async () => {
    const box = new Box(PASS_SCRIPT);
    const p = ports(box);
    const sql0 = p.sql;
    p.sql = async (name: string) => { if (name === 'tickets-in-tickets.delete-leftovers') throw new Error('helper exec timed out'); return sql0(name); };
    const result = await tit.run(p, { ...BUDGETS, tag: TAG });
    expect(result.state).toBe('fail');
    expect(result.cleanup.errors).toEqual(expect.arrayContaining([expect.stringContaining('leftover rows delete failed: helper exec timed out')]));
    expect(box.deleted).toEqual(expect.arrayContaining([...KIDS.slice(0, 2), ROOT]));
    expect(box.tickets.size).toBe(0);
  });

  it('keeps the root and its folder when a child could not be removed', async () => {
    const box = new Box(PASS_SCRIPT);
    box.deleteStatus.set(KIDS[1], 500);
    const result = await runBox(box);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`deleting ticket ${KIDS[1]} answered HTTP 500`);
    expect(result.detail).toContain('the root and its folder were kept');
    expect(box.deleted).not.toContain(ROOT);
    expect(box.tickets.has(ROOT)).toBe(true);
    expect(result.cleanup.outstanding).toEqual(expect.arrayContaining([`ticket ${ROOT}`, `ticket ${KIDS[1]}`]));
  });

  it('finds a root whose filing reply was lost by its tag, and cleans it up', async () => {
    const box = new Box(PASS_SCRIPT);
    const p = ports(box);
    const api0 = p.api;
    p.api = async (method: string, route: string) => {
      if (method === 'POST' && route === '/api/tickets') { post(box); throw new Error('The operation was aborted due to timeout'); }
      return api0(method, route);
    };
    const result = await tit.run(p, { ...BUDGETS, tag: TAG });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('POST /api/tickets failed: The operation was aborted due to timeout');
    expect(result.evidence.rootId).toBe(ROOT);
    expect(box.deleted).toContain(ROOT);
    expect(result.cleanup.outstanding).toEqual([]);
  });

  it('reports the root id as soon as it is filed, and an interrupt cancels the tree and names the cleanup command', async () => {
    const box = new Box([CLAIM, PLAN(2), ...RUN_CHILD(1), ...RUN_CHILD(2, TEST_ENGINEER), ASSEMBLE]);
    const notes: string[] = [];
    let interrupt: (() => Promise<void>) | null = null;
    let released = false;
    const p = { ...ports(box), note: (line: string) => notes.push(line), onInterrupt: (fn: () => Promise<void>) => { interrupt = fn; return () => { released = true; }; } };
    const sql0 = p.sql;
    p.sql = async (name: string) => {
      const rows = await sql0(name);
      if (name === 'tickets-in-tickets.tree' && box.step === 2 && interrupt) { await interrupt(); interrupt = null; }
      return rows;
    };
    const result = await tit.run(p, { ...BUDGETS, tag: TAG });
    expect(notes[0]).toContain(`root ${ROOT} filed as`);
    expect(notes[0]).toContain(`--cleanup-root=${ROOT}`);
    expect(box.cancelled).toEqual(expect.arrayContaining([KIDS[0], KIDS[1], ROOT]));
    expect(notes.some((line) => line.includes('run interrupted') && line.includes(`--cleanup-root=${ROOT}`))).toBe(true);
    expect(released).toBe(true);
    expect(result.state).toBe('fail');
    expect(box.tickets.size).toBe(0);
  });

  it('a cleanup-only run removes an earlier root with everything under it', async () => {
    const box = new Box([CLAIM, PLAN(2), ...RUN_CHILD(1)]);
    post(box);
    for (let i = 0; i < 4; i += 1) box.advance();
    const result = await tit.cleanupRoot(ports(box), ROOT, BUDGETS);
    expect(result.state, result.detail).toBe('pass');
    expect(result.cleanup.outstanding).toEqual([]);
    expect(box.tickets.size).toBe(0);
    expect(box.shadows.size).toBe(0);
    expect(box.deleted.indexOf(ROOT)).toBe(box.deleted.length - 1);
  });

  it('a cleanup-only run touches nothing for a root that is not this case\'s, and refuses a bad id', async () => {
    const box = new Box([]);
    box.tickets.set(ROOT, { ticket_id: ROOT, parent_ticket_id: null, title: 'Somebody else\'s build', status: 'approved', ticket_type: 'build', owner_sub: 'other', metadata: {} });
    const p = ports(box);
    p.sql = async (name: string) => (name === 'tickets-in-tickets.tree' ? { rows: [] } : { rows: [] });
    const result = await tit.cleanupRoot(p, ROOT, BUDGETS);
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`ticket ${ROOT} is not a root this case filed for this caller (HTTP 200); nothing was touched`);
    expect(box.deleted).toEqual([]);
    expect(box.cancelled).toEqual([]);
    const refused = await tit.cleanupRoot(ports(box), 'NOT-A-UUID', BUDGETS);
    expect(refused.state).toBe('fail');
    expect(refused.detail).toContain('is not a lower-case ticket UUID');
  });

  it('reports a settle re-read the api refused as not re-checked, never as readable again', async () => {
    const box = new Box(PASS_SCRIPT);
    const p = ports(box);
    // The settle wait is the only sleep of this length; after it the api refuses every ticket read.
    let settled = false;
    const sleep0 = p.sleep;
    p.sleep = async (ms: number) => { if (ms === 2_500) settled = true; return sleep0(ms); };
    const api0 = p.api;
    p.api = async (method: string, route: string) => (settled && method === 'GET' && /^\/api\/tickets\/[0-9a-f-]+$/.test(route) ? { status: 401, json: {} } : api0(method, route));
    const result = await tit.run(p, { ...BUDGETS, residueWaitMs: 2_500, tag: TAG });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`ticket ${ROOT} could not be re-checked after the settle wait (HTTP 401, 4 attempts)`);
    expect(result.detail).not.toContain('readable again');
    expect(box.tickets.size).toBe(0);
  });

  it('a re-read that times out once and then answers is clean', async () => {
    const box = new Box(PASS_SCRIPT);
    const p = ports(box);
    let settled = false;
    const timedOut = new Set<string>();
    const sleep0 = p.sleep;
    p.sleep = async (ms: number) => { if (ms === 2_500) settled = true; return sleep0(ms); };
    const api0 = p.api;
    p.api = async (method: string, route: string) => {
      // After the settle wait the api is stalled: the first read of each route times out, the next answers.
      if (settled && method === 'GET' && !timedOut.has(route)) { timedOut.add(route); throw new Error('The operation was aborted due to timeout'); }
      return api0(method, route);
    };
    const result = await tit.run(p, { ...BUDGETS, residueWaitMs: 2_500, tag: TAG });
    expect(result.state, result.detail).toBe('pass');
    expect(result.cleanup.errors).toEqual([]);
    expect(timedOut.size).toBeGreaterThanOrEqual(4);
  });

  it('reports a shadow ticket that remains after the deletes', async () => {
    const box = new Box(PASS_SCRIPT);
    const p = ports(box);
    const api0 = p.api;
    let listings = 0;
    p.api = async (method: string, route: string) => {
      if (method === 'GET' && route.startsWith('/api/tickets?status=backlog') && ++listings === 2) box.shadows.add(KIDS[0]);
      return api0(method, route);
    };
    const result = await tit.run(p, { ...BUDGETS, tag: TAG });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain("1 shadow ticket(s) remain for the run's ids after the settle wait");
  });
});
