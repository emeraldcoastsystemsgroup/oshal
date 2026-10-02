/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Live acceptance for the storyboard image rail chosen by the render bot's own harness (ADR-130 amendment 2026-10-02, the bot-level rule). Runs the explicit-only Lab card storyboard-antigravity-render as the operator: the resolved rail must be antigravity-cli (the render bot runs antigravity-cli, by its own row or the swarm default), one frame must render through it on the bot node, and the answer must be a real PNG of at least 64 x 64 with the bot's receipt that generate_image reached DONE, the bot's report that the turn ran on antigravity-cli, and its ADR-034 reconcile reported as 'match' (the dispatch carried the bot's own setting and switched nothing). The card's tagged task workspace must be removed. The render bot's task record and its chat_tasks usage row are kept as the audit trail. One model turn on the operator's subscription.
 */

'use strict';

const common = require('./live-acceptance-common.js');

const CASE_ID = 'storyboard-agy-live';
const KEY = 'storyboard-agy';
const TITLE = 'A storyboard frame renders on the render bot\'s own antigravity harness: generate_image DONE, a real PNG, no provider switch';
const NEEDS = Object.freeze(['api']);
const CARD_ID = 'storyboard-antigravity-render';
/** The card's own tagged render workspaces; nothing else is counted as this run's. */
const RENDER_TASK = /^sbimg-testlab-live-storyboard-[0-9a-f]{8}$/;
/** The suites that guard the seams this case crosses live. */
const REGRESSION_TESTS = Object.freeze(['storyboard-image-default', 'storyboard-antigravity-image-turn', 'storyboard-cli-image-wiring', 'storyboard-test-lab-render']
  .map((name) => Object.freeze({ level: 'unit', path: `tests/unit/${name}.spec.ts` })));

/**
 * @description Judge the card's one step: pass only with a real PNG from antigravity-cli, the
 * generate_image DONE receipt, the bot's report that it ran antigravity-cli with a 'match' reconcile
 * (its own setting, untouched), and the workspace removed. A degraded step (the render bot's rail is
 * another one, or the caller is not the operator) means the case cannot judge this box yet.
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
    ...(receipt && receipt.ranOn === 'antigravity-cli' ? [] : ['the bot does not report that the turn ran on antigravity-cli']),
    ...(receipt && receipt.providerConfigAction === 'match' ? [] : ['the bot does not report a match on its own provider setting (the dispatch must never switch it)']),
  ];
  if (problems.length) return { state: 'fail', detail: `card ${CARD_ID} passed but ${problems.join('; ')}`, output };
  return { state: 'pass', detail: `card ${CARD_ID}: ${output.width} x ${output.height} PNG from ${output.sourceMimeType}, model ${output.model}, generate_image DONE (${receipt.locator}), ran on the bot's own antigravity-cli (reconcile match)`, output };
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
    const judged = judgeCard(await ports.api('POST', '/api/test-lab/run', { scenarioId: CARD_ID }));
    recordCleanup(ledger, judged.output);
    evidence = { card: judged.detail, output: judged.output };
    verdict = { state: judged.state, detail: `${judged.detail}.` };
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` };
  }
  return common.finish(CASE_ID, verdict, ledger, evidence);
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, CARD_ID, REGRESSION_TESTS, judgeCard, run };
