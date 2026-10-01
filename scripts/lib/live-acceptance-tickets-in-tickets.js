/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes before the first live run. The preflight also refuses while any build ticket is in an in-process state, not only when one is queued. A filing whose reply was lost (a timeout after the insert) is found by the title only this run minted, so it is still cleaned up. The root id and the cleanup-only command are reported as soon as the root is filed, and an interrupted run cancels its tickets through the runner's interrupt hook. A cleanup-only entry point (`cleanupRoot`) finishes an interrupted run by its root id. A cleanup that throws is recorded, not lost.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The tickets-in-tickets live case: files one tagged build root as the operator and requires it to be planned in-process (in_process_discovery, then approval_required with planning_complete, IMPLEMENTATION-PLAN.md in its folder), decomposed into 2-5 owned children in planning order, each child run to completion one at a time by a build-lane bot over the signed hop, and the root assembled to customer_action, with no plan-reviewer or Phase-8 round. Cleanup cancels, waits for in-flight node calls, removes the work items and other leftovers anchored to the root, the children, the shadow tickets and the root with its folder, and proves each gone.
 */

'use strict';

const common = require('./live-acceptance-common.js');
const { cleanup, readTree, cancelUnfinished } = require('./live-acceptance-tickets-in-tickets-cleanup.js');

const CASE_ID = 'tickets-in-tickets-live';
const KEY = 'tickets-in-tickets';
const TITLE = 'Tickets in tickets: a build root is planned in-process, its children run one at a time over the signed hop, and the root assembles';
const NEEDS = Object.freeze(['api', 'sql', 'ownerSub', 'files']);
const PM_ID = 'a0000000-0000-0000-0000-000000000001';
/** The build-lane execution targets (signed-child-dispatch.ts BUILD_EXECUTION_TARGETS). */
const BUILD_TARGETS = Object.freeze(new Set([
  'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000004',
  'a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000008', 'a0000000-0000-0000-0000-00000000000c',
  'a0000000-0000-0000-0000-00000000000e', 'a0000000-0000-0000-0000-000000000018', 'a0000000-0000-0000-0000-000000000099',
]));
/** The specs that guard each seam this case crosses live; the Lab card lists them. */
const REGRESSION_TESTS = Object.freeze([
  'controller-pm-hosted-brain-postgres', 'planning-output-source', 'child-ticket-owner-inheritance-postgres',
  'build-child-dispatch-gate', 'signed-swarm-child-dispatch', 'swarm-verification-enforced-fallback',
  'internal-machinery-scoping', 'bot-node-workspace-owner-binding',
].map((name) => Object.freeze({ level: 'unit', path: `tests/unit/${name}.spec.ts` })));
const DEFAULT_BUDGETS = Object.freeze({
  claimBudgetMs: 180_000, planningBudgetMs: 1_200_000, childBudgetMs: 1_500_000,
  settleBudgetMs: 3_900_000, residueWaitMs: 120_000, pollMs: 15_000,
});
const CHILDREN = Object.freeze({ min: 2, max: 5 });
const ROOT_FAILED = new Set(['escalated', 'dead_letter', 'cancelled']);
const CHILD_DONE = new Set(['complete', 'customer_action']);
const RELEASES_NEXT = new Set(['complete', 'customer_action', 'cancelled']);
const KEPT_ROWS = 'cost rows (the <ticket>::<agent> rollups and oshal_cost_events), Arango ticket nodes, queued-principal rows and mesh stream entries have no removal route';
/** Build-ticket states that share the build lane and its nodes with this run; any of them defers the run. */
const BUSY_STATES = Object.freeze(['approved', 'in_process_discovery', 'in_process_design', 'in_process_build', 'in_process_deploy', 'in_process_test', 'in_process_release']);
/** A lower-case ticket UUID, the only root id a cleanup-only run accepts. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @description The command that finishes an interrupted run's cleanup by its root id.
 * @param {string} rootId - The root.
 * @returns {string} The host command.
 */
