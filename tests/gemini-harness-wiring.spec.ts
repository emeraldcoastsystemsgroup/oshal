/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Source-level lock-ins for gemini-cli harness wiring (ADR-033 Updates section)
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

test.describe('gemini-cli harness wiring', () => {
  test('HarnessType union includes gemini-cli', async () => {
    const src = read('src/features/llm-provider/services/harness-adapter.ts');
    expect(src).toMatch(/export type HarnessType\s*=[^;]+'gemini-cli'/);
  });

  test('GeminiCliHarnessAdapter extends BaseCliHarnessAdapter', async () => {
    const src = read('src/features/llm-provider/services/gemini-cli-harness-adapter.ts');
    expect(src).toMatch(/class GeminiCliHarnessAdapter extends BaseCliHarnessAdapter/);
    expect(src).toMatch(/readonly harnessType\s*=\s*'gemini-cli'\s*as const/);
  });

  test('GeminiCliHarnessAdapter passes the verified flag set (--skip-trust + -p + -m + -o json)', async () => {
    const src = read('src/features/llm-provider/services/gemini-cli-harness-adapter.ts');
    // Verified live against @google/gemini-cli v0.41.2 — these are the
    // flags the adapter must emit. Drift means the adapter would invoke
    // a flag the CLI doesn't accept and codex would silently fail.
    expect(src).toMatch(/['"]--skip-trust['"]/);
    expect(src).toMatch(/['"]-m['"]/);
    expect(src).toMatch(/['"]-p['"]/);
    expect(src).toMatch(/['"]-o['"]/);
    // No --system flag exists on the CLI; system prompts must inline.
    expect(src).not.toMatch(/['"]--system['"]/);
  });

  test('HARNESS_FACTORIES has a gemini-cli entry and is type-checked', async () => {
    const src = read('src/app/composition/provider-runtime.ts');
    expect(src).toMatch(/HARNESS_FACTORIES:\s*Record<HarnessType,\s*HarnessFactory>/);
    expect(src).toMatch(/'gemini-cli':\s*\(cfg/);
    expect(src).toMatch(/new GeminiCliHarnessAdapter/);
  });

  test('HARNESS_RUNTIME_DEFAULTS has a gemini-cli entry with both resolvers', async () => {
    // Refactored 2026-04-25: per-harness modelId/binary lives in
    // HARNESS_RUNTIME_DEFAULTS now (typed Record<HarnessType, …>) instead
    // of parallel if/else chains. Source-level lock-in ensures the
    // gemini-cli arm has both resolvers wired.
    const src = read('src/app/composition/provider-runtime.ts');
    expect(src).toMatch(/HARNESS_RUNTIME_DEFAULTS:\s*Record<HarnessType,/);
    // The gemini-cli entry must reference its env vars.
    const block = src.match(/'gemini-cli':\s*\{[\s\S]*?\}/);
    expect(block, 'gemini-cli entry exists in HARNESS_RUNTIME_DEFAULTS').toBeTruthy();
    expect(block![0]).toContain('GEMINI_MODEL');
    expect(block![0]).toContain('GEMINI_CLI_PATH');
  });

  test('Dockerfile installs @google/gemini-cli', async () => {
    const src = read('Dockerfile.oshal');
    expect(src).toMatch(/@google\/gemini-cli@latest/);
  });

  test('docker-compose declares a gemini auth volume anchor', async () => {
    const src = read('docker-compose.oshal-local.yml');
    expect(src).toMatch(/x-gemini-auth-volume:.*GEMINI_CONFIG_HOST_PATH.*~\/\.gemini.*\/root\/\.gemini:ro/s);
    // Mounted on at least 10 services (every bot container that already had claude-auth).
    const mounts = (src.match(/\*gemini-auth-volume/g) ?? []).length;
    expect(mounts).toBeGreaterThanOrEqual(10);
  });

  test('compose env interpolates GEMINI_API_KEY from GOOGLE_API_KEY fallback', async () => {
    const src = read('docker-compose.oshal-local.yml');
    expect(src).toMatch(/GEMINI_API_KEY:\s*\$\{GEMINI_API_KEY:-\$\{GOOGLE_API_KEY:-\}\}/);
  });

  test('research-bot is registered against the gemini-cli harness', async () => {
    const src = read('src/app/extensions/swarm/swarm-bot-registry-local.ts');
    // The block for research-bot must declare gemini-cli + google-gemini.
    const block = src.match(/name:\s*'research-bot',[\s\S]{0,400}/);
    expect(block, 'research-bot block found').toBeTruthy();
    expect(block![0]).toMatch(/harnessType:\s*'gemini-cli'/);
    expect(block![0]).toMatch(/apiType:\s*'google-gemini'/);
  });

  test('BaseCliHarnessAdapter exists and is the shared subprocess base', async () => {
    const src = read('src/features/llm-provider/services/base-cli-harness-adapter.ts');
    expect(src).toMatch(/abstract class BaseCliHarnessAdapter implements HarnessAdapter/);
    expect(src).toMatch(/protected execCapturing\b/);
    expect(src).toMatch(/protected async execWithTimeout\b/);
    expect(src).toMatch(/protected estimateUsage\b/);
  });

  test('all three CLI adapters extend BaseCliHarnessAdapter (no fresh subprocess plumbing)', async () => {
    for (const f of [
      'src/features/llm-provider/services/codex-cli-harness-adapter.ts',
      'src/features/llm-provider/services/claude-code-cli-harness-adapter.ts',
      'src/features/llm-provider/services/gemini-cli-harness-adapter.ts',
    ]) {
      const src = read(f);
      expect(src, `${f} extends BaseCliHarnessAdapter`).toMatch(/extends BaseCliHarnessAdapter/);
      // None of the adapters should re-import `spawn` from child_process —
      // that's the base's job now.
      expect(src, `${f} does not re-import spawn`).not.toMatch(/from 'child_process'/);
    }
  });
});
