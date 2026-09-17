/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the codex fleet default (operator directive 2026-08-12). Pins four invariants: (1) every LLM-harness bot in BOTH registries is codex-cli/openai-codex (a2a is the only exception — an external-agent boundary, not an LLM harness), with hard count floors so an emptied registry can't pass vacuously; (2) the codex model defaults never fall below gpt-5.5 and gpt-5.3-codex (the API-key-only name that 400s on a ChatGPT login) never reappears as a default — compose interpolation defaults included; (3) both codex spawn paths pin `-c model_reasoning_effort` (default high) — asserted on the REAL spawn argv via a stubbed spawnImpl, because the per-task codex home copies the HOST config.toml and a host-side effort tuned for gpt-5.6-sol (ultra) 400s every fleet turn on gpt-5.5/gpt-5.4 (verified live); (4) the compose fleet-provider defaults stay openai-codex.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-128 Amendment 1 guard rows: DEMO_CLI_ORDER is codex-only, a harness-less manifest bot inherits codex-cli, an explicit per-bot claude-code still wins, a stalled codex node never auto-fails-over onto claude-code, and a NAMED claude-code failover still resolves. Mutation-tested: restoring all five defaults turns four rows red.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | INVERTED for ADR-128 Amendment 2 (operator directive 2026-09-17; file renamed from codex-default-floor.spec.ts so history follows it). The fleet brain is Cline backed by Gemini: (1) every LLM-harness bot in BOTH registries is cline/gemini and NOTHING is codex-cli/openai-codex (a2a still the one exception, count floors kept); (4) the compose fleet defaults are gemini / gemini-3.8-flash, LLM_PROVIDER/LLM_MODEL are interpolated the same way, and — the defect that made .env unreachable — no bot service may carry a FORCE_LLM_* literal: a service-level line must be a per-bot knob whose default is the x-bot-env interpolation (mutation-tested: one literal pair on one service turns the row red); the harness-less manifest bot inherits cline/gemini. Kept as-is: the codex model-floor and effort-pin rows (2)(3) still govern the CODEX_MODEL knob for any bot a deployment moves back onto Codex, and the Amendment 1 rows — no automatic chain may default onto claude-code — are unchanged.
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
import { DEMO_CLI_ORDER } from '../../src/app/routes/user-brain-resolution';
import { manifestBotDefinition } from '../../src/app/extensions/swarm/manifest-bot-definition';
import { maybeWrapBotNodeProviderFailover } from '../../src/app/bot-node-runtime';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The fleet brain since 2026-09-17: the generic Cline wrapper backed by Gemini. */
const FLEET_HARNESS = 'cline';
const FLEET_API_TYPE = 'gemini';
const FLEET_MODEL = 'gemini-3.8-flash';

/** The floor the operator set for the CODEX knob: every codex default must be gpt-5.5 or newer. */
const MODEL_FLOOR = { major: 5, minor: 5 };

/** @description True when a codex model id (gpt-<major>.<minor>[-suffix]) meets the codex-knob floor. */
function meetsFloor(model: string): boolean {
  const m = /^gpt-(\d+)\.(\d+)/.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > MODEL_FLOOR.major || (major === MODEL_FLOOR.major && minor >= MODEL_FLOOR.minor);
}

