/**
 * Vision routes — POST /api/vision/describe: turn attached image(s) into a factual text
 * description so a text-only reasoning brain (the Codex-CLI Jarvis bot) can answer about a
 * photo the user attached. This is the visual analog of /api/voice/transcribe: a controller-side
 * transform whose small text output rides into the next /ask turn, exactly as a voice transcript
 * does — which is why images never need to travel inline through the size-capped /ask body.
 *
 * Auth: mounted behind requiresAuth (browser surface) OR the trusted-service identity
 * (X-Service-Secret + x-oshal-user-sub), the same serviceSecretOr pattern as jarvis/message routes.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — POST /api/vision/describe over VisionDescribeService (OpenRouter vision model). Caller-scoped; cost attributed to the caller sub. Mounted with its own 12MB JSON parser (base64 images exceed the global 100kb cap).
 *
 * @module vision-routes
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
import type { AppContext } from '@/app/composition/app-context';
import { VisionDescribeService, type VisionImageInput } from '@/features/vision-describe';

const logger = createChildLogger({ module: 'vision-routes' });

/** Caller's sub: OIDC session first, else the trusted-service identity. Mirrors jarvis-routes. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc?.user;
  const sub = u?.sub || u?.oid;
  if (sub) return String(sub);
  return getTrustedServiceUserSub(req);
}

/** A safe task-id token (the surface sends a localStorage UUID); falls back to a per-user id. */
function resolveTaskId(raw: unknown, sub: string): string {
  const value = String(raw || '').trim();
  return /^[\w.-]{6,128}$/.test(value) ? value : `jarvis-${sub}`;
}

/**
 * @description Builds the vision router (mount at /api/vision behind requiresAuth, with a 12MB
 * JSON parser so base64 images clear the global 100kb body cap).
 * @param ctx - App context (Postgres pool for cost persistence).
 * @returns Express router.
 */
export function createVisionRoutes(ctx: AppContext): Router {
  const router = Router();
  const service = new VisionDescribeService(ctx.pool);

  /** POST /describe — { images: [{ dataUrl }], question?, sessionId? } → { description, model, cost }. */
  router.post('/describe', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const body = (req.body || {}) as { images?: VisionImageInput[]; question?: string; sessionId?: string };
    const images = Array.isArray(body.images) ? body.images : [];
    if (images.length === 0) { res.status(400).json({ error: 'images required' }); return; }
    if (!service.isAvailable()) {
      res.status(503).json({ error: 'vision_unavailable', message: 'No OpenRouter credential is configured for image understanding.' });
      return;
    }
    try {
      const result = await service.describe({
        images,
        question: typeof body.question === 'string' ? body.question : undefined,
        ownerSub: sub,
        taskId: resolveTaskId(body.sessionId, sub),
      });
      res.json(result);
    } catch (err) {
      // Client input errors (bad/oversized data URL, too many images) are 400; everything else 500.
      const message = (err as Error).message || 'vision describe failed';
      const clientError = /image|data URL|at most|8MB|required/i.test(message);
      logger.warn({ err, clientError }, 'vision describe failed');
      res.status(clientError ? 400 : 500).json({ error: 'describe_failed', message });
    }
  });

  logger.info('Vision routes registered (POST /api/vision/describe)');
  return router;
}
