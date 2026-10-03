/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1 guard for the operator route's own branches, over a real express app and the REAL capability adapters (text to speech over a real registry, images and video over their real providers, no credentials, so nothing reaches a network): GET lists all four capabilities with each provider's cost class and availability and the swarm default with its source; an unknown capability, an unknown provider, a voice the provider does not list, a voice on a speech-to-text row and a model are each refused 400 with nothing written; a listed voice is written beside its provider (D9); a table refusal (42501) answers 403; no store answers 503; the speech-to-text try action transcribes through exactly the named provider as the calling operator and refuses a request with no clip; a non-operator is refused on every route. The database boundary itself (the policy, the role, the real snapshot and the end-to-end move of a dictation) is capability-swarm-rows-postgres.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1 (round 2): a service secret is never an operator session. The harness mounts the global request-identity middleware as server.ts does (a valid secret makes the DATABASE identity operator-level, so the route guard is the only wall in front of the operator-only table) and a probe shows that both header forms carry a valid secret and the operator's forwarded subject. GET /, PUT and DELETE /swarm/:capability and POST /stt/:providerId/try each refuse that call (403 operator_session_required) in both forms (x-oshal-user-sub and x-oshal-user-sub-b64) and read or write nothing; the try action also refuses a non-operator session and a request with no session, and transcribes nothing.
 */

import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapabilityProviderRoutes, type CapabilityProviderRouteDeps } from '@/app/routes/capability-provider-routes';
import { getCaller, getTrustedServiceUserSub, hasValidServiceSecret, isOperator } from '@/shared/middleware/authz';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { CAPABILITY_FLEET_SCOPE, type Capability, type CapabilityAdapter, type CapabilitySwarmRow } from '@/shared/capability-providers';
import { STTProviderRegistry, TTSProviderRegistry, createSttCapabilityAdapter, createTtsCapabilityAdapter } from '@/features/voice-providers';
import { createImageCapabilityAdapter, createVideoCapabilityAdapter } from '@/features/video-generation';

const OPERATOR_SUB = 'routes-operator-sub';
const PERSON_SUB = 'routes-person-sub';
/** The service secret this file stubs into SWARM_SERVICE_SECRET, generated per run. */
const SECRET = randomBytes(24).toString('hex');
const VOICE = {
  tts: { default: 'gemini-tts', providers: { browser: {}, 'gemini-tts': { model: 'gemini-2.5-flash-preview-tts', defaultVoice: 'Kore', sampleRateHz: 24000 } } },
  stt: { default: 'gemini-stt', providers: { browser: {}, 'gemini-stt': { model: 'gemini-2.5-flash', defaultLanguageCode: 'en-US', transcribePrompt: 'T.' } } },
};

/** In-memory stand-in for the row store (the real one is proven against Postgres elsewhere). */
const rows = new Map<string, CapabilitySwarmRow>();
let refusal: { code: string } | null = null;
const store: NonNullable<CapabilityProviderRouteDeps['store']> = {
  listAll: async () => [...rows.values()],
  upsert: async (scopeId, capability, providerId, options, updatedBy) => {
    if (refusal) throw Object.assign(new Error('new row violates row-level security policy'), refusal);
    const row = { scopeId, capability, providerId, options, updatedBy, updatedAt: new Date().toISOString() };
    rows.set(`${scopeId}|${capability}`, row);
    return row;
  },
  remove: async (scopeId, capability) => rows.delete(`${scopeId}|${capability}`),
};
const transcribeAudio = vi.fn(async (_audio: Buffer, _mime: string, options?: { providerId?: string }) => ({ providerId: options?.providerId ?? 'none', text: 'the clip said hello', rung: 'app' as const }));

let adapters: Record<Capability, CapabilityAdapter>;
let server: Server;
let base = '';
let withStore = true;

