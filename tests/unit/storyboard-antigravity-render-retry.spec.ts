/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the antigravity-cli render retry (operator decision 2026-10-03: "Retry, max 3, fresh turns"; the 04:41-04:47 UTC measured run rendered the storyboard card 4 of 10 times, every failure Guard A's "generate_image ran and ended in ERROR"). The provider, its receipt check and JPEG conversion run for real on a temporary shared workspace root; every refusal the bot double answers with is written by the REAL Guard A (any-bot's agy-image-turn.js, collectImageTurnOutput over a stream-json built here) and handed back as the node's handler and client leave it ("Bot node execution failed: Antigravity CLI error: <refusal>"), so the wording the provider matches is the bot's own. The executor is the double (the bot node, outside the boundary); the real chain with a real agy child is crossed in storyboard-antigravity-image-turn.spec.ts. Fake timers (setTimeout and Date only) measure every wait exactly. Pins: a Guard A ERROR is retried as a fresh turn (own task id <id>-a2/-a3, own workspace, anchor staged again) after about 3 s then 8 s, at most three attempts; Guard A's [backoff] category waits about 20 s then 45 s; jitter adds at most 20 %; never-ran, did-not-finish, DONE with no brain, a missing output, a refusal before dispatch, a dispatch timeout and Guard A's words anywhere but the end of the bot's own words are never retried and keep their error exactly; the untrusted diagnostic decides nothing (a never-ran refusal whose reply spells the ERROR words and [backoff] is not retried; an ERROR whose reply carries throttle words keeps the short waits); no attempt starts that cannot finish in the render's deadline (120 s by default, the caller's deadlineMs when given) and each request carries that start-by time; a render the bot never started is "image renders are busy"; every attempt is logged with attempt n/3, its category, its wait and its outcome.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ entries: [] as Array<{ level: string; module: string; fields: Record<string, unknown>; msg: string }> }));
vi.mock('@/shared/logger', async (importOriginal) => {
  const recorder = (bindings: { module?: string } = {}): Record<string, unknown> => {
    const at = (level: string) => (fields: Record<string, unknown>, msg: string): void => {
      logged.entries.push({ level, module: String(bindings.module ?? ''), fields, msg });
    };
    const log: Record<string, unknown> = { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug'), trace: at('trace'), fatal: at('fatal') };
    log.child = () => log;
    return log;
  };
  return { ...(await importOriginal<Record<string, unknown>>()), createChildLogger: recorder };
});

import { createAntigravityCliImageProvider } from '../../src/features/video-generation/services/storyboard-antigravity-image-provider';
import { registerCliStoryboardImageExecutor, type CliStoryboardRenderRequest, type CliStoryboardRenderResult } from '../../src/features/video-generation/services/storyboard-cli-image-executor';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const agyImageTurn = require('../../any-bot/server/services/codebase/agy-image-turn') as {
  collectImageTurnOutput: (turn: { home: string; workspaceDir: string; stdout: string; startedAtMs: number; reply?: string }) => { ok: boolean; reason?: string };
};

const OWNER = 'operator-sub';
const PREFIX = 'antigravity-cli image provider: render task failed — ';
const MARKER = ' | untrusted diagnostic: ';
const ENV_KEYS = ['OSHAL_WORKSPACE_ROOT'] as const;

/** One scripted answer of the bot node per attempt: an image, busy, or an error as it leaves the node. */
type Answer = 'image' | 'no-output' | 'busy' | { error: string };
interface Call { request: CliStoryboardRenderRequest; at: number; anchorStaged: boolean }

let scratch: string;
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-agy-retry-'));
  root = path.join(scratch, 'workspaces');
  fs.mkdirSync(root);
  process.env.OSHAL_WORKSPACE_ROOT = root;
  logged.entries.length = 0;
  registerCliStoryboardImageExecutor(null);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  registerCliStoryboardImageExecutor(null);
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A refusal exactly as the REAL Guard A writes it, over a stream of generate_image step updates and the model's reply. */
function guardA(steps: Array<Record<string, unknown>>, reply: string): string {
  const home = fs.mkdtempSync(path.join(scratch, 'home-'));
  const workspaceDir = fs.mkdtempSync(path.join(scratch, 'turn-'));
  const stdout = steps.map((step) => JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'generate_image', ...step } })).join('\n');
  const outcome = agyImageTurn.collectImageTurnOutput({ home, workspaceDir, stdout, startedAtMs: Date.now(), reply });
  expect(outcome.ok, 'Guard A refuses this turn').toBe(false);
  return String(outcome.reason);
}

