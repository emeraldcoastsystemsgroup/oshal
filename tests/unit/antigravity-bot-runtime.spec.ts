/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Proves the bot-node Antigravity runtime without running agy or contacting Google: ADR-127 denial happens before allocation/spawn; the allowed path sends one stream-json user event on stdin (never argv), never adds the dangerous permission bypass, accepts only SUCCESS, and normalizes usage/provider identity.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin --add-dir to the exact invocation workspace. This is agy's project/permission boundary in headless mode; cwd by itself left ViewFile in request-review and made every persona-context read fail despite the task volume being mounted read-write.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Pin agy's sandbox flag beside the exact task workspace. Headless request-review cannot ask about commands, while --dangerously-skip-permissions would approve tools beyond the task boundary; the vendor sandbox is the autonomous task-scoped rail.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Pin accept-edits mode so headless task bots may write deliverables inside the declared workspace. Request-review cannot prompt for write_file, and the test continues to prohibit the global dangerous permission bypass.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Prove call-time MCP provisioning is invocation-scoped, carries exact controller bindings through environment rather than the prompt, adopts only the existing login files, and removes the temporary Antigravity home.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AntigravityCLIWrapper = require('../../any-bot/server/services/codebase/AntigravityCLIWrapper');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AntigravityProvider = require('../../any-bot/server/services/llm/AntigravityProvider');

const ENV_KEYS = ['DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'SWARM_SERVICE_SECRET', 'ANTIGRAVITY_OAUTH_TOKEN_PATH',
  'OSHAL_TOOLS_MCP_PATH', 'SWARM_CONTROLLER_URL'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.DEMO_MODE = 'true';
  process.env.OSHAL_OPERATOR_SUBS = 'operator-sub';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function fakeSpawn(result: object, exitCode = 0) {
  let invocation: { command: string; args: string[]; options: Record<string, unknown>; stdin: string } | null = null;
  const spawnImpl = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough; stderr: PassThrough; stdin: { end(value: string): void }; kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    child.stdin = {
      end(value: string) {
        invocation = { command, args, options, stdin: value };
        queueMicrotask(() => {
          child.stdout.write(`${JSON.stringify({ event: 'init' })}\n`);
          child.stdout.write(`${JSON.stringify({ event: 'result', result })}\n`);
          child.stdout.end();
          child.emit('close', exitCode);
        });
      },
    };
    return child;
  });
  return { spawnImpl, invocation: () => invocation };
}