function session(req: Request, _res: Response, next: NextFunction): void {
  const sub = req.headers['x-test-sub'];
  if (typeof sub === 'string') (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => true, user: { sub } };
  next();
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR_SUB);
  vi.stubEnv('SWARM_SERVICE_SECRET', SECRET);
  for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'COMFYUI_URL', 'VERTEX_PROJECT', 'GCP_PROJECT_ID', 'DEMO_MODE', 'STORYBOARD_IMAGE_PROVIDER']) vi.stubEnv(name, '');
  const tts = new TTSProviderRegistry({ tts: VOICE.tts, stt: VOICE.stt });
  const stt = new STTProviderRegistry({ tts: VOICE.tts, stt: VOICE.stt });
  adapters = { tts: createTtsCapabilityAdapter(() => tts), stt: createSttCapabilityAdapter(() => stt), image: createImageCapabilityAdapter(), video: createVideoCapabilityAdapter() };
  const app = express();
  app.use(express.json());
  app.use(session);
  // The global request-identity middleware as server.ts mounts it: a valid service secret makes the
  // DATABASE identity operator-level, so the route's own guard is what refuses a machine caller.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    runWithRequestIdentity({ sub: getCaller(req).sub, isOperator: isOperator(req) || hasValidServiceSecret(req) }, () => next());
  });
  app.get('/probe/service-identity', (req: Request, res: Response) => {
    res.json({ secretValid: hasValidServiceSecret(req), forwardedSub: getTrustedServiceUserSub(req), databaseOperator: getRequestIdentity()?.isOperator === true });
  });
  app.use('/api/capability-providers', createCapabilityProviderRoutes({
    get store() { return withStore ? store : undefined; },
    snapshot: () => null,
    adapters: () => adapters,
    voice: { transcribeAudio } as unknown as CapabilityProviderRouteDeps['voice'],
  } as CapabilityProviderRouteDeps));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => { rows.clear(); refusal = null; withStore = true; transcribeAudio.mockClear(); });
afterEach(() => { refusal = null; });

