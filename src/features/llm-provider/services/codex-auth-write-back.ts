/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Codex auth write-back (BACKLOG token-stranding fix): the codex CLI rotates its SINGLE-USE ChatGPT refresh_token inside the per-task .codex-home COPY of auth.json, and nothing propagated it back to the shared source — one in-container refresh stranded the only valid refresh token in a dead workspace and bricked codex auth until a host re-login. This helper snapshots the per-task auth.json before the spawn and, after the run, compare-and-swaps the rotated content back to the source (only when the source still equals the snapshot — a moved source means a host re-login or another writer won, and clobbering it would destroy a NEWER token chain). Atomic tmp+rename write, fully synchronous (Node's single thread makes the read-check-write race-free in-process), and never throws into the task path.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review hardening (4-skeptic pass): (1) content-validity guard — only a parseable codex auth shape (tokens.access/refresh_token or a non-empty OPENAI_API_KEY) is ever propagated to the shared source, so a torn read after a SIGKILL or workspace-injected garbage cannot poison the credential ('invalid' outcome); (2) missing-source create — when seeding came from secrets.json and no source FILE exists, an ENOENT is now distinguished from a moved source and the rotation is persisted via an exclusive 'wx' create instead of warn-looping forever; (3) reseedFromAdvancedSource — lets callers refresh an untouched per-task copy when another task's write-back advanced the source while this task queued (boot-storm waiters, same-workspace lease queues).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Verifier round 2: (1) re-seed now requires the source to be provably NEWER (last_refresh comparison) and valid-shaped — "source differs" alone re-seeded the DEAD chain over the only live copy after a failed write-back, bricking codex; when in doubt the copy wins (stale copy = one recoverable task failure, destroyed live chain = host re-login). (2) A non-ENOENT source read error (EACCES/EIO) now returns 'failed' with the real error instead of masquerading as 'source-moved'. (3) The missing-source create is tmp+linkSync (atomic AND exclusive) — a bare 'wx' write could crash mid-create and leave a torn source that blocks all future creates.
 */

import fs from 'fs';
import path from 'path';

/**
 * @description Outcome of one write-back attempt, for logging and tests.
 * - `written`      — the per-task auth.json changed during the run and was persisted to the source
 *                    (including the create-on-ENOENT path when no source file existed).
 * - `unchanged`    — the CLI did not rotate the token (the overwhelmingly common case).
 * - `source-moved` — the token rotated, but the source no longer matches the pre-run snapshot
 *                    (host re-login or another task's write-back) — NOT clobbered.
 * - `invalid`      — the per-task file changed but does not parse as a codex auth shape
 *                    (torn write after a SIGKILL, or garbage) — never propagated.
 * - `skipped`      — nothing to do (no snapshot, per-task file missing, or no source path).
 * - `failed`       — the atomic write itself failed (e.g. a read-only mount); logged, never thrown.
 */
export type CodexAuthWriteBackOutcome =
  | 'written' | 'unchanged' | 'source-moved' | 'invalid' | 'skipped' | 'failed';

/**
 * @description Minimal logger shape so both the harness adapter (pino child) and tests can
 * supply one without importing the logger module here.
 */
export interface CodexAuthWriteBackLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * @description Reads the per-task auth.json as the pre-run snapshot. Call this AFTER the
 * per-workspace lease is acquired and BEFORE the CLI spawns — snapshotting before the lease
 * lets a queued same-workspace task capture a pre-rotation baseline, which would CAS-fail its
 * own later rotation and re-introduce the stranding this module exists to fix. Returns null
 * when the file is missing or unreadable — writeBackRotatedCodexAuth treats a null snapshot
 * as "nothing to do", because without a baseline we cannot prove the per-task content is the
 * successor of the source's token chain.
 * @param perTaskAuthPath Absolute path to `<workspace>/.codex-home/.codex/auth.json`.
 * @returns The file content, or null when absent/unreadable.
 */
export function snapshotCodexAuth(perTaskAuthPath: string): string | null {
  try {
    return fs.readFileSync(perTaskAuthPath, 'utf8');
  } catch {
    // Expected-absence path (fresh workspace with no credential); not an error condition.
    return null;
  }
}

/**
 * @description True when `content` parses as a plausible codex auth.json: either ChatGPT-OAuth
 * shape (`tokens.access_token` / `tokens.refresh_token`) or API-key shape (non-empty
 * `OPENAI_API_KEY`). This is the guard that keeps a torn write (SIGKILL mid-rotation) or
 * workspace-injected garbage out of the SHARED credential file — the CAS is a concurrency
 * guard, not a content guard.
 * @param content Candidate auth.json content.
 * @returns Whether the content is safe to propagate.
 */
export function looksLikeCodexAuth(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const tokens = parsed.tokens as Record<string, unknown> | undefined;
    const hasOauthTokens = !!tokens && typeof tokens === 'object'
      && (typeof tokens.access_token === 'string' || typeof tokens.refresh_token === 'string');
    const hasApiKey = typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0;
    return hasOauthTokens || hasApiKey;
  } catch {
    return false;
  }
}

