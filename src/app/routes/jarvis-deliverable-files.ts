/**
 * Jarvis deliverable capture — a produced file becomes a real, owner-scoped download.
 *
 * A background Jarvis task writes its output into the BOT'S agent workspace
 * (`<workspace>/<taskId>/…`) and then tells the user the file is "available in the workspace app
 * directory". Nothing could serve it: `/api/files/download` serves storage PROVIDERS, and the only
 * link form the surface could emit was `/code?file=…`, which opens code-server — an operator tool
 * absent from a lean customer deployment. So the answer promised a download that did not exist.
 *
 * This module copies the deliverable into the CALLER'S OWN private folder and hands back the
 * existing owner-scoped download contract. Ownership then stops being a check that has to be
 * written correctly and becomes structural: the bytes live under `userfiles/<sha256(ownerSub)>`,
 * and `/api/files/download` resolves its root from the CALLER's own sub — so a different user
 * asking for the same relative path looks inside their own store and finds nothing.
 *
 * THE PATHS HERE ARE UNTRUSTED. They are lifted out of worker output, which is model-influenced,
 * so every one is resolved with realpath and checked against two boundaries before a single byte is
 * read. The second boundary is the one that is easy to miss and fatal to omit: every user's private
 * store lives INSIDE the workspace root, so "is it under the workspace root" alone would authorise
 * reading another tenant's private files.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial. Capture worker deliverables into the owner's private folder and rewrite the answer text to a real download link. Refuses the userfiles/ subtree explicitly (that is where every user's private store lives, inside the same root), refuses symlinks that escape, caps count and size, and leaves the text untouched when nothing was captured so the answer never claims a download it cannot provide.
 * @module jarvis-deliverable-files
 */

import fs from 'node:fs';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition-root';
import { saveContent } from './storage-target';

const logger = createChildLogger({ module: 'jarvis-deliverable-files' });

/** The shared agent workspace. Worker output may reference files under here — and nowhere else. */
const WORKSPACE_ROOT = process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared';

/**
 * Every user's PRIVATE store lives at `<workspace>/userfiles/<sha256(sub)>` (storage-target.ts).
 * It is inside the workspace root, so a containment check against the root alone would happily
 * authorise reading another tenant's private files. This subtree is refused outright.
 */
const USERFILES_ROOT = path.join(WORKSPACE_ROOT, 'userfiles');

/** Bounds. A deliverable is a report, not a disk image, and one answer is not a backup job. */
const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;

/** A captured file, as persisted on the task and rendered to the user. */
export interface CapturedFile {
  /** Display name shown on the download control. */
  name: string;
  /** Owner-scoped URL — `/api/files/download?provider=oshal-local&path=…`. */
  downloadUrl: string;
  /** Byte size at capture time, for the UI to show. */
  bytes: number;
}

/**
 * @description Is `candidate` inside `root`? Compared on RESOLVED paths, and rejecting the
 * equal-to-root case, so neither `..` traversal nor a prefix collision (`/app/workspace-shared-evil`
 * matching `/app/workspace-shared`) can slip through. The separator check is what makes the prefix
 * case safe — `startsWith(root)` alone would accept the sibling directory.
 * @param root - Absolute directory.
 * @param candidate - Absolute path.
 * @returns True when candidate is strictly inside root.
 */
function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @description Extract workspace file paths referenced by worker output.
 *
 * Both shapes are matched deliberately. Markdown links are the tidy case; BARE paths in prose
 * ("saved to /app/workspace-shared/<id>/deliverables/report.md") are what workers actually emit
 * most of the time, and handling only the former is why an earlier attempt at this left the raw
 * path visible in the answer.
 *
 * @param text - Worker deliverable text.
 * @returns Unique absolute candidate paths, in first-seen order, bounded to MAX_FILES.
 */
