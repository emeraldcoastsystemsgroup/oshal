/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit guard for resolveHarnessForAgent + the HARNESS_FACTORIES/HARNESS_RUNTIME_DEFAULTS totality (per-bot harnessType override vs the process-level FORCE_LLM_PROVIDER default). Previously exercised only via noop-mode e2e, though this is exactly the wiring that has broken before (a harnessType with no factory silently fell back to the wrong provider).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Module from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// resolveHarnessForAgent reads the swarm registry via a LAZY runtime
// require('@/app/extensions/swarm/swarm-bot-registry'). Under vitest that '@' alias is not
// resolvable by Node's createRequire and vi.mock does not intercept a runtime require, so the
// function's own catch swallows it and returns null for every agent — coverage that proves
// nothing. The fix is a real seam: redirect that exact specifier to a native .js stub whose
// getActiveRegistry() we control. Everything downstream (lookupHarnessFactory, the real
// HARNESS_FACTORIES, HARNESS_RUNTIME_DEFAULTS) runs unmocked, so this exercises the true wiring.
const REGISTRY_SPECIFIER = '@/app/extensions/swarm/swarm-bot-registry';
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-registry-stub-'));
const stubPath = path.join(stubDir, 'registry-stub.js');
fs.writeFileSync(
  stubPath,
  'let reg = [];\nmodule.exports.__setRegistry = (r) => { reg = r; };\nmodule.exports.getActiveRegistry = () => reg;\n',
  'utf8',
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ModuleInternals = Module as any;
const originalResolveFilename = ModuleInternals._resolveFilename;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const registryStub = require(stubPath) as {
  __setRegistry: (r: unknown[]) => void;
  getActiveRegistry: () => unknown[];
};

/** The controlled registry every case below queries. */
const MOCK_REGISTRY = [
  // Bot that OVERRIDES the process default with its own harness.
  { agentId: 'a-noop', name: 'noop-bot', port: 3001, container: 'c', role: 'r', capabilities: [], harnessType: 'noop', apiType: 'noop' },
  // A different harness — proves the override selects the RIGHT harness, not just any.
  { agentId: 'a-codex', name: 'codex-bot', port: 3002, container: 'c', role: 'r', capabilities: [], harnessType: 'codex-cli', apiType: 'openai-codex' },
  // No harnessType at all → caller must fall back to the process-level provider.
  { agentId: 'a-plain', name: 'plain-bot', port: 3003, container: 'c', role: 'r', capabilities: [] },
  // A harnessType with no registered factory → graceful skip (null), never a throw.
  { agentId: 'a-bogus', name: 'bogus-bot', port: 3004, container: 'c', role: 'r', capabilities: [], harnessType: 'not-a-real-harness' },
];

import {
  resolveHarnessForAgent,
  HARNESS_FACTORIES,
  HARNESS_RUNTIME_DEFAULTS,
} from '@/app/composition/provider-runtime';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'harness-resolution-test' });

/** The complete HarnessType union (harness-adapter.ts). Both parallel records must be keyed
 *  by EXACTLY this set — a union member added without a factory OR a runtime-defaults entry is
 *  the maintenance hazard the code comments call out, and this list is what makes it visible. */
const EXPECTED_HARNESS_TYPES = ['a2a', 'claude-code', 'cline', 'codex-cli', 'gemini-cli', 'noop'];

