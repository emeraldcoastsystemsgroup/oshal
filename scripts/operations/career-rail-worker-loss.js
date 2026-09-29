/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the worker-loss half of the Career rail live acceptance ("Career scoring/tailoring bot-node migration": worker loss terminates visibly). Inside the api container, as the operator automation identity: require the Career bot cb000000-0000-0000-0000-000000000001 to be online in the kernel's runtime registry (the same Redis heartbeat the rail's preflight reads), start the owner-scoped manual `score` run, wait until its first rail call is admitted (GET /runs railCalls >= 1, so the bot is actually in use), then print the phase line `PHASE worker-stop` for the host to act on. The host half (createWorkerLossReactor, run by career-rail-live-proof.js --worker-loss --announced-window) stops the bot's container by name through docker, and restarts it on `PHASE worker-start` or, whatever happens to the proof, when the proof ends. The container half then requires the run to leave `running` as failed with reason career-worker-unavailable (career-hunter/src-routes/career-worker-rail.ts failureOf/railOutcome; the run route maps it to 503, career-run-routes.ts RAIL_FAILURE_STATUS), reads the registration the dead bot left behind (its record outlives it for the key's TTL, so a stale-online record proves nothing), and after the restart waits for a heartbeat STRICTLY NEWER than that record: a bot that never comes back is red, not a note. The run is cancelled if the loss never becomes visible, and a run still running afterwards is incomplete cleanup. No cost table is read: the loss, not the attribution, is this case's claim.
 */

'use strict';

/** The case id this half reports under. */
const CASE_ID = 'career-worker-rail-worker-loss';
const PACKAGE = 'career-hunter';
/** The dedicated Career bot the rail dispatches to (career-hunter/oshal-app.yaml bots[]). */
const CAREER_AGENT_ID = 'cb000000-0000-0000-0000-000000000001';
/** The manual verb whose engine path reaches the rail (score.py _score_one). */
const VERB = 'score';
/** The reason the rail records on a run when the Career bot is gone, and the status the run route maps it to. */
const LOSS_REASON = 'career-worker-unavailable';
const LOSS_STATUS = 503;
/** The Career bot's compose service container (docker-compose.oshal-local.yml `career-bot`). */
const DEFAULT_BOT_CONTAINER = 'oshal-local-career-bot';
/** The flag that says the operator announced the outage this proof causes for every user of the box. */
const ANNOUNCED_FLAG = '--announced-window';
/** Phase lines the container half prints for the host half; anything else on stdout is noise. */
const PHASE_PREFIX = 'PHASE ';
const PHASES = Object.freeze({ stop: 'worker-stop', start: 'worker-start' });
/** How long the run route's own answer may trail the run's terminal state before the proof stops waiting for it. */
const RESPONSE_GRACE_MS = 15_000;
const DEFAULT_BUDGETS = Object.freeze({ runBudgetMs: 600_000, heartbeatBudgetMs: 180_000, pollMs: 1_000 });

/**
 * @description The proof's sibling module, required lazily so that module can dispatch to this one
 * without a load-time cycle.
 * @returns {object} career-rail-live-proof's exports.
 */
function proof() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./career-rail-live-proof');
}

/**
 * @description The registration facts the proof records and compares.
 * @param {object|null} registration - A runtime registration, or null when the key is gone.
 * @returns {{status: string, heartbeatAt: string|null, startedAt: string|null}|null} The summary.
 */
function summarizeRegistration(registration) {
  if (!registration || typeof registration !== 'object') return null;
  return { status: String(registration.status || ''), heartbeatAt: registration.heartbeatAt || null, startedAt: registration.startedAt || null };
}

/**
 * @description Whether a registration is a live heartbeat published AFTER the record the dead bot
 * left behind. The bot's shutdown clears its heartbeat timer before it exits and the record lives
 * on for the key's TTL, so only a strictly newer heartbeat can come from the restarted process.
 * @param {object|null} after - The registration read after the restart.
 * @param {object|null} lastSeen - The registration read once the loss was visible (may be null or stale).
 * @returns {boolean} True for an online registration whose heartbeat is newer than lastSeen's.
 */
function heartbeatIsNewer(after, lastSeen) {
  if (!after || after.status !== 'online') return false;
  const at = Date.parse(after.heartbeatAt);
  if (!Number.isFinite(at)) return false;
  if (!lastSeen) return true;
  const seen = Date.parse(lastSeen.heartbeatAt);
  return Number.isFinite(seen) && at > seen;
}