export function extractWorkspacePaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Built from the CONFIGURED root, not a hardcoded '/app/workspace-shared'. The root is
  // overridable via CLINE_WORKSPACE_ROOT, and a literal here would silently extract nothing on
  // any deployment that sets it — the capture would appear to work and produce no links.
  // A path segment charset deliberately narrower than the filesystem's: no spaces, no quotes, no
  // parens — so a trailing `)` from a markdown link or a `.` ending a sentence is not swallowed.
  const rootPattern = WORKSPACE_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${rootPattern}/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*`, 'g');
  for (const m of String(text || '').matchAll(re)) {
    const raw = m[0].replace(/[.,;:]+$/, '');
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/**
 * @description Read one referenced file, if and only if it is safely readable.
 *
 * Returns null — never throws — for every refusal, so one bad reference in a long answer cannot
 * fail the whole capture and lose the others.
 *
 * @param candidate - Absolute path lifted from worker output.
 * @returns The bytes and base name, or null when refused.
 */
function readIfSafe(candidate: string): { name: string; buf: Buffer } | null {
  try {
    // realpath FIRST: it resolves `..` and follows symlinks, so the containment checks below are
    // made against where the path actually lands, not where it claims to.
    const real = fs.realpathSync(candidate);
    if (!isInside(WORKSPACE_ROOT, real)) return null;
    // The private-store subtree is another tenant's data. Refused even though it is under the root.
    if (isInside(USERFILES_ROOT, real) || real === USERFILES_ROOT) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return null;
    return { name: path.basename(real), buf: fs.readFileSync(real) };
  } catch {
    return null; // missing, unreadable, dangling symlink — all the same answer to the caller
  }
}

/**
 * @description Copy a finished task's deliverable files into the owner's private folder and
 * rewrite the answer text to point at real download links.
 *
 * @param ctx - App context (pool + config), for the storage write.
 * @param ownerSub - The task's RECORDED owner (`jarvis_tasks.user_sub`) — never a client-supplied
 *   id. This is the authorisation anchor: the bytes land in this user's store and nobody else's.
 * @param taskId - Task id, used only as a subfolder label so a user's captures stay separable.
 * @param text - The worker deliverable text.
 * @returns The captured files and the rewritten text. When nothing is captured the text is
 *   returned UNCHANGED apart from the workspace-path notice, so the answer never claims a
 *   download that does not exist.
 */
export async function captureDeliverableFiles(
  ctx: AppContext,
  ownerSub: string,
  taskId: string,
  text: string,
): Promise<{ files: CapturedFile[]; text: string }> {
  if (!ownerSub) return { files: [], text };
  const candidates = extractWorkspacePaths(text);
  if (!candidates.length) return { files: [], text };

  const files: CapturedFile[] = [];
  let rewritten = String(text || '');

  for (const candidate of candidates) {
    const read = readIfSafe(candidate);
    if (!read) continue;
    try {
      // The explicit oshal-local override is deliberate: resolveStorageTarget() prefers Dropbox,
      // then Google Drive, and Drive returns a `url` with NO downloadUrl — so honouring the user's
      // cloud target here would silently produce the very "says downloadable, isn't" behaviour this
      // module exists to end. Every user has a private folder on the system; that is where it goes.
      const saved = await saveContent(
        ctx, ownerSub, 'files', read.name, read.buf,
        { provider: 'oshal-local' },
        `jarvis/${taskId}`,
      );
      if (!saved.downloadUrl) continue;
      files.push({ name: read.name, downloadUrl: saved.downloadUrl, bytes: read.buf.length });
      // Replace BOTH shapes: the markdown link's target and any bare mention left in prose.
      rewritten = rewritten.split(candidate).join(saved.downloadUrl);
    } catch (err) {
      // Quota exhaustion is the expected failure and must not fail the answer — the user still
      // gets their result, just without an attached copy.
      logger.warn({ err, taskId }, 'jarvis: deliverable capture failed for one file');
    }
  }

  if (!files.length) {
    logger.info({ taskId, candidates: candidates.length }, 'jarvis: no deliverable captured');
  }
  return { files, text: rewritten };
}
