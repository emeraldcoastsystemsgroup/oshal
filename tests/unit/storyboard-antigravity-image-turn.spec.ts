/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the antigravity-cli storyboard image rail (ADR-130 amendment 2026-10-02), across the real filesystem and a real child process. The render chain is real end to end except the HTTP hop: the antigravity-cli provider stages the anchor and builds the prompt, the boot-seam executor hands the envelope to the REAL bot-node execution handler, which runs the REAL TaskController message path, the REAL AgenticController, the REAL AntigravityProvider and the REAL AntigravityCLIWrapper, which spawns tests/fixtures/fake-agy-image.cjs with its own argv, cwd and private HOME; the stand-in writes the image into that HOME the way agy 1.2.8 did in the headless proof. Pins: the image comes back to the provider (JPEG converted to a real PNG, source format reported, receipt says generate_image DONE) and the private HOME is gone afterwards; the prompt names generate_image, passes the anchor's absolute path in ImagePaths and forbids code, commands and additions, and it reaches agy verbatim inside the handler's SEC-05 data record, without the ticket/handover scaffolding. Guard A: no generate_image step (image in the brain anyway), a run_command-only stream (image drawn into the workspace), a generate_image that ended in ERROR, an image older than the turn, a step output naming a file outside the private brain, and a workspace that already holds an output are all refused with nothing collected, and the HOME is still removed. An ordinary (non-image) turn collects nothing, and an image turn cannot combine with host-tools-only or a tool bridge. The only doubles are outside the boundary: the two any-bot sqlite stores (in memory) and the HTTP hop between the executor and the handler.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The bot-level rule end to end (ADR-130 amendment 2026-10-02): one render crosses the REAL boot wiring (wireCliStoryboardImageExecutor) over the canonical runtime-params resolver and the REAL switch snapshot (fleet default antigravity-cli), a BotNodeClient double that does only what the /api/swarm-execute route does with the body (the REAL parseBotNodeProviderAuthority onto the envelope, the REAL buildBotNodeHttpResponse back), and the REAL bot-node handler with its ADR-034 dispatchConfigRuntime seam reporting the bot on antigravity-cli. The bot's reconcile is a 'match', setActiveProvider is never called, the provider reports the turn ran on antigravity-cli, and the image still comes back. The case fails if the wiring stamps anything but the bot's own record (a rail harness, a fallback chain the real post-execution check would accept).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 carve for image turns (operator decision 2026-10-02 b): the render instruction now reaches agy as the TRUSTED CONFIGURATION section (source image-render-instruction), the brief as the one data record, and the dispatch body carries the brief as `text` and the instruction as `renderInstruction`; the route double runs the REAL parseBotNodePromptCarrier so the carrier is validated the way /api/swarm-execute validates it. The exact text agy receives, the rebind's tools and the unchanged non-image turns are pinned in tests/unit/image-turn-prompt-framing.spec.ts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Clearer Guard A refusals (operator decision 2026-10-03; Guard A still accepts exactly what it did). The Guard A table now pins the whole error each refusal reaches the provider's caller with: generate_image never ran, ran and ended in ERROR (the 2026-10-03 replay shape: TOOL_ERROR "no image generated in response", then NO_IMAGE_CAPABILITY), ran but never finished, or reached DONE with no acceptable file; and the bot's untrusted diagnostic (the tool's error text, the model's final reply) on the error's `diagnostic`, never in its message. New: an ERROR step with an image in the brain anyway is refused (only the DONE check stands in its way); the reply and the tool error are bounded and lose their control characters; the bot logs the refusal with both as fields; pino's err serializer carries the diagnostic; the REAL storyboard pipeline (generateStoryboardFrame) does not retry a refusal whose tool error and reply carry its transient words, because they are not in the message it classifies; and the 2026-10-03 00:24 shape end to end, a render bot found on a stale default corrected onto its own antigravity-cli before the render (reconcile 'corrected', one switch, onto its own setting). The wrapper case pins the bot-side refusal text with its diagnostic marker.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Verifier finding on core PR #1031: the refusal's diagnostic reached the Antigravity provider error's message and stderr, which ProviderFailoverProvider classifies, and bot-node-runtime wraps antigravity-cli in that failover whenever a fallback order is configured. New: three refusals carrying a throttle word (RESOURCE_EXHAUSTED/quota in the tool's error, 429 Too Many Requests in the model's reply, RESOURCE_EXHAUSTED as the tool step's last state) run through the REAL maybeWrapBotNodeProviderFailover with a recording openai-codex rung: no "[ProviderFailover] ... retrying via" line, the rung never runs, one agy turn, and the api still receives the diagnostic (the handler re-attaches it where the error leaves the node). The active-only reason no longer names the stream's state; it moved into the diagnostic. The marker is the shared ANY_BOT_IMAGE_TURN_DIAGNOSTIC_MARKER, pinned equal to agy-image-turn.js's.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Retry, max 3, fresh turns (operator decision 2026-10-03). A render whose generate_image ran and ended in ERROR now runs again as a fresh turn through this same real chain: the Guard A table's two ERROR shapes make three agy turns, each with its own private HOME (removed) and its own -a2/-a3 workspace (no output collected), and fail with "render retries exhausted: all 3 attempts failed" after Guard A's words; every other shape stays one turn with its message unchanged. New: a first turn ending in ERROR and a second that renders (FAKE_AGY_IMAGE_MODE_SEQUENCE) hands back the second turn's image, attempt 2, from <id>-a2, the second turn's instruction naming its own anchor; the same through the REAL boot wiring and its one-image-turn-per-bot queue, where neither dispatch body carries the queue's startBy. Guard A's [backoff] category (a quota, a 429 or a rate limit in the image tool's own error) is Guard A's own token: it crosses the REAL maybeWrapBotNodeProviderFailover on every attempt with no failover line, the openai-codex rung never runs, and it alone selects the long waits; the shared ANY_BOT_IMAGE_TURN_ERROR_REFUSAL and ANY_BOT_IMAGE_TURN_BACKOFF_CATEGORY are pinned equal to agy-image-turn.js's. The provider's waits ride the test-only sleepImpl and are recorded, so the real chain runs without real 3 to 45 s waits; the storyboard frame stage still adds no retry of its own (three turns, the provider's).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import sharp from 'sharp';

import { createBotNodeExecutionHandler, IMAGE_RENDER_INSTRUCTION_SOURCE } from '../../src/app/bot-node-execution-handler';
import { parseBotNodePromptCarrier } from '../../src/app/bot-node-request-scope';
import { maybeWrapBotNodeProviderFailover } from '../../src/app/bot-node-runtime';
import { ANY_BOT_IMAGE_TURN_BACKOFF_CATEGORY, ANY_BOT_IMAGE_TURN_DIAGNOSTIC_MARKER, ANY_BOT_IMAGE_TURN_ERROR_REFUSAL } from '../../src/shared/llm-runtime';
import { buildAntigravityRenderPrompt, createAntigravityCliImageProvider } from '../../src/features/video-generation/services/storyboard-antigravity-image-provider';
import { registerCliStoryboardImageExecutor } from '../../src/features/video-generation/services/storyboard-cli-image-executor';
import { generateStoryboardFrame } from '../../src/features/video-generation/services/storyboard-frames';
import { registerStoryboardRenderBotReader } from '../../src/features/video-generation/services/storyboard-image-default';
import { wireCliStoryboardImageExecutor } from '../../src/app/storyboard-cli-image-wiring';
import { parseBotNodeProviderAuthority } from '../../src/app/bot-node-provider-authority';
import { buildBotNodeHttpResponse } from '../../src/app/bot-node-http-response';
import { clearRenderBotSwitch, installRenderBotSwitch, switchRow } from '../fixtures/storyboard-render-bot-switch';

/** The HTTP hop to the node: the only double between the wiring and the real handler (set per case). */
const hop = vi.hoisted(() => ({ deliver: null as null | ((agentId: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>) }));
vi.mock('@/features/agent-management', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  BotNodeClient: class {
    async execute(agentId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (!hop.deliver) throw new Error('no bot node behind the hop in this case');
      return hop.deliver(agentId, body);
    }
  },
  createRegistryEndpointResolver: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgenticController = require('../../any-bot/server/controllers/AgenticController');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TaskController = require('../../any-bot/server/controllers/TaskController');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AntigravityProvider = require('../../any-bot/server/services/llm/AntigravityProvider');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const agyImageTurn = require('../../any-bot/server/services/codebase/agy-image-turn') as { DIAGNOSTIC_MARKER: string; ENDED_IN_ERROR_REFUSAL: string; BACKOFF_CATEGORY: string };

const FAKE_AGY = path.resolve('tests/fixtures/fake-agy-image.cjs');
const OWNER = 'operator-sub';
const RENDER_BOT = 'a0000000-0000-0000-0000-000000000099';
const ENV_KEYS = ['DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'ANTIGRAVITY_OAUTH_TOKEN_PATH', 'OSHAL_WORKSPACE_ROOT', 'SHARED_WORKSPACE_ROOT',
  'SWARM_CONTROLLER_URL', 'FAKE_AGY_OBSERVE_FILE', 'FAKE_AGY_IMAGE_MODE', 'OSHAL_TOOL_LESS', 'FAKE_AGY_REPLY_JSON', 'FAKE_AGY_TOOL_ERROR_JSON',
  'FAKE_AGY_ACTIVE_STATE', 'FAKE_AGY_IMAGE_MODE_SEQUENCE'];
/** How a refused render reaches the provider's caller from the real handler: the bot's own words, then Guard A's. */
const REFUSED = 'antigravity-cli image provider: render task failed — Antigravity CLI error: image turn refused: ';
/** Guard A's first half, the text every no-DONE refusal still starts with. */
const NO_DONE = 'the event stream shows no generate_image tool step that reached DONE';
/** What the provider adds when three fresh turns all ended in Guard A's ERROR. */
const EXHAUSTED = ' — render retries exhausted: all 3 attempts failed';
/** A failed render: the message, and the bot's untrusted diagnostic beside it. */
type RenderError = Error & { diagnostic?: string };
/** The provider's waits between attempts, recorded instead of slept (the test-only sleepImpl). */
const waits: number[] = [];
const recordWait = async (ms: number): Promise<void> => { waits.push(ms); };

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
  delete process.env.FAKE_AGY_REPLY_JSON;
  delete process.env.FAKE_AGY_TOOL_ERROR_JSON;
  delete process.env.FAKE_AGY_ACTIVE_STATE;
  delete process.env.FAKE_AGY_IMAGE_MODE_SEQUENCE;
  waits.length = 0;
  registerCliStoryboardImageExecutor(null);
});

afterEach(() => {
  registerCliStoryboardImageExecutor(null);
  registerStoryboardRenderBotReader(null);
  clearRenderBotSwitch();
  hop.deliver = null;
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

/** The REAL message path of a bot node over in-memory stores (the two sqlite stores are the doubles), on `provider`. */
function botNodeTaskController(provider: unknown = antigravityProvider()) {
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
    antigravityProvider: provider, getCurrentProvider: () => 'antigravity-cli',
  }, registry, stream, controller);
  return controller;
}

/** The boot seam wired to the real bot-node handler, with the envelope bot-node-server builds for a render. */
function wireRealBot(controller = botNodeTaskController()): void {
  const handler = createBotNodeExecutionHandler({
    anyBotTaskController: controller, providerName: 'antigravity-cli', modelName: 'gemini-3.8-flash-low',
  });
  registerCliStoryboardImageExecutor(async (request) => {
    const outcome = await handler({ correlationId: `http-${request.taskId}`, fromAgentId: 'swarm-controller', toAgentId: RENDER_BOT,
      channel: `agent.${RENDER_BOT}`, messageType: 'request' as const, payload: {
        // As the wiring sends it: the brief is the untrusted text, the instruction its own carrier.
        text: request.brief, renderInstruction: request.prompt, workspaceTaskId: request.workspaceFolderId, workspaceFolderId: request.workspaceFolderId,
        externalId: request.taskId, agenticMode: true, direct: false, userSub: request.userSub, imageTurn: true,
      } });
    const output = (outcome.output ?? {}) as { response?: string; model?: string };
    return { success: outcome.success, responseText: output.response ?? '', model: output.model, error: outcome.error };
  });
}

const anchor = (): Promise<Buffer> => sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();

/** The brief as the handler's trust-separated builder carries it: the content of the one data record. */
function briefRecord(prompt: string): string {
  const record = /<UNTRUSTED_CONTENT>(\{.*?\})<\/UNTRUSTED_CONTENT>/.exec(prompt);
  expect(record, 'the brief reaches agy as the SEC-05 data record').not.toBeNull();
  return String(JSON.parse(record![1]).content);
}

/** The server-authored render instruction as the handler files it: the TRUSTED CONFIGURATION section's one fragment. */
function renderInstruction(prompt: string): string {
  const section = /## TRUSTED CONFIGURATION\n\[trusted-config source="([^"]+)"\]\n([\s\S]*?)\n\n## UNTRUSTED CONTENT/.exec(prompt);
  expect(section, 'the render instruction reaches agy as trusted configuration').not.toBeNull();
  expect(section![1]).toBe(IMAGE_RENDER_INSTRUCTION_SOURCE);
  return section![2];
}

function renderWorkspaces(): string[] {
  return fs.readdirSync(root).filter((name) => name.startsWith('sbimg-')).map((name) => path.join(root, name));
}

/** The real antigravity-cli provider, its waits between fresh turns recorded instead of slept. */
const renderProvider = (options: { taskId?: string } = {}) => createAntigravityCliImageProvider(OWNER, { ...options, sleepImpl: recordWait });

/** One render through the real chain with the stand-in agy in `mode`; the error it failed with, or null. */
async function refusedRender(mode: string, controller = botNodeTaskController()): Promise<RenderError | null> {
  process.env.FAKE_AGY_IMAGE_MODE = mode;
  wireRealBot(controller);
  return renderProvider().generateWithMeta!('make the circle blue', await anchor()).then(() => null, (e: RenderError) => e);
}

/** The render's task workspaces in attempt order: its own id, then -a2 and -a3. */
function attemptWorkspaces(): string[] {
  return renderWorkspaces().sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Every line this process writes to stdout (where the any-bot pino logger writes) until restore(). */
function captureStdout(): { lines: () => string[]; restore: () => void } {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((...args: unknown[]) => {
    written.push(String(args[0]));
    return original(...args);
  }) as typeof process.stdout.write);
  return { lines: () => written.join('').split('\n'), restore: () => spy.mockRestore() };
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
    // The handler files the server-authored instruction as trusted configuration and the brief as the
    // SEC-05 data record (the carve for image turns): no ticket scaffolding, and the brief never in the instruction.
    const render = renderInstruction(turn.prompt);
    expect(render).toBe(buildAntigravityRenderPrompt(path.join(workspace, 'anchor.png')));
    expect(render).toContain('Call your generate_image tool exactly once');
    expect(render).toContain(`ImagePaths = ${JSON.stringify([path.join(workspace, 'anchor.png')])}`);
    expect(render).toContain('Prompt = the brief');
    expect(render).toContain('Do not write code, do not run terminal commands');
    expect(render).toContain('add nothing it does not ask for');
    expect(render).not.toContain('make the circle blue');
    expect(briefRecord(turn.prompt)).toBe('make the circle blue, keep everything else');
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
    expect(renderInstruction(observations()[0].prompt)).not.toContain('ImagePaths');
    expect(briefRecord(observations()[0].prompt)).toBe('a blue circle on white');
  }, 60_000);

  const NEVER_RAN = `${NO_DONE}: generate_image never ran in this turn`;
  const ENDED_IN_ERROR = `${NO_DONE}: generate_image ran and ended in ERROR`;
  const NO_FILE = 'generate_image reached DONE but no PNG or JPEG it wrote during this turn was found in the private brain directory';
  const TOOL_ERROR = 'generate_image error "TOOL_ERROR: no image generated in response"';
  it.each([
    ['no-step', NEVER_RAN, 'model reply "RENDERED"', 1],
    ['run-command', NEVER_RAN, 'model reply "RENDERED"', 1],
    // The 2026-10-03 storyboard replays: the tool answered TOOL_ERROR, then the model replied NO_IMAGE_CAPABILITY.
    // The one shape the render retries: three fresh turns, then the retries are exhausted.
    ['error-step', `${ENDED_IN_ERROR}${EXHAUSTED}`, `${TOOL_ERROR}; model reply "NO_IMAGE_CAPABILITY"`, 3],
    // An image and its step output sit in the brain anyway: only the DONE check stands between it and collection.
    ['error-step-image', `${ENDED_IN_ERROR}${EXHAUSTED}`, `${TOOL_ERROR}; model reply "RENDERED"`, 3],
    // The stream's state is the tool's word, not Guard A's: it rides in the diagnostic.
    ['active-only', `${NO_DONE}: generate_image ran but did not finish`, 'generate_image last state "ACTIVE"; model reply "RENDERED"', 1],
    ['stale', NO_FILE, 'model reply "RENDERED"', 1],
    ['outside', NO_FILE, 'model reply "RENDERED"', 1],
  ])('Guard A refuses the %s turn and says which way it failed: nothing collected, the render fails, every HOME is removed', async (mode, reason, diagnostic, turns) => {
    const err = await refusedRender(mode);
    // The message is the bot's own words only; every no-DONE reason still starts with the old text.
    expect(err?.message).toBe(`${REFUSED}${reason}`);
    // The tool's error text and the model's reply ride beside it as untrusted diagnostic text.
    expect(err?.diagnostic).toBe(diagnostic);
    // Only Guard A's ERROR runs again, each time as a fresh turn: its own workspace and its own private HOME.
    expect(observations(), 'one agy turn per attempt').toHaveLength(turns);
    const workspaces = attemptWorkspaces();
    expect(workspaces.map((dir) => path.basename(dir))).toEqual([path.basename(workspaces[0]), `${path.basename(workspaces[0])}-a2`, `${path.basename(workspaces[0])}-a3`].slice(0, turns));
    for (const workspace of workspaces) {
      const files = fs.readdirSync(workspace);
      expect(files).not.toContain('output.jpg');
      expect(files).not.toContain('output.image-turn.json');
    }
    expect(new Set(observations().map((turn) => turn.home)).size, 'each turn had a private HOME of its own').toBe(turns);
    for (const turn of observations()) expect(fs.existsSync(turn.home)).toBe(false);
    expect(waits, 'the waits between fresh turns (about 3 s, then about 8 s)').toHaveLength(turns - 1);
  }, 60_000);

  it('a first turn that ends in ERROR runs again as a fresh turn, and the second turn\'s image comes back from its own workspace', async () => {
    process.env.FAKE_AGY_IMAGE_MODE_SEQUENCE = 'error-step,jpeg';
    wireRealBot();

    const result = await renderProvider().generateWithMeta!('make the circle blue', await anchor());

    const [first, second] = attemptWorkspaces();
    expect(path.basename(second)).toBe(`${path.basename(first)}-a2`);
    expect(result.cliRender).toMatchObject({ taskId: path.basename(second), attempt: 2, tool: 'generate_image', toolState: 'DONE', locator: 'step-output' });
    expect((await sharp(result.image).metadata()).format).toBe('png');
    expect(fs.readdirSync(first)).not.toContain('output.jpg');
    expect(fs.readdirSync(second)).toEqual(expect.arrayContaining(['anchor.png', 'output.jpg', 'output.image-turn.json']));
    const turns = observations();
    expect(turns).toHaveLength(2);
    // Fresh turns: each ran in its own workspace with its own private HOME, and each instruction names its own anchor.
    expect(turns.map((turn) => fs.realpathSync(turn.cwd))).toEqual([fs.realpathSync(first), fs.realpathSync(second)]);
    expect(turns[0].home).not.toBe(turns[1].home);
    expect(renderInstruction(turns[1].prompt)).toBe(buildAntigravityRenderPrompt(path.join(second, 'anchor.png')));
    expect(briefRecord(turns[1].prompt)).toBe('make the circle blue');
    for (const turn of turns) expect(fs.existsSync(turn.home)).toBe(false);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(3_000);
    expect(waits[0]).toBeLessThan(3_600);
  }, 60_000);
});