/**
 * @description Post the manual run without awaiting it; its answer settles into `pending.response`.
 * @param {object} io - api, now.
 * @param {object} budgets - runBudgetMs.
 * @returns {{startedAtMs: number, pending: {response: object|null}, posted: Promise<void>}} The flight.
 */
function postRun(io, budgets) {
  const startedAtMs = io.now();
  const pending = { response: null };
  const posted = io.api('POST', `/api/${PACKAGE}/run/${VERB}`, undefined, budgets.runBudgetMs * 2 + 60_000)
    .then((value) => { pending.response = value; }, (error) => { pending.response = { status: 0, json: { error: error instanceof Error ? error.message : String(error) } }; });
  return { startedAtMs, pending, posted };
}

/**
 * @description Watch the owner's run list until the run admits its first rail call (the bot is in
 * use), ends on its own, or the budget passes.
 * @param {object} io - api, sleep, now.
 * @param {object} budgets - runBudgetMs, pollMs.
 * @returns {Promise<{run: object|null, admitted: boolean, startedAtMs: number, pending: object, posted: Promise<void>}>} The flight so far.
 */
async function awaitAdmission(io, budgets) {
  const flight = postRun(io, budgets);
  let run = null;
  while (!flight.pending.response && io.now() - flight.startedAtMs < budgets.runBudgetMs) {
    await io.sleep(budgets.pollMs);
    run = (await proof().findRun(io, flight.startedAtMs)) || run;
    if (run && (Number(run.railCalls) >= 1 || run.state !== 'running')) break;
  }
  if (flight.pending.response) {
    // The route answered, so the run is terminal: read its terminal state once.
    await flight.posted;
    run = (await proof().findRun(io, flight.startedAtMs)) || run;
  }
  return { ...flight, run, admitted: Boolean(run) && run.state === 'running' && Number(run.railCalls) >= 1 };
}

/**
 * @description After the stop was requested: wait for the run to leave `running` and for the run
 * route's own answer, within the budget.
 * @param {object} io - api, sleep, now.
 * @param {object} flight - awaitAdmission's outcome.
 * @param {object} budgets - runBudgetMs, pollMs.
 * @returns {Promise<{run: object, response: object|null, timedOut: boolean}>} The ended (or still running) run.
 */
async function awaitRunEnd(io, flight, budgets) {
  const started = io.now();
  let run = flight.run;
  let graceUntil = null;
  while (io.now() - started < budgets.runBudgetMs) {
    await io.sleep(budgets.pollMs);
    run = (await proof().findRun(io, flight.startedAtMs)) || run;
    if (!run || run.state === 'running') continue;
    if (flight.pending.response) break;
    graceUntil = graceUntil ?? io.now() + RESPONSE_GRACE_MS;
    if (io.now() >= graceUntil) break;
  }
  if (flight.pending.response) await flight.posted;
  run = (await proof().findRun(io, flight.startedAtMs)) || run;
  return { run, response: flight.pending.response, timedOut: Boolean(run) && run.state === 'running' };
}

/**
 * @description Wait (bounded) for a heartbeat newer than the record the dead bot left behind.
 * @param {object} io - registry, sleep, now.
 * @param {object|null} lastSeen - The registration read once the loss was visible.
 * @param {object} budgets - heartbeatBudgetMs, pollMs.
 * @returns {Promise<{ok: boolean, registration: object|null, waitedMs: number}>} The outcome.
 */
async function awaitComeback(io, lastSeen, budgets) {
  const started = io.now();
  let registration = null;
  while (io.now() - started < budgets.heartbeatBudgetMs) {
    registration = await io.registry.read();
    if (heartbeatIsNewer(registration, lastSeen)) return { ok: true, registration, waitedMs: io.now() - started };
    await io.sleep(budgets.pollMs);
  }
  return { ok: false, registration, waitedMs: io.now() - started };
}

/**
 * @description The one-line account of whether the bot came back.
 * @param {{ok: boolean, registration: object|null, waitedMs: number}} comeback - awaitComeback's outcome.
 * @param {object} budgets - heartbeatBudgetMs.
 * @returns {string} The account, without a trailing period.
 */
