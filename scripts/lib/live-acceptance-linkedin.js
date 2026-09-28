/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "LinkedIn Content Assistant queue workflow", STOPPING before any publish. As the caller it files one tagged synthetic linkedin-content-post ticket through the installed Social package's POST /api/social/linkedin-content-queue (a neutral fixture citation), waits for the social-writer worker to turn it into a graded pending-approval draft through the real queue dispatch, and requires the draft to name its source ticket and carry the ticket's citations. It then probes the publish route WITHOUT confirmation and requires 428. It never approves, never confirms, never publishes: a real public post stays an operator decision. Cleanup rejects the draft (terminal, can never publish), deletes it through the closed statement set (the product has no draft delete), deletes the ticket through the ticket service after re-reading it, re-checks for a late draft, and proves both gone.
 */

'use strict';

const common = require('./live-acceptance-common.js');

const CASE_ID = 'linkedin-queue-live';
const KEY = 'linkedin';
const TITLE = 'LinkedIn content queue: ticket to reviewed draft awaiting approval (no publish)';
const NEEDS = Object.freeze(['api', 'sql', 'tickets', 'ownerSub']);
const QUEUE = '/api/social/linkedin-content-queue';
const DRAFTS = '/api/linkedin-assistant/drafts';
const TICKET_TYPE = 'linkedin-content-post';
/** Bounds: the worker spends one or two real model turns (draft, grade, maybe one refine). */
const DEFAULT_BUDGETS = Object.freeze({ draftBudgetMs: 15 * 60_000, pollMs: 10_000, lateDraftGraceMs: 30_000 });
/** Ticket states that mean the worker will not produce a draft. */
const DEAD_TICKET = /^(failed|dead_letter|cancelled|rejected|error)$/;

/**
 * @description The synthetic ticket body: a tagged topic and one neutral fixture citation.
 * @param {string} tag - The run's fixture tag.
 * @returns {{topic: string, description: string, goal: string, tone: string, sourceCitations: string[]}} The body.
 */
function createFixture(tag) {
  return {
    topic: `${tag}: what an automated acceptance run proves that a unit test cannot`,
    description: 'Synthetic Test Lab fixture filed by the live-acceptance sweep. Draft only; it is never approved or published.',
    goal: 'Exercise the queue to reviewed draft path',
    tone: 'plain',
    sourceCitations: [`https://oshal.example.com/testlab/${tag}`],
  };
}

/**
 * @description Find this run's draft among the caller's drafts.
 * @param {object} ports - api.
 * @param {string} ticketId - The fixture ticket.
 * @param {string} [state] - Optional state filter.
 * @returns {Promise<object|null>} The draft, or null.
 */
async function findDraft(ports, ticketId, state) {
  const res = await ports.api('GET', `${DRAFTS}${state ? `?state=${encodeURIComponent(state)}` : ''}`);
  const drafts = Array.isArray(res.json && res.json.drafts) ? res.json.drafts : [];
  return drafts.find((d) => d && d.sourceTicketId === ticketId) || null;
}

/**
 * @description Judge the reviewed draft and its provenance.
 * @param {object} draft - The draft.
 * @param {ReturnType<typeof createFixture>} fixture - The run's fixture.
 * @returns {{ok: boolean, detail: string}} The judgement.
 */
function judgeDraft(draft, fixture) {
  const problems = [];
  if (draft.state !== 'pending-approval') problems.push(`state is ${draft.state}, not pending-approval`);
  const citations = Array.isArray(draft.sourceCitations) ? draft.sourceCitations : [];
  for (const cite of fixture.sourceCitations) if (!citations.includes(cite)) problems.push(`citation ${cite} is missing`);
  if (!String(draft.body || '').trim()) problems.push('the draft has no body');
  if (typeof draft.score !== 'number') problems.push('the draft carries no quality score');
  if (problems.length) return { ok: false, detail: `draft ${draft.id}: ${problems.join('; ')}` };
  return { ok: true, detail: `draft ${draft.id} is pending-approval, scored ${draft.score}, names ticket ${draft.sourceTicketId} and carries its ${citations.length} citation(s)` };
}

/**
 * @description Wait for the worker's draft, stopping early when the ticket is dead.
 * @param {object} io - Ports with clock.
 * @param {string} ticketId - The fixture ticket.
 * @param {object} budgets - Budgets.
 * @returns {Promise<{draft: object|null, ticketStatus: string|null, elapsedMs: number}>} What was seen.
 */
async function awaitDraft(io, ticketId, budgets) {
  let ticketStatus = null;
  const seen = await common.pollUntil(io, { budgetMs: budgets.draftBudgetMs, pollMs: budgets.pollMs }, async () => {
    const draft = await findDraft(io, ticketId);
    if (draft) return { done: true, value: draft };
    const ticket = await io.tickets.get(ticketId);
    ticketStatus = ticket ? String(ticket.status) : 'missing';
    return { done: DEAD_TICKET.test(ticketStatus) || ticketStatus === 'missing', value: null };
  });
  return { draft: seen.value || null, ticketStatus, elapsedMs: seen.elapsedMs };
}

/**
 * @description Probe the publish gate on this draft without confirmation; it must answer 428.
 * @param {object} ports - api.
 * @param {object} draft - The draft.
 * @returns {Promise<{ok: boolean, detail: string}>} The judgement.
 */
async function probePublishGate(ports, draft) {
  const res = await ports.api('POST', `${DRAFTS}/${encodeURIComponent(draft.id)}/publish`, {});
  if (res.status === 428) return { ok: true, detail: 'publishing it without confirmation was refused 428' };
  return { ok: false, detail: `publishing it without confirmation answered HTTP ${res.status}, not 428` };
}

