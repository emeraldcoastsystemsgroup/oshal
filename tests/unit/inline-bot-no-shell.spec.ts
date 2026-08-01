/**
 * Guard: CONTROLLER-INLINE bots have no shell, and none of the api container's
 * platform-plane credentials reach their subprocess.
 * (BACKLOG "Harden inline controller bots (token-broker rollout, phase 2)")
 *
 * Goes red if any of these regress:
 *  - `stripShellTools` stops removing Bash (or a cased/renamed variant of it);
 *  - `resolveControllerInlineScope` stops recognising the api container, or starts
 *    restricting a BOT-NODE bot (which must keep the incident "SWAT team" tool set);
 *  - `resolveHarnessForAgent` stops threading the scope into the harness factory —
 *    asserted by capturing the REAL factory's config for a real inline registry bot
 *    and a real bot-node registry bot, so an unwiring is caught, not just a rename;
 *  - the adapter stops honouring `scrubEnvKeys`, i.e. REMOTE_CLIENT_SHARED_SECRET
 *    survives into the child env. That value is MACHINE TRUST on the worker plane:
 *    it skips per-device ownership, so an injected inline bot holding it could
 *    enqueue a shell-exec task on ANY user's desktop.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard-per-fix for the controller-inline least-privilege scope: pure policy matrix, the resolveHarnessForAgent -> factory wiring proven by capturing the real factory config, and the base-adapter env scrub proven through the real prepareScopedFiles.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTROLLER_INLINE_SCRUB_ENV_KEYS,
  DEFAULT_INLINE_ALLOWED_TOOLS,
  isControllerInlineContainer,
  resolveControllerInlineScope,
  stripShellTools,
} from '../../src/features/llm-provider';

const SHELL_ENV_KEY = 'REMOTE_CLIENT_SHARED_SECRET';
const ENV_KEYS = ['CLAUDE_ALLOWED_TOOLS', 'SWARM_REGISTRY', 'BOT_NAME', 'AGENT_ID', SHELL_ENV_KEY];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('stripShellTools', () => {
  it('removes Bash and its variants while preserving every other tool, in order', () => {
    expect(stripShellTools('Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,WebFetch,WebSearch'))
      .toBe('Read,Write,Edit,MultiEdit,Glob,Grep,LS,WebFetch,WebSearch');
    expect(stripShellTools('Read,BashOutput,Write,KillShell')).toBe('Read,Write');
  });

  it('is case-insensitive and whitespace-tolerant, so a cased spelling cannot smuggle a shell in', () => {
    expect(stripShellTools(' bash , Read ,BASH, Grep')).toBe('Read,Grep');
    expect(stripShellTools('Bash')).toBe('');
    expect(stripShellTools('')).toBe('');
  });

  it('leaves a shell-free list untouched (idempotent)', () => {
    const once = stripShellTools(DEFAULT_INLINE_ALLOWED_TOOLS);
    expect(once).toBe(DEFAULT_INLINE_ALLOWED_TOOLS);
    expect(stripShellTools(once)).toBe(once);
  });
});

describe('resolveControllerInlineScope', () => {
  it('recognises the controller container(s) and nothing else', () => {
    expect(isControllerInlineContainer('oshal-api')).toBe(true);
    expect(isControllerInlineContainer('oshal-local-api')).toBe(true);
    expect(isControllerInlineContainer('queue-bot')).toBe(false);
    expect(isControllerInlineContainer(undefined)).toBe(false);
  });

  it('strips the shell from the DEPLOYMENT-WIDE tool list for an inline bot', () => {
    // The live compose value: every bot gets Bash. An inline bot must not.
    process.env.CLAUDE_ALLOWED_TOOLS = 'Bash,Read,Write,Edit,MultiEdit,Glob,Grep,LS,WebFetch,WebSearch';
    const scope = resolveControllerInlineScope('oshal-api');
    expect(scope.inline).toBe(true);
    expect(scope.allowedTools).toBeDefined();
    expect(scope.allowedTools!.split(',')).not.toContain('Bash');
    // It keeps what codex-packer needs to emit a persona + manifest.
    expect(scope.allowedTools!.split(',')).toEqual(
      expect.arrayContaining(['Read', 'Write', 'Edit', 'Grep']),
    );
    expect(scope.scrubEnvKeys).toContain(SHELL_ENV_KEY);
  });

  it('falls back to a shell-free default when the deployment declares no tool list', () => {
    const scope = resolveControllerInlineScope('oshal-api');
    expect(scope.allowedTools).toBe(DEFAULT_INLINE_ALLOWED_TOOLS);
    expect(scope.allowedTools!.split(',')).not.toContain('Bash');
  });

  it('does NOT restrict a bot-node bot — their harnesses must be built exactly as before', () => {
    process.env.CLAUDE_ALLOWED_TOOLS = 'Bash,Read,Write';
    const scope = resolveControllerInlineScope('queue-bot');
    expect(scope).toEqual({ inline: false });
    expect(scope.allowedTools).toBeUndefined();
    expect(scope.scrubEnvKeys).toBeUndefined();
  });

  it('names the worker-plane secret in the scrub set (the escalation this closes)', () => {
    // Machine trust on the device plane: a request bearing it SKIPS per-device ownership,
    // so an inline bot that could read it could act on any user's desktop.
    expect(CONTROLLER_INLINE_SCRUB_ENV_KEYS).toContain('REMOTE_CLIENT_SHARED_SECRET');
    expect(CONTROLLER_INLINE_SCRUB_ENV_KEYS).toContain('REMOTE_CLIENT_CONTROL_PLANE_TOKEN');
    // Deliberately absent — bot personas legitimately call the api with it (swarm-cli), and
    // provider keys ARE the CLI's own auth. Documented in controller-inline-scope.ts.
    expect(CONTROLLER_INLINE_SCRUB_ENV_KEYS).not.toContain('SWARM_SERVICE_SECRET');
    expect(CONTROLLER_INLINE_SCRUB_ENV_KEYS).not.toContain('ANTHROPIC_API_KEY');
  });
});

describe('resolveHarnessForAgent threads the inline scope into the harness factory', () => {
  const noopLogger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  } as unknown as Parameters<typeof import('../../src/app/composition/provider-runtime').resolveHarnessForAgent>[1];

  const INLINE_AGENT = 'aaaa0000-0000-0000-0000-00000000inl1';
  const NODE_AGENT = 'bbbb0000-0000-0000-0000-0000000000nd1';

  /**
   * Two registry entries differing ONLY in `container` — the field the scope keys off — so the
   * assertion isolates that decision from anything else a real registry row carries. The reader
   * is injected because the production default is a `require('@/...')` the test transform
   * cannot resolve (it returns null on every call under vitest).
   */
  const registry = [
    { agentId: INLINE_AGENT, name: 'spec-inline-bot', container: 'oshal-api', harnessType: 'claude-code', apiType: 'claude-code' },
    { agentId: NODE_AGENT, name: 'spec-node-bot', container: 'spec-node-bot', harnessType: 'claude-code', apiType: 'claude-code' },
  ];

  it('an INLINE bot gets a shell-free allowedTools + the env scrub; a BOT-NODE bot gets neither', async () => {
    process.env.CLAUDE_ALLOWED_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,LS,WebFetch,WebSearch';
    const { HARNESS_FACTORIES, resolveHarnessForAgent } = await import('../../src/app/composition/provider-runtime');

    // Capture the config the REAL resolver hands the REAL factory registry. Swapping the
    // factory (rather than reading adapter internals) proves the WIRING, which is the part an
    // unrelated refactor silently breaks.
    const captured: Array<Record<string, unknown>> = [];
    const original = HARNESS_FACTORIES['claude-code'];
    HARNESS_FACTORIES['claude-code'] = ((cfg: Record<string, unknown>) => {
      captured.push(cfg);
      return { getProviderName: () => 'captured' } as never;
    }) as typeof original;

    try {
      const inlineHarness = resolveHarnessForAgent(INLINE_AGENT, noopLogger, undefined, () => registry);
      expect(inlineHarness, 'the resolver must actually build a harness').not.toBeNull();
      expect(captured).toHaveLength(1);
      const inlineCfg = captured[0];
      expect(inlineCfg.container).toBe('oshal-api');
      expect(String(inlineCfg.allowedTools ?? '').split(',')).not.toContain('Bash');
      expect(String(inlineCfg.allowedTools ?? '')).toContain('Read');
      expect(inlineCfg.scrubEnvKeys as string[]).toContain(SHELL_ENV_KEY);

      captured.length = 0;
      resolveHarnessForAgent(NODE_AGENT, noopLogger, undefined, () => registry);
      expect(captured).toHaveLength(1);
      // Bot-node bots keep the process-level CLAUDE_ALLOWED_TOOLS (Bash included) — the
      // restriction is inline-only, so this half proves the change is additive.
      expect(captured[0].allowedTools).toBeUndefined();
      expect(captured[0].scrubEnvKeys).toBeUndefined();
    } finally {
      HARNESS_FACTORIES['claude-code'] = original;
    }
  }, 30_000);
});

