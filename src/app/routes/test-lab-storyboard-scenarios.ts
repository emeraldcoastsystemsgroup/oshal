/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AI Test Lab registration for the storyboard image rail (BACKLOG "Free ComfyUI storyboard provider"). Which rail renders a storyboard still decides whether the stage costs money per image and whether it can serve anybody but the operator, and nothing in the cockpit said which one this deployment would pick. The live step reads the selection and probes the free GPU rail's own health, so an operator can see that the FREE rail is standing by - or exactly which of url / workflow / reachability is missing - without submitting a frame. Read-only: it generates no image, submits no job and spends nothing.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-130 amendment 2026-10-02 (the bot-level rule: the render bot's own effective harness picks the image rail). The rail readback now awaits selectStoryboardImageProvider - the function the resolver itself uses - instead of re-deriving the default, so it names the render bot and the harness it followed and reports a refused selection ("<bot> runs <harness>, which cannot make images") as a fail. New explicit-only card storyboard-antigravity-render: as the signed-in caller, it requires the resolved rail to be antigravity-cli, renders ONE frame through it (a generated 256 x 256 red-circle anchor and a "make the circle blue, change nothing else" brief) on a tagged sbimg-testlab-live-storyboard-<8 hex> task workspace, requires a real PNG back plus the bot's receipt that generate_image reached DONE, and removes exactly that workspace (proven gone). It spends one model turn on the operator's subscription, so it never runs from "run all". The new guards are attached as regressionTests.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The render card lists tests/unit/image-turn-prompt-framing.spec.ts among its regressionTests: the card renders through the framed image turn (the SEC-05 carve for image turns, ADR-130 amendment b), and only the live case module's REGRESSION_TESTS carried that guard.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-130 amendment 2026-10-03 (operator decision): a render never moves the bot off its own setting, and a bot found on a stale default is first corrected onto it (ADR-034). On 2026-10-03 00:24 the first render after a deploy produced its frame but this card failed it: general-bot had booted on its env fallback (openai-codex) and the render's dispatch corrected it onto its own antigravity-cli ('corrected'). The card now accepts 'match' or 'corrected' when the turn ran on the render bot's own harness (the selection's harness; with an explicit STORYBOARD_IMAGE_PROVIDER the selection names no bot, and the wiring dispatches the antigravity rail only to a bot whose own harness is antigravity-cli), and still fails any other reconcile or a turn that ran elsewhere. A refused render's failure detail and output now carry the bot's untrusted diagnostic (the image tool's error text and the model's reply), which the provider keeps off the error message.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Retry and throttle for image renders (operator decision 2026-10-03: "Retry, max 3, fresh turns", "Throttle image renders"). The render card holds the provider to the CLI render budget (cliStoryboardRenderBudgetMs: STORYBOARD_CLI_IMAGE_TIMEOUT_MS, 420 s when unset), the budget the live case storyboard-agy's one blocking call already carries plus its margin, so the whole render, its waits for the render bot and up to three fresh turns, fits inside it. A retried render works in its own -a2 and -a3 task workspaces; the cleanup removes the tagged workspace and each attempt's, reports them (cleanup.workspaces), and counts the cleanup removed only when every one is gone. The verdict names the attempt that rendered the frame.
 *
 * @module routes/test-lab-storyboard-scenarios
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  antigravityRenderTaskIds,
  cliStoryboardRenderBudgetMs,
  createAntigravityCliImageProvider,
  createComfyUiImageProvider,
  resolveStoryboardImageProvider,
  selectStoryboardImageProvider,
  ANTIGRAVITY_RENDER_MAX_ATTEMPTS,
  type StoryboardImageResult,
} from '@/features/video-generation';
import { createChildLogger } from '@/shared/logger';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import type { Scenario, ScenarioRunContext, StepResult } from './test-lab-scenarios';

const logger = createChildLogger({ module: 'test-lab-storyboard-scenarios' });
const APP = 'storyboard';
const LABEL = 'Storyboard image rail';
const RENDER_LABEL = 'Render one frame on the render bot\'s antigravity rail';
/** The brief the live render sends: an edit whose correct answer is easy to see and hard to fake. */
const RENDER_BRIEF = 'Make the red circle blue. Keep the white background and the circle\'s size and position exactly as they are.';
/** The live render's own task workspaces (its tagged one and a retry's -a2/-a3), and nothing else, are what its cleanup may remove. */
const RENDER_TASK = /^sbimg-testlab-live-storyboard-[0-9a-f]{8}(?:-a[0-9])?$/;

