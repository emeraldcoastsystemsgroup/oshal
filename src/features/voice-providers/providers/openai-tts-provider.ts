/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added API-key-only OpenAI natural TTS with the official voice catalog, cinematic instruction control, MP3 output, and one bounded transient retry.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Log unreadable response-body failures without exposing provider content so retry cleanup never swallows diagnostics.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Honor bounded application-specific performance direction while retaining configured instructions as the default.
 */

import { createChildLogger } from '@/shared/logger';
import type {
  TTSProvider,
  TTSSynthesizeRequest,
  TTSSynthesizeResult,
  TTSVoice,
  VoiceProviderStatus,
} from '../types';

const OPENAI_SPEECH_ENDPOINT = 'https://api.openai.com/v1/audio/speech';
const MAX_INPUT_CHARS = 4_096;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 1_000;
const MAX_PERFORMANCE_INSTRUCTIONS = 600;
const logger = createChildLogger({ module: 'openai-tts-provider' });

const OPENAI_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova',
  'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
] as const;
const OPENAI_VOICE_SET = new Set<string>(OPENAI_VOICES);

type OpenAIAudioFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

/** @description Configuration for server-side OpenAI speech synthesis. */
export interface OpenAITTSConfig {
  model: string;
  defaultVoice: string;
  responseFormat: OpenAIAudioFormat;
  instructions: string;
  timeoutMs?: number;
  retryDelayMs?: number;
}

interface OpenAISpeechBody {
  model: string;
  input: string;
  voice: string;
  instructions: string;
  response_format: OpenAIAudioFormat;
  speed?: number;
}

/**
 * @description Natural server-side speech through OpenAI's Audio API. The
 * provider reads only OPENAI_API_KEY and never consults Codex or ChatGPT OAuth.
 */
export class OpenAITTSProvider implements TTSProvider {
  public readonly id = 'openai-tts';
  public readonly displayName = 'OpenAI TTS (GPT-4o mini)';
  public readonly kind = 'server' as const;

  constructor(private readonly config: OpenAITTSConfig) {}

  /** @description Report whether a dedicated OpenAI Platform API key is present. */
  async getStatus(): Promise<VoiceProviderStatus> {
    const configured = Boolean(readApiKey());
    return {
      providerId: this.id,
      configured,
      reason: configured ? undefined : 'OPENAI_API_KEY is required for OpenAI TTS',
    };
  }

  /**
   * @description Generate natural MP3 speech with one retry for rate limits or
   * transient server failures.
   * @param request Framework speech request.
   * @returns OpenAI audio bytes and the selected voice.
   */
  async synthesize(request: TTSSynthesizeRequest): Promise<TTSSynthesizeResult> {
    const apiKey = requireApiKey();
    const body = buildSpeechBody(request, this.config);
    logger.info(
      { chars: request.text.length, voice: body.voice, model: body.model },
      'OpenAI TTS call',
    );
    const response = await requestWithOneRetry(apiKey, body, this.config);
    if (!response.ok) await throwSafeProviderError(response);
    return {
      providerId: this.id,
      audio: Buffer.from(await response.arrayBuffer()),
      audioFormat: mimeTypeFor(this.config.responseFormat),
      voiceId: body.voice,
    };
  }

  /** @description Return the 13 built-in voices supported by GPT-4o mini TTS. */
  async listVoices(): Promise<TTSVoice[]> {
    return OPENAI_VOICES.map((voice) => ({
      id: voice,
      displayName: titleCase(voice),
      languageCode: 'en-US',
      gender: 'UNSPECIFIED',
    }));
  }
}

function readApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY;
  return key && key.trim().length > 0 ? key.trim() : null;
}

function requireApiKey(): string {
  const key = readApiKey();
  if (!key) throw new Error('OPENAI_API_KEY is required for OpenAI TTS');
  return key;
}

function buildSpeechBody(
  request: TTSSynthesizeRequest,
  config: OpenAITTSConfig,
): OpenAISpeechBody {
  validateText(request.text);
  const voice = request.voiceId || config.defaultVoice;
  if (!OPENAI_VOICE_SET.has(voice)) throw new Error(`Unsupported OpenAI TTS voice: ${voice}`);
  const body: OpenAISpeechBody = {
    model: config.model,
    input: request.text,
    voice,
    instructions: performanceInstructions(request, config),
    response_format: config.responseFormat,
  };
  if (request.speakingRate !== undefined) body.speed = validateSpeed(request.speakingRate);
  return body;
}

function performanceInstructions(
  request: TTSSynthesizeRequest,
  config: OpenAITTSConfig,
): string {
  const requested = request.performanceInstructions;
  if (requested === undefined) return config.instructions;
  const trimmed = requested.trim();
  if (!trimmed || trimmed.length > MAX_PERFORMANCE_INSTRUCTIONS) {
    throw new Error(`OpenAI TTS performance instructions must contain 1 to ${MAX_PERFORMANCE_INSTRUCTIONS} characters`);
  }
  return trimmed;
}

function validateText(text: string): void {
  if (!text.trim()) throw new Error('OpenAI TTS input must not be empty');
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error(`OpenAI TTS input exceeds ${MAX_INPUT_CHARS} characters`);
  }
}

function validateSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    throw new Error('OpenAI TTS speaking rate must be between 0.25 and 4');
  }
  return speed;
}

async function requestWithOneRetry(
  apiKey: string,
  body: OpenAISpeechBody,
  config: OpenAITTSConfig,
): Promise<Response> {
  const first = await requestSpeech(apiKey, body, config.timeoutMs);
  if (!shouldRetry(first.status)) return first;
  await discardBody(first);
  await delay(boundedRetryDelay(config.retryDelayMs));
  return requestSpeech(apiKey, body, config.timeoutMs);
}

function requestSpeech(
  apiKey: string,
  body: OpenAISpeechBody,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(OPENAI_SPEECH_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

function boundedRetryDelay(configured?: number): number {
  const delayMs = configured ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isFinite(delayMs)) return DEFAULT_RETRY_DELAY_MS;
  return Math.max(0, Math.min(delayMs, MAX_RETRY_DELAY_MS));
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch (error) {
    logger.error(
      { err: error, status: response.status },
      'OpenAI TTS error response body could not be discarded',
    );
  }
}

async function throwSafeProviderError(response: Response): Promise<never> {
  await discardBody(response);
  logger.error(
    { status: response.status, requestId: response.headers.get('x-request-id') || undefined },
    'OpenAI TTS call failed',
  );
  throw new Error(`OpenAI TTS returned HTTP ${response.status}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mimeTypeFor(format: OpenAIAudioFormat): string {
  const formats: Record<OpenAIAudioFormat, string> = {
    mp3: 'audio/mpeg', opus: 'audio/opus', aac: 'audio/aac',
    flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm',
  };
  return formats[format];
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