describe('the adapter honours scrubEnvKeys (the child env never sees the worker-plane secret)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-inline-scope-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** Runs the REAL per-spawn scoping path every CLI harness calls, and returns the mutated env. */
  function scopedEnv(adapter: unknown, env: Record<string, string>): Record<string, string> {
    (adapter as {
      applyUserScoping: (e: Record<string, string>, w: string, sub?: string) => unknown;
    }).applyUserScoping(env, workspace);
    return env;
  }

  it('deletes the inline scrub keys — and still deletes the always-scrubbed master secret', async () => {
    const { ClaudeCodeCliHarnessAdapter } = await import(
      '../../src/features/llm-provider/services/claude-code-cli-harness-adapter'
    );
    const scope = resolveControllerInlineScope('oshal-api');
    const adapter = new ClaudeCodeCliHarnessAdapter({
      allowedTools: scope.allowedTools,
      scrubEnvKeys: scope.scrubEnvKeys,
    });

    const env = scopedEnv(adapter, {
      SESSION_SECRET: 'master-connector-key',
      REMOTE_CLIENT_SHARED_SECRET: 'worker-plane-machine-trust',
      ALERT_WEBHOOK_TOKEN: 'ingest',
      // Must SURVIVE: the CLI's own auth and the paths it needs.
      ANTHROPIC_API_KEY: 'sk-ant-real',
      PATH: '/usr/bin',
    });

    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.REMOTE_CLIENT_SHARED_SECRET, 'the worker-plane machine credential must not reach an inline bot').toBeUndefined();
    expect(env.ALERT_WEBHOOK_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-real');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('scrubs on the BATCH (non-streaming) construction path too — both super() branches', async () => {
    // The adapter picks its timeout semantics from outputFormat and passes the scrub list on a
    // DIFFERENT super() argument in each branch; the streaming default above covers one, this
    // covers the other, so neither can silently drop the list.
    const { ClaudeCodeCliHarnessAdapter } = await import(
      '../../src/features/llm-provider/services/claude-code-cli-harness-adapter'
    );
    const scope = resolveControllerInlineScope('oshal-api');
    const adapter = new ClaudeCodeCliHarnessAdapter({ outputFormat: 'json', scrubEnvKeys: scope.scrubEnvKeys });
    const env = scopedEnv(adapter, { REMOTE_CLIENT_SHARED_SECRET: 'worker-plane-machine-trust', PATH: '/usr/bin' });
    expect(env.REMOTE_CLIENT_SHARED_SECRET).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('a codex inline adapter scrubs the same keys (codex always has a shell, so this is its control)', async () => {
    const { CodexCliHarnessAdapter } = await import(
      '../../src/features/llm-provider/services/codex-cli-harness-adapter'
    );
    const scope = resolveControllerInlineScope('oshal-api');
    const adapter = new CodexCliHarnessAdapter({ scrubEnvKeys: scope.scrubEnvKeys });
    const env = scopedEnv(adapter, {
      REMOTE_CLIENT_SHARED_SECRET: 'worker-plane-machine-trust',
      PATH: '/usr/bin',
    });
    expect(env.REMOTE_CLIENT_SHARED_SECRET).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('a BOT-NODE adapter (no scrubEnvKeys) keeps the platform-plane vars — additive by construction', async () => {
    const { ClaudeCodeCliHarnessAdapter } = await import(
      '../../src/features/llm-provider/services/claude-code-cli-harness-adapter'
    );
    const adapter = new ClaudeCodeCliHarnessAdapter({});
    const env = scopedEnv(adapter, {
      SESSION_SECRET: 'master-connector-key',
      REMOTE_CLIENT_SHARED_SECRET: 'worker-plane-machine-trust',
    });

    // The pre-existing always-scrub still applies...
    expect(env.SESSION_SECRET).toBeUndefined();
    // ...but the inline-only addition does not reach bot-node containers (which never carry it).
    expect(env.REMOTE_CLIENT_SHARED_SECRET).toBe('worker-plane-machine-trust');
  });
});
