/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Coverage for the Fire TV surface: auth gates + server wiring (source inspection) and the live pairing→token→one-time-poll lifecycle + view rendering (HTTP, MOCK_OIDC). Guards the security-sensitive signed-token + cookie-auth path.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

// ── Source inspection: auth gates + wiring (no server needed) ───────────────
test.describe('Fire TV — auth gates & wiring', () => {
  test('pairing approve + /tv page are requiresAuth; start/poll are public', () => {
    const src = read('src/app/routes/tv-pairing-routes.ts');
    expect(src).toMatch(/post\(\s*['"]\/api\/tv\/pair\/approve['"]\s*,\s*requiresAuth/);
    expect(src).toMatch(/get\(\s*['"]\/tv['"]\s*,\s*requiresAuth/);
    // start/poll must NOT require auth (the TV isn't signed in yet)
    expect(src).toMatch(/post\(\s*['"]\/api\/tv\/pair\/start['"]\s*,\s*\(/);
    expect(src).toMatch(/post\(\s*['"]\/api\/tv\/pair\/poll['"]\s*,\s*\(/);
  });

  test('jarvis voice views are auth-gated', () => {
    const src = read('src/app/routes/jarvis-voice-routes.ts');
    expect(src).toMatch(/get\(\s*['"]\/api\/jarvis\/tv['"]\s*,\s*requiresAuth/);
    expect(src).toMatch(/get\(\s*['"]\/api\/jarvis\/remote['"]\s*,\s*requiresAuth/);
  });

  test('token uses HMAC + constant-time comparison (no naive string compare)', () => {
    const src = read('src/app/routes/tv-pairing-routes.ts');
    expect(src).toContain('createHmac');
    expect(src).toContain('timingSafeEqual');
  });

  test('tokens are bounded (≤30d) and durably revocable per user', () => {
    const src = read('src/app/routes/tv-pairing-routes.ts');
    // bounded TTL (not the old 90 days)
    expect(src).toMatch(/TOKEN_TTL_SEC\s*=\s*30\s*\*\s*24/);
    expect(src).not.toMatch(/TOKEN_TTL_SEC\s*=\s*90\s*\*/);
    // revoke endpoint is auth-gated + watermark check in the middleware
    expect(src).toMatch(/post\(\s*['"]\/api\/tv\/pair\/revoke['"]\s*,\s*requiresAuth/);
    expect(src).toContain('revocationWatermark');
    expect(src).toContain('tv_token_revocations');
    // server passes the pool in so revocation is durable
    const server = read('src/app/server.ts');
    expect(server).toContain('createTvTokenAuthMiddleware(ctx.pool)');
    expect(server).toContain('createTvPairingRoutes(requiresAuth, ctx.pool)');
  });

  test('server wires the TV-token middleware after authMiddleware and mounts the routes', () => {
    const src = read('src/app/server.ts');
    expect(src).toContain('createTvTokenAuthMiddleware(ctx.pool)');
    expect(src).toContain('createTvPairingRoutes(requiresAuth, ctx.pool)');
    expect(src).toContain('createJarvisVoiceRoutes(requiresAuth)');
    // middleware mounted after the global OIDC authMiddleware so it can override an
    // unauthenticated req.oidc with the paired user
    expect(src.indexOf('app.use(authMiddleware)')).toBeLessThan(src.indexOf('createTvTokenAuthMiddleware(ctx.pool)'));
  });
});

// ── HTTP: pairing lifecycle + view rendering (MOCK_OIDC server) ──────────────
test.describe('Fire TV — pairing lifecycle & views', () => {
  test('pair/start returns a well-formed code + verification URI', async ({ request }) => {
    const res = await request.post('/api/tv/pair/start', { data: {} });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(typeof body.device_code).toBe('string');
    expect(body.device_code.length).toBeGreaterThan(20);
    expect(body.verification_uri).toContain('/tv');
    expect(body.interval).toBeGreaterThan(0);
    expect(body.expires_in).toBeGreaterThan(0);
  });

  test('pair/poll on an unknown device_code reports expired', async ({ request }) => {
    const res = await request.post('/api/tv/pair/poll', { data: { device_code: 'does-not-exist' } });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).status).toBe('expired');
  });

  test('full loop: start → approve → poll yields a signed token bound to the user, one-time', async ({ request }) => {
    const start = await (await request.post('/api/tv/pair/start', { data: {} })).json();

    // pending before approval
    const pending = await (await request.post('/api/tv/pair/poll', { data: { device_code: start.device_code } })).json();
    expect(pending.status).toBe('pending');

    // approve as the (MOCK_OIDC) signed-in user
    const approve = await request.post('/api/tv/pair/approve', { data: { user_code: start.user_code } });
    expect(approve.ok()).toBeTruthy();
    expect((await approve.json()).ok).toBe(true);

    // poll now returns the token
    const approved = await (await request.post('/api/tv/pair/poll', { data: { device_code: start.device_code } })).json();
    expect(approved.status).toBe('approved');
    expect(approved.token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    // the token payload binds a user sub
    const payload = JSON.parse(Buffer.from(approved.token.split('.')[1], 'base64url').toString('utf8'));
    expect(typeof payload.sub).toBe('string');
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // one-time hand-off: the second poll no longer returns the token
    const second = await (await request.post('/api/tv/pair/poll', { data: { device_code: start.device_code } })).json();
    expect(second.status).not.toBe('approved');
  });

  test('approve rejects an invalid/expired code', async ({ request }) => {
    const res = await request.post('/api/tv/pair/approve', { data: { user_code: 'ZZZZ-ZZZZ' } });
    expect(res.status()).toBe(404);
  });

  test('the TV view and phone remote render their surfaces', async ({ request }) => {
    const tv = await request.get('/api/jarvis/tv');
    expect(tv.ok()).toBeTruthy();
    const tvHtml = await tv.text();
    expect(tvHtml).toContain('OSHAL');
    expect(tvHtml).toContain('qrbox'); // scannable QR card
    expect(tvHtml).toContain('id="convo"'); // conversation panel
    expect(tvHtml).toContain('id="tasks"'); // tasks panel (priority)

    const remote = await request.get('/api/jarvis/remote');
    expect(remote.ok()).toBeTruthy();
    const remoteHtml = await remote.text();
    expect(remoteHtml).toContain('Tap'); // push-to-talk button
    expect(remoteHtml).toContain('/api/jarvis/ask');
  });
});