function cleanupCommand(rootId) {
  return `node scripts/operations/live-acceptance.js ${KEY} --cleanup-root=${rootId}`;
}

/**
 * @description Report a line through the runner's note port, where one is bound.
 * @param {object} io - Ports.
 * @param {string} line - The line.
 * @returns {void}
 */
function note(io, line) {
  if (typeof io.note === 'function') io.note(line);
}

/**
 * @description The build the root asks for: two dependent steps and suggested roles, under 500 characters.
 * @param {string} tag - The run tag.
 * @returns {string} The ticket description.
 */
function describeBuild(tag) {
  return `Live-acceptance fixture (${tag}). Two dependent steps. Step 1: write deliverables/src/slugify.ts exporting slugify(text), `
    + 'which lower-cases the text and joins its words with hyphens. Step 2: write deliverables/src/slugify.test.ts, which imports '
    + 'slugify from ./slugify and checks three inputs. Suggested roles: code-developer for step 1, test-engineer for step 2.';
}

/**
 * @description Why this run cannot start here, or null. Writes nothing.
 * @param {object} io - Ports.
 * @returns {Promise<string|null>} The gap.
 */
async function preflight(io) {
  const who = await io.api('GET', '/api/cli-tokens/whoami');
  if (who.status !== 200) return `GET /api/cli-tokens/whoami answered HTTP ${who.status}`;
  if (!who.json || who.json.operator !== true) {
    return 'the caller is not an operator, and the shadow tickets a build leaves can only be removed through operator routes';
  }
  for (const status of BUSY_STATES) {
    const limit = status === 'approved' ? '' : '&limit=1';
    const res = await io.api('GET', `/api/tickets?status=${status}&ticketType=build&scope=all${limit}`);
    if (res.status !== 200) return `listing ${status} build tickets answered HTTP ${res.status}`;
    const count = Array.isArray(res.json && res.json.tickets) ? res.json.tickets.length : 0;
    if (count === 0) continue;
    return status === 'approved'
      ? `${count} approved build ticket(s) are already queued, and this run would share the build lane with them`
      : `a build ticket is ${status}, and this run would share the build lane and its nodes with it`;
  }
  return null;
}

/**
 * @description File the tagged build root as the caller.
 * @param {object} io - Ports.
 * @param {string} tag - The run tag.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{id?: string, title: string, error?: string}>} The root, or why it was not filed.
 */
async function fileRoot(io, tag, ledger) {
  const title = `${tag}: two-module build`;
  let res;
  try {
    res = await io.api('POST', '/api/tickets', {
      title, description: describeBuild(tag), ticketType: 'build', status: 'approved', priority: 'low', metadata: { liveAcceptance: true },
    });
  } catch (error) {
    // The reply was lost (a timeout after the insert committed is the usual shape): the root may
    // exist, and it is found by the title only this run minted.
    const found = await io.sql('tickets-in-tickets.find-root', [io.ownerSub, title]).catch(() => ({ rows: [] }));
    const id = found.rows[0] && found.rows[0].ticket_id;
    if (id) ledger.created('ticket', id, 'the build root (its POST failed on the way back)');
    return { title, ...(id ? { id } : {}), error: `POST /api/tickets failed: ${common.errorText(error)}` };
  }
  const id = res.json && res.json.ticketId;
  if (!id) return { title, error: `POST /api/tickets answered HTTP ${res.status}${res.json && res.json.error ? `: ${res.json.error}` : ''}` };
  ledger.created('ticket', id, 'the build root');
  return { id, title };
}

/**
 * @description One read of the run: the root, its children in planning order, their history and work items.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @returns {Promise<{root: object|null, children: object[], history: object[], items: object[]}>} The snapshot.
 */