/** The rails that bill the caller per image; selecting one is a spend decision, not a default. */
const PAID_RAILS = new Set(['codex', 'vertex', 'openrouter']);
/** The rails that serve only the deployment operator in demo mode (ADR-127). */
const OPERATOR_RAILS = new Set(['codex-cli', 'antigravity-cli']);
/** The rail this card renders on, and the one harness that serves it (storyboard-image-default's mapping). */
const RENDER_RAIL_HARNESS = 'antigravity-cli';
/**
 * What the bot may report of its ADR-034 reconcile for a render on its own harness: its own setting
 * matched, or it was found on a stale default and corrected onto that setting first (ADR-130
 * amendment 2026-10-03). Anything else, or a turn that ran on another harness, fails.
 */
const OWN_SETTING_ACTIONS: ReadonlySet<string> = new Set(['match', 'corrected']);

/**
 * @description Live step: report which rail this deployment would render storyboard stills on, and
 * whether the free GPU rail is ready. It never generates — a single still on a paid rail costs real
 * money, so the card reads configuration and the ComfyUI box's own `/system_stats` and stops there.
 *
 * States, and why: a refused default or an unusable selected rail is a `fail` (the storyboard stage
 * will die at the first frame); a paid rail selected with no free rail configured is `degraded` and
 * says what to set; the free rail selected and reachable, or standing by behind a deliberate paid
 * choice, passes.
 *
 * @param {string} _cookie the initiating user's session cookie; unused, this step calls no route
 * @returns {Promise<StepResult>} the rail verdict, with the free rail's own reason when it is not ready
 */
async function railStep(_cookie: string): Promise<StepResult> {
  const result = (state: StepResult['state'], detail: string): StepResult => ({ app: APP, label: LABEL, state, detail });
  const selection = await selectStoryboardImageProvider();
  if (!selection.ok) return result('fail', `No storyboard image rail can be selected: ${selection.reason}. Every storyboard frame will fail at selection until this is fixed.`);
  const selected = selection.id;
  const via = selection.source === 'render-bot' ? ` (follows the render bot ${selection.renderBot} on ${selection.harness})` : '';

  const comfy = createComfyUiImageProvider();
  const health = comfy.healthCheck ? await comfy.healthCheck() : { ok: false, detail: 'the free rail reports no health probe' };

  if (selected === 'comfyui') {
    return health.ok
      ? result('pass', `Storyboard stills render FREE on the GPU box — ${health.detail}. No per-image charge, and any signed-in caller can use it.`)
      : result('fail', `STORYBOARD_IMAGE_PROVIDER=comfyui is selected but the rail is not usable: ${health.detail}. Every storyboard frame will fail at selection until this is fixed.`);
  }

  const paid = PAID_RAILS.has(selected);
  if (health.ok) {
    return result('pass', `Selected rail is '${selected}'${via}${paid ? ' (billed per image)' : ''}; the free GPU rail is ready as well — ${health.detail}. Set STORYBOARD_IMAGE_PROVIDER=comfyui to render at no per-image cost.`);
  }
  return result('degraded', `Selected rail is '${selected}'${via}${paid ? ', which bills per image' : ''}, and the free GPU rail is not available: ${health.detail}. Storyboards still render, they are just not free${OPERATOR_RAILS.has(selected) ? ` — and ${selected} only serves the operator in demo mode, so a signed-in guest gets nothing` : ''}.`);
}

/**
 * @description The live render's anchor: a 256 x 256 PNG, a red circle on white (the proof's source).
 * @returns {Promise<Buffer>} PNG bytes.
 */
async function circleAnchor(): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#ffffff"/><circle cx="128" cy="128" r="80" fill="#ff0000"/></svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * @description Width and height from a PNG's IHDR, or null when the bytes are not a PNG.
 * @param {Buffer} png - The image.
 * @returns {{width: number, height: number} | null} Its size.
 */
