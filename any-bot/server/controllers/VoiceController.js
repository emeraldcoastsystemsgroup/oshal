/**
 * Voice Controller (any-bot JS side)
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial voice endpoints — AWS Polly + Transcribe
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed AWS Polly / Transcribe imports — violates "no Polly, pluggable TTS" rule. Voice synthesis + transcription now live on the swarm controller at /api/voice/* (see src/features/voice-providers). This file keeps presentation routes and returns 501 for audio endpoints.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Retired the Presentron proxy endpoints: services/PresentationService.js (a dead-host client that silently served MOCK data on failure — standing no-mock violation) is deleted, and the presentation endpoints now return 501 moved-pointers at the swarm's in-repo deck engine, mirroring how this file already handles the migrated audio endpoints.
 */

const logger = require('../utils/logger');

/**
 * Payload returned by the deprecated audio endpoints. Points callers at the
 * swarm controller's pluggable voice stack.
 */
const MIGRATED_RESPONSE = {
  success: false,
  error: 'moved',
  message:
    'Voice synthesis and transcription moved to the swarm controller at /api/voice/* ' +
    '(src/features/voice-providers). The any-bot JS path no longer calls AWS Polly.',
};

/**
 * Payload returned by the retired Presentron proxy endpoints. The Presentron
 * sidecar is gone; deck generation runs on the swarm controller's in-repo
 * presentation engine (src/features/presentation-generation), reachable through
 * the `presentron` chat tool. The old proxy's mock fallback is deleted with it.
 */
const PRESENTATIONS_RETIRED_RESPONSE = {
  success: false,
  error: 'moved',
  message:
    'The Presentron proxy was retired. Presentations render on the swarm controller\'s ' +
    'in-repo deck engine (src/features/presentation-generation) via the `presentron` ' +
    'chat tool; this any-bot proxy (and its mock fallback) no longer exists.',
};

class VoiceController {
  /**
   * POST /api/transcribe
   * Deprecated — returns 501 with a pointer to /api/voice/transcribe on the swarm.
   */
  async transcribe(req, res) {
    logger.warn('Deprecated /api/transcribe hit — use swarm /api/voice/transcribe instead');
    return res.status(501).json(MIGRATED_RESPONSE);
  }

  /**
   * POST /api/synthesize
   * Deprecated — returns 501 with a pointer to /api/voice/synthesize on the swarm.
   */
  async synthesize(req, res) {
    logger.warn('Deprecated /api/synthesize hit — use swarm /api/voice/synthesize instead');
    return res.status(501).json(MIGRATED_RESPONSE);
  }

  /**
   * GET /api/voices
   * Deprecated — returns 501 with a pointer to /api/voice/voices on the swarm.
   */
  async getVoices(req, res) {
    logger.warn('Deprecated /api/voices hit — use swarm /api/voice/voices instead');
    return res.status(501).json(MIGRATED_RESPONSE);
  }

  /**
   * GET /api/presentations/:id/slides
   * Retired — the Presentron proxy is gone; returns 501 with a pointer at the
   * swarm's in-repo deck engine.
   */
  async getSlides(req, res) {
    logger.warn('Retired /api/presentations/:id/slides hit — Presentron proxy removed; use the swarm presentron tool');
    return res.status(501).json(PRESENTATIONS_RETIRED_RESPONSE);
  }

  /**
   * GET /api/presentations
   * Retired — the Presentron proxy is gone; returns 501 with a pointer at the
   * swarm's in-repo deck engine.
   */
  async listPresentations(req, res) {
    logger.warn('Retired /api/presentations hit — Presentron proxy removed; use the swarm presentron tool');
    return res.status(501).json(PRESENTATIONS_RETIRED_RESPONSE);
  }

  /**
   * GET /api/presentations/:id
   * Retired — the Presentron proxy is gone; returns 501 with a pointer at the
   * swarm's in-repo deck engine.
   */
  async getPresentation(req, res) {
    logger.warn('Retired /api/presentations/:id hit — Presentron proxy removed; use the swarm presentron tool');
    return res.status(501).json(PRESENTATIONS_RETIRED_RESPONSE);
  }
}

module.exports = new VoiceController();
