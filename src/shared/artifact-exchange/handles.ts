/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 D2: the artifact handle store — short-TTL, owner-bound claim tickets over existing owner-scoped serve URLs. Bytes never live here (a handle holds a LOCATOR; the route re-fetches server-side as the minting caller). Treated like the token broker: mint validates the source path fail-closed, resolve refuses foreign subs and expired refs indistinguishably (no existence oracle), a per-sub cap bounds abuse, and the clock is injectable so the vitest guards prove expiry for real.
 */

import * as crypto from 'node:crypto';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'artifact-exchange:handles' });

/** @description One minted handle: the locator plus the identity that may redeem it. */
export interface ArtifactHandleRecord {
  ref: string;
  ownerSub: string;
  /** Root-relative same-origin path of an owner-scoped serve route (`/api/...`). */
  sourcePath: string;
  /** The artifact's MIME type as declared at mint. */
  type: string;
  /** Display name for the artifact (sanitized at mint). */
  name: string;
  createdAt: number;
  expiresAt: number;
}

/** Handle lifetime — deliberately short: a handle is a gesture in flight, not storage. */
const TTL_MS = Math.max(60_000, parseInt(process.env.ARTIFACT_HANDLE_TTL_MS || '900000', 10) || 900_000);
/** Outstanding handles one sub may hold — bounds a mint loop without a database. */
const MAX_PER_SUB = Math.max(10, parseInt(process.env.ARTIFACT_HANDLE_MAX_PER_SUB || '200', 10) || 200);

const BY_REF = new Map<string, ArtifactHandleRecord>();

/**
 * @description Why a candidate source path cannot back a handle, or null when it is acceptable:
 * root-relative `/api/...`, no scheme/host, no backslashes, no `..`, no fragment, bounded length.
 * The same shape rule the declaration validator applies to post endpoints — a handle must never
 * become a server-side request forger.
 * @param p - The candidate source path.
 * @returns A defect description, or null when the path is safe.
 */
export function artifactSourcePathError(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'source must be a non-empty string';
  if (p.length > 500) return 'source is too long (≤500 chars)';
  if (!p.startsWith('/api/')) return 'source must be a root-relative /api/... path';
  if (p.includes('://') || p.includes('\\') || p.includes('..') || p.includes('#')) return 'source must not carry a scheme, backslash, .., or fragment';
  if (/\s/.test(p)) return 'source must not contain whitespace';
  return null;
}

/** Drop expired records — called lazily from mint/resolve, never on a timer. */
function sweep(nowMs: number): void {
  for (const [ref, rec] of BY_REF) {
    if (rec.expiresAt <= nowMs) BY_REF.delete(ref);
  }
}

/**
 * @description Mint a handle for the calling sub over a source path the caller can already read
 * (ownership is proven again at resolve, where the fetch runs AS this sub). Fail-closed on a bad
 * source path and on the per-sub cap.
 * @param input - ownerSub + sourcePath + type + display name.
 * @param nowMs - Injectable clock for tests (defaults to Date.now()).
 * @returns The minted record.
 * @throws Error when the source path is unsafe or the caller holds too many live handles.
 */
export function mintArtifactHandle(
  input: { ownerSub: string; sourcePath: string; type: string; name?: string },
  nowMs: number = Date.now(),
): ArtifactHandleRecord {
  sweep(nowMs);
  const pathErr = artifactSourcePathError(input.sourcePath);
  if (pathErr) throw new Error(pathErr);
  if (!input.ownerSub) throw new Error('an authenticated caller is required to mint a handle');
  let held = 0;
  for (const rec of BY_REF.values()) {
    if (rec.ownerSub === input.ownerSub) held++;
  }
  if (held >= MAX_PER_SUB) throw new Error(`too many outstanding artifact handles (${MAX_PER_SUB}) — wait for some to expire`);
  const record: ArtifactHandleRecord = {
    ref: `art_${crypto.randomBytes(24).toString('base64url')}`,
    ownerSub: input.ownerSub,
    sourcePath: input.sourcePath,
    type: String(input.type || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100),
    name: String(input.name || 'artifact').replace(/[\r\n"\\/]/g, '_').slice(0, 120),
    createdAt: nowMs,
    expiresAt: nowMs + TTL_MS,
  };
  BY_REF.set(record.ref, record);
  logger.info({ ref: record.ref, sub: record.ownerSub, type: record.type, path: record.sourcePath }, 'artifact handle minted');
  return record;
}

/**
 * @description Redeem a handle: the record when `callerSub` minted it and it has not expired —
 * otherwise null, indistinguishably (a foreign or expired ref must not reveal that it ever
 * existed). This is the isolation boundary; guard it like graph-keys/token-broker.
 * @param ref - The handle ref. @param callerSub - The redeeming caller's sub.
 * @param nowMs - Injectable clock for tests.
 * @returns The record, or null.
 */
export function resolveArtifactHandle(ref: string, callerSub: string, nowMs: number = Date.now()): ArtifactHandleRecord | null {
  sweep(nowMs);
  if (!ref || !callerSub) return null;
  const rec = BY_REF.get(ref);
  if (!rec || rec.ownerSub !== callerSub || rec.expiresAt <= nowMs) return null;
  return rec;
}

/** @description Outstanding (unswept) handle count — observability and tests only. */
export function artifactHandleCount(): number {
  return BY_REF.size;
}
