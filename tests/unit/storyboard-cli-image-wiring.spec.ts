/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-130 codex-cli render WIRING (the half storyboard-codex-cli-provider.spec.ts doubles). Pins that the boot-registered executor dispatches the render with providerId 'openai-codex' as its ADR-034 carried record, and — running the REAL bot-side parse + reconcile over the captured request — that a render bot parked on another harness (the demo box's claude-code fleet-default row) is switched onto codex before the spawn, while the unstamped legacy shape leaves the runtime untouched, which is exactly how the live storyboard died with NO_IMAGE_CAPABILITY on 2026-09-21. Also pins the bot/timeout knobs, the userSub threading, and that a bot failure is surfaced (never thrown). BotNodeClient is the double: it is the HTTP hop to the node; the request it is handed is the boundary under test.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-130 amendment 2026-10-02: the dispatch carries the rail's own harness. A codex-cli render still stamps 'openai-codex'; an antigravity-cli render stamps 'antigravity-cli', and the REAL bot-side parse + reconcile switches a render bot parked on claude-code onto antigravity-cli before the spawn. Every render is marked imageTurn. A harness outside the two CLI rails is refused before any dispatch. Boot also registers the swarm-default reader: with the switch snapshot reporting an antigravity-cli fleet row, the demo image default selects antigravity-cli.
 */

import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  constructed: [] as Array<{ resolver: unknown; timeoutMs: number | undefined }>,
  executions: [] as Array<{ agentId: string; request: Record<string, unknown> }>,
  behaviour: { mode: 'ok' as 'ok' | 'refuse' | 'throw' },
}));

const RESOLVER_TOKEN = vi.hoisted(() => ({ kind: 'registry-endpoint-resolver' }));

vi.mock('@/features/agent-management', () => ({
  BotNodeClient: class {
    constructor(resolver: unknown, timeoutMs?: number) {
      captured.constructed.push({ resolver, timeoutMs });
    }
    async execute(agentId: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
      captured.executions.push({ agentId, request });
      if (captured.behaviour.mode === 'throw') throw new Error('Bot node execution timed out after 1ms for agent x');
      if (captured.behaviour.mode === 'refuse') {
        return { success: false, response: '', error: 'UNENFORCEABLE_CLI_TOOL_BOUNDARY: demo carve refused' };
      }
      return { success: true, response: 'RENDERED output.png', model: 'gpt-5.5', provider: 'openai-codex' };
    }
  },
  createRegistryEndpointResolver: () => RESOLVER_TOKEN,
}));

const logged = vi.hoisted(() => [] as Array<{ level: string; message: string; fields: Record<string, unknown> }>);
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => {
    const record = (level: string) => (fields: Record<string, unknown>, message: string) => { logged.push({ level, message, fields }); };
    return { info: record('info'), error: record('error'), warn: record('warn'), debug: record('debug') };
  },
}));

