/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Test Lab package runs cancel themselves when an all-package authority re-check runs past 5 s": run the installed presentations `brand-render` package case through the durable run route, time every GET /api/test-lab/runs/:id read while it runs, and require the run to end passed with executed tests and every read answering 200 in under 1 s. A run that ends cancelled (the defect withheld its output) or any slow or failed read is a fail; a case the catalog does not list is unavailable and a listed case that is not runnable is degraded, both before anything is written. Writes only the Lab's own run-history row, which is the recorded evidence.
 */

'use strict';

const crypto = require('node:crypto');
const common = require('./live-acceptance-common.js');

const CASE_ID = 'package-run-live';
const KEY = 'package-run';
const TITLE = 'A package run keeps its own verdict, and its reads stay fast, on the installed build';
const NEEDS = Object.freeze(['api']);
/** The installed package case the Lab catalog lists for the presentations brand-look renders. */
const PACKAGE_CASE_ID = 'app:presentations:test:brand-render';
/** Every read of the run while it runs must answer within this (the backlog entry's live bar). */
const READ_BUDGET_MS = 1000;
/** Terminal durable-run states (test-lab-run-schema.ts). */
const TERMINAL = Object.freeze(['passed', 'failed', 'pending', 'cancelled', 'interrupted']);
/** One read a second gives the latency bar many samples during a run of tens of seconds. */
const DEFAULT_BUDGETS = Object.freeze({ runBudgetMs: 300_000, pollMs: 1_000 });
/** The suites that guard the run-path authority scope this case proves live. */
const REGRESSION_TESTS = Object.freeze(['test-lab-run-history', 'test-lab-wiring', 'test-lab-schedule-wiring']
  .map((name) => Object.freeze({ level: 'unit', path: `tests/unit/${name}.spec.ts` })));

/**
 * @description Count executed tests in a package run's output (the node:test TAP summary).
 * @param {unknown} output - The run's captured output.
 * @returns {{passed: number, failed: number}} The counts (0 when the output names none).
 */
function countTests(output) {
  const text = String(output || '');
  const tap = (name) => { const m = text.match(new RegExp(`^# ${name} (\\d+)`, 'm')); return m ? Number(m[1]) : 0; };
  return { passed: tap('pass'), failed: tap('fail') };
}

/**
 * @description Find the package case in the caller's Lab catalog.
 * @param {object} io - api.
 * @returns {Promise<{test: object|null, detail: string}>} The case's installedTest, or why it is absent.
 */
async function findCase(io) {
  const catalog = await io.api('GET', '/api/test-lab/catalog');
  if (catalog.status !== 200) return { test: null, detail: `The Lab catalog answered HTTP ${catalog.status}.` };
  const scenarios = Array.isArray(catalog.json && catalog.json.scenarios) ? catalog.json.scenarios : [];
  const entry = scenarios.find((s) => s && s.id === PACKAGE_CASE_ID);
  if (!entry || !entry.installedTest) return { test: null, detail: `The installed catalog lists no ${PACKAGE_CASE_ID} (presentations not installed, or a version before 2.13.0).` };
  return { test: entry.installedTest, detail: '' };
}

/**
 * @description Read the run once and time the read.
 * @param {object} io - api, now.
 * @param {string} runId - The run id.
 * @returns {Promise<{status: number, ms: number, run: object|null}>} The read.
 */
async function timedRead(io, runId) {
  const started = io.now();
  const read = await io.api('GET', `/api/test-lab/runs/${encodeURIComponent(runId)}`);
  return { status: read.status, ms: io.now() - started, run: (read.json && read.json.run) || null };
}

/**
 * @description Start the case through the durable run route and follow it to a terminal state, timing every read.
 * A read that fails is recorded and the follow continues, so the run's own outcome is still reported.
 * @param {object} io - api, origin, sleep, now.
 * @param {object} test - The catalog's installedTest for the case.
 * @param {object} budgets - runBudgetMs, pollMs.
 * @returns {Promise<{status: number, runId: string|null, run: object|null, reads: object[], error?: string}>} The followed run.
 */
