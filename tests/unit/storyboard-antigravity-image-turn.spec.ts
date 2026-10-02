/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the antigravity-cli storyboard image rail (ADR-130 amendment 2026-10-02), across the real filesystem and a real child process. The render chain is real end to end except the HTTP hop: the antigravity-cli provider stages the anchor and builds the prompt, the boot-seam executor hands the envelope to the REAL bot-node execution handler, which runs the REAL TaskController message path, the REAL AgenticController, the REAL AntigravityProvider and the REAL AntigravityCLIWrapper, which spawns tests/fixtures/fake-agy-image.cjs with its own argv, cwd and private HOME; the stand-in writes the image into that HOME the way agy 1.2.8 did in the headless proof. Pins: the image comes back to the provider (JPEG converted to a real PNG, source format reported, receipt says generate_image DONE) and the private HOME is gone afterwards; the prompt names generate_image, passes the anchor's absolute path in ImagePaths and forbids code, commands and additions, and it reaches agy verbatim inside the handler's SEC-05 data record, without the ticket/handover scaffolding. Guard A: no generate_image step (image in the brain anyway), a run_command-only stream (image drawn into the workspace), a generate_image that ended in ERROR, an image older than the turn, a step output naming a file outside the private brain, and a workspace that already holds an output are all refused with nothing collected, and the HOME is still removed. An ordinary (non-image) turn collects nothing, and an image turn cannot combine with host-tools-only or a tool bridge. The only doubles are outside the boundary: the two any-bot sqlite stores (in memory) and the HTTP hop between the executor and the handler.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { createBotNodeExecutionHandler } from '../../src/app/bot-node-execution-handler';
import { createAntigravityCliImageProvider } from '../../src/features/video-generation/services/storyboard-antigravity-image-provider';
import { registerCliStoryboardImageExecutor } from '../../src/features/video-generation/services/storyboard-cli-image-executor';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgenticController = require('../../any-bot/server/controllers/AgenticController');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TaskController = require('../../any-bot/server/controllers/TaskController');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AntigravityProvider = require('../../any-bot/server/services/llm/AntigravityProvider');

const FAKE_AGY = path.resolve('tests/fixtures/fake-agy-image.cjs');
const OWNER = 'operator-sub';
const RENDER_BOT = 'a0000000-0000-0000-0000-000000000099';
const ENV_KEYS = ['DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'ANTIGRAVITY_OAUTH_TOKEN_PATH', 'OSHAL_WORKSPACE_ROOT', 'SHARED_WORKSPACE_ROOT',
  'SWARM_CONTROLLER_URL', 'FAKE_AGY_OBSERVE_FILE', 'FAKE_AGY_IMAGE_MODE', 'OSHAL_TOOL_LESS'];

interface Observation { argv: string[]; cwd: string; home: string; prompt: string }

let saved: Record<string, string | undefined>;
let scratch: string;
let root: string;
let observeFile: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-agy-image-'));
  const auth = path.join(scratch, 'auth');
  fs.mkdirSync(auth);
  fs.writeFileSync(path.join(auth, 'antigravity-oauth-token'), 'fixture-token');
  fs.writeFileSync(path.join(auth, 'installation_id'), 'fixture-installation');
  root = path.join(scratch, 'workspaces');
  fs.mkdirSync(root);
  observeFile = path.join(scratch, 'observations.ndjson');
  Object.assign(process.env, {
    DEMO_MODE: 'true', OSHAL_OPERATOR_SUBS: OWNER,
    ANTIGRAVITY_OAUTH_TOKEN_PATH: path.join(auth, 'antigravity-oauth-token'),
    // The provider and the bot resolve the same shared root, as the api and the bots do in compose.
    OSHAL_WORKSPACE_ROOT: root, SHARED_WORKSPACE_ROOT: root,
    // The model-gateway preflight fails open on a refused loopback port; nothing leaves the host.
    SWARM_CONTROLLER_URL: 'http://127.0.0.1:9',
    FAKE_AGY_OBSERVE_FILE: observeFile,
  });
  delete process.env.FAKE_AGY_IMAGE_MODE;
  delete process.env.OSHAL_TOOL_LESS;
  registerCliStoryboardImageExecutor(null);
});

