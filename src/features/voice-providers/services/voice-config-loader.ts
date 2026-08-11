/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Voice config loader — reads swarm-level defaults from config-seed/global-config.json with a built-in fallback so the framework works even pre-seed
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Declare local-stt in the default STT provider map: the provider class, sidecar, and env wiring all existed, but nothing registered the provider, so VoiceService's failover (and explicit local-stt requests) could never reach the on-host sidecar. Config-less by design — the provider reads SPEAKER_DIARIZATION_URL / SPEAKER_SERVICE_KEY itself and reports unconfigured where the sidecar is absent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import type { SwarmVoiceConfig } from '../types';

const logger = createChildLogger({ module: 'voice-config-loader' });

/**
 * @description Default voice config used when `global-config.json` has no
 * `voice` block yet. Browser is the safe TTS default (no creds needed);
 * Google Cloud STT is the swarm-level STT default because the google-bot
 * already provides the OAuth path. Operators can override per-app.
 */
export const DEFAULT_VOICE_CONFIG: SwarmVoiceConfig = {
  tts: {
    default: 'gemini-tts',
    serverSide: 'gemini-tts',
    providers: {
      browser: {},
      'gemini-tts': {
        model: 'gemini-2.5-flash-preview-tts',
        defaultVoice: 'Kore',
        sampleRateHz: 24000,
      },
      'google-cloud-tts': {
        defaultVoice: 'en-US-Chirp3-HD-Kore',
        defaultLanguageCode: 'en-US',
        audioEncoding: 'MP3',
      },
    },
  },
  stt: {
    default: 'gemini-stt',
    providers: {
      browser: {},
      'gemini-stt': {
        model: 'gemini-2.5-flash',
        defaultLanguageCode: 'en-US',
        transcribePrompt: 'Transcribe this audio verbatim. Return only the transcript, no commentary.',
      },
      'google-cloud-stt': {
        model: 'chirp_3',
        defaultLanguageCode: 'en-US',
        location: 'us',
      },
      // The on-host sherpa-onnx sidecar (URL/key from SPEAKER_DIARIZATION_URL /
      // SPEAKER_SERVICE_KEY env). Declared by default so it is REGISTERED wherever the
      // sidecar runs — without this row the STT failover had no local landing spot while
      // Gemini's free tier was quota-walled and the sidecar sat idle. Unconfigured
      // deployments register it harmlessly: it reports unconfigured and is skipped.
      'local-stt': {},
    },
  },
};

/**
 * @description Resolve the path to `global-config.json`. Honors
 * `OSHAL_GLOBAL_CONFIG_PATH` for tests / containers that mount it elsewhere.
 *
 * @returns Absolute path to the global config JSON.
 */
export function resolveGlobalConfigPath(): string {
  const override = process.env.OSHAL_GLOBAL_CONFIG_PATH;
  if (override && override.length > 0) return override;
  return path.join(process.cwd(), 'config-seed', 'global-config.json');
}

/**
 * @description Load the swarm-level voice config. Merges any `voice` block
 * found in `global-config.json` on top of the built-in defaults, so adding
 * a new provider only requires touching config, not this loader.
 *
 * @returns Fully-populated SwarmVoiceConfig.
 */
export function loadSwarmVoiceConfig(): SwarmVoiceConfig {
  const configPath = resolveGlobalConfigPath();
  if (!fs.existsSync(configPath)) {
    logger.warn({ configPath }, 'global-config.json not found — using built-in voice defaults');
    return DEFAULT_VOICE_CONFIG;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const json = JSON.parse(raw) as { voice?: Partial<SwarmVoiceConfig> };
    return mergeVoiceConfig(DEFAULT_VOICE_CONFIG, json.voice);
  } catch (error) {
    logger.error(
      { err: error, configPath },
      'Failed to read global-config.json — falling back to built-in voice defaults',
    );
    return DEFAULT_VOICE_CONFIG;
  }
}

/**
 * @description Shallow-merge a user-supplied voice block onto the defaults.
 * Per-provider options are merged rather than replaced so a partial override
 * doesn't wipe out the full provider config.
 *
 * @param base Built-in defaults.
 * @param override User-supplied `voice` block from global-config.json.
 * @returns Merged config.
 */
function mergeVoiceConfig(
  base: SwarmVoiceConfig,
  override: Partial<SwarmVoiceConfig> | undefined,
): SwarmVoiceConfig {
  if (!override) return base;
  return {
    tts: {
      default: override.tts?.default || base.tts.default,
      serverSide: override.tts?.serverSide ?? base.tts.serverSide,
      providers: mergeProviderMap(base.tts.providers, override.tts?.providers),
    },
    stt: {
      default: override.stt?.default || base.stt.default,
      providers: mergeProviderMap(base.stt.providers, override.stt?.providers),
    },
  };
}

/**
 * @description Per-provider deep-merge so a partial override (e.g. changing
 * only `defaultVoice` for gemini-tts) keeps the rest of that provider's
 * default config (model, sampleRateHz, etc.) instead of replacing the
 * whole entry. Provider-config is one level deep, so a shallow merge per
 * provider key is the right granularity.
 */
function mergeProviderMap<T extends Record<string, unknown>>(
  base: Record<string, T> | undefined,
  override: Record<string, Partial<T>> | undefined,
): Record<string, T> {
  const baseMap = base ?? {};
  const overrideMap = override ?? {};
  const merged: Record<string, T> = {};
  for (const key of new Set([...Object.keys(baseMap), ...Object.keys(overrideMap)])) {
    merged[key] = { ...(baseMap[key] ?? ({} as T)), ...(overrideMap[key] ?? {}) } as T;
  }
  return merged;
}
