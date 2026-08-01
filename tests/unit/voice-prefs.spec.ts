/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | JVV-012 guards over a real express app (registry + pool faked — no live TTS/network/DB). tts-picker-persists-and-honored: a saved provider+voice round-trips through GET /prefs AND changes which provider's synthesize() is CALLED (and with which voiceId) when the body names none — delete the prefs resolution and the default provider answers, going red. unconfigured-provider-not-selectable: POST /prefs for a provider whose getStatus reports configured:false is a 400 provider_not_configured and nothing persists; /providers lists it configured:false with the honest reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';

// ── Fake TTS providers + registry (hoisted so the module mock can reach them) ─
const fixture = vi.hoisted(() => {
  const synthCalls: Array<{ providerId: string; voiceId?: string; text: string }> = [];
  const mkProvider = (id: string, configured: boolean, reason?: string) => ({
    id,
    displayName: id === 'default-tts' ? 'Default TTS' : id === 'fake-tts' ? 'Fake TTS' : 'Locked TTS',
    kind: 'server' as const,
    async getStatus() { return { configured, providerId: id, reason }; },
    async synthesize(req: { text: string; voiceId?: string }) {
      synthCalls.push({ providerId: id, voiceId: req.voiceId, text: req.text });
      return { providerId: id, audio: Buffer.from('audio-bytes'), audioFormat: 'mp3', voiceId: req.voiceId };
    },
    async listVoices() {
      return configured
        ? [{ id: 'v1', displayName: 'Voice One', languageCode: 'en-US' }, { id: 'v2', displayName: 'Voice Two', languageCode: 'en-US' }]
        : [];
    },
  });
  const defaultProvider = mkProvider('default-tts', true);
  const fakeProvider = mkProvider('fake-tts', true);
  const lockedProvider = mkProvider('locked-tts', false, 'GOOGLE_API_KEY env var is empty');
  const registry = {
    list: () => [defaultProvider, fakeProvider, lockedProvider],
    get: (id: string) => [defaultProvider, fakeProvider, lockedProvider].find((p) => p.id === id),
    resolveForApp: () => defaultProvider,
  };
  return { synthCalls, registry };
});

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('@/features/voice-providers', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getTTSProviderRegistry: () => fixture.registry,
    getSTTProviderRegistry: () => ({ get: () => undefined, resolveForApp: () => ({ id: 'browser', kind: 'browser' }) }),
  };
});

import { createVoiceRoutes } from '@/app/routes/voice-routes';

// ── In-memory stand-in for the voice_user_prefs table ────────────────────────
function fakePool() {
  const prefs = new Map<string, { tts_provider: string; tts_voice: string | null }>();
  return {
    prefs,
    async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
      if (sql.includes('INSERT INTO voice_user_prefs')) {
        prefs.set(String(params[0]), { tts_provider: String(params[1]), tts_voice: (params[2] as string | null) ?? null });
        return { rows: [] };
      }
      if (sql.includes('SELECT tts_provider')) {
        const row = prefs.get(String(params[0]));
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('DELETE FROM voice_user_prefs')) {
        prefs.delete(String(params[0]));
        return { rows: [] };
      }
      // Schema bootstrap / validation reads — answer benignly.
      return { rows: [] };
    },
  };
}

function testIdentity() {
  return (req: Request, _res: Response, next: NextFunction) => {
    const sub = req.headers['x-test-sub'];
    if (sub) (req as unknown as { oidc: { user: { sub: string } } }).oidc = { user: { sub: String(sub) } };
    next();
  };
}

let server: Server;
let base: string;
let pool: ReturnType<typeof fakePool>;

