/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live acceptance for the storyboard image rail chosen by the render bot's own harness (ADR-130 amendment 2026-10-02, the bot-level rule). Runs the explicit-only Lab card storyboard-antigravity-render as the operator: the resolved rail must be antigravity-cli (the render bot runs antigravity-cli, by its own row or the swarm default), one frame must render through it on the bot node, and the answer must be a real PNG of at least 64 x 64 with the bot's receipt that generate_image reached DONE, the bot's report that the turn ran on antigravity-cli, and its ADR-034 reconcile reported as 'match' (the dispatch carried the bot's own setting and switched nothing). The card's tagged task workspace must be removed. The render bot's task record and its chat_tasks usage row are kept as the audit trail. One model turn on the operator's subscription.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The one blocking POST /api/test-lab/run now carries its own call budget: the render dispatch budget (STORYBOARD_CLI_IMAGE_TIMEOUT_MS, 420 s when unset, as storyboard-cli-image-wiring.ts reads it) plus a 60 s margin for the api's own work around the dispatch, through the runner's per-call `timeoutMs`. Under the runner's 30 s default the case crashed before the render answered (2026-10-02 19:00: the agy turn alone took 29.77 s, the whole render 61.8 s).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-130 amendment 2026-10-03 (operator decision): a render never moves the bot off its own setting, and a bot found on a stale default is first corrected onto it (ADR-034). The 00:24 run on the box rendered its frame and was failed for a 'corrected' reconcile (the bot had booted on its env fallback). The case now accepts 'match' or 'corrected' when the turn ran on the render bot's own harness (the card's botHarness; antigravity-cli when the selection named no bot, the only harness the wiring dispatches this rail to) and still fails any other reconcile or a turn run elsewhere. Title follows.
 */

'use strict';

const common = require('./live-acceptance-common.js');

const CASE_ID = 'storyboard-agy-live';
const KEY = 'storyboard-agy';
const TITLE = 'A storyboard frame renders on the render bot\'s own antigravity harness: generate_image DONE, a real PNG, the bot never moved off its own setting';
const NEEDS = Object.freeze(['api']);
const CARD_ID = 'storyboard-antigravity-render';
/** The card's own tagged render workspaces; nothing else is counted as this run's. */
const RENDER_TASK = /^sbimg-testlab-live-storyboard-[0-9a-f]{8}$/;
/** The suites that guard the seams this case crosses live. */
const REGRESSION_TESTS = Object.freeze(['storyboard-image-default', 'storyboard-antigravity-image-turn', 'storyboard-cli-image-wiring', 'storyboard-test-lab-render', 'image-turn-prompt-framing']
  .map((name) => Object.freeze({ level: 'unit', path: `tests/unit/${name}.spec.ts` })));
/** The render dispatch budget the api holds the bot to (storyboard-cli-image-wiring.ts reads the same knob and default). */
const DEFAULT_RENDER_BUDGET_MS = 420_000;
/** What the api spends around the dispatch (selection, staging, receipt check, cleanup) before the call answers. */
const RENDER_CALL_MARGIN_MS = 60_000;
/** The rail's one harness: the bot's own when the card's selection named no bot (an explicit STORYBOARD_IMAGE_PROVIDER). */
const RAIL_HARNESS = 'antigravity-cli';
/** What the bot may report of its ADR-034 reconcile on its own harness: a match, or a correction onto it from a stale default. */
const OWN_SETTING_ACTIONS = Object.freeze(['match', 'corrected']);

/**
 * @description The reconcile half of the judgement: the bot kept on, or put back on, its own setting.
 * @param {object|null} receipt - The card's cliRender (the bot's report).
 * @param {object|null} output - The card step's output (botHarness: the render bot's own harness).
 * @returns {string[]} The problem, or none.
 */
function reconcileProblems(receipt, output) {
  const ownHarness = (output && output.botHarness) || RAIL_HARNESS;
  const action = receipt && receipt.providerConfigAction;
  const ranOn = receipt && receipt.ranOn;
  if (OWN_SETTING_ACTIONS.includes(action) && ranOn === ownHarness) return [];
  return [`the bot's reconcile was ${action || 'not reported'} on ${ranOn || 'nothing'}, not a match on or a correction onto its own ${ownHarness} setting (a render never moves the bot off it)`];
}

/**
 * @description The budget of the case's one blocking call: the render dispatch budget plus the
 * margin. The api runs the card's step inline, so the POST answers only once the render has.
 * @param {NodeJS.ProcessEnv} [env] - The environment (STORYBOARD_CLI_IMAGE_TIMEOUT_MS, as the api reads it).
 * @returns {number} The call budget in milliseconds.
 */
