/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the codex dead-seed audit: every codex OAuth consumer must resolve the LIVE ~/.codex/auth.json (rotated + written back by the harness) before the never-rotated config-seed copy. Goes red if getSwarmApiKey('openai') or ClineRuntimeConfigSyncService.syncOpenAiCodexCredentials ever reverts to seed-first resolution — the failure mode that pinned Cline/Haven to an expired token forever while codex auth was healthy.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSwarmApiKey } from '../../src/features/llm-provider/services/swarm-credentials';
import { ClineRuntimeConfigSyncService } from '../../src/features/llm-provider/services/cline-runtime-config-sync-service';

const FRESH_LIVE_TOKEN = 'FRESH-LIVE-ACCESS-TOKEN';
const STALE_SEED_TOKEN = 'STALE-SEED-ACCESS-TOKEN';

const ENV_KEYS = [
  'CODEX_AUTH_SOURCE_PATH',
  'OPENAI_CODEX_SHARED_SEED_PATH',
  'OSHAL_SEED_SECRETS_PATH',
  'OSHAL_GLOBAL_CONFIG_PATH',
  'OPENAI_API_KEY',
] as const;

describe('codex seed liveness — live ~/.codex/auth.json beats the never-rotated config-seed', () => {
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

  /**
   * Writes a native-CLI-shaped live auth.json (the shape codex login produces).
   * @param withTopLevelApiKey - Also writes a top-level OPENAI_API_KEY string. getSwarmApiKey's
   *   live read currently resolves the flat OPENAI_API_KEY field but NOT the nested
   *   `{ tokens: { access_token } }` OAuth shape (extractOpenAiCodexAccessToken only unwraps
   *   `tokens` beneath its two named blob keys) — a swarm-credentials.ts gap outside this fix's
   *   scope, reported separately. The ordering guard here uses the flat field.
   */
  function writeLiveAuthJson(withTopLevelApiKey = false): void {
    fs.writeFileSync(liveAuthPath, JSON.stringify({
      ...(withTopLevelApiKey ? { OPENAI_API_KEY: FRESH_LIVE_TOKEN } : {}),
      tokens: {
        access_token: FRESH_LIVE_TOKEN,
        refresh_token: 'fresh-live-refresh',
        account_id: 'acct-live-123',
      },
      last_refresh: '2026-07-24T12:00:00.000Z',
    }, null, 2));
  }

  /** Reads the codex OAuth blob the sync service wrote into Cline data/secrets.json. */
  function readSyncedBlob(): Record<string, unknown> {
    const secretsFile = path.join(clineDir, 'data', 'secrets.json');
    const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf-8')) as Record<string, unknown>;
    const raw = secrets['openai-codex-oauth-credentials'];
    expect(typeof raw).toBe('string');
    return JSON.parse(raw as string) as Record<string, unknown>;
  }

  it('getSwarmApiKey(openai) returns the fresh live token, not the stale seed copy', () => {
    writeLiveAuthJson(true);

    expect(getSwarmApiKey('openai')).toBe(FRESH_LIVE_TOKEN);
  });

  it('getSwarmApiKey(openai) still falls back to the seed when the live source is missing', () => {
    // No live auth.json written.
    expect(getSwarmApiKey('openai')).toBe(STALE_SEED_TOKEN);
  });

  it('syncOpenAiCodexCredentials writes the LIVE token into Cline secrets when the envelope is empty', () => {
    writeLiveAuthJson();

    const service = new ClineRuntimeConfigSyncService(clineDir, outputDir);
    const synced = service.syncOpenAiCodexCredentials(null);

    expect(synced).toBe(true);
    const blob = readSyncedBlob();
    expect(blob.access_token).toBe(FRESH_LIVE_TOKEN);
    expect(blob.access_token).not.toBe(STALE_SEED_TOKEN);
    expect(blob.refresh_token).toBe('fresh-live-refresh');
    expect(blob.accountId).toBe('acct-live-123');
    // A partial mapping (missing expires) trips normalizeOpenAiCodexCredentials and silently
    // falls back to null → the dead seed; the blob must always carry a numeric expiry.
    expect(typeof blob.expires).toBe('number');
    expect(Number.isFinite(blob.expires)).toBe(true);
  });

  it('syncOpenAiCodexCredentials still seeds fresh installs from config-seed when no live source exists', () => {
    // No live auth.json written — the sanctioned bootstrap path must keep working.
    const service = new ClineRuntimeConfigSyncService(clineDir, outputDir);
    const synced = service.syncOpenAiCodexCredentials(null);

    expect(synced).toBe(true);
    const blob = readSyncedBlob();
    expect(blob.access_token).toBe(STALE_SEED_TOKEN);
  });
});