/**
 * @description Remove the draft (reject, then delete) and prove none is left for the ticket.
 * @param {object} io - api, sql, ownerSub.
 * @param {string} ticketId - The fixture ticket.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeDrafts(io, ticketId, ledger) {
  await ledger.attempt(`drafts for ${ticketId}`, async () => {
    const draft = await findDraft(io, ticketId);
    if (draft && draft.state !== 'rejected') {
      const rejected = await io.api('POST', `${DRAFTS}/${encodeURIComponent(draft.id)}/reject`, {});
      if (rejected.status !== 200) return `rejecting draft ${draft.id} answered HTTP ${rejected.status}`;
    }
    await io.sql('linkedin.draft-delete', [io.ownerSub, ticketId]);
    const left = ((await io.sql('linkedin.draft-residue', [io.ownerSub, ticketId])).rows || [])[0] || {};
    if (Number(left.drafts)) return `${left.drafts} draft(s) still name ticket ${ticketId}`;
    if (draft) ledger.removed('linkedin-draft', draft.id);
    return null;
  });
}

/**
 * @description Delete the fixture ticket through the ticket service after re-reading it as this run's.
 * @param {object} io - tickets, ownerSub.
 * @param {string} ticketId - The fixture ticket.
 * @param {ReturnType<typeof createFixture>} fixture - The run's fixture.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeTicket(io, ticketId, fixture, ledger) {
  await ledger.attempt(`ticket ${ticketId} delete`, async () => {
    const ticket = await io.tickets.get(ticketId);
    if (ticket) {
      const metadata = ticket.metadata || {};
      if (ticket.ownerSub !== io.ownerSub || ticket.ticketType !== TICKET_TYPE || metadata.topic !== fixture.topic) {
        return `ticket ${ticketId} did not revalidate as this run's fixture; not deleted`;
      }
      await io.tickets.delete(ticketId);
      if (await io.tickets.get(ticketId)) return `ticket ${ticketId} still exists after deletion`;
    }
    ledger.removed('ticket', ticketId);
    return null;
  });
}

/**
 * @description Clean up everything the run created, including a draft the worker writes late.
 * @param {object} io - Ports with clock.
 * @param {string} ticketId - The fixture ticket.
 * @param {ReturnType<typeof createFixture>} fixture - The run's fixture.
 * @param {object} budgets - Budgets.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function cleanUp(io, ticketId, fixture, budgets, ledger) {
  await removeDrafts(io, ticketId, ledger);
  await removeTicket(io, ticketId, fixture, ledger);
  await io.sleep(budgets.lateDraftGraceMs);
  const late = await findDraft(io, ticketId);
  if (late) {
    ledger.created('linkedin-draft', late.id, 'written after the ticket was deleted');
    await removeDrafts(io, ticketId, ledger);
  }
}

/**
 * @description File the ticket, follow it to the reviewed draft, probe the gate.
 * @param {object} io - Ports with clock.
 * @param {ReturnType<typeof createFixture>} fixture - The run's fixture.
 * @param {object} budgets - Budgets.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{verdict: object, ticketId: string|null, evidence: object}>} The outcome.
 */
async function exercise(io, fixture, budgets, ledger) {
  const filed = await io.api('POST', QUEUE, fixture);
  const ticketId = filed.json && filed.json.ticket ? String(filed.json.ticket.ticketId || '') : '';
  if (filed.status === 404) return { verdict: { state: 'unavailable', detail: `${QUEUE} is not mounted (Social 1.5.1 or later is not installed). Nothing was written.` }, ticketId: null, evidence: {} };
  if (filed.status !== 202 || !ticketId) return { verdict: { state: 'fail', detail: `${QUEUE} answered HTTP ${filed.status}: ${(filed.json && filed.json.error) || 'no ticket'}.` }, ticketId: null, evidence: {} };
  ledger.created('ticket', ticketId);
  const seen = await awaitDraft(io, ticketId, budgets);
  const evidence = { ticketId, ticketStatus: seen.ticketStatus, draftSeconds: Math.round(seen.elapsedMs / 1000) };
  if (!seen.draft) {
    return { verdict: { state: 'fail', detail: `no draft named ticket ${ticketId} within ${Math.round(budgets.draftBudgetMs / 1000)}s (ticket ${seen.ticketStatus}).` }, ticketId, evidence };
  }
  ledger.created('linkedin-draft', seen.draft.id);
  const judged = judgeDraft(seen.draft, fixture);
  const gate = await probePublishGate(io, seen.draft);
  const state = judged.ok && gate.ok ? 'pass' : 'fail';
  return { verdict: { state, detail: `${judged.detail}; ${gate.detail}. Stopped before approval and publish.` }, ticketId, evidence: { ...evidence, draftId: seen.draft.id } };
}

/**
 * @description Run the case once.
 * @param {object} ports - api, sql, tickets, ownerSub.
 * @param {object} [options] - Budget overrides (draftBudgetMs, pollMs, lateDraftGraceMs), `tag` (tests only).
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const io = common.withClock(ports);
  const budgets = common.budgetsFrom(DEFAULT_BUDGETS, options);
  const fixture = createFixture(options.tag || common.mintTag(KEY));
  const ledger = new common.CleanupLedger();
  let outcome = { verdict: { state: 'fail', detail: 'The case did not finish.' }, ticketId: null, evidence: {} };
  try {
    outcome = await exercise(io, fixture, budgets, ledger);
  } catch (error) {
    outcome.verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` };
  }
  const ticketId = outcome.ticketId || (ledger.outstanding().find((e) => e.kind === 'ticket') || {}).id;
  if (ticketId) await cleanUp(io, ticketId, fixture, budgets, ledger);
  return common.finish(CASE_ID, outcome.verdict, ledger, outcome.evidence);
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, TICKET_TYPE, createFixture, judgeDraft, probePublishGate, run };
