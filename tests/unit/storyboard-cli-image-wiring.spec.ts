/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-130 codex-cli render WIRING (the half storyboard-codex-cli-provider.spec.ts doubles). Pins that the boot-registered executor dispatches the render with providerId 'openai-codex' as its ADR-034 carried record, and — running the REAL bot-side parse + reconcile over the captured request — that a render bot parked on another harness (the demo box's claude-code fleet-default row) is switched onto codex before the spawn, while the unstamped legacy shape leaves the runtime untouched, which is exactly how the live storyboard died with NO_IMAGE_CAPABILITY on 2026-09-21. Also pins the bot/timeout knobs, the userSub threading, and that a bot failure is surfaced (never thrown). BotNodeClient is the double: it is the HTTP hop to the node; the request it is handed is the boundary under test.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-130 amendment 2026-10-02, the bot-level rule: entry 1's fixed codex stamp and its "switched onto codex" case are gone, because a render must never move the render bot off its own setting. The executor now reads the render bot's canonical provider record through the REAL canonical resolver (the swarm extension's createAgentConfigRuntimeParamsResolver over the REAL ProviderSwitchSnapshot and registry readers; tests/fixtures/storyboard-render-bot-switch.ts) and stamps exactly that record with an empty fallback chain. Through the REAL bot-side parseCarriedDispatchConfig + reconcileDispatchProviderConfig, a bot on antigravity-cli (fleet default) and a bot whose own row says openai-codex (while the fleet says antigravity-cli) each reconcile as 'match' with no setActiveProvider call. Refused before any dispatch, naming the bot and the harness: a bot on claude-code (row or fleet), a bot with no record, an unread snapshot, a process with no resolver, and a rail other than the bot's own (STORYBOARD_IMAGE_PROVIDER naming the other CLI rail, or the bot switched since the rail was chosen). The empty chain makes the REAL post-execution check refuse a turn that ran on the fleet row's fallback rung. Boot registers the render-bot reader the selection follows; the knobs, the imageTurn hop and the refusal/throw surfacing are kept.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 carve for image turns (operator decision 2026-10-02 b): the dispatch sends the request's `brief` as the bot's `text` and its server-authored `prompt` as `renderInstruction`; the fixture request carries both.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Throttle image renders (operator decision 2026-10-03): through the real wiring, two concurrent renders reach the bot one at a time in arrival order (the hop double can hold an image turn open and counts the turns in flight); a render still waiting at its startBy is answered success:false, busy:true with nothing dispatched, and the queue moves on to the next render; a text turn to the same bot is delivered while an image turn holds it, because the queue sits in the image executor and not in the bot-node client. The dispatch budget knob is read through cliStoryboardRenderBudgetMs; a value that is not a positive number falls back to 420 s.
 */

import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  constructed: [] as Array<{ resolver: unknown; timeoutMs: number | undefined }>,
  executions: [] as Array<{ agentId: string; request: Record<string, unknown> }>,
  behaviour: { mode: 'ok' as 'ok' | 'refuse' | 'throw' | 'hold' },
  /** Image turns the hop holds open until the case releases them, and how many were open at once. */
  held: [] as Array<() => void>,
  inFlight: { now: 0, most: 0 },
}));

const RESOLVER_TOKEN = vi.hoisted(() => ({ kind: 'registry-endpoint-resolver' }));

vi.mock('@/features/agent-management', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  BotNodeClient: class {
    constructor(resolver: unknown, timeoutMs?: number) {
      captured.constructed.push({ resolver, timeoutMs });
    }
    async execute(agentId: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
      captured.executions.push({ agentId, request });
      if (captured.behaviour.mode === 'hold' && request.imageTurn === true) {
        captured.inFlight.now += 1;
        captured.inFlight.most = Math.max(captured.inFlight.most, captured.inFlight.now);
        await new Promise<void>((release) => { captured.held.push(release); });
        captured.inFlight.now -= 1;
      }
      if (captured.behaviour.mode === 'throw') throw new Error('Bot node execution timed out after 1ms for agent x');
      if (captured.behaviour.mode === 'refuse') {
        return { success: false, response: '', error: 'UNENFORCEABLE_CLI_TOOL_BOUNDARY: demo carve refused' };
      }
      return { success: true, response: 'RENDERED', model: 'gemini-3.8-flash-low', provider: String(request.providerId), providerConfigAction: 'match' };
    }
  },
  createRegistryEndpointResolver: () => RESOLVER_TOKEN,
}));