describe('Guard A refusals: bounded diagnostics, the bot log, and an error message the tool and the model cannot steer', () => {
  it('bounds the tool error and the model reply to 200 characters each and turns control characters into spaces', async () => {
    process.env.FAKE_AGY_TOOL_ERROR_JSON = JSON.stringify({ type: 'TOOL_ERROR\u0007', message: `quota\u0000 hit\n${'z'.repeat(300)}` });
    process.env.FAKE_AGY_REPLY_JSON = JSON.stringify(`NO_IMAGE\u0000CAPABILITY\u001b[31m "red"\r\nsecond line \u202eesrever\u2066 ${'y'.repeat(300)}`);
    const err = await refusedRender('error-step');
    const toolError = `TOOL_ERROR: quota hit ${'z'.repeat(189)}…`;
    const reply = `NO_IMAGE CAPABILITY [31m "red" second line esrever ${'y'.repeat(148)}…`;
    expect(reply).toHaveLength(200);
    // Guard A writes the marker; the node re-attaches behind it and the api splits on it: one contract across the runtimes.
    expect(ANY_BOT_IMAGE_TURN_DIAGNOSTIC_MARKER).toBe(agyImageTurn.DIAGNOSTIC_MARKER);
    // A quota in the tool's own error puts the ERROR in Guard A's [backoff] category, in Guard A's own words.
    expect(err?.message).toBe(`${REFUSED}${NO_DONE}: generate_image ran and ended in ERROR [backoff]${EXHAUSTED}`);
    expect(err?.diagnostic).toBe(`generate_image error ${JSON.stringify(toolError)}; model reply ${JSON.stringify(reply)}`);
    expect(err?.diagnostic).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    // A framework logger's { err } (Create logs its region-edit failure that way) carries it: pino's err serializer copies it.
    expect((pino.stdSerializers.err(err!) as unknown as Record<string, unknown>).diagnostic).toBe(err?.diagnostic);
  }, 60_000);

  it('the bot logs the refusal with the tool error and the model reply as fields of their own, once per fresh turn', async () => {
    const stdout = captureStdout();
    try {
      await refusedRender('error-step');
    } finally {
      stdout.restore();
    }
    const refusals = stdout.lines().filter((line) => line.includes('"agy-image-turn"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.msg === 'image turn refused');
    expect(refusals).toHaveLength(3);
    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ level: 40, reason: `${NO_DONE}: generate_image ran and ended in ERROR`,
        toolError: 'TOOL_ERROR: no image generated in response', modelReply: 'NO_IMAGE_CAPABILITY' });
    }
  }, 60_000);

  it('the api retries on Guard A\'s own ERROR words and [backoff] category: one contract across the runtimes', () => {
    expect(ANY_BOT_IMAGE_TURN_ERROR_REFUSAL).toBe(agyImageTurn.ENDED_IN_ERROR_REFUSAL);
    expect(ANY_BOT_IMAGE_TURN_BACKOFF_CATEGORY).toBe(agyImageTurn.BACKOFF_CATEGORY);
    expect(`${REFUSED}${NO_DONE}: generate_image ran and ended in ERROR`).toBe(`antigravity-cli image provider: render task failed — Antigravity CLI error: ${ANY_BOT_IMAGE_TURN_ERROR_REFUSAL}`);
  });

  it('the REAL storyboard frame stage does not retry a refusal whose tool error and reply carry its transient words', async () => {
    process.env.FAKE_AGY_TOOL_ERROR_JSON = JSON.stringify({ type: 'TOOL_ERROR', message: 'upstream returned 503 EMPTY_RESPONSE' });
    process.env.FAKE_AGY_REPLY_JSON = JSON.stringify('EMPTY_RESPONSE 503');
    process.env.FAKE_AGY_IMAGE_MODE = 'error-step';
    wireRealBot();
    const provider = renderProvider();
    // generateStoryboardFrame retries only when the error MESSAGE reads transient (RATE_LIMITED, EMPTY_RESPONSE, 429, 5xx).
    const err = await generateStoryboardFrame({ n: 1, camera: 'WIDE: a red circle on white' }, { styleLock: 'flat colour', cast: [], provider }, null)
      .then(() => null, (e: Error) => e);
    expect(err?.message).toBe(`storyboard frame 1 (antigravity-cli): ${REFUSED}${NO_DONE}: generate_image ran and ended in ERROR${EXHAUSTED}`);
    // The provider's own three fresh turns on Guard A's words; the frame stage adds none on the tool's or the model's words.
    expect(observations(), 'one render of three fresh turns: words from the tool or the model never decide a retry').toHaveLength(3);
  }, 60_000);
});

