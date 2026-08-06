/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — abstract base for CLI-spawn harness adapters (codex, claude-code, gemini)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: applyUserScoping also writes the caller's provided short-lived access tokens (OSHAL_CRED_GOOGLE/OSHAL_CRED_TWITTER) as .oshal-cred-<provider> files in the workspace + sets them in the spawn env, so shelled tools use a provided token instead of decrypting oshal_connections with SESSION_SECRET.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | applyUserScoping also emits OSHAL_USER_KEY (sha256(sub)[:32]) + a .oshal-user-key workspace file — the FS-safe per-user key for per-user file space. codex-packer writes packs to packs/<OSHAL_USER_KEY>/<slug>/ so they land where the per-user-isolated swarm-pack routes read them.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | BROKERED_CRED_FILES += OSHAL_CRED_OUTLOOK → .oshal-cred-outlook (ADR-037 Outlook provider parity): the caller's Microsoft Graph token reaches shelled tools (scripts/oshal-outlook.js) on the in-controller harness path too; kept in sync with connector-token-broker.ts, bot-node-request-scope.ts, and any-bot user-scoping.js.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Inactivity-based timeout (ADR-081): the one-shot absolute timer killed ACTIVELY-WORKING runs (live incident 2026-07-06: two codex dev runs killed mid-typecheck at 600s while streaming events). Adapters may opt into idleReset — child stdout/stderr refreshes the timer, so timeoutMs means "max silence" and only silent-stuck processes die; a separate maxDurationMs one-shot cap backstops runaways. Absolute semantics remain the default (claude/gemini batch modes are legitimately silent until their final JSON — docs/evidence/claude-inactivity-timeout-honesty-2026-06-22.md). Also added SIGTERM→SIGKILL escalation (10s) on timeout kills.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Preserve userSub exactly across CLI env/file/hash scoping. Invalid UTF-8 or subjects over 512 bytes now fail before spawn instead of silently trimming/truncating into another identity; whitespace remains an explicit isolated subject.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Route every inline `.oshal-user-*` and `.oshal-cred-*` write through the safe scoped-file writer and fail closed on linked parents, linked/nonregular targets, or partial publication; cleanup now removes only invocation-owned entries.
 */

import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import { optionalExactUserSubject } from '@/shared/security/exact-user-subject';
import {
  removeOwnedScopedFile,
  writeScopedFile,
  type ScopedFileIdentity,
} from '@/shared/security/scoped-file-writer';
import type { HarnessAdapter, HarnessTask, HarnessResult, HarnessType } from './harness-adapter';
import type { TokenUsage } from './llm-service';

/**
 * @description Result shape emitted by `execCapturing` — consumed by every
 * CLI harness's `run()` method.
 */
export interface CliExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * @description Abstract base class for CLI-spawn harness adapters
 * (codex-cli, claude-code, gemini-cli). Encapsulates the subprocess
 * boilerplate every CLI adapter previously duplicated:
 *
 * - `execCapturing(binary, args, env, cwd, timeoutMs)` — spawns a subprocess,
 *   captures stdout/stderr, enforces timeout with SIGTERM, returns exit code.
 * - `execWithTimeout()` — same but throws on non-zero exit.
 * - `estimateUsage(prompt, response)` — fallback token estimate when the
 *   CLI doesn't emit real telemetry.
 *
 * Subclasses must:
 * - Set `harnessType` (assigned through the protected ctor pattern below
 *   since TypeScript needs `readonly` on the literal).
 * - Implement `run()` and use `this.execCapturing()` for subprocess work.
 * - Optionally override `healthCheck()`.
 *
 * Replaces ~150 lines of identical subprocess plumbing across three
 * adapters (codex-cli, claude-code, gemini-cli).
 */
export abstract class BaseCliHarnessAdapter implements HarnessAdapter {
  /** Set by the concrete subclass via the constructor. */
  abstract readonly harnessType: HarnessType;