const errorSteps = (error: Record<string, string> = { type: 'TOOL_ERROR', message: 'no image generated in response' }) =>
  [{ state: 'ACTIVE' }, { state: 'ERROR', tool_info: { name: 'generate_image', error } }];
/** The 2026-10-03 shape: generate_image answered TOOL_ERROR, then the model replied NO_IMAGE_CAPABILITY. */
const ERROR = (): string => guardA(errorSteps(), 'NO_IMAGE_CAPABILITY');
/** The same with a quota in the image tool's own error: Guard A's [backoff] category. */
const QUOTA = (): string => guardA(errorSteps({ type: 'RESOURCE_EXHAUSTED', message: 'quota exceeded for image generation' }), 'NO_IMAGE_CAPABILITY');
/** How the bot node's answer reaches the executor: the client's words, the Antigravity provider's, then Guard A's refusal. */
const leftNode = (refusal: string): { error: string } => ({ error: `Bot node execution failed: Antigravity CLI error: ${refusal}` });
/** The provider's message for that answer: its own prefix and the bot's own words, never the diagnostic. */
const messageFor = (refusal: string): string => `${PREFIX}Bot node execution failed: Antigravity CLI error: ${refusal.slice(0, refusal.indexOf(MARKER))}`;
const diagnosticOf = (refusal: string): string => refusal.slice(refusal.indexOf(MARKER) + MARKER.length);

/** The bot's part of a rendered attempt, as agy-image-turn.js leaves it: the tool's JPEG and its receipt. */
async function leaveImage(dir: string): Promise<CliStoryboardRenderResult> {
  const jpeg = await sharp({ create: { width: 96, height: 80, channels: 3, background: { r: 16, g: 64, b: 224 } } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(dir, 'output.jpg'), jpeg);
  fs.writeFileSync(path.join(dir, 'output.image-turn.json'), JSON.stringify({ tool: 'generate_image', toolState: 'DONE', file: 'output.jpg',
    mimeType: 'image/jpeg', bytes: jpeg.length, sha256: createHash('sha256').update(jpeg).digest('hex'), locator: 'step-output' }));
  return { success: true, responseText: 'RENDERED', model: 'gemini-3.8-flash-low', provider: 'antigravity-cli', providerConfigAction: 'match' };
}

/** The bot node double: answers each attempt in turn (the last answer repeats), each attempt taking `attemptMs` of fake time. */
function botAnswers(answers: Answer[], attemptMs = 0): Call[] {
  const calls: Call[] = [];
  registerCliStoryboardImageExecutor(async (request) => {
    const dir = path.join(root, request.workspaceFolderId);
    calls.push({ request, at: Date.now(), anchorStaged: fs.existsSync(path.join(dir, 'anchor.png')) });
    if (attemptMs) await new Promise((resolve) => { setTimeout(resolve, attemptMs); });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer === 'image') return leaveImage(dir);
    if (answer === 'no-output') return { success: true, responseText: 'RENDERED', model: 'gemini-3.8-flash-low', provider: 'antigravity-cli', providerConfigAction: 'match' };
    if (answer === 'busy') return { success: false, busy: true, responseText: '', error: 'general-bot was still rendering another image when this render had to start; nothing was dispatched' };
    return { success: false, responseText: '', error: answer.error };
  });
  return calls;
}

/** Settle a render under fake timers: real I/O runs between the turns, fake time moves only to the next pending timer. */
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

type RenderError = Error & { diagnostic?: string };
const anchor = (): Promise<Buffer> => sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
const render = async (options: Parameters<typeof createAntigravityCliImageProvider>[1] = {}) =>
  createAntigravityCliImageProvider(OWNER, options).generateWithMeta!('make the circle blue', await anchor());
const refused = async (options: Parameters<typeof createAntigravityCliImageProvider>[1] = {}): Promise<RenderError | null> =>
  drive(render(options)).then(() => null, (error: RenderError) => error);
const gaps = (calls: Call[]): number[] => calls.slice(1).map((call, index) => call.at - calls[index].at);
const attemptLogs = () => logged.entries.filter((entry) => entry.module === 'storyboard-antigravity-image-provider' && entry.msg === 'antigravity-cli render attempt failed').map((entry) => entry.fields);