async function observe(io, rootId) {
  const params = [io.ownerSub, rootId];
  const [tree, history, items] = await Promise.all([
    io.sql('tickets-in-tickets.tree', params),
    io.sql('tickets-in-tickets.history', params),
    io.sql('tickets-in-tickets.work-items', params),
  ]);
  const children = tree.rows.filter((row) => row.parent_ticket_id === rootId)
    .sort((a, b) => subtaskIndex(a) - subtaskIndex(b));
  return { root: tree.rows.find((row) => row.ticket_id === rootId) || null, children, history: history.rows, items: items.rows };
}

/**
 * @description A child's planning order, or 0 when it has none.
 * @param {{metadata?: object}} ticket - A ticket row.
 * @returns {number} Its subtaskIndex.
 */
function subtaskIndex(ticket) {
  const value = Number(ticket && ticket.metadata && ticket.metadata.subtaskIndex);
  return Number.isInteger(value) ? value : 0;
}

/**
 * @description The reason a ticket last entered a status, from its history, for a failure line.
 * @param {object[]} history - History rows.
 * @param {string} ticketId - The ticket.
 * @param {string} status - The status.
 * @returns {string} ` (reason: message)` or ''.
 */
function reasonFor(history, ticketId, status) {
  const row = [...history].reverse().find((h) => h.ticket_id === ticketId && h.to_status === status);
  const words = row ? [row.reason, row.message].filter(Boolean).join(': ') : '';
  return words ? ` (${words.slice(0, 300)})` : '';
}

/**
 * @description The named signature of a run that has already failed, or null.
 * @param {Awaited<ReturnType<typeof observe>>} snap - The snapshot.
 * @returns {string|null} The failure.
 */
function earlyFailure(snap) {
  const { root, children, history } = snap;
  if (!root) return 'the root ticket is no longer readable';
  if (ROOT_FAILED.has(root.status)) return `the root reached ${root.status}${reasonFor(history, root.ticket_id, root.status)}`;
  if (root.status === 'complete' && children.length === 0) return 'the root reached complete before any child existed';
  if (children.length === 1 && children[0].title === root.title) return 'planning produced one child titled like the root (no decomposition)';
  const escalated = children.find((child) => child.status === 'escalated' || child.status === 'dead_letter');
  return escalated ? `child ${escalated.ticket_id} reached ${escalated.status}${reasonFor(history, escalated.ticket_id, escalated.status)}` : null;
}

/** @description Planning has finished: the root parked at approval_required (planning_complete) with children. */
function planned(snap) {
  return snap.children.length > 0 && snap.history.some((h) => h.ticket_id === snap.root.ticket_id
    && h.to_status === 'approval_required' && h.reason === 'planning_complete');
}

/** @description The tree has finished: every child released and the root assembled. */
function finished(snap) {
  return snap.children.length > 0 && snap.children.every((child) => RELEASES_NEXT.has(child.status))
    && snap.root.status === 'customer_action';
}

/**
 * @description Poll the run until `done`, a named failure, or the budget runs out.
 * @param {object} io - Ports.
 * @param {number} budgetMs - The budget.
 * @param {string} rootId - The root.
 * @param {(snap: object) => boolean} done - The phase's completion test.
 * @param {(snap: object) => void} onSnapshot - Called with every snapshot (for the ledger).
 * @returns {Promise<{done: boolean, snap: object, failure: string|null}>} The outcome.
 */
async function awaitPhase(io, budgetMs, rootId, done, onSnapshot) {
  const outcome = await common.pollUntil(io, { budgetMs, pollMs: io.budgets.pollMs }, async () => {
    const snap = await observe(io, rootId);
    onSnapshot(snap);
    const failure = earlyFailure(snap);
    return { done: Boolean(failure) || done(snap), value: { snap, failure } };
  });
  return { done: outcome.done && !outcome.value.failure, snap: outcome.value.snap, failure: outcome.value.failure };
}

