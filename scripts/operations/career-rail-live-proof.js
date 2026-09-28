#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Career scoring/tailoring bot-node migration" (career-hunter 1.24.0 replaced the app's only model path with the worker rail: every engine model call is a loopback POST /api/career-hunter/engine/complete that runs on the dedicated Career bot cb000000-0000-0000-0000-000000000001 through the kernel's accounted bot rail). As the operator automation identity it starts the smallest real engine run that reaches the rail (the owner-scoped manual `score` run; `match` is deterministic and `pull` scores 150 in-lane jobs), watches the owner's run list, cancels the run as soon as its first rail call is admitted so the spend is bounded, and then requires the kernel's own attribution: the chat_tasks rollup row for this owner and the Career bot plus at least one oshal_cost_events ledger row written since the run started, both read under the owner's own RLS identity. A rail call the kernel refused before package code (authorization_identity_required, 401, 403 - the shape tests/unit/career-rail-enforce-posture.spec.ts proves an enforce box answers) fails LOUDLY naming the refusal, as does a run that ends on any rail failure. The proof creates no synthetic rows: the scores it produces are the owner's own scoring work, exactly what the nightly pass writes, and stay; what it does create - the engine run and its rail token - it leaves terminal and revoked, and anything still running afterwards is reported as incomplete cleanup. Same host/container split as lora-import-live-proof.js.
 */

'use strict';

// Usage (from a core checkout on the box, after career-hunter >= 1.24.0 is staged):
//   OSHAL_VERIFY_ENV_FILE=C:/Projects/oshal/.env OSHAL_VERIFY_API_CONTAINER=oshal-local-api \
//     node scripts/operations/career-rail-live-proof.js
// Knobs: OSHAL_VERIFY_OPERATOR_PAT (else read by name from OSHAL_VERIFY_ENV_FILE or ./.env),
//        OSHAL_VERIFY_API_CONTAINER, OSHAL_CAREER_RAIL_RUN_BUDGET_MS, OSHAL_CAREER_RAIL_LEDGER_BUDGET_MS,
//        OSHAL_CAREER_RAIL_POLL_MS.
// Exit 0 pass, 1 fail, 2 not runnable (no PAT / package below 1.24.0 / caller not admitted / no
// posting to score). Spends the owner's own scoring calls on the Career bot, bounded by cancellation.

const path = require('node:path');
const runner = require('./live-proof-runner');

const CASE_ID = 'career-worker-rail-completion';
const PACKAGE = 'career-hunter';
/** The dedicated Career bot the rail dispatches to (career-hunter/oshal-app.yaml bots[]). */
const CAREER_AGENT_ID = 'cb000000-0000-0000-0000-000000000001';
/** The first package version that has the rail at all. */
const RAIL_MIN_VERSION = [1, 24, 0];
/** The only manual run verb whose engine path reaches enrich.complete (score.py _score_one). */
const VERB = 'score';
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_BUDGETS = Object.freeze({ runBudgetMs: 600_000, ledgerBudgetMs: 180_000, pollMs: 3_000 });
/**
 * Refusals that mean the KERNEL (or the rail's own gate) turned the engine child away before any
 * model work: the enforce-mode identity refusal, the two other application-policy answers, the
 * plain statuses enrich.py records when the answer carried no error code, and the rail handler's
 * own two gates. Any of these in the run's stderr tail or recorded reason names the refusal.
 */
const RAIL_REFUSALS = Object.freeze(['authorization_identity_required', 'authorization_app_admin_required',
  'authorization_app_unavailable', 'http-401', 'http-403', 'trusted-subject-required', 'run-token-refused']);

/** The owner's accumulated rollup for this bot: the row the node writes under the rail's workspace. */
const ROLLUP_SQL = `SELECT task_id, agent_id, owner_sub, status, total_requests, total_cost, updated_at
  FROM chat_tasks WHERE task_id = $1 AND agent_id = $2 AND owner_sub = $3`;
