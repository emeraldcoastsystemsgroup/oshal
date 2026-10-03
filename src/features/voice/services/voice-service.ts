/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Created stub backend VoiceService to unblock server startup
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Replaced stub with registry-backed impl — delegates to TTS/STT provider registries, surfaces browser/unconfigured fallbacks instead of lying about transcription
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | synthesizeSpeech now accepts an optional providerId override for preview-any-provider UX on the voice settings page
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Non-auth provider errors (bad audio, rate-limit, etc.) now return `fallback: 'failed'` in the envelope instead of bubbling to a 500 — the client always gets a structured payload to render
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added safe STT provider override and timestamp-segment request options for deterministic diarization alignment.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | JVV-012 voice picker rails: listTtsProviders() reports every registered provider with its LIVE getStatus (configured true/false + reason — the UI renders unconfigured ones as honest disabled states) and voices for the configured ones; getAvailableVoices() accepts an optional explicit providerId so the picker can enumerate a non-default provider's voices.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Turn-time STT failover: when the DEFAULT-resolved provider fails or is unconfigured mid-call (live 2026-08-11: Gemini free tier quota-walled → every dictation answered "Transcription failed" while the local sherpa sidecar sat idle), walk each remaining server-kind registered provider once and return the first real transcript; nothing answers → the ORIGINAL failure surfaces. An explicitly requested provider is the caller's choice and never switches — same boundary rule as an explicit BYO brain. Guard: tests/unit/voice-stt-failover.spec.ts.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: both directions resolve through the shared capability resolver with the caller's principal (D8): an explicit provider is a required preference (D10), the caller's saved voice choice is rung 3, the swarm default is the operator's row else the seed the config names (D6), and a refusal names the missing piece; every answer reports the rung. Entry 7's registration-order failover is REMOVED (D5): a provider that was available and then fails surfaces its own failure and no other provider is tried, so a free-tier quota wall can no longer become a paid Cloud call. A voice travels only with its own provider and only when that provider lists it (D9). listTtsProviders reports each provider's cost class and availability for the caller from the SAME availability function the resolver asks (D3). A caller that names no principal (store code until S4) resolves as unattributed: the operator-written rungs only, logged.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D10 (round 2): the provider a synthesize request names is a preference again, as before ADR-173: an unregistered or unavailable one falls through to the next rung (the swarm default when the request named a provider), with a warning naming the provider and the reason, instead of refusing the call. Its voice does not travel to the provider that answers (D9).
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1b (D4): a successful server TTS or STT call records its spend through the installed recorder — the accountable bot and the caller from the call's CapabilityCaller, the units (characters, counted as code points, for TTS; audio seconds measured from the clip for STT, else the transcript's last segment), and the unit price from the provider's offer row. A free provider and a failed call record nothing; a recorder failure is logged and never fails the call.
 */

import { createChildLogger } from '@/shared/logger';
import {
  GoogleAuthNotConfiguredError,
  createSttCapabilityAdapter,
  createTtsCapabilityAdapter,
  getSTTProviderRegistry,
  getTTSProviderRegistry,
  measureAudioSeconds,
  type STTProvider,
  type TTSProvider,
  type TTSVoice,
} from '@/features/voice-providers';
import {
  describeCapabilitySwarmDefault,
  installedCapabilityOfferReader,
  installedCapabilitySpendRecorder,
  listCapabilityOptions,
  resolveCapabilityProvider,
  unattributedCapabilityPrincipal,
  type CapabilityAdapter,
  type CapabilityCaller,
  type CapabilityChoice,
  type CapabilityCostClass,
  type CapabilityMissingPiece,
  type CapabilityOfferReader,
  type CapabilityPrincipal,
  type CapabilityResolution,
  type CapabilityResolved,
  type CapabilityRung,
  type CapabilitySpendRecorder,
  type CapabilitySwarmRowReader,
} from '@/shared/capability-providers';

const logger = createChildLogger({ module: 'voice-service' });

/** The rung that answered a voice call, or 'refused' (ADR-173 D1). */
export type VoiceRung = CapabilityRung | 'refused';

/**
 * @description Result returned to HTTP callers for `POST /api/voice/synthesize`.
 * Shape matches `SynthesizeResponseSchema` in voice-schemas.ts — `audioData`
 * is base64-encoded audio, `fallback` signals a non-server path.
 */