describe('registry fleet default — Cline on Gemini everywhere, a2a excepted', () => {
  const cases = [
    { name: 'canonical', registry: SWARM_BOT_REGISTRY, minFleetBots: 35 },
    { name: 'local', registry: LOCAL_BOT_REGISTRY, minFleetBots: 50 },
  ] as const;

  for (const { name, registry, minFleetBots } of cases) {
    it(`${name} registry declares no LLM harness other than cline`, () => {
      for (const bot of registry) {
        if (bot.harnessType !== undefined) {
          expect([FLEET_HARNESS, 'a2a'], `${bot.name} harnessType`).toContain(bot.harnessType);
        }
        if (bot.apiType !== undefined) {
          expect([FLEET_API_TYPE, 'a2a'], `${bot.name} apiType`).toContain(bot.apiType);
        }
      }
    });

    it(`${name} registry has ZERO bots on the exhausted Codex login`, () => {
      // The Aug-12 literal is what ADR-034 tier 3 stamps on the dispatch record, and a bot whose
      // record says openai-codex refuses or discards work the fleet harness actually completed.
      const onCodex = registry.filter((b) => b.harnessType === 'codex-cli' || b.apiType === 'openai-codex');
      expect(onCodex.map((b) => b.name)).toEqual([]);
    });

    it(`${name} registry keeps a real fleet (count floor, not a vacuous pass)`, () => {
      const fleetBots = registry.filter((b) => b.harnessType === FLEET_HARNESS && b.apiType === FLEET_API_TYPE);
      expect(fleetBots.length).toBeGreaterThanOrEqual(minFleetBots);
    });
  }
});

