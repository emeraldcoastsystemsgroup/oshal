/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — Voice API routes for STT/TTS
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refactored to use BaseController pattern and VoiceService
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Switched to direct backend voice imports to avoid browser-only service compilation in server build
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Restored barrel import after voice services public API was narrowed to backend-safe exports
 */

import { Router } from 'express';
import multer from 'multer';
import { createChildLogger } from '@/shared/logger';
import { VoiceController, VoiceService } from '@/features/voice';

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

/**
 * @description Creates Express router for voice endpoints (STT/TTS).
 * Uses VoiceController which extends BaseController for standardized handling.
 * 
 * @returns Express Router with voice routes mounted
 */
export function createVoiceRoutes(): Router {
  const router = Router();
  
  // Initialize service and controller
  const service = new VoiceService();
  const controller = new VoiceController(service);

  // Register routes with controller handlers
  router.post('/transcribe', upload.single('audio'), controller.transcribe);
  router.post('/synthesize', controller.synthesize);
  router.get('/voices', controller.getVoices);

  logger.info('Voice routes registered with BaseController pattern');
  return router;
}