describe('a Guard A refusal never enters the bot node\'s provider failover (the REAL maybeWrapBotNodeProviderFailover)', () => {
  /** antigravity-cli as bot-node-runtime wraps it when a fallback order is configured, over a recording openai-codex rung. */
  function failoverAntigravity(rungCalls: string[]): unknown {
    const raw = antigravityProvider();
    const codexRung = {
      getModelInfo: () => ({ provider: 'openai-codex', model: 'gpt-5.5' }),
      generateResponse: async () => { rungCalls.push('openai-codex'); throw new Error('the fallback rung ran a model turn'); },
    };
    return maybeWrapBotNodeProviderFailover(raw, 'antigravity-cli', { 'antigravity-cli': raw, 'openai-codex': codexRung }, ['openai-codex']);
  }

  const BACKOFF = `${NO_DONE}: generate_image ran and ended in ERROR [backoff]${EXHAUSTED}`;
  it.each([
    // Guard A's own [backoff] category crosses the failover on every one of the three fresh turns.
    ['a quota in the image tool\'s own error', 'error-step',
      { FAKE_AGY_TOOL_ERROR_JSON: JSON.stringify({ type: 'TOOL_ERROR', message: 'RESOURCE_EXHAUSTED: quota exceeded' }) },
      BACKOFF, 'generate_image error "TOOL_ERROR: RESOURCE_EXHAUSTED: quota exceeded"; model reply "NO_IMAGE_CAPABILITY"', 3],
    ['a 429 in the image tool\'s own error', 'error-step',
      { FAKE_AGY_TOOL_ERROR_JSON: JSON.stringify({ type: 'HTTP_ERROR', message: '429 Too Many Requests' }) },
      BACKOFF, 'generate_image error "HTTP_ERROR: 429 Too Many Requests"; model reply "NO_IMAGE_CAPABILITY"', 3],
    ['a rate limit in the image tool\'s own error', 'error-step',
      { FAKE_AGY_TOOL_ERROR_JSON: JSON.stringify({ type: 'TOOL_ERROR', message: 'image model rate limit reached' }) },
      BACKOFF, 'generate_image error "TOOL_ERROR: image model rate limit reached"; model reply "NO_IMAGE_CAPABILITY"', 3],
    ['a 429 in the model\'s reply', 'no-step', { FAKE_AGY_REPLY_JSON: JSON.stringify('429 Too Many Requests') },
      `${NO_DONE}: generate_image never ran in this turn`, 'model reply "429 Too Many Requests"', 1],
    ['a throttle word as the tool step\'s last state', 'active-only', { FAKE_AGY_ACTIVE_STATE: 'RESOURCE_EXHAUSTED' },
      `${NO_DONE}: generate_image ran but did not finish`, 'generate_image last state "RESOURCE_EXHAUSTED"; model reply "RENDERED"', 1],
  ])('%s: no failover, no second rung, one agy turn per attempt, and the api still receives the diagnostic', async (_label, mode, env, reason, diagnostic, turns) => {
    Object.assign(process.env, env);
    const rungCalls: string[] = [];
    const stdout = captureStdout();
    let err: RenderError | null = null;
    try {
      err = await refusedRender(mode, botNodeTaskController(failoverAntigravity(rungCalls)));
    } finally {
      stdout.restore();
    }
    expect(stdout.lines().filter((line) => line.includes('[ProviderFailover]') && line.includes('retrying via')), 'no failover was attempted').toEqual([]);
    expect(rungCalls, 'the fallback rung never ran').toEqual([]);
    expect(observations(), 'one agy turn per attempt').toHaveLength(turns);
    expect(err?.message).toBe(`${REFUSED}${reason}`);
    expect(err?.diagnostic, 'the handler re-attached it where the error left the node').toBe(diagnostic);
    if (reason !== BACKOFF) return;
    // Only Guard A's [backoff] token chose the long waits: about 20 s, then about 45 s.
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(20_000);
    expect(waits[0]).toBeLessThan(24_000);
    expect(waits[1]).toBeGreaterThanOrEqual(45_000);
    expect(waits[1]).toBeLessThan(54_000);
  }, 60_000);
});