describe('antigravity-cli renders retry a generate_image ERROR as fresh turns (operator decision 2026-10-03)', () => {
  it('a Guard A ERROR runs again as a fresh turn after about 3 s, and the second attempt\'s image comes back', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const calls = botAnswers([leftNode(ERROR()), 'image']);

    const result = await drive(render());

    expect(calls).toHaveLength(2);
    expect(gaps(calls)).toEqual([3_000]);
    expect(result.cliRender).toMatchObject({ taskId: `${calls[0].request.taskId}-a2`, attempt: 2, tool: 'generate_image', toolState: 'DONE', ranOn: 'antigravity-cli' });
    expect((await sharp(result.image).metadata()).format).toBe('png');
  });

  it('three Guard A ERRORs make three attempts and no more, after 3 s then 8 s, each a fresh turn in its own workspace', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const refusal = ERROR();
    const calls = botAnswers([leftNode(refusal)]);

    const err = await refused();

    expect(calls).toHaveLength(3);
    expect(gaps(calls)).toEqual([3_000, 8_000]);
    const [first, second, third] = calls.map((call) => call.request.taskId);
    expect(first).toMatch(/^sbimg-[0-9a-f-]{36}$/);
    expect([second, third]).toEqual([`${first}-a2`, `${first}-a3`]);
    for (const call of calls) {
      expect(call.request.workspaceFolderId).toBe(call.request.taskId);
      expect(call.anchorStaged, `${call.request.taskId} has its own staged anchor`).toBe(true);
      expect(call.request.prompt).toContain(`ImagePaths = ${JSON.stringify([path.join(root, call.request.taskId, 'anchor.png')])}`);
      expect(call.request.brief).toBe('make the circle blue');
    }
    expect(err?.message).toBe(`${messageFor(refusal)} — render retries exhausted: all 3 attempts failed`);
    expect(err?.diagnostic).toBe(diagnosticOf(refusal));
  });

  it('Guard A\'s [backoff] category (a quota in the image tool\'s own error) waits about 20 s, then about 45 s', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const refusal = QUOTA();
    expect(refusal, 'Guard A states the category in its own words, ahead of the diagnostic').toContain('ran and ended in ERROR [backoff] | untrusted diagnostic: ');
    const calls = botAnswers([leftNode(refusal)]);

    const err = await refused();

    expect(calls).toHaveLength(3);
    expect(gaps(calls)).toEqual([22_000, 49_500]);
    expect(err?.message).toBe(`${messageFor(refusal)} — render retries exhausted: all 3 attempts failed`);
  });

  it('jitter adds at most a fifth of each wait', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const calls = botAnswers([leftNode(ERROR())]);
    await refused();
    expect(gaps(calls)).toEqual([3_599, 9_599]);
  });
});

describe('only Guard A\'s ERROR is retried, and only its own words decide', () => {
  const ownRefusal = (): string => 'general-bot runs claude-code, which cannot make images; give that bot an image-capable harness, or set STORYBOARD_IMAGE_PROVIDER to an image API';
  it.each([
    ['generate_image never ran', () => leftNode(guardA([], 'RENDERED'))],
    ['generate_image ran but did not finish', () => leftNode(guardA([{ state: 'ACTIVE' }], 'RENDERED'))],
    ['generate_image reached DONE with no brain directory', () => leftNode(guardA([{ state: 'ACTIVE' }, { state: 'DONE' }], 'RENDERED'))],
    ['a refusal before dispatch', () => ({ error: ownRefusal() })],
    ['a dispatch that timed out', () => ({ error: 'Bot node execution timed out after 420000ms for agent a0000000-0000-0000-0000-000000000099' })],
    ['Guard A\'s ERROR words followed by other words of the bot', () => ({ error: `Bot node execution failed: Antigravity CLI error: ${ERROR().replace(MARKER, ' (then the bot wrote more)' + MARKER)}` })],
  ])('%s: one attempt, and the error is exactly the provider\'s as before', async (_label, answer) => {
    const said = answer();
    const calls = botAnswers([said, 'image']);
    const err = await refused();
    expect(calls).toHaveLength(1);
    const at = said.error.indexOf(MARKER);
    expect(err?.message).toBe(`${PREFIX}${(at < 0 ? said.error : said.error.slice(0, at)).slice(0, 300)}`);
    expect(attemptLogs()).toEqual([expect.objectContaining({ attempt: '1/3', category: 'never-retried', waitMs: null, outcome: 'not-retried' })]);
  });

  it('a render that completed without handing back an output is not retried', async () => {
    const calls = botAnswers(['no-output', 'image']);
    const err = await refused();
    expect(calls).toHaveLength(1);
    expect(err?.message).toBe('antigravity-cli image provider: the render task completed without handing back a generate_image output');
  });

  it('the untrusted diagnostic decides nothing: a never-ran refusal whose reply spells the ERROR words is not retried', async () => {
    const spelled = 'image turn refused: the event stream shows no generate_image tool step that reached DONE: generate_image ran and ended in ERROR [backoff]';
    const refusal = guardA([], spelled);
    expect(diagnosticOf(refusal)).toContain(spelled.slice(0, 150));
    const calls = botAnswers([leftNode(refusal), 'image']);
    const err = await refused();
    expect(calls).toHaveLength(1);
    expect(err?.message).toBe(messageFor(refusal));
  });

  it('the untrusted diagnostic decides nothing: an ERROR whose model reply reads as a throttle keeps the short waits', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const refusal = guardA(errorSteps(), '429 Too Many Requests: quota exceeded [backoff]');
    expect(refusal).not.toContain('ERROR [backoff] |');
    const calls = botAnswers([leftNode(refusal)]);
    await refused();
    expect(gaps(calls)).toEqual([3_000, 8_000]);
  });
});

