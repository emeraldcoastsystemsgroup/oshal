/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Sandboxed Agent Runner (ADR-077 Phase 2 Slice 2): run an untrusted edit command in a locked-down container (only its scratch dir writable, no host .git/creds/network), then extract the file changes as a change set for the Dev Session Engine. A container is a real boundary; a cwd is not (Phase-2 red-team).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add sandboxUsable(): a real write-to-/work probe stricter than dockerAvailable(), so integration tests skip on engines where Docker responds but the /work bind mount is not writable by the container user (CI userns-remap). Linux userns-remap /work-writability is a tracked follow-up.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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
   * GitHub Actions' userns-remapped daemon maps container-root to a host subuid that does not
   * own the `mkdtemp` (mode-0700) bind mount, so every write to /work is "Permission denied"
   * and the isolation self-test fails for an ENVIRONMENT reason, not a real regression. The
   * Docker integration tests gate on this so they run where the sandbox works (e.g. the
   * operator's Docker Desktop) and skip cleanly where the host Docker cannot support it.
   * Linux userns-remap /work-writability is a tracked dev-console follow-up (BACKLOG).
   * @returns true only when a trivial write-to-/work sandbox run succeeds end to end.
   */
  static sandboxUsable(): boolean {
    if (!SandboxedAgentRunner.dockerAvailable()) return false;
    let dir: string | undefined;
    try {
      dir = mkdtempSync(path.join(tmpdir(), 'sar-probe-'));
      const result = new SandboxedAgentRunner().run(
        dir,
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
