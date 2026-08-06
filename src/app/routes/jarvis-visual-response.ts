/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial authenticated Jarvis image route and non-blocking visual integration adapter.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Resolve SEC-01 verified delegation claims before the legacy service-sub compatibility path on owner-scoped visual reads.
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
import { getVerifiedWorkloadDelegation } from '@/features/security';
import {
  parseVisualResponseSpec, VisualResponseService, type FactLockedAnswerPacket, type VisualResponseArtifact,
} from '@/features/visual-response';

const logger = createChildLogger({ module: 'jarvis-visual-response' });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @description Best-effort adapter used by `/ask`: visual generation is optional, so a renderer
 * or persistence failure is logged and deliberately leaves the authoritative text response intact.
 * @param service - Owner-scoped visual artifact service.
 * @param userSub - Authenticated owner of the answer.
 * @param packet - Final fact-locked answer packet.
 * @returns Persisted image metadata, or undefined when the optional visual path fails.
 */
export async function createOptionalJarvisVisual(
  service: VisualResponseService,
  userSub: string,
  packet: FactLockedAnswerPacket,
): Promise<VisualResponseArtifact | undefined> {
  const visualSpec = parseVisualResponseSpec(packet.visualSpec);
  if (!visualSpec) {
    if (packet.visualSpec !== undefined) {
      logger.warn({ sourceJobId: packet.sourceJobId }, 'Ignoring invalid Jarvis visual directive');
    }
    return undefined;
  }
  try {
    return await service.createArtifact(userSub, { ...packet, visualSpec });
  } catch (err) {
    logger.error({ err, sourceJobId: packet.sourceJobId }, 'Jarvis visual unavailable; returning text fallback');
    return undefined;
  }
}

/**
 * @description Creates the authenticated, owner-scoped route that serves persisted Jarvis images.
 * The parent `/api/jarvis` mount admits ordinary user auth or a durable route delegation; this
 * router additionally binds every read to that verified subject so artifact ids cannot cross users.
 * @param service - Visual artifact service shared with the `/ask` integration.
 * @returns Express router mounted at `/api/jarvis/visuals`.
 */
export function createJarvisVisualRoutes(service: VisualResponseService): Router {
  const router = Router();
  router.get('/:artifactId', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const artifactId = String(req.params.artifactId || '');
    const userSub = callerSub(req);
    logger.info({ artifactId }, 'Jarvis visual route entered');
    if (!userSub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    if (!UUID_PATTERN.test(artifactId)) { res.status(404).json({ error: 'visual_not_found' }); return; }
    try {
      const artifact = await service.getArtifact(userSub, artifactId);
      if (!artifact) { res.status(404).json({ error: 'visual_not_found' }); return; }
      res.setHeader('Content-Type', `${artifact.metadata.mimeType}; charset=utf-8`);
      res.setHeader('Content-Length', String(artifact.content.byteLength));
      res.setHeader('Content-Disposition', `inline; filename="jarvis-visual-${artifactId}.svg"`);
      // These SVGs can contain mailbox subjects and other owner-private facts. Browser replay uses
      // the authenticated URL; it must not depend on a shared or persistent HTTP cache.
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('ETag', `"${artifact.contentSha256}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Referrer-Policy', 'no-referrer');
      // Gallery SVGs may contain only server-received, sanitized raster bytes embedded as `data:`
      // images. Keep every network origin blocked: model/provider URLs must never become subrequests.
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
      logger.info({ artifactId, durationMs: Date.now() - startedAt }, 'Jarvis visual route completed');
      res.send(artifact.content);
    } catch (err) {
      logger.error({ err, artifactId, durationMs: Date.now() - startedAt }, 'Jarvis visual route failed');
      res.status(500).json({ error: 'visual_unavailable' });
    }
  });
  return router;
}

function callerSub(req: Request): string | null {
  const user = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc?.user;
  const sub = user?.sub || user?.oid;
  if (sub) return String(sub);
  const delegated = getVerifiedWorkloadDelegation(req);
  return delegated?.sub ?? getTrustedServiceUserSub(req);
}