/**
 * @description Parses the `last_refresh` ISO timestamp out of an auth.json content string.
 * Both the codex CLI and buildAuthFilePayload stamp it on every write, so it is the honest
 * "which chain is newer" signal.
 * @param content Candidate auth.json content.
 * @returns Epoch millis, or null when the content is invalid or unstamped.
 */
function authLastRefreshMs(content: string): number | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.last_refresh !== 'string') return null;
    const ms = Date.parse(parsed.last_refresh);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * @description Re-seeds an UNTOUCHED per-task auth.json copy from the source when the source
 * advanced while this task was queued (behind the prime gate on cold start, or behind the
 * per-workspace lease). Without this, a waiter spawns against a copy whose single-use
 * refresh_token another task already spent, and dies with "refresh token was already used"
 * even though the shared file is fresh.
 *
 * Guards (direction matters — a wrong re-seed DESTROYS the only live chain):
 * - never overwrites a copy that rotated past `snapshot` (its chain may be live);
 * - only re-seeds from a source that passes looksLikeCodexAuth;
 * - only re-seeds when the source's `last_refresh` is provably NEWER than the copy's.
 *   "Source differs" alone is not enough: after a FAILED write-back the source holds the
 *   older, already-spent chain while the copy holds the only live one — re-seeding then
 *   would erase the live token everywhere. When in doubt, keep the copy: a stale copy
 *   fails one task recoverably; a destroyed live chain bricks codex until a host re-login.
 * - also seeds a copy that is missing entirely when a valid source exists.
 * @param perTaskAuthPath Absolute path to the per-task auth.json.
 * @param sourceAuthPath  Absolute path to the shared source auth.json (null → no-op).
 * @param snapshot        The pre-spawn snapshot for this task (null = no copy existed).
 * @param logger          Optional logger for diagnostics.
 * @returns The snapshot to use for the post-run CAS: the source content when re-seeded,
 *          otherwise the original `snapshot` unchanged.
 */
export function reseedFromAdvancedSource(
  perTaskAuthPath: string,
  sourceAuthPath: string | null,
  snapshot: string | null,
  logger?: CodexAuthWriteBackLogger,
): string | null {
  if (!sourceAuthPath) return snapshot;

  let sourceNow: string;
  try {
    sourceNow = fs.readFileSync(sourceAuthPath, 'utf8');
  } catch {
    return snapshot; // no source file — nothing to re-seed from
  }
  if (sourceNow === snapshot) return snapshot; // source has not advanced
  if (!looksLikeCodexAuth(sourceNow)) return snapshot; // never seed garbage into the copy

  let currentCopy: string | null;
  try {
    currentCopy = fs.readFileSync(perTaskAuthPath, 'utf8');
  } catch {
    currentCopy = null;
  }
  // Never clobber a copy that already rotated past the snapshot — its chain may be live.
  if (currentCopy !== snapshot) return snapshot;

  // Freshness check (skipped when there is no copy at all): the source must be provably
  // newer. Equal/older/unstamped source → keep the copy; see the doc comment for why the
  // failure asymmetry forces this direction.
  if (currentCopy !== null) {
    const sourceTs = authLastRefreshMs(sourceNow);
    if (sourceTs === null) return snapshot;
    const copyTs = authLastRefreshMs(currentCopy);
    if (copyTs !== null && sourceTs <= copyTs) return snapshot;
  }

  try {
    fs.writeFileSync(perTaskAuthPath, sourceNow, { encoding: 'utf8', mode: 0o600 });
    logger?.info(
      { perTaskAuthPath, sourceAuthPath },
      'Codex auth source advanced while this task queued — per-task copy re-seeded with the fresh token chain',
    );
    return sourceNow;
  } catch (error) {
    logger?.error(
      { err: error, perTaskAuthPath },
      'Codex auth re-seed failed — spawning against the possibly-stale per-task copy',
    );
    return snapshot;
  }
}