export interface SynthesizeResult {
  providerId: string;
  audioData?: string;
  format?: string;
  voiceId?: string;
  fallback?: 'browser' | 'unconfigured' | 'failed';
  message?: string;
  /** The rung that chose the provider, or 'refused' (ADR-173 D1). */
  rung?: VoiceRung;
  /** What is missing when the call was refused. */
  missing?: CapabilityMissingPiece;
}

/**
 * @description Result returned to HTTP callers for `POST /api/voice/transcribe`.
 */
export interface TranscribeResult {
  providerId: string;
  text?: string;
  confidence?: number;
  segments?: Array<{ text: string; startTime: number; endTime: number }>;
  languageCode?: string;
  fallback?: 'browser' | 'unconfigured' | 'failed';
  message?: string;
  /** The rung that chose the provider, or 'refused' (ADR-173 D1). */
  rung?: VoiceRung;
  /** What is missing when the call was refused. */
  missing?: CapabilityMissingPiece;
}

/** @description Optional provider, caller and timestamp controls for server STT callers. */
export interface TranscribeOptions {
  /** A provider the calling code names itself: used when available, refused otherwise, never switched. */
  providerId?: string;
  enableSegments?: boolean;
  signal?: AbortSignal;
  /** Whose call this is, the application and the accountable bot (ADR-173 D8). */
  caller?: CapabilityCaller;
}

/** @description Caller and saved-choice inputs for a synthesis call. */
export interface SynthesizeOptions {
  /** Whose call this is, the application and the accountable bot (ADR-173 D8). */
  caller?: CapabilityCaller;
  /** The caller's saved provider and voice (rung 3; voice_user_prefs until S2). */
  userDefault?: CapabilityChoice | null;
}

/** One TTS provider as the picker shows it. */
export interface TtsProviderListing {
  id: string;
  displayName: string;
  kind: string;
  /** Kept for the JVV-012 picker: the same answer as `available`. */
  configured: boolean;
  reason?: string;
  costClass: CapabilityCostClass | null;
  available: boolean;
  missing: CapabilityMissingPiece | null;
  voices: Array<{ id: string; name: string; gender: string; language: string }>;
}

/** @description Optional collaborators (tests); the defaults are the installed ones. */
export interface VoiceServiceDeps {
  rows?: CapabilitySwarmRowReader;
  /** The offer rows a spend is priced from (default: the installed snapshot). */
  offers?: CapabilityOfferReader;
  /** The spend recorder (default: the one installed at boot; null records nothing). */
  spend?: CapabilitySpendRecorder | null;
}

/**
 * @description The latest segment end a transcript reports, as a fallback measure of its audio.
 * @param segments - The provider's timestamped segments, if any.
 * @returns Seconds, or null.
 */
function lastSegmentEnd(segments: TranscribeResult['segments']): number | null {
  const ends = (segments ?? []).map((segment) => segment.endTime).filter((end) => Number.isFinite(end));
  return ends.length ? Math.max(...ends) : null;
}

/**
 * @description The caller of a legacy entry that named no principal (store code until ADR-173 S4).
 * @param entry - The entry point, for the log line.
 * @returns A caller that resolves the operator-written rungs only.
 */
function legacyCaller(entry: string): CapabilityCaller {
  return { principal: unattributedCapabilityPrincipal(`${entry} was called without a caller`), appId: null, agentId: null };
}

/**
 * @description The fields a refused resolution contributes to a voice result.
 * @param resolution - A refusal.
 * @returns The refusal fields.
 */
function refusalFields(resolution: Extract<CapabilityResolution, { ok: false }>): {
  fallback: 'unconfigured'; message: string; rung: 'refused'; missing: CapabilityMissingPiece;
} {
  return { fallback: 'unconfigured', message: resolution.detail, rung: 'refused', missing: resolution.missing };
}

/**
 * @description Backend voice service — resolves the TTS/STT provider through the shared capability
 * resolver and calls it, translating `GoogleAuthNotConfiguredError` into a `fallback: 'unconfigured'`
 * response so the client can render a remediation hint instead of crashing.
 */
export class VoiceService {
  private readonly ttsRegistry = getTTSProviderRegistry();
  private readonly sttRegistry = getSTTProviderRegistry();
  private readonly ttsAdapter: CapabilityAdapter = createTtsCapabilityAdapter(() => this.ttsRegistry);
  private readonly sttAdapter: CapabilityAdapter = createSttCapabilityAdapter(() => this.sttRegistry);

  constructor(private readonly deps: VoiceServiceDeps = {}) {}

