/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Integration test for the ADR-077 Phase 2 Dev Session Orchestrator — sandboxed agent edit applied to the governed worktree. Skips when Docker is unavailable.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Gate on sandboxUsable() not dockerAvailable(): CI's userns-remapped Docker responds but cannot write /work, so the sandbox can't actually run there — skip instead of failing the fast unit lane.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DevSessionEngine, DevSessionOrchestrator, SandboxedAgentRunner } from '@/features/dev-console';

// sandboxUsable() (not dockerAvailable()) so this skips where Docker responds but the /work
// bind mount is not writable by the container user (e.g. CI's userns-remapped daemon).
const hasDocker = SandboxedAgentRunner.sandboxUsable();

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

let base: string;
let repoRoot: string;
let engine: DevSessionEngine;
let orchestrator: DevSessionOrchestrator;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'oshal-orch-'));
  repoRoot = path.join(base, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 't@t.test']);
  git(repoRoot, ['config', 'user.name', 'T']);
  writeFileSync(path.join(repoRoot, 'seed.txt'), 'seed\n');
  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', 'init']);
  engine = new DevSessionEngine({ repoRoot, worktreesRoot: path.join(base, 'wt') });
  orchestrator = new DevSessionOrchestrator(engine, new SandboxedAgentRunner(), path.join(base, 'scratch'));
});

afterEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('DevSessionOrchestrator — governed agentic edit (needs docker)', () => {
  (hasDocker ? it : it.skip)('runs an agent in the sandbox and applies its edits to the governed worktree', () => {
    const session = engine.create('orch');
    try {
      const result = orchestrator.runAgentEdit(session, [
        'sh', '-c', 'echo agent-made-this > /work/generated.txt; printf appended >> /work/seed.txt',
      ]);
      expect(result.agentExitCode).toBe(0);
      expect(result.filesChanged.sort()).toEqual(['generated.txt', 'seed.txt']);
      expect(result.diff.changed).toBe(true);
      expect(result.diff.files.map((f) => f.path)).toContain('generated.txt');
      // the edit is in the worktree, NOT the live repo tree
      expect(git(repoRoot, ['status', '--porcelain']).trim()).toBe('');
    } finally {
      engine.teardown(session);
    }
  }, 180_000);
});