describe('resolveHarnessForAgent — per-bot harness override vs process default', () => {
  // The name-fallback arm reads BOT_NAME/AGENT_ID; clear them so an unknown-agentId lookup
  // can never accidentally match a mock bot by name in a CI env that sets these.
  const savedBotName = process.env.BOT_NAME;
  const savedAgentId = process.env.AGENT_ID;

  beforeAll(() => {
    delete process.env.BOT_NAME;
    delete process.env.AGENT_ID;
    ModuleInternals._resolveFilename = function (request: string, ...rest: unknown[]) {
      if (request === REGISTRY_SPECIFIER) return stubPath;
      return originalResolveFilename.call(this, request, ...rest);
    };
    registryStub.__setRegistry(MOCK_REGISTRY);
  });

  afterAll(() => {
    ModuleInternals._resolveFilename = originalResolveFilename;
    if (savedBotName === undefined) delete process.env.BOT_NAME; else process.env.BOT_NAME = savedBotName;
    if (savedAgentId === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = savedAgentId;
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it('a bot with harnessType OVERRIDES the process default and resolves to THAT harness', () => {
    const codex = resolveHarnessForAgent('a-codex', logger);
    expect(codex).not.toBeNull();
    // The returned service is the codex harness bridge, not the process-level provider —
    // proving the registry harnessType wins over FORCE_LLM_PROVIDER.
    expect(codex!.getProviderName()).toContain('codex-cli');

    const noop = resolveHarnessForAgent('a-noop', logger);
    expect(noop).not.toBeNull();
    expect(noop!.getProviderName()).toBe('noop');
  });

  it('a bot with NO harnessType returns null (caller falls back to the process provider)', () => {
    expect(resolveHarnessForAgent('a-plain', logger)).toBeNull();
  });

  it('an agentId the registry does not know returns null (no override, no throw)', () => {
    expect(resolveHarnessForAgent('a-agent-not-in-registry', logger)).toBeNull();
  });

  it('a harnessType with no registered factory is a graceful skip → null, never a throw', () => {
    // The "Bot has harnessType but no factory found in HARNESS_FACTORIES" branch: it must
    // degrade to the process provider, not crash mid-dispatch.
    expect(() => resolveHarnessForAgent('a-bogus', logger)).not.toThrow();
    expect(resolveHarnessForAgent('a-bogus', logger)).toBeNull();
  });
});

describe('HARNESS_FACTORIES / HARNESS_RUNTIME_DEFAULTS — the mapping is total and in sync', () => {
  it('HARNESS_FACTORIES is keyed by EXACTLY the HarnessType union', () => {
    expect(Object.keys(HARNESS_FACTORIES).sort()).toEqual(EXPECTED_HARNESS_TYPES);
  });

  it('HARNESS_RUNTIME_DEFAULTS covers the SAME set — the two parallel records never drift', () => {
    // Adding a harness means a factory entry AND a runtime-defaults entry. If one is added
    // without the other, resolveHarnessForAgent falls back to the cline defaults silently —
    // this equality is the guard that keeps them lock-step.
    expect(Object.keys(HARNESS_RUNTIME_DEFAULTS).sort()).toEqual(EXPECTED_HARNESS_TYPES);
    expect(Object.keys(HARNESS_RUNTIME_DEFAULTS).sort()).toEqual(Object.keys(HARNESS_FACTORIES).sort());
  });

  it('every harness maps to a callable factory and a complete runtime-defaults entry', () => {
    for (const key of EXPECTED_HARNESS_TYPES) {
      expect(typeof (HARNESS_FACTORIES as Record<string, unknown>)[key], `factory for ${key}`).toBe('function');
      const defaults = (HARNESS_RUNTIME_DEFAULTS as Record<string, { resolveModel: unknown; resolveBinary: unknown }>)[key];
      expect(typeof defaults.resolveModel, `resolveModel for ${key}`).toBe('function');
      expect(typeof defaults.resolveBinary, `resolveBinary for ${key}`).toBe('function');
    }
  });

  it('resolveModel falls back to the system default when the harness has no env override', () => {
    // The noop + cline harnesses carry no model env of their own, so the fallback thunk is
    // returned verbatim — this is the contract resolveHarnessForAgent relies on.
    const fallback = () => 'system-default-model';
    expect(HARNESS_RUNTIME_DEFAULTS.noop.resolveModel(fallback)).toBe('system-default-model');
    expect(HARNESS_RUNTIME_DEFAULTS.cline.resolveModel(fallback)).toBe('system-default-model');
  });
});