function comebackText(comeback, budgets) {
  const seconds = Math.round(comeback.waitedMs / 1000);
  if (comeback.ok) return `the Career bot came back online ${seconds}s after its restart (heartbeat ${comeback.registration.heartbeatAt})`;
  const seen = comeback.registration ? `last registration ${comeback.registration.status} at ${comeback.registration.heartbeatAt}` : 'no registration at all';
  return `the Career bot did NOT come back within ${Math.round(budgets.heartbeatBudgetMs / 1000)}s of its restart (${seen})`;
}

/**
 * @description The verdict once the stop was requested: the run must have failed with the loss
 * reason, the run route must have answered 503 with it, and the bot must have come back.
 * @param {{run: object, response: object|null, timedOut: boolean}} ended - awaitRunEnd's outcome.
 * @param {{ok: boolean, registration: object|null, waitedMs: number}} comeback - awaitComeback's outcome.
 * @param {object} budgets - runBudgetMs, heartbeatBudgetMs.
 * @returns {{state: 'pass'|'fail', detail: string}} The verdict before cleanup.
 */
function lossVerdict(ended, comeback, budgets) {
  const { run, response, timedOut } = ended;
  const back = comebackText(comeback, budgets);
  const fail = (detail) => ({ state: 'fail', detail });
  if (timedOut) return fail(`Run ${run.runId} was still running ${Math.round(budgets.runBudgetMs / 1000)}s after the Career bot was stopped (${run.railCalls} rail calls admitted); the loss never became visible and the proof cancelled it. ${back}.`);
  if (run.state !== 'failed') return fail(`Run ${run.runId} ended ${run.state}${run.reason ? ` (${run.reason})` : ''} after the Career bot was stopped; the loss was not visible as failed/${LOSS_REASON}. ${back}.`);
  if (run.reason !== LOSS_REASON) return fail(`Run ${run.runId} failed with reason ${run.reason} instead of ${LOSS_REASON} after the Career bot was stopped. ${back}.`);
  const error = response && response.json ? String(response.json.error || '') : '';
  if (!response || response.status !== LOSS_STATUS || error !== LOSS_REASON) {
    const answered = response ? `HTTP ${response.status} ${error}`.trim() : 'nothing';
    return fail(`Run ${run.runId} failed with reason ${LOSS_REASON}, but the run route answered ${answered} instead of ${LOSS_STATUS} ${LOSS_REASON}. ${back}.`);
  }
  if (!comeback.ok) return fail(`Run ${run.runId} failed with reason ${LOSS_REASON} and the run route answered ${LOSS_STATUS} ${LOSS_REASON}, but ${back}.`);
  return { state: 'pass', detail: `Run ${run.runId} failed with reason ${LOSS_REASON} after the Career bot was stopped (${run.railCalls} rail calls admitted before the loss) and the run route answered ${LOSS_STATUS} ${LOSS_REASON}; ${back}.` };
}

/**
 * @description The verdict for a run that never admitted a call while the bot was still up.
 * @param {{run: object|null, pending: {response: object|null}}} flight - awaitAdmission's outcome.
 * @param {object} budgets - runBudgetMs.
 * @returns {{state: 'fail'|'unavailable', detail: string}} The verdict; nothing was stopped.
 */
function notAdmittedVerdict(flight, budgets) {
  const { run, pending } = flight;
  const refused = proof().startVerdict(pending.response);
  if (!run) return refused || { state: 'fail', detail: `POST /run/${VERB} answered HTTP ${pending.response ? pending.response.status : 'none'} but no ${VERB} run of this owner appeared in GET /runs; nothing was stopped.` };
  if (run.state === 'running') return { state: 'fail', detail: `Run ${run.runId} admitted no rail call within ${Math.round(budgets.runBudgetMs / 1000)}s; the Career bot was never in use, so nothing was stopped and the proof cancelled the run.` };
  if (run.state === 'failed') {
    const refusal = proof().detectRailRefusal([run.reason, pending.response && pending.response.json && pending.response.json.error, pending.response && pending.response.json ? pending.response.json.err : '']);
    return { state: 'fail', detail: `Run ${run.runId} failed with reason ${run.reason} before the Career bot was stopped${refusal ? ` (the kernel refused the rail call: ${refusal})` : ''}; nothing was stopped.` };
  }
  return { state: 'unavailable', detail: `Run ${run.runId} ended ${run.state} after ${run.railCalls} rail calls before the Career bot could be stopped; the loss could not be staged, and nothing was stopped.` };
}

