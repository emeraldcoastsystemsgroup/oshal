/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Coverage for the UI-entered-key gap: every persisted provider API key (not just Anthropic) must reach Cline data/secrets.json so the CLI actually authenticates with the chosen provider
 */

import { expect, test } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ClineRuntimeConfigSyncService } from '../src/features/llm-provider/services/cline-runtime-config-sync-service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');

/**
 * @description Builds isolated temp dirs and seeds a plaintext secrets store + global-config
 * so the runtime sync can be exercised without ~/.cline or the docker stack.
 */
function buildHarness(secrets: Record<string, unknown>, settings: Record<string, unknown>) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-keysync-'));
  const outputDir = path.join(base, 'output');
  const configDir = path.join(base, '.cline');
  fs.mkdirSync(outputDir, { recursive: true });

  // No ENCRYPTION_KEY → plaintext secrets file, matching the service's secrets manager.
  const mgr = new EncryptedConfigManager(outputDir, null);
  mgr.saveSecrets(secrets);
  fs.writeFileSync(path.join(outputDir, 'global-config.json'), JSON.stringify(settings, null, 2), 'utf-8');

  const service = new ClineRuntimeConfigSyncService(configDir, outputDir);
  const readClineSecrets = () =>
    JSON.parse(fs.readFileSync(path.join(configDir, 'data', 'secrets.json'), 'utf-8')) as Record<string, unknown>;
  return { service, readClineSecrets };
}

test('every persisted provider key — not just Anthropic — reaches Cline secrets', async () => {
  const priorEncryptionKey = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  try {
    const h = buildHarness(
      {
        openAiApiKey: 'sk-openai-123',
        geminiApiKey: 'gm-456',
        openRouterApiKey: 'or-789',
        // a per-user OAuth envelope must NOT be flattened into Cline secrets
        '11111111-2222-4333-8444-555555555555': { someUserToken: 'nope' },
      },
      { actModeApiProvider: 'openai', actModeApiModelId: 'gpt-4o', mode: 'act' },
    );

    h.service.syncFromPersistedConfig('gpt-4o');
    const clineSecrets = h.readClineSecrets();

    expect(clineSecrets.openAiApiKey).toBe('sk-openai-123');
    expect(clineSecrets.geminiApiKey).toBe('gm-456');
    expect(clineSecrets.openRouterApiKey).toBe('or-789');
    // user envelope key must not leak into the flat Cline secrets file
    expect(clineSecrets['11111111-2222-4333-8444-555555555555']).toBeUndefined();
  } finally {
    if (priorEncryptionKey !== undefined) process.env.ENCRYPTION_KEY = priorEncryptionKey;
  }
});

test('the persisted provider/model selection is written to Cline runtime config', async () => {
  const priorEncryptionKey = process.env.ENCRYPTION_KEY;
  delete process.env.ENCRYPTION_KEY;
  const priorForce = process.env.FORCE_LLM_PROVIDER;
  delete process.env.FORCE_LLM_PROVIDER;
  try {
    const h = buildHarness(
      { geminiApiKey: 'gm-abc' },
      { actModeApiProvider: 'gemini', actModeApiModelId: 'gemini-2.5-flash', mode: 'act' },
    );

    const selection = h.service.syncFromPersistedConfig('gemini-2.5-flash');
    expect(selection.provider).toBe('gemini');
    expect(selection.model).toBe('gemini-2.5-flash');
    expect(h.readClineSecrets().geminiApiKey).toBe('gm-abc');
  } finally {
    if (priorEncryptionKey !== undefined) process.env.ENCRYPTION_KEY = priorEncryptionKey;
    if (priorForce !== undefined) process.env.FORCE_LLM_PROVIDER = priorForce;
  }
});
