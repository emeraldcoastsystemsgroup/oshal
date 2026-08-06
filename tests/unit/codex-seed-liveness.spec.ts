/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the codex dead-seed audit: every codex OAuth consumer must resolve the LIVE ~/.codex/auth.json (rotated + written back by the harness) before the never-rotated config-seed copy. Goes red if getSwarmApiKey('openai') or ClineRuntimeConfigSyncService.syncOpenAiCodexCredentials ever reverts to seed-first resolution — the failure mode that pinned Cline/Haven to an expired token forever while codex auth was healthy.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: preserve live-first server credential resolution while proving the retired Codex-to-Cline compatibility method never materializes either live or seed OAuth credentials and empties legacy Cline secrets.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: make Codex OAuth live-only, prove the native nested token shape works, and prove a stale static seed is never executable fallback authority.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSwarmApiKey } from '../../src/features/llm-provider/services/swarm-credentials';
import { ClineRuntimeConfigSyncService } from '../../src/features/llm-provider/services/cline-runtime-config-sync-service';
import { resolveFreeModel } from '../../src/app/routes/provider-routes';

const FRESH_LIVE_TOKEN = 'FRESH-LIVE-ACCESS-TOKEN';
const STALE_SEED_TOKEN = 'STALE-SEED-ACCESS-TOKEN';

const ENV_KEYS = [
  'CODEX_AUTH_SOURCE_PATH',
  'OPENAI_CODEX_SHARED_SEED_PATH',
  'OSHAL_SEED_SECRETS_PATH',
  'OSHAL_GLOBAL_CONFIG_PATH',
  'OPENAI_API_KEY',
  'FREE_SHARED_MODEL_ENABLED',
] as const;

describe('codex credential liveness — only the rotating native auth source is executable', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let root: string;
  let liveAuthPath: string;
  let seedPath: string;
  let clineDir: string;
  let outputDir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-codex-liveness-'));
    liveAuthPath = path.join(root, 'codex-home', 'auth.json');
    seedPath = path.join(root, 'config-seed', 'secrets.json');
    clineDir = path.join(root, 'cline-runtime');
    outputDir = path.join(root, 'output');
    fs.mkdirSync(path.dirname(liveAuthPath), { recursive: true });
    fs.mkdirSync(path.dirname(seedPath), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    // The stale seed blob — installed once, never rotated.
    fs.writeFileSync(seedPath, JSON.stringify({
      openAiCodexOauthCredentials: JSON.stringify({
        access_token: STALE_SEED_TOKEN,
        refresh_token: 'stale-seed-refresh',
        expires: 1_700_000_000_000,
      }),
    }, null, 2));

    // An empty global-config so getSwarmApiKey cannot pick up a real operator key.
    const globalConfigPath = path.join(root, 'global-config.json');
    fs.writeFileSync(globalConfigPath, JSON.stringify({}));

    process.env.CODEX_AUTH_SOURCE_PATH = liveAuthPath;
    process.env.OPENAI_CODEX_SHARED_SEED_PATH = seedPath;
    process.env.OSHAL_SEED_SECRETS_PATH = seedPath;
    process.env.OSHAL_GLOBAL_CONFIG_PATH = globalConfigPath;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Writes the native nested auth.json shape produced and rotated by the Codex CLI. */
  function writeLiveAuthJson(): void {
    fs.writeFileSync(liveAuthPath, JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        access_token: FRESH_LIVE_TOKEN,
        refresh_token: 'fresh-live-refresh',
        account_id: 'acct-live-123',
      },
      last_refresh: '2026-07-24T12:00:00.000Z',
    }, null, 2));
  }

  /** Reads the legacy Cline secret envelope, treating a never-created file as empty. */
  function readClineSecrets(): Record<string, unknown> {
    const secretsFile = path.join(clineDir, 'data', 'secrets.json');
    if (!fs.existsSync(secretsFile)) return {};
    return JSON.parse(fs.readFileSync(secretsFile, 'utf-8')) as Record<string, unknown>;
  }

  /** Seeds the raw runtime carrier written by releases before SEC-05 containment. */
  function seedLegacyClineSecrets(accessToken: string): void {
    const secretsFile = path.join(clineDir, 'data', 'secrets.json');
    fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
    fs.writeFileSync(secretsFile, JSON.stringify({
      'openai-codex-oauth-credentials': JSON.stringify({ access_token: accessToken }),
    }));
  }

  it('getSwarmApiKey(openai) reads the native nested live token, not the stale seed copy', () => {
    writeLiveAuthJson();

    expect(getSwarmApiKey('openai')).toBe(FRESH_LIVE_TOKEN);
    expect(resolveFreeModel().available).toBe(true);
  });

  it('getSwarmApiKey(openai) fails closed when only a stale seed copy exists', () => {
    expect(getSwarmApiKey('openai')).toBe('');
    expect(resolveFreeModel().available).toBe(false);
  });

  it('getSwarmApiKey(openai) permits an explicit platform API key without reviving the seed', () => {
    process.env.OPENAI_API_KEY = 'explicit-platform-key';
    expect(getSwarmApiKey('openai')).toBe('explicit-platform-key');
    expect(resolveFreeModel().available).toBe(true);
  });

  it('syncOpenAiCodexCredentials rejects live-token materialization and tombstones legacy Cline secrets', () => {
    writeLiveAuthJson();
    seedLegacyClineSecrets('legacy-runtime-token');

    const service = new ClineRuntimeConfigSyncService(clineDir, outputDir);
    const synced = service.syncOpenAiCodexCredentials(null);

    expect(synced).toBe(false);
    expect(readClineSecrets()).toEqual({});
    expect(JSON.stringify(readClineSecrets())).not.toContain(FRESH_LIVE_TOKEN);
  });

  it('syncOpenAiCodexCredentials rejects stale-seed materialization and tombstones legacy Cline secrets', () => {
    // No live auth.json written. Static seed material is non-executable and must never be copied
    // into Cline-owned files.
    seedLegacyClineSecrets(STALE_SEED_TOKEN);
    const service = new ClineRuntimeConfigSyncService(clineDir, outputDir);
    const synced = service.syncOpenAiCodexCredentials(null);

    expect(synced).toBe(false);
    expect(readClineSecrets()).toEqual({});
  });
});
