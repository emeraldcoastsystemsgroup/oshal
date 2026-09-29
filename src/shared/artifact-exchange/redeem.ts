/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 wave 2: the SHARED package-side redeem (the BACKLOG's promised promotion — career and print-ingest carry hand-copied versions of this idiom; new destinations import it instead). One call turns a Send-to {ref} into named bytes: metadata + content fetched from the kernel relay over the loopback service rail AS the acting caller, so ownership stays enforced at mint and at use and the service secret never reaches the importing app's own logic. Fail-closed: bad ref shape, missing secret, expired/foreign refs, and oversize bodies all come back as a status + reason the route can relay verbatim.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The importing route hands over its own `request`, and the loopback then carries the CALLER'S verified rail (the session cookie and/or a PAT-shaped Authorization header, plus Host) instead of the service secret, the same rails relayAuthenticatedArtifact already forwards to a locator's source. Found live 2026-09-28: since a17f8d28 the relay binds every handle to the verified principal (sub + issuer) at mint and revalidates it at redeem through the application actor resolver, which refuses the service rail (a subject with no verified issuer), so GET /api/artifacts/handles/:ref answered 404 "handle not found or expired" and the Little Monsters class-material import relayed 404 "artifact handle not found" for a handle minted seconds earlier. Same process, same registry, same owner; the mismatch was between the mint rail and the redeem rail. A request carrying neither rail still uses the service rail (a mock-OIDC deployment stamps its mock user on the loopback too). Guarded by tests/unit/artifact-redeem-principal.spec.ts.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'artifact-exchange:redeem' });

/** A successful redeem: the artifact's display name, declared MIME type, and bytes. */
export interface RedeemedArtifact {
  ok: true;
  name: string;
  type: string;
  buffer: Buffer;
}

/** A failed redeem: the HTTP status and reason an importing route can relay verbatim. */
export interface RedeemFailure {
  ok: false;
  status: number;
  error: string;
}

/** The part of the importing route's request the loopback needs: its headers. */
export interface RedeemingRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** Per-redeem byte ceiling — matches the relay's own default; importing apps may pass less. */
const DEFAULT_MAX_BYTES = 52_428_800;
/** The one bearer shape the relay forwards as the caller's own rail: a personal access token. */
const PAT_AUTHORIZATION = /^Bearer\s+oshal_pat_[a-f0-9]{48}$/;

/**
 * @description The caller's own verified rail as the relay expects it: the session cookie and/or a
 * PAT-shaped Authorization header, with the original Host so the session validates as the browser's
 * did. Null when the request carries neither, in which case the legacy service rail is used.
 * @param request - The importing route's request (headers only).
 * @returns The headers to forward, or null.
 */
export function callerRelayHeaders(request: RedeemingRequest | undefined): Record<string, string> | null {
  if (!request || !request.headers) return null;
  const headers: Record<string, string> = {};
  const cookie = request.headers.cookie;
  if (typeof cookie === 'string' && cookie) headers.cookie = cookie;
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && PAT_AUTHORIZATION.test(authorization)) headers.authorization = authorization;
  if (!headers.cookie && !headers.authorization) return null;
  const host = request.headers.host;
  if (typeof host === 'string' && host) headers.host = host;
  return headers;
}

/**
 * @description The headers one loopback redeem sends: the caller's own rail when the importing
 * route handed its request over and it carries one, else the legacy service rail.
 * @param callerSub - The acting caller's sub (the service rail's identity assertion).
 * @param request - The importing route's request, when it passes it.
 * @returns The headers, or a failure when the service rail is needed but unconfigured.
 */
function relayHeaders(callerSub: string, request: RedeemingRequest | undefined): { headers: Record<string, string> } | { failure: RedeemFailure } {
  const own = callerRelayHeaders(request);
  if (own) return { headers: own };
  const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
  if (!secret) return { failure: { ok: false, status: 503, error: 'artifact relay unconfigured' } };
  return { headers: { 'x-service-secret': secret, 'x-oshal-user-sub': callerSub } };
}

/**
 * @description Redeem an ADR-139 artifact handle for its bytes via the kernel relay, AS the
 * acting caller. For app "Send to…" destination endpoints: pass the request's own local port
 * (`req.socket.localPort` — the same server instance), the authenticated caller's sub, and the
 * request itself, so the loopback presents the caller's own verified rail to the relay's
 * principal check (a handle is bound to sub + issuer at mint; the service rail carries no issuer).
 * @param input - port + callerSub + ref (+ optional request and maxBytes below the relay's ceiling).
 * @returns The named bytes, or a status + reason to relay.
 */
export async function redeemArtifactViaRelay(
  input: { port: number | undefined; callerSub: string; ref: string; maxBytes?: number; request?: RedeemingRequest },
): Promise<RedeemedArtifact | RedeemFailure> {
  const { port, callerSub, ref } = input;
  const maxBytes = Math.min(DEFAULT_MAX_BYTES, Math.max(1, input.maxBytes ?? DEFAULT_MAX_BYTES));
  const rail = relayHeaders(callerSub, input.request);
  if ('failure' in rail) return rail.failure;
  const { headers } = rail;
  if (!port) return { ok: false, status: 503, error: 'artifact relay port unavailable' };
  if (!/^art_[A-Za-z0-9_-]{8,64}$/.test(ref)) return { ok: false, status: 400, error: 'a valid artifact ref is required' };
  const base = `http://127.0.0.1:${port}`;
  try {
    const meta = await fetch(`${base}/api/artifacts/handles/${encodeURIComponent(ref)}`, { headers, redirect: 'manual' });
    if (!meta.ok) {
      return { ok: false, status: meta.status === 404 ? 404 : 502, error: meta.status === 404 ? 'artifact handle not found — it may have expired; use Send to… again' : 'artifact lookup failed' };
    }
    const info = await meta.json() as { name?: string; type?: string };
    const content = await fetch(`${base}/api/artifacts/handles/${encodeURIComponent(ref)}/content`, { headers, redirect: 'manual' });
    if (!content.ok) return { ok: false, status: 502, error: 'artifact source unavailable' };
    const buffer = Buffer.from(await content.arrayBuffer());
    if (buffer.length > maxBytes) return { ok: false, status: 413, error: 'artifact exceeds this destination’s size limit' };
    return {
      ok: true,
      name: String(info.name || 'artifact').replace(/[\r\n"\\/]/g, '_').slice(0, 120),
      type: String(info.type || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100),
      buffer,
    };
  } catch (err) {
    logger.error({ err, ref }, 'artifact redeem via relay failed');
    return { ok: false, status: 502, error: 'artifact redeem failed' };
  }
}