const call = async (method: string, route: string, body?: unknown, sub: string | null = OPERATOR_SUB) => {
  const res = await fetch(`${base}/api/capability-providers${route}`, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(sub ? { 'x-test-sub': sub } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('the capability provider operator routes (ADR-173 S1)', () => {
  it('GET lists the four capabilities with cost classes, availability and the swarm default\'s source', async () => {
    const res = await call('GET', '/');
    expect(res.status).toBe(200);
    const sections = res.body.capabilities as Array<{ capability: string; providers: Array<Record<string, unknown>>; swarmDefault: Record<string, unknown> }>;
    expect(sections.map((s) => s.capability)).toEqual(['tts', 'stt', 'image', 'video']);
    const tts = sections[0];
    expect(tts.swarmDefault).toMatchObject({ providerId: 'gemini-tts', source: 'global-config.json voice.tts.default', row: null });
    expect(tts.providers.find((p) => p.providerId === 'gemini-tts')).toMatchObject({ costClass: 'swarm-paid', available: false, missing: 'no-credential' });
    expect(tts.providers.find((p) => p.providerId === 'browser')).toMatchObject({ costClass: 'free', available: true });
    expect(sections[2].providers.map((p) => [p.providerId, p.costClass])).toEqual([
      ['codex', 'swarm-paid'], ['comfyui', 'free'], ['vertex', 'user-paid'], ['openrouter', 'swarm-paid'], ['codex-cli', 'free'], ['antigravity-cli', 'free'],
    ]);
    expect(sections[3].swarmDefault).toMatchObject({ providerId: null, reason: expect.stringContaining('No swarm video default') });
  });

  it('refuses a non-operator on every route and a request with no session', async () => {
    expect((await call('GET', '/', undefined, PERSON_SUB)).status).toBe(403);
    expect((await call('PUT', '/swarm/stt', { providerId: 'browser' }, PERSON_SUB)).status).toBe(403);
    expect((await call('DELETE', '/swarm/stt', undefined, PERSON_SUB)).status).toBe(403);
    expect((await call('PUT', '/swarm/stt', { providerId: 'browser' }, null))).toMatchObject({ status: 403, body: { error: 'operator_session_required' } });
    expect(rows.size).toBe(0);
  });

  it.each([
    ['an unknown capability', '/swarm/music', { providerId: 'browser' }, 'unknown capability'],
    ['an unknown provider', '/swarm/tts', { providerId: 'polly' }, 'unknown_provider'],
    ['a voice the provider does not list', '/swarm/tts', { providerId: 'gemini-tts', voice: 'en-US-Chirp3-HD-Kore' }, 'voice_not_listed'],
    ['a voice on a speech-to-text row', '/swarm/stt', { providerId: 'gemini-stt', voice: 'Kore' }, 'voice_not_supported'],
    ['a model (no call reads one yet)', '/swarm/stt', { providerId: 'gemini-stt', model: 'gemini-2.5-pro' }, 'model_not_supported'],
  ])('refuses %s with 400 and writes nothing', async (_label, route, body, marker) => {
    const res = await call('PUT', route, body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(marker);
    expect(rows.size).toBe(0);
  });

  it('writes a listed voice beside its provider (D9) and reports the provider\'s availability', async () => {
    const res = await call('PUT', '/swarm/tts', { providerId: 'gemini-tts', voice: 'Puck' });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ scopeId: CAPABILITY_FLEET_SCOPE, capability: 'tts', providerId: 'gemini-tts', options: { voice: 'Puck' }, updatedBy: OPERATOR_SUB });
    expect(res.body.availability).toMatchObject({ available: false, missing: 'no-credential' });
  });

  it('a refusal by the table itself (42501) answers 403; no store answers 503', async () => {
    refusal = { code: '42501' };
    expect((await call('PUT', '/swarm/stt', { providerId: 'browser' })).status).toBe(403);
    refusal = null;
    withStore = false;
    expect((await call('PUT', '/swarm/stt', { providerId: 'browser' })).status).toBe(503);
    expect((await call('GET', '/')).status).toBe(503);
  });

  it('DELETE removes the row and reports the seed again', async () => {
    await call('PUT', '/swarm/stt', { providerId: 'browser' });
    const res = await call('DELETE', '/swarm/stt');
    expect(res.body).toMatchObject({ removed: true, swarmDefault: { source: 'global-config.json voice.stt.default' } });
  });

  it('the STT try action transcribes through exactly the named provider as the calling operator, and needs a clip', async () => {
    const form = new FormData();
    form.append('audio', new Blob([Buffer.from('RIFF-clip')], { type: 'audio/wav' }), 'clip.wav');
    const res = await fetch(`${base}/api/capability-providers/stt/local-stt/try`, { method: 'POST', headers: { 'x-test-sub': OPERATOR_SUB }, body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, providerId: 'local-stt', text: 'the clip said hello' });
    const options = transcribeAudio.mock.calls[0][2] as { providerId: string; caller: { principal: { kind: string; sub: string } } };
    expect(options.providerId).toBe('local-stt');
    expect(options.caller.principal).toMatchObject({ kind: 'user', sub: OPERATOR_SUB, isOperator: true });
    const empty = await fetch(`${base}/api/capability-providers/stt/local-stt/try`, { method: 'POST', headers: { 'x-test-sub': OPERATOR_SUB }, body: new FormData() });
    expect(empty.status).toBe(400);
  });
});

/** The two ways a service call forwards a subject: the legacy plain header and the canonical base64url one. */
const SERVICE_HEADERS: Array<[string, Record<string, string>]> = [
  ['x-oshal-user-sub', { 'x-service-secret': SECRET, 'x-oshal-user-sub': OPERATOR_SUB }],
  ['x-oshal-user-sub-b64', { 'x-service-secret': SECRET, 'x-oshal-user-sub-b64': Buffer.from(OPERATOR_SUB).toString('base64url') }],
];

/** Send one request with raw headers; 'multipart' sends a one-clip form. */
async function send(method: string, route: string, body: unknown, headers: Record<string, string>) {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body === 'multipart') {
    const form = new FormData();
    form.append('audio', new Blob([Buffer.from('RIFF-clip')], { type: 'audio/wav' }), 'clip.wav');
    init.body = form;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}/api/capability-providers${route}`, init);
  return { status: res.status, text: await res.text() };
}

/** The S1a routes, each with a body that would be accepted from an operator session. */
const S1A_ROUTES: Array<[string, string, unknown]> = [
  ['GET', '/', undefined],
  ['PUT', '/swarm/stt', { providerId: 'browser' }],
  ['DELETE', '/swarm/stt', undefined],
  ['POST', '/stt/browser/try', 'multipart'],
];

describe('a service secret is never an operator session (ADR-173 S1)', () => {
  it.each(SERVICE_HEADERS)('the secret is valid and the database identity is operator-level (%s), so the route guard is the wall', async (_form, headers) => {
    const res = await fetch(`${base}/probe/service-identity`, { headers });
    expect(await res.json()).toEqual({ secretValid: true, forwardedSub: OPERATOR_SUB, databaseOperator: true });
  });

  it.each(S1A_ROUTES)('%s %s refuses a service secret forwarding the operator, in both header forms, and reads or writes nothing', async (method, route, body) => {
    const spies = [vi.spyOn(store, 'listAll'), vi.spyOn(store, 'upsert'), vi.spyOn(store, 'remove')];
    try {
      for (const [, headers] of SERVICE_HEADERS) {
        const res = await send(method, route, body, headers);
        expect(res.status).toBe(403);
        expect(res.text).toContain('operator_session_required');
      }
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
      expect(transcribeAudio).not.toHaveBeenCalled();
      expect(rows.size).toBe(0);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('POST /stt/:providerId/try refuses a non-operator session and a request with no session; nothing is transcribed', async () => {
    const person = await send('POST', '/stt/browser/try', 'multipart', { 'x-test-sub': PERSON_SUB });
    const none = await send('POST', '/stt/browser/try', 'multipart', {});
    expect([person.status, none.status]).toEqual([403, 403]);
    expect(person.text).toContain('Operator privilege required');
    expect(none.text).toContain('operator_session_required');
    expect(transcribeAudio).not.toHaveBeenCalled();
  });
});
