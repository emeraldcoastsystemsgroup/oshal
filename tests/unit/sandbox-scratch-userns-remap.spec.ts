/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-077 sandbox scratch mount under a userns-remapped daemon: the per-run tree is widened for a container uid that owns nothing on the host, the scratch root that contains it stays owner-only, symlinks are never chmodded, and both run paths prepare the mount before the container starts. The real-kernel half runs scripts/sandbox-userns-mount-proof.sh in one disposable container.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DevSessionOrchestrator,
  SandboxedAgentRunner,
  SCRATCH_DIR_MODE,
  SCRATCH_FILE_MODE,
  SCRATCH_ROOT_MODE,
} from '@/features/dev-console';
import type { DevSession, DevSessionEngine } from '@/features/dev-console';

/**
 * WHAT FAILED, and where this guard crosses it.
 *
 * Under a Linux userns-remapped daemon (GitHub Actions) the container's root is a host subuid that
 * owns nothing. The dev-console sandbox bind-mounts a `mkdtemp` (0700) scratch holding 0644 seeded
 * files, so that uid could neither traverse nor write and every /work write was "Permission
 * denied" — the sandbox was unusable for an environment reason and its own integration tests
 * excluded the engine rather than fixing it.
 *
 * Two boundaries, asserted separately because no single host can carry both:
 *  - the DECISION and the mode bits: asserted here on every platform from the plan, and on POSIX
 *    additionally from the real on-disk mode. POSIX decides a foreign uid's access on exactly the
 *    `other` bits, so a real 0o777 directory IS the property the remapped uid needs.
 *  - the KERNEL honouring them for a genuinely different uid: proved by
 *    `scripts/sandbox-userns-mount-proof.sh` inside one disposable container, as uid 165536 — the
 *    first subuid a default `dockremap` mapping hands to container root. It is opt-in
 *    (`OSHAL_SANDBOX_USERNS_PROOF=1`) because it starts a container; when it is on it FAILS rather
 *    than skips if Docker cannot be reached.
 */

const scratchRoots: string[] = [];

function makeTree(): { root: string; work: string; outside: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'sar-userns-'));
  scratchRoots.push(root);
  const work = path.join(root, 'run');
  mkdirSync(path.join(work, 'sub'), { recursive: true });
  mkdirSync(path.join(work, 'node_modules'), { recursive: true });
  writeFileSync(path.join(work, 'a.txt'), 'seeded\n');
  writeFileSync(path.join(work, 'sub', 'b.txt'), 'seeded\n');
  writeFileSync(path.join(work, 'node_modules', 'x.js'), 'ignored\n');
  const outside = path.join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'secret.txt'), 'not the sandbox\n');
  return { root, work, outside };
}

/** A junction on Windows, a symlink elsewhere: both lstat as a symbolic link. */
function linkTo(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratchRoots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* throwaway */ }
  }
});