/**
 * @description Compare-and-swap the rotated codex auth.json back to the shared source.
 * Why: a ChatGPT-login auth.json carries a SINGLE-USE refresh_token; when the CLI refreshes,
 * the rotated token lands in the per-task copy it was given. If it is not propagated back,
 * the source keeps an already-spent refresh token and every later task dies with
 * "refresh token was already used" once its access token expires.
 *
 * Safety rules (all verified by tests/unit/codex-auth-write-back.spec.ts):
 * 1. Only writes when the per-task content CHANGED during this run (differs from `snapshot`).
 * 2. Only writes content that passes looksLikeCodexAuth — torn/garbage bytes never reach the
 *    shared file.
 * 3. Only writes when the source STILL equals `snapshot` — the CAS guard. A single-use
 *    refresh token has exactly one valid successor chain, so "source == snapshot" proves
 *    this run's rotation is that successor; anything else means a host re-login or another
 *    writer already advanced the chain, and overwriting would destroy the newer credential.
 *    Exception: a source that does not EXIST (ENOENT — seeding came from secrets.json) is
 *    created exclusively ('wx'), so the rotation survives for every later task in this
 *    container instead of warn-looping as "moved".
 * 4. Atomic write: temp file in the source's directory + rename (same filesystem). The CAS
 *    is atomic in-process (fully synchronous); across containers sharing the mount there is
 *    a microsecond TOCTOU window — accepted, since the worst case equals the pre-fix status
 *    quo (a lost rotation) and a cross-process lock file adds crash-recovery failure modes.
 * 5. Never throws — a write-back failure (e.g. `:ro` mount) must not fail the task that
 *    just completed; it logs and returns 'failed'.
 *
 * @param perTaskAuthPath Absolute path to the per-task auth.json the CLI ran against.
 * @param sourceAuthPath  Absolute path to the shared source auth.json (null → 'skipped').
 * @param snapshot        Pre-run content from snapshotCodexAuth (null → 'skipped').
 * @param logger          Optional logger for info/warn/error diagnostics.
 * @returns The outcome, so callers/tests can assert on the exact branch taken.
 */
export function writeBackRotatedCodexAuth(
  perTaskAuthPath: string,
  sourceAuthPath: string | null,
  snapshot: string | null,
  logger?: CodexAuthWriteBackLogger,
): CodexAuthWriteBackOutcome {
  if (!snapshot || !sourceAuthPath) {
    return 'skipped';
  }

  let current: string;
  try {
    current = fs.readFileSync(perTaskAuthPath, 'utf8');
  } catch {
    // Expected when a run never produced a per-task credential; nothing to propagate.
    return 'skipped';
  }

  if (current === snapshot) {
    return 'unchanged';
  }

  if (!looksLikeCodexAuth(current)) {
    logger?.warn(
      { perTaskAuthPath },
      'Codex auth changed during the run but is not a valid auth shape (torn write or injected content) — NOT propagated to the shared source',
    );
    return 'invalid';
  }

  let sourceNow: string | null = null;
  let sourceMissing = false;
  try {
    sourceNow = fs.readFileSync(sourceAuthPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      sourceMissing = true;
    } else {
      // EACCES/EIO etc. — NOT "the source moved"; report honestly so an operator
      // diagnosing a stranded rotation isn't sent down the wrong path.
      logger?.error(
        { err: error, sourceAuthPath },
        'Codex auth write-back could not READ the source file — rotation not propagated',
      );
      return 'failed';
    }
  }

  if (sourceMissing) {
    // Seeding came from secrets.json (no source file). Create it exclusively so later tasks
    // in this container seed the ROTATED chain from the file (ensureRuntimeHome prefers the
    // file over the secrets blob). Atomic-and-exclusive: write a tmp then hard-link it into
    // place (link fails EEXIST if a concurrent creator won; a crash can only leave a tmp,
    // never a torn source that would block future creates).
    const createTmp = path.join(
      path.dirname(sourceAuthPath),
      `.auth.json.create-${process.pid}-${Date.now()}.tmp`,
    );
    try {
      fs.mkdirSync(path.dirname(sourceAuthPath), { recursive: true });
      fs.writeFileSync(createTmp, current, { encoding: 'utf8', mode: 0o600 });
      fs.linkSync(createTmp, sourceAuthPath);
      logger?.info(
        { sourceAuthPath },
        'Codex auth rotated and no source file existed (secrets.json seed) — rotated token persisted as the new shared source',
      );
      return 'written';
    } catch (error) {
      logger?.error(
        { err: error, sourceAuthPath },
        'Codex auth write-back could not create the missing source file — the rotated single-use refresh token lives only in the per-task copy',
      );
      return 'failed';
    } finally {
      try { fs.unlinkSync(createTmp); } catch { /* tmp may not exist */ }
    }
  }

  if (sourceNow !== snapshot) {
    // The source advanced underneath us (host re-login or another task's write-back).
    // Its token chain is newer than the one this run rotated from — never clobber it.
    logger?.warn(
      { perTaskAuthPath, sourceAuthPath },
      'Codex auth rotated during the run, but the source file changed since seeding — write-back skipped to protect the newer credential',
    );
    return 'source-moved';
  }

  const tmpPath = path.join(
    path.dirname(sourceAuthPath),
    `.auth.json.writeback-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, current, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, sourceAuthPath);
    logger?.info(
      { sourceAuthPath },
      'Codex auth rotated during the run — rotated token written back to the shared source (single-use refresh_token preserved)',
    );
    return 'written';
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* tmp may not exist */ }
    logger?.error(
      { err: error, sourceAuthPath },
      'Codex auth write-back FAILED — the rotated single-use refresh token lives only in the per-task copy; if the source mount is read-only, codex auth will need a host re-login after the next refresh',
    );
    return 'failed';
  }
}