import { BotNodeClient } from '@/features/agent-management';
import { wireCliStoryboardImageExecutor, type CliStoryboardWiringDeps } from '../../src/app/storyboard-cli-image-wiring';
import { registerStoryboardRenderBotReader, selectStoryboardImageProvider } from '../../src/features/video-generation/services/storyboard-image-default';
import {
  dispatchConfigMatchesActive,
  parseCarriedDispatchConfig,
  reconcileDispatchProviderConfig,
  type DispatchConfigRuntime,
} from '../../src/app/bot-node-dispatch-config';
import type { ActiveBotNodeProvider } from '../../src/app/bot-node-llm-provider-route';
import {
  registerCliStoryboardImageExecutor,
  resolveCliStoryboardImageExecutor,
  type CliStoryboardRenderRequest,
} from '../../src/features/video-generation/services/storyboard-cli-image-executor';
import { clearRenderBotSwitch, installRenderBotSwitch, RENDER_BOT, switchRow } from '../fixtures/storyboard-render-bot-switch';

const ENV_KEYS = ['STORYBOARD_CLI_IMAGE_BOT_ID', 'STORYBOARD_CLI_IMAGE_TIMEOUT_MS', 'DEMO_MODE', 'STORYBOARD_IMAGE_PROVIDER'] as const;
const QUIET_LOG = { warn: () => undefined, debug: () => undefined };
const FLEET_AGY = switchRow('fleet-default', 'antigravity-cli', { modelId: 'gemini-3.8-flash-low', fallbackOrder: ['openai-codex'] });

const RENDER: CliStoryboardRenderRequest = {
  prompt: 'You are a headless image-rendering task. Call your generate_image tool exactly once.',
  brief: 'a red circle on white',
  taskId: 'sbimg-11111111-2222-4333-8444-555555555555',
  workspaceFolderId: 'sbimg-11111111-2222-4333-8444-555555555555',
  userSub: 'operator-sub-1',
  rail: 'antigravity-cli',
};

/** A bot-node runtime seam whose active provider is the given one; records every switch. */
function runtimeOn(provider: string, model: string): DispatchConfigRuntime & { switches: Array<[string, string | undefined]> } {
  let active: ActiveBotNodeProvider = { provider, model };
  const switches: Array<[string, string | undefined]> = [];
  return {
    switches,
    getActiveProvider: () => active,
    setActiveProvider: (next: string, nextModel?: string) => {
      switches.push([next, nextModel]);
      active = { provider: next, model: nextModel ?? model };
      return active;
    },
  };
}

/** Wire the executor over a real switch with the given rows and render once. */
async function renderWith(rows: Parameters<typeof installRenderBotSwitch>[0], request: CliStoryboardRenderRequest = RENDER, options?: Parameters<typeof installRenderBotSwitch>[1]) {
  const installed = await installRenderBotSwitch(rows, options);
  wireCliStoryboardImageExecutor({ runtimeParamsResolver: () => installed.resolver });
  const executor = resolveCliStoryboardImageExecutor();
  expect(executor, 'boot wiring must register the executor seam').not.toBeNull();
  return executor!(request);
}

/** The REAL bot half over the captured request: parse it, reconcile against the bot's live runtime. */
function reconcileOnBot(runtime: DispatchConfigRuntime) {
  const carried = parseCarriedDispatchConfig(captured.executions[0].request as Parameters<typeof parseCarriedDispatchConfig>[0]);
  return { carried, outcome: reconcileDispatchProviderConfig(carried, runtime, { taskId: RENDER.taskId }, QUIET_LOG) };
}