describe('sandbox scratch mount — prepared for a container uid that owns nothing on the host', () => {
  it('plans every directory and file of the per-run tree, and nothing outside it', () => {
    const { work, outside } = makeTree();
    const plan = SandboxedAgentRunner.scratchMountPlan(work);
    const planned = new Map(plan.entries.map((entry) => [entry.path, entry.mode]));

    expect(planned.get(work)).toBe(SCRATCH_DIR_MODE);
    expect(planned.get(path.join(work, 'sub'))).toBe(SCRATCH_DIR_MODE);
    expect(planned.get(path.join(work, 'a.txt'))).toBe(SCRATCH_FILE_MODE);
    expect(planned.get(path.join(work, 'sub', 'b.txt'))).toBe(SCRATCH_FILE_MODE);

    // The widening reaches the per-run directory and stops: not the root above it, not a sibling.
    expect([...planned.keys()].every((entry) => entry === work || entry.startsWith(work + path.sep))).toBe(true);
    expect(planned.has(path.dirname(work))).toBe(false);
    expect(planned.has(outside)).toBe(false);
    expect(planned.has(path.join(outside, 'secret.txt'))).toBe(false);

    // Trees the seeder never copies in are not walked either.
    expect(planned.has(path.join(work, 'node_modules'))).toBe(false);
    expect(planned.has(path.join(work, 'node_modules', 'x.js'))).toBe(false);
  });

  it('never chmods a symlink — that would widen its target, which is outside the scratch', () => {
    const { work, outside } = makeTree();
    const link = path.join(work, 'escape');
    linkTo(outside, link);

    const plan = SandboxedAgentRunner.scratchMountPlan(work);
    expect(plan.skippedSymlinks).toContain(link);
    expect(plan.entries.some((entry) => entry.path === link)).toBe(false);
    // Nothing reached through the link is planned either.
    expect(plan.entries.some((entry) => entry.path.startsWith(link + path.sep))).toBe(false);
    expect(plan.entries.some((entry) => entry.path === path.join(outside, 'secret.txt'))).toBe(false);
  });

  it('applies the planned modes on a host that has them, and says so when it has not', () => {
    const { work } = makeTree();
    const prepared = SandboxedAgentRunner.prepareScratchMount(work);

    expect(prepared.entries.length).toBeGreaterThan(0);
    if (process.platform === 'win32') {
      expect(prepared.skipped).toBe(true);
      expect(prepared.applied).toEqual([]);
      return;
    }
    expect(prepared.skipped).toBe(false);
    expect(prepared.applied.map((entry) => entry.path).sort()).toEqual(prepared.entries.map((entry) => entry.path).sort());
    // The `other` bits are what a foreign uid is judged on: assert them on the real inodes.
    expect(lstatSync(work).mode & 0o777).toBe(SCRATCH_DIR_MODE);
    expect(lstatSync(path.join(work, 'sub')).mode & 0o777).toBe(SCRATCH_DIR_MODE);
    expect(lstatSync(path.join(work, 'a.txt')).mode & 0o777).toBe(SCRATCH_FILE_MODE);
    expect(lstatSync(path.join(work, 'sub', 'b.txt')).mode & 0o777).toBe(SCRATCH_FILE_MODE);
    // The root above the mount is untouched by preparation.
    expect(lstatSync(path.dirname(work)).mode & 0o007).toBe(0);
  });

  it('locks the scratch root to owner-only, so no second host user reaches the widened directory', () => {
    const { root, work } = makeTree();
    SandboxedAgentRunner.prepareScratchMount(work);
    const locked = SandboxedAgentRunner.lockScratchRoot(root);

    if (process.platform === 'win32') {
      expect(locked).toBe(false);
      return;
    }
    expect(locked).toBe(true);
    expect(lstatSync(root).mode & 0o777).toBe(SCRATCH_ROOT_MODE);
    expect(lstatSync(work).mode & 0o777).toBe(SCRATCH_DIR_MODE);
  });
});

type ArgsBuilder = { dockerArgs: (...args: unknown[]) => string[] };

/** Stops each run path at the moment it builds the `docker run` vector — no container is started. */
function stopAtDockerArgs(runner: SandboxedAgentRunner, order: string[]): void {
  vi.spyOn(runner as unknown as ArgsBuilder, 'dockerArgs').mockImplementation(() => {
    order.push('docker-args');
    throw new Error('stop before the container starts');
  });
}

function recordPreparation(order: string[]): void {
  vi.spyOn(SandboxedAgentRunner, 'prepareScratchMount').mockImplementation((dir: string) => {
    order.push(`prepare:${dir}`);
    return { entries: [], skippedSymlinks: [], applied: [], skipped: true };
  });
}

