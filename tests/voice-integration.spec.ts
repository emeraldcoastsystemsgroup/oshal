/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Voice API endpoint tests
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Updated for new ApiSuccessResponse/ApiErrorResponse format
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Rewrote for pluggable voice-providers contract — server returns 200 with fallback field for browser/unconfigured cases; validation errors stay at 400
 */

import { test, expect } from '@playwright/test';

test.describe('Voice API Endpoints (voice-providers registry)', () => {
  test.describe('GET /api/voice/voices', () => {
    test('returns success envelope with voices array and source provider id', async ({ request }) => {
      const response = await request.get('/api/voice/voices');
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data.voices)).toBe(true);
      // Source is the resolved provider id. Any registered TTS provider is acceptable here;
      // the point of the assertion is that the registry returned a known id, not a specific one.
      expect(['browser', 'gemini-tts', 'google-cloud-tts']).toContain(body.data.source);
      expect(typeof body.data.providerId).toBe('string');
    });

    test('response carries the standard meta envelope', async ({ request }) => {
      const response = await request.get('/api/voice/voices');
      const body = await response.json();
      expect(body.meta).toBeDefined();
      expect(typeof body.meta.requestId).toBe('string');
      expect(typeof body.meta.durationMs).toBe('number');
      expect(typeof body.meta.timestamp).toBe('string');
    });
  });

  test.describe('POST /api/voice/synthesize', () => {
    test('rejects empty body with VALIDATION_ERROR', async ({ request }) => {
      const response = await request.post('/api/voice/synthesize', { data: {} });
      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('rejects text exceeding 3000 characters', async ({ request }) => {
      const response = await request.post('/api/voice/synthesize', {
        data: { text: 'a'.repeat(3001) },
      });
      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns fallback envelope when provider is browser or unconfigured', async ({ request }) => {
      const response = await request.post('/api/voice/synthesize', {
        data: { text: 'Hello world' },
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.providerId).toBeTruthy();
      // Default swarm config makes tts=browser, so we expect a browser directive.
      // Accept 'unconfigured' too in case an operator swapped the default to a
      // server provider that hasn't completed OAuth yet.
      if (body.data.fallback) {
        expect(['browser', 'unconfigured', 'failed']).toContain(body.data.fallback);
        expect(typeof body.data.message).toBe('string');
      } else {
        // Server provider configured — expect real audio payload.
        expect(typeof body.data.audioData).toBe('string');
        expect(typeof body.data.format).toBe('string');
      }
    });
  });

  test.describe('POST /api/voice/transcribe', () => {
    test('rejects missing audio file with VALIDATION_ERROR', async ({ request }) => {
      const response = await request.post('/api/voice/transcribe');
      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    test('returns fallback envelope when STT provider is browser or unconfigured', async ({ request }) => {
      const response = await request.post('/api/voice/transcribe', {
        multipart: {
          audio: {
            name: 'test.wav',
            mimeType: 'audio/wav',
            buffer: Buffer.from('fake-audio-data'),
          },
        },
      });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.providerId).toBeTruthy();
      // Default swarm config makes stt=google-cloud-stt; without OAuth consent
      // on the google-bot we expect an unconfigured fallback. If consent is
      // completed on the test host, accept a real transcript payload instead.
      if (body.data.fallback) {
        expect(['browser', 'unconfigured', 'failed']).toContain(body.data.fallback);
        expect(typeof body.data.message).toBe('string');
      } else {
        expect(typeof body.data.text).toBe('string');
      }
    });
  });

  test.describe('Voice Route Registration', () => {
    test('voice routes are mounted at /api/voice prefix', async ({ request }) => {
      const voicesResponse = await request.get('/api/voice/voices');
      expect(voicesResponse.status()).toBe(200);

      const transcribeResponse = await request.post('/api/voice/transcribe');
      expect(transcribeResponse.status()).toBe(400);

      const synthesizeResponse = await request.post('/api/voice/synthesize', { data: {} });
      expect(synthesizeResponse.status()).toBe(400);
    });

    test('non-existent voice sub-routes return 404', async ({ request }) => {
      const response = await request.get('/api/voice/nonexistent');
      expect(response.status()).toBe(404);
    });
  });
});
