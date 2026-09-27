/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for the operator Discord setup (operator directive 2026-09-27: "one click to a user"). The shipped /api/channels router is served over loopback HTTP with the REAL requiresOperator gate reading the REAL isOperator allowlist; the settings row lives in disposable PostgreSQL as the NOSUPERUSER NOBYPASSRLS runtime role under migration 171's forced operator-only RLS; the token is validated against a local HTTP server speaking Discord's two reads; the Gateway is the shipped client dialling a local WebSocket server that answers HELLO, records IDENTIFY and sends READY (or closes 4014). Covers: anonymous 401 / non-operator 403 / operator 200 on every admin verb; a rejected token stores nothing and starts nothing; a saved token is encrypted at rest under the connector-token cipher, starts the Gateway with exactly that token, and is absent from every response and from the api log file; a non-operator connection sees no settings row; the per-user surface and the link mint read the bot's name and DM link from the saved state; disconnect stops the Gateway, forgets the token and answers the mint 503; the boot precedence (a disabled row beats the env seed; a saved row restarts the Gateway without asking Discord again); a 4014 close after save surfaces intent_missing; and the Test Lab operator-setup step.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import WebSocket, { WebSocketServer } from 'ws';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { CHANNEL_RLS_TABLES, prepareChannelSchema } from '../helpers/chat-channel-postgres';
import { createChildLogger } from '@/shared/logger';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { isOperator } from '@/shared/middleware/authz';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '@/app/composition/app-context';
import { createChatChannelRoutes } from '@/app/routes/chat-channel-routes';
import { CHANNEL_SCENARIOS } from '@/app/routes/test-lab-channel-scenarios';

/** The api log this process writes; the token must never appear in it. Named before the logger loads. */
const LOG_NAME = vi.hoisted(() => { process.env.SERVICE_NAME = 'chat-channel-admin-spec'; return 'chat-channel-admin-spec'; });

const ROLE = 'oshal_app';
const OPERATOR = 'auth0|setup-operator';
const USER = 'auth0|setup-user';
const ISSUER = 'https://identity.oshal.example.com';
const TOKEN = 'fixture-bot-token.aaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // obviously fake; never a real credential
const SECOND_TOKEN = 'fixture-bot-token.cccccc.dddddddddddddddddddddddddddddd';
const BAD_TOKEN = 'fixture-bad-token.eeeeee.ffffffffffffffffffffffffffffff';
const BOT_ID = '123456789012345678';
const APP_ID = '223456789012345678';

const fixture = new DisposablePostgres({ purpose: 'chat-channel-admin', roles: [ROLE], migrations: ['155-refusal-ledger.sql'] });
const logger = createChildLogger({ module: 'chat-channel-admin-spec' });

let admin: Pool;
let runtime: Pool;
let discordApi: Server;
let discordApiCalls = 0;
let gateway: WebSocketServer;
let gatewayUrl = '';
/** Every IDENTIFY the local Gateway received, in order (the token the shipped client sent). */
const identifies: string[] = [];
/** Server-side close notifications, so "stop" is observed at the protocol, not inferred. */
let gatewayCloses = 0;
/** When set, the local Gateway closes with this code after IDENTIFY instead of sending READY. */
let closeAfterIdentify: number | null = null;
const servers: Server[] = [];
const bases: string[] = [];