/**
 * @description What is wrong with the planning outcome: the root's history and the children's shape.
 * @param {object} snap - A planned snapshot.
 * @param {string} rootTitle - The root's title.
 * @param {string} ownerSub - The caller.
 * @returns {string[]} Findings; empty when planning is right.
 */
function judgePlanning(snap, rootTitle, ownerSub) {
  const findings = [];
  const rootMoves = snap.history.filter((h) => h.ticket_id === snap.root.ticket_id).map((h) => h.to_status);
  const discovery = rootMoves.indexOf('in_process_discovery');
  if (discovery < 0 || rootMoves.indexOf('approval_required', discovery) < 0) findings.push(`the root moved ${rootMoves.join(' -> ')}, not in_process_discovery then approval_required`);
  const { children } = snap;
  if (children.length < CHILDREN.min || children.length > CHILDREN.max) findings.push(`planning produced ${children.length} children (expected ${CHILDREN.min}-${CHILDREN.max})`);
  if (new Set(children.map((c) => c.title)).size !== children.length) findings.push('two children share a title');
  for (const [index, child] of children.entries()) {
    const label = `child ${child.ticket_id}`;
    if (child.title === rootTitle) findings.push(`${label} is titled like the root`);
    if (child.ticket_type !== 'build') findings.push(`${label} has ticket type ${child.ticket_type}`);
    if (Number(child.metadata && child.metadata.depth) !== 1) findings.push(`${label} is not at depth 1`);
    if (child.owner_sub !== ownerSub) findings.push(`${label} is not owned by the caller`);
    if (subtaskIndex(child) !== index + 1) findings.push(`${label} has subtaskIndex ${subtaskIndex(child)} where ${index + 1} was expected`);
  }
  return findings;
}

/**
 * @description When a ticket first entered a status (ms), or null.
 * @param {object[]} history - History rows.
 * @param {string} ticketId - The ticket.
 * @param {Set<string>|string} statuses - The status or statuses.
 * @returns {number|null} The time.
 */
function firstEntry(history, ticketId, statuses) {
  const wanted = typeof statuses === 'string' ? new Set([statuses]) : statuses;
  const row = history.find((h) => h.ticket_id === ticketId && wanted.has(h.to_status));
  return row ? new Date(row.created_at).getTime() : null;
}

/**
 * @description What is wrong with the children's run: completion, the node that ran each, and order.
 * @param {object} snap - A finished snapshot.
 * @returns {string[]} Findings.
 */
function judgeChildrenRun(snap) {
  const findings = [];
  for (const [index, child] of snap.children.entries()) {
    const label = `child ${child.ticket_id}`;
    if (!CHILD_DONE.has(child.status)) findings.push(`${label} ended ${child.status}`);
    const unit = snap.items.find((item) => item.unit_id === `${child.ticket_id}-unit-1`);
    if (!unit) findings.push(`${label} has no unit-1 work item`);
    else if (unit.status !== 'completed') findings.push(`${label} unit-1 is ${unit.status}`);
    else if (!BUILD_TARGETS.has(unit.assigned_agent_id)) findings.push(`${label} unit-1 was completed by ${unit.assigned_agent_id}, which is not a build-lane target`);
    else if (!unit.provider || !unit.model) findings.push(`${label} unit-1 records no node provider and model`);
    if (index === 0) continue;
    const started = firstEntry(snap.history, child.ticket_id, 'in_process_build');
    const previousDone = firstEntry(snap.history, snap.children[index - 1].ticket_id, RELEASES_NEXT);
    if (started === null || previousDone === null || started < previousDone) findings.push(`${label} entered in_process_build before child ${snap.children[index - 1].ticket_id} was done`);
  }
  if (snap.root.status !== 'customer_action') findings.push(`the root ended ${snap.root.status}, not customer_action`);
  return findings;
}

/**
 * @description What is wrong with the root's own rounds: planning in-process by project-manager, no
 * plan-reviewer or Phase-8 round, and nothing left pending or assigned.
 * @param {object} snap - A finished snapshot.
 * @param {string} rootId - The root.
 * @returns {string[]} Findings.
 */
