/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Dev-mode promote step (ADR-077 gap 1): the missing link between a merged commit and a serving container. scripts/oshal-deploy.sh was referenced by docs, oshal-up.sh and tests but by NO code path — so self-development landed in git and the running api kept serving the previously baked dist indefinitely. This wraps that script as a single-flight host operation with its four-outcome exit contract preserved (0 deployed / 1 rolled back and serving / 2 preflight / 3 degraded, needs hands), because collapsing 1 and 3 into "failed" is the exact 2026-07-29 incident the script's exit codes exist to prevent.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import { buildDevSessionProcessEnv } from './dev-session-engine';

const logger = createChildLogger({ module: 'deploy-promoter' });

/** How the deploy ended, in the script's own terms — never flattened to pass/fail. */
export type PromoteStatus =
  | 'deployed'
  | 'failed-rolled-back'
  | 'preflight-failed'
  | 'degraded-needs-hands'
  | 'unknown';

/** The decoded meaning of one deploy exit code. */
export interface PromoteVerdict {
  status: PromoteStatus;
  /** True when the box needs a human — the stack is NOT serving and no automation will fix it. */
  needsHands: boolean;
  /** True when an api is believed to be serving (either the new image or the rolled-back one). */
  stackServing: boolean;
  summary: string;
}

/** The full result of a promote run. */
export interface PromoteOutcome extends PromoteVerdict {
  exitCode: number | null;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Bounded tail of the script's combined output — enough to diagnose, never unbounded. */
  logTail: string;
}

/** Options for a single promote run. */
export interface PromoteOptions {
  /** Preflight + image verify + print the plan, touching no container. */
  dryRun?: boolean;
  /** Reuse the current image instead of building (paired with dryRun for a fast check). */
  skipBuild?: boolean;
  /** Deploy committed HEAD even when it is not pushed. Off by default: deploying an unpushed
   *  commit makes the running stack un-reproducible from the remote. */
  allowUnpushed?: boolean;
}

/** Injectable process launcher so the outcome contract is testable without a 34-container deploy. */
export type PromoteSpawner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<{ exitCode: number | null; output: string }>;

/** Configuration for the promoter. */
export interface DeployPromoterConfig {
  repoRoot: string;
  /** Overrides the deploy script path (tests). Defaults to `<repoRoot>/scripts/oshal-deploy.sh`. */
  scriptPath?: string;
  /** Overrides process launching (tests). */
  spawner?: PromoteSpawner;
  /** Hard ceiling for one deploy. A full rebuild + 34-bot batched recreate is legitimately slow. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const LOG_TAIL_BYTES = 8192;

/**
 * Git Bash launchers we are willing to run the deploy script with. Bare `bash` is deliberately
 * NOT a candidate: on Windows it resolves through PATH into System32/WSL, which is a different
 * filesystem namespace where the repo path, the Docker socket and the compose project do not
 * mean what the script assumes.
 */
const WINDOWS_BASH_CANDIDATES: readonly string[] = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
];

/** Windows shells that must never run this script, however they were supplied. */
const UNSAFE_WINDOWS_SHELL = /[\\/](?:system32|sysnative|syswow64)[\\/]bash\.exe$|(?:^|[\\/])wsl\.exe$/i;

/**
 * @description Resolves the shell used to run the deploy script. On POSIX that is `bash`. On
 * Windows it is an ABSOLUTE Git Bash path — validated against the same refusal set the deploy
 * guard spec pins (System32 / Sysnative / SysWOW64 / wsl.exe), because a deploy that crosses
 * into the WSL namespace silently operates on a different tree and a different Docker context.
 * @param platform - The platform to resolve for (defaults to the running platform).
 * @param override - Optional explicit shell path (OSHAL_DEPLOY_BASH); still validated.
 * @param exists - Existence probe, injectable for tests.
 * @returns The absolute shell path (or `bash` on POSIX).
 * @throws When no safe shell can be resolved.
 */
export function resolveDeployShell(
  platform: NodeJS.Platform = process.platform,
  override: string | undefined = process.env.OSHAL_DEPLOY_BASH,
  exists: (candidate: string) => boolean = existsSync,
): string {
  if (platform !== 'win32') return override?.trim() || 'bash';
  const candidates = override?.trim() ? [override.trim()] : WINDOWS_BASH_CANDIDATES;
  for (const candidate of candidates) {
    if (!path.win32.isAbsolute(candidate) || UNSAFE_WINDOWS_SHELL.test(candidate)) {
      throw new Error(`refusing unsafe deploy shell: ${candidate}`);
    }
    if (exists(candidate)) return candidate;
  }
  throw new Error('no Git Bash found to run the deploy script (set OSHAL_DEPLOY_BASH to an absolute path)');
}

/**
 * @description Decodes one deploy exit code into its operational meaning. This mapping IS the
 * contract documented in scripts/oshal-deploy.sh: 1 and 3 are both "the deploy failed" but only
 * 3 means nothing is serving, and conflating them is what let a dead api sit unnoticed behind a
 * success-shaped failure on 2026-07-29. An unrecognized code fails closed — needs hands.
 * @param exitCode - The script's exit code (null when it was killed or never ran).
 * @returns The decoded verdict.
 */