async function waitFor(done: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A signed-in cookie session entered exactly as the app's middleware enters it (real isOperator). */
const cookieIdentity: RequestHandler = (req, _res, next) => {
  const sub = /(?:^|;\s*)test-user=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!sub) { next(); return; }
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub }, idTokenClaims: { sub, iss: ISSUER } } });
  runWithRequestIdentity({ sub, principalIssuer: getAuthenticatedPrincipalIssuer(req), isOperator: isOperator(req) }, () => next());
};
const requiresAuth: RequestHandler = (req, res, next) => {
  if (!(req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
};

/** Serve a fresh shipped router (a new boot) and return its base URL. */
async function serveRouter(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(cookieIdentity);
  app.use('/api/channels', createChatChannelRoutes({ pool: runtime } as unknown as AppContext, requiresAuth, {
    dispatch: async () => 'unused',
    telegram: { send: async () => undefined },
    discord: {
      send: async () => undefined,
      gateway: { socketFactory: () => new WebSocket(gatewayUrl) as never, reconnectDelayMs: 60_000 },
      identity: { apiBase: `http://127.0.0.1:${(discordApi.address() as AddressInfo).port}`, timeoutMs: 5_000 },
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  bases.push(base);
  return base;
}

async function call(base: string, method: string, path: string, as: string | null, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(as ? { cookie: `test-user=${as}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {}, text };
}

async function settingsRows(): Promise<Array<{ provider: string; enabled: boolean; secret_ciphertext: string | null; metadata: Record<string, unknown> }>> {
  return (await admin.query('SELECT provider, enabled, secret_ciphertext, metadata FROM channel_provider_settings')).rows;
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_DB_GUC_STRICT', 'deny');
  vi.stubEnv('SESSION_SECRET', 'fixture-session-secret-for-the-channel-cipher');
  vi.stubEnv('OSHAL_OPERATOR_SUBS', OPERATOR);
  vi.stubEnv('DISCORD_BOT_TOKEN', '');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  admin = await fixture.start();
  const prepared = await prepareChannelSchema(fixture, ROLE);
  expect(prepared.forcedTables).toEqual([...CHANNEL_RLS_TABLES]);
  expect(prepared.roleFlags).toEqual({ rolsuper: false, rolbypassrls: false });
  runtime = prepared.runtime;
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only');

  const api = express();
  api.use((_req, _res, next) => { discordApiCalls += 1; next(); });
  api.get('/users/@me', (req, res) => {
    const auth = req.header('authorization');
    if (auth === `Bot ${TOKEN}` || auth === `Bot ${SECOND_TOKEN}`) { res.json({ id: BOT_ID, username: 'oshal-fixture-bot', bot: true }); return; }
    res.status(401).json({ message: '401: Unauthorized', code: 0 });
  });
  api.get('/oauth2/applications/@me', (_req, res) => { res.json({ id: APP_ID, name: 'oshal fixture app', flags: 1 << 19 }); });
  discordApi = api.listen(0, '127.0.0.1');
  await new Promise((r) => discordApi.once('listening', r));

  gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => gateway.once('listening', r));
  gateway.on('connection', (socket) => {
    socket.on('close', () => { gatewayCloses += 1; });
    socket.on('message', (raw) => {
      const packet = JSON.parse(String(raw)) as { op?: number; d?: { token?: string } };
      if (packet.op !== 2) return;
      identifies.push(String(packet.d?.token));
      if (closeAfterIdentify !== null) { socket.close(closeAfterIdentify, 'Disallowed intent(s).'); return; }
      socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { user: { id: BOT_ID, username: 'oshal-fixture-bot' } } }));
    });
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
  });
  gatewayUrl = `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  // Every router validates its schema on construction, detached (the shipped `void ensureSchema()`).
  // A router served late in the run may still be validating when the fixture pool is ended, so drain
  // each one with a read that awaits the same validation before the pool goes away.
  for (const base of bases) await call(base, 'GET', '/api/channels', USER);
  await new Promise((r) => setTimeout(r, 300));
  vi.unstubAllEnvs();
  for (const server of servers) await new Promise((r) => server.close(r));
  for (const client of gateway?.clients ?? []) client.terminate();
  if (gateway) await new Promise((r) => gateway.close(r));
  if (discordApi) await new Promise((r) => discordApi.close(r));
  await fixture.stop();
}, 120_000);

describe('operator Discord setup over the shipped router, real Postgres and a local Discord', () => {
  let base = '';

  it('gates every admin verb: anonymous 401, non-operator 403, operator 200', async () => {
    base = await serveRouter();
    for (const [method, body] of [['GET'], ['POST', { token: TOKEN }], ['DELETE']] as Array<[string, unknown?]>) {
      expect((await call(base, method, '/api/channels/admin/discord', null, body)).status, `${method} anonymous`).toBe(401);
      expect((await call(base, method, '/api/channels/admin/discord', USER, body)).status, `${method} non-operator`).toBe(403);
    }
    const state = await call(base, 'GET', '/api/channels/admin/discord', OPERATOR);
    expect(state.status).toBe(200);
    expect(state.json).toMatchObject({ configured: false, source: null, bot: null, inviteUrl: null, dmUrl: null, connection: { state: 'stopped', running: false } });
    expect(identifies).toEqual([]);
    expect(await settingsRows()).toEqual([]);
  });

  it('refuses a rejected or malformed token before anything is stored or started', async () => {
    const rejected = await call(base, 'POST', '/api/channels/admin/discord', OPERATOR, { token: BAD_TOKEN });
    expect(rejected.status).toBe(422);
    expect(rejected.json).toMatchObject({ error: 'token_invalid' });
    expect(rejected.text).not.toContain(BAD_TOKEN);
    expect((await call(base, 'POST', '/api/channels/admin/discord', OPERATOR, { token: 'short' })).json).toMatchObject({ error: 'token_malformed' });
    expect((await call(base, 'POST', '/api/channels/admin/discord', OPERATOR, {})).json).toMatchObject({ error: 'token_required' });
    expect(await settingsRows()).toEqual([]);
    expect(identifies).toEqual([]);
    expect((await call(base, 'POST', '/api/channels/discord/link', USER)).status).toBe(503);
  });

  it('saves a valid token encrypted, starts the Gateway with it, and never echoes it', async () => {
    const saved = await call(base, 'POST', '/api/channels/admin/discord', OPERATOR, { token: TOKEN });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({
      configured: true, source: 'database', messageContentIntent: true,
      bot: { userId: BOT_ID, username: 'oshal-fixture-bot', applicationId: APP_ID, applicationName: 'oshal fixture app' },
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${APP_ID}&permissions=2048&scope=bot`,
      dmUrl: `https://discord.com/users/${BOT_ID}`,
      connection: { state: 'connected', running: true, problem: null, source: 'database' },
    });
    expect(saved.text).not.toContain(TOKEN);
    expect(identifies).toEqual([TOKEN]);
    const rows = await settingsRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'discord', enabled: true, metadata: { botUserId: BOT_ID, applicationId: APP_ID, messageContentIntent: true } });
    expect(rows[0].secret_ciphertext).toMatch(/^k2:/);
    expect(rows[0].secret_ciphertext).not.toContain(TOKEN);
    const readback = await call(base, 'GET', '/api/channels/admin/discord', OPERATOR);
    expect(readback.json).toMatchObject({ configured: true, bot: { username: 'oshal-fixture-bot' }, connection: { state: 'connected' } });
    expect(readback.text).not.toContain(TOKEN);
  });

  it('a non-operator connection sees no settings row under forced RLS; the operator sees it', async () => {
    const asUser = await runWithRequestIdentity({ sub: USER, isOperator: false }, () => runtime.query('SELECT provider FROM channel_provider_settings'));
    expect(asUser.rows).toEqual([]);
    const asOperator = await runWithRequestIdentity({ sub: OPERATOR, isOperator: true }, () => runtime.query('SELECT provider FROM channel_provider_settings'));
    expect(asOperator.rows).toEqual([{ provider: 'discord' }]);
  });

  it('the per-user surface and the link mint read the bot name and DM link from the saved state', async () => {
    const channels = await call(base, 'GET', '/api/channels', USER);
    expect(channels.status).toBe(200);
    expect(channels.json.discord).toEqual({ configured: true, connected: true, problem: null, bot: { userId: BOT_ID, username: 'oshal-fixture-bot' }, dmUrl: `https://discord.com/users/${BOT_ID}` });
    expect(channels.text).not.toContain(TOKEN);
    const mint = await call(base, 'POST', '/api/channels/discord/link', USER);
    expect(mint.status).toBe(200);
    const code = String(mint.json.code);
    expect(code).toMatch(/^[0-9a-f]{8}$/);
    expect(mint.json).toMatchObject({ send: `LINK ${code}`, expiresInMinutes: 15, botUsername: 'oshal-fixture-bot', botUserId: BOT_ID, dmUrl: `https://discord.com/users/${BOT_ID}` });
    expect(mint.text).not.toContain(TOKEN);
  });

  it('the token never reaches the api log file', async () => {
    const logFile = resolve(process.cwd(), 'output', 'logs', `${LOG_NAME}.log`);
    const marker = `spec-marker-${Date.now()}`;
    logger.info({ marker }, 'chat-channel-admin-spec marker');
    await waitFor(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes(marker), 'the log marker to be flushed', 15_000);
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('channel provider settings saved');
    expect(log).toContain('starting the Discord Gateway listener');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(BAD_TOKEN);
  });

  it('disconnect stops the Gateway, forgets the token, and the mint answers 503 again', async () => {
    const closesBefore = gatewayCloses;
    const off = await call(base, 'DELETE', '/api/channels/admin/discord', OPERATOR);
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ configured: false, source: null, bot: null, connection: { running: false } });
    await waitFor(() => gatewayCloses === closesBefore + 1, 'the Gateway socket to close');
    const rows = await settingsRows();
    expect(rows).toEqual([expect.objectContaining({ provider: 'discord', enabled: false, secret_ciphertext: null, metadata: {} })]);
    expect((await call(base, 'POST', '/api/channels/discord/link', USER)).json).toMatchObject({ error: 'discord_not_configured' });
    expect((await call(base, 'GET', '/api/channels', USER)).json.discord).toMatchObject({ configured: false, bot: null });
  });

  it('boot precedence: a disabled row beats the env seed; a saved row restarts the Gateway without asking Discord again', async () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', SECOND_TOKEN);
    const seeded = await serveRouter();
    // The admin read waits for the boot precedence, so this is the boot's answer, not a blank.
    expect((await call(seeded, 'GET', '/api/channels/admin/discord', OPERATOR)).json).toMatchObject({ configured: false });
    expect(identifies).toEqual([TOKEN]);
    vi.stubEnv('DISCORD_BOT_TOKEN', '');

    const identifiesBefore = identifies.length;
    expect((await call(seeded, 'POST', '/api/channels/admin/discord', OPERATOR, { token: SECOND_TOKEN })).status).toBe(200);
    expect(identifies).toEqual([TOKEN, SECOND_TOKEN]);
    const apiCallsBefore = discordApiCalls;
    const rebooted = await serveRouter();
    await waitFor(() => identifies.length === identifiesBefore + 2, 'the rebooted router to IDENTIFY from the saved row');
    expect(identifies.at(-1)).toBe(SECOND_TOKEN);
    const state = await call(rebooted, 'GET', '/api/channels/admin/discord', OPERATOR);
    expect(state.json).toMatchObject({ configured: true, source: 'database', bot: { username: 'oshal-fixture-bot', applicationId: APP_ID }, inviteUrl: expect.stringContaining(APP_ID) });
    expect(discordApiCalls).toBe(apiCallsBefore);
    expect(state.text).not.toContain(SECOND_TOKEN);
  });

  it('a Gateway that closes 4014 after the save surfaces intent_missing, and the user card is told', async () => {
    closeAfterIdentify = 4014;
    try {
      const saved = await call(base, 'POST', '/api/channels/admin/discord', OPERATOR, { token: TOKEN });
      expect(saved.status).toBe(200);
      expect(saved.json).toMatchObject({ configured: true, connection: { state: 'offline', problem: 'intent_missing', lastCloseCode: 4014 } });
      expect((await call(base, 'GET', '/api/channels', USER)).json.discord).toMatchObject({ configured: true, connected: false, problem: 'intent_missing' });
    } finally {
      closeAfterIdentify = null;
    }
  });

  it('the Test Lab operator-setup step degrades for no session and a non-operator, and reports the named problem for an operator', async () => {
    const card = CHANNEL_SCENARIOS.find((s) => s.id === 'channel-operator-setup');
    expect(card?.steps.map((s) => s.id)).toEqual(['discord-setup']);
    const step = card!.steps[0];
    const priorPort = process.env.PORT;
    process.env.PORT = new URL(base).port;
    try {
      expect(await step.run('', {})).toMatchObject({ state: 'degraded', status: 401 });
      expect(await step.run(`test-user=${USER}`, {})).toMatchObject({ state: 'degraded', status: 403 });
      const asOperator = await step.run(`test-user=${OPERATOR}`, {});
      expect(asOperator.state).toBe('fail');
      expect(asOperator.detail).toContain('Message Content intent is OFF');
      expect(asOperator.detail).not.toContain(TOKEN);
    } finally {
      if (priorPort === undefined) delete process.env.PORT; else process.env.PORT = priorPort;
    }
  });
});