/**
 * @description Record the run facts the verdict rests on.
 * @param {object} evidence - The evidence object.
 * @param {{run: object|null, response?: object|null, pending?: {response: object|null}}} flight - The flight.
 * @returns {void}
 */
function recordRun(evidence, flight) {
  const { run } = flight;
  const response = flight.response || (flight.pending ? flight.pending.response : null);
  Object.assign(evidence, { runId: run ? run.runId : null, runState: run ? run.state : null, runReason: run ? run.reason : null,
    railCalls: run ? run.railCalls : null, routeStatus: response ? response.status : null });
}

/**
 * @description The stop, the loss, the restart and the comeback, in that order; the host acts on the
 * two phase lines. The start phase is printed as soon as the loss is decided so the outage is as
 * short as the run's own failure.
 * @param {object} io - api, registry, phase, sleep, now.
 * @param {object} flight - awaitAdmission's outcome (admitted).
 * @param {object} evidence - The evidence object.
 * @param {object} budgets - runBudgetMs, heartbeatBudgetMs, pollMs.
 * @returns {Promise<{state: 'pass'|'fail', detail: string}>} The verdict before cleanup.
 */
async function observeLoss(io, flight, evidence, budgets) {
  io.phase(PHASES.stop, { runId: flight.run.runId, railCalls: flight.run.railCalls });
  evidence.stopRequestedAt = new Date(io.now()).toISOString();
  const ended = await awaitRunEnd(io, flight, budgets);
  flight.run = ended.run; // the cleanup judges the run as it ended, not the pre-loss snapshot
  recordRun(evidence, ended);
  const lastSeen = await io.registry.read();
  evidence.heartbeatAtLoss = summarizeRegistration(lastSeen);
  io.phase(PHASES.start, { runId: ended.run.runId, state: ended.run.state, reason: ended.run.reason });
  evidence.startRequestedAt = new Date(io.now()).toISOString();
  const comeback = await awaitComeback(io, lastSeen, budgets);
  Object.assign(evidence, { heartbeatAfter: summarizeRegistration(comeback.registration), cameBack: comeback.ok, comebackMs: comeback.waitedMs });
  return lossVerdict(ended, comeback, budgets);
}

/**
 * @description Run the whole worker-loss case once; cleanup always runs once a run was posted.
 * @param {object} ports - api, registry ({read}), phase, careerVersion, sleep?, now?.
 * @param {object} [options] - Budget overrides (runBudgetMs, heartbeatBudgetMs, pollMs).
 * @returns {Promise<{caseId: string, state: string, detail: string, evidence: object}>} The result.
 */
async function runWorkerLossAcceptance(ports, options = {}) {
  const io = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => Date.now(), phase: () => undefined, ...ports };
  const budgets = { ...DEFAULT_BUDGETS };
  for (const key of Object.keys(DEFAULT_BUDGETS)) if (Number(options[key]) > 0) budgets[key] = Number(options[key]);
  const evidence = { verb: VERB, agentId: CAREER_AGENT_ID, careerVersion: io.careerVersion || null, startedAt: new Date(io.now()).toISOString() };
  let flight = { run: null, admitted: false, pending: { response: null } };
  let verdict = { state: 'fail', detail: 'The case did not finish.' };
  try {
    const before = await io.registry.read();
    evidence.heartbeatBefore = summarizeRegistration(before);
    if (!before || before.status !== 'online') {
      return { caseId: CASE_ID, state: 'unavailable', detail: `The Career bot ${CAREER_AGENT_ID} is not online in the runtime registry (${before ? `status ${before.status}` : 'no registration'}); no run was started and nothing was stopped.`, evidence: { ...evidence, cleanupErrors: [] } };
    }
    flight = await awaitAdmission(io, budgets);
    recordRun(evidence, flight);
    verdict = flight.admitted ? await observeLoss(io, flight, evidence, budgets) : notAdmittedVerdict(flight, budgets);
  } catch (error) {
    verdict = { state: 'fail', detail: error instanceof Error ? error.message : String(error) };
  }
  const cleanupErrors = await proof().cleanUpRun(io, flight.run, budgets);
  const detail = cleanupErrors.length ? `${verdict.detail} CLEANUP INCOMPLETE: ${cleanupErrors.join('; ')}.` : verdict.detail;
  return { caseId: CASE_ID, state: cleanupErrors.length ? 'fail' : verdict.state, detail, evidence: { ...evidence, cleanupErrors } };
}

