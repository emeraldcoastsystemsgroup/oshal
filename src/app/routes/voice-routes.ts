/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — Voice API routes for STT/TTS
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refactored to use BaseController pattern and VoiceService
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Switched to direct backend voice imports to avoid browser-only service compilation in server build
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Restored barrel import after voice services public API was narrowed to backend-safe exports
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | JVV-012 selectable TTS: GET /providers (every registered provider with LIVE configured status + voices — unconfigured ones ship reason for an honest disabled UI), GET/POST /prefs (per-user provider+voice persisted in voice_user_prefs; POST rejects any provider whose getStatus is not configured — never selectable), and the synthesize path now honors the caller's saved selection via the controller's prefs resolver. createVoiceRoutes takes the AppContext (pool) — omitted (tests/legacy) → prefs endpoints answer 503 and synthesize keeps the swarm-default flow.
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
import { VoiceController, VoiceService } from '@/features/voice';
import { VoicePrefsStore, getTTSProviderRegistry } from '@/features/voice-providers';
import type { AppContext } from '@/app/composition/app-context';

const logger = createChildLogger({ module: 'voice-routes' });

/**
 * @description Configure multer for audio file uploads.
 * Store files in memory for processing.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
  },
  fileFilter: (_req, file, cb) => {
    // Accept audio files only
    if (file.mimetype.startsWith('audio/') || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  },
});

/** Caller's sub: OIDC session first, else the trusted-service identity. Mirrors jarvis-routes. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc?.user;
  const sub = u?.sub || u?.oid;
  if (sub) return String(sub);
  return getTrustedServiceUserSub(req);
}

/**
 * @description Creates Express router for voice endpoints (STT/TTS + the JVV-012 voice
 * picker rails). Mounted behind requiresAuth.
 *
 * @param ctx - App context (pool for per-user voice prefs). Optional: without it the
 *   prefs endpoints answer 503 and synthesize keeps the swarm-default flow.
 * @returns Express Router with voice routes mounted
 */
export function createVoiceRoutes(ctx?: AppContext): Router {
  const router = Router();

  // Per-user voice prefs (JVV-012). Schema ensure is fire-and-forget: a failed bootstrap
  // degrades to "no saved prefs" (default flow), never a crashed route registration.
  const prefsStore = ctx?.pool ? new VoicePrefsStore(ctx.pool) : null;
  prefsStore?.ensureSchema().catch((err) => logger.error({ err }, 'voice_user_prefs schema ensure failed — prefs degrade to default flow'));

  // Initialize service and controller (controller resolves saved prefs at synthesize time).
  const service = new VoiceService();
  const controller = new VoiceController(service, async (req) => {
    if (!prefsStore) return null;
    const sub = callerSub(req);
    if (!sub) return null;
    try {
      const prefs = await prefsStore.get(sub);
      return prefs ? { providerId: prefs.ttsProvider, voiceId: prefs.ttsVoice } : null;
    } catch (err) {
      logger.error({ err, sub }, 'voice prefs lookup failed — falling back to swarm default');
      return null;
    }
  });

  // Register routes with controller handlers
  router.post('/transcribe', upload.single('audio'), controller.transcribe);
  router.post('/synthesize', controller.synthesize);
  router.get('/voices', controller.getVoices);

  /** GET /providers — every registered TTS provider with live status + voices, plus the
   *  swarm default and the caller's saved selection. Unconfigured providers are listed
   *  (configured:false + reason) so the UI renders an honest disabled state. */
  router.get('/providers', async (req: Request, res: Response) => {
    try {
      const listing = await service.listTtsProviders();
      const sub = callerSub(req);
      const prefs = prefsStore && sub ? await prefsStore.get(sub).catch(() => null) : null;
      res.json({
        ...listing,
        selected: prefs ? { providerId: prefs.ttsProvider, voiceId: prefs.ttsVoice } : null,
      });
    } catch (err) {
      logger.error({ err }, 'voice providers listing failed');
      res.status(500).json({ error: 'providers_failed', message: (err as Error).message });
    }
  });

  /** GET /prefs — the caller's saved voice selection (null = swarm default). */
  router.get('/prefs', async (req: Request, res: Response) => {
    if (!prefsStore) { res.status(503).json({ error: 'prefs_unavailable', message: 'no database on this deployment' }); return; }
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const prefs = await prefsStore.get(sub);
      res.json({ selected: prefs ? { providerId: prefs.ttsProvider, voiceId: prefs.ttsVoice } : null });
    } catch (err) {
      logger.error({ err, sub }, 'voice prefs read failed');
      res.status(500).json({ error: 'prefs_read_failed' });
    }
  });

  /** POST /prefs — { providerId, voiceId? } saves; { providerId: null } clears (back to the
   *  swarm default). An unknown provider is 404; a registered-but-UNCONFIGURED provider is
   *  400 provider_not_configured — never selectable (JVV-012). */
  router.post('/prefs', async (req: Request, res: Response) => {
    if (!prefsStore) { res.status(503).json({ error: 'prefs_unavailable', message: 'no database on this deployment' }); return; }
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const body = (req.body || {}) as { providerId?: unknown; voiceId?: unknown };
    try {
      if (body.providerId === null || body.providerId === '') {
        await prefsStore.clear(sub);
        res.json({ selected: null });
        return;
      }
      const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
      if (!providerId) { res.status(400).json({ error: 'providerId required (string, or null to clear)' }); return; }
      const provider = getTTSProviderRegistry().get(providerId);
      if (!provider) { res.status(404).json({ error: 'unknown_provider', message: `no TTS provider "${providerId}" is registered` }); return; }
      const status = await provider.getStatus().catch((err) => ({ configured: false, providerId, reason: (err as Error).message }));
      if (!status.configured) {
        res.status(400).json({
          error: 'provider_not_configured',
          message: status.reason || `${providerId} is not configured on this deployment`,
        });
        return;
      }
      const voiceId = typeof body.voiceId === 'string' && body.voiceId.trim() ? body.voiceId.trim().slice(0, 200) : null;
      await prefsStore.set(sub, providerId, voiceId);
      res.json({ selected: { providerId, voiceId } });
    } catch (err) {
      logger.error({ err, sub }, 'voice prefs save failed');
      res.status(500).json({ error: 'prefs_save_failed' });
    }
  });

  logger.info('Voice routes registered with BaseController pattern (+ JVV-012 providers/prefs)');
  return router;
}