  /** Master/connector secrets scrubbed from EVERY bot spawn env (token-broker
   *  hygiene): the bot uses controller-provided short-lived tokens, never these. */
  protected static readonly SECRET_ENV_KEYS: readonly string[] = [
    'SESSION_SECRET', 'OIDC_CLIENT_SECRET', 'AUTH_SESSION_SECRET',
    'GOOGLE_CONNECT_CLIENT_SECRET', 'LINKEDIN_PRIMARY_CLIENT_SECRET', 'LINKEDIN_CLIENT_SECRET',
    'TWITTER_CLIENT_SECRET', 'X_CLIENT_SECRET', 'X_CLIENT_SECRECT',
    'GITHUB_CLIENT_SECRET', 'AZURE_EMAIL_CLIENT_SECRET', 'OUTLOOK_CLIENT_VALUE', 'FACEBOOK_APP_SECRET',
    'SMARTTHINGS_CLIENT_SECRET', 'SMARTTHINGS_OAUTH_CLIENT_SECRET',
  ];
  protected static readonly BROKERED_CRED_FILES: Readonly<Record<string, string>> = {
    OSHAL_CRED_GOOGLE: '.oshal-cred-google',
    OSHAL_CRED_OUTLOOK: '.oshal-cred-outlook',
    OSHAL_CRED_TWITTER: '.oshal-cred-twitter',
    OSHAL_CRED_SMARTTHINGS: '.oshal-cred-smartthings',
    OSHAL_CRED_GCP: '.oshal-cred-gcp',
    OSHAL_CRED_WALMART: '.oshal-cred-walmart',
    OSHAL_CRED_UBER: '.oshal-cred-uber',
    OSHAL_CRED_UBER_RIDES: '.oshal-cred-uber-rides',
    OSHAL_CRED_SPOTIFY: '.oshal-cred-spotify',
    OSHAL_CRED_TMDB: '.oshal-cred-tmdb',
    OSHAL_CRED_DUFFEL: '.oshal-cred-duffel',
    OSHAL_CRED_TWILIO: '.oshal-cred-twilio',
  };
  private static readonly USER_SCOPE_TAILS = new Map<string, Promise<void>>();

  protected readonly logger: ReturnType<typeof createChildLogger>;
  protected readonly defaultTimeoutMs: number;
  /** When true, child stdout/stderr activity refreshes the timeout timer — timeoutMs
   *  becomes "max silence", so an actively-streaming run is never killed for taking long.
   *  Only safe for CLIs that stream output incrementally (codex `exec --json` JSONL);
   *  batch CLIs that stay silent until one final JSON must keep absolute semantics. */
  protected readonly idleReset: boolean;
  /** Runaway backstop used only with idleReset: absolute wall-clock cap regardless of
   *  activity. 0/undefined disables the cap. */
  protected readonly maxDurationMs: number | undefined;
  /** Per-instance additions to SECRET_ENV_KEYS. Controller-INLINE bots run in the api
   *  container, which holds platform-plane credentials (the worker-plane shared secret, the
   *  webhook ingest tokens) that no bot tool needs; the composition root passes them here so
   *  the scrub stays one code path. Empty for bot-node bots — behaviour unchanged. */
  protected readonly extraSecretEnvKeys: readonly string[];

  constructor(
    loggerModule: string,
    defaultTimeoutMs: number,
    opts?: { idleReset?: boolean; maxDurationMs?: number; extraSecretEnvKeys?: readonly string[] },
  ) {
    this.logger = createChildLogger({ module: loggerModule });
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.idleReset = opts?.idleReset === true;
    this.maxDurationMs = opts?.maxDurationMs && opts.maxDurationMs > 0 ? opts.maxDurationMs : undefined;
    this.extraSecretEnvKeys = opts?.extraSecretEnvKeys ?? [];
  }

  abstract run(task: HarnessTask): Promise<HarnessResult>;

  /**
   * @description Default health check — runs `<binary> --version`. Subclasses
   * that need a different probe can override.
   */
  async healthCheck(): Promise<boolean> {
    const binary = this.healthCheckBinary();
    if (!binary) return true;
    try {
      const { stdout } = await this.execWithTimeout(
        binary,
        ['--version'],
        process.env as Record<string, string>,
        process.cwd(),
        5000,
      );
      this.logger.info({ harnessType: this.harnessType, version: stdout.trim() }, 'CLI health check passed');
      return true;
    } catch (err) {
      this.logger.warn({ err, harnessType: this.harnessType }, 'CLI health check failed — binary not found or not executable');
      return false;
    }
  }

  /**
   * @description Subclass hook returning the binary to probe in the default
   * health check. Return null to skip the probe. Default implementation
   * returns null because the binary path is held in subclass state.
   */
  protected healthCheckBinary(): string | null {
    return null;
  }