describe('the whole render stays inside the caller\'s deadline', () => {
  it('no attempt starts that cannot finish in budget: with 40 s attempts and the 120 s default, the third is never started', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const refusal = ERROR();
    const started = Date.now();
    const calls = botAnswers([leftNode(refusal)], 40_000);

    const err = await refused();

    expect(calls).toHaveLength(2);
    expect(Date.now() - started, 'the render stopped when attempt 2 failed, without taking the 8 s wait').toBe(83_000);
    expect(err?.message).toBe(`${messageFor(refusal)} — render retries exhausted: the render's deadline leaves no time for attempt 3 of 3`);
    // Each request carries the latest moment its turn may begin: the deadline less the time one attempt needs.
    expect(calls.map((call) => call.request.startBy)).toEqual([started + 90_000, started + 80_000]);
    for (const call of calls) expect(call.at).toBeLessThanOrEqual(call.request.startBy!);
    expect(attemptLogs().map((log) => [log.attempt, log.category, log.waitMs, log.outcome])).toEqual([['1/3', 'error', 3_000, 'retrying'], ['2/3', 'error', null, 'deadline']]);
  });

  it('a [backoff] wait that would end past the deadline is not waited out', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const started = Date.now();
    const calls = botAnswers([leftNode(QUOTA())], 15_000);
    const err = await refused();
    expect(calls).toHaveLength(2);
    expect(gaps(calls)).toEqual([35_000]);
    expect(Date.now() - started).toBe(50_000);
    expect(err?.message).toMatch(/ — render retries exhausted: the render's deadline leaves no time for attempt 3 of 3$/);
  });

  it('a caller\'s deadlineMs replaces the 120 s default: the frame stage and the Test Lab card hold a render to the 420 s CLI budget', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const started = Date.now();
    const calls = botAnswers([leftNode(ERROR())], 40_000);
    await refused({ deadlineMs: 420_000 });
    expect(calls).toHaveLength(3);
    expect(calls[0].request.startBy).toBe(started + 390_000);
  });

  it('image renders are busy: an attempt the render bot never started fails clearly and is not retried', async () => {
    const calls = botAnswers(['busy', 'image']);
    const err = await refused();
    expect(calls).toHaveLength(1);
    expect(err?.message).toBe('antigravity-cli image provider: image renders are busy: the render bot was still rendering other images when attempt 1 of 3 had to start to finish within this render\'s deadline');
  });

  it('a retry the render bot never started ends the render with the last failure and says the renders were busy', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const refusal = ERROR();
    const calls = botAnswers([leftNode(refusal), 'busy', 'image']);
    const err = await refused();
    expect(calls).toHaveLength(2);
    expect(err?.message).toBe(`${messageFor(refusal)} — render retries exhausted: image renders are busy: the render bot was still rendering other images when attempt 2 of 3 had to start to finish within this render's deadline`);
    expect(err?.diagnostic).toBe(diagnosticOf(refusal));
  });
});

describe('every attempt is logged', () => {
  it('attempt n/3, its category, its wait and its outcome; the rendered attempt names itself', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    botAnswers([leftNode(QUOTA()), leftNode(ERROR()), 'image']);
    const result = await drive(render({ deadlineMs: 420_000 }));
    expect(result.cliRender?.attempt).toBe(3);
    expect(attemptLogs().map((log) => [log.attempt, log.category, log.waitMs, log.outcome])).toEqual([['1/3', 'backoff', 20_000, 'retrying'], ['2/3', 'error', 8_000, 'retrying']]);
    const rendered = logged.entries.find((entry) => entry.msg === 'antigravity-cli storyboard frame rendered');
    expect(rendered?.fields).toMatchObject({ attempt: '3/3', taskId: result.cliRender?.taskId });
  });
});
