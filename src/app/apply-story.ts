/**
 * Apply Story — the narrated, screenshot-backed record of ONE desktop job submission.
 *
 * The desktop worker drives a real Chrome the operator cannot see (the box is headed but the
 * operator is looking at the cockpit, not at that monitor). Before this module the only thing that
 * ever came back was a single terminal verdict at /api/apply/ingest — `applied` or a one-line
 * blocker — so a submission that took eight minutes was an eight-minute blank. The worker DID take
 * screenshots the whole time (it is a screenshot-driven agent) but they died on the box's disk with
 * only a local path echoed into `note`.
 *
 * This gives those frames somewhere to land: the worker POSTs a beat — a caption, and optionally the
 * PNG it just looked at — to /api/apply/shot as it works, and the cockpit reads them back in order as
 * a story. Beats are append-only and captionless-safe: a beat with no image is still a progress line,
 * so the narration survives a screenshot that failed to encode.
 *
 * Storage is the shared workspace volume (the same one the packet is staged into), one folder per
 * ticket, because these are bulky binary artifacts of a transient run — not rows. `story.json` is the
 * ordered index; the PNGs sit beside it. Reads are owner-scoped by the ROUTE (it checks the ticket's
 * owner_sub) — nothing here trusts a caller.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial apply story store:
 *   append-only per-ticket beats (caption + optional PNG) written by the desktop worker via
 *   /api/apply/shot, read back by the cockpit apply-queue surface as a live narration. Replaces the
 *   "one terminal verdict, no visibility" submission experience. Frames are identified by MAGIC BYTES
 *   before being written — Buffer.from(x,'base64') does not throw on garbage, so a mangled upload
 *   would otherwise land as an unrenderable `.png`.
 *
 * @module app/apply-story
 */

import { promises as fsp } from 'fs';
import { resolve as pathResolve, basename } from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'apply-story' });

/** Root of the shared workspace volume — the same mount the apply packet is staged into. */
const WORKSPACE_ROOT = (
  process.env.SHARED_WORKSPACE_ROOT ||
  process.env.WORKSPACE_DIR ||
  process.env.WORKSPACE_ROOT ||
  '/app/workspace-shared'
).trim();

/** Per-run cap. A wedged worker screenshotting in a loop must not fill the workspace volume. */
const MAX_BEATS_PER_TICKET = 60;
/** Largest single frame we accept (decoded bytes). A full-page 4K PNG lands well under this. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** One moment in a submission: what the worker was doing, and optionally what it was looking at. */
export interface ApplyStoryBeat {
  /** 1-based position in the run — what makes the story ordered rather than a bag of files. */
  seq: number;
  /** Short human label, e.g. "opened the posting" / "uploaded resume" / "confirmation page". */
  label: string;
  /** Optional longer detail (a blocker, a field it had to reason about). */
  note?: string;
  /** Relative PNG filename in this ticket's folder, absent when the beat is text-only. */
  file?: string;
  /** ISO timestamp the controller received the beat. */
  at: string;
}

/** A ticket id must be a single safe path segment — it becomes a directory name. */
function safeTicketId(value: string): string | null {
  const v = String(value || '').trim();
  return /^[A-Za-z0-9._-]{1,128}$/.test(v) && v !== '.' && v !== '..' ? v : null;
}

/** Absolute folder holding one ticket's beats, or null when the id is unsafe. */
function storyDir(ticketId: string): string | null {
  const id = safeTicketId(ticketId);
  return id ? pathResolve(WORKSPACE_ROOT, 'apply-shots', id) : null;
}

/** Filesystem-safe slug for a caption, used in the frame filename so the folder reads sensibly. */
function slug(label: string): string {
  return String(label || 'step').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'step';
}

/**
 * Identify the frame by its MAGIC BYTES, not by trusting the sender. `Buffer.from(x,'base64')` does
 * NOT throw on garbage — it silently skips invalid characters and hands back whatever it managed to
 * decode. Without this check a mangled upload was written out as a `.png` that no browser could
 * render, turning a readable caption-only beat into a broken image in the story.
 */
