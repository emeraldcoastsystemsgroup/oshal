/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Capture through the real bot-node handler, TaskController and agentic loop: frames carry the runtime's producing bot, not request metadata, and the real tail service delegates to it. Scripted provider, in-memory task persistence and controller-to-node transport are explicit doubles; filesystem/git capture and node tail execution are real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBotNodeExecutionHandler } from '@/app/bot-node-execution-handler';
import { executeTailReplayOnNode } from '@/app/bot-node-token-chase-tail-route';
import { TokenChaseReadService, TokenChaseTailReplayService, createOwnerStoreSnapshotter, readOwnerStoreConfig } from '@/features/token-chase';

// The production capture flag is read once on module load; no provider/network is used.
vi.hoisted(() => { process.env.TOKEN_CHASE_CAPTURE = 'true'; });
const requireCjs = createRequire(import.meta.url);
const TaskController = requireCjs('../../any-bot/server/controllers/TaskController');
const AgenticController = requireCjs('../../any-bot/server/controllers/AgenticController');
const ToolRegistry = requireCjs('../../any-bot/server/services/ToolRegistry');
const { tokenChase } = requireCjs('../../any-bot/server/services/token-chase/TokenChaseCapture');
const BOT = 'a0000000-0000-0000-0000-000000000050';
const OTHER_BOT = 'a0000000-0000-0000-0000-000000000099';
const OWNER = 'fixture|producing-bot-owner';
const ACCESS = { callerSub: OWNER, isAdmin: false };
const ENV_KEYS = ['SHARED_WORKSPACE_ROOT', 'OSHAL_WORKSPACE_ROOT', 'OSHAL_TOOL_LESS'];
const saved: Record<string, string | undefined> = {};
let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-producing-bot-'));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.SHARED_WORKSPACE_ROOT = root;
  process.env.OSHAL_WORKSPACE_ROOT = root;
  process.env.OSHAL_TOOL_LESS = 'false';
  tokenChase.configureOwnerStore(null);
});
afterAll(async () => {
  await tokenChase.flush();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** Real message routing/persistence logic with only database stores and task allocation doubled. */
function taskController() {
  const controller = Object.create(TaskController.prototype);
  const provider = { generateResponse: vi.fn(async () => ({
    content: '<attempt_completion><result>fixture complete</result></attempt_completion>',
    contentBlocks: [], provider: 'scripted-fixture', model: 'scripted-v1',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, cost: 0,
  })) };
  const stream = { broadcast() {} };
  Object.assign(controller, {
    activeTasks: new Map(), toolRegistry: new ToolRegistry(), stream, llm: null,
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
    bedrockProvider: provider, clineProvider: null, claudeCodeProvider: null, codexProvider: null,
    antigravityProvider: null, getCurrentProvider: () => 'scripted-fixture',
  }, controller.toolRegistry, stream, controller);
  return { controller, provider };
}

/** Only the constructor dependency is runtime-owned; envelope/payload identities are deliberately hostile. */
async function capture(runId: string, runtimeAgentId: string | undefined, target = BOT, owner = OWNER) {
  const { controller, provider } = taskController();
  const handler = createBotNodeExecutionHandler({
    runtimeAgentId, anyBotTaskController: controller, providerName: 'scripted-fixture', modelName: 'scripted-v1',
  });
  const outcome = await handler({
    correlationId: runId, fromAgentId: 'swarm-controller', toAgentId: target, channel: 'agent.fixture',
    messageType: 'request', payload: { direct: true, text: 'Return the fixture completion.', workspaceTaskId: runId,
      userSub: owner, agentId: OTHER_BOT, runtimeAgentId: OTHER_BOT, frame: { agentId: OTHER_BOT } },
  });
  await tokenChase.flush();
  await tokenChase.flush();
  const reader = new TokenChaseReadService();
  return { outcome, reader, provider, controller };
}

/** HTTP is doubled; real controller routing and isolated node restore/replay are not. */
function tails(reader: TokenChaseReadService) {
  const replayCall = vi.fn(async () => { throw new Error('Provider replay must not be called'); });
  const replayTail = vi.fn(async (agentId: string, request: Parameters<typeof executeTailReplayOnNode>[1]) => {
    const result = await executeTailReplayOnNode({
      agentId, reader, pool: null, authorize: (_req, _res, next) => next(),
      ownerStore: createOwnerStoreSnapshotter(readOwnerStoreConfig({})),
      replayRoot: path.join(root, '.tokenchase-replays'),
    }, request);
    if (!result) throw new Error('No visible start frame');
    return result;
  });
  return { replayCall, replayTail, service: new TokenChaseTailReplayService(reader, {
    hasEndpoint: (agentId) => agentId === BOT, replayTail, replayCall,
  }) };
}

describe('Token Chase producing identity across the real bot-node execution handler', () => {
  it('captures the runtime bot and delegates a no-edit tail to it, without a controller/provider fallback', async () => {
    const { outcome, reader, provider } = await capture('handler-capture', BOT);
    expect(outcome).toMatchObject({ success: true, output: { content: 'fixture complete' } });
    expect(provider.generateResponse).toHaveBeenCalledTimes(1);
    const frame = await reader.getFrame('handler-capture', 1, ACCESS);
    expect(frame).toMatchObject({ agentId: BOT, ownerSub: OWNER });
    const { service, replayTail, replayCall } = tails(reader);
    const result = await service.replayForward('handler-capture', 1, ACCESS);
    expect(result).toMatchObject({ agentId: BOT, status: 'reproduced', paidCalls: 0, artifacts: { reproduced: true }, storeVersion: { bound: false } });
    expect(replayTail).toHaveBeenCalledWith(BOT, { runId: 'handler-capture', fromFrame: 1, access: ACCESS });
    expect(replayCall).not.toHaveBeenCalled();
    expect(provider.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('does not promote an envelope target, payload agentId or supplied frame into producing identity', async () => {
    const { outcome, reader } = await capture('spoofed-target', BOT, OTHER_BOT);
    expect(outcome.success).toBe(true);
    expect(await reader.getFrame('spoofed-target', 1, ACCESS)).toMatchObject({ agentId: BOT, ownerSub: OWNER });
  });

  it('keeps an absent trusted runtime identity null and replay fail-closed, rather than borrowing request identity', async () => {
    const { reader } = await capture('missing-runtime', undefined);
    expect(await reader.getFrame('missing-runtime', 1, ACCESS)).toMatchObject({ agentId: null });
    const { service, replayTail, replayCall } = tails(reader);
    expect(await service.replayForward('missing-runtime', 1, ACCESS)).toMatchObject({ status: 'stopped', agentId: null, restore: { source: 'none' }, stopReason: expect.stringContaining('No reachable bot node for agent (unknown)') });
    expect(replayTail).not.toHaveBeenCalled();
    expect(replayCall).not.toHaveBeenCalled();
  });

  it('retains real reader owner isolation and prevents cross-owner handler workspace reuse', async () => {
    const { controller, reader, provider } = await capture('owned-run', BOT);
    expect(await reader.getFrame('owned-run', 1, { callerSub: 'fixture|other-owner', isAdmin: false })).toBeNull();
    const { service, replayTail } = tails(reader);
    expect(await service.replayForward('owned-run', 1, { callerSub: 'fixture|other-owner', isAdmin: false })).toBeNull();
    expect(replayTail).not.toHaveBeenCalled();
    const handler = createBotNodeExecutionHandler({ runtimeAgentId: BOT, anyBotTaskController: controller, providerName: 'scripted-fixture', modelName: 'scripted-v1' });
    expect(await handler({ correlationId: 'other-owner', fromAgentId: 'swarm-controller', toAgentId: BOT, channel: 'agent.fixture',
      messageType: 'request', payload: { direct: true, text: 'Not my workspace', workspaceTaskId: 'owned-run', userSub: 'fixture|other-owner' } }))
      .toMatchObject({ success: false, error: 'Task owner mismatch' });
    expect(provider.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('wires the resolved runtime identity at the actual shared server/batch composition point', () => {
    const runtime = fs.readFileSync('src/app/bot-node-runtime.ts', 'utf8');
    expect(/const agentId = runtimeIdentity\.agentId;/.test(runtime)).toBe(true);
    expect(/createBotNodeExecutionHandler\(\{\s*runtimeAgentId: agentId,/.test(runtime)).toBe(true);
  });
});