beforeEach(async () => {
  fixture.synthCalls.length = 0;
  pool = fakePool();
  const app = express();
  app.use(express.json());
  app.use(testIdentity());
  app.use('/api/voice', createVoiceRoutes({ pool } as never));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('test server did not bind');
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

const AUTH = { 'x-test-sub': 'auth0|voice-user', 'Content-Type': 'application/json' };

async function post(pathname: string, body: unknown, headers: Record<string, string> = AUTH) {
  const res = await fetch(`${base}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}

describe('tts-picker-persists-and-honored', () => {
  it('a saved provider+voice persists per-user and is what synthesize actually CALLS', async () => {
    // Without prefs the DEFAULT provider answers — the baseline the guard distinguishes from.
    const before = await post('/api/voice/synthesize', { text: 'hello' });
    expect(before.status).toBe(200);
    expect(fixture.synthCalls).toEqual([{ providerId: 'default-tts', voiceId: undefined, text: 'hello' }]);

    // Pick fake-tts / v2 and confirm the round-trip.
    const saved = await post('/api/voice/prefs', { providerId: 'fake-tts', voiceId: 'v2' });
    expect(saved.status).toBe(200);
    expect(saved.data.selected).toEqual({ providerId: 'fake-tts', voiceId: 'v2' });
    const read = await (await fetch(`${base}/api/voice/prefs`, { headers: AUTH })).json();
    expect(read.selected).toEqual({ providerId: 'fake-tts', voiceId: 'v2' });

    // A body with NO provider now synthesizes on the SAVED provider with the SAVED voice.
    fixture.synthCalls.length = 0;
    const honored = await post('/api/voice/synthesize', { text: 'read this' });
    expect(honored.status).toBe(200);
    expect(honored.data.data.providerId).toBe('fake-tts');
    expect(fixture.synthCalls).toEqual([{ providerId: 'fake-tts', voiceId: 'v2', text: 'read this' }]);
  });

  it('explicit body values beat the saved preference', async () => {
    await post('/api/voice/prefs', { providerId: 'fake-tts', voiceId: 'v2' });
    fixture.synthCalls.length = 0;
    await post('/api/voice/synthesize', { text: 'explicit wins', providerId: 'default-tts', voice: 'v1' });
    expect(fixture.synthCalls).toEqual([{ providerId: 'default-tts', voiceId: 'v1', text: 'explicit wins' }]);
  });

  it('another user does not inherit the first user\'s voice', async () => {
    await post('/api/voice/prefs', { providerId: 'fake-tts', voiceId: 'v2' });
    fixture.synthCalls.length = 0;
    const other = { 'x-test-sub': 'auth0|someone-else', 'Content-Type': 'application/json' };
    await post('/api/voice/synthesize', { text: 'other user' }, other);
    expect(fixture.synthCalls[0].providerId).toBe('default-tts');
  });

  it('clearing (providerId null) returns to the swarm default', async () => {
    await post('/api/voice/prefs', { providerId: 'fake-tts', voiceId: 'v2' });
    const cleared = await post('/api/voice/prefs', { providerId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.data.selected).toBeNull();
    fixture.synthCalls.length = 0;
    await post('/api/voice/synthesize', { text: 'back to default' });
    expect(fixture.synthCalls[0].providerId).toBe('default-tts');
  });
});

describe('unconfigured-provider-not-selectable', () => {
  it('POST /prefs for an unconfigured provider is a 400 and persists NOTHING', async () => {
    const res = await post('/api/voice/prefs', { providerId: 'locked-tts' });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe('provider_not_configured');
    expect(res.data.message).toMatch(/GOOGLE_API_KEY/);
    expect(pool.prefs.size).toBe(0);
    // And synthesize still runs on the default — the refused choice left no trace.
    fixture.synthCalls.length = 0;
    await post('/api/voice/synthesize', { text: 'still default' });
    expect(fixture.synthCalls[0].providerId).toBe('default-tts');
  });

  it('an unknown provider id is a 404', async () => {
    const res = await post('/api/voice/prefs', { providerId: 'never-heard-of-it' });
    expect(res.status).toBe(404);
    expect(res.data.error).toBe('unknown_provider');
  });

  it('GET /providers reports the unconfigured provider honestly (configured:false + reason), with voices only for configured ones', async () => {
    const res = await fetch(`${base}/api/voice/providers`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.defaultProviderId).toBe('default-tts');
    const locked = body.providers.find((p: { id: string }) => p.id === 'locked-tts');
    expect(locked.configured).toBe(false);
    expect(locked.reason).toMatch(/GOOGLE_API_KEY/);
    expect(locked.voices).toEqual([]);
    const fake = body.providers.find((p: { id: string }) => p.id === 'fake-tts');
    expect(fake.configured).toBe(true);
    expect(fake.voices.map((v: { id: string }) => v.id)).toEqual(['v1', 'v2']);
  });

  it('prefs endpoints are caller-scoped — anonymous is 401', async () => {
    const res = await post('/api/voice/prefs', { providerId: 'fake-tts' }, { 'Content-Type': 'application/json' });
    expect(res.status).toBe(401);
  });
});
