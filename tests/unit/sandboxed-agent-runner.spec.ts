/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Tests for the ADR-077 Phase 2 Slice 2 Sandboxed Agent Runner. Change-set extraction is pure; container isolation tests skip when Docker is unavailable.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SandboxedAgentRunner } from '@/features/dev-console';

const runner = new SandboxedAgentRunner();

describe('SandboxedAgentRunner — change-set extraction (no docker)', () => {
  it('extracts new/changed text files, reports deletions, skips binary + ignored dirs', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sar-'));
    try {
      writeFileSync(path.join(dir, 'a.txt'), 'A0');
      writeFileSync(path.join(dir, 'b.txt'), 'B0');
      mkdirSync(path.join(dir, 'node_modules'));
      writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'ignored');
      const before = runner.snapshot(dir);

      writeFileSync(path.join(dir, 'a.txt'), 'A1');                       // changed
      mkdirSync(path.join(dir, 'sub'));
      writeFileSync(path.join(dir, 'sub', 'c.txt'), 'C');                 // new
      rmSync(path.join(dir, 'b.txt'));                                    // deleted
      writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 2, 0, 3])); // binary
      writeFileSync(path.join(dir, 'node_modules', 'y.js'), 'still ignored');

      const cs = runner.extractChangeSet(dir, before);
      expect(cs.edits.map((e) => e.path).sort()).toEqual(['a.txt', 'sub/c.txt']);
      expect(cs.edits.find((e) => e.path === 'a.txt')?.content).toBe('A1');
      expect(cs.deleted).toEqual(['b.txt']);
      expect(cs.skippedBinary).toEqual(['bin.dat']);
      expect(cs.edits.some((e) => e.path.includes('node_modules'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// sandboxUsable() (not dockerAvailable()) so these skip on engines where Docker responds
// but the /work bind mount is not writable by the container user — e.g. CI's userns-remapped
// daemon. See SandboxedAgentRunner.sandboxUsable().
const hasDocker = SandboxedAgentRunner.sandboxUsable();

describe('SandboxedAgentRunner — container isolation (needs docker)', () => {
  (hasDocker ? it : it.skip)('self-test reports every escape blocked', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sar-iso-'));
    try {
      const report = runner.selfTestIsolation(dir);
      expect(report.workWritable).toBe(true);
      expect(report.rootReadOnly).toBe(true);
      expect(report.networkBlocked).toBe(true);
      expect(report.hostFsInvisible).toBe(true);
      expect(report.credsInvisible).toBe(true);
      expect(report.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  (hasDocker ? it : it.skip)('runs a benign edit in the sandbox and extracts it as a change set', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sar-run-'));
    try {
      writeFileSync(path.join(dir, 't.txt'), 'orig\n');
      const before = runner.snapshot(dir);
      const result = runner.run(dir, ['sh', '-c', 'echo done > /work/t.txt'], 60_000);
      expect(result.exitCode).toBe(0);
      const cs = runner.extractChangeSet(dir, before);
      expect(cs.edits.find((e) => e.path === 't.txt')?.content.trim()).toBe('done');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
