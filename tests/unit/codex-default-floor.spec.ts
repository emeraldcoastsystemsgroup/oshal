/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the codex fleet default (operator directive 2026-08-12). Pins four invariants: (1) every LLM-harness bot in BOTH registries is codex-cli/openai-codex (a2a is the only exception — an external-agent boundary, not an LLM harness), with hard count floors so an emptied registry can't pass vacuously; (2) the codex model defaults never fall below gpt-5.5 and gpt-5.3-codex (the API-key-only name that 400s on a ChatGPT login) never reappears as a default — compose interpolation defaults included; (3) both codex spawn paths pin `-c model_reasoning_effort` (default high) — asserted on the REAL spawn argv via a stubbed spawnImpl, because the per-task codex home copies the HOST config.toml and a host-side effort tuned for gpt-5.6-sol (ultra) 400s every fleet turn on gpt-5.5/gpt-5.4 (verified live); (4) the compose fleet-provider defaults stay openai-codex.
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

// DEFAULT_MODEL in the adapter freezes process.env.LLM_MODEL at import time — clear the
// model env BEFORE the hoisted imports so the module-level default under test is the
// repo default, not whatever this shell happens to carry.
vi.hoisted(() => {
  delete process.env.LLM_MODEL;
  delete process.env.CODEX_MODEL;
  delete process.env.CODEX_REASONING_EFFORT;
});

import { SWARM_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry';
import { LOCAL_BOT_REGISTRY } from '../../src/app/extensions/swarm/swarm-bot-registry-local';
import { CodexCliHarnessAdapter } from '../../src/features/llm-provider/services/codex-cli-harness-adapter';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The floor the operator set: every codex default must be gpt-5.5 or newer. */
const MODEL_FLOOR = { major: 5, minor: 5 };

/** @description True when a codex model id (gpt-<major>.<minor>[-suffix]) meets the fleet floor. */
function meetsFloor(model: string): boolean {
  const m = /^gpt-(\d+)\.(\d+)/.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > MODEL_FLOOR.major || (major === MODEL_FLOOR.major && minor >= MODEL_FLOOR.minor);
}

describe('registry fleet default — codex everywhere, a2a excepted', () => {
  const cases = [
    { name: 'canonical', registry: SWARM_BOT_REGISTRY, minCodexBots: 35 },
    { name: 'local', registry: LOCAL_BOT_REGISTRY, minCodexBots: 50 },
  ] as const;

  for (const { name, registry, minCodexBots } of cases) {
    it(`${name} registry declares no LLM harness other than codex-cli`, () => {
      for (const bot of registry) {
        if (bot.harnessType !== undefined) {
          expect(['codex-cli', 'a2a'], `${bot.name} harnessType`).toContain(bot.harnessType);
        }
        if (bot.apiType !== undefined) {
          expect(['openai-codex', 'a2a'], `${bot.name} apiType`).toContain(bot.apiType);
        }
      }
    });

    it(`${name} registry keeps a real codex fleet (count floor, not a vacuous pass)`, () => {
      const codexBots = registry.filter((b) => b.harnessType === 'codex-cli');
      expect(codexBots.length).toBeGreaterThanOrEqual(minCodexBots);
    });
  }
});

describe('TS adapter (controller/inline path) — model floor + pinned reasoning effort', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['CODEX_MODEL', 'LLM_MODEL', 'CODEX_REASONING_EFFORT'];

  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('defaults to a model at or above the gpt-5.5 floor', () => {
    const adapter = new CodexCliHarnessAdapter({});
    const model = (adapter as unknown as { model: string }).model;
    expect(meetsFloor(model), `default model ${model} is below the gpt-5.5 floor`).toBe(true);
  });

  it('pins -c model_reasoning_effort=high on the argv by default', () => {
    const adapter = new CodexCliHarnessAdapter({});
    const args = (adapter as unknown as { buildArgs(w: string, m: string): string[] }).buildArgs('/tmp/w', 'gpt-5.5');
    const at = args.indexOf('-c');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('model_reasoning_effort=high');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5');
  });

  it('honours CODEX_REASONING_EFFORT and an explicit config override', () => {
    process.env.CODEX_REASONING_EFFORT = 'medium';
    const fromEnv = new CodexCliHarnessAdapter({});
    const envArgs = (fromEnv as unknown as { buildArgs(w: string, m: string): string[] }).buildArgs('/tmp/w', 'gpt-5.4');
    expect(envArgs).toContain('model_reasoning_effort=medium');

    const fromConfig = new CodexCliHarnessAdapter({ reasoningEffort: 'xhigh' });
    const cfgArgs = (fromConfig as unknown as { buildArgs(w: string, m: string): string[] }).buildArgs('/tmp/w', 'gpt-5.5');
    expect(cfgArgs).toContain('model_reasoning_effort=xhigh');
  });
});

