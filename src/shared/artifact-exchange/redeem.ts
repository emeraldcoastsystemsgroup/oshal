/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 wave 2: the SHARED package-side redeem (the BACKLOG's promised promotion — career and print-ingest carry hand-copied versions of this idiom; new destinations import it instead). One call turns a Send-to {ref} into named bytes: metadata + content fetched from the kernel relay over the loopback service rail AS the acting caller, so ownership stays enforced at mint and at use and the service secret never reaches the importing app's own logic. Fail-closed: bad ref shape, missing secret, expired/foreign refs, and oversize bodies all come back as a status + reason the route can relay verbatim.
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

/** Per-redeem byte ceiling — matches the relay's own default; importing apps may pass less. */
const DEFAULT_MAX_BYTES = 52_428_800;

/**
 * @description Redeem an ADR-139 artifact handle for its bytes via the kernel relay, AS the
 * acting caller. For app "Send to…" destination endpoints: pass the request's own local port
 * (`req.socket.localPort` — the same server instance) and the authenticated caller's sub.
 * @param input - port + callerSub + ref (+ optional maxBytes below the relay's ceiling).
 * @returns The named bytes, or a status + reason to relay.
 */
export async function redeemArtifactViaRelay(
  input: { port: number | undefined; callerSub: string; ref: string; maxBytes?: number },
): Promise<RedeemedArtifact | RedeemFailure> {
  const { port, callerSub, ref } = input;
  const maxBytes = Math.min(DEFAULT_MAX_BYTES, Math.max(1, input.maxBytes ?? DEFAULT_MAX_BYTES));
  const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
  if (!secret) return { ok: false, status: 503, error: 'artifact relay unconfigured' };
  if (!port) return { ok: false, status: 503, error: 'artifact relay port unavailable' };
  if (!/^art_[A-Za-z0-9_-]{8,64}$/.test(ref)) return { ok: false, status: 400, error: 'a valid artifact ref is required' };
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'x-service-secret': secret, 'x-oshal-user-sub': callerSub };
  try {
    const meta = await fetch(`${base}/api/artifacts/handles/${encodeURIComponent(ref)}`, { headers });
    if (!meta.ok) {
      return { ok: false, status: meta.status === 404 ? 404 : 502, error: meta.status === 404 ? 'artifact handle not found — it may have expired; use Send to… again' : 'artifact lookup failed' };
    }
    const info = await meta.json() as { name?: string; type?: string };
    const content = await fetch(`${base}/api/artifacts/handles/${encodeURIComponent(ref)}/content`, { headers });
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
