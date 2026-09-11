/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Execute production CI log retention in Git Bash and prove prior per-run failure details survive later results.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

function bash(): string {
  if (process.platform !== 'win32') return 'bash';
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up += 1, dir = dirname(dir)) {
    const candidate = resolve(dir, 'bin/bash.exe'); if (existsSync(candidate)) return candidate;
  }
  throw new Error('Git Bash is required; WSL launcher is not a substitute');
}
describe('local nightly per-run output retention', () => {
  it('keeps stderr and stdout from both failed and passed scheduled invocations with the real exit status', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'oshal-nightly-log-'));
    try {
      const probe = resolve(root, 'probe.sh');
      const helper = resolve(__dirname, '../../scripts/ci/ci-run-log.sh').replaceAll('\\', '/');
      writeFileSync(probe, `#!/usr/bin/env bash\nset -uo pipefail\nSTATE_DIR="$1"\nSCHEDULED=1\nsource "$2"\ninit_run_log\ntrap finish_run_log EXIT\nprintf 'gate detail: %s\\n' "$3"\nprintf 'fixture stderr\\n' >&2\nexit "$4"\n`);
      const invoke = (word: string, exit: number) => spawnSync(bash(), [probe.replaceAll('\\', '/'), root.replaceAll('\\', '/'), helper, word, String(exit)], { encoding: 'utf8', timeout: 15_000 });
      const first = invoke('failed-case', 17); expect(first.status, first.stderr).toBe(17);
      const firstPath = readFileSync(resolve(root, 'ci-local-latest-run.txt'), 'utf8').trim();
      expect(readFileSync(firstPath, 'utf8')).toContain('failed-case');
      const second = invoke('passed-case', 0); expect(second.status, second.stderr).toBe(0);
      const secondPath = readFileSync(resolve(root, 'ci-local-latest-run.txt'), 'utf8').trim();
      expect(firstPath).not.toBe(secondPath);
      expect(readFileSync(firstPath, 'utf8')).toContain('failed-case');
      expect(readFileSync(secondPath, 'utf8')).toContain('fixture stderr');
      expect(readFileSync(resolve(root, 'ci-local-last-run.log'), 'utf8')).toContain('passed-case');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
});