/** Per-call ledger rows for the same task since the run started (migration 078; 090 adds tokens/duration). */
const LEDGER_SQL = `SELECT count(*)::int AS calls, coalesce(sum(cost_usd), 0)::float8 AS cost_usd,
    coalesce(sum(input_tokens), 0)::bigint AS input_tokens, coalesce(sum(output_tokens), 0)::bigint AS output_tokens
  FROM oshal_cost_events WHERE task_id = $1 AND agent_id = $2 AND owner_sub = $3 AND ts >= $4`;

/**
 * @description The chat_tasks task id the Career bot records the rail's calls under: the node scopes
 * every request to `<canonical workspace>::<agent>`, and the rail's workspace is `career-engine-<owner>`
 * (career-hunter/src-routes/career-worker-rail.ts workerRequest).
 * @param {(value: string) => string} canonical - The kernel's canonicalBotWorkspaceId.
 * @param {string} ownerSub - The run owner's exact subject.
 * @returns {string} The rollup task id.
 */
function railTaskId(canonical, ownerSub) {
  return `${canonical(`career-engine-${ownerSub}`)}::${CAREER_AGENT_ID}`;
}

/**
 * @description Whether an installed package version has the worker rail.
 * @param {unknown} version - The manifest version.
 * @returns {boolean} True for 1.24.0 and later.
 */
function hasRail(version) {
  const parts = String(version || '').split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return false;
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] > RAIL_MIN_VERSION[i]) return true;
    if (parts[i] < RAIL_MIN_VERSION[i]) return false;
  }
  return true;
}

/**
 * @description Name the refusal a run's diagnostics carry, if any.
 * @param {Array<unknown>} texts - The run's recorded reason, the route's error and the stderr tail.
 * @returns {string|null} The first known refusal code found, or null.
 */
function detectRailRefusal(texts) {
  const joined = texts.map((text) => String(text ?? '')).join('\n');
  return RAIL_REFUSALS.find((code) => joined.includes(code)) || null;
}

/**
 * @description Read the kernel's attribution for this owner and the Career bot as the owner.
 * @param {object} ports - query, withOwner, ownerSub, taskId.
 * @param {Date} since - Only ledger rows written at or after this instant count.
 * @returns {Promise<{rollup: object|null, ledger: {calls: number, costUsd: number, inputTokens: number, outputTokens: number}}>} What the database holds.
 */
async function readAttribution(ports, since) {
  return ports.withOwner(async () => {
    const rollup = (await ports.query(ROLLUP_SQL, [ports.taskId, CAREER_AGENT_ID, ports.ownerSub])).rows[0] || null;
    const row = (await ports.query(LEDGER_SQL, [ports.taskId, CAREER_AGENT_ID, ports.ownerSub, since])).rows[0] || {};
    return { rollup, ledger: { calls: Number(row.calls || 0), costUsd: Number(row.cost_usd || 0),
      inputTokens: Number(row.input_tokens || 0), outputTokens: Number(row.output_tokens || 0) } };
  });
}

/**
 * @description Find this proof's run in the owner's run list: the newest `score` run started no
 * earlier than the proof itself.
 * @param {object} ports - api.
 * @param {number} startedAtMs - When the proof posted the run.
 * @returns {Promise<object|null>} The owner-visible run record, or null.
 */
async function findRun(ports, startedAtMs) {
  const listed = await ports.api('GET', `/api/${PACKAGE}/runs`);
  const runs = listed.status === 200 && Array.isArray(listed.json.runs) ? listed.json.runs : [];
  return runs.find((run) => run && run.verb === VERB && Number(run.startedAt) >= startedAtMs - 5_000
    && RUN_ID_RE.test(String(run.runId))) || null;
}

/**
 * @description Cancel one run through the owner-only route.
 * @param {object} ports - api.
 * @param {string} runId - The run.
 * @returns {Promise<number>} The route's status.
 */
