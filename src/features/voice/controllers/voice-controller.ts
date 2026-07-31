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
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { BaseController } from '@/shared/api';
import { validateBody, validateFile } from '@/shared/api';
import { VoiceService } from '../services/voice-service';
import { SynthesizeRequestSchema } from '../schemas/voice-schemas';

/**
 * @description Controller for voice-related endpoints (STT/TTS).
 * Extends BaseController to inherit standardized response handling,
 * error handling, logging, and timing.
 * 
 * Delegates all business logic to VoiceService.
 */
export class VoiceController extends BaseController {
  constructor(private service: VoiceService) {
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

    // Delegate to service
    const result = await this.measure('synthesizeSpeech', () =>
      this.service.synthesizeSpeech(text, voice, providerId)
    );

    // Return standardized success response
    return this.success(result);
  });

  /**
   * @description Handler for GET /api/voice/voices
   * Returns list of available voices for TTS.
   */
  getVoices: RequestHandler = this.handle(async (req: Request, res: Response, next: NextFunction) => {
    // Delegate to service
    const result = await this.measure('getAvailableVoices', () =>
      this.service.getAvailableVoices()
    );

    // Return standardized success response
    return this.success(result);
  });
}
