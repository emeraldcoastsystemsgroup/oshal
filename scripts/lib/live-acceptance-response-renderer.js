/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Shared response-renderer completion" against the installed build: run the core 'shared-response-renderer' Test Lab card through POST /api/test-lab/run (all three steps must pass), fetch the vendored Mermaid runtime directly and require it served same-origin (VERSION is an exact version, the entry module is JavaScript, neither answers with a redirect), and run the installed Little Monsters 'tutor-shared-renderer' package case through the durable run route, requiring it to have EXECUTED tests (at least one passed, none failed) rather than decline. Writes nothing but the Lab's own run-history row, which is the recorded evidence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The Tutor half no longer takes one catalog read as final when the only thing holding the case back is the api's runner probe. The api verifies its browser runner lazily: the first catalog listing after a start begins the probe and still lists every browser case as not runnable with "The playwright runner is unavailable.", so the case, whose own card run is that first listing, reported the Tutor half blocked on the first sweep after every api restart (2026-09-29: the read landed 5.3 s before the probe verified the runner). While the case is listed, not runnable, and that is its reason, the catalog is re-read at the poll interval until it is runnable or probeBudgetMs (165 s, just above the probe's 150 s timeout) runs out. The run starts from the LAST read, because the api re-seals every case when the probe verifies and its revisions change. Any other reason, an absent case or a failed read ends the wait at once, and the reason still present at the end of the budget stays blocked with the reason and the time waited. The evidence carries tutorCatalogWaitMs.
 */

'use strict';

const crypto = require('node:crypto');
const common = require('./live-acceptance-common.js');

const CASE_ID = 'shared-response-renderer-live';
const KEY = 'response-renderer';
const TITLE = 'Shared response renderer and the Tutor, on the installed build';
const NEEDS = Object.freeze(['api']);
/** The core card this case runs. */
const CARD_ID = 'shared-response-renderer';
/** The installed package case id the Lab catalog lists for the Tutor renderer suite. */
const TUTOR_CASE_ID = 'app:little-monsters:test:tutor-shared-renderer';
const MERMAID_VERSION_PATH = '/dist/vendor/mermaid/VERSION';
const MERMAID_ENTRY_PATH = '/dist/vendor/mermaid/mermaid.esm.min.mjs';
/** Terminal durable-run states (test-lab-run-schema.ts). */
const TERMINAL = Object.freeze(['passed', 'failed', 'pending', 'cancelled', 'interrupted']);
/**
 * The pending reason the catalog gives a browser case while the api has not yet verified its browser
 * runner (packageTestRecipePending in package-test-snapshot.ts). It means "not verified yet" as well as
 * "not available": the listing that begins the probe still answers it.
 */
const RUNNER_UNVERIFIED_REASON = 'The playwright runner is unavailable.';
/** probeBudgetMs sits just above the runner probe's own 150 s timeout (package-test-sandbox.ts, probe()). */
const DEFAULT_BUDGETS = Object.freeze({ runBudgetMs: 300_000, pollMs: 3_000, probeBudgetMs: 165_000 });

/**
 * @description Run one core Lab card through the signed-in run route and return its result block.
 * @param {object} ports - api.
 * @param {string} id - The scenario id.
 * @returns {Promise<{status: number, card: object|null}>} The HTTP status and the card's result.
 */
async function runCard(ports, id) {
  const res = await ports.api('POST', '/api/test-lab/run', { scenarioId: id });
  const results = Array.isArray(res.json && res.json.results) ? res.json.results : [];
  return { status: res.status, card: results.find((entry) => entry && entry.id === id) || null };
}

/**
 * @description Judge a card's result: every step must pass.
 * @param {{status: number, card: object|null}} ran - What runCard returned.
 * @returns {{ok: boolean, detail: string, steps: Array<{label: string, state: string}>}} The judgement.
 */
function judgeCard(ran) {
  if (!ran.card) return { ok: false, detail: `card ${CARD_ID} did not run (HTTP ${ran.status})`, steps: [] };
  const steps = (Array.isArray(ran.card.steps) ? ran.card.steps : []).map((s) => ({ label: String(s.label), state: String(s.state), detail: String(s.detail || '') }));
  const bad = steps.filter((s) => s.state !== 'pass');
  if (!steps.length) return { ok: false, detail: `card ${CARD_ID} ran no steps`, steps };
  if (bad.length) return { ok: false, detail: `card ${CARD_ID}: ${bad.map((s) => `${s.label} = ${s.state} (${s.detail.slice(0, 160)})`).join('; ')}`, steps };
  return { ok: true, detail: `card ${CARD_ID}: ${steps.length}/${steps.length} steps pass`, steps };
}

/**
 * @description Fetch the vendored Mermaid runtime from this origin and require it served here.
 * @param {object} ports - api.
 * @returns {Promise<{ok: boolean, detail: string, version: string|null}>} The judgement.
 */