describe('JS wrapper (bot-node path) — pinned effort reaches the real spawn argv', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['CODEX_MODEL', 'CODEX_REASONING_EFFORT', 'CODEX_SANDBOX_MODE', 'DEMO_MODE', 'OSHAL_OPERATOR_SUBS'];

  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  /** @description Minimal fake `codex` child: streams nothing, exits 0 on the next tick. */
  function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { end(s?: string): void }; kill(): void } {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; stdin: { end(s?: string): void }; kill(): void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => { setImmediate(() => child.emit('close', 0)); } };
    child.kill = () => { /* the run exits on its own */ };
    return child;
  }

  it('defaults to gpt-5.5/high and passes both to codex exec', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const CodexCLIWrapper = require('../../any-bot/server/services/codebase/CodexCLIWrapper');

    // The SEC-05 spawn gate (assert-cli-tool-boundary) admits only a demo-deployment
    // operator launch — satisfy it the same way the live handler does, via extraEnv.
    process.env.DEMO_MODE = 'true';
    process.env.OSHAL_OPERATOR_SUBS = 'spec-operator';

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-floor-spec-'));
    const captured: string[][] = [];
    const wrapper = new CodexCLIWrapper({
      authSourcePath: path.join(workspace, 'auth-source', 'auth.json'),
      spawnImpl: (_cmd: string, args: string[]) => { captured.push(args); return fakeChild(); },
    });

    expect(wrapper.model).toBe('gpt-5.5');
    expect(wrapper.reasoningEffort).toBe('high');

    try {
      await wrapper.executeTask('say ok', workspace, { extraEnv: { OSHAL_USER_SUB: 'spec-operator' } });
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }

    expect(captured.length).toBe(1);
    const args = captured[0];
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5');
    const at = args.indexOf('-c');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe('model_reasoning_effort=high');
  });
});

describe('compose fleet defaults — the self-install contract', () => {
  const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.oshal-local.yml'), 'utf8');

  it('defaults the fleet provider to openai-codex', () => {
    expect(compose).toMatch(/FORCE_LLM_PROVIDER: \$\{FORCE_LLM_PROVIDER:-openai-codex\}/);
    expect(compose).toMatch(/^\s*LLM_PROVIDER: openai-codex$/m);
  });

  it('defaults every codex model knob at or above the gpt-5.5 floor', () => {
    const codexDefault = /CODEX_MODEL: \$\{CODEX_MODEL:-([^}]+)\}/.exec(compose);
    expect(codexDefault, 'CODEX_MODEL interpolation default missing').not.toBeNull();
    expect(meetsFloor(codexDefault![1]), `CODEX_MODEL default ${codexDefault![1]} below floor`).toBe(true);

    const forceDefault = /FORCE_LLM_MODEL: \$\{FORCE_LLM_MODEL:-([^}]+)\}/.exec(compose);
    expect(forceDefault, 'FORCE_LLM_MODEL interpolation default missing').not.toBeNull();
    expect(meetsFloor(forceDefault![1]), `FORCE_LLM_MODEL default ${forceDefault![1]} below floor`).toBe(true);
  });

  it('pins the reasoning-effort knob with a fleet-safe default', () => {
    expect(compose).toMatch(/CODEX_REASONING_EFFORT: \$\{CODEX_REASONING_EFFORT:-high\}/);
  });

  it('never re-defaults to gpt-5.3-codex — the API-key-only name a ChatGPT login 400s on', () => {
    expect(compose).not.toMatch(/:-gpt-5\.3-codex\}/);
    const bootSync = fs.readFileSync(path.join(REPO_ROOT, 'src', 'app', 'extensions', 'swarm', 'index.ts'), 'utf8');
    expect(bootSync).not.toContain("'gpt-5.3-codex'");
  });
});
