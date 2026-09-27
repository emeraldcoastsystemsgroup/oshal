/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Seam guard for the 2026-09-27 live defect (automated case jarvis-cross-thread-recall): a Jarvis recall ask on the Antigravity brain ran 10 min 45 s and died on a headless read_file denial, because agy chased the answer with its own tools instead of the host loop's. Crosses the real boundary chain - the bot-node handler's direct marker, the REAL AgenticController XML loop over a REAL ToolRegistry, the REAL AntigravityProvider and AntigravityCLIWrapper, and a REAL child process (tests/fixtures/fake-agy-host-loop.cjs) spawned with the wrapper's own argv, cwd and env - and asserts from inside that child what agy is handed on every turn: the tool-less host agent in the private HOME, an empty permission allow list, one --add-dir equal to the task workspace, --sandbox, no accept-edits, no bypass flag, no MCP config and no .agents folder in the workspace. The recall tools run through the registry for the calling owner. A workspace task turn (no marker) keeps its existing shape, and a denied native read now names its tool and target.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBotNodeExecutionHandler } from '../../src/app/bot-node-execution-handler';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgenticController = require('../../any-bot/server/controllers/AgenticController');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ToolRegistry = require('../../any-bot/server/services/ToolRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AntigravityProvider = require('../../any-bot/server/services/llm/AntigravityProvider');

const FAKE_AGY = path.resolve('tests/fixtures/fake-agy-host-loop.cjs');
const OWNER = 'operator-sub';
const CODEWORD = 'TESTLAB-RECALL-5D0C1E77';
const THREAD_A = 'testlab-recall-a-fixture-thread';
const ENV_KEYS = ['DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'ANTIGRAVITY_OAUTH_TOKEN_PATH', 'SHARED_WORKSPACE_ROOT',
  'SWARM_CONTROLLER_URL', 'FAKE_AGY_OBSERVE_FILE', 'FAKE_AGY_MODE'];

interface Observation {
  argv: string[]; cwd: string; home: string; settings: string | null; agentMd: string | null;
  mcpConfig: string | null; workspaceAgentsDir: boolean; prompt: string;
}

let saved: Record<string, string | undefined>;
let scratch: string;
let observeFile: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-agy-loop-'));
  const auth = path.join(scratch, 'auth');
  fs.mkdirSync(auth);
  fs.writeFileSync(path.join(auth, 'antigravity-oauth-token'), 'fixture-token');
  fs.writeFileSync(path.join(auth, 'installation_id'), 'fixture-installation');
  observeFile = path.join(scratch, 'observations.ndjson');
  Object.assign(process.env, {
    DEMO_MODE: 'true', OSHAL_OPERATOR_SUBS: OWNER,
    ANTIGRAVITY_OAUTH_TOKEN_PATH: path.join(auth, 'antigravity-oauth-token'),
    SHARED_WORKSPACE_ROOT: path.join(scratch, 'workspaces'),
    // The model-gateway preflight fails open on a refused loopback port; nothing leaves the host.
    SWARM_CONTROLLER_URL: 'http://127.0.0.1:9',
    FAKE_AGY_OBSERVE_FILE: observeFile,
  });
  delete process.env.FAKE_AGY_MODE;
});