async function cancelRun(ports, runId) {
  return (await ports.api('POST', `/api/${PACKAGE}/run/${encodeURIComponent(runId)}/cancel`)).status;
}

/**
 * @description Post the manual run and watch the owner's run list while it is in flight. The run
 * is cancelled as soon as its first rail call is admitted, so at most the rail's concurrency
 * ceiling of calls is ever spent; a run that ends on its own is left alone.
 * @param {object} ports - api, sleep, now.
 * @param {object} budgets - runBudgetMs, pollMs.
 * @returns {Promise<{run: object|null, response: object|null, cancelledByProof: boolean, timedOut: boolean}>} The observation.
 */
async function observeRun(ports, budgets) {
  const startedAtMs = ports.now();
  let response = null;
  const posted = ports.api('POST', `/api/${PACKAGE}/run/${VERB}`, undefined, budgets.runBudgetMs + 30_000)
    .then((value) => { response = value; }, (error) => { response = { status: 0, json: { error: error instanceof Error ? error.message : String(error) } }; });
  let run = null;
  let cancelledByProof = false;
  while (!response && ports.now() - startedAtMs < budgets.runBudgetMs) {
    await ports.sleep(budgets.pollMs);
    run = (await findRun(ports, startedAtMs)) || run;
    if (run && run.state === 'running' && Number(run.railCalls) >= 1 && !cancelledByProof) {
      cancelledByProof = (await cancelRun(ports, run.runId)) === 202;
    }
  }
  const timedOut = !response;
  if (!timedOut) await posted;
  run = (await findRun(ports, startedAtMs)) || run;
  return { run, response, cancelledByProof, timedOut };
}

/**
 * @description Wait (bounded) for the kernel's attribution of the admitted calls to land.
 * @param {object} ports - query, withOwner, sleep, now.
 * @param {Date} since - The run's start.
 * @param {object} budgets - ledgerBudgetMs, pollMs.
 * @returns {Promise<{rollup: object|null, ledger: {calls: number, costUsd: number, inputTokens: number, outputTokens: number}}>} The last read.
 */
async function awaitAttribution(ports, since, budgets) {
  const started = ports.now();
  let last = await readAttribution(ports, since);
  while (!(last.rollup && last.ledger.calls >= 1) && ports.now() - started < budgets.ledgerBudgetMs) {
    await ports.sleep(budgets.pollMs);
    last = await readAttribution(ports, since);
  }
  return last;
}

/**
 * @description The verdict for a run the route refused before it started.
 * @param {object} response - The run route's answer.
 * @returns {{state: 'unavailable'|'fail', detail: string}|null} A verdict, or null when the run did start.
 */
function startVerdict(response) {
  if (!response) return null;
  const error = String((response.json && (response.json.error || response.json.err)) || '');
  if (response.status === 401 || response.status === 403) {
    return { state: 'unavailable', detail: `The operator automation identity is not admitted to ${PACKAGE} (POST /run/${VERB} answered HTTP ${response.status} ${error}); no run was started. Grant it the package role first.` };
  }
  // career-engine-response.ts rejectEngineStart: 409 "<verb> already running" (the owner's slot is
  // held) or 429 "busy - too many career runs in progress" (the box's global slots are held).
  if ((response.status === 409 && /already running/i.test(error)) || response.status === 429) {
    return { state: 'unavailable', detail: `${PACKAGE} refused to start a run (HTTP ${response.status} ${error}); another engine run holds the slot. Nothing was started.` };
  }
  if (response.status === 0) return { state: 'fail', detail: `POST /run/${VERB} did not answer: ${error}.` };
  return null;
}

/**
 * @description Decide the verdict from the observed run, the route's answer and the attribution.
 * @param {{run: object|null, response: object|null, cancelledByProof: boolean, timedOut: boolean}} observed - observeRun's outcome.
 * @param {{rollup: object|null, ledger: {calls: number, costUsd: number, inputTokens: number, outputTokens: number}}|null} attribution - What the database holds, or null when never read.
 * @param {object} budgets - For the messages.
 * @returns {{state: 'pass'|'fail'|'unavailable', detail: string}} The verdict before cleanup.
 */