function imageExt(bytes: Buffer): 'png' | 'jpg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

/**
 * @description Read a ticket's ordered beats. Missing/unreadable/corrupt index reads as an empty
 * story — a submission with no narration yet is the normal early state, never an error.
 * @param ticketId - The apply ticket whose story to read.
 * @returns The beats in sequence order (empty when nothing has been recorded).
 */
export async function readApplyStory(ticketId: string): Promise<ApplyStoryBeat[]> {
  const dir = storyDir(ticketId);
  if (!dir) return [];
  try {
    const raw = await fsp.readFile(pathResolve(dir, 'story.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as ApplyStoryBeat[]).filter((b) => b && typeof b.seq === 'number').sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

/**
 * @description Append one beat to a ticket's story, optionally persisting the frame the worker was
 * looking at. Never throws: a submission must not fail because its narration could not be written.
 * @param input - ticketId, the caption, an optional note, and an optional base64 PNG.
 * @returns The stored beat, or null when it was rejected (bad ticket id, cap reached, oversized image).
 */
export async function recordApplyBeat(input: {
  ticketId: string;
  label: string;
  note?: string;
  imageBase64?: string;
}): Promise<ApplyStoryBeat | null> {
  const dir = storyDir(input.ticketId);
  if (!dir) { logger.warn({ ticketId: input.ticketId }, 'apply story: unsafe ticket id, beat dropped'); return null; }

  const existing = await readApplyStory(input.ticketId);
  if (existing.length >= MAX_BEATS_PER_TICKET) {
    logger.warn({ ticketId: input.ticketId, beats: existing.length }, 'apply story: per-ticket beat cap reached, beat dropped');
    return null;
  }
  const seq = existing.length + 1;
  const label = String(input.label || '').trim().slice(0, 160) || `step ${seq}`;

  const beat: ApplyStoryBeat = { seq, label, at: new Date().toISOString() };
  const note = String(input.note || '').trim();
  if (note) beat.note = note.slice(0, 2000);

  try {
    await fsp.mkdir(dir, { recursive: true });

    // The frame is optional and independently failable — a beat with an unusable image is still a
    // usable progress line, so an image problem must never lose the caption.
    if (input.imageBase64) {
      const bytes = Buffer.from(String(input.imageBase64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const ext = imageExt(bytes);
      if (bytes.length > MAX_IMAGE_BYTES) {
        logger.warn({ ticketId: input.ticketId, seq, bytes: bytes.length }, 'apply story: image over cap, keeping caption only');
      } else if (!ext) {
        logger.warn({ ticketId: input.ticketId, seq, bytes: bytes.length }, 'apply story: payload is not a PNG/JPEG, keeping caption only');
      } else {
        const file = `${String(seq).padStart(3, '0')}-${slug(label)}.${ext}`;
        await fsp.writeFile(pathResolve(dir, file), bytes);
        beat.file = file;
      }
    }

    await fsp.writeFile(pathResolve(dir, 'story.json'), JSON.stringify([...existing, beat], null, 2), 'utf8');
    logger.info({ ticketId: input.ticketId, seq, hasImage: Boolean(beat.file) }, 'apply story: beat recorded');
    return beat;
  } catch (err) {
    logger.error({ err, ticketId: input.ticketId, seq }, 'apply story: failed to record beat');
    return null;
  }
}

/**
 * @description Resolve one stored frame to an absolute path for streaming. Path-scoped: the caller's
 * filename is reduced to a basename and must be one this ticket's own index actually lists, so a
 * crafted name can neither traverse out of the folder nor read another ticket's frames.
 * @param ticketId - The apply ticket that owns the frame.
 * @param file - The frame filename from the story index.
 * @returns Absolute path, or null when the ticket id is unsafe or the frame is not in the index.
 */
export async function resolveApplyShotPath(ticketId: string, file: string): Promise<string | null> {
  const dir = storyDir(ticketId);
  if (!dir) return null;
  const name = basename(String(file || ''));
  const beats = await readApplyStory(ticketId);
  if (!beats.some((b) => b.file === name)) return null;
  return pathResolve(dir, name);
}