async function followRun(io, test, budgets) {
  const body = { caseId: test.id, requestId: crypto.randomUUID(), revision: test.revision, executionRevision: test.executionRevision };
  const started = await io.api('POST', '/api/test-lab/runs', body, { headers: common.sameOriginHeaders(io.origin, 'x-oshal-test-lab') });
  const runId = started.json && started.json.run && started.json.run.id;
  if (started.status !== 202 || !runId) return { status: started.status, runId: null, run: null, reads: [], error: String((started.json && started.json.error) || 'no run id') };
  const reads = [];
  let last = null;
  const followed = await common.pollUntil(io, { budgetMs: budgets.runBudgetMs, pollMs: budgets.pollMs }, async () => {
    const read = await timedRead(io, runId);
    reads.push({ status: read.status, ms: read.ms, state: read.run ? read.run.state : null });
    if (read.run) last = read.run;
    return { done: Boolean(read.run && TERMINAL.includes(read.run.state)), value: last };
  });
  const still = followed.done ? {} : { error: `still ${last ? last.state : 'unread'} after ${Math.round(budgets.runBudgetMs / 1000)}s` };
  return { status: 202, runId, run: last, reads, ...still };
}

/**
 * @description The reads that missed the bar: not HTTP 200, or READ_BUDGET_MS or longer.
 * @param {Array<{status: number, ms: number}>} reads - Every timed read.
 * @returns {string|null} What missed, or null when every read met the bar.
 */
function slowReads(reads) {
  const missed = reads.filter((r) => r.status !== 200 || r.ms >= READ_BUDGET_MS);
  if (!missed.length) return null;
  const shown = missed.slice(0, 5).map((r) => `HTTP ${r.status} in ${r.ms} ms`).join(', ');
  return `${missed.length} of ${reads.length} run read(s) answered non-200 or took ${READ_BUDGET_MS} ms or more (${shown})`;
}

/**
 * @description Judge the followed run: it must end passed with executed tests, and every read must meet the bar.
 * @param {{status: number, run: object|null, reads: object[], error?: string}} ran - The followed run.
 * @returns {{ok: boolean, detail: string}} The judgement.
 */
function judgeRun(ran) {
  if (!ran.runId) return { ok: false, detail: `the ${PACKAGE_CASE_ID} run did not start (HTTP ${ran.status}: ${ran.error})` };
  const slowest = ran.reads.reduce((max, r) => Math.max(max, r.ms), 0);
  const reads = `${ran.reads.length} run read(s), slowest ${slowest} ms`;
  const problems = [];
  const missed = slowReads(ran.reads);
  if (missed) problems.push(missed);
  const state = ran.run ? ran.run.state : 'unread';
  const why = ran.run && ran.run.result && ran.run.result.error ? `: ${String(ran.run.result.error).slice(0, 200)}` : '';
  const counts = countTests(ran.run && ran.run.result && ran.run.result.output);
  if (ran.error) problems.push(`the run is ${ran.error}`);
  else if (state !== 'passed') problems.push(`the run ended ${state}${why}`);
  else if (counts.passed < 1 || counts.failed > 0) problems.push(`the run reported passed but its output shows ${counts.passed} passed / ${counts.failed} failed tests`);
  if (problems.length) return { ok: false, detail: `${problems.join('; ')} (${reads})` };
  return { ok: true, detail: `the ${PACKAGE_CASE_ID} run passed, executing ${counts.passed} test(s), 0 failed; ${reads}, every one HTTP 200 under ${READ_BUDGET_MS} ms` };
}

/**
 * @description Run the case once.
 * @param {object} ports - api, origin (and optional sleep/now).
 * @param {object} [options] - Budget overrides (runBudgetMs, pollMs).
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
    const found = await findCase(io);
    if (!found.test) return common.unavailable(CASE_ID, found.detail);
    const version = `presentations ${found.test.appVersion}`;
    if (!found.test.runnable) return common.finish(CASE_ID, { state: 'degraded', detail: `The ${PACKAGE_CASE_ID} case (${version}) is not runnable here: ${found.test.pendingReason || 'no reason given'}. Nothing was run.` }, ledger);
    const ran = await followRun(io, found.test, budgets);
    if (ran.runId) ledger.kept('test-lab-run', ran.runId, 'the Lab run history row is the recorded evidence');
    const judged = judgeRun(ran);
    evidence = { runId: ran.runId, state: ran.run ? ran.run.state : null, reads: ran.reads, packageVersion: found.test.appVersion };
    verdict = { state: judged.ok ? 'pass' : 'fail', detail: `${judged.detail} (${version}).` };
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` };
  }
  return common.finish(CASE_ID, verdict, ledger, evidence);
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, REGRESSION_TESTS, PACKAGE_CASE_ID, READ_BUDGET_MS, DEFAULT_BUDGETS, countTests, judgeRun, run };