export function promoteVerdictForExit(exitCode: number | null): PromoteVerdict {
  switch (exitCode) {
    case 0:
      return { status: 'deployed', needsHands: false, stackServing: true, summary: 'deployed and verified' };
    case 1:
      return {
        status: 'failed-rolled-back',
        needsHands: false,
        stackServing: true,
        summary: 'deploy failed; rollback restored the previous image and the stack is serving',
      };
    case 2:
      return {
        status: 'preflight-failed',
        needsHands: false,
        stackServing: true,
        summary: 'preflight refused the deploy; no container was touched',
      };
    case 3:
      return {
        status: 'degraded-needs-hands',
        needsHands: true,
        stackServing: false,
        summary: 'deploy failed AND the rollback did not restore a serving stack — run scripts/oshal-up.sh',
      };
    default:
      return {
        status: 'unknown',
        needsHands: true,
        stackServing: false,
        summary: `deploy ended with an unrecognized exit code (${exitCode === null ? 'killed/timed out' : exitCode}) — treat the stack as unverified`,
      };
  }
}

/**
 * @description Runs the verified deploy script for the host repo, one run at a time.
 *
 * SINGLE-FLIGHT is load-bearing, not tidiness: two concurrent runs would race the same
 * `oshal-bot:deploy-rollback` anchor tag, and the loser would restore the OTHER run's
 * intermediate image on failure. The deploy script has its own lock; this refuses earlier so
 * the caller gets a clean 409 rather than a lock-timeout deep in a log.
 */
export class DeployPromoter {
  private readonly repoRoot: string;
  private readonly scriptPath: string;
  private readonly spawner: PromoteSpawner;
  private readonly timeoutMs: number;
  private inFlight: Promise<PromoteOutcome> | null = null;

  /**
   * @description Builds a promoter bound to one repo checkout.
   * @param config - Repo root plus optional script path / spawner / timeout overrides.
   */
  constructor(config: DeployPromoterConfig) {
    this.repoRoot = path.resolve(config.repoRoot);
    this.scriptPath = config.scriptPath ?? path.join(this.repoRoot, 'scripts', 'oshal-deploy.sh');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawner = config.spawner ?? this.defaultSpawner.bind(this);
  }

  /** Whether a promote is currently running (drives the 409 on the route). */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  /**
   * @description Runs the deploy script and decodes its outcome. Refuses when a run is already
   * in flight, and when the deploy script is missing from the checkout (a source-less install
   * cannot promote — saying so beats a confusing ENOENT).
   * @param options - Dry-run / skip-build / allow-unpushed switches.
   * @returns The decoded outcome with a bounded log tail.
   */
  async promote(options: PromoteOptions = {}): Promise<PromoteOutcome> {
    if (this.inFlight) throw new Error('a promote is already running');
    if (!existsSync(this.scriptPath)) {
      throw new Error(`deploy script not found at ${this.scriptPath} — this checkout cannot promote`);
    }
    const run = this.runOnce(options).finally(() => { this.inFlight = null; });
    this.inFlight = run;
    return run;
  }

  /** Executes one deploy and decodes the result. */
  private async runOnce(options: PromoteOptions): Promise<PromoteOutcome> {
    const args = [this.scriptPath];
    if (options.dryRun) args.push('--dry-run');
    if (options.skipBuild) args.push('--skip-build');
    if (options.allowUnpushed) args.push('--allow-unpushed');

    const shell = resolveDeployShell();
    const startedAt = new Date();
    logger.info({ args, repoRoot: this.repoRoot, dryRun: !!options.dryRun }, 'promote starting');

    const { exitCode, output } = await this.spawner(shell, args, this.repoRoot);
    const finishedAt = new Date();
    const verdict = promoteVerdictForExit(exitCode);

    const outcome: PromoteOutcome = {
      ...verdict,
      exitCode,
      dryRun: !!options.dryRun,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      logTail: output.slice(-LOG_TAIL_BYTES),
    };
    const level = outcome.needsHands ? 'error' : 'info';
    logger[level]({ status: outcome.status, exitCode, durationMs: outcome.durationMs }, 'promote finished');
    return outcome;
  }

  /** Launches the deploy script with a least-privilege env and a bounded output buffer. */
  private defaultSpawner(command: string, args: readonly string[], cwd: string): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], {
        cwd,
        env: buildDevSessionProcessEnv(),
        windowsHide: true,
      });
      let output = '';
      const append = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        // Keep only what we will report — a full rebuild log is megabytes.
        if (output.length > LOG_TAIL_BYTES * 4) output = output.slice(-LOG_TAIL_BYTES * 2);
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      const timer = setTimeout(() => {
        output += '\n[promote] timeout exceeded — killing the deploy\n';
        child.kill('SIGKILL');
      }, this.timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: null, output: `${output}\n[promote] failed to launch: ${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, output });
      });
    });
  }
}
