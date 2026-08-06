/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Dev Session Engine (ADR-077 Phase 2): isolated-worktree edit governance — create -> apply -> diff -> verify -> commit-to-branch -> teardown. Never touches main or the live working tree.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening after adversarial red-team: removed the unconfined runAgent (a cwd is NOT a sandbox — needs an OS jail; deferred to the sandboxed-agent slice); teardown refuses to remove while the node_modules junction is still present (was: --force could recurse through it and delete the SHARED node_modules); safeJoin is now realpath-aware and rejects .git/.githooks/node_modules; every method validates the session (poisoned registry can't repoint the worktree); commit now requires a passing verify for the exact tree.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: isolate verify and Git child processes from controller/database/provider credentials while retaining only runtime, locale, proxy, Git author, and explicit branch-policy settings.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';

/**
 * The safety spine of platform self-development (ADR-077 Phase 2). A reviewed change set is
 * applied inside an ISOLATED git worktree on a dedicated branch, reviewed as a diff, gated by
 * typecheck, and committed to that branch. It NEVER writes to the live working tree and NEVER
 * commits to main/master. Because the deployed checkout is hot-swap-mounted (an edit to live
 * `src/**` reloads the running platform instantly), that isolation is what keeps
 * generation-in-progress off production until a human approves.
 *
 * SECURITY BOUNDARY NOTE: a git worktree shares the object database + refs of the main repo, and
 * a process's cwd does not confine its filesystem writes. So this engine intentionally does NOT
 * run an arbitrary agent process itself — an unconfined agent could `git update-ref refs/heads/main`
 * or write any absolute path. The agentic (LLM) loop must run in a real OS sandbox (container/jail)
 * whose only writable mount is the session worktree, and it feeds its result here as a reviewed
 * change set. This engine governs the SAFE apply -> verify -> commit substrate; the sandbox is a
 * separate slice. Runs on the host / sidecar node (git + node), NOT in the swarm controller.
 */

const logger = createChildLogger({ module: 'dev-session-engine' });

export interface DevSessionEngineConfig {
  /** Absolute path to the OSHAL git repo. */
  repoRoot: string;
  /** Where worktrees are created. MUST be outside repoRoot. Defaults to a sibling dir. */
  worktreesRoot?: string;
  /** Branch namespace for sessions. Sessions only ever operate on `${branchPrefix}<id>`. */
  branchPrefix?: string;
  /** Verify command run inside the worktree before a commit is allowed. */
  verifyCommand?: string[];
}

export interface DevSession {
  id: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  createdAt: string;
  /** Tree SHA that verify() last passed against; commit() requires the staged tree to match it. */
  verifiedTree?: string;
}

export interface ChangeSetEdit {
  /** Worktree-relative path. Traversal, symlink escape, and .git/.githooks/node_modules are rejected. */
  path: string;
  content: string;
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

export interface DevSessionDiff {
  patch: string;
  files: DiffFile[];
  changed: boolean;
}

export interface VerifyResult {
  passed: boolean;
  command: string;
  output: string;
  durationMs: number;
  /** Tree SHA the verify ran against (recorded so commit can bind to it). */
  tree: string;
}

export interface CommitResult {
  sha: string;
  branch: string;
}

// Invoke tsc directly via `node` (exactly what `npm run typecheck` does) so verify works with
// spawnSync shell:false cross-platform — `npm` resolves to npm.cmd on Windows and cannot be
// launched without a shell. `--preserveSymlinks` is REQUIRED because the worktree's node_modules
// is a junction: without it tsc resolves types through the junction to the main repo's real path
// and emits spurious TS2742 "not portable" errors for every Express-typed handler.
const DEFAULT_VERIFY: string[] = ['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit', '--preserveSymlinks', '--pretty', 'false'];
const PROTECTED_BRANCHES = new Set(['main', 'master', 'HEAD']);
const FORBIDDEN_SEGMENTS = new Set(['.git', '.githooks', 'node_modules']);
const BIG_BUFFER = 256 * 1024 * 1024;
const DEV_SESSION_PROCESS_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'CI', 'NODE_ENV', 'FORCE_COLOR',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
] as const;
const DEV_SESSION_EXTRA_ENV_KEYS = ['ALLOW_NONMAIN_COMMIT'] as const;

/** Build a least-privilege environment for dev-session verification and Git subprocesses. */
export function buildDevSessionProcessEnv(
  extra: NodeJS.ProcessEnv = {},
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DEV_SESSION_PROCESS_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of DEV_SESSION_EXTRA_ENV_KEYS) {
    const value = extra[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * @description Governs isolated, reviewable, verify-gated change sets applied to the OSHAL repo.
 */
export class DevSessionEngine {
  private readonly repoRoot: string;
  private readonly worktreesRoot: string;
  private readonly branchPrefix: string;
  private readonly verifyCommand: string[];

  /**
   * @param config - Engine configuration; only repoRoot is required.
   */
  constructor(config: DevSessionEngineConfig) {
    this.repoRoot = path.resolve(config.repoRoot);
    this.worktreesRoot = path.resolve(config.worktreesRoot ?? path.join(this.repoRoot, '..', 'oshal-dev-sessions'));
    this.branchPrefix = config.branchPrefix ?? 'dev-session/';
    this.verifyCommand = config.verifyCommand ?? DEFAULT_VERIFY;
    if (isInside(this.worktreesRoot, this.repoRoot)) {
      throw new Error('worktreesRoot must be OUTSIDE repoRoot so worktrees never overlay the live tree');
    }
    if (!existsSync(path.join(this.repoRoot, '.git'))) {
      throw new Error(`repoRoot is not a git repository: ${this.repoRoot}`);
    }
  }

  /**
   * @description Opens a session: a fresh worktree on a new `${branchPrefix}<id>` branch from
   * HEAD, with a node_modules junction so verify can resolve dependencies without a copy.
   * @param label - Optional human label folded into the session id.
   * @returns The created session.
   */
  create(label?: string): DevSession {
    const id = `${sanitizeLabel(label)}${shortId()}`;
    const worktreePath = path.join(this.worktreesRoot, id);
    if (!isInside(worktreePath, this.worktreesRoot)) {
      throw new Error('resolved worktree path escaped worktreesRoot');
    }
    const branch = `${this.branchPrefix}${id}`;
    mkdirSync(this.worktreesRoot, { recursive: true });
    const baseSha = this.git(['rev-parse', 'HEAD']).trim();
    this.git(['worktree', 'add', worktreePath, '-b', branch]);
    this.linkNodeModules(worktreePath);
    logger.info({ id, branch, worktreePath }, 'dev-session created');
    return { id, worktreePath, branch, baseSha, createdAt: new Date().toISOString() };
  }

  /**
   * @description Writes a reviewed change set into the worktree. Each path is confined to the
   * worktree (traversal, symlink escape, and .git/.githooks/node_modules rejected). Deterministic.
   * @param session - The active session.
   * @param edits - Files to write (worktree-relative path + content).
   * @returns The worktree-relative paths written.
   */
  applyChangeSet(session: DevSession, edits: ChangeSetEdit[]): string[] {
    this.assertSession(session);
    const written: string[] = [];
    for (const edit of edits) {
      const target = this.safeJoin(session, edit.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, edit.content, 'utf8');
      written.push(edit.path);
    }
    return written;
  }

  /**
   * @description Computes the reviewable diff of everything changed in the worktree (including
   * new files), by staging into the worktree's own isolated index and diffing against HEAD.
   * @param session - The active session.
   * @returns Unified patch + per-file add/remove stats.
   */
  diff(session: DevSession): DevSessionDiff {
    this.assertSession(session);
    this.gitIn(session, ['add', '-A']);
    const patch = this.gitIn(session, ['diff', '--cached']);
    const numstat = this.gitIn(session, ['diff', '--cached', '--numstat']);
    const files = parseNumstat(numstat);
    return { patch, files, changed: files.length > 0 };
  }

  /**
   * @description Runs the verify command (default `npm run typecheck`) inside the worktree and,
   * on success, records the tree SHA it passed against so commit() can bind to it.
   * @param session - The active session (mutated: verifiedTree set on pass).
   * @param override - Optional command to run instead of the configured verifyCommand.
   * @returns Pass/fail + captured output + duration + the tree the verify ran against.
   */
  verify(session: DevSession, override?: string[]): VerifyResult {
    this.assertSession(session);
    const tree = this.stagedTree(session);
    const command = override ?? this.verifyCommand;
    const [cmd, ...args] = command;
    const started = Date.now();
    const result = spawnSync(cmd, args, {
      cwd: session.worktreePath,
      env: buildDevSessionProcessEnv(),
      encoding: 'utf8',
      timeout: 900_000,
      shell: false,
      maxBuffer: BIG_BUFFER,
    });
    const passed = result.status === 0;
    if (passed) session.verifiedTree = tree;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return { passed, command: command.join(' '), output: output.slice(-20_000), durationMs: Date.now() - started, tree };
  }

  /**
   * @description Non-blocking variant of verify(): runs the verify command via async `spawn` so a
   * multi-second typecheck never blocks the caller's event loop (a self-edit session must not
   * freeze a co-resident server). Same semantics + tree-binding as verify().
   * @param session - The active session (mutated: verifiedTree set on pass).
   * @param override - Optional command to run instead of the configured verifyCommand.
   * @returns Promise of pass/fail + captured output + duration + the tree.
   */
  verifyAsync(session: DevSession, override?: string[]): Promise<VerifyResult> {
    this.assertSession(session);
    const tree = this.stagedTree(session);
    const command = override ?? this.verifyCommand;
    const [cmd, ...args] = command;
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: session.worktreePath,
        env: buildDevSessionProcessEnv(),
        windowsHide: true,
      });
      let output = '';
      const collect = (buf: Buffer): void => { if (output.length < 4_000_000) output += buf.toString('utf8'); };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      const done = (passed: boolean): void => {
        if (passed) session.verifiedTree = tree;
        resolve({ passed, command: command.join(' '), output: output.slice(-20_000), durationMs: Date.now() - started, tree });
      };
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
    });
  }

  /**
   * @description Commits the worktree's staged changes to its session branch. Refuses to commit
   * unless (a) verify() has passed for the EXACT current tree, and (b) the worktree is on a
   * `${branchPrefix}*` branch (never main/master) — the invariants that keep self-development
   * off the live line and un-typechecked code out of history.
   * @param session - The active session.
   * @param message - Commit message.
   * @returns The new commit SHA + branch.
   */
  commit(session: DevSession, message: string): CommitResult {
    this.assertSession(session);
    const currentTree = this.stagedTree(session);
    if (!session.verifiedTree || session.verifiedTree !== currentTree) {
      throw new Error('refusing to commit: no passing verify for the current tree (run verify first; re-verify after any change)');
    }
    const branch = this.gitIn(session, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (PROTECTED_BRANCHES.has(branch) || !branch.startsWith(this.branchPrefix)) {
      throw new Error(`refusing to commit: worktree is on '${branch}', not a '${this.branchPrefix}*' session branch`);
    }
    // The repo pre-commit hook enforces trunk-based commits (RULE 0: code only on main). A
    // dev-session branch is the sanctioned exception — an isolated, ephemeral, reviewed proposal,
    // NOT feature-branch sprawl — so we use the hook's OWN branch-policy override. Its
    // conflict-marker and secret-scan guards are deliberately left ON.
    execFileSync('git', ['-C', session.worktreePath, 'commit', '-m', message], {
      encoding: 'utf8',
      maxBuffer: BIG_BUFFER,
      env: buildDevSessionProcessEnv({ ALLOW_NONMAIN_COMMIT: '1' }),
    });
    const sha = this.gitIn(session, ['rev-parse', 'HEAD']).trim();
    logger.info({ id: session.id, branch, sha }, 'dev-session committed to branch');
    return { sha, branch };
  }

  /**
   * @description Disposes the worktree and (optionally) its branch. CRITICAL ORDERING: the
   * node_modules junction is removed and PROVEN gone before the destructive worktree removal, so
   * `git worktree remove --force` can never recurse through the junction into the SHARED
   * dependency tree. Refuses (throws) rather than risk deleting the real node_modules.
   * @param session - The session to dispose.
   * @param options - keepBranch to preserve the session branch for later merge/inspection.
   */
  teardown(session: DevSession, options: { keepBranch?: boolean } = {}): void {
    this.assertSession(session);
    const link = path.join(session.worktreePath, 'node_modules');
    const st = lstatSync(link, { throwIfNoEntry: false });
    if (st) {
      if (!st.isSymbolicLink()) {
        throw new Error(`refusing to remove worktree: ${link} is a real directory, not the junction — inspect it manually`);
      }
      try {
        unlinkSync(link);
      } catch (error) {
        logger.error({ err: error, link }, 'failed to unlink node_modules junction; refusing destructive worktree removal');
        throw new Error(`refusing to remove worktree: could not unlink node_modules junction (${errMsg(error)})`);
      }
    }
    if (lstatSync(link, { throwIfNoEntry: false })) {
      throw new Error('refusing to remove worktree: node_modules link still present after unlink');
    }
    this.git(['worktree', 'remove', session.worktreePath, '--force']);
    if (!options.keepBranch) {
      try { this.git(['branch', '-D', session.branch]); } catch { /* branch may be checked out elsewhere */ }
    }
    logger.info({ id: session.id }, 'dev-session torn down');
  }

  /** Stages all worktree changes into its isolated index and returns the resulting tree SHA. */
  private stagedTree(session: DevSession): string {
    this.gitIn(session, ['add', '-A']);
    return this.gitIn(session, ['write-tree']).trim();
  }

  /** Creates the shared node_modules junction (no admin needed, no copy). Best-effort. */
  private linkNodeModules(worktreePath: string): void {
    const source = path.join(this.repoRoot, 'node_modules');
    if (!existsSync(source)) return;
    const link = path.join(worktreePath, 'node_modules');
    if (existsSync(link)) return;
    try {
      symlinkSync(source, link, 'junction');
    } catch (error) {
      logger.warn({ err: error }, 'could not link node_modules; verify will fail loudly if deps cannot resolve');
    }
  }

  /**
   * Confines a worktree-relative path to the worktree. Realpath-aware (a symlinked ancestor
   * cannot smuggle the write outside), rejects an existing-symlink target, and forbids writing
   * to .git / .githooks / node_modules (which could subvert the commit hooks or the junction).
   */
  private safeJoin(session: DevSession, rel: string): string {
    const segments = rel.split(/[\\/]+/).filter(Boolean);
    if (segments.some((seg) => FORBIDDEN_SEGMENTS.has(seg))) {
      throw new Error(`refusing to write to a protected path (.git/.githooks/node_modules): ${rel}`);
    }
    const root = realpathSync(session.worktreePath);
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`path escapes the worktree: ${rel}`);
    }
    let ancestor = path.dirname(target);
    while (!existsSync(ancestor) && ancestor !== path.dirname(ancestor)) {
      ancestor = path.dirname(ancestor);
    }
    const realAncestor = realpathSync(ancestor);
    if (realAncestor !== root && !realAncestor.startsWith(root + path.sep)) {
      throw new Error(`path escapes the worktree via a symlinked directory: ${rel}`);
    }
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing && existing.isSymbolicLink()) {
      throw new Error(`refusing to write through a symlink: ${rel}`);
    }
    return target;
  }

  /**
   * Validates that a session (which may have been loaded from an untrusted registry) still points
   * inside worktreesRoot and at a session-namespace branch. Every method calls this first, so a
   * poisoned sessions.json cannot repoint operations at the live tree or main.
   */
  private assertSession(session: DevSession): void {
    if (!isInside(path.resolve(session.worktreePath), this.worktreesRoot)) {
      throw new Error('untrusted session: worktreePath is outside worktreesRoot');
    }
    if (PROTECTED_BRANCHES.has(session.branch) || !session.branch.startsWith(this.branchPrefix)) {
      throw new Error(`untrusted session: '${session.branch}' is not a '${this.branchPrefix}*' branch`);
    }
  }

  /** Runs git in the MAIN repo (only worktree/branch management — never edits its tree/index). */
  private git(args: string[]): string {
    return execFileSync('git', ['-C', this.repoRoot, ...args], {
      encoding: 'utf8',
      env: buildDevSessionProcessEnv(),
      maxBuffer: BIG_BUFFER,
    });
  }

  /** Runs git inside the session worktree (its own isolated tree + index). */
  private gitIn(session: DevSession, args: string[]): string {
    return execFileSync('git', ['-C', session.worktreePath, ...args], {
      encoding: 'utf8',
      env: buildDevSessionProcessEnv(),
      maxBuffer: BIG_BUFFER,
    });
  }
}

/** True when `child` is the same as, or nested inside, `parent`. */
function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

function parseNumstat(numstat: string): DiffFile[] {
  return numstat
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t');
      const binary = added === '-' || removed === '-';
      return {
        path: rest.join('\t'),
        added: binary ? 0 : Number.parseInt(added, 10) || 0,
        removed: binary ? 0 : Number.parseInt(removed, 10) || 0,
        binary,
      };
    });
}

function sanitizeLabel(label?: string): string {
  const clean = (label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return clean ? `${clean}-` : '';
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