async function probeMermaid(ports) {
  const version = await ports.api('GET', MERMAID_VERSION_PATH);
  if (version.location) return { ok: false, detail: `${MERMAID_VERSION_PATH} redirected to ${version.location}`, version: null };
  const pinned = String(version.text || '').trim();
  if (version.status !== 200 || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    return { ok: false, detail: `${MERMAID_VERSION_PATH} answered HTTP ${version.status} without an exact version`, version: null };
  }
  const entry = await ports.api('GET', MERMAID_ENTRY_PATH);
  if (entry.location) return { ok: false, detail: `${MERMAID_ENTRY_PATH} redirected to ${entry.location}`, version: pinned };
  if (entry.status !== 200 || !/javascript/.test(String(entry.contentType || ''))) {
    return { ok: false, detail: `${MERMAID_ENTRY_PATH} answered HTTP ${entry.status} (${entry.contentType || 'no content-type'})`, version: pinned };
  }
  return { ok: true, detail: `Mermaid ${pinned} is served same-origin from /dist/vendor/mermaid`, version: pinned };
}

/**
 * @description Count executed tests in a package run's output (node:test TAP or Playwright's list reporter).
 * @param {unknown} output - The run's captured output.
 * @returns {{passed: number, failed: number}} The counts (0 when the output names none).
 */
function countTests(output) {
  const text = String(output || '');
  const tap = (name) => { const m = text.match(new RegExp(`^# ${name} (\\d+)`, 'm')); return m ? Number(m[1]) : null; };
  const pw = (name) => { const m = text.match(new RegExp(`(\\d+) ${name}\\b`)); return m ? Number(m[1]) : null; };
  return { passed: tap('pass') ?? pw('passed') ?? 0, failed: tap('fail') ?? pw('failed') ?? 0 };
}

/**
 * @description Start the installed Tutor case through the durable run route and follow it to a terminal state.
 * @param {object} io - api, origin, sleep, now.
 * @param {object} test - The catalog's installedTest for the case.
 * @param {object} budgets - runBudgetMs, pollMs.
 * @returns {Promise<{status: number, run: object|null, error?: string}>} The final run record.
 */
async function runTutor(io, test, budgets) {
  const body = { caseId: test.id, requestId: crypto.randomUUID(), revision: test.revision, executionRevision: test.executionRevision };
  const started = await io.api('POST', '/api/test-lab/runs', body, { headers: common.sameOriginHeaders(io.origin, 'x-oshal-test-lab') });
  const runId = started.json && started.json.run && started.json.run.id;
  if (started.status !== 202 || !runId) return { status: started.status, run: null, error: String((started.json && started.json.error) || 'no run id') };
  const followed = await common.pollUntil(io, { budgetMs: budgets.runBudgetMs, pollMs: budgets.pollMs }, async () => {
    const read = await io.api('GET', `/api/test-lab/runs/${encodeURIComponent(runId)}`);
    const run = read.json && read.json.run;
    return { done: Boolean(run && TERMINAL.includes(run.state)), value: run || null };
  });
  return { status: 202, run: followed.value, ...(followed.done ? {} : { error: `still ${followed.value ? followed.value.state : 'unknown'} after ${Math.round(budgets.runBudgetMs / 1000)}s` }) };
}

/**
 * @description Judge the Tutor run: it must have passed AND executed tests, none failing.
 * @param {{status: number, run: object|null, error?: string}} ran - The followed run.
 * @returns {{ok: boolean, detail: string, counts: {passed: number, failed: number}}} The judgement.
 */
function judgeTutor(ran) {
  const counts = countTests(ran.run && ran.run.result && ran.run.result.output);
  if (!ran.run) return { ok: false, detail: `the Tutor case did not start (HTTP ${ran.status}: ${ran.error})`, counts };
  if (ran.error) return { ok: false, detail: `the Tutor case is ${ran.error}`, counts };
  if (ran.run.state !== 'passed') {
    const why = ran.run.result && ran.run.result.error ? `: ${String(ran.run.result.error).slice(0, 200)}` : '';
    return { ok: false, detail: `the Tutor case ended ${ran.run.state}${why}`, counts };
  }
  if (counts.passed < 1 || counts.failed > 0) {
    return { ok: false, detail: `the Tutor case reported passed but its output shows ${counts.passed} passed / ${counts.failed} failed tests (not an executed run)`, counts };
  }
  return { ok: true, detail: `the Tutor case executed ${counts.passed} test(s), 0 failed`, counts };
}

/**
 * @description Find the Tutor case in the caller's Lab catalog.
 * @param {object} ports - api.
 * @returns {Promise<{test: object|null, detail: string}>} The case's installedTest, or why it is absent.
 */