describe('TS codex adapter (the CODEX_MODEL knob) — model floor + pinned reasoning effort', () => {
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
  const composePath = path.join(REPO_ROOT, 'docker-compose.oshal-local.yml');
  const compose = fs.readFileSync(composePath, 'utf8');

  it('defaults the fleet provider and model to Cline on Gemini', () => {
    expect(compose).toMatch(/^  FORCE_LLM_PROVIDER: \$\{FORCE_LLM_PROVIDER:-gemini\}$/m);
    expect(compose).toMatch(/^  FORCE_LLM_MODEL: \$\{FORCE_LLM_MODEL:-gemini-3\.8-flash\}$/m);
    // The lower-tier fallback pair follows the same knob shape: .env reaches it, a hand-edit is
    // never the way to move a deployment.
    expect(compose).toMatch(/^  LLM_PROVIDER: \$\{LLM_PROVIDER:-gemini\}$/m);
    expect(compose).toMatch(/^  LLM_MODEL: \$\{LLM_MODEL:-gemini-3\.8-flash\}$/m);
    expect(compose).not.toMatch(/^\s*LLM_PROVIDER: openai-codex$/m);
  });

  /**
   * @description The service-level FORCE_LLM_* lines of a compose text. Two-space indent is the
   * x-bot-env anchor (the ONE place the engine may be named); six-space indent is a service's own
   * environment block, which overrides the anchor and is what made .env unreachable for ~20 bots.
   */
  function serviceLevelForceLines(text: string): Array<{ line: number; key: string; value: string }> {
    const out: Array<{ line: number; key: string; value: string }> = [];
    text.split(/\r?\n/).forEach((raw, idx) => {
      const m = /^ {4,}(FORCE_LLM_PROVIDER|FORCE_LLM_MODEL):\s*(.*?)\s*$/.exec(raw);
      if (m) out.push({ line: idx + 1, key: m[1], value: m[2] });
    });
    return out;
  }

  /**
   * @description The compose guard: a bot service may carry a FORCE_LLM_* line ONLY as a per-bot
   * knob whose default is the x-bot-env interpolation — `${<BOT>_LLM_PROVIDER:-${FORCE_LLM_PROVIDER:-…}}`.
   * A literal (`openai-codex`, `gpt-5.5`, `gemini`, anything) or a knob with its own literal default
   * re-creates the Aug-12 shape where .env could not move the fleet.
   */
  function violations(text: string): string[] {
    const knob: Record<string, RegExp> = {
      FORCE_LLM_PROVIDER: /^\$\{[A-Z0-9_]+_LLM_PROVIDER:-\$\{FORCE_LLM_PROVIDER:-[^}]+\}\}$/,
      FORCE_LLM_MODEL: /^\$\{[A-Z0-9_]+_LLM_MODEL:-\$\{FORCE_LLM_MODEL:-[^}]+\}\}$/,
    };
    return serviceLevelForceLines(text)
      .filter(({ key, value }) => !knob[key].test(value))
      .map(({ line, key, value }) => `line ${line}: ${key}: ${value}`);
  }

  it('no bot service carries a FORCE_LLM_* literal — the anchor is the one place the engine is named', () => {
    expect(violations(compose)).toEqual([]);
    // Not vacuous: the per-bot knobs (jarvis, sales) are still service-level lines that pass.
    expect(serviceLevelForceLines(compose).length).toBeGreaterThanOrEqual(2);
  });

  it('the literal guard goes red on exactly the shape it exists to catch (mutation)', () => {
    const mutated = compose.replace(
      /^(  weather-bot:\r?\n(?:.*\r?\n)*?      AGENT_CAPABILITIES: [^\r\n]*\r?\n)/m,
      '$1      FORCE_LLM_PROVIDER: openai-codex\n      FORCE_LLM_MODEL: gpt-5.5\n',
    );
    expect(mutated, 'mutation must have landed on weather-bot').not.toBe(compose);
    const found = violations(mutated);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/FORCE_LLM_PROVIDER: openai-codex$/);
    expect(found[1]).toMatch(/FORCE_LLM_MODEL: gpt-5\.5$/);

    // A per-bot knob that carries its own literal default is the same defect in disguise.
    const knobWithLiteral = compose.replace(
      '${JARVIS_LLM_PROVIDER:-${FORCE_LLM_PROVIDER:-gemini}}',
      '${JARVIS_LLM_PROVIDER:-openai-codex}',
    );
    expect(knobWithLiteral).not.toBe(compose);
    expect(violations(knobWithLiteral)).toHaveLength(1);
  });

  it('keeps the CODEX_MODEL knob at or above the gpt-5.5 floor for any bot moved back onto Codex', () => {
    const codexDefault = /CODEX_MODEL: \$\{CODEX_MODEL:-([^}]+)\}/.exec(compose);
    expect(codexDefault, 'CODEX_MODEL interpolation default missing').not.toBeNull();
    expect(meetsFloor(codexDefault![1]), `CODEX_MODEL default ${codexDefault![1]} below floor`).toBe(true);
  });

  it('pins the reasoning-effort knob with a fleet-safe default', () => {
    expect(compose).toMatch(/CODEX_REASONING_EFFORT: \$\{CODEX_REASONING_EFFORT:-high\}/);
  });

  it('never re-defaults to gpt-5.3-codex — the API-key-only name a ChatGPT login 400s on', () => {
    expect(compose).not.toMatch(/:-gpt-5\.3-codex\}/);
    const bootSync = fs.readFileSync(path.join(REPO_ROOT, 'src', 'app', 'extensions', 'swarm', 'index.ts'), 'utf8');
    expect(bootSync).not.toContain("'gpt-5.3-codex'");
  });

  it('the helm chart mirrors the compose fleet brain (parity claim, not a copy of a stale value)', () => {
    const values = fs.readFileSync(path.join(REPO_ROOT, 'deploy', 'helm', 'oshal', 'values.yaml'), 'utf8');
    expect(values).toMatch(/^  forceLlmProvider: gemini$/m);
    expect(values).toMatch(new RegExp(`^  forceLlmModel: ${FLEET_MODEL.replace('.', '\\.')}$`, 'm'));
  });
});