function judgeRounds(snap, rootId) {
  const findings = [];
  const round1 = snap.items.find((item) => item.unit_id === `${rootId}-phase-2-round-1`);
  if (!round1 || round1.status !== 'completed' || round1.assigned_agent_id !== PM_ID) {
    findings.push(`the planning round is ${round1 ? `${round1.status} by ${round1.assigned_agent_id}` : 'missing'}, not completed by project-manager`);
  }
  if (snap.items.some((item) => item.unit_id === `${rootId}-phase-2-round-2`)) findings.push('a plan-reviewer round work item exists');
  if (snap.items.some((item) => String(item.unit_id).includes('-phase-8-'))) findings.push('a Phase-8 architecture round work item exists');
  const open = snap.items.filter((item) => item.status === 'pending' || item.status === 'assigned');
  if (open.length) findings.push(`${open.length} work item(s) are still pending or assigned (${open.map((i) => i.unit_id).join(', ')})`);
  return findings;
}

/**
 * @description What is wrong with the root folder: the plan, a deliverable, one handover per child,
 * and no folder of a child's own.
 * @param {{exists: boolean, files: string[]}} listing - The root folder's listing.
 * @param {Array<{exists: boolean}>} childListings - Each child id's folder listing, in order.
 * @param {string[]} childIds - The children, in order.
 * @returns {string[]} Findings.
 */
function judgeFolder(listing, childListings, childIds) {
  if (!listing.exists) return ['the root folder does not exist'];
  const findings = [];
  if (!listing.files.includes('IMPLEMENTATION-PLAN.md')) findings.push('IMPLEMENTATION-PLAN.md is not in the root folder');
  if (!listing.files.some((file) => file.startsWith('deliverables/'))) findings.push('the root folder holds no deliverable');
  for (const [index, childId] of childIds.entries()) {
    const handover = listing.files.some((file) => file.startsWith('developer-handovers/') && file.split('/').pop().startsWith(`${childId}--`));
    if (!handover) findings.push(`no developer handover starts with ${childId}--`);
    if (childListings[index] && childListings[index].exists) findings.push(`child ${childId} has a folder of its own`);
  }
  return findings;
}

/**
 * @description The compact evidence of a snapshot: status moves and who ran each child.
 * @param {object} snap - A snapshot.
 * @returns {object} Evidence.
 */
function snapshotEvidence(snap) {
  if (!snap || !snap.root) return {};
  const label = new Map([[snap.root.ticket_id, 'root'], ...snap.children.map((c) => [c.ticket_id, `child-${subtaskIndex(c)}`])]);
  return {
    statusMoves: snap.history.map((h) => ({ ticket: label.get(h.ticket_id) || h.ticket_id, to: h.to_status, reason: h.reason || null, at: h.created_at })),
    children: snap.children.map((child) => {
      const unit = snap.items.find((item) => item.unit_id === `${child.ticket_id}-unit-1`) || {};
      return { id: child.ticket_id, title: child.title, subtaskIndex: subtaskIndex(child), status: child.status,
        agentId: unit.assigned_agent_id || null, provider: unit.provider || null, model: unit.model || null };
    }),
  };
}

/**
 * @description Record every child the run's root produced as this run's fixture, once.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {Set<string>} seen - Children already recorded.
 * @returns {(snap: object) => void} The snapshot listener.
 */
function recordChildren(ledger, seen) {
  return (snap) => {
    for (const child of (snap && snap.children) || []) {
      if (seen.has(child.ticket_id)) continue;
      seen.add(child.ticket_id);
      ledger.created('ticket', child.ticket_id, 'a child planned from the run root');
    }
  };
}

/**
 * @description Numeric cost and token totals found in the root's activity payload, for evidence.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @returns {Promise<object>} The totals, or the status when unreadable.
 */