  /**
   * @description Centralized per-user scoping for every CLI harness. Delivers the
   * caller's OIDC sub to shelled-out tools (e.g. oshal-gmail.js) via BOTH channels
   * so it works regardless of harness: (1) the spawn env `OSHAL_USER_SUB` (claude /
   * gemini / cline propagate env to their tools), and (2) a `.oshal-user-sub` file
   * in the task workspace (codex's sandbox strips env, but runs tools with cwd =
   * workspace). The tool reads whichever is present. Call from each adapter's run().
   *
   * Token broker: when `creds` is provided (the caller's short-lived per-user access
   * tokens, e.g. { OSHAL_CRED_GOOGLE, OSHAL_CRED_TWITTER }), also write each as a
   * `.oshal-cred-<provider>` file + set the env var, so a shelled tool uses a provided
   * token instead of decrypting `oshal_connections` with SESSION_SECRET.
   *
   * @param env - The spawn env object (mutated in place to add OSHAL_USER_SUB + OSHAL_CRED_*).
   * @param workspacePath - The task workspace dir codex runs in (per-task isolated).
   * @param userSub - Authenticated caller's sub; no-op if absent.
   * @param creds - The caller's provided access tokens as an env-key map; optional.
   */
  protected applyUserScoping(
    env: Record<string, string>,
    workspacePath: string,
    userSub?: string,
    creds?: Record<string, string>,
  ): ScopedFileIdentity[] {
    // Secret hygiene: the in-controller harness spawns codex (danger-full-access) IN the
    // api container, which holds the master connector key + OAuth app secrets. Scrub them
    // from EVERY bot spawn env so untrusted swarm code can't `printenv` them — the bot uses
    // the controller-provided short-lived per-user token instead. Always runs.
    for (const k of BaseCliHarnessAdapter.SECRET_ENV_KEYS) delete env[k];
    // Per-instance additions (controller-inline bots): the api container's platform-plane
    // credentials. REMOTE_CLIENT_SHARED_SECRET is the sharp one — it is machine trust on the
    // worker plane, so it SKIPS per-device ownership and would let an injected inline bot
    // enqueue a shell task on any user's desktop.
    for (const k of this.extraSecretEnvKeys) delete env[k];
    const exactUserSub = optionalExactUserSubject(userSub, 'CLI userSub');
    const credEntries = creds ? Object.entries(creds).filter(([key, value]) => (
      Object.prototype.hasOwnProperty.call(BaseCliHarnessAdapter.BROKERED_CRED_FILES, key)
      && typeof value === 'string'
      && value.length > 0
      && value.length <= 32_768
    )) : [];
    const ownedFiles: ScopedFileIdentity[] = [];
    if (exactUserSub === undefined && credEntries.length === 0) return ownedFiles;
    const writes: Array<[string, string]> = [];
    if (exactUserSub !== undefined) {
      // FS-safe per-user key (sha256 of the sub) — the channel for per-user file space.
      // Must match userKey() in swarm-pack-routes.ts so codex-packer writes packs where
      // the routes read them: packs/<OSHAL_USER_KEY>/<slug>/. Subs aren't path-safe.
      const userKey = crypto.createHash('sha256').update(exactUserSub).digest('hex').slice(0, 32);
      writes.push(['.oshal-user-sub', exactUserSub], ['.oshal-user-key', userKey]);
    }
    for (const [envKey, value] of credEntries) {
      writes.push([BaseCliHarnessAdapter.BROKERED_CRED_FILES[envKey], value]);
    }
    try {
      for (const [fileName, value] of writes) {
        ownedFiles.push(writeScopedFile(path.join(workspacePath, fileName), value));
      }
    } catch (error) {
      for (const owned of ownedFiles.reverse()) removeOwnedScopedFile(owned);
      this.logger.error({ err: error, workspacePath }, 'applyUserScoping: safe scoped-file publication failed');
      throw error;
    }
    if (exactUserSub !== undefined) {
      env.OSHAL_USER_SUB = exactUserSub;
      env.OSHAL_USER_KEY = crypto.createHash('sha256').update(exactUserSub).digest('hex').slice(0, 32);
    }
    for (const [envKey, value] of credEntries) env[envKey] = value;
    return ownedFiles;
  }

  private wipeOwnedUserScoping(ownedFiles: ScopedFileIdentity[]): void {
    for (const owned of ownedFiles) removeOwnedScopedFile(owned);
  }

  /**
   * Acquire an exclusive credential-file lease for one workspace. Different workspaces
   * remain concurrent; requests sharing a cwd wait until the previous subprocess has
   * removed only the files it created.
   */
  protected async acquireUserScopingLease(
    env: Record<string, string>,
    workspacePath: string,
    userSub?: string,
    creds?: Record<string, string>,
  ): Promise<() => void> {
    const key = path.resolve(workspacePath);
    const previous = BaseCliHarnessAdapter.USER_SCOPE_TAILS.get(key) ?? Promise.resolve();
    let unlock: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    BaseCliHarnessAdapter.USER_SCOPE_TAILS.set(key, tail);
    await previous.catch(() => undefined);

    let ownedFiles: ScopedFileIdentity[];
    try {
      ownedFiles = this.applyUserScoping(env, workspacePath, userSub, creds);
    } catch (error) {
      unlock?.();
      if (BaseCliHarnessAdapter.USER_SCOPE_TAILS.get(key) === tail) {
        BaseCliHarnessAdapter.USER_SCOPE_TAILS.delete(key);
      }
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.wipeOwnedUserScoping(ownedFiles);
      unlock?.();
      if (BaseCliHarnessAdapter.USER_SCOPE_TAILS.get(key) === tail) {
        BaseCliHarnessAdapter.USER_SCOPE_TAILS.delete(key);
      }
    };
  }

