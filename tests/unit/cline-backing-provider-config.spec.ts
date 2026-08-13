/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard ClineCLIWrapper._resolveBackingProvider (any-bot JS layer). Operator directive 2026-08-13: nothing is hardcoded — configuration decides and the swarm env file is the fallback. This file used to bake in provider 'claude-code' + model 'claude-sonnet-4-5-20250929' and THROW if the write-verify read back anything else, so a deployment could not move Cline off a cancelled subscription without editing source. Drives the REAL resolver against a REAL config file on disk through the full precedence chain, including the no-configuration refusal.
 */

/**
 * @description
 * Precedence contract for the provider Cline drives:
 *   CLINE_API_PROVIDER → global-config.json → FORCE_LLM_PROVIDER → LLM_PROVIDER → refuse.
 * No vendor literal may terminate that chain.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);

/** @description The env keys this resolver reads, saved and restored around every case. */
const ENV_KEYS = [
  'CLINE_API_PROVIDER', 'CLINE_API_MODEL', 'CONFIG_OUTPUT_DIR',
  'FORCE_LLM_PROVIDER', 'LLM_PROVIDER', 'FORCE_LLM_MODEL', 'LLM_MODEL',
] as const;

let saved: Record<string, string | undefined> = {};
let configDir: string;

/**
 * @description Builds a wrapper instance without running the constructor — the constructor
 * spawns/seeds config, which is not what this contract is about.
 * @returns An object exposing the real prototype method under test.
 */
function resolver(): { _resolveBackingProvider: () => { provider: string; model: string } } {
  // module.exports IS the class (not a named export) — bind to it directly.
  const ClineCLIWrapper = require_('../../any-bot/server/services/codebase/ClineCLIWrapper');
  return Object.create(ClineCLIWrapper.prototype);
}

/** @description Writes a global-config.json the resolver will read. */
function writeConfig(body: Record<string, unknown>): void {
  writeFileSync(join(configDir, 'global-config.json'), JSON.stringify(body), 'utf8');
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  configDir = mkdtempSync(join(tmpdir(), 'oshal-cline-cfg-'));
  process.env.CONFIG_OUTPUT_DIR = configDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  rmSync(configDir, { recursive: true, force: true });
});

describe('Cline backing provider — configuration, never a literal', () => {
  it('reads the persisted global-config.json the cockpit writes', () => {
    writeConfig({ mode: 'act', actModeApiProvider: 'openai-codex', actModeApiModelId: 'gpt-5.5' });
    expect(resolver()._resolveBackingProvider()).toEqual({ provider: 'openai-codex', model: 'gpt-5.5' });
  });

  it('honours plan mode against the same file', () => {
    writeConfig({ mode: 'plan', planModeApiProvider: 'claude-code', planModeApiModelId: 'a-model' });
    expect(resolver()._resolveBackingProvider()).toEqual({ provider: 'claude-code', model: 'a-model' });
  });

  it('falls back to the swarm env file when no config has been set up', () => {
    process.env.LLM_PROVIDER = 'openai-codex';
    process.env.LLM_MODEL = 'gpt-5.5';
    expect(resolver()._resolveBackingProvider()).toEqual({ provider: 'openai-codex', model: 'gpt-5.5' });
  });

  it('prefers FORCE_* over the plain env keys, matching the rest of the swarm', () => {
    process.env.LLM_PROVIDER = 'claude-code';
    process.env.FORCE_LLM_PROVIDER = 'openai-codex';
    process.env.LLM_MODEL = 'old-model';
    process.env.FORCE_LLM_MODEL = 'gpt-5.5';
    expect(resolver()._resolveBackingProvider()).toEqual({ provider: 'openai-codex', model: 'gpt-5.5' });
  });

  it('lets CLINE_API_PROVIDER pin Cline independently of the fleet', () => {
    writeConfig({ mode: 'act', actModeApiProvider: 'openai-codex', actModeApiModelId: 'gpt-5.5' });
    process.env.FORCE_LLM_PROVIDER = 'openai-codex';
    process.env.CLINE_API_PROVIDER = 'claude-code';
    process.env.CLINE_API_MODEL = 'pinned-model';
    expect(resolver()._resolveBackingProvider()).toEqual({ provider: 'claude-code', model: 'pinned-model' });
  });

  it('config beats the env file — the more specific layer wins', () => {
    writeConfig({ mode: 'act', actModeApiProvider: 'openai-codex' });
    process.env.LLM_PROVIDER = 'claude-code';
    expect(resolver()._resolveBackingProvider().provider).toBe('openai-codex');
  });

  it('REFUSES with an actionable message when nothing is configured — no vendor default', () => {
    // The whole point of the directive: an unconfigured deployment must say so, not silently
    // reach for one vendor's subscription.
    expect(() => resolver()._resolveBackingProvider())
      .toThrow(/Cline backing provider is not configured/);
    expect(() => resolver()._resolveBackingProvider())
      .toThrow(/CLINE_API_PROVIDER.*FORCE_LLM_PROVIDER\/LLM_PROVIDER/s);
  });

  it('survives a malformed config by falling through to the env file', () => {
    writeFileSync(join(configDir, 'global-config.json'), '{ not json', 'utf8');
    process.env.LLM_PROVIDER = 'openai-codex';
    expect(resolver()._resolveBackingProvider().provider).toBe('openai-codex');
  });

  it('never bakes in a vendor: the source carries no provider/model literal in the resolver', () => {
    const src = require_('fs').readFileSync(
      join(process.cwd(), 'any-bot', 'server', 'services', 'codebase', 'ClineCLIWrapper.js'), 'utf8');
    expect(src).not.toContain("'actModeApiProvider': 'claude-code'");
    expect(src).not.toContain("const model = 'claude-sonnet-4-5-20250929'");
    expect(src).not.toContain("provider: 'claude-code',");
  });
});