function renderCallTimeoutMs(env = process.env) {
  const configured = Number(env.STORYBOARD_CLI_IMAGE_TIMEOUT_MS);
  return (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RENDER_BUDGET_MS) + RENDER_CALL_MARGIN_MS;
}

/**
 * @description Judge the card's one step: pass only with a real PNG from antigravity-cli, the
 * generate_image DONE receipt, the bot's report that it ran antigravity-cli on its own harness with a
 * 'match' reconcile or a 'corrected' one (put back on its own setting from a stale default), and the
 * workspace removed. A degraded step (the render bot's rail is another one, or the caller is not the
 * operator) means the case cannot judge this box yet.
 * @param {{status: number, json: object}} res - POST /api/test-lab/run for the card.
 * @returns {{state: string, detail: string, output: object|null}} The judgement and the step output.
 */
function judgeCard(res) {
  const card = (Array.isArray(res.json && res.json.results) ? res.json.results : []).find((c) => c && c.id === CARD_ID);
  if (!card) return { state: 'unavailable', detail: `card ${CARD_ID} did not run (HTTP ${res.status}); the build predates it`, output: null };
  const step = Array.isArray(card.steps) ? card.steps[0] : null;
  if (!step) return { state: 'fail', detail: `card ${CARD_ID} answered with no step`, output: null };
  const output = step.output && typeof step.output === 'object' ? step.output : null;
  if (step.state === 'degraded') return { state: 'unavailable', detail: String(step.detail || '').slice(0, 400), output };
  if (step.state !== 'pass') return { state: 'fail', detail: `card ${CARD_ID}: ${step.state}: ${String(step.detail || '').slice(0, 400)}`, output };
  const receipt = output && output.cliRender;
  const problems = [
    ...(output && output.provider === 'antigravity-cli' ? [] : ['the frame did not come from antigravity-cli']),
    ...(output && output.format === 'png' && output.width >= 64 && output.height >= 64 ? [] : ['the frame is not a PNG of at least 64 x 64']),
    ...(receipt && receipt.tool === 'generate_image' && receipt.toolState === 'DONE' ? [] : ['no receipt shows generate_image reaching DONE']),
    ...(receipt && receipt.ranOn === RAIL_HARNESS ? [] : ['the bot does not report that the turn ran on antigravity-cli']),
    ...reconcileProblems(receipt, output),
  ];
  if (problems.length) return { state: 'fail', detail: `card ${CARD_ID} passed but ${problems.join('; ')}`, output };
  return { state: 'pass', detail: `card ${CARD_ID}: ${output.width} x ${output.height} PNG from ${output.sourceMimeType}, model ${output.model}, generate_image DONE (${receipt.locator}), ran on the bot's own antigravity-cli (reconcile ${receipt.providerConfigAction})`, output };
}

/**
 * @description Account for the card's render workspace in the run's ledger.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @param {object|null} output - The card step's output.
 * @returns {void}
 */
function recordCleanup(ledger, output) {
  const cleanup = output && output.cleanup;
  const taskId = (cleanup && cleanup.taskId) || (output && output.cliRender && output.cliRender.taskId) || (output && output.taskId);
  if (!taskId) return;
  if (!RENDER_TASK.test(String(taskId))) { ledger.error(`the card reported a render workspace that is not its own tag: ${taskId}`); return; }
  ledger.created('render-workspace', taskId);
  if (cleanup && cleanup.removed === true) ledger.removed('render-workspace', taskId);
  else if (cleanup && cleanup.error) ledger.error(`render workspace ${taskId}: ${cleanup.error}`);
  ledger.kept('bot-task-record', taskId, 'the render bot keeps its task record and chat_tasks usage row as the audit trail; neither holds the image');
}

/**
 * @description Run the case once.
 * @param {object} ports - api.
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const ledger = new common.CleanupLedger();
  let verdict;
  let evidence = {};
  try {
    // The call blocks for the whole render: it carries the render budget, not the runner's 30 s default.
    const judged = judgeCard(await ports.api('POST', '/api/test-lab/run', { scenarioId: CARD_ID }, { timeoutMs: renderCallTimeoutMs() }));
    recordCleanup(ledger, judged.output);
    evidence = { card: judged.detail, output: judged.output };
    verdict = { state: judged.state, detail: `${judged.detail}.` };
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` };
  }
  return common.finish(CASE_ID, verdict, ledger, evidence);
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, CARD_ID, REGRESSION_TESTS, DEFAULT_RENDER_BUDGET_MS, RENDER_CALL_MARGIN_MS, judgeCard, renderCallTimeoutMs, run };