  /**
   * @description Transcribe an uploaded audio buffer with the provider the capability resolver
   * chooses for this caller. Returns a browser directive when that is the browser engine, a
   * refusal naming the missing piece when nothing is available, or the provider's own answer. A
   * provider that fails surfaces its own failure: no other provider is tried (ADR-173 D5).
   *
   * @param buffer Raw audio bytes from the multipart upload.
   * @param mimetype Audio MIME type as reported by the uploader.
   * @param options Optional explicit provider, caller and timestamp-segment controls.
   * @returns Shape consumed by `TranscribeResponseSchema`, with the rung that answered.
   */
  async transcribeAudio(
    buffer: Buffer,
    mimetype: string,
    options: TranscribeOptions = {},
  ): Promise<TranscribeResult> {
    const caller = options.caller ?? legacyCaller('VoiceService.transcribeAudio');
    const resolution = await resolveCapabilityProvider(this.sttAdapter, {
      capability: 'stt', ...caller,
      explicit: options.providerId ? { providerId: options.providerId } : null,
    }, { rows: this.deps.rows });
    if (!resolution.ok) return { providerId: options.providerId || 'unavailable', ...refusalFields(resolution) };
    const provider = this.sttRegistry.get(resolution.providerId);
    if (!provider) {
      logger.error({ providerId: resolution.providerId }, 'Resolved STT provider vanished from the registry');
      return { providerId: resolution.providerId, fallback: 'unconfigured', message: 'Resolved STT provider is not registered', rung: 'refused', missing: 'not-registered' };
    }
    logger.info(
      { providerId: provider.id, kind: provider.kind, rung: resolution.rung, bytes: buffer.length, mimetype },
      'transcribeAudio resolved provider',
    );
    if (provider.kind === 'browser') {
      return { providerId: provider.id, fallback: 'browser', message: 'Browser STT selected — use Web Speech API on the client', rung: resolution.rung };
    }
    const started = Date.now();
    const result = await this.runServerSTT(provider, buffer, mimetype, options.enableSegments === true, options.signal);
    if (!result.fallback) {
      // ADR-173 D4: the call's audio seconds, measured from the clip itself (else the transcript's last segment).
      await this.recordSpend(resolution, caller, measureAudioSeconds(buffer, mimetype) ?? lastSegmentEnd(result.segments), Date.now() - started);
    }
    return { ...result, rung: resolution.rung };
  }

  /**
   * @description Record one TTS or STT call's spend (ADR-173 D4) through the installed recorder: the
   * accountable bot, the caller, the call's units and the offer row's unit price. A free provider
   * records nothing; the recorder never fails the call.
   * @param resolution The resolution that chose the provider.
   * @param caller Whose call it was.
   * @param units Characters (TTS) or audio seconds (STT); null when not measurable.
   * @param durationMs How long the vendor call took.
   * @returns Resolves once recorded or the failure is logged.
   */
  private async recordSpend(resolution: CapabilityResolved, caller: CapabilityCaller, units: number | null, durationMs: number): Promise<void> {
    if (resolution.costClass === 'free') return;
    const recorder = this.deps.spend === undefined ? installedCapabilitySpendRecorder() : this.deps.spend;
    if (!recorder) return;
    const offer = (this.deps.offers ?? installedCapabilityOfferReader()).offerFor(resolution.capability, resolution.providerId);
    try {
      await recorder({
        capability: resolution.capability, providerId: resolution.providerId, costClass: resolution.costClass, units,
        unitPriceUsd: offer?.unitPriceUsd ?? null, principal: caller.principal, agentId: caller.agentId, appId: caller.appId,
        model: resolution.model, durationMs,
      });
    } catch (err) {
      logger.error({ err, capability: resolution.capability, providerId: resolution.providerId }, 'Voice spend recording failed — the call itself is unaffected');
    }
  }

