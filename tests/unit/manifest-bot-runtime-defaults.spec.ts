/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify manifest defaults follow the existing deployed mode and hard overrides.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveManifestBotRuntimeDefaults } from '@/app/composition/manifest-bot-runtime-defaults';
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oshal-runtime-defaults-'));
  vi.stubEnv('CONFIG_OUTPUT_DIR', root); vi.stubEnv('FORCE_LLM_PROVIDER', ''); vi.stubEnv('FORCE_LLM_MODEL', '');
  vi.stubEnv('LLM_PROVIDER', 'openai-native'); vi.stubEnv('LLM_MODEL', 'fixture-env-model');
});
afterEach(() => {
  const boundary = relative(resolve(tmpdir()), resolve(root));
  if (!boundary || boundary.startsWith('..')) throw new Error('Invalid temporary fixture path');
  rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});
it('reads the same persisted active provider/model as provider runtime', () => {
  writeFileSync(join(root, 'global-config.json'), JSON.stringify({ mode: 'plan', planModeApiProvider: 'anthropic', planModeApiModelId: 'fixture-plan-model',
    actModeApiProvider: 'openai-native', actModeApiModelId: 'fixture-act-model' }));
  expect(resolveManifestBotRuntimeDefaults()).toEqual({ providerId: 'anthropic', modelId: 'fixture-plan-model' });
});
it('uses explicit deployment overrides without writing config or enabling a harness', () => {
  vi.stubEnv('FORCE_LLM_PROVIDER', 'openai-native'); vi.stubEnv('FORCE_LLM_MODEL', 'fixture-forced-model');
  expect(resolveManifestBotRuntimeDefaults()).toEqual({ providerId: 'openai-native', modelId: 'fixture-forced-model' });
});
it('leaves a different declared provider model unspecified', () => {
  expect(resolveManifestBotRuntimeDefaults('anthropic')).toEqual({ providerId: 'anthropic' });
  expect(resolveManifestBotRuntimeDefaults('openai-native')).toEqual({ providerId: 'openai-native', modelId: 'fixture-env-model' });
});
