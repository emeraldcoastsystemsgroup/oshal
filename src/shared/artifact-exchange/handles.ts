/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Amendment D (mint-with-bytes): a SECOND mint for sources that have no byte-serving URL at all — a client-generated export, or a route that answers a JSON preview envelope rather than the file. Such a source could never be tagged, no matter how the tag improved. The bytes are held transiently IN MEMORY on the record (never on disk: a handle is a gesture in flight, and disk would add a cleanup obligation and cross-restart residue that D2's "no bytes at rest" property deliberately avoided), under the same owner binding and the same TTL. Two caps bound it — per-handle size and a per-sub BYTE budget, because the existing per-sub COUNT cap times a large blob is an api-memory exhaustion path. Redeem is unchanged for callers: a record either carries a locator to re-fetch or the bytes themselves.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 D2: the artifact handle store — short-TTL, owner-bound claim tickets over existing owner-scoped serve URLs. Bytes never live here (a handle holds a LOCATOR; the route re-fetches server-side as the minting caller). Treated like the token broker: mint validates the source path fail-closed, resolve refuses foreign subs and expired refs indistinguishably (no existence oracle), a per-sub cap bounds abuse, and the clock is injectable so the vitest guards prove expiry for real.
 */

import * as crypto from 'node:crypto';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'artifact-exchange:handles' });

/** @description One minted handle: the locator plus the identity that may redeem it. */
export interface ArtifactHandleRecord {
  ref: string;
  ownerSub: string;
  /**
   * Root-relative same-origin path of an owner-scoped serve route (`/api/...`), or null on a
   * mint-with-bytes handle whose payload is carried on `bytes` instead.
   */
  sourcePath: string | null;
  /** The artifact itself, on a mint-with-bytes handle — transient, in memory, dropped at expiry. */
  bytes: Buffer | null;
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
/** Largest single mint-with-bytes payload. Deliberately well under the 50MB relay ceiling: these
 *  bytes sit in api memory for the whole TTL, where a relayed body is streamed and released. */
const MAX_INLINE_BYTES = Math.max(64_000, parseInt(process.env.ARTIFACT_INLINE_MAX_BYTES || '10485760', 10) || 10_485_760);
/** Total live inline bytes one sub may hold. The COUNT cap alone does not bound memory — 200 handles
 *  times a 10MB payload is 2GB of api heap, so the byte budget is the one that actually holds. */
const MAX_INLINE_BYTES_PER_SUB = Math.max(MAX_INLINE_BYTES, parseInt(process.env.ARTIFACT_INLINE_MAX_BYTES_PER_SUB || '52428800', 10) || 52_428_800);

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

/** Live handle count and inline byte total for one sub — the cap arithmetic in one place. */
function usage(ownerSub: string): { held: number; inlineBytes: number } {
  let held = 0;
  let inlineBytes = 0;
  for (const rec of BY_REF.values()) {
    if (rec.ownerSub !== ownerSub) continue;
    held++;
    if (rec.bytes) inlineBytes += rec.bytes.length;
  }
  return { held, inlineBytes };
}

/** Normalize the declared MIME type — bare type/subtype, lowercased, parameters dropped. */
function normalizeType(raw: unknown): string {
  return String(raw || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100);
}

/** Normalize a display name — no separators or quoting characters reach a Content-Disposition. */
function normalizeName(raw: unknown): string {
  return String(raw || 'artifact').replace(/[\r\n"\\/]/g, '_').slice(0, 120);
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
  if (usage(input.ownerSub).held >= MAX_PER_SUB) {
    throw new Error(`too many outstanding artifact handles (${MAX_PER_SUB}) — wait for some to expire`);
  }
  const record: ArtifactHandleRecord = {
    ref: `art_${crypto.randomBytes(24).toString('base64url')}`,
    ownerSub: input.ownerSub,
    sourcePath: input.sourcePath,
    bytes: null,
    type: normalizeType(input.type),
    name: normalizeName(input.name),
    createdAt: nowMs,
    expiresAt: nowMs + TTL_MS,
  };
  BY_REF.set(record.ref, record);
  logger.info({ ref: record.ref, sub: record.ownerSub, type: record.type, path: record.sourcePath }, 'artifact handle minted');
  return record;
}

/**
 * @description Mint a handle that CARRIES the artifact (ADR-139 Amendment D) — for a source with no
 * byte-serving URL to point at: a client-generated export, or a route that answers a preview envelope
 * rather than the file. Ownership, TTL and redeem are identical to the locator mint; the difference is
 * only where the bytes come from at redeem. Adds no authority: these are the caller's OWN bytes, bound
 * to the caller's own sub, redeemable by nobody else — the same thing they could already POST directly
 * to any destination. What it does add is memory pressure, so both caps here are fail-closed.
 * @param input - ownerSub + the artifact bytes + type + display name.
 * @param nowMs - Injectable clock for tests (defaults to Date.now()).
 * @returns The minted record.
 * @throws Error when the payload is empty/oversized, or the caller is over either cap.
 */
export function mintInlineArtifactHandle(
  input: { ownerSub: string; bytes: Buffer; type: string; name?: string },
  nowMs: number = Date.now(),
): ArtifactHandleRecord {
  sweep(nowMs);
  if (!input.ownerSub) throw new Error('an authenticated caller is required to mint a handle');
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) throw new Error('an artifact body is required');
  if (input.bytes.length > MAX_INLINE_BYTES) {
    throw new Error(`artifact is too large to carry (${MAX_INLINE_BYTES} bytes max)`);
  }
  const { held, inlineBytes } = usage(input.ownerSub);
  if (held >= MAX_PER_SUB) throw new Error(`too many outstanding artifact handles (${MAX_PER_SUB}) — wait for some to expire`);
  if (inlineBytes + input.bytes.length > MAX_INLINE_BYTES_PER_SUB) {
    throw new Error('too many artifact bytes in flight — wait for some handles to expire');
  }
  const record: ArtifactHandleRecord = {
    ref: `art_${crypto.randomBytes(24).toString('base64url')}`,
    ownerSub: input.ownerSub,
    sourcePath: null,
    bytes: input.bytes,
    type: normalizeType(input.type),
    name: normalizeName(input.name),
    createdAt: nowMs,
    expiresAt: nowMs + TTL_MS,
  };
  BY_REF.set(record.ref, record);
  logger.info({ ref: record.ref, sub: record.ownerSub, type: record.type, bytes: record.bytes?.length }, 'artifact handle minted with bytes');
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

/**
 * @description Live inline bytes held for one sub, or across every sub when none is named —
 * observability and the byte-budget guard. Expired records are swept first so the number is real.
 * @param ownerSub - Restrict to one sub, or omit for the process total.
 * @param nowMs - Injectable clock for tests.
 * @returns Total bytes currently held in memory by mint-with-bytes handles.
 */
export function artifactHandleInlineBytes(ownerSub?: string, nowMs: number = Date.now()): number {
  sweep(nowMs);
  let total = 0;
  for (const rec of BY_REF.values()) {
    if (ownerSub && rec.ownerSub !== ownerSub) continue;
    if (rec.bytes) total += rec.bytes.length;
  }
  return total;
}
