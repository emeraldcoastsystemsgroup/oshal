#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Career scoring/tailoring bot-node migration" (career-hunter 1.24.0 replaced the app's only model path with the worker rail: every engine model call is a loopback POST /api/career-hunter/engine/complete that runs on the dedicated Career bot cb000000-0000-0000-0000-000000000001 through the kernel's accounted bot rail). As the operator automation identity it starts the smallest real engine run that reaches the rail (the owner-scoped manual `score` run; `match` is deterministic and `pull` scores 150 in-lane jobs), watches the owner's run list, cancels the run as soon as its first rail call is admitted so the spend is bounded, and then requires the kernel's own attribution: the chat_tasks rollup row for this owner and the Career bot plus at least one oshal_cost_events ledger row written since the run started, both read under the owner's own RLS identity. A rail call the kernel refused before package code (authorization_identity_required, 401, 403 - the shape tests/unit/career-rail-enforce-posture.spec.ts proves an enforce box answers) fails LOUDLY naming the refusal, as does a run that ends on any rail failure. The proof creates no synthetic rows: the scores it produces are the owner's own scoring work, exactly what the nightly pass writes, and stay; what it does create - the engine run and its rail token - it leaves terminal and revoked, and anything still running afterwards is reported as incomplete cleanup. Same host/container split as lora-import-live-proof.js.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Attribute by what the proof can know. The first live run (2026-09-28, career-hunter 1.25.1 under enforce, run 517a4078: 8 rail calls admitted) reported "no cost" although the kernel had written two oshal_cost_events rows for the Career bot under the owner: career-hunter declares a catalog, so it is a protected application, and the bot node keys a protected execution's history `protected-<sha256>::<agent>` (src/app/bot-node-execution-handler.ts:264-265 over src/app/bot-node-protected-workspace.ts:28-40, a digest over issuer, subject, application, agent, tenant, workspace and the execution id), never the `career-engine-<owner>::<agent>` id this proof derived. The digest is the isolation boundary and changes per execution, so the proof no longer predicts a task id: the verdict requires oshal_cost_events rows with agent_id = the Career bot, owner_sub = the resolved owner and ts at or after the run's start (read under the owner's RLS identity as before), no more of them than the rail calls the run itself admitted (GET /runs railCalls). The chat_tasks rollup is optional evidence: the owner's rows whose task id ends `::<Career bot>` touched since the start, whatever the workspace shape. The refusal naming and the cleanup contract are unchanged; the pre-run baseline read (only the exact rollup needed it) is gone.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Two more modes; the default is unchanged. `--complete` lets the score run FINISH: no cancellation, the run must reach `succeeded` on its own within the (longer, 30 min default) budget with at least one admitted rail call, a run someone else cancelled is red, and the same ledger attribution applies to every admitted call. `--worker-loss` (requires `--announced-window`: it takes the Career bot away from every user of the box for the length of one run failure) is the visible-termination clause: the container half (career-rail-worker-loss.js) starts a run, waits for its first admitted rail call and prints phase lines; this host half reacts by stopping `oshal-local-career-bot` through docker by name, the container half requires GET /runs to show the run failed with reason career-worker-unavailable and the run route to answer 503, the host restarts the container on the next phase line (or when the proof ends, whatever it did), and the container half waits for a heartbeat strictly newer than the record the dead bot left behind - a bot that does not come back is red. The approve-to-draft half of a complete run is NOT here: career-hunter 1.26.0 has no route that plants or removes a posting or an application row (POST /enqueue-drafts creates durable tickets and rows over the owner's real postings, career-application-routes.ts enqueueForUser/createApplication, and nothing deletes them), so a draft the proof owned and removed cannot be driven yet; it waits on that package seam.
 */

'use strict';

