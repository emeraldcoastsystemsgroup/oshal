/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-139 Stage 1 routes: POST /handles mints an owner-bound claim ticket over a serve URL the caller can already read; GET /handles/:ref(/content) redeems it — content re-fetches the source SERVER-SIDE as the minting caller (service secret + sub over the loopback to this same server instance), so ownership is enforced at mint AND at use; GET /actions answers the "Send to…" menu for a MIME type; GET /send-to.js serves the one shared browser component. Mounted at /api/artifacts behind serviceSecretOr(requiresAuth). Enforcement for a dispatched action stays at the DESTINATION's own gate.
 */

import * as path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
import {
  artifactActionsForType,
  mintArtifactHandle,
  resolveArtifactHandle,
} from '@/shared/artifact-exchange';

const logger = createChildLogger({ module: 'artifact-exchange-routes' });

/** Refuse to relay a source object larger than this — a handle is a gesture, not bulk transfer. */
const MAX_CONTENT_BYTES = Math.max(1_000_000, parseInt(process.env.ARTIFACT_MAX_CONTENT_BYTES || '52428800', 10) || 52_428_800);
/** Hard deadline on the internal source fetch — a hung source must not hold the relay open. */
const SOURCE_FETCH_TIMEOUT_MS = 30_000;

/**
 * @description Signed-in caller's OIDC sub, or the trusted sub from an internal service-secret
 * call — the same precedence every app surface uses.
 * @param req - The incoming request.
 * @returns The acting user's sub, or null when unauthenticated.
 */
function callerSub(req: Request): string | null {
  const trusted = getTrustedServiceUserSub(req);
  if (trusted) return trusted;
  const u = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc?.user;
  const sub = u?.sub || u?.oid;
  return sub ? String(sub) : null;
}

/**
 * @description Fetch the handle's source object from THIS server instance over the loopback,
 * authenticated as the minting caller (service secret + x-oshal-user-sub) — the headless
 * identity rail the platform already trusts internally. The secret never leaves this function.
 * @param req - The redeeming request (its socket tells us our own port).
 * @param sourcePath - The validated root-relative source path.
 * @param ownerSub - The minting caller the fetch acts as.
 * @returns Status, content type, and bytes of the source response.
 */
async function fetchSourceAsOwner(
  req: Request,
  sourcePath: string,
  ownerSub: string,
): Promise<{ ok: boolean; status: number; contentType: string; body: Buffer | null }> {
  const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
  if (!secret) return { ok: false, status: 503, contentType: '', body: null };
  const port = req.socket.localPort;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${sourcePath}`, {
      headers: { 'x-service-secret': secret, 'x-oshal-user-sub': ownerSub },
      signal: controller.signal,
    });
    if (!r.ok) return { ok: false, status: r.status, contentType: '', body: null };
    const declared = Number(r.headers.get('content-length') || 0);
    if (declared > MAX_CONTENT_BYTES) return { ok: false, status: 413, contentType: '', body: null };
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > MAX_CONTENT_BYTES) return { ok: false, status: 413, contentType: '', body: null };
    return { ok: true, status: r.status, contentType: r.headers.get('content-type') || 'application/octet-stream', body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @description Create the artifact-exchange routes (ADR-139 Stage 1). Mounted at /api/artifacts
 * behind serviceSecretOr(requiresAuth) in server.ts.
 * @returns Configured Express router.
 */
export function createArtifactExchangeRoutes(): Router {
  const router = Router();

  /** GET /actions?type=<mime> — the "Send to…" menu for one artifact type. Entries the caller
   *  may not ultimately use still fail closed at the destination's own gate on dispatch. */
  router.get('/actions', (req, res) => {
    const mime = String(req.query.type || '').trim();
    if (!mime || !mime.includes('/') || mime.length > 100) {
      res.status(400).json({ error: 'type must be a MIME type, e.g. image/png' });
      return;
    }
    res.json({ actions: artifactActionsForType(mime) });
  });

  /** POST /handles — mint a claim ticket over a serve URL the caller can already read. */
  router.post('/handles', (req, res) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'unauthenticated' }); return; }
    const body = (req.body ?? {}) as { source?: unknown; type?: unknown; name?: unknown };
    try {
      const record = mintArtifactHandle({
        ownerSub: sub,
        sourcePath: String(body.source ?? ''),
        type: String(body.type ?? ''),
        name: typeof body.name === 'string' ? body.name : undefined,
      });
      res.status(201).json({ ref: record.ref, type: record.type, name: record.name, expiresAt: new Date(record.expiresAt).toISOString() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'handle mint failed' });
    }
  });

  /** GET /handles/:ref — metadata (owner only; foreign/expired/missing are one 404). */
  router.get('/handles/:ref', (req, res) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'unauthenticated' }); return; }
    const rec = resolveArtifactHandle(String(req.params.ref || ''), sub);
    if (!rec) { res.status(404).json({ error: 'artifact handle not found' }); return; }
    res.json({ ref: rec.ref, type: rec.type, name: rec.name, expiresAt: new Date(rec.expiresAt).toISOString() });
  });

  /** GET /handles/:ref/content — the artifact bytes, re-fetched server-side AS the minting
   *  caller through the source's own auth-gated serve route (ownership enforced at use). */
  router.get('/handles/:ref/content', async (req, res) => {
    const started = Date.now();
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'unauthenticated' }); return; }
    const rec = resolveArtifactHandle(String(req.params.ref || ''), sub);
    if (!rec) { res.status(404).json({ error: 'artifact handle not found' }); return; }
    try {
      const fetched = await fetchSourceAsOwner(req, rec.sourcePath, rec.ownerSub);
      if (!fetched.ok || !fetched.body) {
        const status = fetched.status === 503 ? 503 : fetched.status === 413 ? 413 : 502;
        logger.warn({ ref: rec.ref, sourceStatus: fetched.status }, 'artifact source fetch failed');
        res.status(status).json({ error: status === 503 ? 'artifact relay unconfigured (SWARM_SERVICE_SECRET unset)' : status === 413 ? 'artifact too large to relay' : 'artifact source unavailable' });
        return;
      }
      res.setHeader('Content-Type', rec.type || fetched.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${rec.name}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(fetched.body);
      logger.info({ ref: rec.ref, bytes: fetched.body.length, durationMs: Date.now() - started }, 'artifact handle redeemed');
    } catch (err) {
      logger.error({ err, ref: rec.ref }, 'artifact content relay failed');
      res.status(502).json({ error: 'artifact source unavailable' });
    }
  });

  /** GET /send-to.js — the one shared browser component every surface loads (classic script). */
  router.get('/send-to.js', (_req: Request, res: Response) => {
    res.type('application/javascript');
    res.sendFile(path.resolve(process.cwd(), 'src/pages/cockpit/js/components/send-to.js'), (err) => {
      if (err) {
        logger.error({ err }, 'failed to serve send-to component');
        res.status(404).send('// send-to component not found');
      }
    });
  });

  return router;
}
