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
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-110 follow-up: POST /api/vision/read-doc — server-side PDF/DOCX/text extraction (doc-extract feature; pdf-parse + yauzl, both already-shipped deps) so a binary attached to a Jarvis prompt becomes bounded text for the /ask turn. Extraction failure is an HONEST 200 { ok:false, reason } — the surface names the file and says it couldn't be read; it is never a silent drop, and only transport/shape errors use 4xx/5xx.
 *
 * @module vision-routes
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
import type { AppContext } from '@/app/composition/app-context';
import { VisionDescribeService, type VisionImageInput } from '@/features/vision-describe';
import { extractDocText } from '@/features/doc-extract';

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

  /** POST /read-doc — { name?, dataUrl } (any base64 data: URL) → bounded extracted text.
   *  Success: { ok:true, name, format, text, truncated }. Extraction failure is an honest
   *  200 { ok:false, name, format, reason } so the surface can attach "couldn't read <file>"
   *  instead of silently dropping the document. 4xx is reserved for transport/shape errors. */
  router.post('/read-doc', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const body = (req.body || {}) as { name?: string; dataUrl?: string; mime?: string };
    const parsedInput = parseDocDataUrl(body.dataUrl);
    if (!parsedInput) { res.status(400).json({ error: 'dataUrl required (base64 data: URL, max 10MB)' }); return; }
    const name = typeof body.name === 'string' ? body.name.slice(0, 200) : undefined;
    const result = await extractDocText({ name, buffer: parsedInput.buffer, mime: body.mime || parsedInput.mime });
    if (result.ok) {
      logger.info({ sub, name, format: result.format, chars: result.text.length, truncated: result.truncated }, 'read-doc extracted');
      res.json({ ok: true, name: name || null, format: result.format, text: result.text, truncated: result.truncated });
    } else {
      logger.warn({ sub, name, format: result.format, reason: result.reason }, 'read-doc extraction failed — honest failure returned');
      res.json({ ok: false, name: name || null, format: result.format, reason: result.reason });
    }
  });

  logger.info('Vision routes registered (POST /api/vision/describe, POST /api/vision/read-doc)');
  return router;
}

/** Max base64 payload for a document (post-decode ~10MB; the mount's JSON cap is 12MB). */
const MAX_DOC_DATAURL_CHARS = 14 * 1024 * 1024;

/** Parse a `data:<mime>;base64,<payload>` URL into bytes; null on any shape problem. */
function parseDocDataUrl(dataUrl: unknown): { buffer: Buffer; mime: string } | null {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_DOC_DATAURL_CHARS) return null;
  const match = /^data:([\w.+-]+\/[\w.+-]+)?(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  try {
    return { buffer: Buffer.from(match[2], 'base64'), mime: match[1] || '' };
  } catch {
    return null;
  }
}