// Usage (from a core checkout on the box, after career-hunter >= 1.24.0 is staged):
//   OSHAL_VERIFY_ENV_FILE=C:/Projects/oshal/.env OSHAL_VERIFY_API_CONTAINER=oshal-local-api \
//     node scripts/operations/career-rail-live-proof.js                              # cancel after the first admitted call (default)
//     node scripts/operations/career-rail-live-proof.js --complete                   # let the score run finish
//     node scripts/operations/career-rail-live-proof.js --worker-loss --announced-window
//                                                       # stop + restart oshal-local-career-bot mid-run
// Knobs: OSHAL_VERIFY_OPERATOR_PAT (else read by name from OSHAL_VERIFY_ENV_FILE or ./.env),
//        OSHAL_VERIFY_API_CONTAINER, OSHAL_VERIFY_CAREER_BOT_CONTAINER (worker-loss),
//        OSHAL_CAREER_RAIL_RUN_BUDGET_MS, OSHAL_CAREER_RAIL_LEDGER_BUDGET_MS, OSHAL_CAREER_RAIL_POLL_MS,
//        OSHAL_CAREER_RAIL_HEARTBEAT_BUDGET_MS (worker-loss).
// Exit 0 pass, 1 fail, 2 not runnable (no PAT / package below 1.24.0 / caller not admitted / no
// posting to score / worker-loss without --announced-window or with the bot container not running).
// Spends the owner's own scoring calls on the Career bot: bounded by cancellation by default, one
// whole score run under --complete, up to one run failure under --worker-loss.

const path = require('node:path');
const runner = require('./live-proof-runner');

const CASE_ID = 'career-worker-rail-completion';
/** Case ids by mode; the default keeps the id the Test Lab card and the first live receipts carry. */
const CASE_IDS = Object.freeze({ cancel: CASE_ID, complete: 'career-worker-rail-complete', 'worker-loss': 'career-worker-rail-worker-loss' });
/** A whole score run (150 in-lane postings at 2 rail slots) needs more than the default's 10 minutes. */
const COMPLETE_RUN_BUDGET_MS = 1_800_000;
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

/**
 * The node records every call as `<workspace>::<agent>` (src/app/bot-node-execution-handler.ts). For
 * a protected application the workspace is a per-execution digest the proof cannot and must not
 * derive (src/app/bot-node-protected-workspace.ts), so rows are matched on this suffix, never on a
 * predicted task id.
 */
const RAIL_TASK_SUFFIX = `::${CAREER_AGENT_ID}`;
/** Per-call ledger rows the Career bot wrote for this owner since the run started (migration 078; 090 adds tokens). */
const LEDGER_SQL = `SELECT count(*)::int AS calls, coalesce(sum(cost_usd), 0)::float8 AS cost_usd,
    coalesce(sum(input_tokens), 0)::bigint AS input_tokens, coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
    coalesce(array_agg(DISTINCT task_id), '{}') AS task_ids
  FROM oshal_cost_events WHERE agent_id = $1 AND owner_sub = $2 AND ts >= $3`;
/** Optional evidence: the owner's Career-bot rollup rows touched since the run started, in any workspace shape. */
const ROLLUP_SQL = `SELECT task_id, total_requests, total_cost, updated_at FROM chat_tasks
  WHERE owner_sub = $1 AND updated_at >= $2 AND right(task_id, char_length($3::text)) = $3::text
  ORDER BY updated_at DESC, task_id LIMIT 50`;

/**
 * @description Read the mode flags. The two extra modes exclude each other; `--in-container` marks
 * the container half and `--announced-window` the operator's outage announcement.
 * @param {string[]} argv - The process arguments after the script path.
 * @returns {{mode: 'cancel'|'complete'|'worker-loss', announcedWindow: boolean, inContainer: boolean, error: string|null}} The parsed flags.
 */
