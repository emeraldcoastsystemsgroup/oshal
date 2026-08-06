/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | SEC-05 closure: prove Haven direct-model compatibility paths and compiled-runtime patchers cannot read credentials or bypass the accounted provider runtime.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  havenGoogleChat,
  havenLlmChat,
} from '@/features/haven';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Haven direct-model boundary', () => {
  it.each([
    ['Gemini', () => havenGoogleChat('system', [{ role: 'user' as const, content: 'hello' }])],
    ['OpenAI', () => havenLlmChat('system', [{ role: 'user' as const, content: 'hello' }], true)],
  ])('rejects retired %s entry before credential or network access', async (_label, invoke) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubEnv('GOOGLE_API_KEY', 'must-not-be-read');
    vi.stubEnv('OPENAI_API_KEY', 'must-not-be-read');

    await expect(invoke()).rejects.toMatchObject({ code: 'UNBROKERED_DIRECT_MODEL_CALL' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ships no Cline-secret reader, environment-key bypass, or active runtime patcher', () => {
    const directSource = fs.readFileSync(
      path.join(process.cwd(), 'src/features/haven/haven-direct-llm-service.ts'),
      'utf8',
    );
    const personaSource = fs.readFileSync(
      path.join(process.cwd(), 'src/features/haven/haven-persona-service.ts'),
      'utf8',
    );
    const patchSources = [
      'patch-haven-anthropic.js',
      'patch-haven-gemini-v2.js',
      'patch-haven-gemini.js',
      'patch-haven-direct.js',
      'patch-haven-revert.js',
    ].map((file) => fs.readFileSync(path.join(process.cwd(), 'scripts', file), 'utf8'));

    expect(directSource).not.toContain('.cline/data/secrets.json');
    expect(directSource).not.toContain('GOOGLE_API_KEY');
    expect(directSource).not.toContain('Authorization');
    expect(personaSource).not.toContain('new CodexHarnessProvider');
    expect(personaSource).not.toContain('new ClaudeCodeCliProvider');
    for (const source of patchSources) {
      expect(source).toContain('process.exitCode = 73');
      expect(source).not.toContain('readFileSync');
      expect(source).not.toContain('OPENAI_API_KEY');
      expect(source).not.toContain('GOOGLE_API_KEY');
      expect(source).not.toContain('openai-codex-oauth-credentials');
    }
  });
});
