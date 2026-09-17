/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Sandboxed Agent Runner (ADR-077 Phase 2 Slice 2): run an untrusted edit command in a locked-down container (only its scratch dir writable, no host .git/creds/network), then extract the file changes as a change set for the Dev Session Engine. A container is a real boundary; a cwd is not (Phase-2 red-team).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add sandboxUsable(): a real write-to-/work probe stricter than dockerAvailable(), so integration tests skip on engines where Docker responds but the /work bind mount is not writable by the container user (CI userns-remap). Linux userns-remap /work-writability is a tracked follow-up.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prepare the /work mount for a userns-remapped container uid: every run widens the per-run scratch tree (dirs a+rwx, files a+rw) and the scratch ROOT that contains it stays owner-only 0700, so the widening reaches the per-run directory and nothing above it. Symlinks are never chmodded (chmod follows them, which would widen a target outside the tree). Windows has no POSIX mode bits, so preparation is a declared no-op there.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import type { ChangeSetEdit } from './dev-session-engine';

/**
 * Runs an untrusted agentic/edit command inside a locked-down Docker container so it CANNOT do
 * the things the Phase-2 red-team proved a bare worktree cwd allows: reach the host git object
 * DB/refs (and move `main`), read `~/.claude` creds, write outside its scratch, or egress the
 * network. Only the session scratch dir is writable; the root fs is read-only; all capabilities
 * are dropped; privilege escalation is off. The agent's edits land in the host scratch dir, which
 * is then diffed into a reviewed change set fed to the DevSessionEngine's governed apply/verify/commit.
 *
 * NETWORK: defaults to 'none' (fully isolated) — correct for untrusted/deterministic commands and
 * for the isolation self-test. A real LLM agent needs egress to its provider API; that must be a
 * NARROW egress allowlist (proxy / firewalled bridge), NOT open network — tracked as a hardening
 * item on the ADR. Open egress would let a compromised agent exfiltrate, so it is not the default.
 */

const logger = createChildLogger({ module: 'sandboxed-agent-runner' });
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.tokenchase']);

/**
 * Mount modes that make the bind-mounted /work usable by a container uid that does NOT own it on
 * the host — which is every container under a Linux userns-remapped daemon (GitHub Actions), where
 * container-root is a host subuid. A `mkdtemp` scratch is 0700 and a seeded file 0644, so the
 * remapped uid can neither traverse nor write and every /work write is "Permission denied".
 *
 * The widening is deliberately scoped: the per-run directory and the files inside it become
 * world-writable, and the scratch ROOT that contains it is locked to owner-only. A bind mount is
 * resolved by the daemon, so the container reaches /work without traversing the root — while a
 * second host user must traverse the root and is refused there. Host reach therefore does not
 * extend past the per-run directory.
 */
export const SCRATCH_ROOT_MODE = 0o700;
export const SCRATCH_DIR_MODE = 0o777;
export const SCRATCH_FILE_MODE = 0o666;

/** One entry of the scratch tree and the mode it needs for a foreign container uid to use it. */
export interface ScratchMountEntry {
  path: string;
  mode: number;
}

/** What the scratch tree needs, decided without touching it — the platform-independent half. */
export interface ScratchMountPlan {
  /** Every directory and file inside the scratch, with the mode it needs. */
  entries: ScratchMountEntry[];
  /** Symlinks found inside the scratch and deliberately left alone (chmod would follow them out). */
  skippedSymlinks: string[];
}

/** What {@link SandboxedAgentRunner.prepareScratchMount} actually did, so a guard can assert it. */
export interface ScratchMountPreparation extends ScratchMountPlan {
  /** The entries whose mode was really changed. Empty on Windows, which has no POSIX mode bits. */
  applied: ScratchMountEntry[];
  /** True on platforms without POSIX mode bits (Windows): the plan is computed and not applied. */
  skipped: boolean;
}

export interface SandboxRunnerConfig {
  /** Container image (has the agent's toolchain). Defaults to a tiny base for the self-test. */
  image?: string;
  /** Docker network mode. 'none' (default, isolated) or a narrow egress network for a real agent. */
  network?: string;
  memory?: string;
  pidsLimit?: number;
}

export interface SandboxRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export interface SandboxRunExtra {
  /** Read-only mounts (e.g. `~/.claude` creds for a real agent). Never writable. */
  roMounts?: Array<{ host: string; container: string }>;
  /** Override the network for this run (e.g. a narrow provider-egress network for a real agent). */
  network?: string;
  /** Override the image for this run (e.g. the any-bot image that ships claude/codex). */
  image?: string;
}

export interface IsolationReport {
  workWritable: boolean;
  rootReadOnly: boolean;
  networkBlocked: boolean;
  hostFsInvisible: boolean;
  credsInvisible: boolean;
  passed: boolean;
  raw: string;
}