async function activityTotals(io, rootId) {
  const res = await io.api('GET', `/api/v1/tickets/${rootId}/activity`);
  if (res.status !== 200 || !res.json || typeof res.json !== 'object') return { status: res.status };
  const totals = {};
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 2) return;
    for (const [key, inner] of Object.entries(value)) {
      if (/^total(Cost|Tokens|InputTokens|OutputTokens|Requests)$/.test(key) && typeof inner === 'number') totals[key] = inner;
      else visit(inner, depth + 1);
    }
  };
  visit(res.json, 0);
  return totals;
}

/**
 * @description The run from filing to verdict: claimed, planned, children run, then the final reads.
 * @param {object} io - Ports.
 * @param {{rootId: string, rootTitle: string}} plan - The run.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{verdict: object, snap: object|null}>} The verdict and the last snapshot.
 */
async function exercise(io, plan, ledger) {
  const seen = recordChildren(ledger, new Set());
  const fail = (detail, snap) => ({ verdict: { state: 'fail', detail, evidence: snapshotEvidence(snap) }, snap });
  const claimed = await awaitPhase(io, io.budgets.claimBudgetMs, plan.rootId, (s) => s.root && s.root.status !== 'approved', seen);
  if (!claimed.done) return fail(claimed.failure || `the queue did not claim the root within ${io.budgets.claimBudgetMs / 1000} s`, claimed.snap);
  const planning = await awaitPhase(io, io.budgets.planningBudgetMs, plan.rootId, planned, seen);
  if (!planning.done) return fail(planning.failure || `planning did not finish within ${io.budgets.planningBudgetMs / 1000} s`, planning.snap);
  const planFindings = judgePlanning(planning.snap, plan.rootTitle, io.ownerSub);
  if (planFindings.length) return fail(planFindings.join('; '), planning.snap);
  ledger.created('workspace-folder', plan.rootId, 'the root folder the tree writes into');
  const budget = io.budgets.childBudgetMs * planning.snap.children.length;
  const run = await awaitPhase(io, budget, plan.rootId, finished, seen);
  if (!run.done) return fail(run.failure || `the children did not finish within ${budget / 1000} s`, run.snap);
  const childIds = run.snap.children.map((c) => c.ticket_id);
  const listing = await io.files.dir('build.root', plan.rootId);
  const childListings = await Promise.all(childIds.map((id) => io.files.dir('build.root', id)));
  const findings = [...judgeChildrenRun(run.snap), ...judgeRounds(run.snap, plan.rootId), ...judgeFolder(listing, childListings, childIds)];
  const evidence = { ...snapshotEvidence(run.snap), files: listing.files.length, activity: await activityTotals(io, plan.rootId) };
  if (findings.length) return { verdict: { state: 'fail', detail: findings.join('; '), evidence }, snap: run.snap };
  return { verdict: { state: 'pass', detail: `${childIds.length} children planned in-process, run one at a time over the signed hop and assembled`, evidence }, snap: run.snap };
}

/**
 * @description What a signal handler can do in the seconds before the process exits: cancel the
 * run's tickets so the queue stops dispatching them, and say how to finish the cleanup. A node call
 * already in flight cannot be stopped from here.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @returns {Promise<void>} Resolves once the cancels were sent.
 */
async function abandon(io, rootId) {
  const tree = await readTree(io, rootId).catch(() => []);
  await cancelUnfinished(io, [...tree.filter((t) => t.parent_ticket_id === rootId), ...tree.filter((t) => t.ticket_id === rootId)], new common.CleanupLedger());
  note(io, `run interrupted; root ${rootId} and its children were cancelled. Finish the cleanup with: ${cleanupCommand(rootId)}`);
}

/**
 * @description The run's cleanup, with a throw recorded as a cleanup error instead of lost.
 * @param {object} io - Ports.
 * @param {string} rootId - The root.
 * @param {object|null} snap - The last snapshot.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<object>} Counts of leftover rows removed.
 */