function decideVerdict(observed, attribution, budgets) {
  const { run, response, cancelledByProof, timedOut } = observed;
  const refusedStart = startVerdict(response);
  if (!run) {
    if (refusedStart) return refusedStart;
    return { state: 'fail', detail: `POST /run/${VERB} answered HTTP ${response ? response.status : 'none'} but no ${VERB} run of this owner appeared in GET /runs.` };
  }
  const tail = response && response.json ? String(response.json.err || '') : '';
  if (timedOut || run.state === 'running') {
    return { state: 'fail', detail: `Run ${run.runId} was still running after ${Math.round(budgets.runBudgetMs / 1000)}s (${run.railCalls} rail calls admitted); the proof cancelled it.` };
  }
  if (run.state === 'failed') {
    const refusal = detectRailRefusal([run.reason, response && response.json && response.json.error, tail]);
    if (refusal) {
      return { state: 'fail', detail: `The kernel refused the rail call before package code ran: ${refusal} (run ${run.runId} failed with reason ${run.reason}, ${run.railCalls} calls admitted; engine stderr: "${tail.slice(-300)}").` };
    }
    return { state: 'fail', detail: `Run ${run.runId} failed with reason ${run.reason} after ${run.railCalls} admitted rail calls (engine stderr: "${tail.slice(-300)}").` };
  }
  if (Number(run.railCalls) < 1) {
    return { state: 'unavailable', detail: `Run ${run.runId} ended ${run.state} without a single rail call: no posting of this owner needed scoring, so the rail was not exercised and there is nothing to attribute.` };
  }
  const how = cancelledByProof ? `cancelled by the proof after its first admitted rail call (${run.railCalls} admitted)` : `ended ${run.state} after ${run.railCalls} rail calls`;
  if (!attribution || !attribution.rollup || attribution.ledger.calls < 1) {
    const seen = attribution ? `rollup ${attribution.rollup ? 'present' : 'absent'}, ${attribution.ledger.calls} ledger rows since the run started` : 'not read';
    return { state: 'fail', detail: `Run ${run.runId} was ${how}, but the kernel recorded no cost for agent ${CAREER_AGENT_ID} under this owner within ${Math.round(budgets.ledgerBudgetMs / 1000)}s (${seen}).` };
  }
  const ledger = attribution.ledger;
  return { state: 'pass', detail: `Run ${run.runId} was ${how}; the Career bot ${CAREER_AGENT_ID} recorded ${ledger.calls} ledger row(s) for this owner since the run started (${ledger.inputTokens} in / ${ledger.outputTokens} out tokens, $${ledger.costUsd.toFixed(6)}), and the owner's rollup row ${attribution.rollup.task_id} stands at ${attribution.rollup.total_requests} requests.` };
}

/**
 * @description Leave nothing running: a run still in flight is cancelled and must reach a terminal
 * state. The scores the run wrote are the owner's own scoring work and stay.
 * @param {object} ports - api, sleep.
 * @param {object|null} run - The observed run.
 * @param {object} budgets - pollMs.
 * @returns {Promise<string[]>} Cleanup errors; empty means nothing of the proof's is still live.
 */
async function cleanUpRun(ports, run, budgets) {
  if (!run || run.state !== 'running') return [];
  const status = await cancelRun(ports, run.runId);
  if (status !== 202 && status !== 409) return [`run ${run.runId} could not be cancelled (HTTP ${status})`];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await ports.sleep(budgets.pollMs);
    const current = await findRun(ports, Number(run.startedAt) - 1);
    if (!current || current.state !== 'running') return [];
  }
  return [`run ${run.runId} is still running after cancellation`];
}

/**
 * @description Run the whole case once; cleanup always runs once a run was observed.
 * @param {object} ports - api, query, withOwner, ownerSub, taskId, careerVersion, sleep?, now?.
 * @param {object} [options] - Budget overrides.
 * @returns {Promise<{caseId: string, state: string, detail: string, evidence: object}>} The result.
 */
