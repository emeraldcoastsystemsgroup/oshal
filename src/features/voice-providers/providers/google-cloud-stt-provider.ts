/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added the initial Google Cloud Speech-to-Text REST provider for common browser audio containers.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Centralized the provider's initial Google authentication boundary.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed unsupported API-key authentication from the initial provider.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Honored caller abort signals so diarization-aligned STT has a bounded remote request lifetime.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Corrected the provider to Chirp 3 V2 Recognize with project/location routing, auto decoding, word offsets, and a base64-safe inline limit.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Removed arbitrary provider-body logging and documented service-account cloud-platform authentication.
 */

import { createChildLogger } from '@/shared/logger';
import {
  getGoogleCloudPlatformAccessToken,
  probeGoogleCloudServiceAccount,
} from '@/shared/services';
import type {
  STTProvider,
  STTSegment,
  STTTranscribeRequest,
  STTTranscribeResult,
  VoiceProviderStatus,
} from '../types';
const logger = createChildLogger({ module: 'google-cloud-stt-provider' });

/** @description Raw-audio ceiling whose base64 JSON remains below Google's 10 MB synchronous request limit. */
export const GOOGLE_CLOUD_STT_MAX_INLINE_AUDIO_BYTES = 7 * 1024 * 1024;

/** @description Per-instance Cloud Speech-to-Text V2 recognition configuration. */
export interface GoogleCloudSTTConfig {
  model: string;
  defaultLanguageCode: string;
  projectId?: string;
  location?: string;
}

/** @description Injectable cloud-platform authentication boundary for deterministic provider tests. */
export interface GoogleCloudSTTAuth {
  probe(): { ready: boolean; reason?: string };
  accessToken(): Promise<string>;
}

const DEFAULT_STT_AUTH: GoogleCloudSTTAuth = {
  probe: probeGoogleCloudServiceAccount,
  accessToken: getGoogleCloudPlatformAccessToken,
};

/** @description Server-side STT provider that calls Google Cloud Speech-to-Text V2. */
export class GoogleCloudSTTProvider implements STTProvider {
  public readonly id = 'google-cloud-stt';
  public readonly displayName = 'Google Cloud Speech-to-Text V2';
  public readonly kind = 'server' as const;

  constructor(
    private readonly config: GoogleCloudSTTConfig,
    private readonly auth: GoogleCloudSTTAuth = DEFAULT_STT_AUTH,
  ) {}

  /**
   * @description Reports ready only when service-account auth plus V2 project/location are configured.
   * @returns Structured provider status with an actionable configuration reason.
   */
  async getStatus(): Promise<VoiceProviderStatus> {
    const probe = this.auth.probe();
    const configurationError = cloudConfigurationError(this.config);
    return {
      configured: probe.ready && !configurationError,
      providerId: this.id,
      reason: probe.ready ? configurationError || undefined : probe.reason,
    };
  }

  /**
   * @description Transcribes short inline audio with Chirp 3 and optional word offsets.
   * @param request - Bounded audio, container MIME, language override, and abort signal.
   * @returns Transcript and timestamped word segments when requested.
   */
  async transcribe(request: STTTranscribeRequest): Promise<STTTranscribeResult> {
    assertInlineSize(request.audio);
    const projectId = resolveProjectId(this.config);
    const location = resolveLocation(this.config);
    const languageCode = request.languageCode || this.config.defaultLanguageCode;
    const body = buildRecognizeBody(request, this.config.model, languageCode);
    const accessToken = await this.auth.accessToken();
    const response = await callRecognize(
      recognizeEndpoint(projectId, location), accessToken, request.signal, body,
    );
    if (!response.ok) await throwCloudFailure(response);
    return buildResult(this.id, await response.json() as CloudSTTResponse, languageCode);
  }
}

interface CloudRecognizeBody {
  config: {
    autoDecodingConfig: Record<string, never>;
    languageCodes: string[];
    model: string;
    features: { enableWordTimeOffsets: boolean; enableAutomaticPunctuation: boolean };
  };
  content: string;
}

interface CloudSTTResponse {
  results?: Array<{
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
      words?: CloudWord[];
    }>;
  }>;
}

interface CloudWord {
  word: string;
  startOffset?: string;
  endOffset?: string;
}