describe('the bot-level rule end to end: the real wiring, the route\'s mapping and the real handler\'s reconcile', () => {
  /** The bot node's ADR-034 runtime seam: the bot runs `initial` (its own antigravity-cli setting by default); records every switch. */
  function botRuntime(initial = { provider: 'antigravity-cli', model: 'gemini-3.8-flash-low' }) {
    const switches: Array<[string, string | undefined]> = [];
    let active = initial;
    return {
      switches,
      getActiveProvider: () => active,
      setActiveProvider: (provider: string, model?: string) => {
        switches.push([provider, model]);
        active = { provider, model: model ?? 'gemini-3.8-flash-low' };
        return active;
      },
    };
  }

  /** What /api/swarm-execute does with the body: provider authority onto the envelope, the result back as JSON. */
  function routeTo(handler: ReturnType<typeof createBotNodeExecutionHandler>) {
    return async (agentId: string, body: Record<string, unknown>) => {
      const envelope = { correlationId: `http-${String(body.taskId)}`, fromAgentId: 'swarm-controller', toAgentId: agentId, channel: `agent.${agentId}`,
        messageType: 'request' as const, payload: {
          text: body.text, workspaceTaskId: body.workspaceFolderId, workspaceFolderId: body.workspaceFolderId, externalId: body.taskId,
          agenticMode: body.agenticMode ?? true, direct: body.direct === true, userSub: body.userSub,
          // The route's REAL carrier parse: the render instruction is validated and promoted the way pattern is.
          ...parseBotNodePromptCarrier(body),
          ...parseBotNodeProviderAuthority(body), ...(body.imageTurn === true ? { imageTurn: true } : {}),
        } };
      return buildBotNodeHttpResponse(await handler(envelope), { durationMs: 0, taskId: String(body.taskId), defaultModel: 'gemini-3.8-flash-low', defaultProvider: 'antigravity-cli' });
    };
  }

  it('a render bot on the antigravity fleet default renders on its own harness: reconcile match, no switch, the image comes back', async () => {
    const installed = await installRenderBotSwitch([switchRow('fleet-default', 'antigravity-cli', { modelId: 'gemini-3.8-flash-low', fallbackOrder: ['openai-codex'] })]);
    const runtime = botRuntime();
    const bodies: Array<Record<string, unknown>> = [];
    const deliver = routeTo(createBotNodeExecutionHandler({
      anyBotTaskController: botNodeTaskController(), providerName: 'antigravity-cli', modelName: 'gemini-3.8-flash-low', dispatchConfigRuntime: runtime,
    }));
    hop.deliver = async (agentId, body) => { bodies.push(body); return deliver(agentId, body); };
    wireCliStoryboardImageExecutor({ runtimeParamsResolver: () => installed.resolver });

    const result = await createAntigravityCliImageProvider(OWNER).generateWithMeta!('make the circle blue', await anchor());

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low', fallbackOrder: [], providerConfigRequired: true, imageTurn: true,
      text: 'make the circle blue', renderInstruction: expect.stringContaining('Call your generate_image tool exactly once') });
    expect(result.cliRender).toMatchObject({ tool: 'generate_image', toolState: 'DONE', ranOn: 'antigravity-cli', providerConfigAction: 'match' });
    expect(runtime.switches, 'a bot already on its own setting is not switched').toEqual([]);
    expect((await sharp(result.image).metadata()).format).toBe('png');
    expect(fs.existsSync(observations()[0].home)).toBe(false);
  }, 60_000);

  it('a render bot found on a stale default is corrected onto its own antigravity-cli before the render: reconcile corrected, one switch onto its own setting', async () => {
    const installed = await installRenderBotSwitch([switchRow('fleet-default', 'antigravity-cli', { modelId: 'gemini-3.8-flash-low', fallbackOrder: ['openai-codex'] })]);
    // The 2026-10-03 00:24 shape: the bot booted while the api was unreachable and ran its env seed.
    const runtime = botRuntime({ provider: 'openai-codex', model: 'gpt-5.5' });
    hop.deliver = routeTo(createBotNodeExecutionHandler({
      anyBotTaskController: botNodeTaskController(), providerName: 'antigravity-cli', modelName: 'gemini-3.8-flash-low', dispatchConfigRuntime: runtime,
    }));
    wireCliStoryboardImageExecutor({ runtimeParamsResolver: () => installed.resolver });

    const result = await createAntigravityCliImageProvider(OWNER).generateWithMeta!('make the circle blue', await anchor());

    expect(result.cliRender).toMatchObject({ tool: 'generate_image', toolState: 'DONE', ranOn: 'antigravity-cli', providerConfigAction: 'corrected' });
    expect(runtime.switches, 'the one switch puts the bot back on its own setting').toEqual([['antigravity-cli', 'gemini-3.8-flash-low']]);
    expect((await sharp(result.image).metadata()).format).toBe('png');
  }, 60_000);

  it('a first turn that ends in ERROR runs again through the real wiring and its image-turn queue: a fresh dispatch on <id>-a2, the bot\'s own record each time', async () => {
    process.env.FAKE_AGY_IMAGE_MODE_SEQUENCE = 'error-step,jpeg';
    const installed = await installRenderBotSwitch([switchRow('fleet-default', 'antigravity-cli', { modelId: 'gemini-3.8-flash-low', fallbackOrder: ['openai-codex'] })]);
    const runtime = botRuntime();
    const bodies: Array<Record<string, unknown>> = [];
    const deliver = routeTo(createBotNodeExecutionHandler({
      anyBotTaskController: botNodeTaskController(), providerName: 'antigravity-cli', modelName: 'gemini-3.8-flash-low', dispatchConfigRuntime: runtime,
    }));
    hop.deliver = async (agentId, body) => { bodies.push(body); return deliver(agentId, body); };
    wireCliStoryboardImageExecutor({ runtimeParamsResolver: () => installed.resolver });

    const result = await renderProvider().generateWithMeta!('make the circle blue', await anchor());

    expect(bodies.map((body) => body.taskId)).toEqual([bodies[0].taskId, `${String(bodies[0].taskId)}-a2`]);
    for (const body of bodies) {
      expect(body).toMatchObject({ providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low', fallbackOrder: [], providerConfigRequired: true, imageTurn: true, text: 'make the circle blue' });
      // The queue's start-by time is the api's own bookkeeping; it never reaches the bot.
      expect(body).not.toHaveProperty('startBy');
    }
    expect(result.cliRender).toMatchObject({ taskId: `${String(bodies[0].taskId)}-a2`, attempt: 2, ranOn: 'antigravity-cli', providerConfigAction: 'match' });
    expect(runtime.switches, 'neither turn switched the bot').toEqual([]);
    expect(observations()).toHaveLength(2);
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
    // The bot-side refusal: Guard A's own words, then the untrusted diagnostic after its marker.
    expect(result.stderr).toBe('image turn refused: the task workspace already holds output.jpg, which this turn did not collect | untrusted diagnostic: model reply "RENDERED"');
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