  /**
   * @description Call a server-side STT provider and translate configuration
   * errors into a structured `fallback` payload rather than an exception.
   *
   * @param provider Resolved server-kind STT provider.
   * @param buffer Audio bytes.
   * @param mimetype MIME type for encoding resolution.
   * @param enableSegments Whether timestamp-capable providers should return segments.
   * @param signal Optional abort signal for a bounded remote transcription call.
   * @returns Transcription result or unconfigured fallback.
   */
  private async runServerSTT(
    provider: STTProvider,
    buffer: Buffer,
    mimetype: string,
    enableSegments: boolean,
    signal?: AbortSignal,
  ): Promise<TranscribeResult> {
    try {
      const result = await provider.transcribe({ audio: buffer, mimeType: mimetype, enableSegments, signal });
      return {
        providerId: result.providerId,
        text: result.text,
        confidence: result.confidence,
        segments: result.segments,
        languageCode: result.languageCode,
      };
    } catch (error) {
      if (error instanceof GoogleAuthNotConfiguredError) {
        logger.warn({ providerId: provider.id, reason: error.reason }, 'STT unconfigured');
        return {
          providerId: provider.id,
          fallback: 'unconfigured',
          message: error.reason,
        };
      }
      logger.error({ err: error, providerId: provider.id }, 'STT call failed — surfacing its own failure (ADR-173 D5: no failover)');
      return {
        providerId: provider.id,
        fallback: 'failed',
        message: (error as Error).message,
      };
    }
  }

  /**
   * @description Synthesize text into audio (or a browser directive) with the provider the
   * capability resolver chooses: the provider the request names when it is available, else the
   * caller's saved choice, else the swarm default. The voice sent is always one the chosen provider
   * lists (ADR-173 D9).
   *
   * @param text Text to synthesize.
   * @param voice Optional voice id; with `providerId` it is that provider's voice, without it a hint
   *   used only by a provider that lists it.
   * @param providerId Optional provider the request names (e.g. "gemini-tts"): a preference (ADR-173 D10's
   *   default), used when available; when it is not registered or not available the next rung answers and a
   *   warning names it and the reason.
   * @param options The caller (ADR-173 D8) and the caller's saved choice.
   * @returns Shape consumed by `SynthesizeResponseSchema`, with the rung that answered.
   */
  async synthesizeSpeech(
    text: string,
    voice?: string,
    providerId?: string,
    options: SynthesizeOptions = {},
  ): Promise<SynthesizeResult> {
    const caller = options.caller ?? legacyCaller('VoiceService.synthesizeSpeech');
    const resolution = await resolveCapabilityProvider(this.ttsAdapter, {
      capability: 'tts', ...caller,
      // The request's provider is a preference (D10's default): when it is not registered or not
      // available the next rung answers, as this route did before ADR-173, and its voice stays with it (D9).
      requested: providerId ? { providerId, voice: voice ?? null } : null,
      userDefault: options.userDefault ?? null,
      voiceHint: providerId ? null : voice ?? null,
    }, { rows: this.deps.rows });
    if (!resolution.ok) return { providerId: providerId || 'unavailable', ...refusalFields(resolution) };
    const provider = this.ttsRegistry.get(resolution.providerId);
    if (!provider) {
      logger.error({ providerId: resolution.providerId }, 'Resolved TTS provider vanished from the registry');
      return { providerId: resolution.providerId, fallback: 'unconfigured', message: 'Resolved TTS provider is not registered', rung: 'refused', missing: 'not-registered' };
    }
    const voiceId = resolution.voice ?? undefined;
    logger.info({ providerId: provider.id, kind: provider.kind, rung: resolution.rung, chars: text.length, voice: voiceId },
      'synthesizeSpeech resolved provider');
    if (provider.kind === 'browser') {
      return { providerId: provider.id, fallback: 'browser', message: 'Browser TTS selected — use speechSynthesis on the client', voiceId, rung: resolution.rung };
    }
    const started = Date.now();
    const result = await this.runServerTTS(provider, text, voiceId);
    // ADR-173 D4: the call's characters, counted as code points (an emoji is one character, not two).
    if (!result.fallback) await this.recordSpend(resolution, caller, Array.from(text).length, Date.now() - started);
    return { ...result, rung: resolution.rung };
  }

  /**
   * @description Call a server-side TTS provider and base64-encode the audio
   * bytes for JSON transport. Translates configuration errors to a fallback.
   *
   * @param provider Resolved server-kind TTS provider.
   * @param text Text to synthesize.
   * @param voice Optional voice override (always one the provider lists).
   * @returns Synthesis result with base64 audio or unconfigured fallback.
   */
  private async runServerTTS(
    provider: TTSProvider,
    text: string,
    voice: string | undefined,
  ): Promise<SynthesizeResult> {
    try {
      const result = await provider.synthesize({ text, voiceId: voice });
      return {
        providerId: result.providerId,
        audioData: result.audio ? result.audio.toString('base64') : undefined,
        format: result.audioFormat,
        voiceId: result.voiceId,
      };
    } catch (error) {
      if (error instanceof GoogleAuthNotConfiguredError) {
        logger.warn({ providerId: provider.id, reason: error.reason }, 'TTS unconfigured');
        return {
          providerId: provider.id,
          fallback: 'unconfigured',
          message: error.reason,
        };
      }
      logger.error({ err: error, providerId: provider.id }, 'TTS call failed');
      return {
        providerId: provider.id,
        fallback: 'failed',
        message: (error as Error).message,
      };
    }
  }

