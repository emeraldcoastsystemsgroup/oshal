/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added provider-runtime regression coverage for explicit Anthropic credential failure and valid secrets-based initialization
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added shared-seed OpenAI Codex credential sync regression coverage for Docker worker runtime refresh
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Updated Anthropic expectations to match ADR-005 Cline-only provider routing instead of removed direct Anthropic provider behavior
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Shared-seed sync spec updated for the live-first resolution chain (619eb60, 2026-07-24): pin CODEX_AUTH_SOURCE_PATH to a nonexistent path so the seed-fallback leg is genuinely exercised — on an operator box the live ~/.codex/auth.json correctly wins and the fixture was never read (spec failed every run since; masked by the dead failure-alert email, fixed 2026-07-25).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: prove the retired shared-seed-to-Cline method returns false and tombstones legacy runtime secrets without consuming or copying the server seed.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect } from '@playwright/test';
import { createRuntimeProviderWithManifest } from '@/app/composition/provider-runtime';
import { ClineRuntimeConfigSyncService } from '@/features/llm-provider/services';

test.describe('provider-runtime auth guard', () => {
  test('routes Anthropic selection through the Cline runtime even without direct env credentials', async () => {
    const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-provider-runtime-no-key-'));
    const previousConfigOutputDir = process.env.CONFIG_OUTPUT_DIR;
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

    delete process.env.ANTHROPIC_API_KEY;
    process.env.CONFIG_OUTPUT_DIR = tempConfigDir;

    try {
      const provider = createRuntimeProviderWithManifest('anthropic');
      expect(provider.getProviderName()).toBe('claude-code');
    } finally {
      if (previousConfigOutputDir === undefined) {
        delete process.env.CONFIG_OUTPUT_DIR;
      } else {
        process.env.CONFIG_OUTPUT_DIR = previousConfigOutputDir;
      }

      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
      }

      fs.rmSync(tempConfigDir, { recursive: true, force: true });
    }
  });

  test('keeps Anthropic selection routed through Cline when secrets.json has anthropicApiKey', async () => {
    const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-provider-runtime-with-key-'));
    const previousConfigOutputDir = process.env.CONFIG_OUTPUT_DIR;
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

    delete process.env.ANTHROPIC_API_KEY;
    process.env.CONFIG_OUTPUT_DIR = tempConfigDir;
    fs.writeFileSync(
      path.join(tempConfigDir, 'secrets.json'),
      JSON.stringify({ anthropicApiKey: 'sk-ant-test-local' }, null, 2),
      'utf8',
    );

    try {
      const provider = createRuntimeProviderWithManifest('anthropic');
      expect(provider.getProviderName()).toBe('claude-code');
    } finally {
      if (previousConfigOutputDir === undefined) {
        delete process.env.CONFIG_OUTPUT_DIR;
      } else {
        process.env.CONFIG_OUTPUT_DIR = previousConfigOutputDir;
      }

      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
      }

      fs.rmSync(tempConfigDir, { recursive: true, force: true });
    }
  });

  test('does not materialize OpenAI Codex credentials from the shared server seed', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-provider-runtime-shared-seed-runtime-'));
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-provider-runtime-shared-seed-output-'));
    const sharedSeedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-provider-runtime-shared-seed-root-'));
    const sharedSeedPath = path.join(sharedSeedDir, 'secrets.json');
    const previousSharedSeedPath = process.env.OPENAI_CODEX_SHARED_SEED_PATH;
    const previousCodexAuthSourcePath = process.env.CODEX_AUTH_SOURCE_PATH;
    process.env.CODEX_AUTH_SOURCE_PATH = path.join(sharedSeedDir, 'no-live-auth', 'auth.json');

    fs.mkdirSync(path.join(runtimeRoot, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(runtimeRoot, 'data', 'secrets.json'),
      JSON.stringify({ 'openai-codex-oauth-credentials': 'legacy-runtime-token' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(outputRoot, 'global-config.json'),
      JSON.stringify({
        actModeApiProvider: 'claude-code',
        actModeApiModelId: 'gpt-5.3-codex',
      }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      sharedSeedPath,
      JSON.stringify({
        openAiCodexOauthCredentials: JSON.stringify({
          accessToken: 'shared-access-token',
          refreshToken: 'shared-refresh-token',
          expiresAt: Date.now() + 60_000,
          accountId: 'acct-shared-seed',
        }),
      }, null, 2),
      'utf8',
    );
    process.env.OPENAI_CODEX_SHARED_SEED_PATH = sharedSeedPath;

    try {
      const runtimeSyncService = new ClineRuntimeConfigSyncService(runtimeRoot, outputRoot);
      const synced = runtimeSyncService.syncOpenAiCodexCredentials();
      const runtimeSecretsPath = path.join(runtimeRoot, 'data', 'secrets.json');
      const runtimeSecrets = JSON.parse(fs.readFileSync(runtimeSecretsPath, 'utf8')) as Record<string, string>;

      expect(synced).toBe(false);
      expect(runtimeSecrets).toEqual({});
      expect(fs.readFileSync(sharedSeedPath, 'utf8')).toContain('shared-access-token');
      expect(fs.readFileSync(sharedSeedPath, 'utf8')).not.toContain('legacy-runtime-token');
    } finally {
      if (previousSharedSeedPath === undefined) {
        delete process.env.OPENAI_CODEX_SHARED_SEED_PATH;
      } else {
        process.env.OPENAI_CODEX_SHARED_SEED_PATH = previousSharedSeedPath;
      }
      if (previousCodexAuthSourcePath === undefined) {
        delete process.env.CODEX_AUTH_SOURCE_PATH;
      } else {
        process.env.CODEX_AUTH_SOURCE_PATH = previousCodexAuthSourcePath;
      }

      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      fs.rmSync(outputRoot, { recursive: true, force: true });
      fs.rmSync(sharedSeedDir, { recursive: true, force: true });
    }
  });
});