async function cleanupRecorded(io, rootId, snap, ledger) {
  try {
    return await cleanup(io, { rootId, snap }, ledger);
  } catch (error) {
    ledger.error(`cleanup stopped early: ${common.errorText(error)}`);
    return {};
  }
}

/**
 * @description Run the case once.
 * @param {object} ports - api, sql, ownerSub, files (and the clock in tests; `note` and
 *   `onInterrupt` when the runner binds them).
 * @param {object} [options] - Budget overrides (`claimBudgetMs`, `planningBudgetMs`, `childBudgetMs`,
 *   `settleBudgetMs`, `residueWaitMs`, `pollMs`) and `tag` (tests only).
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const io = { ...common.withClock(ports), budgets: common.budgetsFrom(DEFAULT_BUDGETS, options) };
  const gap = await preflight(io);
  if (gap) return common.unavailable(CASE_ID, `${gap}.`);
  const ledger = new common.CleanupLedger();
  const filed = await fileRoot(io, options.tag || common.mintTag(KEY), ledger);
  if (!filed.id) return common.finish(CASE_ID, { state: 'fail', detail: `${filed.error}.` }, ledger, {});
  note(io, `root ${filed.id} filed as "${filed.title}"; if this run is interrupted, finish with: ${cleanupCommand(filed.id)}`);
  const release = typeof io.onInterrupt === 'function' ? io.onInterrupt(() => abandon(io, filed.id)) : null;
  const outcome = filed.error
    ? { verdict: { state: 'fail', detail: filed.error, evidence: {} }, snap: null }
    : await exercise(io, { rootId: filed.id, rootTitle: filed.title }, ledger)
      .catch((error) => ({ verdict: { state: 'fail', detail: `The case crashed: ${common.errorText(error)}`, evidence: {} }, snap: null }));
  const removed = await cleanupRecorded(io, filed.id, outcome.snap, ledger);
  if (release) release();
  ledger.kept('cost-rows', filed.id, KEPT_ROWS);
  const verdict = { ...outcome.verdict, detail: `${outcome.verdict.detail}.` };
  return common.finish(CASE_ID, verdict, ledger, { rootId: filed.id, ...outcome.verdict.evidence, removedRows: removed });
}

/**
 * @description Finish an interrupted run by its root id: the same cleanup under the same anchors,
 * so only a root this caller filed under this case's tag can be touched.
 * @param {object} ports - api, sql, ownerSub, files.
 * @param {string} rootId - The root ticket id.
 * @param {object} [options] - Budget overrides.
 * @returns {Promise<object>} A result whose receipt is the cleanup's.
 */
async function cleanupRoot(ports, rootId, options = {}) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  if (typeof rootId !== 'string' || !UUID_RE.test(rootId)) {
    return common.finish(CASE_ID, { state: 'fail', detail: `${String(rootId).slice(0, 60)} is not a lower-case ticket UUID.` }, new common.CleanupLedger(), {});
  }
  const io = { ...common.withClock(ports), budgets: common.budgetsFrom(DEFAULT_BUDGETS, options) };
  const ledger = new common.CleanupLedger();
  ledger.created('ticket', rootId, 'the build root of an earlier run');
  const removed = await cleanupRecorded(io, rootId, null, ledger);
  ledger.kept('cost-rows', rootId, KEPT_ROWS);
  return common.finish(CASE_ID, { state: 'pass', detail: `Cleanup-only run for root ${rootId}.` }, ledger, { rootId, removedRows: removed });
}

module.exports = {
  CASE_ID, KEY, TITLE, NEEDS, REGRESSION_TESTS, BUILD_TARGETS, DEFAULT_BUDGETS, BUSY_STATES,
  describeBuild, preflight, earlyFailure, judgePlanning, judgeChildrenRun, judgeRounds, judgeFolder, exercise, run, cleanupRoot,
};