async function runCareerRailAcceptance(ports, options = {}) {
  const io = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => Date.now(), ...ports };
  const budgets = { ...DEFAULT_BUDGETS };
  for (const key of Object.keys(DEFAULT_BUDGETS)) if (Number(options[key]) > 0) budgets[key] = Number(options[key]);
  const since = new Date(io.now());
  const evidence = { verb: VERB, careerVersion: io.careerVersion || null, agentId: CAREER_AGENT_ID, taskId: io.taskId, startedAt: since.toISOString() };
  let observed = { run: null, response: null, cancelledByProof: false, timedOut: false };
  let verdict = { state: 'fail', detail: 'The case did not finish.' };
  try {
    const before = await readAttribution(io, since);
    evidence.rollupRequestsBefore = before.rollup ? Number(before.rollup.total_requests) : null;
    observed = await observeRun(io, budgets);
    const { run, response } = observed;
    Object.assign(evidence, { runId: run ? run.runId : null, runState: run ? run.state : null, runReason: run ? run.reason : null,
      railCalls: run ? run.railCalls : null, cancelledByProof: observed.cancelledByProof, routeStatus: response ? response.status : null });
    const attributable = run && !observed.timedOut && run.state !== 'running' && run.state !== 'failed' && Number(run.railCalls) >= 1;
    const attribution = attributable ? await awaitAttribution(io, since, budgets) : null;
    if (attribution) Object.assign(evidence, { ledger: attribution.ledger, rollupRequestsAfter: attribution.rollup ? Number(attribution.rollup.total_requests) : null });
    verdict = decideVerdict(observed, attribution, budgets);
  } catch (error) {
    verdict = { state: 'fail', detail: error instanceof Error ? error.message : String(error) };
  }
  const cleanupErrors = await cleanUpRun(io, observed.run, budgets);
  const detail = cleanupErrors.length ? `${verdict.detail} CLEANUP INCOMPLETE: ${cleanupErrors.join('; ')}.`
    : `${verdict.detail}${observed.run ? ' The run is terminal and its rail token revoked; the scores it wrote are the owner\'s own and stay.' : ''}`;
  return { caseId: CASE_ID, state: cleanupErrors.length ? 'fail' : verdict.state, detail, evidence: { ...evidence, cleanupErrors } };
}

/**
 * @description Host mode: stage the proof into the api container and run it there.
 * @returns {never} Exits with the proof's status.
 */
function runOnHost() {
  const repo = path.resolve(__dirname, '..', '..');
  const pat = runner.readOperatorPat(process.env, process.env.OSHAL_VERIFY_ENV_FILE || path.join(repo, '.env'));
  if (!pat) {
    process.stdout.write(`${CASE_ID} UNAVAILABLE: ${runner.PAT_ENV} is neither exported nor in the .env; nothing was started.\n`);
    process.exit(2);
  }
  const env = { LOG_LEVEL: 'silent', OSHAL_SCHEMA_BOOTSTRAP: 'validate-only' };
  for (const name of ['OSHAL_CAREER_RAIL_RUN_BUDGET_MS', 'OSHAL_CAREER_RAIL_LEDGER_BUDGET_MS', 'OSHAL_CAREER_RAIL_POLL_MS']) if (process.env[name]) env[name] = process.env[name];
  runner.reportAndExit(runner.stageAndRun({
    container: process.env.OSHAL_VERIFY_API_CONTAINER || runner.DEFAULT_API_CONTAINER,
    files: [
      { src: __filename, rel: 'operations/career-rail-live-proof.js' },
      { src: path.join(__dirname, 'live-proof-runner.js'), rel: 'operations/live-proof-runner.js' },
    ],
    entry: 'operations/career-rail-live-proof.js', env, pat, timeoutMs: 20 * 60_000,
  }));
}

