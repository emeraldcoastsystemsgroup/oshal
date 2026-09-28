/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Queued paper-to-live parity features" against the installed build, as the token's owner and READ-ONLY: run the core 'trading-parity-features' Test Lab card (market gap, exit plans, yield sleeve: all three steps must pass, which means each is armed on the paper book; a degraded step is reported as not runnable with the setting it names, a failed step fails the case), read the trading package's plan route for the paper book (GET /api/trading/position-plans answers its plans and the plan arm; 404 = a package before the route), and prove both promotion paths still refuse without confirm - POST /api/trading/position-plans/amend and POST /api/trading/accounts/books/<paper book>/mix must each answer 428 to a body carrying a parity change and no confirm. No request carries confirm, so nothing is written.
 */

'use strict';

const common = require('./live-acceptance-common.js');

const CASE_ID = 'trading-parity-live';
const KEY = 'trading-parity';
const TITLE = 'Trading paper-to-live parity: gap filter, exit plans, yield sleeve (armed on paper, confirm-gated promotion)';
const NEEDS = Object.freeze(['api']);
const CARD_ID = 'trading-parity-features';
const STEPS = Object.freeze(['market-gap-readback', 'exit-plan-readback', 'yield-sleeve-readback']);

/**
 * @description Judge the parity card: every step present; all pass = pass; a failed step = fail;
 * otherwise (a degraded step: that feature is not armed on paper) the case cannot judge the soak yet.
 * @param {{status: number, json: object}} res - POST /api/test-lab/run for the card.
 * @returns {{state: 'pass'|'fail'|'unavailable', detail: string}} The judgement.
 */
function judgeCard(res) {
  const card = (Array.isArray(res.json && res.json.results) ? res.json.results : []).find((c) => c && c.id === CARD_ID);
  if (!card) return { state: 'unavailable', detail: `card ${CARD_ID} did not run (HTTP ${res.status}); the build predates it` };
  // The run answer carries the steps in registration order (a StepResult has no id of its own).
  const steps = Array.isArray(card.steps) ? card.steps.slice(0, STEPS.length) : [];
  if (steps.length < STEPS.length) return { state: 'unavailable', detail: `card ${CARD_ID} ran ${steps.length} of ${STEPS.length} steps; the build predates the yield sleeve` };
  const line = steps.map((s, i) => `${STEPS[i]}=${s.state}`).join(', ');
  const failed = steps.filter((s) => s.state === 'fail');
  if (failed.length) return { state: 'fail', detail: `card ${CARD_ID}: ${line}; ${String(failed[0].detail || '').slice(0, 240)}` };
  const degraded = steps.filter((s) => s.state !== 'pass');
  if (degraded.length) return { state: 'unavailable', detail: `card ${CARD_ID}: ${line}; ${String(degraded[0].detail || '').slice(0, 240)}` };
  return { state: 'pass', detail: `card ${CARD_ID}: ${line}` };
}

/**
 * @description Judge the package's plan route for the paper book.
 * @param {{status: number, json: object}} res - GET /api/trading/position-plans?book=paper.
 * @returns {{state: 'pass'|'fail'|'unavailable', detail: string}} The judgement.
 */
function judgePlans(res) {
  if (res.status === 404) return { state: 'unavailable', detail: 'GET /api/trading/position-plans is not mounted (trading not installed, or a version before the plan routes)' };
  const body = res.json || {};
  if (res.status !== 200 || !Array.isArray(body.plans) || !body.armed || typeof body.armed.sessions !== 'number') {
    return { state: 'fail', detail: `GET /api/trading/position-plans answered HTTP ${res.status} without plans[] and armed{sessions}` };
  }
  return { state: 'pass', detail: `paper book: ${body.plans.length} open plan(s), plans ${body.armed.sessions > 0 ? `armed at ${body.armed.sessions} sessions (${body.armed.source})` : 'off'}` };
}

/**
 * @description The two promotion paths, each sent a parity change WITHOUT confirm: both must refuse 428.
 * @param {object} ports - api.
 * @returns {Promise<{state: 'pass'|'fail'|'unavailable', detail: string}>} The judgement.
 */
async function confirmGates(ports) {
  const accounts = await ports.api('GET', '/api/trading/accounts');
  const books = Array.isArray(accounts.json && accounts.json.books) ? accounts.json.books : [];
  const paper = books.find((b) => b && b.ref === 'paper');
  if (accounts.status !== 200 || !paper || !paper.bookId) return { state: 'unavailable', detail: `GET /api/trading/accounts answered HTTP ${accounts.status} without the paper book` };
  const amend = await ports.api('POST', '/api/trading/position-plans/amend?book=paper', { sessions: 5, book: 'paper' });
  const mix = await ports.api('POST', `/api/trading/accounts/books/${encodeURIComponent(paper.bookId)}/mix`, { yieldSleeveFloatPct: 5, marketGapFilterPct: 1, exitPlanSessions: 20 });
  const detail = `unconfirmed amend -> HTTP ${amend.status}, unconfirmed parity mix edit -> HTTP ${mix.status}`;
  return amend.status === 428 && mix.status === 428 ? { state: 'pass', detail } : { state: 'fail', detail: `${detail} (both must be 428)` };
}

/**
 * @description Run the case once. Read-only: no request carries confirm, so there is nothing to clean up.
 * @param {object} ports - api.
 * @returns {Promise<object>} The result with its (empty) cleanup receipt.
 */
async function run(ports) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const ledger = new common.CleanupLedger();
  let verdict;
  let evidence = {};
  try {
    const plans = judgePlans(await ports.api('GET', '/api/trading/position-plans?book=paper&status=open'));
    if (plans.state === 'unavailable') return common.unavailable(CASE_ID, `${plans.detail}.`);
    const gates = await confirmGates(ports);
    const card = judgeCard(await ports.api('POST', '/api/test-lab/run', { scenarioId: CARD_ID }));
    evidence = { plans: plans.detail, gates: gates.detail, card: card.detail };
    const parts = [plans, gates, card];
    const detail = `${parts.map((p) => p.detail).join('; ')}.`;
    const state = parts.some((p) => p.state === 'fail') ? 'fail' : parts.every((p) => p.state === 'pass') ? 'pass' : 'unavailable';
    verdict = { state, detail };
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` };
  }
  return common.finish(CASE_ID, verdict, ledger, evidence);
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, CARD_ID, judgeCard, judgePlans, confirmGates, run };
