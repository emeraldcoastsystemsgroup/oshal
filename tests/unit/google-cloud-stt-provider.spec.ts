/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added exact Cloud STT V2 regional request, service-account readiness, word-offset parsing, and inline-size contract coverage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Covered provider-error body redaction from surfaced failures.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GOOGLE_CLOUD_STT_MAX_INLINE_AUDIO_BYTES,
  GoogleCloudSTTProvider,
  type GoogleCloudSTTAuth,
} from '../../src/features/voice-providers';
import {
  getGoogleCloudPlatformAccessToken,
  probeGoogleCloudServiceAccount,
} from '../../src/shared/services';

const ORIGINAL_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const ORIGINAL_GCP_PROJECT = process.env.GCP_PROJECT_ID;
const ORIGINAL_LOCATION = process.env.GOOGLE_CLOUD_SPEECH_LOCATION;
const ORIGINAL_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const tempDirectories: string[] = [];

afterEach(() => {
  restoreEnv('GOOGLE_CLOUD_PROJECT', ORIGINAL_PROJECT);
  restoreEnv('GCP_PROJECT_ID', ORIGINAL_GCP_PROJECT);
  restoreEnv('GOOGLE_CLOUD_SPEECH_LOCATION', ORIGINAL_LOCATION);
  restoreEnv('GOOGLE_APPLICATION_CREDENTIALS', ORIGINAL_CREDENTIALS);
  tempDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  vi.unstubAllGlobals();
});

describe('Google Cloud STT V2 provider', () => {
  it('calls the regional V2 recognizer contract and parses word offsets', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ alternatives: [{
        transcript: 'Hello world.', confidence: 0.91,
        words: [
          { word: 'Hello', startOffset: '0.100s', endOffset: '0.450s' },
          { word: 'world', startOffset: '0.500s', endOffset: '0.900s' },
        ],
      }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const auth = readyAuth();
    const signal = new AbortController().signal;
    const provider = new GoogleCloudSTTProvider({
      model: 'chirp_3', defaultLanguageCode: 'en-US',
      projectId: 'speech-project-123', location: 'us',
    }, auth);

    const result = await provider.transcribe({
      audio: Buffer.from('mp3-audio'), mimeType: 'audio/mpeg', enableSegments: true, signal,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, any>;

    expect(url).toBe('https://us-speech.googleapis.com/v2/projects/speech-project-123/locations/us/recognizers/_:recognize');
    expect(init.signal).toBe(signal);
    expect(init.headers).toEqual({ Authorization: 'Bearer cloud-token', 'Content-Type': 'application/json' });
    expect(body).toEqual({
      config: {
        autoDecodingConfig: {}, languageCodes: ['en-US'], model: 'chirp_3',
        features: { enableWordTimeOffsets: true, enableAutomaticPunctuation: true },
      },
      content: Buffer.from('mp3-audio').toString('base64'),
    });
    expect(result).toMatchObject({
      text: 'Hello world.', confidence: 0.91,
      segments: [
        { text: 'Hello', startTime: 0.1, endTime: 0.45 },
        { text: 'world', startTime: 0.5, endTime: 0.9 },
      ],
    });
  });

  it('rejects audio beyond the base64-safe cap before auth or network work', async () => {
    const auth = readyAuth();
    const accessToken = vi.spyOn(auth, 'accessToken');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GoogleCloudSTTProvider({
      model: 'chirp_3', defaultLanguageCode: 'en-US', projectId: 'speech-project', location: 'us',
    }, auth);

    await expect(provider.transcribe({
      audio: Buffer.alloc(GOOGLE_CLOUD_STT_MAX_INLINE_AUDIO_BYTES + 1), mimeType: 'audio/webm',
    })).rejects.toThrow(`exceeds ${GOOGLE_CLOUD_STT_MAX_INLINE_AUDIO_BYTES} bytes`);
    expect(accessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports unconfigured when a V2 billing project is absent', async () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCP_PROJECT_ID;
    const provider = new GoogleCloudSTTProvider({
      model: 'chirp_3', defaultLanguageCode: 'en-US', location: 'us',
    }, readyAuth());

    await expect(provider.getStatus()).resolves.toMatchObject({
      configured: false,
      reason: 'Google Cloud STT V2 requires GOOGLE_CLOUD_PROJECT or GCP_PROJECT_ID',
    });
  });

  it('does not surface an arbitrary remote error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'provider-debug-secret-that-must-not-be-logged', { status: 403 },
    )));
    const provider = new GoogleCloudSTTProvider({
      model: 'chirp_3', defaultLanguageCode: 'en-US', projectId: 'speech-project', location: 'us',
    }, readyAuth());

    const promise = provider.transcribe({ audio: Buffer.from('audio'), mimeType: 'audio/webm' });

    await expect(promise).rejects.toThrow('Google Cloud STT V2 returned HTTP 403');
    await expect(promise).rejects.not.toThrow('provider-debug-secret');
  });

  it('mints a real cloud-platform JWT assertion from the mounted service account', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'oshal-stt-auth-'));
    tempDirectories.push(directory);
    const keyPath = join(directory, 'service-account.json');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(keyPath, JSON.stringify({
      client_email: 'speech-service@speech-project.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'service-account-token', expires_in: 3600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    expect(probeGoogleCloudServiceAccount()).toEqual({ ready: true });
    await expect(getGoogleCloudPlatformAccessToken()).resolves.toBe('service-account-token');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const assertion = new URLSearchParams(String(init.body)).get('assertion') || '';
    const payload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString()) as Record<string, unknown>;

    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(payload.scope).toBe('https://www.googleapis.com/auth/cloud-platform');
    expect(payload.iss).toBe('speech-service@speech-project.iam.gserviceaccount.com');
  });
});

function readyAuth(): GoogleCloudSTTAuth {
  return { probe: () => ({ ready: true }), accessToken: async () => 'cloud-token' };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