/**
 * @description Runs untrusted edit commands in a locked-down container and extracts their changes.
 */
export class SandboxedAgentRunner {
  private readonly image: string;
  private readonly network: string;
  private readonly memory: string;
  private readonly pidsLimit: number;

  /**
   * @param config - Runner configuration.
   */
  constructor(config: SandboxRunnerConfig = {}) {
    this.image = config.image ?? 'alpine:latest';
    this.network = config.network ?? 'none';
    this.memory = config.memory ?? '1g';
    this.pidsLimit = config.pidsLimit ?? 512;
  }

  /**
   * @description Whether a usable Docker engine is reachable (integration paths no-op without it).
   * @returns true when `docker version` succeeds.
   */
  static dockerAvailable(): boolean {
    const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 15_000 });
    return probe.status === 0 && Boolean((probe.stdout ?? '').trim());
  }

  /**
   * @description Whether the sandbox can ACTUALLY run — stricter than {@link dockerAvailable}:
   * Docker must respond AND a throwaway container must be able to write to the bind-mounted
   * /work scratch. Some engines report a Docker version yet cannot support the sandbox: e.g.
   * a userns-remapped daemon maps container-root to a host subuid that owns nothing on the host.
   * {@link prepareScratchMount} is what makes that case work, so the probe is now a real check of
   * this engine rather than a standing exclusion: it mounts a per-run directory inside a private
   * 0700 root, exactly as a session run does, and reports whether the container wrote to it.
   * @returns true only when a trivial write-to-/work sandbox run succeeds end to end.
   */
  static sandboxUsable(): boolean {
    if (!SandboxedAgentRunner.dockerAvailable()) return false;
    let dir: string | undefined;
    try {
      // The private root is never the mount: mounting a mkdtemp directly would force the widening
      // onto a directory sitting straight under a world-traversable /tmp. The mount is its child.
      dir = mkdtempSync(path.join(tmpdir(), 'sar-probe-'));
      SandboxedAgentRunner.lockScratchRoot(dir);
      const work = path.join(dir, 'work');
      mkdirSync(work, { recursive: true });
      const result = new SandboxedAgentRunner().run(
        work,
        ['sh', '-c', 'echo ok > /work/.probe && cat /work/.probe'],
        30_000,
      );
      return result.exitCode === 0 && /ok/.test(result.output ?? '');
    } catch {
      return false;
    } finally {
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* throwaway */ }
      }
    }
  }

  /**
   * @description Runs `command` inside the locked-down container with `scratchDir` bind-mounted at
   * /work (the only writable path). Never mounts the host repo, git dir, or credentials.
   * @param scratchDir - Absolute host path made available rw at /work.
   * @param command - Command + args to run inside the container.
   * @param timeoutMs - Hard wall-clock timeout.
   * @returns exit code + combined output + whether it timed out.
   */
  run(scratchDir: string, command: string[], timeoutMs = 600_000, extra: SandboxRunExtra = {}): SandboxRunResult {
    SandboxedAgentRunner.prepareScratchMount(scratchDir);
    const args = this.dockerArgs(scratchDir, command, extra);
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    const timedOut = Boolean((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || result.signal);
    return { exitCode: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(0, 200_000), timedOut };
  }

  /**
   * @description Streaming variant of `run`: spawns the container and calls `onChunk` with each
   * stdout/stderr chunk AS IT ARRIVES (the live thought-chain), not only at the end. Same
   * locked-down profile. Resolves with the final exit code + combined output.
   * @param scratchDir - Absolute host path made available rw at /work.
   * @param command - Command + args to run inside the container.
   * @param onChunk - Called with each output chunk as it streams.
   * @param timeoutMs - Hard wall-clock timeout (the container is killed on expiry).
   * @param extra - Optional creds mounts / network / image overrides.
   * @returns Promise of exit code + combined output + whether it timed out.
   */
  runStreaming(
    scratchDir: string,
    command: string[],
    onChunk: (chunk: string) => void,
    timeoutMs = 900_000,
    extra: SandboxRunExtra = {},
    signal?: AbortSignal,
  ): Promise<SandboxRunResult> {
    // Name the container so we can reap it directly: SIGKILL on the `docker run` CLI does NOT
    // stop the container (it runs in the engine/VM, not as a child of the CLI), so we must
    // `docker kill <name>` on timeout, abort, or client disconnect — otherwise it leaks.
    SandboxedAgentRunner.prepareScratchMount(scratchDir);
    const name = `oshal-dev-${randomUUID().slice(0, 12)}`;
    const args = this.dockerArgs(scratchDir, command, extra);
    args.splice(2, 0, '--name', name);
    const kill = (): void => { try { spawnSync('docker', ['kill', name], { timeout: 15_000 }); } catch { /* already gone */ } };
    return new Promise((resolve) => {
      const child = spawn('docker', args, { windowsHide: true });
      let output = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      const onAbort = (): void => { kill(); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const finish = (result: SandboxRunResult): void => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onData = (buf: Buffer): void => {
        const text = buf.toString('utf8');
        output += text;
        if (output.length < 4_000_000) onChunk(text);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (error) => finish({ exitCode: null, output: `${output}\n${error instanceof Error ? error.message : String(error)}`.slice(0, 200_000), timedOut }));
      child.on('close', (code) => finish({ exitCode: code, output: output.slice(0, 200_000), timedOut }));
    });
  }

  /**
   * @description Locks the directory that CONTAINS per-run scratch directories to owner-only, so
   * the per-run widening below cannot be reached by another user on the host. Call it once on the
   * scratch root; the per-run directory inside it is prepared by {@link prepareScratchMount}.
   * @param root - Absolute path of the scratch root (the parent of the per-run directories).
   * @returns true when the 0700 mode was applied; false on Windows or when the chmod failed.
   */
  static lockScratchRoot(root: string): boolean {
    if (process.platform === 'win32') return false;
    try {
      chmodSync(root, SCRATCH_ROOT_MODE);
      return true;
    } catch (error) {
      logger.warn({ root, error }, 'could not lock sandbox scratch root to owner-only');
      return false;
    }
  }

  /**
   * @description Makes the per-run scratch writable by the container uid that will be bind-mounted
   * on it. Under a Linux userns-remapped daemon that uid is a host subuid owning nothing, so a
   * 0700 `mkdtemp` directory and its 0644 seeded files deny every write to /work; the sandbox then
   * fails for a host-configuration reason rather than a real isolation regression. Widening is
   * confined to this directory tree: symlinks are skipped (chmod follows them, which would widen a
   * target outside the scratch) and the ignored trees are not descended into.
   * @param scratchDir - Absolute path of the per-run directory that will be mounted at /work.
   * @returns What was widened, which symlinks were skipped, and whether the platform has no modes.
   */
  static prepareScratchMount(scratchDir: string): ScratchMountPreparation {
    const plan = SandboxedAgentRunner.scratchMountPlan(scratchDir);
    const prepared: ScratchMountPreparation = { ...plan, applied: [], skipped: process.platform === 'win32' };
    if (prepared.skipped) return prepared;
    for (const entry of plan.entries) {
      try {
        chmodSync(entry.path, entry.mode);
        prepared.applied.push(entry);
      } catch (error) {
        logger.warn({ entry, error }, 'could not widen sandbox scratch entry for a remapped container uid');
      }
    }
    return prepared;
  }

  /**
   * @description Decides, without changing anything, which entries of the scratch tree need which
   * mode. Split out from {@link prepareScratchMount} so the decision — walk order, the ignored
   * trees, the symlink refusal, and which mode each kind of entry gets — is assertable on a host
   * that has no POSIX mode bits to inspect afterwards.
   * @param scratchDir - Absolute path of the per-run directory that will be mounted at /work.
   * @returns The entries to widen and the symlinks deliberately left alone.
   */
  static scratchMountPlan(scratchDir: string): ScratchMountPlan {
    const plan: ScratchMountPlan = { entries: [], skippedSymlinks: [] };
    const visit = (target: string): void => {
      let stats;
      try {
        stats = lstatSync(target);
      } catch {
        return; // raced away between readdir and lstat; nothing to widen
      }
      if (stats.isSymbolicLink()) { plan.skippedSymlinks.push(target); return; }
      if (stats.isDirectory()) {
        plan.entries.push({ path: target, mode: SCRATCH_DIR_MODE });
        for (const entry of readdirSync(target)) {
          if (IGNORED_DIRS.has(entry)) continue;
          visit(path.join(target, entry));
        }
        return;
      }
      if (stats.isFile()) plan.entries.push({ path: target, mode: SCRATCH_FILE_MODE });
    };
    visit(path.resolve(scratchDir));
    return plan;
  }

  /**
   * Builds the locked-down `docker run` argument vector (proven profile). `extra.roMounts` add
   * READ-ONLY mounts (e.g. The operator's `~/.claude` so a real agent can authenticate — never rw)
   * and `extra.network`/`extra.image` override the defaults for a real-agent run (which needs
   * narrow provider egress). The write surface is always exactly /work.
   */
  private dockerArgs(scratchDir: string, command: string[], extra: SandboxRunExtra): string[] {
    const roMounts = (extra.roMounts ?? []).flatMap((m) => ['-v', `${toWindowsPath(m.host)}:${m.container}:ro`]);
    return [
      'run', '--rm',
      '--network', extra.network ?? this.network,
      '--read-only',
      '--tmpfs', '/tmp:rw,size=256m',
      '--tmpfs', '/run:rw,size=16m',
      '-v', `${toWindowsPath(scratchDir)}:/work`,
      ...roMounts,
      '-w', '/work',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--memory', this.memory,
      '--pids-limit', String(this.pidsLimit),
      extra.image ?? this.image,
      ...command,
    ];
  }

  /**
   * @description Runs an adversarial probe inside the sandbox and reports whether every escape is
   * blocked. This is the live proof that the sandbox is a real boundary on THIS host.
   * @param scratchDir - A throwaway scratch dir to mount.
   * @returns A structured isolation report; `passed` is true only when all escapes are blocked.
   */
  selfTestIsolation(scratchDir: string): IsolationReport {
    const probe =
      'printf "work="; (echo ok > /work/.probe && echo yes || echo no); ' +
      'printf "root="; (mkdir /pwned 2>/dev/null && echo writable || echo readonly); ' +
      'printf "net="; (wget -T2 -qO- http://1.1.1.1 >/dev/null 2>&1 && echo reached || echo blocked); ' +
      'printf "hostfs="; ([ -e /c ] || [ -e /host ] || [ -e /mnt/c ] && echo visible || echo invisible); ' +
      'printf "creds="; (ls /root/.claude >/dev/null 2>&1 && echo visible || echo invisible)';
    const { output } = this.run(scratchDir, ['sh', '-c', probe], 60_000);
    const has = (needle: string): boolean => output.includes(needle);
    const report: IsolationReport = {
      workWritable: has('work=yes'),
      rootReadOnly: has('root=readonly'),
      networkBlocked: has('net=blocked'),
      hostFsInvisible: has('hostfs=invisible'),
      credsInvisible: has('creds=invisible'),
      passed: false,
      raw: output,
    };
    report.passed = report.workWritable && report.rootReadOnly && report.networkBlocked
      && report.hostFsInvisible && report.credsInvisible;
    if (!report.passed) logger.error({ report }, 'sandbox isolation self-test FAILED — do not run untrusted commands');
    return report;
  }

  /**
   * @description Snapshots the content hashes of a directory tree (excluding .git/node_modules),
   * so a later extractChangeSet can tell what the sandboxed command changed.
   * @param dir - Directory to snapshot.
   * @returns Map of posix-relative path to sha-256 of its bytes.
   */
  snapshot(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    walkFiles(dir, dir, (rel, abs) => out.set(rel, sha256(readFileSync(abs))));
    return out;
  }

  /**
   * @description Diffs the scratch dir against a pre-run snapshot and returns the new/changed text
   * files as a change set ready for DevSessionEngine.applyChangeSet. Binary or deleted files are
   * reported via `deleted`/`skippedBinary` rather than smuggled in.
   * @param scratchDir - The scratch dir the sandboxed command wrote to.
   * @param before - Snapshot taken before the run.
   * @returns The extracted change set plus lists of deleted and skipped-binary paths.
   */
  extractChangeSet(scratchDir: string, before: Map<string, string>): {
    edits: ChangeSetEdit[];
    deleted: string[];
    skippedBinary: string[];
  } {
    const edits: ChangeSetEdit[] = [];
    const skippedBinary: string[] = [];
    const seen = new Set<string>();
    walkFiles(scratchDir, scratchDir, (rel, abs) => {
      seen.add(rel);
      const bytes = readFileSync(abs);
      if (before.get(rel) === sha256(bytes)) return; // unchanged
      if (isBinary(bytes)) { skippedBinary.push(rel); return; }
      edits.push({ path: rel, content: bytes.toString('utf8') });
    });
    const deleted = [...before.keys()].filter((rel) => !seen.has(rel));
    return { edits, deleted, skippedBinary };
  }
}

/** Converts a host path to the `C:/...` form Docker's -v expects on Windows (no-op elsewhere). */
function toWindowsPath(p: string): string {
  const resolved = path.resolve(p);
  const drive = resolved.match(/^([a-zA-Z]):[\\/]/);
  return drive ? resolved.replace(/\\/g, '/') : resolved;
}

/** Recursively visits files under `dir` (excluding IGNORED_DIRS), calling cb(relPosix, abs). */
function walkFiles(root: string, current: string, cb: (rel: string, abs: string) => void): void {
  if (!existsSync(current)) return;
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name.startsWith('.probe')) continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walkFiles(root, abs, cb);
    } else if (entry.isFile()) {
      if (statSync(abs).size > 4 * 1024 * 1024) continue; // skip very large files
      cb(path.relative(root, abs).split(path.sep).join('/'), abs);
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8000);
  return sample.includes(0);
}