function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * @description Remove one of the live render's task workspaces and prove it is gone.
 * @param {string} root - The shared workspace root.
 * @param {string} id - The workspace's task id.
 * @returns {{existed: boolean, gone: boolean, error?: string}} The fact for that workspace.
 */
function removeOneRenderWorkspace(root: string, id: string): { existed: boolean; gone: boolean; error?: string } {
  const dir = path.join(root, id);
  if (!RENDER_TASK.test(id) || path.dirname(dir) !== root) return { existed: false, gone: false, error: 'not a live-render task workspace' };
  const existed = fs.existsSync(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { existed, gone: !fs.existsSync(dir) };
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, taskId: id }, 'live storyboard render workspace could not be removed');
    return { existed, gone: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @description Remove exactly the live render's task workspaces, its tagged one and each retry
 * attempt's (-a2, -a3), and prove every one is gone.
 * @param {string} taskId - The tagged render task id.
 * @returns {{taskId: string, removed: boolean, workspaces: string[], error?: string}} The cleanup fact: the
 *   tagged id, whether all are gone, the workspaces that existed, and the first error.
 */
function removeRenderWorkspace(taskId: string): { taskId: string; removed: boolean; workspaces: string[]; error?: string } {
  const root = resolveSharedWorkspaceRoot();
  const facts = antigravityRenderTaskIds(taskId).map((id) => ({ id, ...removeOneRenderWorkspace(root, id) }));
  const error = facts.find((fact) => fact.error)?.error;
  return { taskId, removed: facts.every((fact) => fact.gone), workspaces: facts.filter((fact) => fact.existed).map((fact) => fact.id), ...(error ? { error } : {}) };
}

/**
 * @description The reconcile half of the verdict: the bot kept on, or put back on, its own setting.
 * @param {StoryboardImageResult['cliRender']} receipt - The render's receipt and the bot's report.
 * @param {string} ownHarness - The render bot's own harness.
 * @returns {string[]} The problem, or none.
 */
function reconcileProblems(receipt: StoryboardImageResult['cliRender'], ownHarness: string): string[] {
  const action = receipt?.providerConfigAction ?? null;
  if (action && OWN_SETTING_ACTIONS.has(action) && receipt?.ranOn === ownHarness) return [];
  return [`the bot's provider reconcile was ${action ?? 'not reported'} on ${receipt?.ranOn ?? 'nothing'}; only a match on, or a correction onto, its own ${ownHarness} setting passes`];
}

/**
 * @description Judge one finished render: a real PNG of a usable size, from the antigravity rail,
 * carrying the bot's receipt that generate_image reached DONE, run on the render bot's own harness
 * with its ADR-034 reconcile a 'match' on that setting or a 'corrected' onto it (a bot found on a
 * stale default is put back first; a render never moves it off its own setting), with its workspace
 * removed.
 * @param {StoryboardImageResult} rendered - The provider's answer.
 * @param {{removed: boolean}} cleanup - The workspace cleanup fact.
 * @param {string} ownHarness - The render bot's own harness.
 * @returns {{state: StepResult['state'], detail: string}} The verdict.
 */
function judgeRender(rendered: StoryboardImageResult, cleanup: { removed: boolean }, ownHarness: string): { state: StepResult['state']; detail: string } {
  const size = pngSize(rendered.image);
  const receipt = rendered.cliRender;
  const problems = [
    ...(size && size.width >= 64 && size.height >= 64 ? [] : ['the image is not a PNG of at least 64 x 64']),
    ...(receipt?.tool === 'generate_image' && receipt.toolState === 'DONE' ? [] : ['no receipt shows a generate_image step that reached DONE']),
    ...(receipt?.ranOn === RENDER_RAIL_HARNESS ? [] : [`the bot reports the turn ran on ${receipt?.ranOn ?? 'nothing'}, not ${RENDER_RAIL_HARNESS}`]),
    ...reconcileProblems(receipt, ownHarness),
    ...(cleanup.removed ? [] : ['the render workspace was not removed']),
  ];
  const facts = `${size ? `${size.width} x ${size.height} PNG` : 'no PNG'} from ${rendered.sourceMimeType ?? 'an unreported format'}, model ${rendered.model}, ran on ${receipt?.ranOn ?? 'unreported'} (reconcile ${receipt?.providerConfigAction ?? 'unreported'}), located by ${receipt?.locator ?? 'nothing'}, attempt ${receipt?.attempt ?? 'unreported'} of ${ANTIGRAVITY_RENDER_MAX_ATTEMPTS}`;
  return problems.length ? { state: 'fail', detail: `${problems.join('; ')} (${facts}).` } : { state: 'pass', detail: `The render bot's antigravity rail rendered the frame: ${facts}; generate_image reached DONE; workspace removed.` };
}

/**
 * @description Explicit-only live step: render ONE frame through the resolved rail for the
 * signed-in caller and require that the antigravity-cli rail produced it on the render bot's own
 * setting. One model turn.
 * @param {string} _cookie - Unused; the step runs in-process as the server-derived caller.
 * @param {Record<string, unknown>} _prior - Unused.
 * @param {ScenarioRunContext} [runtime] - The server-derived caller.
 * @returns {Promise<StepResult>} The verdict, with the render facts and the cleanup fact as output.
 */
async function renderStep(_cookie: string, _prior: Record<string, unknown>, runtime?: ScenarioRunContext): Promise<StepResult> {
  const result = (state: StepResult['state'], detail: string, output?: unknown): StepResult => ({ app: APP, label: RENDER_LABEL, state, detail, ...(output === undefined ? {} : { output }) });
  if (!runtime?.ownerSub) return result('fail', 'No server-derived caller reached the step; nothing was rendered.');
  const selection = await selectStoryboardImageProvider();
  if (!selection.ok) return result('fail', `The image selection refused: ${selection.reason}. Nothing was rendered.`);
  if (selection.id !== 'antigravity-cli') return result('degraded', `The resolved image rail is '${selection.id}' (${selection.source}${selection.renderBot ? `, ${selection.renderBot} on ${selection.harness}` : ''}), not antigravity-cli. Nothing was rendered.`);
  try {
    const resolved = await resolveStoryboardImageProvider({ userSub: runtime.ownerSub });
    if (resolved.id !== 'antigravity-cli') return result('fail', `The resolver chose '${resolved.id}' although the selection named antigravity-cli. Nothing was rendered.`);
  } catch (err) {
    return result('degraded', `The antigravity-cli rail is not available to you: ${err instanceof Error ? err.message : String(err)}. Nothing was rendered.`);
  }
  const taskId = `sbimg-testlab-live-storyboard-${randomBytes(4).toString('hex')}`;
  let rendered: StoryboardImageResult | null = null;
  let failure = '';
  let diagnostic: string | null = null;
  try {
    // The whole render (its waits for the render bot, up to three fresh turns) fits the CLI render budget the live case's call carries.
    const provider = createAntigravityCliImageProvider(runtime.ownerSub, { taskId, deadlineMs: cliStoryboardRenderBudgetMs() });
    rendered = await provider.generateWithMeta!(RENDER_BRIEF, await circleAnchor());
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, taskId }, 'live storyboard render failed');
    failure = err instanceof Error ? err.message : String(err);
    // The bot's untrusted diagnostic (the image tool's error, the model's reply), kept off the message by the provider.
    const said = (err as { diagnostic?: unknown } | null)?.diagnostic;
    diagnostic = typeof said === 'string' && said ? said : null;
  }
  const cleanup = removeRenderWorkspace(taskId);
  const kept = 'the render bot keeps its task record and the chat_tasks usage row as the audit trail; neither holds the image';
  if (!rendered) {
    const told = diagnostic ? ` The render bot's diagnostic (the image tool's error text and the model's reply; untrusted, for diagnosis only): ${diagnostic}` : '';
    return result('fail', `The render failed: ${failure.slice(0, 400)}${cleanup.removed ? '' : ' The render workspace was not removed.'}${told}`, { taskId, cleanup, kept, diagnostic });
  }
  const size = pngSize(rendered.image);
  // The render bot's own harness. An explicit STORYBOARD_IMAGE_PROVIDER names no bot in the selection; the
  // wiring then dispatches this rail only to a bot whose own record maps to it, which is antigravity-cli.
  const verdict = judgeRender(rendered, cleanup, selection.harness ?? RENDER_RAIL_HARNESS);
  return result(verdict.state, verdict.detail, { provider: 'antigravity-cli', renderBot: selection.renderBot, botHarness: selection.harness, model: rendered.model, sourceMimeType: rendered.sourceMimeType ?? null,
    format: size ? 'png' : null, width: size?.width ?? 0, height: size?.height ?? 0, bytes: rendered.image.length, cliRender: rendered.cliRender ?? null, cleanup, kept });
}