async function findTutorCase(ports) {
  const catalog = await ports.api('GET', '/api/test-lab/catalog');
  const scenarios = Array.isArray(catalog.json && catalog.json.scenarios) ? catalog.json.scenarios : [];
  const entry = scenarios.find((s) => s && s.id === TUTOR_CASE_ID);
  if (catalog.status !== 200) return { test: null, detail: `the Lab catalog answered HTTP ${catalog.status}` };
  if (!entry || !entry.installedTest) return { test: null, detail: `the installed catalog lists no ${TUTOR_CASE_ID} (Little Monsters not installed, or a version before the case)` };
  return { test: entry.installedTest, detail: '' };
}

/**
 * @description Whether only the api's unfinished runner probe holds a catalog entry back.
 * @param {object|null} test - The catalog's installedTest for the case.
 * @returns {boolean} True when the case is listed, not runnable, and its reason is the runner-unverified one.
 */
function awaitsRunnerProbe(test) {
  return Boolean(test) && !test.runnable && test.pendingReason === RUNNER_UNVERIFIED_REASON;
}

/**
 * @description Find the Tutor case, re-reading the catalog while only the runner probe holds it back.
 * The api begins that probe on the first catalog listing after a start and lists browser cases as not
 * runnable until it finishes, so one read straight after a restart says nothing about the runner. Every
 * other answer (runnable, absent, another reason, a failed read) ends the wait at that read.
 * @param {object} io - api, sleep, now.
 * @param {object} budgets - probeBudgetMs, pollMs.
 * @returns {Promise<{test: object|null, detail: string, waitedMs: number, expired: boolean}>} The last read.
 */
async function awaitTutorCase(io, budgets) {
  const followed = await common.pollUntil(io, { budgetMs: budgets.probeBudgetMs, pollMs: budgets.pollMs }, async () => {
    const found = await findTutorCase(io);
    return { done: !awaitsRunnerProbe(found.test), value: found };
  });
  return { ...followed.value, waitedMs: followed.elapsedMs, expired: !followed.done };
}

/**
 * @description Why a listed Tutor case is not run: its pending reason, and the wait when one ran out.
 * @param {{test: object, waitedMs: number, expired: boolean}} found - The last catalog read.
 * @returns {string} The blocked detail.
 */
function notRunnableDetail(found) {
  const waited = found.expired ? ` (still so after ${Math.round(found.waitedMs / 1000)}s of re-reading the catalog)` : '';
  return `the Tutor case (Little Monsters ${found.test.appVersion}) is not runnable here: ${found.test.pendingReason || 'no reason given'}${waited}`;
}

/**
 * @description Run the Tutor half: find it (waiting out the runner probe), refuse a non-runnable case by its reason, else run it.
 * @param {object} io - Ports with clock.
 * @param {object} budgets - Budgets.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{state: 'ok'|'failed'|'blocked', detail: string, waitedMs: number, counts?: object}>} The half's outcome.
 */
async function tutorHalf(io, budgets, ledger) {
  const found = await awaitTutorCase(io, budgets);
  if (!found.test) return { state: 'blocked', detail: found.detail, waitedMs: found.waitedMs };
  if (!found.test.runnable) return { state: 'blocked', detail: notRunnableDetail(found), waitedMs: found.waitedMs };
  const ran = await runTutor(io, found.test, budgets);
  if (ran.run && ran.run.id) ledger.kept('test-lab-run', ran.run.id, 'the Lab run history row is the recorded evidence');
  const judged = judgeTutor(ran);
  return { state: judged.ok ? 'ok' : 'failed', detail: `${judged.detail} (Little Monsters ${found.test.appVersion})`, counts: judged.counts, waitedMs: found.waitedMs };
}

/**
 * @description Run the case once.
 * @param {object} ports - api, origin (and optional sleep/now).
 * @param {object} [options] - Budget overrides (runBudgetMs, pollMs, probeBudgetMs).
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, [...NEEDS, 'origin']);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const io = common.withClock(ports);
  const budgets = common.budgetsFrom(DEFAULT_BUDGETS, options);
  const ledger = new common.CleanupLedger();
  let verdict;
  let evidence = {};
  try {
    const card = judgeCard(await runCard(io, CARD_ID));
    const mermaid = await probeMermaid(io);
    const tutor = await tutorHalf(io, budgets, ledger);
    evidence = { cardSteps: card.steps, mermaidVersion: mermaid.version, tutor: tutor.detail, tutorCounts: tutor.counts || null, tutorCatalogWaitMs: tutor.waitedMs };
    const parts = [card.detail, mermaid.detail, tutor.detail];
    if (!card.ok || !mermaid.ok || tutor.state === 'failed') verdict = { state: 'fail', detail: `${parts.join('; ')}.` };
    else if (tutor.state === 'blocked') verdict = { state: 'degraded', detail: `${parts.join('; ')}. The renderer is live-proven; the Tutor half is not.` };
    else verdict = { state: 'pass', detail: `${parts.join('; ')}.` };
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` };
  }
  return common.finish(CASE_ID, verdict, ledger, evidence);
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, CARD_ID, TUTOR_CASE_ID, RUNNER_UNVERIFIED_REASON, countTests, judgeCard, judgeTutor, probeMermaid, run };