/**
 * @description Loopback JSON calls as the PAT's owner.
 * @param {string} base - Loopback base URL.
 * @param {string} token - The operator PAT.
 * @returns {(method: string, route: string, body?: unknown, timeoutMs?: number) => Promise<{status: number, json: object}>} The HTTP port.
 */
function bearerApi(base, token) {
  return async (method, route, body, timeoutMs = 30_000) => {
    const response = await fetch(`${base}${route}`, { method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json: json && typeof json === 'object' ? json : {} };
  };
}

/**
 * @description Container mode: resolve the caller and the installed package, run the case once
 * and print the RESULT line.
 * @returns {Promise<never>} Exits with the case's status.
 */
async function runInContainer() {
  const unavailable = (detail, evidence = {}) => runner.emitResult({ caseId: CASE_ID, state: 'unavailable', detail, evidence });
  const token = String(process.env[runner.PAT_ENV] || '').trim();
  if (!token) return unavailable(`${runner.PAT_ENV} was not forwarded into the container; nothing was started.`);
  const api = bearerApi(`http://127.0.0.1:${process.env.PORT || '5000'}`, token);
  const who = await api('GET', '/api/cli-tokens/whoami');
  const ownerSub = typeof who.json.sub === 'string' ? who.json.sub : '';
  if (who.status !== 200 || !ownerSub) return unavailable(`The operator PAT did not resolve to a caller (HTTP ${who.status}); nothing was started.`);
  const apps = await api('GET', '/api/swarm/apps?status=active');
  const career = (Array.isArray(apps.json.apps) ? apps.json.apps : []).find((app) => app && app.name === PACKAGE);
  if (!career) return unavailable(`The ${PACKAGE} package is not installed and active on this box; nothing was started.`);
  if (!hasRail(career.version)) return unavailable(`${PACKAGE} ${career.version} has no worker rail (1.24.0+); nothing was started.`, { careerVersion: career.version });
  const dist = process.env.OSHAL_ACCEPTANCE_DIST_DIR || path.join(process.cwd(), 'dist');
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { createOptionalPostgresPool } = require(path.join(dist, 'shared/services/database/optional-postgres-pool.js'));
  const { runWithRequestIdentity } = require(path.join(dist, 'shared/services/database/request-identity.js'));
  const { canonicalBotWorkspaceId } = require(path.join(dist, 'app/bot-node-request-scope.js'));
  /* eslint-enable @typescript-eslint/no-require-imports */
  const pool = createOptionalPostgresPool('career-rail-live-proof');
  if (!pool) return unavailable('This container has no PostgreSQL configuration; nothing was started.');
  const result = await runCareerRailAcceptance({
    api, ownerSub, careerVersion: career.version, taskId: railTaskId(canonicalBotWorkspaceId, ownerSub),
    query: (sql, params) => pool.query(sql, params),
    withOwner: (fn) => runWithRequestIdentity({ sub: ownerSub, isOperator: false }, fn),
  }, { runBudgetMs: process.env.OSHAL_CAREER_RAIL_RUN_BUDGET_MS, ledgerBudgetMs: process.env.OSHAL_CAREER_RAIL_LEDGER_BUDGET_MS, pollMs: process.env.OSHAL_CAREER_RAIL_POLL_MS });
  return runner.emitResult(result);
}

if (require.main === module) {
  if (process.argv.includes('--in-container')) {
    runInContainer().catch((error) => runner.emitResult({ caseId: CASE_ID, state: 'fail',
      detail: `The proof crashed: ${error instanceof Error ? error.message : String(error)}`, evidence: {} }));
  } else {
    runOnHost();
  }
}

module.exports = {
  CASE_ID, CAREER_AGENT_ID, PACKAGE, VERB, RAIL_REFUSALS, ROLLUP_SQL, LEDGER_SQL, railTaskId, hasRail, detectRailRefusal,
  readAttribution, decideVerdict, runCareerRailAcceptance,
};