/** The storyboard Test Lab cards: the read-only rail readback, and the explicit-only live render. */
export const STORYBOARD_SCENARIOS: Scenario[] = [{
  id: 'storyboard-image-rail',
  title: 'Storyboard stills — which rail renders them, and whether it is free',
  group: 'tool',
  description: 'Reads which image rail this deployment would render storyboard frames on (in demo mode it follows the render bot\'s own harness - its own switch row, else the swarm default: antigravity-cli or codex-cli, and a harness that cannot make images is reported as refused, naming the bot) and probes the free GPU rail (ComfyUI) for readiness, naming exactly what is missing when it is not ready. A paid rail selected by accident is a per-image bill nobody chose, and the demo CLI rails serve only the operator — this is the read that tells them apart. Read-only: no frame is generated and nothing is spent.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/storyboard-comfyui-provider.spec.ts' },
    { level: 'unit', path: 'tests/unit/storyboard-codex-cli-provider.spec.ts' },
    { level: 'unit', path: 'tests/unit/storyboard-codex-platform-key.spec.ts' },
    { level: 'unit', path: 'tests/unit/series-storyboard-owner-sub.spec.ts' },
    { level: 'unit', path: 'tests/unit/storyboard-image-default.spec.ts' },
  ],
  steps: [{ id: 'rail', app: APP, label: LABEL, run: railStep }],
}, {
  id: 'storyboard-antigravity-render',
  title: 'Storyboard stills — render one frame on the render bot\'s antigravity rail',
  group: 'tool',
  explicitOnly: true,
  description: 'As you, requires the resolved storyboard image rail to be antigravity-cli (the render bot runs antigravity-cli, by its own row or the swarm default), renders ONE frame through it (a generated red-circle reference and a "make the circle blue, change nothing else" brief) on a tagged sbimg-testlab-live-storyboard-<8 hex> task workspace, and requires a real PNG back with the bot\'s receipt that generate_image reached DONE. A render whose generate_image ran and ended in ERROR runs again as a fresh turn on its own -a2, then -a3 workspace, at most three attempts inside the CLI render budget (STORYBOARD_CLI_IMAGE_TIMEOUT_MS, 420 s), and the render bot takes one image turn at a time; the verdict names the attempt that rendered the frame. A render never moves the render bot off its own setting: its provider reconcile must be a match on its own harness, or a correction onto it when the bot was found on a stale default (ADR-034); any other reconcile, or a turn that ran on another harness, fails. A refused render says which way Guard A refused it (generate_image never ran, ended in ERROR, or reached DONE with no file) and shows the bot\'s untrusted diagnostic (the image tool\'s error text and the model\'s reply) beside it; a render that stopped retrying says why (render retries exhausted, image renders are busy). Removes exactly its workspaces and proves them gone; the render bot\'s task record and usage row stay as the audit trail. Serves only the deployment operator in demo mode. Spends one model turn on the operator\'s subscription per attempt.',
  regressionTests: [
    { level: 'unit', path: 'tests/unit/storyboard-image-default.spec.ts' },
    { level: 'unit', path: 'tests/unit/storyboard-antigravity-image-turn.spec.ts' },
    { level: 'unit', path: 'tests/unit/storyboard-antigravity-render-retry.spec.ts' },
    { level: 'unit', path: 'tests/unit/storyboard-image-turn-queue.spec.ts' },
    { level: 'unit', path: 'tests/unit/storyboard-cli-image-wiring.spec.ts' },
    { level: 'unit', path: 'tests/unit/storyboard-test-lab-render.spec.ts' },
    { level: 'unit', path: 'tests/unit/image-turn-prompt-framing.spec.ts' },
  ],
  steps: [{ id: 'render', app: APP, label: RENDER_LABEL, run: renderStep }],
}];
