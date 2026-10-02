/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the explicit-only Test Lab card storyboard-swarm-default-render (ADR-130 amendment 2026-10-02), the step the live-acceptance case storyboard-agy drives on the box. The card, the selection, the resolver, the antigravity-cli provider, its receipt check, the JPEG-to-PNG conversion and the workspace cleanup are real on a temporary shared root; the executor double plays the bot node's part exactly as agy-image-turn.js leaves it (output.jpg plus its receipt), because the bot half is pinned through a real child process in storyboard-antigravity-image-turn.spec.ts. Cases: a pass renders one frame from a generated 256 x 256 anchor on a tagged sbimg-testlab-live-storyboard-<8 hex> workspace and removes exactly that folder; a swarm default that is not antigravity-cli and a non-operator caller are degraded with nothing dispatched; an output without its receipt is a fail, and its workspace is still removed; the readback card names the swarm default it followed and fails a refused default.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STORYBOARD_SCENARIOS } from '../../src/app/routes/test-lab-storyboard-scenarios';
import { registerStoryboardSwarmDefaultReader } from '../../src/features/video-generation/services/storyboard-image-default';
import { registerCliStoryboardImageExecutor, type CliStoryboardRenderRequest } from '../../src/features/video-generation/services/storyboard-cli-image-executor';
import type { ScenarioRunContext, StepResult } from '../../src/app/routes/test-lab-scenarios';

const OPERATOR = 'operator-sub-1';
const ENV_KEYS = ['STORYBOARD_IMAGE_PROVIDER', 'DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'OSHAL_WORKSPACE_ROOT', 'COMFYUI_URL', 'COMFYUI_STORYBOARD_WORKFLOW'] as const;

let root: string;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const card = (id: string) => STORYBOARD_SCENARIOS.find((s) => s.id === id)!;
const runtime = (ownerSub = OPERATOR) => ({ ownerSub, issuer: null, apiBaseUrl: 'http://127.0.0.1:5000', ctx: {} }) as unknown as ScenarioRunContext;
const runRender = (ownerSub?: string): Promise<StepResult> => card('storyboard-swarm-default-render').steps[0].run('', {}, runtime(ownerSub));
const fleet = (harness: string): void => registerStoryboardSwarmDefaultReader(() => ({ loaded: true, harness }));

/** The bot's part, as agy-image-turn.js leaves it: the tool's JPEG and its receipt in the task workspace. */
function botLeaves(requests: CliStoryboardRenderRequest[], options: { receipt?: boolean } = {}): void {
  registerCliStoryboardImageExecutor(async (request) => {
    requests.push(request);
    const dir = path.join(root, request.workspaceFolderId);
    const jpeg = await sharp({ create: { width: 128, height: 96, channels: 3, background: { r: 16, g: 64, b: 224 } } }).jpeg().toBuffer();
    fs.writeFileSync(path.join(dir, 'output.jpg'), jpeg);
    if (options.receipt !== false) {
      fs.writeFileSync(path.join(dir, 'output.image-turn.json'), JSON.stringify({ tool: 'generate_image', toolState: 'DONE', file: 'output.jpg',
        mimeType: 'image/jpeg', bytes: jpeg.length, sha256: createHash('sha256').update(jpeg).digest('hex'), locator: 'step-output' }));
    }
    return { success: true, responseText: 'RENDERED', model: 'gemini-3.8-flash-low' };
  });
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lab-render-'));
  Object.assign(process.env, { DEMO_MODE: 'true', OSHAL_OPERATOR_SUBS: OPERATOR, OSHAL_WORKSPACE_ROOT: root });
  for (const k of ['STORYBOARD_IMAGE_PROVIDER', 'COMFYUI_URL', 'COMFYUI_STORYBOARD_WORKFLOW'] as const) delete process.env[k];
  registerStoryboardSwarmDefaultReader(null);
  registerCliStoryboardImageExecutor(null);
});

afterEach(() => {
  registerStoryboardSwarmDefaultReader(null);
  registerCliStoryboardImageExecutor(null);
  fs.rmSync(root, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('Test Lab: storyboard-swarm-default-render', () => {
  it('is explicit-only and lists the guards of the seams it crosses', () => {
    const render = card('storyboard-swarm-default-render');
    expect(render.explicitOnly).toBe(true);
    expect(render.regressionTests?.map((t) => t.path)).toEqual(expect.arrayContaining([
      'tests/unit/storyboard-antigravity-image-turn.spec.ts', 'tests/unit/storyboard-image-default.spec.ts', 'tests/unit/storyboard-test-lab-render.spec.ts']));
  });

  it('renders one frame on the antigravity rail from a generated anchor and removes exactly its workspace', async () => {
    fleet('antigravity-cli');
    const requests: CliStoryboardRenderRequest[] = [];
    botLeaves(requests);
    fs.mkdirSync(path.join(root, 'sbimg-someone-elses-render'));

    const step = await runRender();

    expect(step.state, step.detail).toBe('pass');
    expect(step.output).toMatchObject({ provider: 'antigravity-cli', format: 'png', width: 128, height: 96, sourceMimeType: 'image/jpeg',
      cliRender: { tool: 'generate_image', toolState: 'DONE', locator: 'step-output' }, cleanup: { removed: true } });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.harness).toBe('antigravity-cli');
    expect(request.workspaceFolderId).toMatch(/^sbimg-testlab-live-storyboard-[0-9a-f]{8}$/);
    expect(request.prompt).toContain(`ImagePaths = ${JSON.stringify([path.join(root, request.workspaceFolderId, 'anchor.png')])}`);
    expect(fs.existsSync(path.join(root, request.workspaceFolderId))).toBe(false);
    expect(fs.existsSync(path.join(root, 'sbimg-someone-elses-render')), 'only the card\'s own workspace is removed').toBe(true);
  });

  it('is degraded, dispatching nothing, when the swarm default is not antigravity or the caller is not the operator', async () => {
    const requests: CliStoryboardRenderRequest[] = [];
    botLeaves(requests);
    fleet('openai-codex');
    const codex = await runRender();
    expect(codex.state).toBe('degraded');
    expect(codex.detail).toContain("The resolved image rail is 'codex-cli' (swarm-default, swarm default openai-codex)");
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

  it('the rail readback names the swarm default it followed, and fails a default that cannot make images', async () => {
    fleet('antigravity-cli');
    const rail = card('storyboard-image-rail').steps[0];
    const followed = await rail.run('', {}, runtime());
    expect(followed.detail).toContain("Selected rail is 'antigravity-cli' (follows the swarm default antigravity-cli)");
    fleet('claude-code');
    const refused = await rail.run('', {}, runtime());
    expect(refused.state).toBe('fail');
    expect(refused.detail).toContain('the swarm default claude-code cannot make images; set STORYBOARD_IMAGE_PROVIDER');
  });
});
