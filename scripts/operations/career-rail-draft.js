/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the approve -> draft half of the Career rail live acceptance's `--complete` mode ("Career scoring/tailoring bot-node migration": a real Career bot-node completes the workflow). Inside the api container, as the operator automation identity, after the score run passed: require career-hunter 1.27.0 (its Test Lab application seam) and auto-submit off, borrow one untouched posting from the owner's own board (status new, no packet, no application), plant ONE application marked with this run's tag (POST /test-lab/applications), approve it through the real route (POST /applications/:postingId/approve runs the engine's `draft --job` on the Career worker rail), and require the draft run to end `succeeded` in GET /runs with at least one admitted rail call, the application to read `drafted`, and the Career bot's oshal_cost_events rows under the owner since the approve to exist and number no more than the calls the draft admitted. Then it removes exactly what it created: the packet (DELETE /jobs/:id/packet), the marked application and its ticket (DELETE /test-lab/applications/:postingId/:tag), and reads both back: no application row for the posting, and the posting's status, generated_at and packet flags as they were before. An incomplete cleanup is red. The shared jobs corpus is never written; the cost rows are the owner's accounting and stay.
 */

'use strict';

/** The first career-hunter version with the Test Lab application seam. */
const SEAM_MIN_VERSION = [1, 27, 0];
const API = '/api/career-hunter';
/** The engine verb the approve route runs (career-application-routes.ts approveApplication). */
const DRAFT_VERB = 'draft';
/** The status an untouched posting holds (the user_signals column default). */
const UNWORKED = 'new';
/** One draft is two model calls (tailoring and the cover polish) plus rendering: 15 minutes is generous. */
const DEFAULT_DRAFT_BUDGET_MS = 900_000;
/** How many polls cleanup waits for a cancelled draft's handler to leave `drafting`. */
const SETTLE_POLLS = 20;
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @description The proof module, required lazily (it requires this module back in `--complete`).
 * @returns {object} career-rail-live-proof's exports.
 */
function proof() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./career-rail-live-proof');
}

/**
 * @description Whether an installed package version has the Test Lab application seam.
 * @param {unknown} version - The manifest version.
 * @returns {boolean} True for 1.27.0 and later.
 */
function hasDraftSeam(version) {
  const parts = String(version || '').split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return false;
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== SEAM_MIN_VERSION[i]) return parts[i] > SEAM_MIN_VERSION[i];
  }
  return true;
}

/**
 * @description This run's Test Lab tag, in the grammar the seam accepts (6-64 of [a-z0-9-]).
 * @param {() => string} randomHex - Twelve lowercase hex characters.
 * @returns {string} The tag.
 */
function makeTag(randomHex) {
  return `rail-draft-${randomHex()}`;
}

/**
 * @description The per-user facts of one posting that a draft changes.
 * @param {object} job - One job as GET /jobs/:id returns it.
 * @returns {{status: string|null, generatedAt: string|null, hasResume: number, hasCover: number}} The facts.
 */
function jobState(job) {
  return { status: job.status ?? null, generatedAt: job.generated_at ?? null, hasResume: Number(job.has_resume || 0), hasCover: Number(job.has_cover || 0) };
}

/** @description A precondition that is not met; nothing has been written. */
function unavailable(detail) {
  return { unavailable: detail };
}

/**
 * @description Read-only preconditions: the seam, auto-submit off, and one untouched posting the
 * owner has no application for.
 * @param {object} io - api, careerVersion.
 * @returns {Promise<{postingId: number, before: object}|{unavailable: string}>} The borrowed posting, or why not.
 */
async function choosePosting(io) {
  if (!hasDraftSeam(io.careerVersion)) return unavailable(`career-hunter ${io.careerVersion} has no Test Lab application seam (1.27.0+), so no draft the proof owns and removes can be driven; nothing was written.`);
  const automation = await io.api('GET', `${API}/automation/state`);
  if (automation.status !== 200) return unavailable(`GET /automation/state answered ${automation.status}; nothing was written.`);
  if (automation.json.autoSubmit === true) return unavailable('Career auto-submit is on for this identity, so a drafted application could be submitted; nothing was written.');
  const [board, applications] = [await io.api('GET', `${API}/jobs?per=60`), await io.api('GET', `${API}/applications`)];
  if (board.status !== 200 || applications.status !== 200) return unavailable(`GET /jobs answered ${board.status} and GET /applications ${applications.status}; nothing was written.`);
  const taken = new Set((applications.json.applications || []).map((row) => Number(row.posting_id)));
  const candidate = (board.json.jobs || []).find((job) => job.status === UNWORKED && !job.has_resume && !job.has_cover && !job.generated_at && !taken.has(Number(job.id)));
  if (!candidate) return unavailable('No untouched posting without an application on the first board page to draft for; nothing was written.');
  const detail = await io.api('GET', `${API}/jobs/${candidate.id}`);
  if (detail.status !== 200 || !detail.json.job) return unavailable(`GET /jobs/${candidate.id} answered ${detail.status}; nothing was written.`);
  return { postingId: Number(candidate.id), before: jobState(detail.json.job) };
}