describe('sandbox scratch mount — every run path prepares the mount before the container starts', () => {
  it('run() prepares the scratch it is about to bind-mount', () => {
    const { work } = makeTree();
    const order: string[] = [];
    recordPreparation(order);
    const runner = new SandboxedAgentRunner();
    stopAtDockerArgs(runner, order);

    expect(() => runner.run(work, ['sh', '-c', 'true'], 1_000)).toThrow('stop before the container starts');
    expect(order).toEqual([`prepare:${work}`, 'docker-args']);
  });

  it('runStreaming() prepares the scratch it is about to bind-mount', () => {
    const { work } = makeTree();
    const order: string[] = [];
    recordPreparation(order);
    const runner = new SandboxedAgentRunner();
    stopAtDockerArgs(runner, order);

    expect(() => runner.runStreaming(work, ['sh', '-c', 'true'], () => {}, 1_000)).toThrow('stop before the container starts');
    expect(order).toEqual([`prepare:${work}`, 'docker-args']);
  });

  it('a session scratch is created inside a root the orchestrator locks to owner-only', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sar-userns-root-'));
    scratchRoots.push(root);
    const scratchRoot = path.join(root, 'oshal-dev-scratch');
    const engine = { applyChangeSet: () => [], diff: () => ({ files: [] }) };
    const orchestrator = new DevSessionOrchestrator(
      engine as unknown as DevSessionEngine,
      new SandboxedAgentRunner(),
      scratchRoot,
    );
    const session = { id: 'session-userns', worktreePath: path.join(root, 'worktree') } as unknown as DevSession;
    mkdirSync(session.worktreePath, { recursive: true });
    writeFileSync(path.join(session.worktreePath, 'file.ts'), 'export const x = 1;');

    const lock = vi.spyOn(SandboxedAgentRunner, 'lockScratchRoot');
    const prepare = vi.spyOn(SandboxedAgentRunner, 'prepareScratchMount');
    const runner = orchestrator as unknown as { runner: SandboxedAgentRunner };
    vi.spyOn(runner.runner as unknown as ArgsBuilder, 'dockerArgs').mockImplementation(() => {
      throw new Error('stop before the container starts');
    });

    expect(() => orchestrator.runAgentEdit(session, ['sh', '-c', 'true'])).toThrow('stop before the container starts');
    expect(lock).toHaveBeenCalledWith(scratchRoot);
    expect(prepare).toHaveBeenCalledWith(path.join(scratchRoot, session.id));
    // The per-session scratch is removed by the orchestrator's own finally; the root it created
    // and locked is what survives, and it is the thing that must stay owner-only.
    if (process.platform !== 'win32') {
      expect(lstatSync(scratchRoot).mode & 0o777).toBe(SCRATCH_ROOT_MODE);
    }
  });
});

describe('sandbox scratch mount — the shell proof and the runner agree on the modes', () => {
  const proof = readFileSync(path.resolve(__dirname, '../../scripts/sandbox-userns-mount-proof.sh'), 'utf8');

  it('the proof script defaults to the modes the runner ships', () => {
    const literal = (name: string): number => {
      const match = proof.match(new RegExp(`${name}=\\$\\{OSHAL_[A-Z_]+:-(\\d+)\\}`));
      expect(match, `${name} default not found in the proof script`).toBeTruthy();
      return parseInt(match![1], 8);
    };
    expect(literal('DIR_MODE')).toBe(SCRATCH_DIR_MODE);
    expect(literal('FILE_MODE')).toBe(SCRATCH_FILE_MODE);
    expect(literal('ROOT_MODE')).toBe(SCRATCH_ROOT_MODE);
  });
});

// The real-kernel half. Opt-in because it starts a container; when it is on, a missing or broken
// Docker is a FAILURE, never a skip — a proof that quietly declines is not a proof.
const proofRequested = process.env.OSHAL_SANDBOX_USERNS_PROOF === '1';

describe('sandbox scratch mount — a foreign container uid on a real kernel', () => {
  (proofRequested ? it : it.skip)('is denied the unprepared mount, writes the prepared one, and cannot reach past it', () => {
    // Its own reachability check rather than dockerAvailable(): that helper's 15s budget is sized
    // for a gate deciding whether to skip, and a loaded engine answers slower than that.
    const version = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 90_000 });
    expect(version.status, `OSHAL_SANDBOX_USERNS_PROOF=1 but Docker is unreachable: ${version.stderr ?? version.error}`).toBe(0);
    const script = readFileSync(path.resolve(__dirname, '../../scripts/sandbox-userns-mount-proof.sh'), 'utf8');
    const image = process.env.OSHAL_SANDBOX_PROOF_IMAGE ?? 'alpine:latest';
    const run = spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', image, 'sh', '-s'], {
      input: script,
      encoding: 'utf8',
      timeout: 240_000,
    });
    const facts = new Map(
      `${run.stdout ?? ''}`.split('\n').map((line) => line.trim()).filter(Boolean)
        .map((line) => line.split('=') as [string, string]),
    );
    expect(facts.get('probe_uid'), `proof produced no uid; output: ${run.stdout}${run.stderr}`).toBe('165536');
    expect(facts.get('unprepared_write')).toBe('denied');
    expect(facts.get('prepared_write')).toBe('ok');
    expect(facts.get('prepared_create')).toBe('ok');
    expect(facts.get('escape_parent')).toBe('denied');
    expect(facts.get('escape_root')).toBe('denied');
    expect(facts.get('owner_cleanup')).toBe('ok');
  }, 300_000);
});