describe('Antigravity bot-node wrapper', () => {
  it('provisions and removes an invocation-only MCP home for protected app tools', () => {
    const authRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-agy-auth-'));
    const tokenPath = path.join(authRoot, 'antigravity-oauth-token');
    fs.writeFileSync(tokenPath, 'fixture-token', 'utf8');
    fs.writeFileSync(path.join(authRoot, 'installation_id'), 'fixture-installation', 'utf8');
    process.env.SWARM_SERVICE_SECRET = 'fixture-service-secret';
    process.env.ANTIGRAVITY_OAUTH_TOKEN_PATH = tokenPath;
    process.env.OSHAL_TOOLS_MCP_PATH = path.resolve('scripts/oshal-tools-mcp.js');
    process.env.SWARM_CONTROLLER_URL = 'http://controller.fixture:5000';
    let scope: { env: NodeJS.ProcessEnv; release(): void } | undefined;
    try {
      scope = AntigravityCLIWrapper.provisionToolBridge({ agentId: 'career-bot', taskId: 'task-folder',
        userSub: 'operator-sub', applicationExecutionId: 'execution-id', applicationExecutionToken: 'signed-token' });
      const home = String(scope.env.HOME);
      const config = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
      expect(config).toEqual({ mcpServers: { 'oshal-tools': { command: 'node',
        args: [path.resolve('scripts/oshal-tools-mcp.js')], disabled: false } } });
      expect(fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).toBe('fixture-token');
      expect(scope.env).toMatchObject({ OSHAL_API_BASE: 'http://controller.fixture:5000', OSHAL_AGENT_ID: 'career-bot',
        OSHAL_TASK_ID: 'task-folder', OSHAL_USER_SUB: 'operator-sub', OSHAL_APPLICATION_EXECUTION_ID: 'execution-id',
        OSHAL_APPLICATION_EXECUTION_TOKEN: 'signed-token' });
      scope.release();
      expect(fs.existsSync(home)).toBe(false);
      scope = undefined;
    } finally {
      scope?.release();
      fs.rmSync(authRoot, { recursive: true, force: true });
    }
  });

  it('denies outside the ADR-127 carve before creating a workspace or spawning', async () => {
    delete process.env.DEMO_MODE;
    const workspace = path.join(os.tmpdir(), `oshal-agy-denied-${Date.now()}`, 'workspace');
    const spawnImpl = vi.fn();
    const wrapper = new AntigravityCLIWrapper({ spawnImpl });
    await expect(wrapper.executeTask('do not run', workspace, {}))
      .rejects.toMatchObject({ code: 'UNENFORCEABLE_CLI_TOOL_BOUNDARY' });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it('frames the prompt on stdin and accepts only the final SUCCESS result', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-agy-runtime-'));
    const fake = fakeSpawn({
      status: 'SUCCESS', response: 'ok\n',
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, cache_read_tokens: 4 },
    });
    try {
      const wrapper = new AntigravityCLIWrapper({
        agyCommand: 'fake-agy', model: 'gemini-3.8-flash-low', spawnImpl: fake.spawnImpl,
      });
      const result = await wrapper.executeTask('a prompt much safer on stdin', workspace, {
        extraEnv: { OSHAL_USER_SUB: 'operator-sub' },
      });
      expect(result).toMatchObject({ success: true, text: 'ok', exitCode: 0, usage: { totalTokens: 15 } });
      const invocation = fake.invocation();
      expect(invocation?.command).toBe('fake-agy');
      expect(invocation?.args).toEqual(expect.arrayContaining([
        '--mode', 'accept-edits',
        '--sandbox',
        '--add-dir', workspace,
        '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--model', 'gemini-3.8-flash-low',
      ]));
      expect(invocation?.options.cwd).toBe(workspace);
      expect(invocation?.args).not.toContain('--dangerously-skip-permissions');
      expect(invocation?.args).not.toContain('a prompt much safer on stdin');
      expect(JSON.parse(invocation?.stdin.trim() || '{}')).toEqual({
        event: 'user', message: { content: 'a prompt much safer on stdin' },
      });
      expect((invocation?.options.env as NodeJS.ProcessEnv).OSHAL_USER_SUB).toBe('operator-sub');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each(['ERROR', 'WAITING', 'FUTURE_VENDOR_STATUS'])(
    'fails closed on status %s even when the process exits zero',
    async (status) => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-agy-status-'));
      const fake = fakeSpawn({ status, response: 'must not cross', error: 'vendor refused' });
      try {
        const wrapper = new AntigravityCLIWrapper({ spawnImpl: fake.spawnImpl });
        await expect(wrapper.executeTask('work', workspace, { extraEnv: { OSHAL_USER_SUB: 'operator-sub' } }))
          .resolves.toMatchObject({ success: false, stderr: expect.stringContaining('vendor refused') });
      } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  it('does not miss a child that closes synchronously while stdin is written', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-agy-fast-close-'));
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough; stderr: PassThrough; stdin: { end(value: string): void }; kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      child.stdin = {
        end() {
          child.stdout.write(`${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'fast' } })}\n`);
          child.emit('close', 0);
        },
      };
      return child;
    });
    try {
      const wrapper = new AntigravityCLIWrapper({ spawnImpl });
      await expect(wrapper.executeTask('work', workspace, { extraEnv: { OSHAL_USER_SUB: 'operator-sub' } }))
        .resolves.toMatchObject({ success: true, text: 'fast' });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('Antigravity bot-node provider', () => {
  it('normalizes an invalid timeout instead of reporting NaN', () => {
    const prior = process.env.ANTIGRAVITY_TIMEOUT_MS;
    try {
      process.env.ANTIGRAVITY_TIMEOUT_MS = 'not-a-number';
      const provider = new AntigravityProvider();
      expect(provider.getModelInfo().timeout).toBe(600000);
    } finally {
      if (prior === undefined) delete process.env.ANTIGRAVITY_TIMEOUT_MS;
      else process.env.ANTIGRAVITY_TIMEOUT_MS = prior;
    }
  });

  it('normalizes a successful wrapper result under the Antigravity runtime identity', async () => {
    const provider = new AntigravityProvider({ model: 'gemini-3.8-flash-low' });
    provider.wrapper.executeTask = vi.fn(async () => ({
      success: true, text: 'answer', stderr: '', exitCode: 0, durationMs: 5, costUSD: 0,
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, cacheReadTokens: 0 },
    }));
    await expect(provider.generateResponse([{ role: 'user', content: 'question' }], {
      workspaceDir: os.tmpdir(), extraEnv: { OSHAL_USER_SUB: 'operator-sub' },
    })).resolves.toMatchObject({
      content: 'answer', provider: 'antigravity-cli', model: 'gemini-3.8-flash-low',
      usage: { totalTokens: 3 },
    });
  });
});

describe('Antigravity container credential wiring', () => {
  it('puts the API and every bot on agy file storage backed by the shared Gemini mount', () => {
    const compose = fs.readFileSync(path.join(process.cwd(), 'docker-compose.oshal-local.yml'), 'utf8');
    expect(compose).toContain('GEMINI_FORCE_FILE_STORAGE: "true"');
    expect(compose).toContain('ANTIGRAVITY_OAUTH_TOKEN_PATH: ${ANTIGRAVITY_OAUTH_TOKEN_PATH:-/root/.gemini/antigravity-cli/antigravity-oauth-token}');
    expect(compose).toContain('x-gemini-auth-volume: &gemini-auth-volume');
    expect(compose).toContain('<<: *bot-env');
    expect(compose).toContain('- *gemini-auth-volume');
    expect(compose).not.toContain('ANTIGRAVITY_ACCOUNT_LOGIN_READY');
  });
});