afterEach(() => {
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

/** Two read-only recall tools in a REAL registry; handlers record the owner the loop ran them for. */
function recallRegistry(calls: Array<{ tool: string; owner: unknown; input: unknown }>) {
  const registry = new ToolRegistry();
  const define = (name: string, required: string, result: unknown) => registry.register({
    name, description: `${name} fixture`, category: 'knowledge', requiresApproval: false, timeout: 5000,
    inputSchema: { type: 'object', required: [required], properties: { [required]: { type: 'string' }, source: { type: 'string' } } },
    handler: async (input: unknown, context: { extraEnv?: { OSHAL_USER_SUB?: string } }) => {
      calls.push({ tool: name, owner: context.extraEnv?.OSHAL_USER_SUB, input });
      return result;
    },
  });
  define('conversation_query', 'query', { conversations: [{ taskId: THREAD_A, source: 'conversation', title: 'Recall drill fixture' }], tasks: [] });
  define('conversation_fetch', 'taskId', { conversation: { taskId: THREAD_A, messages: [
    { role: 'user', text: `Please keep this for our recall drill: the codeword is ${CODEWORD}.` }] }, task: null });
  return registry;
}

function hostLoop(registry: unknown, taskId: string, workspace: string) {
  const taskController = {
    getTask: async () => ({ id: taskId, workspace_dir: workspace, source: 'swarm-dispatch', messages: [] }),
    addMessage: async () => undefined,
    updateMetrics: async () => undefined,
  };
  return new AgenticController({
    bedrockProvider: null, clineProvider: null, claudeCodeProvider: null, codexProvider: null,
    antigravityProvider: antigravityProvider(), getCurrentProvider: () => 'antigravity-cli',
  }, registry, { broadcast() {} }, taskController);
}

/** Every path-shaped argv value must be the one task workspace: nothing else is added to agy's scope. */
function expectWorkspaceOnlyScope(observed: Observation, workspace: string) {
  const addDirs = observed.argv.flatMap((arg, i) => (arg === '--add-dir' ? [observed.argv[i + 1]] : []));
  expect(addDirs).toEqual([workspace]);
  const paths = observed.argv.filter((arg) => path.isAbsolute(arg) || /^[A-Za-z]:[\\/]/.test(arg));
  expect(paths).toEqual([workspace]);
  expect(fs.realpathSync(observed.cwd)).toBe(fs.realpathSync(workspace));
  expect(observed.argv).toContain('--sandbox');
  expect(observed.argv).not.toContain('--dangerously-skip-permissions');
}

describe('Antigravity inside the agentic host tool loop', () => {
  it('answers a two-tool recall with agy holding no native tools on any turn', async () => {
    const taskId = 'jarvis-recall-seam';
    const workspace = path.join(scratch, 'workspaces', taskId);
    fs.mkdirSync(workspace, { recursive: true });
    const calls: Array<{ tool: string; owner: unknown; input: unknown }> = [];
    const loop = hostLoop(recallRegistry(calls), taskId, workspace);

    const result = await loop.processAgenticTask(taskId,
      'In a different conversation of mine, titled "Recall drill fixture", I gave you a codeword. Which codeword was it?',
      [], {}, {
        source: 'swarm-dispatch', hostToolsOnly: true, extraEnv: { OSHAL_USER_SUB: OWNER },
        allowedTools: ['conversation_query', 'conversation_fetch', 'attempt_completion'],
        authorizedScopes: ['tool:conversation_query', 'tool:conversation_fetch', 'control:attempt_completion'],
      });

    expect(result).toMatchObject({ success: true, turns: 3, provider: 'antigravity-cli' });
    expect(String(result.result.result)).toContain(CODEWORD);
    expect(calls.map((c) => [c.tool, c.owner])).toEqual([['conversation_query', OWNER], ['conversation_fetch', OWNER]]);
    expect(calls[1].input).toMatchObject({ taskId: THREAD_A });
    const seen = observations();
    expect(seen).toHaveLength(3);
    for (const turn of seen) {
      expect(turn.argv.slice(0, 2)).toEqual(['--agent', 'oshal-host-tools']);
      expect(turn.argv).not.toContain('--mode');
      expect(turn.argv).not.toContain('accept-edits');
      expectWorkspaceOnlyScope(turn, workspace);
      expect(JSON.parse(turn.settings || '{}')).toEqual({ permissions: { allow: [] } });
      expect(turn.agentMd).toMatch(/^excludeDefaultComponents: true$/m);
      expect(turn.agentMd).toMatch(/^inheritCustomizations: false$/m);
      expect(turn.agentMd).not.toMatch(/^tools:/m);
      expect(turn.mcpConfig).toBeNull();
      expect(turn.workspaceAgentsDir).toBe(false);
      expect(fs.existsSync(turn.home)).toBe(false);
    }
    // The brokered result reached the next turn, which is how the codeword got into the answer.
    expect(seen[2].prompt).toContain('tool-result:conversation_fetch');
  }, 30_000);

  it('keeps the workspace-task shape for an agentic turn without the marker', async () => {
    const workspace = path.join(scratch, 'workspaces', 'ticket-task');
    fs.mkdirSync(workspace, { recursive: true });
    await antigravityProvider().generateResponse([{ role: 'user', content: 'Write the deliverable.' }], {
      workspaceDir: workspace, extraEnv: { OSHAL_USER_SUB: OWNER },
    });
    const [turn] = observations();
    expect(turn.argv.slice(0, 2)).toEqual(['--mode', 'accept-edits']);
    expect(turn.argv).not.toContain('--agent');
    expectWorkspaceOnlyScope(turn, workspace);
    expect(JSON.parse(turn.settings || '{}')).toEqual({ permissions: { allow: ['command(regex:.*)'] } });
    expect(turn.agentMd).toBeNull();
  }, 30_000);

  it('names the denied native tool and its target when agy is refused', async () => {
    process.env.FAKE_AGY_MODE = 'deny';
    const workspace = path.join(scratch, 'workspaces', 'denied-task');
    fs.mkdirSync(workspace, { recursive: true });
    await expect(antigravityProvider().generateResponse([{ role: 'user', content: 'recall' }], {
      workspaceDir: workspace, extraEnv: { OSHAL_USER_SUB: OWNER },
    })).rejects.toThrow(/denied tool calls: view_file: permission check failed for read_file "\/app\/server\/app\.js"/);
  }, 30_000);
});

describe('bot-node handler marks only interactive dispatches host-tools-only', () => {
  function run(payload: Record<string, unknown>) {
    const processMessage = vi.fn(async (_taskId: string, _message: { text: string }, _options: Record<string, unknown>) => ({ messages: [{ say: 'completion_result', text: 'done' }], apiMetrics: { totalCost: 0, totalTokens: 0 } }));
    const handler = createBotNodeExecutionHandler({
      anyBotTaskController: { getTask: async () => null, createTask: async (_t: string, _m: string, o?: { forceTaskId?: string }) => ({ id: o?.forceTaskId ?? 'task' }), processMessage },
      providerName: 'antigravity-cli', modelName: 'gemini-3.8-flash-low',
    });
    return { processMessage, done: handler({ correlationId: 'c', fromAgentId: 'swarm-controller', toAgentId: 'jarvis', channel: 'agent.jarvis',
      messageType: 'request' as const, payload: { text: 'Which codeword was it?', userSub: OWNER, workspaceTaskId: 'jarvis-thread', ...payload } }) };
  }

  it('sets the marker for a direct ask and leaves every other dispatch unmarked', async () => {
    const direct = run({ direct: true, agenticMode: true });
    await direct.done;
    expect(direct.processMessage.mock.calls[0][2]).toMatchObject({ hostToolsOnly: true, agenticMode: true });
    const ticket = run({ agenticMode: true });
    await ticket.done;
    expect(ticket.processMessage.mock.calls[0][2]).not.toHaveProperty('hostToolsOnly');
  });
});
