/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards the promote step's outcome contract. The regression these prevent is the 2026-07-29 shape: a deploy that failed AND left nothing serving reported the same thing as a deploy that failed safely, so the operator learned it from `docker ps`. Exit 1 and exit 3 must stay distinguishable all the way out to the caller, and an unrecognized code must fail closed rather than read as success.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin the two post-deploy-verification codes. The deploy script grew exit 4 (deployed and SERVING, but the live verification proved the product broken) and exit 5 (deployed and SERVING, but the product was never PROVED for more consecutive runs than the gate tolerates). Both fell into the unrecognized arm, which answers stackServing: false and needsHands: true - the precise inversion entry 1 exists to prevent, sending an operator to oshal-up.sh for a stack that is up and serving. These cases require the serving half of both, require neither to read as 'deployed', and keep 4 and 5 distinguishable from each other: they demand different actions - fix the named check, versus supply an operator PAT the gate can prove with.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DeployPromoter,
  promoteVerdictForExit,
  resolveDeployShell,
  type PromoteSpawner,
} from '@/features/dev-console';

let repoRoot: string;
let scriptPath: string;
const savedBash = process.env.OSHAL_DEPLOY_BASH;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-promote-'));
  fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
  scriptPath = path.join(repoRoot, 'scripts', 'oshal-deploy.sh');
  fs.writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  // An absolute, existing, non-System32, non-WSL launcher so shell resolution is deterministic
  // on every platform the suite runs on.
  process.env.OSHAL_DEPLOY_BASH = process.execPath;
});

afterEach(() => {
  if (savedBash === undefined) delete process.env.OSHAL_DEPLOY_BASH;
  else process.env.OSHAL_DEPLOY_BASH = savedBash;
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

/** A spawner that reports a fixed exit code and records the argv it was handed. */
function fakeSpawner(exitCode: number | null, seen: string[][] = []): PromoteSpawner {
  return async (_cmd, args) => {
    seen.push([...args]);
    return { exitCode, output: 'deploy output\n' };
  };
}

describe('promote verdicts — exit 1 and exit 3 are NOT the same failure', () => {
  it('reads 0 as deployed and serving', () => {
    const v = promoteVerdictForExit(0);
    expect(v.status).toBe('deployed');
    expect(v.needsHands).toBe(false);
    expect(v.stackServing).toBe(true);
  });

  it('reads 1 as a SAFE failure — rolled back, stack still serving, no hands needed', () => {
    const v = promoteVerdictForExit(1);
    expect(v.status).toBe('failed-rolled-back');
    expect(v.stackServing).toBe(true);
    expect(v.needsHands).toBe(false);
  });

  it('reads 2 as a preflight refusal that touched nothing', () => {
    const v = promoteVerdictForExit(2);
    expect(v.status).toBe('preflight-failed');
    expect(v.stackServing).toBe(true);
    expect(v.needsHands).toBe(false);
  });

  it('reads 3 as NOTHING IS SERVING and names the recovery script', () => {
    const v = promoteVerdictForExit(3);
    expect(v.status).toBe('degraded-needs-hands');
    expect(v.stackServing).toBe(false);
    expect(v.needsHands).toBe(true);
    expect(v.summary).toMatch(/oshal-up\.sh/);
  });

  it('reads 4 as deployed-and-SERVING with the product proved broken - never as needing hands', () => {
    // The stack is up. Sending the operator to oshal-up.sh here is the inversion this file exists
    // to prevent, one layer up: what is broken is the product, and the image was left running.
    const v = promoteVerdictForExit(4);
    expect(v.status).toBe('deployed-product-broken');
    expect(v.stackServing).toBe(true);
    expect(v.needsHands).toBe(false);
    expect(v.summary).toMatch(/not rolled back/i);
  });

  it('reads 5 as deployed-and-SERVING but never PROVED, and names what supplies the proof', () => {
    const v = promoteVerdictForExit(5);
    expect(v.status).toBe('deployed-unproven');
    expect(v.stackServing).toBe(true);
    expect(v.needsHands).toBe(false);
    expect(v.summary).toContain('OSHAL_VERIFY_OPERATOR_PAT');
  });

  it('keeps 4 and 5 distinguishable - proved broken and never proved demand different actions', () => {
    expect(promoteVerdictForExit(4).status).not.toBe(promoteVerdictForExit(5).status);
    for (const code of [4, 5]) {
      expect(promoteVerdictForExit(code).status, String(code)).not.toBe('deployed');
      expect(promoteVerdictForExit(code).status, String(code)).not.toBe('unknown');
    }
  });

  it('fails closed on an unrecognized or absent exit code', () => {
    for (const code of [null, 99, -1, 137]) {
      const v = promoteVerdictForExit(code);
      expect(v.status, String(code)).toBe('unknown');
      expect(v.needsHands, String(code)).toBe(true);
      expect(v.stackServing, String(code)).toBe(false);
    }
  });

  it('never reports a failing code as serving-and-fine', () => {
    // The single property that makes the whole contract worth having.
    for (const code of [1, 2, 3, 99, null]) {
      expect(promoteVerdictForExit(code).status, String(code)).not.toBe('deployed');
    }
  });
});

describe('DeployPromoter', () => {
  it('surfaces the decoded verdict and a bounded log tail', async () => {
    const promoter = new DeployPromoter({ repoRoot, scriptPath, spawner: fakeSpawner(3) });
    const outcome = await promoter.promote();
    expect(outcome.status).toBe('degraded-needs-hands');
    expect(outcome.exitCode).toBe(3);
    expect(outcome.logTail).toContain('deploy output');
    expect(typeof outcome.durationMs).toBe('number');
  });

  it('passes --dry-run only when asked, and never invents flags', async () => {
    const seen: string[][] = [];
    const promoter = new DeployPromoter({ repoRoot, scriptPath, spawner: fakeSpawner(0, seen) });
    await promoter.promote();
    await promoter.promote({ dryRun: true, skipBuild: true, allowUnpushed: true });
    expect(seen[0]).toEqual([scriptPath]);
    expect(seen[1]).toEqual([scriptPath, '--dry-run', '--skip-build', '--allow-unpushed']);
  });

  it('defaults allowUnpushed OFF — deploying an unpushed commit is opt-in', async () => {
    const seen: string[][] = [];
    const promoter = new DeployPromoter({ repoRoot, scriptPath, spawner: fakeSpawner(0, seen) });
    await promoter.promote({ dryRun: true });
    expect(seen[0]).not.toContain('--allow-unpushed');
  });

  it('is single-flight: a second concurrent promote is refused, not queued', async () => {
    // Two concurrent runs would race the same oshal-bot:deploy-rollback anchor tag, and the
    // loser would restore the OTHER run's intermediate image on failure.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const promoter = new DeployPromoter({
      repoRoot,
      scriptPath,
      spawner: async () => { await gate; return { exitCode: 0, output: '' }; },
    });
    const first = promoter.promote();
    expect(promoter.busy).toBe(true);
    await expect(promoter.promote()).rejects.toThrow(/already running/i);
    release();
    await first;
    expect(promoter.busy).toBe(false);
    // And the lock clears, so the next promote runs.
    await expect(promoter.promote()).resolves.toMatchObject({ status: 'deployed' });
  });

  it('clears the single-flight lock when the run throws', async () => {
    const promoter = new DeployPromoter({
      repoRoot,
      scriptPath,
      spawner: async () => { throw new Error('spawn exploded'); },
    });
    await expect(promoter.promote()).rejects.toThrow(/spawn exploded/);
    expect(promoter.busy).toBe(false);
  });

  it('refuses when the checkout has no deploy script rather than emitting a confusing ENOENT', async () => {
    fs.rmSync(scriptPath);
    const promoter = new DeployPromoter({ repoRoot, scriptPath, spawner: fakeSpawner(0) });
    await expect(promoter.promote()).rejects.toThrow(/cannot promote/i);
  });
});