describe('ADR-128 Amendment 1 — no automatic chain may default to claude-code', () => {
  // The Claude Code subscription is being cancelled. A silent degrade onto it is worse than a
  // visible failure: a successful fallback logs like a success, so the operator discovers it as
  // a billing surprise or a bot that dies on renewal day. Every row here is a REAL call into the
  // shipped resolver, not a substring scan — a comment claiming codex-only proves nothing.

  it('the demo CLI ladder offers codex and nothing else', () => {
    expect(DEMO_CLI_ORDER).toEqual(['openai-codex']);
    expect(DEMO_CLI_ORDER).not.toContain('claude-code');
  });

  it('a manifest bot that declares no harness inherits the fleet brain (Cline on Gemini)', () => {
    // The common store-package shape: a package author omits harnessType entirely. It must land on
    // the same engine as the core fleet — a package bot on the exhausted Codex login is dead the
    // same way the core fleet was.
    const definition = manifestBotDefinition({
      agentId: 'aa000000-0000-0000-0000-0000000000ff',
      name: 'package-bot-without-a-harness',
    } as Parameters<typeof manifestBotDefinition>[0]);

    expect(definition.harnessType).toBe(FLEET_HARNESS);
    expect(definition.apiType).toBe(FLEET_API_TYPE);
  });
  it('an explicit per-bot harness still wins — this amendment moves defaults, not choices', () => {
    const definition = manifestBotDefinition({
      agentId: 'aa000000-0000-0000-0000-0000000000fe',
      name: 'package-bot-that-asked-for-claude',
      harnessType: 'claude-code',
      apiType: 'claude-code',
    } as Parameters<typeof manifestBotDefinition>[0]);

    expect(definition.harnessType).toBe('claude-code');
  });

  it('a stalled codex bot-node never auto-fails-over onto claude-code', () => {
    const priorFallback = process.env.OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER;
    const priorAuto = process.env.OSHAL_PROVIDER_AUTO_FAILOVER;
    delete process.env.OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER;
    delete process.env.OSHAL_PROVIDER_AUTO_FAILOVER;
    try {
      // All three providers initialized — the pre-amendment order picked claude-code here.
      const providers = {
        'claude-code': { name: 'claude-sentinel' },
        'openai-codex': { name: 'codex-sentinel' },
        'cline-cli': { name: 'cline-sentinel' },
      };
      const wrapped = maybeWrapBotNodeProviderFailover({ name: 'codex-primary' }, 'openai-codex', providers);

      expect(wrapped.fallbackName, 'codex must not degrade onto a cancelled subscription').not.toBe('claude-code');
      expect(wrapped.fallback).not.toBe(providers['claude-code']);
      expect(wrapped.fallbackName).toBe('cline-cli');
    } finally {
      if (priorFallback === undefined) delete process.env.OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER;
      else process.env.OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER = priorFallback;
      if (priorAuto === undefined) delete process.env.OSHAL_PROVIDER_AUTO_FAILOVER;
      else process.env.OSHAL_PROVIDER_AUTO_FAILOVER = priorAuto;
    }
  });

  it('an operator who NAMES claude-code as the failover still gets it', () => {
    const prior = process.env.OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER;
    process.env.OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER = 'claude-code';
    try {
      const providers = {
        'claude-code': { name: 'claude-sentinel' },
        'openai-codex': { name: 'codex-sentinel' },
        'cline-cli': { name: 'cline-sentinel' },
      };
      const wrapped = maybeWrapBotNodeProviderFailover({ name: 'codex-primary' }, 'openai-codex', providers);
      expect(wrapped.fallbackName).toBe('claude-code');
    } finally {
      if (prior === undefined) delete process.env.OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER;
      else process.env.OSHAL_PROVIDER_RUNTIME_FALLBACK_PROVIDER = prior;
    }
  });

  it('no source default resolves to claude-code on the sites the amendment names', () => {
    // Belt-and-braces over the two module-level constants a call cannot reach without booting
    // the whole composition root. Narrow and exact: the assignment, not the mere mention.
    const providerRuntime = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'app', 'composition', 'provider-runtime.ts'), 'utf8');
    expect(providerRuntime).toMatch(/process\.env\.LLM_PROVIDER \?\? 'openai-codex'/);
    expect(providerRuntime).not.toMatch(/process\.env\.LLM_PROVIDER \?\? 'claude-code'/);
    expect(providerRuntime).not.toMatch(/process\.env\.LLM_MODEL \|\| 'claude-/);

    const configSync = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'features', 'llm-provider', 'services', 'cline-runtime-config-sync-service.ts'), 'utf8');
    expect(configSync).toMatch(/DEFAULT_PROVIDER = process\.env\.LLM_PROVIDER \|\| 'openai-codex'/);
  });
});
