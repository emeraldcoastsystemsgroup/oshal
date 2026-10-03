/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the antigravity-cli render retry (operator decision 2026-10-03: "Retry, max 3, fresh turns"; the 04:41-04:47 UTC measured run rendered the storyboard card 4 of 10 times, every failure Guard A's "generate_image ran and ended in ERROR"). The provider, its receipt check and JPEG conversion run for real on a temporary shared workspace root; every refusal the bot double answers with is written by the REAL Guard A (any-bot's agy-image-turn.js, collectImageTurnOutput over a stream-json built here) and handed back as the node's handler and client leave it ("Bot node execution failed: Antigravity CLI error: <refusal>"), so the wording the provider matches is the bot's own. The executor is the double (the bot node, outside the boundary); the real chain with a real agy child is crossed in storyboard-antigravity-image-turn.spec.ts. Fake timers (setTimeout and Date only) measure every wait exactly. Pins: a Guard A ERROR is retried as a fresh turn (own task id <id>-a2/-a3, own workspace, anchor staged again) after about 3 s then 8 s, at most three attempts; Guard A's [backoff] category waits about 20 s then 45 s; jitter adds at most 20 %; never-ran, did-not-finish, DONE with no brain, a missing output, a refusal before dispatch, a dispatch timeout and Guard A's words anywhere but the end of the bot's own words are never retried and keep their error exactly; the untrusted diagnostic decides nothing (a never-ran refusal whose reply spells the ERROR words and [backoff] is not retried; an ERROR whose reply carries throttle words keeps the short waits); no attempt starts that cannot finish in the render's deadline (120 s by default, the caller's deadlineMs when given) and each request carries that start-by time; a render the bot never started is "image renders are busy"; every attempt is logged with attempt n/3, its category, its wait and its outcome.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Verifier finding on core PR #1033: retries stacked. A retry attempt that failed with something other than Guard A's ERROR (a bot-node 500, a dispatch timeout) led the thrown message with its own words, so the storyboard frame stage and Portrait Studio re-ran the whole render: the verifier's probe (Guard A's ERROR, then a bot-node 500, alternating) made one frame run 10 image turns through the REAL generateStoryboardFrame. The probe is now a regression, with fake timers carrying the stage's own 8 s backoff: once a render has retried, one frame makes at most three turns and the stage never backs off; the stage still retries a first attempt that failed transiently, as before. Every stop message the provider throws (retries exhausted, the deadline, a retry that failed in a way never retried, renders busy; plain and [backoff]; failing retries whose own text carries every transient word) is driven out of the real provider and checked against the frame stage's REAL pattern (STORYBOARD_FRAME_TRANSIENT_ERROR, imported) and Portrait Studio's isTransientVendorError (store code, not importable from core: a verbatim copy pinned by the sha256 of the store source, from which its patterns are read). Stop messages are now Guard A's fixed words plus the provider's note. The default deadline is 90 s (the callers' 120 s less one attempt): a render whose every attempt starts as late as it may and runs twice its reserve still ends before 120 s.
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
import { generateStoryboardFrame, STORYBOARD_FRAME_TRANSIENT_ERROR } from '../../src/features/video-generation/services/storyboard-frames';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const agyImageTurn = require('../../any-bot/server/services/codebase/agy-image-turn') as {
  collectImageTurnOutput: (turn: { home: string; workspaceDir: string; stdout: string; startedAtMs: number; reply?: string }) => { ok: boolean; reason?: string };
};

