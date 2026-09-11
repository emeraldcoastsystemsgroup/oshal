/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Relay fixed local artifact sources with exact caller credentials and current app authority.
 */
import type { Request } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import { artifactSourcePathError, type ArtifactHandleRecord } from '@/shared/artifact-exchange';

interface HandlePrincipal { sub: string; issuer: string; source?: { app: string; generation: string } }
const PRINCIPALS = new WeakMap<ArtifactHandleRecord, HandlePrincipal>();
const refused = () => Object.assign(new Error('artifact_authorization_unavailable'), { status: 403 });

function localPath(source: string): string {
  if (artifactSourcePathError(source)) throw refused();
  const pathname = source.split('?')[0];
  if (/%(?:2e|2f|5c)/i.test(pathname)) throw refused();
  return pathname;
}
async function current(ctx: AppContext, req: Request, rec: ArtifactHandleRecord): Promise<HandlePrincipal | null> {
  const runtime = ctx.applicationAuthorization;
  if (!runtime) return null;
  const actor = await runtime.resolveActor(req);
  if (!actor.isActive || !actor.issuer || actor.sub !== rec.ownerSub) throw refused();
  const decision = rec.sourcePath ? await runtime.authorizeHttpPath(actor, { method: 'GET', path: localPath(rec.sourcePath) }) : null;
  if (decision && !decision.allowed) throw refused();
  const snapshot = decision ? runtime.snapshot(decision.app) : null;
  if (decision && !snapshot) throw refused();
  return { sub: actor.sub, issuer: actor.issuer, ...(snapshot ? { source: { app: snapshot.app, generation: snapshot.generation } } : {}) };
}

/** @description Bind a newly minted in-process handle to its verified principal and protected source generation.
 * @param ctx Core context. @param req Authenticated request. @param rec Newly minted server record.
 * @returns Nothing; missing authority refuses a protected handle before its reference is released.
 */
export async function bindArtifactPrincipal(ctx: AppContext, req: Request, rec: ArtifactHandleRecord): Promise<void> {
  const principal = await current(ctx, req, rec);
  if (principal) PRINCIPALS.set(rec, principal);
}

/** @description Revalidate exact handle ownership, source permission and activation before returning any artifact data.
 * @param ctx Core context. @param req Authenticated request. @param rec Resolved server record.
 * @returns Nothing when current authority matches; rejects missing, changed or revoked authority.
 */
export async function assertArtifactPrincipal(ctx: AppContext, req: Request, rec: ArtifactHandleRecord): Promise<void> {
  const expected = PRINCIPALS.get(rec), actual = await current(ctx, req, rec);
  if (expected && (!actual || expected.sub !== actual.sub || expected.issuer !== actual.issuer
    || expected.source?.app !== actual.source?.app || expected.source?.generation !== actual.source?.generation)) throw refused();
  if (actual?.source && !expected) throw refused();
}

function callerHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  if (/^Bearer\s+oshal_pat_[a-f0-9]{48}$/.test(req.headers.authorization ?? '')) headers.authorization = req.headers.authorization!;
  if (!headers.cookie && !headers.authorization) throw refused(); // Preserve both original rails and their normal authentication precedence.
  if (req.headers.host) headers.host = req.headers.host;
  return headers;
}
async function boundedBody(response: globalThis.Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('artifact_too_large');
  const chunks: Buffer[] = []; let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error('artifact_too_large');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** @description Fetch a validated local source as the existing authenticated caller without redirect or service impersonation.
 * @param ctx Core context. @param req Authenticated request. @param rec Exact owner-bound handle.
 * @param limits Byte and timeout bounds. @returns Source status and bytes after current-rights revalidation.
 */
export async function relayAuthenticatedArtifact(ctx: AppContext, req: Request, rec: ArtifactHandleRecord,
  limits: { maxBytes: number; timeoutMs: number }): Promise<{ ok: boolean; status: number; contentType: string; body: Buffer | null }> {
  await assertArtifactPrincipal(ctx, req, rec);
  if (rec.bytes) return { ok: true, status: 200, contentType: rec.type, body: rec.bytes };
  if (!rec.sourcePath || !req.socket.localPort) throw refused();
  localPath(rec.sourcePath);
  const base = `http://127.0.0.1:${req.socket.localPort}`, target = new URL(rec.sourcePath, base);
  if (target.origin !== base || !target.pathname.startsWith('/api/')) throw refused();
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, limits.timeoutMs); req.once('aborted', abort); req.res?.once('close', abort);
  try {
    const response = await fetch(target, { headers: callerHeaders(req), redirect: 'error', signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status, contentType: '', body: null };
    const body = await boundedBody(response, limits.maxBytes);
    await assertArtifactPrincipal(ctx, req, rec);
    if (controller.signal.aborted || req.aborted || req.res?.destroyed) throw refused();
    return { ok: true, status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream', body };
  } finally { clearTimeout(timer); req.off('aborted', abort); req.res?.off('close', abort); }
}