import { ANTIGRAVITY_CLI_RENDER_PROVIDER_ID, CODEX_CLI_RENDER_PROVIDER_ID, wireCliStoryboardImageExecutor } from '../../src/app/storyboard-cli-image-wiring';
import { setInstalledProviderSwitchSnapshot } from '../../src/app/composition/provider-switch-runtime';
import { registerStoryboardSwarmDefaultReader, selectStoryboardImageProvider } from '../../src/features/video-generation/services/storyboard-image-default';
import {
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

const GENERAL_BOT = 'a0000000-0000-0000-0000-000000000099';
const ENV_KEYS = ['STORYBOARD_CLI_IMAGE_BOT_ID', 'STORYBOARD_CLI_IMAGE_TIMEOUT_MS'] as const;
const QUIET_LOG = { warn: () => undefined, debug: () => undefined };

const RENDER: CliStoryboardRenderRequest = {
  prompt: 'You are a headless image-rendering task. ---BRIEF--- a fox ---END BRIEF---',
  taskId: 'sbimg-11111111-2222-4333-8444-555555555555',
  workspaceFolderId: 'sbimg-11111111-2222-4333-8444-555555555555',
  userSub: 'operator-sub-1',
  harness: 'openai-codex',
};

/** A bot-node runtime seam whose active provider is whatever its switch row last said. */
function runtimeParkedOn(provider: string, model = 'claude-sonnet-4-6'): DispatchConfigRuntime & { switches: Array<[string, string | undefined]> } {
  let active: ActiveBotNodeProvider = { provider, model };
  const switches: Array<[string, string | undefined]> = [];
  return {
    switches,
    getActiveProvider: () => active,
    setActiveProvider: (next: string, nextModel?: string) => {
      switches.push([next, nextModel]);
      active = { provider: next, model: nextModel ?? 'gpt-5.5' };
      return active;
    },
  };
}

async function wireAndRender(request: CliStoryboardRenderRequest = RENDER) {
  wireCliStoryboardImageExecutor();
  const executor = resolveCliStoryboardImageExecutor();
  expect(executor, 'boot wiring must register the executor seam').not.toBeNull();
  return executor!(request);
}

describe('codex-cli storyboard render wiring (ADR-130 on the ADR-162 fleet)', () => {
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    captured.constructed.length = 0;
    captured.executions.length = 0;
    captured.behaviour.mode = 'ok';
    logged.length = 0;
    registerCliStoryboardImageExecutor(null);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    registerCliStoryboardImageExecutor(null);
  });

  it('dispatches the render with the codex harness as its ADR-034 carried record, unpinned model', async () => {
    const result = await wireAndRender();

    expect(result).toEqual({ success: true, responseText: 'RENDERED output.png', model: 'gpt-5.5', provider: 'openai-codex', error: undefined });
    expect(captured.executions).toHaveLength(1);
    const { agentId, request } = captured.executions[0];
    expect(agentId).toBe(GENERAL_BOT);
    expect(request).toMatchObject({
      text: RENDER.prompt,
      taskId: RENDER.taskId,
      workspaceFolderId: RENDER.workspaceFolderId,
      agentId: GENERAL_BOT,
      agenticMode: true,
      userSub: RENDER.userSub,
      providerId: CODEX_CLI_RENDER_PROVIDER_ID,
      imageTurn: true,
    });
    expect(CODEX_CLI_RENDER_PROVIDER_ID).toBe('openai-codex');
    // The model is the render bot's CODEX_MODEL, never a per-call pin (ADR-130 "Model").
    expect(request).not.toHaveProperty('model');
  });

  it('a render bot parked on claude-code (the demo fleet-default row) is switched onto codex before the spawn', async () => {
    await wireAndRender();
    const body = captured.executions[0].request as { providerId?: unknown; model?: unknown; configVersion?: unknown };

    // The REAL bot half: parse what the controller sent, reconcile against a claude-code runtime.
    const carried = parseCarriedDispatchConfig(body);
    expect(carried).toEqual({ providerId: 'openai-codex' });

    const runtime = runtimeParkedOn('claude-code');
    const outcome = reconcileDispatchProviderConfig(carried, runtime, { taskId: RENDER.taskId }, QUIET_LOG);

    expect(outcome.action).toBe('corrected');
    expect(outcome.active).toMatchObject({ provider: 'openai-codex' });
    expect(runtime.switches).toEqual([['openai-codex', undefined]]);
    expect(runtime.getActiveProvider().provider).toBe('openai-codex');
  });

  it('a render bot already on codex needs no correction, and the legacy unstamped shape leaves the runtime untouched', () => {
    const onCodex = runtimeParkedOn('openai-codex', 'gpt-5.5');
    const matched = reconcileDispatchProviderConfig({ providerId: CODEX_CLI_RENDER_PROVIDER_ID }, onCodex, {}, QUIET_LOG);
    expect(matched.action).toBe('match');
    expect(onCodex.switches).toEqual([]);

    // The defect's shape: no providerId on the body is the "absent" legacy path — the bot keeps
    // running whatever it was on. On claude-code that is NO_IMAGE_CAPABILITY (live, 2026-09-21).
    const legacy = parseCarriedDispatchConfig({ text: 'render', agenticMode: true } as { providerId?: unknown });
    expect(legacy).toBeNull();
    const parked = runtimeParkedOn('claude-code');
    expect(reconcileDispatchProviderConfig(legacy, parked, {}, QUIET_LOG)).toEqual({ action: 'absent' });
    expect(parked.getActiveProvider().provider).toBe('claude-code');
  });

  it('STORYBOARD_CLI_IMAGE_BOT_ID and _TIMEOUT_MS pick the render node and the dispatch deadline', async () => {
    process.env.STORYBOARD_CLI_IMAGE_BOT_ID = ' a0000000-0000-0000-0000-000000000042 ';
    process.env.STORYBOARD_CLI_IMAGE_TIMEOUT_MS = '90000';

    await wireAndRender();

    expect(captured.constructed).toEqual([{ resolver: RESOLVER_TOKEN, timeoutMs: 90_000 }]);
    expect(captured.executions[0].agentId).toBe('a0000000-0000-0000-0000-000000000042');
    expect(captured.executions[0].request).toMatchObject({
      agentId: 'a0000000-0000-0000-0000-000000000042',
      providerId: CODEX_CLI_RENDER_PROVIDER_ID,
    });
    expect(logged.find((l) => l.message === 'cli storyboard image executor registered')?.fields)
      .toMatchObject({ agentId: 'a0000000-0000-0000-0000-000000000042', timeoutMs: 90_000 });
  });

  it('an antigravity-cli render carries the Antigravity harness, and a bot parked on claude-code is switched onto it', async () => {
    await wireAndRender({ ...RENDER, harness: 'antigravity-cli' });
    const body = captured.executions[0].request as { providerId?: unknown; imageTurn?: unknown };
    expect(body).toMatchObject({ providerId: ANTIGRAVITY_CLI_RENDER_PROVIDER_ID, imageTurn: true, agenticMode: true });
    expect(ANTIGRAVITY_CLI_RENDER_PROVIDER_ID).toBe('antigravity-cli');

    const carried = parseCarriedDispatchConfig(body);
    expect(carried).toEqual({ providerId: 'antigravity-cli' });
    const runtime = runtimeParkedOn('claude-code');
    const outcome = reconcileDispatchProviderConfig(carried, runtime, { taskId: RENDER.taskId }, QUIET_LOG);
    expect(outcome.action).toBe('corrected');
    expect(runtime.switches).toEqual([['antigravity-cli', undefined]]);
  });

  it('refuses a harness outside the two CLI rails before any dispatch', async () => {
    const result = await wireAndRender({ ...RENDER, harness: 'claude-code' as never });
    expect(result).toEqual({ success: false, responseText: '', error: "unknown render harness 'claude-code'" });
    expect(captured.executions).toEqual([]);
  });

  it('boot registers the swarm-default reader the demo image default follows', () => {
    const savedDemo = process.env.DEMO_MODE;
    process.env.DEMO_MODE = 'true';
    try {
      wireCliStoryboardImageExecutor();
      setInstalledProviderSwitchSnapshot({ status: () => ({ loaded: true, loadedAt: null, rowCount: 1, lastError: null,
        fleetDefault: { scopeId: 'fleet-default', providerId: 'antigravity-cli', modelId: null, updatedBy: null, updatedAt: null } }) } as never);
      expect(selectStoryboardImageProvider()).toMatchObject({ ok: true, id: 'antigravity-cli', source: 'swarm-default' });
    } finally {
      setInstalledProviderSwitchSnapshot(null);
      registerStoryboardSwarmDefaultReader(null);
      if (savedDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = savedDemo;
    }
  });

  it('the bot-node HTTP hop forwards only a literal-true imageTurn into the execution envelope', () => {
    const source = fs.readFileSync(new URL('../../src/app/bot-node-server.ts', import.meta.url), 'utf8');
    const routeStart = source.indexOf("app.post(\n    '/api/swarm-execute'");
    const route = source.slice(routeStart, source.indexOf("app.post('/api/token-chase/replay-call'", routeStart));
    expect(routeStart).toBeGreaterThan(-1);
    expect(route).toContain('...(body.imageTurn === true ? { imageTurn: true } : {}),');
    expect(route.indexOf('body.imageTurn === true')).toBeGreaterThan(route.indexOf('payload: {'));
  });

  it('defaults to general-bot and the 7-minute deadline when the knobs are unset', async () => {
    await wireAndRender();
    expect(captured.constructed).toEqual([{ resolver: RESOLVER_TOKEN, timeoutMs: 420_000 }]);
    expect(captured.executions[0].agentId).toBe(GENERAL_BOT);
  });

  it('a bot-side refusal rides through as success:false with its text, and a thrown dispatch is surfaced, never rethrown', async () => {
    captured.behaviour.mode = 'refuse';
    const refused = await wireAndRender();
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('UNENFORCEABLE_CLI_TOOL_BOUNDARY');

    captured.behaviour.mode = 'throw';
    const failed = await wireAndRender();
    expect(failed).toEqual({ success: false, responseText: '', error: 'Bot node execution timed out after 1ms for agent x' });
    expect(logged.some((l) => l.level === 'error' && l.message === 'cli storyboard render task failed')).toBe(true);
  });
});
