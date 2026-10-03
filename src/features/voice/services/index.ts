/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel export for voice services
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added VoiceService export for backend routes
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Restricted default voice services barrel to backend-safe exports only
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: export the VoiceService option and result types (the caller each call carries, the rung each answer reports) so the routes type them through the barrel.
 */

export {
  VoiceService,
  type SynthesizeOptions,
  type SynthesizeResult,
  type TranscribeOptions,
  type TranscribeResult,
  type TtsProviderListing,
  type VoiceRung,
  type VoiceServiceDeps,
} from './voice-service';