  /**
   * @description The provider a no-provider voice listing describes: the swarm default (the
   * operator's row, else the seed), falling back to the registry's own default when it names none.
   * @returns The provider.
   */
  private async swarmDefaultTtsProvider(): Promise<TTSProvider> {
    const view = await describeCapabilitySwarmDefault(this.ttsAdapter, this.deps.rows);
    return (view.providerId && this.ttsRegistry.get(view.providerId)) || this.ttsRegistry.resolveForApp();
  }

  /**
   * @description List voices exposed by a TTS provider (the swarm default when none is named).
   * Browser providers return an empty list because voices are enumerated client-side
   * via `speechSynthesis.getVoices()` — callers detect the browser case via the `source` field.
   *
   * @param providerId Optional explicit provider to list.
   * @returns Envelope matching GetVoicesResponseSchema (`voices` + `source`).
   */
  async getAvailableVoices(providerId?: string): Promise<{
    voices: Array<{ id: string; name: string; gender: string; language: string }>;
    source: string;
    providerId: string;
  }> {
    const provider = (providerId && this.ttsRegistry.get(providerId)) || await this.swarmDefaultTtsProvider();
    const voices = await this.safeListVoices(provider);
    return {
      voices: voices.map((v) => ({
        id: v.id,
        name: v.displayName,
        gender: v.gender || 'UNSPECIFIED',
        language: v.languageCode,
      })),
      source: provider.id,
      providerId: provider.id,
    };
  }

  /**
   * @description Every registered TTS provider with its cost class and its availability FOR THIS
   * CALLER, from the same availability function the resolver asks (ADR-173 D3): available providers
   * include their voices (bounded); unavailable ones carry the missing piece so the UI renders an
   * honest disabled state. Provider secrets never leave this layer.
   *
   * @param principal The caller (an unattributed principal when the route has none).
   * @returns Providers (registration order), the swarm default and its source.
   */
  async listTtsProviders(principal: CapabilityPrincipal = unattributedCapabilityPrincipal('listTtsProviders without a caller')): Promise<{
    defaultProviderId: string;
    swarmDefault: { providerId: string | null; voice: string | null; source: string };
    providers: TtsProviderListing[];
  }> {
    const view = await describeCapabilitySwarmDefault(this.ttsAdapter, this.deps.rows);
    const options = await listCapabilityOptions(this.ttsAdapter, principal);
    const providers: TtsProviderListing[] = [];
    for (const option of options) {
      const provider = this.ttsRegistry.get(option.providerId);
      const voices = option.available && provider ? (await this.safeListVoices(provider)).slice(0, 400) : [];
      providers.push({
        id: option.providerId, displayName: option.displayName, kind: provider?.kind ?? 'server',
        configured: option.available, ...(option.detail ? { reason: option.detail } : {}),
        costClass: option.costClass, available: option.available, missing: option.missing,
        voices: voices.map((v) => ({ id: v.id, name: v.displayName, gender: v.gender || 'UNSPECIFIED', language: v.languageCode })),
      });
    }
    return {
      defaultProviderId: view.providerId ?? this.ttsRegistry.resolveForApp().id,
      swarmDefault: { providerId: view.providerId, voice: view.voice, source: view.source },
      providers,
    };
  }

  /**
   * @description List voices while treating auth errors as "empty list" —
   * the voices endpoint is used by UI dropdowns and should never crash when
   * OAuth hasn't been completed.
   *
   * @param provider Resolved TTS provider.
   * @returns Voice list, or empty when unconfigured.
   */
  private async safeListVoices(provider: TTSProvider): Promise<TTSVoice[]> {
    try {
      return await provider.listVoices();
    } catch (error) {
      if (error instanceof GoogleAuthNotConfiguredError) {
        logger.warn({ providerId: provider.id, reason: error.reason }, 'listVoices unconfigured');
        return [];
      }
      logger.error({ err: error, providerId: provider.id }, 'listVoices failed');
      return [];
    }
  }
}