/**
 * @description The owner's newest draft run started no earlier than the approve.
 * @param {object} io - api.
 * @param {number} sinceMs - When the approve was posted.
 * @returns {Promise<object|null>} The owner-visible run record, or null.
 */
async function findDraftRun(io, sinceMs) {
  const listed = await io.api('GET', `${API}/runs`);
  const runs = listed.status === 200 && Array.isArray(listed.json.runs) ? listed.json.runs : [];
  return runs.find((run) => run && run.verb === DRAFT_VERB && Number(run.startedAt) >= sinceMs - 5_000 && RUN_ID_RE.test(String(run.runId))) || null;
}

/**
 * @description The owner's application row for one posting, or null.
 * @param {object} io - api.
 * @param {number} postingId - The posting.
 * @returns {Promise<object|null>} The row.
 */
async function applicationFor(io, postingId) {
  const listed = await io.api('GET', `${API}/applications`);
  if (listed.status !== 200) throw new Error(`GET /applications answered ${listed.status}`);
  return (listed.json.applications || []).find((row) => Number(row.posting_id) === postingId) || null;
}

/**
 * @description Approve the planted application through the real route and observe the draft.
 * @param {object} io - api, now.
 * @param {object} budgets - draftBudgetMs.
 * @param {number} postingId - The planted posting.
 * @returns {Promise<{response: object, run: object|null, sinceMs: number, application: object|null}>} What was seen.
 */
async function approveAndObserve(io, budgets, postingId) {
  const sinceMs = io.now();
  const response = await io.api('POST', `${API}/applications/${postingId}/approve`, {}, budgets.draftBudgetMs + 30_000)
    .catch((error) => ({ status: 0, json: { error: error instanceof Error ? error.message : String(error) } }));
  const run = await findDraftRun(io, sinceMs);
  const application = await applicationFor(io, postingId);
  return { response, run, sinceMs, application };
}

/**
 * @description The draft half's verdict before cleanup.
 * @param {{response: object, run: object|null, application: object|null}} seen - approveAndObserve's outcome.
 * @param {object|null} attribution - What the database holds since the approve, or null when not read.
 * @param {object} budgets - For the messages.
 * @returns {{state: 'pass'|'fail', detail: string}} The verdict.
 */
function draftVerdict(seen, attribution, budgets) {
  const { response, run, application } = seen;
  const error = String((response.json && (response.json.error || response.json.err)) || '');
  if (!run) return { state: 'fail', detail: `POST /applications/:postingId/approve answered HTTP ${response.status} ${error.slice(-200)} but no ${DRAFT_VERB} run of this owner appeared in GET /runs.` };
  if (run.state === 'running') {
    return { state: 'fail', detail: `Draft run ${run.runId} was still running after ${Math.round(budgets.draftBudgetMs / 1000)}s (${run.railCalls} rail calls admitted); the proof cancelled it.` };
  }
  if (run.state !== 'succeeded') {
    const refusal = proof().detectRailRefusal([run.reason, error]);
    return { state: 'fail', detail: `Draft run ${run.runId} ended ${run.state}${run.reason ? ` (${run.reason})` : ''} after ${run.railCalls} admitted rail calls${refusal ? `; the kernel refused the rail call before package code ran: ${refusal}` : ''} (approve answered HTTP ${response.status} ${error.slice(-200)}).` };
  }
  if (response.status !== 200 || !response.json || response.json.ok !== true) {
    return { state: 'fail', detail: `Draft run ${run.runId} succeeded but the approve answered HTTP ${response.status} ${error.slice(-200)}.` };
  }
  if (!application || application.status !== 'drafted') {
    return { state: 'fail', detail: `Draft run ${run.runId} succeeded but the application reads ${application ? application.status : 'missing'}, not drafted.` };
  }
  if (Number(run.railCalls) < 1) return { state: 'fail', detail: `Draft run ${run.runId} succeeded without a single rail call: the draft made no model call on the Career bot.` };
  return proof().attributionVerdict(run, `a draft that ended succeeded after ${run.railCalls} rail calls (the application reads drafted)`, attribution, budgets);
}

/**
 * @description Leave no draft running: cancel an in-flight one and wait for the approve handler to
 * leave `drafting` (it writes the row after the run ends).
 * @param {object} io - api, sleep.
 * @param {object|null} run - The observed draft run.
 * @param {number} postingId - The planted posting.
 * @param {object} budgets - pollMs.
 * @returns {Promise<string[]>} Errors; empty when nothing of the draft is still live.
 */