const OWNER = 'operator-sub';
const PREFIX = 'antigravity-cli image provider: render task failed — ';
const MARKER = ' | untrusted diagnostic: ';
const ENV_KEYS = ['OSHAL_WORKSPACE_ROOT'] as const;
/** Guard A's fixed words for a generate_image step that ran and ended in ERROR. */
const ERROR_WORDS = 'image turn refused: the event stream shows no generate_image tool step that reached DONE: generate_image ran and ended in ERROR';
/** The provider's own words when a render's retries end: Guard A's fixed ERROR words (and [backoff]), then the note. */
const stopMessage = (note: string, backoff = false): string => `${PREFIX}${ERROR_WORDS}${backoff ? ' [backoff]' : ''} — ${note}`;
/** Failures a retry attempt may end in whose own words carry every word the callers' retry classifiers read as transient. */
const BOT_500 = 'Bot node returned 500: {"success":false,"response":""}';
const TIMED_OUT = 'Bot node execution timed out after 420000ms for agent a0000000-0000-0000-0000-000000000099';
const NETWORK = 'fetch failed: ECONNRESET socket hang up on the network (ETIMEDOUT, ECONNREFUSED, ENOTFOUND, EAI_AGAIN, abort)';
const THROTTLED = 'HTTP 429 RATE_LIMITED: EMPTY_RESPONSE from the image endpoint after HTTP 503';

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
    // The provider's own words only: Guard A's fixed ERROR words and the note, never an attempt's own text.
    expect(err?.message).toBe(stopMessage('render retries exhausted: all 3 attempts failed'));
    expect(err?.diagnostic).toBe(diagnosticOf(refusal));
  });

  it('Guard A\'s [backoff] category (a quota in the image tool\'s own error) waits about 20 s, then about 45 s (inside the frame stage\'s 420 s budget)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const refusal = QUOTA();
    expect(refusal, 'Guard A states the category in its own words, ahead of the diagnostic').toContain('ran and ended in ERROR [backoff] | untrusted diagnostic: ');
    const calls = botAnswers([leftNode(refusal)]);

    const err = await refused({ deadlineMs: 420_000 });

    expect(calls).toHaveLength(3);
    expect(gaps(calls)).toEqual([22_000, 49_500]);
    expect(err?.message).toBe(stopMessage('render retries exhausted: all 3 attempts failed', true));
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
  it('no attempt starts that cannot finish in budget: with 40 s attempts and the 90 s default, the third is never started', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const refusal = ERROR();
    const started = Date.now();
    const calls = botAnswers([leftNode(refusal)], 40_000);

    const err = await refused();

    expect(calls).toHaveLength(2);
    expect(Date.now() - started, 'the render stopped when attempt 2 failed, without taking the 8 s wait').toBe(83_000);
    expect(err?.message).toBe(stopMessage('render retries exhausted: the render\'s deadline leaves no time for attempt 3 of 3'));
    // Each request carries the latest moment its turn may begin: the 90 s deadline less the time one attempt needs.
    expect(calls.map((call) => call.request.startBy)).toEqual([started + 60_000, started + 50_000]);
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

  it('a caller\'s deadlineMs replaces the 90 s default: the frame stage and the Test Lab card hold a render to the 420 s CLI budget', async () => {
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
    expect(err?.message).toBe(stopMessage('render retries exhausted: image renders are busy: the render bot was still rendering other images when attempt 2 of 3 had to start to finish within this render\'s deadline'));
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

describe('one storyboard frame never re-runs a render the provider retried (verifier probe, core PR #1033)', () => {
  const frame = (): Promise<Error | null> => generateStoryboardFrame({ n: 1, camera: 'WIDE: a red circle on white' },
    { styleLock: 'flat colour', cast: [], provider: createAntigravityCliImageProvider(OWNER, { deadlineMs: 420_000 }) }, null).then(() => null, (e: Error) => e);
  const stageBackoffs = () => logged.entries.filter((entry) => entry.module === 'storyboard-frames' && entry.msg === 'storyboard frame transient failure — backing off');
  /** The verifier's scripted bot node: every odd dispatch Guard A's ERROR, every even one the bot route's 500. */
  const alternating = (): Answer[] => Array.from({ length: 15 }, (_unused, index) => (index % 2 ? { error: BOT_500 } : leftNode(ERROR())));

  it.each([
    ['Guard A\'s ERROR, then a bot-node 500, alternating (the verifier\'s probe)', alternating, 2, false],
    ['Guard A\'s ERROR, then a dispatch that timed out', (): Answer[] => [leftNode(ERROR()), { error: TIMED_OUT }], 2, false],
    ['two ERRORs, then a network failure', (): Answer[] => [leftNode(ERROR()), leftNode(ERROR()), { error: NETWORK }], 3, false],
    ['a [backoff] ERROR, then a throttled image endpoint', (): Answer[] => [leftNode(QUOTA()), { error: THROTTLED }], 2, true],
  ])('%s: at most three image turns, and the stage never backs off', async (_label, answers, turns, backoff) => {
    const calls = botAnswers(answers());
    const err = await drive(frame());
    expect(calls.length, `image turns for one frame (final error: ${err?.message})`).toBeLessThanOrEqual(3);
    expect(calls).toHaveLength(turns);
    expect(stageBackoffs(), 'the frame stage never re-runs a render the provider retried').toEqual([]);
    expect(err?.message).toBe(`storyboard frame 1 (antigravity-cli): ${stopMessage(`render retries stopped: attempt ${turns} of 3 failed in a way that is never retried`, backoff)}`);
  });

  it('the stage still retries a first attempt that failed transiently, as before; the render after it that retried ends the stage', async () => {
    const calls = botAnswers([{ error: BOT_500 }, leftNode(ERROR())]);
    const err = await drive(frame());
    // One stage retry of a single-turn render that never retried, then one render of three fresh turns.
    expect(calls).toHaveLength(4);
    expect(stageBackoffs()).toHaveLength(1);
    expect(err?.message).toBe(`storyboard frame 1 (antigravity-cli): ${stopMessage('render retries exhausted: all 3 attempts failed')}`);
  });
});

describe('the default deadline leaves the callers\' own 120 s timeout one attempt of headroom', () => {
  /** A busy render bot: an attempt begins only at its latest start, then runs 59 s (twice the 30 s reserve, less a second) and ends in Guard A's ERROR. */
  function lateSlowBot(refusal: { error: string }, fastFirst: boolean): Call[] {
    const calls: Call[] = [];
    registerCliStoryboardImageExecutor(async (request) => {
      calls.push({ request, at: Date.now(), anchorStaged: true });
      if (!(fastFirst && calls.length === 1)) {
        await new Promise((resolve) => { setTimeout(resolve, Math.max(0, request.startBy! - Date.now()) + 59_000); });
      }
      return { success: false, responseText: '', error: refusal.error };
    });
    return calls;
  }

  it.each([
    ['a first attempt', false, 1, 60_000],
    ['a retry', true, 2, 60_000],
  ])('%s that starts as late as it may and runs twice its reserve still ends before Create\'s and Portrait\'s own 120 s', async (_label, fastFirst, attempts, latestStart) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const started = Date.now();
    const calls = lateSlowBot(leftNode(ERROR()), fastFirst);
    const err = await refused();
    expect(calls).toHaveLength(attempts);
    expect(calls[attempts - 1].request.startBy, 'the 90 s default deadline less one attempt\'s 30 s').toBe(started + latestStart);
    expect(Date.now() - started, 'the render settled before the callers\' own timeout fires').toBeLessThan(120_000);
    expect(err?.message).toBe(stopMessage(`render retries exhausted: the render's deadline leaves no time for attempt ${attempts + 1} of 3`));
  });
});

/**
 * Portrait Studio's own retry classifier, isTransientVendorError, exactly as the store ships it
 * (portrait-studio/src-routes/portrait-ops.ts, store main 25c87a29). Store code is not importable from
 * core, so it is copied verbatim and pinned: PORTRAIT_CLASSIFIER_SHA256 is the sha256 of that store
 * source text, and the patterns below are read out of this pinned copy, never retyped.
 */
const PORTRAIT_CLASSIFIER_SOURCE = String.raw`export function isTransientVendorError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/RATE_LIMITED/.test(msg)) return true;
  if (/HTTP 5\d\d/.test(msg)) return true;
  if (/HTTP 429/.test(msg)) return true;
  if (/(fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|abort|timed out)/i.test(msg)) return true;
  return false;
}`;
const PORTRAIT_CLASSIFIER_SHA256 = '6930b59c331b49e88128b5aeeadf5d8b9c6c97b1fbd7fb0048fcad30a2627cd0';
const PORTRAIT_TRANSIENT = [...PORTRAIT_CLASSIFIER_SOURCE.matchAll(/if \(\/(.+)\/([a-z]*)\.test\(msg\)\) return true;/g)]
  .map(([, source, flags]) => new RegExp(source, flags));
const portraitRetries = (message: string): boolean => PORTRAIT_TRANSIENT.some((pattern) => pattern.test(message));

describe('no stop message the provider throws reads as transient to the frame stage or to Portrait Studio', () => {
  it('the frame stage\'s pattern is its real one, Portrait\'s is the store\'s pinned text, and both catch what they exist to catch', () => {
    expect(createHash('sha256').update(PORTRAIT_CLASSIFIER_SOURCE).digest('hex'), 'the copy is the store source, byte for byte').toBe(PORTRAIT_CLASSIFIER_SHA256);
    expect(PORTRAIT_TRANSIENT).toHaveLength(4);
    // So that a clean result below is not a blind one.
    for (const transient of [BOT_500, THROTTLED]) expect(STORYBOARD_FRAME_TRANSIENT_ERROR.test(transient), transient).toBe(true);
    for (const transient of [TIMED_OUT, NETWORK, THROTTLED]) expect(portraitRetries(transient), transient).toBe(true);
  });

  const STOPS: Array<[string, () => Answer[], number, { deadlineMs?: number }]> = [
    ['all three attempts failed', () => [leftNode(ERROR())], 0, {}],
    ['all three [backoff] attempts failed', () => [leftNode(QUOTA())], 0, { deadlineMs: 420_000 }],
    ['the deadline left no time for attempt 2', () => [leftNode(ERROR())], 0, { deadlineMs: 20_000 }],
    ['the deadline left no time for a [backoff] attempt 3', () => [leftNode(QUOTA())], 15_000, {}],
    ['a retry hit a bot-node 500', () => [leftNode(ERROR()), { error: BOT_500 }], 0, {}],
    ['a retry timed out', () => [leftNode(ERROR()), { error: TIMED_OUT }], 0, {}],
    ['the last retry failed on the network', () => [leftNode(ERROR()), leftNode(ERROR()), { error: NETWORK }], 0, {}],
    ['a [backoff] retry was throttled', () => [leftNode(QUOTA()), { error: THROTTLED }], 0, { deadlineMs: 420_000 }],
    ['a retry handed back no output', () => [leftNode(ERROR()), 'no-output'], 0, {}],
    ['a retry\'s generate_image never ran', () => [leftNode(ERROR()), leftNode(guardA([], 'RENDERED'))], 0, {}],
    ['renders were busy at attempt 1', () => ['busy'], 0, {}],
    ['renders were busy at the retry', () => [leftNode(ERROR()), 'busy'], 0, {}],
    ['renders were busy at the last retry', () => [leftNode(QUOTA()), leftNode(ERROR()), 'busy'], 0, { deadlineMs: 420_000 }],
  ];
  it.each(STOPS)('%s: the message carries only the provider\'s fixed words', async (_label, answers, attemptMs, options) => {
    botAnswers(answers(), attemptMs);
    const message = String((await refused(options))?.message);
    expect(message).toMatch(/^antigravity-cli image provider: (render task failed — image turn refused: |image renders are busy: )/);
    expect(STORYBOARD_FRAME_TRANSIENT_ERROR.test(message), `the frame stage would re-run the render: ${message}`).toBe(false);
    expect(portraitRetries(message), `Portrait Studio would re-run the render: ${message}`).toBe(false);
  });
});
