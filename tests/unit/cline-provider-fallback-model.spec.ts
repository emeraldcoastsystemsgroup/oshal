/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the failover model mismatch measured 2026-09-17 23:16:33Z: ClineProvider was constructed with the fleet default (LLM_MODEL=gpt-5.5, the Codex primary's model), the wrapper resolved the backing provider to gemini from the persisted global-config.json, and the spawn carried `-m gpt-5.5` to Gemini - `models/gpt-5.5 is not found for API version v1beta`, ticket escalated. Drives the REAL ClineProvider and the REAL wrapper resolver against a REAL global-config.json on disk, and asserts what reaches the wrapper's executeTask seam and the model gate. The CLI spawn itself is outside this boundary (the wrapper's executeTask is replaced with a recorder); the launcher is proved by scripts/check-cline-entrypoint.mjs against the artifact.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

/** @description Every env key the provider, wrapper and resolver read, saved and restored per case. */
const ENV_KEYS = [
  'HOME', 'CONFIG_OUTPUT_DIR', 'CLINE_API_PROVIDER', 'CLINE_API_MODEL',
  'FORCE_LLM_PROVIDER', 'LLM_PROVIDER', 'FORCE_LLM_MODEL', 'LLM_MODEL', 'AWS_REGION',
  'DEMO_MODE', 'OSHAL_OPERATOR_SUBS', 'MOCK_OIDC',
] as const;

/** @description The deployment operator on the ADR-127 demo box - the only subject the CLI carve admits. */
const OPERATOR = 'operator-subject-for-this-spec';
/** @description The call options the bot-node handler threads: the subject rides in the spawn env, never a caller flag. */
const callOptions = (workspaceDir: string) => ({ workspaceDir, extraEnv: { OSHAL_USER_SUB: OPERATOR } });

let saved: Record<string, string | undefined> = {};
let scratch: string;
let configDir: string;

/** @description Writes the persisted cockpit config the resolver reads. */
function writeGlobalConfig(body: Record<string, unknown>): void {
  writeFileSync(join(configDir, 'global-config.json'), JSON.stringify(body), 'utf8');
}

type Recorded = { model: string | undefined; gated: string | undefined };

/**
 * @description Builds a real ClineProvider with the fleet default the startup module passes,
 * replaces ONLY the wrapper's executeTask seam with a recorder, and patches the gate module's
 * export so the case records what model was gated without reaching the controller.
 * @param fleetModel The model startup-core-services hands the provider (config.llm.defaultModel).
 * @returns The provider and the recorder.
 */
function providerWithRecorder(fleetModel: string): { provider: any; recorded: Recorded } {
  const ClineProvider = require_('../../any-bot/server/services/llm/ClineProvider');
  const gateModule = require_('../../any-bot/server/services/llm/llmGate');
  const recorded: Recorded = { model: undefined, gated: undefined };
  gateModule.gateLlmCall = async (model: string) => { recorded.gated = model; return { allowed: true, model, reason: 'ok' }; };
  const provider = new ClineProvider({ model: fleetModel, timeout: 5, inactivityTimeout: 5 });
  provider.wrapper.executeTask = async (_task: string, _dir: string, options: { model?: string }) => {
    recorded.model = options.model;
    return { success: true, output: 'OK', activityStats: {} };
  };
  return { provider, recorded };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  scratch = mkdtempSync(join(tmpdir(), 'oshal-cline-fallback-'));
  configDir = join(scratch, 'output');
  require_('node:fs').mkdirSync(configDir, { recursive: true });
  process.env.HOME = scratch;               // the wrapper seeds ~/.cline here, never the real home
  process.env.CONFIG_OUTPUT_DIR = configDir;
  process.env.FORCE_LLM_PROVIDER = 'openai-codex';
  process.env.LLM_MODEL = 'gpt-5.5';        // the Codex fleet's primary model, as on the box
  process.env.DEMO_MODE = 'true';           // the box's posture: the ADR-127 carve admits the operator only
  process.env.OSHAL_OPERATOR_SUBS = OPERATOR;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe('ClineProvider - the model handed to the Cline fallback is the backing provider\'s', () => {
  it('passes the persisted gemini model, not the fleet default gpt-5.5, when global-config.json names it', async () => {
    writeGlobalConfig({ actModeApiProvider: 'gemini', actModeApiModelId: 'gemini-3.8-flash' });
    const { provider, recorded } = providerWithRecorder('gpt-5.5');
    await provider.generateResponse([{ role: 'user', content: 'Reply OK' }], callOptions(scratch));
    expect(recorded.model).toBe('gemini-3.8-flash');
    expect(recorded.gated).toBe('gemini-3.8-flash');
  });

  it('lets CLINE_API_MODEL pin the harness ahead of the persisted config', async () => {
    writeGlobalConfig({ actModeApiProvider: 'gemini', actModeApiModelId: 'gemini-3.8-flash' });
    process.env.CLINE_API_PROVIDER = 'openrouter';
    process.env.CLINE_API_MODEL = 'google/gemini-3.8-flash';
    const { provider, recorded } = providerWithRecorder('gpt-5.5');
    await provider.generateResponse([{ role: 'user', content: 'Reply OK' }], callOptions(scratch));
    expect(recorded.model).toBe('google/gemini-3.8-flash');
  });

  it('keeps the constructor model when no configuration names a backing model (byte-identical to before)', async () => {
    writeGlobalConfig({ actModeApiProvider: 'gemini' });
    delete process.env.LLM_MODEL;
    const { provider, recorded } = providerWithRecorder('gpt-5.5');
    await provider.generateResponse([{ role: 'user', content: 'Reply OK' }], callOptions(scratch));
    expect(recorded.model).toBe('gpt-5.5');
  });

  it('reports the model that actually ran on the response, so the cost row is not billed to the wrong model', async () => {
    writeGlobalConfig({ actModeApiProvider: 'gemini', actModeApiModelId: 'gemini-3.8-flash' });
    const { provider } = providerWithRecorder('gpt-5.5');
    const response = await provider.generateResponse([{ role: 'user', content: 'Reply OK' }], callOptions(scratch));
    expect(response.model).toBe('gemini-3.8-flash');
    expect(response.provider).toBe('cline-cli');
  });

  it('still refuses the launch for a non-operator subject - resolving the model does not widen the carve', async () => {
    writeGlobalConfig({ actModeApiProvider: 'gemini', actModeApiModelId: 'gemini-3.8-flash' });
    const { provider, recorded } = providerWithRecorder('gpt-5.5');
    await expect(provider.generateResponse([{ role: 'user', content: 'Reply OK' }], { workspaceDir: scratch, extraEnv: { OSHAL_USER_SUB: 'someone-else' } }))
      .rejects.toThrow(/autonomous CLI launch denied/);
    expect(recorded.model).toBeUndefined();
    expect(recorded.gated).toBeUndefined();
  });
});