  /**
   * @description Spawns a subprocess, captures stdout + stderr, enforces a
   * timeout that SIGTERMs on expiry (escalating to SIGKILL after 10s if the
   * child ignores it). Resolves with exit code rather than rejecting on
   * non-zero — gives subclasses a chance to parse error JSON before deciding
   * whether to throw.
   *
   * Timeout semantics depend on the adapter's `idleReset` flag:
   * - false (default): `timeoutMs` is an absolute wall-clock cap (legacy).
   * - true: `timeoutMs` is MAX SILENCE — any stdout/stderr chunk refreshes the
   *   timer, so an actively-streaming run is never killed for taking long; a
   *   separate `maxDurationMs` cap (when set) backstops runaways.
   */
  protected execCapturing(
    binary: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
    timeoutMs?: number,
    input?: string,
  ): Promise<CliExecResult> {
    return new Promise((resolve, reject) => {
      const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
      let stdout = '';
      let stderr = '';
      let finished = false;

      let proc: ChildProcess;
      try {
        proc = spawn(binary, args, {
          cwd,
          env,
          // Pipe stdin only when there is input to deliver. Passing a large prompt via stdin
          // instead of an argv positional is how we stay under the OS ARG_MAX limit — a big
          // conversation-aware prompt as an argument fails the spawn with E2BIG.
          stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(new Error(
          `${this.constructor.name}: failed to spawn ${binary} — ${(err as Error).message}`,
        ));
        return;
      }

      // SIGTERM first; if the child ignores it, SIGKILL 10s later. The escalation timer
      // is cleared by 'close' (kill succeeded) and unref'd so it never holds the process open.
      const killWithEscalation = () => {
        proc.kill('SIGTERM');
        const hardKill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 10_000);
        hardKill.unref?.();
        proc.once('close', () => clearTimeout(hardKill));
      };

      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          killWithEscalation();
          reject(new Error(this.idleReset
            ? `${this.constructor.name}: timed out after ${effectiveTimeout}ms of silence (no stdout/stderr activity — idle timeout)`
            : `${this.constructor.name}: timed out after ${effectiveTimeout}ms`));
        }
      }, effectiveTimeout);

      // Runaway backstop: only meaningful under idle semantics (the absolute timer above
      // already caps non-idleReset adapters).
      let durationTimer: NodeJS.Timeout | undefined;
      if (this.idleReset && this.maxDurationMs) {
        durationTimer = setTimeout(() => {
          if (!finished) {
            finished = true;
            clearTimeout(timer);
            killWithEscalation();
            reject(new Error(`${this.constructor.name}: exceeded max duration ${this.maxDurationMs}ms (hard cap — the run was still producing output; raise the max-duration knob if this work is legitimate)`));
          }
        }, this.maxDurationMs);
      }

      const onActivity = this.idleReset ? () => { timer.refresh(); } : undefined;
      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); onActivity?.(); });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); onActivity?.(); });

      if (input != null && proc.stdin) {
        // Ignore EPIPE if the child closes stdin before it finishes reading.
        proc.stdin.on('error', () => {});
        proc.stdin.end(input);
      }

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (durationTimer) clearTimeout(durationTimer);
        if (finished) return;
        finished = true;
        resolve({ stdout, stderr, exitCode: code });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (durationTimer) clearTimeout(durationTimer);
        if (finished) return;
        finished = true;
        reject(new Error(`${this.constructor.name}: failed to spawn ${binary} — ${err.message}`));
      });
    });
  }

  /**
   * @description Like `execCapturing` but throws when the exit code is
   * non-zero (and not null/SIGTERM). Used by `healthCheck()` and any
   * subclass that wants strict success-or-throw semantics.
   */
  protected async execWithTimeout(
    binary: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await this.execCapturing(binary, args, env, cwd, timeoutMs);
    if (result.exitCode !== 0 && result.exitCode !== null) {
      throw new Error(
        `${this.constructor.name}: ${binary} exited with code ${result.exitCode}. stderr: ${result.stderr.slice(0, 500)}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * @description Crude token estimate (4 chars ≈ 1 token) for harnesses /
   * modes that don't return real telemetry. Subclasses with structured
   * output should ignore this and return real `usage` from the parsed
   * response.
   */
  protected estimateUsage(prompt: string, response: string): TokenUsage {
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(response.length / 4);
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }
}