async function settleDraft(io, run, postingId, budgets) {
  const errors = run && run.state === 'running' ? await proof().cleanUpRun(io, run, budgets, (probe) => findDraftRun(io, probe)) : [];
  for (let poll = 0; poll < SETTLE_POLLS; poll += 1) {
    const row = await applicationFor(io, postingId);
    if (!row || row.status !== 'drafting') return errors;
    await io.sleep(budgets.pollMs);
  }
  return [...errors, `the application for posting ${postingId} is still drafting`];
}

/**
 * @description Remove exactly what the half created and read it back.
 * @param {object} io - api, sleep.
 * @param {{postingId: number, before: object, tag: string, run: object|null}} created - What was planted and observed.
 * @param {object} budgets - pollMs.
 * @returns {Promise<string[]>} Cleanup errors; empty means the owner's store is as it was.
 */
async function removeDraft(io, created, budgets) {
  const { postingId, before, tag } = created;
  const errors = await settleDraft(io, created.run, postingId, budgets);
  const packet = await io.api('DELETE', `${API}/jobs/${postingId}/packet`);
  if (packet.status !== 200 && packet.status !== 404) errors.push(`DELETE /jobs/${postingId}/packet answered ${packet.status} ${packet.json.error || ''}`);
  const seam = await io.api('DELETE', `${API}/test-lab/applications/${postingId}/${tag}`);
  if (seam.status !== 200) errors.push(`DELETE /test-lab/applications/${postingId}/${tag} answered ${seam.status} ${seam.json.error || ''}`);
  if (await applicationFor(io, postingId)) errors.push(`an application for posting ${postingId} is still listed`);
  const job = await io.api('GET', `${API}/jobs/${postingId}`);
  const after = job.status === 200 && job.json.job ? jobState(job.json.job) : null;
  if (JSON.stringify(after) !== JSON.stringify(before)) errors.push(`posting ${postingId} is ${JSON.stringify(after)}, was ${JSON.stringify(before)}`);
  return errors;
}

/**
 * @description Run the approve -> draft half once. Cleanup always runs once an application was planted.
 * @param {object} io - api, query, withOwner, ownerSub, careerVersion, sleep, now, randomHex.
 * @param {object} budgets - draftBudgetMs, ledgerBudgetMs, pollMs.
 * @returns {Promise<{state: string, detail: string, evidence: object, cleanupErrors: string[]}>} The half's result.
 */
async function runDraftHalf(io, budgets) {
  const chosen = await choosePosting(io);
  if (chosen.unavailable) return { state: 'unavailable', detail: chosen.unavailable, evidence: { planted: false }, cleanupErrors: [] };
  const tag = makeTag(io.randomHex);
  const evidence = { postingId: chosen.postingId, tag, planted: false };
  const planted = await io.api('POST', `${API}/test-lab/applications`, { postingId: chosen.postingId, tag });
  if (planted.status !== 201) {
    return { state: 'fail', detail: `POST /test-lab/applications answered ${planted.status} ${planted.json.error || ''}; nothing was planted.`, evidence, cleanupErrors: [] };
  }
  evidence.planted = true;
  let seen = { response: { status: 0, json: {} }, run: null, application: null };
  let verdict = { state: 'fail', detail: 'The draft half did not finish.' };
  try {
    seen = await approveAndObserve(io, budgets, chosen.postingId);
    const { run } = seen;
    Object.assign(evidence, { approveStatus: seen.response.status, draftRunId: run ? run.runId : null, draftState: run ? run.state : null,
      draftReason: run ? run.reason : null, draftRailCalls: run ? run.railCalls : null, applicationStatus: seen.application ? seen.application.status : null });
    const attributable = run && run.state === 'succeeded' && Number(run.railCalls) >= 1;
    const attribution = attributable ? await proof().awaitAttribution(io, new Date(seen.sinceMs), budgets) : null;
    if (attribution) evidence.ledger = attribution.ledger;
    verdict = draftVerdict(seen, attribution, budgets);
  } catch (error) {
    verdict = { state: 'fail', detail: error instanceof Error ? error.message : String(error) };
  }
  const cleanupErrors = await removeDraft(io, { postingId: chosen.postingId, before: chosen.before, tag, run: seen.run }, budgets)
    .catch((error) => [`cleanup crashed: ${error instanceof Error ? error.message : String(error)}`]);
  const removed = cleanupErrors.length ? '' : ' The packet and the marked application with its ticket were removed, and the posting reads as it did before.';
  return { ...verdict, detail: `${verdict.detail}${removed}`, evidence, cleanupErrors };
}

module.exports = {
  SEAM_MIN_VERSION, DRAFT_VERB, DEFAULT_DRAFT_BUDGET_MS, hasDraftSeam, makeTag, jobState, choosePosting, findDraftRun,
  draftVerdict, removeDraft, runDraftHalf,
};