describe('storyboard render wiring: the render runs on the render bot\'s own harness (ADR-130, bot-level rule)', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    captured.constructed.length = 0;
    captured.executions.length = 0;
    captured.behaviour.mode = 'ok';
    captured.held.length = 0;
    captured.inFlight.now = 0;
    captured.inFlight.most = 0;
    registerCliStoryboardImageExecutor(null);
    registerStoryboardRenderBotReader(null);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    registerCliStoryboardImageExecutor(null);
    registerStoryboardRenderBotReader(null);
    clearRenderBotSwitch();
  });

  it('a bot on the antigravity fleet default is stamped with its own record, no fallback chain, and its reconcile is a match', async () => {
    const result = await renderWith([FLEET_AGY]);

    expect(result).toEqual({ success: true, responseText: 'RENDERED', model: 'gemini-3.8-flash-low', provider: 'antigravity-cli', providerConfigAction: 'match', error: undefined });
    expect(captured.executions).toHaveLength(1);
    const { agentId, request } = captured.executions[0];
    expect(agentId).toBe(RENDER_BOT);
    expect(request).toMatchObject({
      // SEC-05 carve for image turns: the brief is the untrusted text, the instruction its own carrier.
      text: RENDER.brief, renderInstruction: RENDER.prompt, taskId: RENDER.taskId, workspaceFolderId: RENDER.workspaceFolderId, agentId: RENDER_BOT,
      agenticMode: true, userSub: RENDER.userSub, imageTurn: true,
      providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low', providerConfigRequired: true, fallbackOrder: [],
    });

    const bot = runtimeOn('antigravity-cli', 'gemini-3.8-flash-low');
    const { carried, outcome } = reconcileOnBot(bot);
    expect(carried).toEqual({ providerId: 'antigravity-cli', model: 'gemini-3.8-flash-low', fallbackOrder: [] });
    expect(outcome.action).toBe('match');
    expect(bot.switches, 'the dispatch never changes the render bot\'s provider').toEqual([]);
  });

  it('the bot\'s own row overrides the fleet: a bot on codex while the fleet is antigravity renders codex-cli on codex, unswitched', async () => {
    const result = await renderWith([FLEET_AGY, switchRow(RENDER_BOT, 'openai-codex')], { ...RENDER, rail: 'codex-cli' });
    expect(result.success).toBe(true);
    expect(captured.executions[0].request).toMatchObject({ providerId: 'openai-codex', fallbackOrder: [] });
    expect(captured.executions[0].request).not.toHaveProperty('model');

    const bot = runtimeOn('openai-codex', 'gpt-5.5');
    expect(reconcileOnBot(bot).outcome.action).toBe('match');
    expect(bot.switches).toEqual([]);
  });

  it.each([
    ['the bot\'s own row', [FLEET_AGY, switchRow(RENDER_BOT, 'claude-code')]],
    ['the fleet default', [switchRow('fleet-default', 'claude-code')]],
  ])('a bot on claude-code by %s is refused naming the bot and harness, and nothing is dispatched', async (_label, rows) => {
    for (const rail of ['antigravity-cli', 'codex-cli'] as const) {
      const result = await renderWith(rows, { ...RENDER, rail });
      expect(result).toEqual({ success: false, responseText: '',
        error: 'general-bot runs claude-code, which cannot make images; give that bot an image-capable harness, or set STORYBOARD_IMAGE_PROVIDER to an image API' });
    }
    expect(captured.executions).toEqual([]);
  });

  it('a rail other than the bot\'s own is refused instead of switching the bot (an explicit codex-cli override on an antigravity bot)', async () => {
    const result = await renderWith([FLEET_AGY], { ...RENDER, rail: 'codex-cli' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('general-bot runs antigravity-cli, whose image rail is antigravity-cli, but this render was prepared for codex-cli; a render never switches the bot\'s harness — set STORYBOARD_IMAGE_PROVIDER to antigravity-cli or unset it, or give general-bot a harness for codex-cli');
    expect(captured.executions).toEqual([]);
  });

  it('a bot switched after the rail was chosen is refused at dispatch, read fresh from the snapshot', async () => {
    const installed = await installRenderBotSwitch([FLEET_AGY]);
    wireCliStoryboardImageExecutor({ runtimeParamsResolver: () => installed.resolver });
    process.env.DEMO_MODE = 'true';
    expect(await selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'antigravity-cli' });
    installed.rows.set(RENDER_BOT, switchRow(RENDER_BOT, 'codex-cli'));
    await installed.refresh();
    const result = await resolveCliStoryboardImageExecutor()!(RENDER);
    expect(result.error).toMatch(/^general-bot runs codex-cli, whose image rail is codex-cli, but this render was prepared for antigravity-cli/);
    expect(captured.executions).toEqual([]);
  });

  it('no record, an unread snapshot and a process without the resolver are each refused before any dispatch', async () => {
    const registryOnly = await renderWith([], RENDER);
    expect(registryOnly.error, 'no rows: the registry declares openai-codex, whose rail is codex-cli').toMatch(/^general-bot runs openai-codex, whose image rail is codex-cli/);
    process.env.STORYBOARD_CLI_IMAGE_BOT_ID = 'a0000000-0000-0000-0000-0000000000ff';
    const noRecord = await renderWith([FLEET_AGY], RENDER);
    expect(noRecord.error, 'a bot the registry does not know: the fleet default does not reach it').toBe('a0000000-0000-0000-0000-0000000000ff has no provider record (no bot row, fleet default or registry declaration)');
    delete process.env.STORYBOARD_CLI_IMAGE_BOT_ID;
    const unread = await renderWith([FLEET_AGY], RENDER, { loaded: false });
    expect(unread.error).toMatch(/^the provider of general-bot could not be read \(.*first successful read/);
    wireCliStoryboardImageExecutor({ runtimeParamsResolver: () => undefined });
    const noResolver = await resolveCliStoryboardImageExecutor()!(RENDER);
    expect(noResolver.error).toMatch(/could not be read \(this process has no runtime-params resolver/);
    expect(captured.executions).toEqual([]);
  });

  it('the empty fallback chain makes the real post-execution check refuse a turn that ran on the fleet row\'s fallback rung', async () => {
    await renderWith([FLEET_AGY]);
    const { carried } = reconcileOnBot(runtimeOn('antigravity-cli', 'gemini-3.8-flash-low'));
    expect(carried?.fallbackOrder).toEqual([]);
    expect(dispatchConfigMatchesActive(carried!, { provider: 'openai-codex', model: 'gpt-5.5' })).toBe(false);
    // With the fleet row's own chain carried, that fallback turn would have been accepted.
    expect(dispatchConfigMatchesActive({ ...carried!, fallbackOrder: ['openai-codex'] }, { provider: 'openai-codex', model: 'gpt-5.5' })).toBe(true);
  });

  it('boot registers the render-bot reader the image selection follows', async () => {
    process.env.DEMO_MODE = 'true';
    const installed = await installRenderBotSwitch([switchRow('fleet-default', 'openai-codex')]);
    const deps: CliStoryboardWiringDeps = { runtimeParamsResolver: () => installed.resolver };
    wireCliStoryboardImageExecutor(deps);
    expect(await selectStoryboardImageProvider()).toEqual({ ok: true, id: 'codex-cli', source: 'render-bot', renderBot: 'general-bot', harness: 'openai-codex' });
  });

  it('STORYBOARD_CLI_IMAGE_BOT_ID and _TIMEOUT_MS pick the render node and the dispatch deadline', async () => {
    process.env.STORYBOARD_CLI_IMAGE_BOT_ID = ' a0000000-0000-0000-0000-000000000042 ';
    process.env.STORYBOARD_CLI_IMAGE_TIMEOUT_MS = '90000';
    await renderWith([FLEET_AGY]);
    expect(captured.constructed).toEqual([{ resolver: RESOLVER_TOKEN, timeoutMs: 90_000 }]);
    expect(captured.executions[0].agentId).toBe('a0000000-0000-0000-0000-000000000042');
    expect(captured.executions[0].request).toMatchObject({ agentId: 'a0000000-0000-0000-0000-000000000042' });
  });

  it('defaults to general-bot and the 7-minute deadline when the knobs are unset', async () => {
    await renderWith([FLEET_AGY]);
    expect(captured.constructed).toEqual([{ resolver: RESOLVER_TOKEN, timeoutMs: 420_000 }]);
    expect(captured.executions[0].agentId).toBe(RENDER_BOT);
  });

  it('a dispatch deadline that is not a positive number falls back to 7 minutes', async () => {
    process.env.STORYBOARD_CLI_IMAGE_TIMEOUT_MS = '-5';
    await renderWith([FLEET_AGY]);
    expect(captured.constructed).toEqual([{ resolver: RESOLVER_TOKEN, timeoutMs: 420_000 }]);
  });

  it('the bot-node HTTP hop forwards only a literal-true imageTurn into the execution envelope', () => {
    const source = fs.readFileSync(new URL('../../src/app/bot-node-server.ts', import.meta.url), 'utf8');
    const routeStart = source.indexOf("app.post(\n    '/api/swarm-execute'");
    const route = source.slice(routeStart, source.indexOf("app.post('/api/token-chase/replay-call'", routeStart));
    expect(routeStart).toBeGreaterThan(-1);
    expect(route).toContain('...(body.imageTurn === true ? { imageTurn: true } : {}),');
    expect(route.indexOf('body.imageTurn === true')).toBeGreaterThan(route.indexOf('payload: {'));
  });

  it('a bot-side refusal rides through as success:false with its text, and a thrown dispatch is surfaced, never rethrown', async () => {
    captured.behaviour.mode = 'refuse';
    const refused = await renderWith([FLEET_AGY]);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('UNENFORCEABLE_CLI_TOOL_BOUNDARY');
    captured.behaviour.mode = 'throw';
    const failed = await renderWith([FLEET_AGY]);
    expect(failed).toEqual({ success: false, responseText: '', error: 'Bot node execution timed out after 1ms for agent x' });
  });

  describe('the render bot runs one image turn at a time (operator decision 2026-10-03, "Throttle image renders")', () => {
    const render = (taskId: string, startBy?: number): CliStoryboardRenderRequest => ({ ...RENDER, taskId, workspaceFolderId: taskId, ...(startBy === undefined ? {} : { startBy }) });
    const settle = (ms = 50): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

    /** The real wiring over the antigravity fleet default, with the hop holding every image turn open until released. */
    async function holdingExecutor() {
      captured.behaviour.mode = 'hold';
      const installed = await installRenderBotSwitch([FLEET_AGY]);
      wireCliStoryboardImageExecutor({ runtimeParamsResolver: () => installed.resolver });
      return resolveCliStoryboardImageExecutor()!;
    }

    it('two concurrent renders reach the bot one at a time, in arrival order, each on the bot\'s own record', async () => {
      const executor = await holdingExecutor();
      const first = executor(render('sbimg-first-render-0001'));
      const second = executor(render('sbimg-second-render-0002'));
      await vi.waitFor(() => expect(captured.executions).toHaveLength(1));
      await settle();
      expect(captured.executions.map((e) => e.request.taskId), 'the second render waits while the first holds the bot').toEqual(['sbimg-first-render-0001']);
      captured.held.shift()!();
      await vi.waitFor(() => expect(captured.executions).toHaveLength(2));
      expect(captured.executions[1].request).toMatchObject({ taskId: 'sbimg-second-render-0002', providerId: 'antigravity-cli', fallbackOrder: [], imageTurn: true });
      captured.held.shift()!();
      expect((await first).success).toBe(true);
      expect((await second).success).toBe(true);
      expect(captured.inFlight.most, 'never two image turns on the render bot at once').toBe(1);
    });

    it('a render still waiting at its startBy is answered busy with nothing dispatched, and the queue moves on to the next render', async () => {
      const executor = await holdingExecutor();
      const first = executor(render('sbimg-first-render-0001'));
      await vi.waitFor(() => expect(captured.executions).toHaveLength(1));
      const late = executor(render('sbimg-late-render-0002', Date.now() + 60));
      const patient = executor(render('sbimg-patient-render-0003'));
      expect(await late).toEqual({ success: false, busy: true, responseText: '',
        error: 'general-bot was still rendering another image when this render had to start; nothing was dispatched' });
      expect(captured.executions).toHaveLength(1);
      captured.held.shift()!();
      await vi.waitFor(() => expect(captured.executions).toHaveLength(2));
      expect(captured.executions[1].request.taskId, 'the late render never reached the bot').toBe('sbimg-patient-render-0003');
      captured.held.shift()!();
      expect((await first).success).toBe(true);
      expect((await patient).success).toBe(true);
    });

    it('a text turn to the same bot is delivered while an image turn holds it: the queue sits in the image executor, not in the bot-node client', async () => {
      const executor = await holdingExecutor();
      const image = executor(render('sbimg-first-render-0001'));
      await vi.waitFor(() => expect(captured.held).toHaveLength(1));
      const text = await new BotNodeClient(RESOLVER_TOKEN as never, 30_000).execute(RENDER_BOT, { text: 'what is on my calendar today', taskId: 'chat-text-0001', agentId: RENDER_BOT } as never);
      expect(text.success).toBe(true);
      expect(captured.executions.map((e) => e.request.taskId)).toEqual(['sbimg-first-render-0001', 'chat-text-0001']);
      captured.held.shift()!();
      expect((await image).success).toBe(true);
    });
  });
});