function parseArgs(argv) {
  const chosen = ['--complete', '--worker-loss'].filter((flag) => argv.includes(flag));
  const mode = chosen[0] === '--worker-loss' ? 'worker-loss' : chosen[0] === '--complete' ? 'complete' : 'cancel';
  return {
    mode, announcedWindow: argv.includes('--announced-window'), inContainer: argv.includes('--in-container'),
    error: chosen.length > 1 ? 'choose one of --complete and --worker-loss' : null,
  };
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
 * @description Read the kernel's attribution for this owner and the Career bot as the owner: the
 * ledger rows since the run started (the verdict) and the rollup rows touched since then (evidence).
 * @param {object} ports - query, withOwner, ownerSub.
 * @param {Date} since - Only rows written or touched at or after this instant count.
 * @returns {Promise<{rollups: Array<{taskId: string, totalRequests: number}>, ledger: {calls: number, costUsd: number, inputTokens: number, outputTokens: number, taskIds: string[]}}>} What the database holds.
 */
async function readAttribution(ports, since) {
  return ports.withOwner(async () => {
    const row = (await ports.query(LEDGER_SQL, [CAREER_AGENT_ID, ports.ownerSub, since])).rows[0] || {};
    const rollups = (await ports.query(ROLLUP_SQL, [ports.ownerSub, since, RAIL_TASK_SUFFIX])).rows
      .map((rollup) => ({ taskId: String(rollup.task_id), totalRequests: Number(rollup.total_requests || 0) }));
    return { rollups, ledger: { calls: Number(row.calls || 0), costUsd: Number(row.cost_usd || 0),
      inputTokens: Number(row.input_tokens || 0), outputTokens: Number(row.output_tokens || 0),
      taskIds: Array.isArray(row.task_ids) ? row.task_ids.map(String).sort() : [] } };
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
 * @description Post the manual run and watch the owner's run list while it is in flight. In the
 * default mode the run is cancelled as soon as its first rail call is admitted, so at most the
 * rail's concurrency ceiling of calls is ever spent; a run that ends on its own is left alone. In
 * `complete` mode nothing is cancelled here: the run must end on its own within the budget.
 * @param {object} ports - api, sleep, now.
 * @param {object} budgets - runBudgetMs, pollMs.
 * @param {boolean} [cancelOnFirstCall] - Cancel after the first admitted call (the default mode).
 * @returns {Promise<{run: object|null, response: object|null, cancelledByProof: boolean, timedOut: boolean}>} The observation.
 */
async function observeRun(ports, budgets, cancelOnFirstCall = true) {
  const startedAtMs = ports.now();
  let response = null;
  const posted = ports.api('POST', `/api/${PACKAGE}/run/${VERB}`, undefined, budgets.runBudgetMs + 30_000)
    .then((value) => { response = value; }, (error) => { response = { status: 0, json: { error: error instanceof Error ? error.message : String(error) } }; });
  let run = null;
  let cancelledByProof = false;
  while (!response && ports.now() - startedAtMs < budgets.runBudgetMs) {
    await ports.sleep(budgets.pollMs);
    run = (await findRun(ports, startedAtMs)) || run;
    if (cancelOnFirstCall && run && run.state === 'running' && Number(run.railCalls) >= 1 && !cancelledByProof) {
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
 * @returns {Promise<{rollups: Array<object>, ledger: {calls: number, costUsd: number, inputTokens: number, outputTokens: number, taskIds: string[]}}>} The last read.
 */
async function awaitAttribution(ports, since, budgets) {
  const started = ports.now();
  let last = await readAttribution(ports, since);
  while (last.ledger.calls < 1 && ports.now() - started < budgets.ledgerBudgetMs) {
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
 * @description The verdict for a run that admitted rail calls: the Career bot's ledger rows for this
 * owner since the start must exist, and there may not be more of them than calls the run admitted
 * (each admitted call settles at most one row; more means rows this run cannot account for).
 * @param {object} run - The observed, ended run.
 * @param {string} how - How the run ended, for the message.
 * @param {{rollups: Array<{taskId: string, totalRequests: number}>, ledger: {calls: number, costUsd: number, inputTokens: number, outputTokens: number, taskIds: string[]}}|null} attribution - What the database holds.
 * @param {object} budgets - For the messages.
 * @returns {{state: 'pass'|'fail', detail: string}} The verdict before cleanup.
 */
function attributionVerdict(run, how, attribution, budgets) {
  const rollups = attribution ? attribution.rollups : [];
  const rolled = `${rollups.length} rollup row(s) ending ${RAIL_TASK_SUFFIX} touched`;
  if (!attribution || attribution.ledger.calls < 1) {
    const seen = attribution ? `0 ledger rows since the run started, ${rolled}` : 'not read';
    return { state: 'fail', detail: `Run ${run.runId} was ${how}, but the kernel recorded no cost for agent ${CAREER_AGENT_ID} under this owner within ${Math.round(budgets.ledgerBudgetMs / 1000)}s (${seen}).` };
  }
  const ledger = attribution.ledger;
  if (ledger.calls > Number(run.railCalls)) {
    return { state: 'fail', detail: `Run ${run.runId} was ${how}, but the kernel holds ${ledger.calls} ledger rows for agent ${CAREER_AGENT_ID} under this owner since the run started, more than the ${run.railCalls} rail calls the run admitted: the cost cannot be attributed to this run (task ids ${ledger.taskIds.join(', ')}).` };
  }
  const requests = rollups.reduce((sum, rollup) => sum + rollup.totalRequests, 0);
  return { state: 'pass', detail: `Run ${run.runId} was ${how}; the Career bot ${CAREER_AGENT_ID} recorded ${ledger.calls} ledger row(s) for this owner since the run started (${ledger.inputTokens} in / ${ledger.outputTokens} out tokens, $${ledger.costUsd.toFixed(6)}, task ids ${ledger.taskIds.join(', ')}), no more than the ${run.railCalls} admitted rail calls; ${rolled} since then (${requests} requests).` };
}

/**
 * @description Decide the verdict from the observed run, the route's answer and the attribution.
 * @param {{run: object|null, response: object|null, cancelledByProof: boolean, timedOut: boolean}} observed - observeRun's outcome.
 * @param {{rollups: Array<object>, ledger: {calls: number, costUsd: number, inputTokens: number, outputTokens: number, taskIds: string[]}}|null} attribution - What the database holds, or null when never read.
 * @param {object} budgets - For the messages.
 * @param {'cancel'|'complete'} [mode] - `complete` requires the run to have finished on its own.
 * @returns {{state: 'pass'|'fail'|'unavailable', detail: string}} The verdict before cleanup.
 */
function decideVerdict(observed, attribution, budgets, mode = 'cancel') {
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
  if (mode === 'complete' && run.state !== 'succeeded') {
    return { state: 'fail', detail: `Run ${run.runId} ended ${run.state}${run.reason ? ` (${run.reason})` : ''} after ${run.railCalls} rail calls; a complete run must end succeeded on its own.` };
  }
  if (Number(run.railCalls) < 1) {
    return { state: 'unavailable', detail: `Run ${run.runId} ended ${run.state} without a single rail call: no posting of this owner needed scoring, so the rail was not exercised and there is nothing to attribute.` };
  }
  const how = cancelledByProof ? `cancelled by the proof after its first admitted rail call (${run.railCalls} admitted)`
    : `ended ${run.state} after ${run.railCalls} rail calls${mode === 'complete' ? ', uncancelled' : ''}`;
  return attributionVerdict(run, how, attribution, budgets);
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
 * @param {object} ports - api, query, withOwner, ownerSub, careerVersion, sleep?, now?.
 * @param {object} [options] - Budget overrides, and `mode` (`cancel`, the default, or `complete`).
 * @returns {Promise<{caseId: string, state: string, detail: string, evidence: object}>} The result.
 */
async function runCareerRailAcceptance(ports, options = {}) {
  const io = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => Date.now(), ...ports };
  const mode = options.mode === 'complete' ? 'complete' : 'cancel';
  const budgets = { ...DEFAULT_BUDGETS, ...(mode === 'complete' ? { runBudgetMs: COMPLETE_RUN_BUDGET_MS } : {}) };
  for (const key of Object.keys(DEFAULT_BUDGETS)) if (Number(options[key]) > 0) budgets[key] = Number(options[key]);
  const since = new Date(io.now());
  const evidence = { mode, verb: VERB, careerVersion: io.careerVersion || null, agentId: CAREER_AGENT_ID, startedAt: since.toISOString() };
  let observed = { run: null, response: null, cancelledByProof: false, timedOut: false };
  let verdict = { state: 'fail', detail: 'The case did not finish.' };
  try {
    observed = await observeRun(io, budgets, mode === 'cancel');
    const { run, response } = observed;
    Object.assign(evidence, { runId: run ? run.runId : null, runState: run ? run.state : null, runReason: run ? run.reason : null,
      railCalls: run ? run.railCalls : null, cancelledByProof: observed.cancelledByProof, routeStatus: response ? response.status : null });
    const attributable = run && !observed.timedOut && run.state !== 'running' && run.state !== 'failed' && Number(run.railCalls) >= 1
      && (mode === 'cancel' || run.state === 'succeeded');
    const attribution = attributable ? await awaitAttribution(io, since, budgets) : null;
    if (attribution) Object.assign(evidence, { ledger: attribution.ledger, rollups: attribution.rollups });
    verdict = decideVerdict(observed, attribution, budgets, mode);
  } catch (error) {
    verdict = { state: 'fail', detail: error instanceof Error ? error.message : String(error) };
  }
  const cleanupErrors = await cleanUpRun(io, observed.run, budgets);
  const detail = cleanupErrors.length ? `${verdict.detail} CLEANUP INCOMPLETE: ${cleanupErrors.join('; ')}.`
    : `${verdict.detail}${observed.run ? ' The run is terminal and its rail token revoked; the scores it wrote are the owner\'s own and stay.' : ''}`;
  return { caseId: CASE_IDS[mode], state: cleanupErrors.length ? 'fail' : verdict.state, detail, evidence: { ...evidence, cleanupErrors } };
}


/** The files every mode stages into the api container (the worker-loss half rides along; it is small). */
const STAGED_FILES = Object.freeze([
  { src: __filename, rel: 'operations/career-rail-live-proof.js' },
  { src: path.join(__dirname, 'career-rail-worker-loss.js'), rel: 'operations/career-rail-worker-loss.js' },
  { src: path.join(__dirname, 'live-proof-runner.js'), rel: 'operations/live-proof-runner.js' },
]);
/** The budget knobs forwarded into the container by name. */
const BUDGET_ENV = Object.freeze(['OSHAL_CAREER_RAIL_RUN_BUDGET_MS', 'OSHAL_CAREER_RAIL_LEDGER_BUDGET_MS', 'OSHAL_CAREER_RAIL_POLL_MS',
  'OSHAL_CAREER_RAIL_HEARTBEAT_BUDGET_MS']);

/**
 * @description The worker-loss half, required lazily (it requires this module back for the shared run helpers).
 * @returns {object} career-rail-worker-loss's exports.
 */
function workerLoss() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./career-rail-worker-loss');
}

/**
 * @description One positive integer knob from the environment, or its default.
 * @param {string} name - The variable.
 * @param {number} fallback - The default.
 * @returns {number} The value.
 */
function budgetFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return value > 0 ? value : fallback;
}

/**
 * @description How long the host waits for the container half: the mode's run budget (twice for
 * worker-loss, which waits for admission and then for the failure), the follow-up budget and margin.
 * @param {'cancel'|'complete'|'worker-loss'} mode - The mode.
 * @returns {number} The docker exec ceiling in milliseconds.
 */
function hostTimeoutMs(mode) {
  const run = budgetFromEnv('OSHAL_CAREER_RAIL_RUN_BUDGET_MS', mode === 'complete' ? COMPLETE_RUN_BUDGET_MS : DEFAULT_BUDGETS.runBudgetMs);
  if (mode === 'worker-loss') return run * 2 + budgetFromEnv('OSHAL_CAREER_RAIL_HEARTBEAT_BUDGET_MS', workerLoss().DEFAULT_BUDGETS.heartbeatBudgetMs) + 300_000;
  return run + budgetFromEnv('OSHAL_CAREER_RAIL_LEDGER_BUDGET_MS', DEFAULT_BUDGETS.ledgerBudgetMs) + 300_000;
}

/**
 * @description The staging spec the host runs for one mode.
 * @param {'cancel'|'complete'|'worker-loss'} mode - The mode.
 * @param {string} pat - The operator PAT (forwarded by name).
 * @returns {object} A live-proof-runner spec.
 */
function hostSpec(mode, pat) {
  const env = { LOG_LEVEL: 'silent', OSHAL_SCHEMA_BOOTSTRAP: 'validate-only' };
  for (const name of BUDGET_ENV) if (process.env[name]) env[name] = process.env[name];
  const args = mode === 'cancel' ? [] : [`--${mode}`];
  return { container: process.env.OSHAL_VERIFY_API_CONTAINER || runner.DEFAULT_API_CONTAINER, files: [...STAGED_FILES],
    entry: 'operations/career-rail-live-proof.js', env, pat, timeoutMs: hostTimeoutMs(mode), args };
}

/**
 * @description Host side of `--worker-loss`: refuse without the announced window or with the bot
 * container not running, then stream the container half and act on its phase lines, restarting
 * the container at the end whatever happened. The host's docker outcomes fold into the verdict.
 * @param {string} pat - The operator PAT.
 * @param {{announcedWindow: boolean}} args - The parsed flags.
 * @returns {Promise<never>} Exits with the case's status.
 */
async function runWorkerLossOnHost(pat, args) {
  const loss = workerLoss();
  if (!args.announcedWindow) {
    process.stdout.write(`${loss.CASE_ID} UNAVAILABLE: --worker-loss stops the Career bot for every user of this box; run it inside an announced window with ${loss.ANNOUNCED_FLAG}. Nothing was started.\n`);
    process.exit(2);
  }
  const bot = process.env.OSHAL_VERIFY_CAREER_BOT_CONTAINER || loss.DEFAULT_BOT_CONTAINER;
  if (loss.containerRunning(bot, runner.docker, process.env) !== true) {
    process.stdout.write(`${loss.CASE_ID} UNAVAILABLE: the Career bot container ${bot} is not running (docker inspect); nothing was started and nothing was stopped.\n`);
    process.exit(2);
  }
  const reactor = loss.createWorkerLossReactor({ bot, exec: runner.docker, env: process.env });
  const run = await runner.stageAndStream(hostSpec('worker-loss', pat), { onLine: reactor.onLine });
  const state = reactor.finish();
  const verdict = loss.hostVerdict(runner.parseResult(run.stdout), state, loss.containerRunning(bot, runner.docker, process.env));
  const noise = run.stdout.split(/\r?\n/).filter((line) => !line.startsWith(runner.RESULT_PREFIX)).join('\n');
  const status = { pass: 0, fail: 1, unavailable: 2 }[verdict.state];
  runner.reportAndExit({ status: status === undefined ? 1 : status, stdout: `${noise}\n${runner.RESULT_PREFIX}${JSON.stringify(verdict)}\n`, stderr: run.stderr });
}

/**
 * @description Host mode: stage the proof into the api container and run it there; `--worker-loss`
 * additionally drives the Career bot's container from here.
 * @param {{mode: string, announcedWindow: boolean, error: string|null}} args - The parsed flags.
 * @returns {Promise<never>} Exits with the proof's status.
 */
async function runOnHost(args) {
  if (args.error) {
    process.stdout.write(`${CASE_ID} UNAVAILABLE: ${args.error}; nothing was started.\n`);
    process.exit(2);
  }
  const repo = path.resolve(__dirname, '..', '..');
  const pat = runner.readOperatorPat(process.env, process.env.OSHAL_VERIFY_ENV_FILE || path.join(repo, '.env'));
  if (!pat) {
    process.stdout.write(`${CASE_IDS[args.mode]} UNAVAILABLE: ${runner.PAT_ENV} is neither exported nor in the .env; nothing was started.\n`);
    process.exit(2);
  }
  if (args.mode === 'worker-loss') return runWorkerLossOnHost(pat, args);
  return runner.reportAndExit(runner.stageAndRun(hostSpec(args.mode, pat)));
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
 * @description Resolve the caller and the installed package inside the container; every mode
 * needs both before it starts anything.
 * @param {Function} api - The loopback HTTP port.
 * @returns {Promise<{ownerSub: string, career: object}|{unavailable: string, evidence?: object}>} The context, or why the proof cannot run.
 */
async function resolveContainerContext(api) {
  const who = await api('GET', '/api/cli-tokens/whoami');
  const ownerSub = typeof who.json.sub === 'string' ? who.json.sub : '';
  if (who.status !== 200 || !ownerSub) return { unavailable: `The operator PAT did not resolve to a caller (HTTP ${who.status}); nothing was started.` };
  const apps = await api('GET', '/api/swarm/apps?status=active');
  const career = (Array.isArray(apps.json.apps) ? apps.json.apps : []).find((app) => app && app.name === PACKAGE);
  if (!career) return { unavailable: `The ${PACKAGE} package is not installed and active on this box; nothing was started.` };
  if (!hasRail(career.version)) return { unavailable: `${PACKAGE} ${career.version} has no worker rail (1.24.0+); nothing was started.`, evidence: { careerVersion: career.version } };
  return { ownerSub, career };
}

/**
 * @description Container side of `--worker-loss`: the run and the registry are read from inside,
 * the phase lines go to stdout for the host, and the result is the RESULT line.
 * @param {Function} api - The loopback HTTP port.
 * @param {{ownerSub: string, career: object}} context - The resolved caller and package.
 * @param {string} dist - The compiled kernel's directory.
 * @returns {Promise<object>} The case result.
 */
async function runWorkerLossInContainer(api, context, dist) {
  const loss = workerLoss();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AgentRuntimeRegistryService } = require(path.join(dist, 'features/agent-management/services/agent-runtime-registry-service.js'));
  const registry = new AgentRuntimeRegistryService();
  try {
    return await loss.runWorkerLossAcceptance({
      api, careerVersion: context.career.version,
      registry: { read: () => registry.getAgentRegistration(CAREER_AGENT_ID) },
      phase: (name, data) => process.stdout.write(`${loss.PHASE_PREFIX}${name} ${JSON.stringify(data)}\n`),
    }, { runBudgetMs: process.env.OSHAL_CAREER_RAIL_RUN_BUDGET_MS, heartbeatBudgetMs: process.env.OSHAL_CAREER_RAIL_HEARTBEAT_BUDGET_MS, pollMs: process.env.OSHAL_CAREER_RAIL_POLL_MS });
  } finally {
    await registry.disconnect().catch(() => undefined);
  }
}

/**
 * @description Container mode: resolve the caller and the installed package, run the mode's case
 * once and print the RESULT line.
 * @param {{mode: string}} args - The parsed flags.
 * @returns {Promise<never>} Exits with the case's status.
 */
async function runInContainer(args) {
  const caseId = CASE_IDS[args.mode];
  const unavailable = (detail, evidence = {}) => runner.emitResult({ caseId, state: 'unavailable', detail, evidence });
  const token = String(process.env[runner.PAT_ENV] || '').trim();
  if (!token) return unavailable(`${runner.PAT_ENV} was not forwarded into the container; nothing was started.`);
  const api = bearerApi(`http://127.0.0.1:${process.env.PORT || '5000'}`, token);
  const context = await resolveContainerContext(api);
  if (context.unavailable) return unavailable(context.unavailable, context.evidence);
  const dist = process.env.OSHAL_ACCEPTANCE_DIST_DIR || path.join(process.cwd(), 'dist');
  if (args.mode === 'worker-loss') return runner.emitResult(await runWorkerLossInContainer(api, context, dist));
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { createOptionalPostgresPool } = require(path.join(dist, 'shared/services/database/optional-postgres-pool.js'));
  const { runWithRequestIdentity } = require(path.join(dist, 'shared/services/database/request-identity.js'));
  /* eslint-enable @typescript-eslint/no-require-imports */
  const pool = createOptionalPostgresPool('career-rail-live-proof');
  if (!pool) return unavailable('This container has no PostgreSQL configuration; nothing was started.');
  const result = await runCareerRailAcceptance({
    api, ownerSub: context.ownerSub, careerVersion: context.career.version,
    query: (sql, params) => pool.query(sql, params),
    withOwner: (fn) => runWithRequestIdentity({ sub: context.ownerSub, isOperator: false }, fn),
  }, { mode: args.mode, runBudgetMs: process.env.OSHAL_CAREER_RAIL_RUN_BUDGET_MS, ledgerBudgetMs: process.env.OSHAL_CAREER_RAIL_LEDGER_BUDGET_MS, pollMs: process.env.OSHAL_CAREER_RAIL_POLL_MS });
  return runner.emitResult(result);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.inContainer) {
    runInContainer(args).catch((error) => runner.emitResult({ caseId: CASE_IDS[args.mode], state: 'fail',
      detail: `The proof crashed: ${error instanceof Error ? error.message : String(error)}`, evidence: {} }));
  } else {
    runOnHost(args).catch((error) => {
      process.stdout.write(`${CASE_IDS[args.mode]} FAIL: the host half crashed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  }
}

module.exports = {
  CASE_ID, CASE_IDS, CAREER_AGENT_ID, COMPLETE_RUN_BUDGET_MS, PACKAGE, VERB, RAIL_REFUSALS, RAIL_TASK_SUFFIX, ROLLUP_SQL, LEDGER_SQL,
  hasRail, parseArgs, detectRailRefusal, findRun, cancelRun, cleanUpRun, startVerdict, readAttribution, decideVerdict,
  runCareerRailAcceptance, hostSpec, hostTimeoutMs,
};