function buildRecognizeBody(
  request: STTTranscribeRequest,
  model: string,
  languageCode: string,
): CloudRecognizeBody {
  return {
    config: {
      autoDecodingConfig: {},
      languageCodes: [languageCode],
      model,
      features: {
        enableWordTimeOffsets: Boolean(request.enableSegments),
        enableAutomaticPunctuation: true,
      },
    },
    content: request.audio.toString('base64'),
  };
}

async function callRecognize(
  endpoint: string,
  accessToken: string,
  signal: AbortSignal | undefined,
  body: CloudRecognizeBody,
): Promise<Response> {
  logger.info(
    { audioBytes: Buffer.byteLength(body.content, 'base64'), model: body.config.model, endpoint },
    'Cloud STT V2 recognize call',
  );
  return fetch(endpoint, {
    method: 'POST', signal,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function throwCloudFailure(response: Response): Promise<never> {
  try {
    await response.body?.cancel();
  } catch {
    logger.warn({ status: response.status }, 'Cloud STT V2 error body cancellation failed');
  }
  logger.error({ status: response.status }, 'Cloud STT V2 call failed');
  throw new Error(`Google Cloud STT V2 returned HTTP ${response.status}`);
}

function buildResult(
  providerId: string,
  json: CloudSTTResponse,
  languageCode: string,
): STTTranscribeResult {
  const segments: STTSegment[] = [];
  const texts: string[] = [];
  let topConfidence: number | undefined;
  for (const result of json.results || []) {
    const alternative = result.alternatives?.[0];
    if (!alternative?.transcript) continue;
    texts.push(alternative.transcript);
    topConfidence ??= alternative.confidence;
    segments.push(...wordsToSegments(alternative.words));
  }
  return {
    providerId, text: texts.join(' ').trim(), confidence: topConfidence,
    segments: segments.length > 0 ? segments : undefined, languageCode,
  };
}

function wordsToSegments(words: CloudWord[] | undefined): STTSegment[] {
  return (words || []).map((word) => ({
    text: word.word,
    startTime: parseDuration(word.startOffset),
    endTime: parseDuration(word.endOffset),
  }));
}

function parseDuration(raw: string | undefined): number {
  if (!raw) return 0;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(raw);
  return match ? parseFloat(match[1]) : 0;
}

function recognizeEndpoint(projectId: string, location: string): string {
  return `https://${location}-speech.googleapis.com/v2/projects/${encodeURIComponent(projectId)}`
    + `/locations/${encodeURIComponent(location)}/recognizers/_:recognize`;
}

function configuredProjectId(config: GoogleCloudSTTConfig): string {
  return String(
    config.projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID || '',
  ).trim();
}

function configuredLocation(config: GoogleCloudSTTConfig): string {
  return String(process.env.GOOGLE_CLOUD_SPEECH_LOCATION || config.location || 'us').trim();
}

function resolveProjectId(config: GoogleCloudSTTConfig): string {
  const value = configuredProjectId(config);
  if (!value) throw new Error('Google Cloud STT V2 requires GOOGLE_CLOUD_PROJECT or GCP_PROJECT_ID');
  return value;
}

function resolveLocation(config: GoogleCloudSTTConfig): string {
  const value = configuredLocation(config);
  if (!/^[a-z0-9-]+$/.test(value)) throw new Error('Google Cloud STT V2 location is invalid');
  return value;
}

function cloudConfigurationError(config: GoogleCloudSTTConfig): string | null {
  if (!configuredProjectId(config)) {
    return 'Google Cloud STT V2 requires GOOGLE_CLOUD_PROJECT or GCP_PROJECT_ID';
  }
  if (!/^[a-z0-9-]+$/.test(configuredLocation(config))) {
    return 'Google Cloud STT V2 location is invalid';
  }
  return null;
}

function assertInlineSize(audio: Buffer): void {
  if (audio.length > GOOGLE_CLOUD_STT_MAX_INLINE_AUDIO_BYTES) {
    throw new Error(
      `Google Cloud STT inline audio exceeds ${GOOGLE_CLOUD_STT_MAX_INLINE_AUDIO_BYTES} bytes`,
    );
  }
}