afterEach(() => {
  registerCliStoryboardImageExecutor(null);
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** The real provider, spawning the stand-in agy as a real child with the wrapper's own argv/env. */
function antigravityProvider() {
  const provider = new AntigravityProvider({ model: 'gemini-3.8-flash-low' });
  provider.wrapper.spawnImpl = (_command: string, args: string[], options: Record<string, unknown>) =>
    spawn(process.execPath, [FAKE_AGY, ...args], options);
  return provider;
}

function observations(): Observation[] {
  if (!fs.existsSync(observeFile)) return [];
  return fs.readFileSync(observeFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

/** The REAL message path of a bot node over in-memory stores (the two sqlite stores are the doubles). */
function botNodeTaskController() {
  const controller = Object.create(TaskController.prototype);
  const registry = new ToolRegistry();
  const stream = { broadcast() {} };
  Object.assign(controller, {
    activeTasks: new Map(), toolRegistry: registry, stream, llm: null,
    taskStore: { saveTask: async (task: unknown) => task, loadTask: async () => null },
    messageStore: { saveMessage: async () => undefined, getMessages: async () => [] },
    createTask: async (text: string, _mode: string, opts: { forceTaskId: string; userSub?: string }) => {
      const workspace = path.join(root, opts.forceTaskId);
      fs.mkdirSync(workspace, { recursive: true });
      const task = { id: opts.forceTaskId, text, userSub: opts.userSub ?? null, workspace_dir: workspace, messages: [], apiMetrics: {} };
      controller.activeTasks.set(task.id, task);
      return task;
    },
  });
  controller.agenticController = new AgenticController({
    bedrockProvider: null, clineProvider: null, claudeCodeProvider: null, codexProvider: null,
    antigravityProvider: antigravityProvider(), getCurrentProvider: () => 'antigravity-cli',
  }, registry, stream, controller);
  return controller;
}

/** The boot seam wired to the real bot-node handler, with the envelope bot-node-server builds for a render. */
function wireRealBot(): void {
  const handler = createBotNodeExecutionHandler({
    anyBotTaskController: botNodeTaskController(), providerName: 'antigravity-cli', modelName: 'gemini-3.8-flash-low',
  });
  registerCliStoryboardImageExecutor(async (request) => {
    const outcome = await handler({ correlationId: `http-${request.taskId}`, fromAgentId: 'swarm-controller', toAgentId: RENDER_BOT,
      channel: `agent.${RENDER_BOT}`, messageType: 'request' as const, payload: {
        text: request.prompt, workspaceTaskId: request.workspaceFolderId, workspaceFolderId: request.workspaceFolderId,
        externalId: request.taskId, agenticMode: true, direct: false, userSub: request.userSub, imageTurn: true,
      } });
    const output = (outcome.output ?? {}) as { response?: string; model?: string };
    return { success: outcome.success, responseText: output.response ?? '', model: output.model, error: outcome.error };
  });
}

const anchor = (): Promise<Buffer> => sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();

/** The render prompt as the handler's trust-separated builder carries it: the content of the first data record. */
function renderRecord(prompt: string): string {
  const record = /<UNTRUSTED_CONTENT>(\{.*?\})<\/UNTRUSTED_CONTENT>/.exec(prompt);
  expect(record, 'the render prompt reaches agy as the SEC-05 data record').not.toBeNull();
  return String(JSON.parse(record![1]).content);
}

function renderWorkspaces(): string[] {
  return fs.readdirSync(root).filter((name) => name.startsWith('sbimg-')).map((name) => path.join(root, name));
}

describe('antigravity-cli storyboard rail, through the real bot-node chain and a real agy child', () => {
  it('hands generate_image\'s JPEG back as a real PNG, reports the source format, and removes the private HOME', async () => {
    wireRealBot();
    const source = await anchor();

    const result = await createAntigravityCliImageProvider(OWNER).generateWithMeta!('make the circle blue, keep everything else', source);

    const meta = await sharp(result.image).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 96, height: 80 });
    expect(result.sourceMimeType).toBe('image/jpeg');
    expect(result.costUsd).toBeNull();
    expect(result.cliRender).toMatchObject({ tool: 'generate_image', toolState: 'DONE', locator: 'step-output' });
    const [workspace] = renderWorkspaces();
    expect(path.basename(workspace)).toBe(result.cliRender!.taskId);
    expect(fs.readdirSync(workspace).sort()).toEqual(expect.arrayContaining(['anchor.png', 'output.image-turn.json', 'output.jpg']));
    expect(fs.existsSync(path.join(workspace, 'output.png'))).toBe(false);

    const [turn] = observations();
    expect(fs.existsSync(turn.home), 'the private HOME is removed after the image was collected').toBe(false);
    expect(fs.realpathSync(turn.cwd)).toBe(fs.realpathSync(workspace));
    expect(turn.argv.slice(0, 2)).toEqual(['--mode', 'accept-edits']);
    expect(turn.argv).toContain('--sandbox');
    expect(turn.argv).not.toContain('--dangerously-skip-permissions');
    // The handler hands the render prompt over as the SEC-05 data record, verbatim: no ticket scaffolding.
    const render = renderRecord(turn.prompt);
    expect(render).toContain('Call your generate_image tool exactly once');
    expect(render).toContain(`ImagePaths = ${JSON.stringify([path.join(workspace, 'anchor.png')])}`);
    expect(render).toContain('Prompt = "make the circle blue, keep everything else"');
    expect(render).toContain('Do not write code, do not run terminal commands');
    expect(render).toContain('add nothing it does not ask for');
    expect(turn.prompt).not.toContain('== WORKSPACE RULES');
    expect(turn.prompt).not.toContain('DEVELOPER HANDOVER');
  }, 60_000);

  it('a PNG from generate_image passes through unchanged, and a text-to-image render passes no ImagePaths', async () => {
    process.env.FAKE_AGY_IMAGE_MODE = 'png';
    wireRealBot();
    const result = await createAntigravityCliImageProvider(OWNER).generateWithMeta!('a blue circle on white', null);
    expect(result.sourceMimeType).toBe('image/png');
    expect((await sharp(result.image).metadata()).format).toBe('png');
    expect(fs.readdirSync(renderWorkspaces()[0])).toContain('output.png');
    expect(renderRecord(observations()[0].prompt)).not.toContain('ImagePaths');
  }, 60_000);

  it.each([
    ['no-step', /no generate_image tool step that reached DONE/],
    ['run-command', /no generate_image tool step that reached DONE/],
    ['error-step', /no generate_image tool step that reached DONE/],
    ['stale', /no PNG or JPEG it wrote during this turn/],
    ['outside', /no PNG or JPEG it wrote during this turn/],
  ])('Guard A refuses the %s turn: nothing collected, the render fails, the HOME is removed', async (mode, reason) => {
    process.env.FAKE_AGY_IMAGE_MODE = mode;
    wireRealBot();
    const err = await createAntigravityCliImageProvider(OWNER).generateWithMeta!('make the circle blue', await anchor()).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/render task failed/);
    expect(err?.message).toMatch(reason);
    const files = fs.readdirSync(renderWorkspaces()[0]);
    expect(files).not.toContain('output.jpg');
    expect(files).not.toContain('output.image-turn.json');
    expect(fs.existsSync(observations()[0].home)).toBe(false);
  }, 60_000);
});

describe('the Antigravity wrapper\'s image turn, directly', () => {
  function workspace(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const turn = (dir: string, options: Record<string, unknown>) =>
    antigravityProvider().wrapper.executeTask('render', dir, { extraEnv: { OSHAL_USER_SUB: OWNER }, ...options });

  it('finds the image by scanning the private brain when the step output is missing', async () => {
    process.env.FAKE_AGY_IMAGE_MODE = 'scan';
    const dir = workspace('scan-task');
    const result = await turn(dir, { imageTurn: true });
    expect(result).toMatchObject({ success: true, image: { file: 'output.jpg', mimeType: 'image/jpeg', locator: 'brain-scan' } });
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'output.image-turn.json'), 'utf8'));
    expect(receipt).toMatchObject({ tool: 'generate_image', toolState: 'DONE', file: 'output.jpg', sha256: result.image.sha256 });
  }, 30_000);

  it('refuses when the workspace already holds an output it did not collect', async () => {
    const dir = workspace('pre-existing-task');
    fs.writeFileSync(path.join(dir, 'output.jpg'), 'drawn earlier');
    const result = await turn(dir, { imageTurn: true });
    expect(result.success).toBe(false);
    expect(result.stderr).toMatch(/already holds output\.jpg/);
    expect(fs.readFileSync(path.join(dir, 'output.jpg'), 'utf8')).toBe('drawn earlier');
    expect(fs.existsSync(path.join(dir, 'output.image-turn.json'))).toBe(false);
  }, 30_000);

  it('collects nothing on an ordinary turn, even when generate_image ran', async () => {
    const dir = workspace('ordinary-task');
    const result = await turn(dir, {});
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty('image');
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('output'))).toEqual([]);
  }, 30_000);

  it('an image turn cannot be host-tools-only or bridged', async () => {
    const dir = workspace('shape-task');
    await expect(turn(dir, { imageTurn: true, hostToolsOnly: true })).rejects.toThrow(/only as an unbridged workspace task turn/);
    await expect(turn(dir, { imageTurn: true, toolBridge: { agentId: 'a' } })).rejects.toThrow(/only as an unbridged workspace task turn/);
    expect(observations()).toEqual([]);
  });
});