/**
 * @description Parse one stdout line of the container half as a phase line.
 * @param {string} line - The line.
 * @returns {{name: string, data: object}|null} The phase, or null for any other line.
 */
function parsePhase(line) {
  const text = String(line || '');
  if (!text.startsWith(PHASE_PREFIX)) return null;
  const rest = text.slice(PHASE_PREFIX.length).trim();
  const space = rest.indexOf(' ');
  const name = space < 0 ? rest : rest.slice(0, space);
  let data = {};
  if (space >= 0) {
    try { data = JSON.parse(rest.slice(space + 1)); } catch { data = {}; }
  }
  return name ? { name, data: data && typeof data === 'object' ? data : {} } : null;
}

/**
 * @description The host half: react to the container half's phase lines by stopping and restarting
 * the Career bot's container, at most once each, and restart it at the end whatever the proof did.
 * @param {{bot: string, exec: Function, env: NodeJS.ProcessEnv}} deps - Container name, docker runner, its environment.
 * @returns {{state: {stop: object|null, start: object|null}, onLine: (line: string) => void, finish: () => object}} The reactor.
 */
function createWorkerLossReactor(deps) {
  const state = { stop: null, start: null };
  const act = (verb) => {
    const out = deps.exec([verb, deps.bot], deps.env, 120_000);
    return { status: out.status === null ? 1 : out.status, stderr: String(out.stderr || '').trim().slice(-300) };
  };
  return {
    state,
    onLine(line) {
      const phase = parsePhase(line);
      if (!phase) return;
      if (phase.name === PHASES.stop && !state.stop) state.stop = act('stop');
      else if (phase.name === PHASES.start && state.stop && !state.start) state.start = act('start');
    },
    finish() {
      if (state.stop && !state.start) state.start = act('start');
      return state;
    },
  };
}

/**
 * @description Whether a container is running, by name.
 * @param {string} container - The container name.
 * @param {Function} exec - The docker runner.
 * @param {NodeJS.ProcessEnv} env - Its environment.
 * @returns {boolean|null} True/false from docker inspect, null when docker could not say.
 */
function containerRunning(container, exec, env) {
  const out = exec(['inspect', '-f', '{{.State.Running}}', container], env, 30_000);
  if (out.status !== 0) return null;
  const text = String(out.stdout || '').trim();
  return text === 'true' ? true : text === 'false' ? false : null;
}

/**
 * @description Fold the host's docker outcomes into the container half's verdict: a stop or restart
 * that failed, a restart never issued, or a container not running afterwards turns any verdict red.
 * @param {object|null} result - The container half's RESULT payload, or null when it printed none.
 * @param {{stop: object|null, start: object|null}} state - The reactor's state after finish().
 * @param {boolean|null} running - containerRunning after finish().
 * @returns {{caseId: string, state: string, detail: string, evidence: object}} The final verdict.
 */
function hostVerdict(result, state, running) {
  const problems = [];
  if (state.stop && state.stop.status !== 0) problems.push(`docker stop failed (${state.stop.stderr || 'no detail'})`);
  if (state.stop && !state.start) problems.push('docker start was never issued');
  if (state.stop && state.start && state.start.status !== 0) problems.push(`docker start failed (${state.start.stderr || 'no detail'})`);
  if (state.stop && running !== true) problems.push(`the Career bot container is ${running === false ? 'not running' : 'in an unknown state'} after the restart`);
  const base = result || { caseId: CASE_ID, state: 'fail', detail: 'The container half produced no verdict.', evidence: {} };
  const evidence = { ...(base.evidence || {}), host: { stop: state.stop, start: state.start, running } };
  if (!problems.length) return { ...base, evidence };
  return { ...base, state: 'fail', detail: `${base.detail} HOST: ${problems.join('; ')}.`, evidence };
}

module.exports = {
  ANNOUNCED_FLAG, CASE_ID, CAREER_AGENT_ID, DEFAULT_BOT_CONTAINER, DEFAULT_BUDGETS, LOSS_REASON, LOSS_STATUS, PHASE_PREFIX, PHASES,
  awaitComeback, containerRunning, createWorkerLossReactor, heartbeatIsNewer, hostVerdict, lossVerdict, parsePhase, runWorkerLossAcceptance,
  summarizeRegistration,
};