describe('deploy shell resolution — never through a foreign filesystem namespace', () => {
  it('refuses System32 / Sysnative / SysWOW64 / WSL launchers on Windows', () => {
    for (const unsafe of [
      'C:\\Windows\\System32\\bash.exe',
      'C:\\Windows\\Sysnative\\bash.exe',
      'C:\\Windows\\SysWOW64\\bash.exe',
      'C:\\Windows\\System32\\wsl.exe',
    ]) {
      expect(() => resolveDeployShell('win32', unsafe, () => true), unsafe)
        .toThrow(/refusing unsafe deploy shell/);
    }
  });

  it('refuses a bare / relative shell name on Windows (PATH is not a namespace guarantee)', () => {
    expect(() => resolveDeployShell('win32', 'bash', () => true)).toThrow(/refusing unsafe deploy shell/);
    expect(() => resolveDeployShell('win32', 'bin\\bash.exe', () => true)).toThrow(/refusing unsafe deploy shell/);
  });

  it('accepts an absolute Git Bash and reports when none exists', () => {
    expect(resolveDeployShell('win32', 'C:\\Program Files\\Git\\bin\\bash.exe', () => true))
      .toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(() => resolveDeployShell('win32', undefined, () => false)).toThrow(/no Git Bash found/);
  });

  it('uses plain bash on POSIX when no override is set', () => {
    delete process.env.OSHAL_DEPLOY_BASH; // afterEach restores it
    expect(resolveDeployShell('linux', undefined, () => true)).toBe('bash');
  });

  it('honors an explicit override on POSIX', () => {
    expect(resolveDeployShell('linux', '/usr/local/bin/bash', () => true)).toBe('/usr/local/bin/bash');
  });
});
