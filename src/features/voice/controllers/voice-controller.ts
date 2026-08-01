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
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { BaseController } from '@/shared/api';
import { validateBody, validateFile } from '@/shared/api';
import { VoiceService } from '../services/voice-service';
import { SynthesizeRequestSchema } from '../schemas/voice-schemas';

/**
 * @description Resolves the caller's saved TTS preference (provider + voice), if any.
 * Injected by the route layer (which owns the DB pool + caller identity); the controller
 * stays storage-agnostic. Returning null means "no saved preference — default flow".
 */
export type TtsPrefsResolver = (req: Request) => Promise<{ providerId?: string | null; voiceId?: string | null } | null>;

/**
 * @description Controller for voice-related endpoints (STT/TTS).
 * Extends BaseController to inherit standardized response handling,
 * error handling, logging, and timing.
 *
 * Delegates all business logic to VoiceService.
 */
export class VoiceController extends BaseController {
  constructor(private service: VoiceService, private prefsResolver?: TtsPrefsResolver) {
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

    // Delegate to service
    const result = await this.measure('transcribeAudio', () =>
      this.service.transcribeAudio(audioFile.buffer, audioFile.mimetype)
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

    // JVV-012: a caller that names no provider gets their SAVED per-user selection (provider
    // + voice). Explicit body values always win; the saved voice applies only alongside the
    // saved provider (voice ids are provider-specific). No prefs → swarm default, unchanged.
    let effectiveProviderId = providerId;
    let effectiveVoice = voice;
    if (!effectiveProviderId && this.prefsResolver) {
      const prefs = await this.prefsResolver(req);
      if (prefs?.providerId) {
        effectiveProviderId = prefs.providerId;
        if (!effectiveVoice && prefs.voiceId) effectiveVoice = prefs.voiceId;
      }
    }

    // Delegate to service
    const result = await this.measure('synthesizeSpeech', () =>
      this.service.synthesizeSpeech(text, effectiveVoice, effectiveProviderId)
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
