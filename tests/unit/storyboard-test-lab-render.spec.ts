/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the explicit-only Test Lab card storyboard-antigravity-render (ADR-130 amendment 2026-10-02, the bot-level rule), the step the live-acceptance case storyboard-agy drives on the box. The card, the selection, the resolver, the antigravity-cli provider, its receipt check, the JPEG-to-PNG conversion and the workspace cleanup are real on a temporary shared root; the render-bot reader is a fixture (the real reader is pinned in storyboard-image-default.spec.ts) and the executor double plays the bot node's part exactly as agy-image-turn.js leaves it (output.jpg plus its receipt) and reports what the node reports (the provider it ran on and its ADR-034 reconcile), because the bot half is pinned through a real child process in storyboard-antigravity-image-turn.spec.ts. Cases: a pass renders one frame from a generated 256 x 256 anchor on a tagged sbimg-testlab-live-storyboard-<8 hex> workspace, carries the render bot and its harness, and removes exactly that folder; a render bot on another rail and a non-operator caller are degraded with nothing dispatched; an output without its receipt is a fail, and its workspace is still removed; a turn the bot reports as run on another provider, or as a 'corrected' reconcile (a switched bot), is a fail; the readback card names the render bot and harness it followed and fails a harness that cannot make images.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The card must list the image-turn framing guard (tests/unit/image-turn-prompt-framing.spec.ts) and every spec the live case module storyboard-agy names in its REGRESSION_TESTS, so the card and the case that drives it on the box never list different guards again.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-130 amendment 2026-10-03 (operator decision): a render never moves the bot off its own setting, and a bot found on a stale default is first corrected onto it. The 00:24 live render was failed by this card for exactly that ('corrected' after the bot booted on its env fallback). Now a 'corrected' reconcile on the render bot's own harness (the selection's harness) passes like a 'match'; a correction onto another harness, an 'absent' or unreported reconcile, and a turn run elsewhere still fail; with an explicit STORYBOARD_IMAGE_PROVIDER (the selection names no bot) the bot's own harness is the rail's, antigravity-cli. A refused render's failure carries the bot's untrusted diagnostic (the image tool's error text, the model's reply) in its detail and as output.diagnostic, apart from the error message.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Retry and throttle for image renders (operator decision 2026-10-03). The card holds the render to the CLI render budget: every request carries a start-by time inside STORYBOARD_CLI_IMAGE_TIMEOUT_MS. A first attempt that ends in Guard A's ERROR and a fresh second attempt that renders pass, with the verdict naming attempt 2 of 3 and the cleanup removing and reporting both task workspaces (<id> and <id>-a2), fake timers carrying the 3 s wait. A refused render under a budget too short for a second attempt fails with Guard A's own words and "render retries exhausted", the diagnostic still beside them.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STORYBOARD_SCENARIOS } from '../../src/app/routes/test-lab-storyboard-scenarios';
import { registerStoryboardRenderBotReader } from '../../src/features/video-generation/services/storyboard-image-default';
import { registerCliStoryboardImageExecutor, resolveCliStoryboardImageExecutor, type CliStoryboardRenderRequest } from '../../src/features/video-generation/services/storyboard-cli-image-executor';
import type { ScenarioRunContext, StepResult } from '../../src/app/routes/test-lab-scenarios';

// The live case that drives this card on the box is plain CommonJS under scripts/lib (staged into a container by the host runner).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storyboardAgyCase = require('../../scripts/lib/live-acceptance-storyboard-agy.js') as { CARD_ID: string; REGRESSION_TESTS: ReadonlyArray<{ level: string; path: string }> };

const OPERATOR = 'operator-sub-1';
const ENV_KEYS = ['STORYBOARD_IMAGE_PROVIDER', 'DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'OSHAL_WORKSPACE_ROOT', 'COMFYUI_URL', 'COMFYUI_STORYBOARD_WORKFLOW', 'STORYBOARD_CLI_IMAGE_TIMEOUT_MS'] as const;
/** Guard A's refusal of a generate_image step that ran and ended in ERROR, as it leaves the node: its own words, then the diagnostic. */
const ERROR_REASON = 'image turn refused: the event stream shows no generate_image tool step that reached DONE: generate_image ran and ended in ERROR';
const ERROR_DIAGNOSTIC = 'generate_image error "TOOL_ERROR: no image generated in response"; model reply "NO_IMAGE_CAPABILITY"';
const ERROR_LEFT_NODE = `Bot node execution failed: Antigravity CLI error: ${ERROR_REASON} | untrusted diagnostic: ${ERROR_DIAGNOSTIC}`;

let root: string;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const card = (id: string) => STORYBOARD_SCENARIOS.find((s) => s.id === id)!;
const runtime = (ownerSub = OPERATOR) => ({ ownerSub, issuer: null, apiBaseUrl: 'http://127.0.0.1:5000', ctx: {} }) as unknown as ScenarioRunContext;
const runRender = (ownerSub?: string): Promise<StepResult> => card('storyboard-antigravity-render').steps[0].run('', {}, runtime(ownerSub));
const fleet = (harness: string): void => registerStoryboardRenderBotReader(async () => ({ name: 'general-bot', harness }));

/** The bot's part, as agy-image-turn.js leaves it: the tool's JPEG and its receipt in the task workspace. */
function botLeaves(requests: CliStoryboardRenderRequest[], options: { receipt?: boolean; ranOn?: string; action?: 'match' | 'corrected' | 'absent' } = {}): void {
  registerCliStoryboardImageExecutor(async (request) => {
    requests.push(request);
    const dir = path.join(root, request.workspaceFolderId);
    const jpeg = await sharp({ create: { width: 128, height: 96, channels: 3, background: { r: 16, g: 64, b: 224 } } }).jpeg().toBuffer();
    fs.writeFileSync(path.join(dir, 'output.jpg'), jpeg);
    if (options.receipt !== false) {
      fs.writeFileSync(path.join(dir, 'output.image-turn.json'), JSON.stringify({ tool: 'generate_image', toolState: 'DONE', file: 'output.jpg',
        mimeType: 'image/jpeg', bytes: jpeg.length, sha256: createHash('sha256').update(jpeg).digest('hex'), locator: 'step-output' }));
    }
    return { success: true, responseText: 'RENDERED', model: 'gemini-3.8-flash-low', provider: options.ranOn ?? 'antigravity-cli', providerConfigAction: options.action ?? 'match' };
  });
}

/** Settle a step under fake timers: real I/O runs between the turns, fake time moves only to the next pending timer. */
async function drive<T>(work: Promise<T>): Promise<T> {
  let done: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  void work.then((value) => { done = { ok: true, value }; }, (error: unknown) => { done = { ok: false, error }; });
  while (!done) {
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    else await new Promise((resolve) => { setImmediate(resolve); });
  }
  const outcome = done as { ok: true; value: T } | { ok: false; error: unknown };
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lab-render-'));
  Object.assign(process.env, { DEMO_MODE: 'true', OSHAL_OPERATOR_SUBS: OPERATOR, OSHAL_WORKSPACE_ROOT: root });
  for (const k of ['STORYBOARD_IMAGE_PROVIDER', 'COMFYUI_URL', 'COMFYUI_STORYBOARD_WORKFLOW', 'STORYBOARD_CLI_IMAGE_TIMEOUT_MS'] as const) delete process.env[k];
  registerStoryboardRenderBotReader(null);
  registerCliStoryboardImageExecutor(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  registerStoryboardRenderBotReader(null);
  registerCliStoryboardImageExecutor(null);
  fs.rmSync(root, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('Test Lab: storyboard-antigravity-render', () => {
  it('is explicit-only and lists the guards of the seams it crosses, including the image-turn framing and everything its live case names', () => {
    const render = card('storyboard-antigravity-render');
    expect(render.explicitOnly).toBe(true);
    const listed = render.regressionTests?.map((t) => t.path) ?? [];
    expect(listed).toEqual(expect.arrayContaining([
      'tests/unit/storyboard-antigravity-image-turn.spec.ts', 'tests/unit/storyboard-image-default.spec.ts', 'tests/unit/storyboard-test-lab-render.spec.ts',
      'tests/unit/image-turn-prompt-framing.spec.ts']));
    // The live case storyboard-agy runs this very card on the box: the card lists every guard the case lists.
    expect(storyboardAgyCase.CARD_ID).toBe('storyboard-antigravity-render');
    expect(listed).toEqual(expect.arrayContaining(storyboardAgyCase.REGRESSION_TESTS.map((t) => t.path)));
    for (const test of render.regressionTests ?? []) expect(fs.existsSync(test.path), test.path).toBe(true);
  });

  it('renders one frame on the antigravity rail from a generated anchor and removes exactly its workspace', async () => {
    fleet('antigravity-cli');
    const requests: CliStoryboardRenderRequest[] = [];
    botLeaves(requests);
    fs.mkdirSync(path.join(root, 'sbimg-someone-elses-render'));
    const started = Date.now();

    const step = await runRender();

    expect(step.state, step.detail).toBe('pass');
    expect(step.detail).toContain('attempt 1 of 3');
    expect(step.output).toMatchObject({ provider: 'antigravity-cli', renderBot: 'general-bot', botHarness: 'antigravity-cli', format: 'png', width: 128, height: 96, sourceMimeType: 'image/jpeg',
      cliRender: { tool: 'generate_image', toolState: 'DONE', locator: 'step-output', ranOn: 'antigravity-cli', providerConfigAction: 'match', attempt: 1 }, cleanup: { removed: true } });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.rail).toBe('antigravity-cli');
    expect(request.workspaceFolderId).toMatch(/^sbimg-testlab-live-storyboard-[0-9a-f]{8}$/);
    expect((step.output as { cleanup: { workspaces: string[] } }).cleanup.workspaces).toEqual([request.workspaceFolderId]);
    // The whole render fits the CLI render budget (420 s when unset): the turn had to start before 420 s less one attempt's 30 s.
    expect(request.startBy).toBeGreaterThanOrEqual(started + 390_000);
    expect(request.startBy).toBeLessThanOrEqual(Date.now() + 390_000);
    expect(request.prompt).toContain(`ImagePaths = ${JSON.stringify([path.join(root, request.workspaceFolderId, 'anchor.png')])}`);
    expect(fs.existsSync(path.join(root, request.workspaceFolderId))).toBe(false);
    expect(fs.existsSync(path.join(root, 'sbimg-someone-elses-render')), 'only the card\'s own workspace is removed').toBe(true);
  });

  it('is degraded, dispatching nothing, when the render bot is on another rail or the caller is not the operator', async () => {
    const requests: CliStoryboardRenderRequest[] = [];
    botLeaves(requests);
    fleet('openai-codex');
    const codex = await runRender();
    expect(codex.state).toBe('degraded');
    expect(codex.detail).toContain("The resolved image rail is 'codex-cli' (render-bot, general-bot on openai-codex)");
    fleet('antigravity-cli');
    const guest = await runRender('someone-else');
    expect(guest.state).toBe('degraded');
    expect(guest.detail).toMatch(/not available to you: storyboard image provider 'antigravity-cli' is not configured/);
    expect(requests).toEqual([]);
  });

  it('fails an output that carries no receipt, and still removes its workspace', async () => {
    fleet('antigravity-cli');
    const requests: CliStoryboardRenderRequest[] = [];
    botLeaves(requests, { receipt: false });
    const step = await runRender();
    expect(step.state).toBe('fail');
    expect(step.detail).toMatch(/no readable image-turn receipt/);
    expect(step.output).toMatchObject({ cleanup: { removed: true } });
    expect(fs.existsSync(path.join(root, requests[0].workspaceFolderId))).toBe(false);
  });

  it('a render bot found on a stale default and corrected onto its own harness passes, like a match (ADR-130 amendment 2026-10-03)', async () => {
    fleet('antigravity-cli');
    const requests: CliStoryboardRenderRequest[] = [];
    botLeaves(requests, { action: 'corrected' });
    const corrected = await runRender();
    expect(corrected.state, corrected.detail).toBe('pass');
    expect(corrected.detail).toContain('ran on antigravity-cli (reconcile corrected)');
    expect(corrected.output).toMatchObject({ botHarness: 'antigravity-cli', cliRender: { ranOn: 'antigravity-cli', providerConfigAction: 'corrected' } });
  });

  it('with STORYBOARD_IMAGE_PROVIDER naming the rail (no render bot in the selection) the bot\'s own harness is the rail\'s, antigravity-cli', async () => {
    fleet('antigravity-cli');
    process.env.STORYBOARD_IMAGE_PROVIDER = 'antigravity-cli';
    const requests: CliStoryboardRenderRequest[] = [];
    botLeaves(requests, { action: 'corrected' });
    const explicit = await runRender();
    expect(explicit.state, explicit.detail).toBe('pass');
    expect(explicit.output).toMatchObject({ botHarness: null, cliRender: { providerConfigAction: 'corrected' } });
  });

  it('a correction onto another harness, an absent reconcile, or a turn run elsewhere is a fail', async () => {
    fleet('antigravity-cli');
    const requests: CliStoryboardRenderRequest[] = [];
    botLeaves(requests, { action: 'corrected', ranOn: 'openai-codex' });
    const correctedElsewhere = await runRender();
    expect(correctedElsewhere.state).toBe('fail');
    expect(correctedElsewhere.detail).toContain("the bot's provider reconcile was corrected on openai-codex; only a match on, or a correction onto, its own antigravity-cli setting passes");
    botLeaves(requests, { action: 'absent' });
    const absent = await runRender();
    expect(absent.state).toBe('fail');
    expect(absent.detail).toContain("the bot's provider reconcile was absent on antigravity-cli; only a match on, or a correction onto, its own antigravity-cli setting passes");
    botLeaves(requests, { ranOn: 'openai-codex' });
    const elsewhere = await runRender();
    expect(elsewhere.state).toBe('fail');
    expect(elsewhere.detail).toContain('the bot reports the turn ran on openai-codex, not antigravity-cli');
    expect(elsewhere.detail).toContain("the bot's provider reconcile was match on openai-codex");
  });

  it('a refused render fails with Guard A\'s own words and how its retries ended, and the bot\'s untrusted diagnostic beside them', async () => {
    fleet('antigravity-cli');
    // A budget too short for a second attempt: the render stops after the first and says why.
    process.env.STORYBOARD_CLI_IMAGE_TIMEOUT_MS = '1000';
    const requests: CliStoryboardRenderRequest[] = [];
    registerCliStoryboardImageExecutor(async (request) => { requests.push(request); return { success: false, responseText: '', error: ERROR_LEFT_NODE }; });
    const step = await runRender();
    expect(step.state).toBe('fail');
    expect(requests).toHaveLength(1);
    expect(step.detail).toContain(`The render failed: antigravity-cli image provider: render task failed — Bot node execution failed: Antigravity CLI error: ${ERROR_REASON} — render retries exhausted: the render's deadline leaves no time for attempt 2 of 3`);
    expect(step.detail).toContain(`The render bot's diagnostic (the image tool's error text and the model's reply; untrusted, for diagnosis only): ${ERROR_DIAGNOSTIC}`);
    expect(step.output).toMatchObject({ diagnostic: ERROR_DIAGNOSTIC, cleanup: { removed: true } });
  });

  it('a first attempt that ends in Guard A\'s ERROR and a fresh second attempt that renders pass, and the cleanup removes both workspaces', async () => {
    fleet('antigravity-cli');
    const requests: CliStoryboardRenderRequest[] = [];
    botLeaves(requests);
    const leaves = resolveCliStoryboardImageExecutor()!;
    registerCliStoryboardImageExecutor(async (request) => (requests.length ? leaves(request) : (requests.push(request), { success: false, responseText: '', error: ERROR_LEFT_NODE })));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const step = await drive(runRender());

    expect(step.state, step.detail).toBe('pass');
    expect(step.detail).toContain('attempt 2 of 3');
    const [first, second] = requests.map((request) => request.workspaceFolderId);
    expect(second).toBe(`${first}-a2`);
    expect(step.output).toMatchObject({ cliRender: { taskId: second, attempt: 2 }, cleanup: { taskId: first, removed: true, workspaces: [first, second] } });
    for (const id of [first, second]) expect(fs.existsSync(path.join(root, id)), `${id} is removed`).toBe(false);
  });

  it('the rail readback names the render bot and harness it followed, and fails a harness that cannot make images', async () => {
    fleet('antigravity-cli');
    const rail = card('storyboard-image-rail').steps[0];
    const followed = await rail.run('', {}, runtime());
    expect(followed.detail).toContain("Selected rail is 'antigravity-cli' (follows the render bot general-bot on antigravity-cli)");
    fleet('claude-code');
    const refused = await rail.run('', {}, runtime());
    expect(refused.state).toBe('fail');
    expect(refused.detail).toContain('general-bot runs claude-code, which cannot make images; give that bot an image-capable harness, or set STORYBOARD_IMAGE_PROVIDER to an image API');
  });
});
