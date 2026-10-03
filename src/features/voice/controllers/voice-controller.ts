/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — Voice controller using BaseController pattern
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log formatting while keeping controller API unchanged
 * 3 | maintainer@emeraldcoastsystemsgroup.com | 2026-07-30 23:10:00 | Added
 *   explicit Express RequestHandler annotations to exported controller handlers so committed-HEAD
 *   declaration typechecking stays portable and does not infer transitive @types/qs paths.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | JVV-012: synthesize now honors the caller's SAVED per-user provider/voice via an injected prefs resolver — explicit body values always win; when the body names no provider, the saved provider (and, only then, its saved voice) applies; no resolver / no prefs → the swarm-default flow exactly as before. getVoices accepts ?providerId= so the picker can enumerate a specific provider's voices.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: an injected VoiceCallerResolver says whose call each request is (principal, application, accountable bot; D8) and both handlers pass it to the service. The saved selection is no longer substituted as an explicit provider: it travels as the user default (rung 3), so an unavailable saved provider falls to the swarm default (D1, D5) and its voice is never sent to another provider (D9). Explicit body values still win.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D10 (round 2): the synthesize comment now says what the service does: a body provider answers when available; when it is not registered or not available the walk moves on under D5. A change from main, where only an unregistered requested provider fell back to the swarm default, and a registered one that was not usable was called and returned its own unconfigured or failed result.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { BaseController } from '@/shared/api';
import { validateBody, validateFile } from '@/shared/api';
import type { CapabilityCaller, CapabilityChoice } from '@/shared/capability-providers';
import { VoiceService } from '../services/voice-service';
import { SynthesizeRequestSchema } from '../schemas/voice-schemas';

/**
 * @description Resolves the caller's saved TTS preference (provider + voice), if any.
 * Injected by the route layer (which owns the DB pool + caller identity); the controller
 * stays storage-agnostic. Returning null means "no saved preference — default flow".
 */
export type TtsPrefsResolver = (req: Request) => Promise<{ providerId?: string | null; voiceId?: string | null } | null>;

/**
 * @description Says whose call a request is, the application and the accountable bot (ADR-173 D8).
 * Injected by the route layer, which owns the caller identity; without it a call resolves as
 * unattributed (the operator-written rungs only).
 */
export type VoiceCallerResolver = (req: Request) => CapabilityCaller;

/**
 * @description Controller for voice-related endpoints (STT/TTS).
 * Extends BaseController to inherit standardized response handling,
 * error handling, logging, and timing.
 *
 * Delegates all business logic to VoiceService.
 */
export class VoiceController extends BaseController {
  constructor(
    private service: VoiceService,
    private prefsResolver?: TtsPrefsResolver,
    private callerResolver?: VoiceCallerResolver,
  ) {
    super({ module: 'voice-controller' });
  }

  /**
   * @description Handler for POST /api/voice/transcribe
   * Transcribes uploaded audio file to text (Speech-to-Text).
   * 
   * Expects multipart/form-data with audio file.
   */
  transcribe: RequestHandler = this.handle(async (req: Request, res: Response, next: NextFunction) => {
    // Validate uploaded file
    const audioFile = validateFile(req.file, {
      required: true,
      maxSize: 10 * 1024 * 1024, // 10MB
      allowedMimeTypes: ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/ogg'],
    });

    // Delegate to service with the caller (ADR-173 D8): the swarm default answers unless the
    // calling code names a provider, and a failed provider surfaces its own failure (D5).
    const caller = this.callerResolver?.(req);
    const result = await this.measure('transcribeAudio', () =>
      this.service.transcribeAudio(audioFile.buffer, audioFile.mimetype, { caller })
    );

    // Return standardized success response
    return this.success(result);
  });

  /**
   * @description Handler for POST /api/voice/synthesize
   * Synthesizes text to speech (Text-to-Speech).
   * 
   * Expects JSON body with text and optional voice.
   */
  synthesize: RequestHandler = this.handle(async (req: Request, res: Response, next: NextFunction) => {
    // Validate request body
    const { text, voice, providerId } = validateBody(req, SynthesizeRequestSchema);

    // JVV-012 + ADR-173: a caller that names no provider has their SAVED selection (provider +
    // voice) tried as rung 3, the user default; when that provider is unavailable the swarm
    // default answers (D1, D5), and a voice travels only with its own provider (D9). A body
    // provider is a preference (D10's default): it answers when available; when it is not
    // registered or not available the walk moves on under D5. A change from main, where a registered
    // provider that was not usable was called and returned its own failure (see the service's CHANGE LOG 9).
    let userDefault: CapabilityChoice | null = null;
    if (!providerId && this.prefsResolver) {
      const prefs = await this.prefsResolver(req);
      if (prefs?.providerId) userDefault = { providerId: prefs.providerId, voice: prefs.voiceId ?? null };
    }
    const caller = this.callerResolver?.(req);

    // Delegate to service
    const result = await this.measure('synthesizeSpeech', () =>
      this.service.synthesizeSpeech(text, voice, providerId, { caller, userDefault })
    );

    // Return standardized success response
    return this.success(result);
  });

  /**
   * @description Handler for GET /api/voice/voices
   * Returns list of available voices for TTS.
   */
  getVoices: RequestHandler = this.handle(async (req: Request, res: Response, next: NextFunction) => {
    // Optional explicit provider (JVV-012 picker) — unknown ids fall back to the default.
    const providerId = typeof req.query.providerId === 'string' ? req.query.providerId : undefined;

    // Delegate to service
    const result = await this.measure('getAvailableVoices', () =>
      this.service.getAvailableVoices(providerId)
    );

    // Return standardized success response
    return this.success(result);
  });
}
