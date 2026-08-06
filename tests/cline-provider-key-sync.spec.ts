/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Coverage for the UI-entered-key gap: every persisted provider API key (not just Anthropic) must reach Cline data/secrets.json so the CLI actually authenticates with the chosen provider
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: invert the retired key-copy expectation and prove persisted provider credentials stay in encrypted server storage while Cline files are non-secret, plan-only tombstones.
 */

import { expect, test } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ClineRuntimeConfigSyncService } from '../src/features/llm-provider/services/cline-runtime-config-sync-service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EncryptedConfigManager } = require('../src/api/encrypted-config-manager');

/**
 * @description Builds disposable encrypted server storage plus a deliberately contaminated
 * legacy Cline directory so runtime sync must remove, rather than copy, credential material.
 */
function buildHarness(secrets: Record<string, unknown>, settings: Record<string, unknown>) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-keysync-'));
  const outputDir = path.join(base, 'output');
  const configDir = path.join(base, '.cline');
  const runtimeSecretsPath = path.join(configDir, 'data', 'secrets.json');
  fs.mkdirSync(path.dirname(runtimeSecretsPath), { recursive: true });

  const mgr = new EncryptedConfigManager(outputDir, 'test-only-encryption-key');
  mgr.saveSecrets(secrets);
  fs.writeFileSync(path.join(outputDir, 'global-config.json'), JSON.stringify(settings, null, 2), 'utf-8');
  fs.writeFileSync(runtimeSecretsPath, JSON.stringify({
    openAiApiKey: 'legacy-openai-runtime-key',
    geminiApiKey: 'legacy-gemini-runtime-key',
  }), 'utf-8');

  const service = new ClineRuntimeConfigSyncService(configDir, outputDir);
  const readJson = (relativePath: string): Record<string, any> =>
    JSON.parse(fs.readFileSync(path.join(configDir, relativePath), 'utf-8')) as Record<string, any>;
  return { base, outputDir, service, readJson };
}

test('persisted provider keys stay out of Cline runtime files', async () => {
  const h = buildHarness(
    {
      openAiApiKey: 'sk-openai-123',
      geminiApiKey: 'gm-456',
      openRouterApiKey: 'or-789',
      '11111111-2222-4333-8444-555555555555': { someUserToken: 'private-user-token' },
    },
    { actModeApiProvider: 'openai', actModeApiModelId: 'gpt-4o', mode: 'act' },
  );
  try {
    h.service.syncFromPersistedConfig('gpt-4o');
    const clineSecrets = h.readJson(path.join('data', 'secrets.json'));
    const runtimeText = JSON.stringify({
      config: h.readJson('config.json'),
      globalState: h.readJson(path.join('data', 'globalState.json')),
      secrets: clineSecrets,
    });

    expect(clineSecrets).toEqual({});
    expect(runtimeText).not.toContain('sk-openai-123');
    expect(runtimeText).not.toContain('gm-456');
    expect(runtimeText).not.toContain('or-789');
    expect(runtimeText).not.toContain('private-user-token');
    expect(fs.existsSync(path.join(h.outputDir, 'secrets.enc.json'))).toBe(true);
    expect(fs.existsSync(path.join(h.outputDir, 'secrets.json'))).toBe(false);
  } finally {
    fs.rmSync(h.base, { recursive: true, force: true });
  }
});

test('persisted provider/model selection becomes plan-only no-approval metadata', async () => {
  const h = buildHarness(
    { geminiApiKey: 'gm-abc' },
    { actModeApiProvider: 'gemini', actModeApiModelId: 'gemini-2.5-flash', mode: 'act' },
  );
  const priorForceProvider = process.env.FORCE_LLM_PROVIDER;
  const priorForceModel = process.env.FORCE_LLM_MODEL;
  delete process.env.FORCE_LLM_PROVIDER;
  delete process.env.FORCE_LLM_MODEL;
  try {
    const selection = h.service.syncFromPersistedConfig('gemini-2.5-flash');
    const config = h.readJson('config.json');
    const globalState = h.readJson(path.join('data', 'globalState.json'));

    expect(selection.provider).toBe('gemini');
    expect(selection.model).toBe('gemini-2.5-flash');
    expect(config.autoApprove).toBe(false);
    expect(globalState.mode).toBe('plan');
    expect(globalState.yoloModeToggled).toBe(false);
    expect(globalState.autoApprovalSettings.enabled).toBe(false);
    expect(Object.values(globalState.autoApprovalSettings.actions)).toEqual(
      expect.arrayContaining([false]),
    );
    expect(Object.values(globalState.autoApprovalSettings.actions).every((value) => value === false)).toBe(true);
    expect(h.readJson(path.join('data', 'secrets.json'))).toEqual({});
  } finally {
    if (priorForceProvider === undefined) delete process.env.FORCE_LLM_PROVIDER;
    else process.env.FORCE_LLM_PROVIDER = priorForceProvider;
    if (priorForceModel === undefined) delete process.env.FORCE_LLM_MODEL;
    else process.env.FORCE_LLM_MODEL = priorForceModel;
    fs.rmSync(h.base, { recursive: true, force: true });
  }
});
