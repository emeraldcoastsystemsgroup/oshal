/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary inbound acceptance for BACKLOG "Chat-channel adapter core". Telegram arrives through the REAL createChatChannelRoutes webhook over real HTTP with the derived secret header; Discord arrives through the REAL Gateway client speaking the Gateway protocol (HELLO, IDENTIFY, MESSAGE_CREATE) to a local WebSocket server; link codes are minted through the REAL auth-gated routes. The identity store runs as a NOSUPERUSER NOBYPASSRLS role under forced owner RLS and refusals land in the real refusal ledger. Only the accountable bot turn and the provider send are doubled. Covers link, one owner-bound dispatch per occurrence, redelivery refused, unlinked refused and audited, two users isolated, codes never crossing providers, the WhatsApp sender advertisement, and the executable Test Lab round trip for every provider.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import WebSocket, { WebSocketServer } from 'ws';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { CHANNEL_RLS_TABLES, prepareChannelSchema } from '../helpers/chat-channel-postgres';
import { CHANNEL_REFUSAL_CODES, ChannelLinkService, channelRefusalActor, deriveWebhookSecret } from '@/features/chat-channels';
import { PostgresRefusalStore } from '@/features/refusal-visibility';
import { configureRefusalRecorder } from '@/shared/refusal-events';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '@/app/composition/app-context';
import { DISCORD_CHANNEL_REPLIES, TELEGRAM_CHANNEL_REPLIES, createChatChannelRoutes } from '@/app/routes/chat-channel-routes';
import { runChannelRoundTrip } from '@/app/routes/test-lab-channel-round-trip';

const ROLE = 'oshal_app';
const ALICE = 'auth0|inbound-alice';
const BOB = 'auth0|inbound-bob';
const CAROL = 'auth0|inbound-lab-carol';
const TELEGRAM_TOKEN = '123456:fixture-telegram-token'; // obviously-fake; never a real credential
const DISCORD_TOKEN = 'fixture-discord-token'; // obviously-fake; never a real credential
const WHATSAPP_SENDER = '+14155238886';

const fixture = new DisposablePostgres({ purpose: 'chat-channel-inbound', roles: [ROLE], migrations: ['155-refusal-ledger.sql'] });

interface Turn { provider: string; ownerSub: string; chatId: string; text: string; ambientSub: string | null | undefined; ambientOperator: boolean | undefined }
let admin: Pool;
let runtime: Pool;
let store: PostgresRefusalStore;
let server: Server;
let baseUrl = '';
let gateway: WebSocketServer;
let gatewaySocket: WebSocket | null = null;
const identifies: Array<{ op: number; d: { token?: string; intents?: number } }> = [];
let turns: Turn[] = [];
let telegramOut: Array<{ chatId: string; text: string }> = [];
let discordOut: Array<{ channelId: string; text: string }> = [];

/** Poll until `done()` holds; a real async boundary (webhook ack before processing) needs it. */
async function waitFor(done: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
/** Give an in-flight message that must produce NOTHING time to (not) produce it. */
const settle = () => new Promise((r) => setTimeout(r, 400));

/** A signed-in cookie session, entered as a non-operator request identity like the app's middleware. */
const cookieIdentity: RequestHandler = (req, _res, next) => {
  const sub = /(?:^|;\s*)test-user=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!sub) { next(); return; }
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub } } });
  runWithRequestIdentity({ sub, isOperator: false }, () => next());
};
const requiresAuth: RequestHandler = (req, res, next) => {
  if (!(req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
};

let updateId = 5000;
/** POST one Telegram private-chat update to the real webhook. */
async function telegram(fromId: string, text: string, opts: { updateId?: number; secret?: string } = {}): Promise<number> {
  const id = opts.updateId ?? ++updateId;
  const res = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': opts.secret ?? deriveWebhookSecret(TELEGRAM_TOKEN) },
    body: JSON.stringify({ update_id: id, message: { text, chat: { id: Number(fromId), type: 'private' }, from: { id: Number(fromId), first_name: 'Fixture' } } }),
  });
  return res.status;
}

let discordSeq = 700000000;
/** Deliver one MESSAGE_CREATE over the live Gateway socket, exactly as Discord frames it. */
function discord(userId: string, text: string, opts: { messageId?: string; channelId?: string; guildId?: string } = {}): string {
  const id = opts.messageId ?? String(++discordSeq);
  gatewaySocket!.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: discordSeq, d: {
    id, channel_id: opts.channelId ?? `9${userId}`, channel_type: opts.guildId ? 0 : 1, content: text,
    author: { id: userId, username: `user${userId}` }, ...(opts.guildId ? { guild_id: opts.guildId } : {}),
  } }));
  return id;
}

/** Mint a link code through the real auth-gated route as `sub`. */
async function mintViaRoute(sub: string, provider: 'discord' | 'whatsapp' | 'sms'): Promise<{ status: number; body: Record<string, string> }> {
  const res = await fetch(`${baseUrl}/api/channels/${provider}/link`, { method: 'POST', headers: { cookie: `test-user=${sub}` } });
  return { status: res.status, body: await res.json() as Record<string, string> };
}
/** Telegram's mint route needs the live getMe; the code store itself is the same service. */
function mintTelegram(sub: string): Promise<string> {
  return runWithRequestIdentity({ sub, isOperator: false }, () => new ChannelLinkService(runtime as never).mintLinkCode(sub, 'telegram'));
}
async function ownerOf(provider: string, identity: string): Promise<string | null> {
  return (await admin.query('SELECT user_sub FROM channel_links WHERE provider=$1 AND channel_user_id=$2', [provider, identity])).rows[0]?.user_sub ?? null;
}
async function refusalCodes(): Promise<string[]> {
  return (await admin.query('SELECT code FROM oshal_refusals ORDER BY occurred_at, id')).rows.map((r) => r.code);
}

beforeAll(async () => {
  vi.stubEnv('OSHAL_DB_GUC_STRICT', 'deny');
  admin = await fixture.start();
  const prepared = await prepareChannelSchema(fixture, ROLE);
  expect(prepared.forcedTables).toEqual([...CHANNEL_RLS_TABLES]);
  expect(prepared.roleFlags).toEqual({ rolsuper: false, rolbypassrls: false });
  runtime = prepared.runtime;
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', TELEGRAM_TOKEN);
  vi.stubEnv('DISCORD_BOT_TOKEN', DISCORD_TOKEN);
  vi.stubEnv('TWILIO_INBOUND_NUMBER', '+15559990000');
  vi.stubEnv('TWILIO_WHATSAPP_FROM', WHATSAPP_SENDER);
  store = new PostgresRefusalStore(runtime);
  configureRefusalRecorder(store);

  gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => gateway.once('listening', r));
  gateway.on('connection', (socket) => {
    gatewaySocket = socket;
    socket.on('message', (raw) => { const packet = JSON.parse(String(raw)); if (packet.op === 2) identifies.push(packet); });
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
  });
  const gatewayUrl = `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

  const app = express();
  app.use(express.json());
  app.use(cookieIdentity);
  app.use('/api/channels', createChatChannelRoutes({ pool: runtime } as unknown as AppContext, requiresAuth, {
    dispatch: async (provider, ownerSub, chatId, text) => {
      const ambient = getRequestIdentity();
      turns.push({ provider, ownerSub, chatId, text, ambientSub: ambient?.sub, ambientOperator: ambient?.isOperator });
      return `answer for ${ownerSub}`;
    },
    telegram: { send: async (chatId, text) => { telegramOut.push({ chatId, text }); }, typing: async () => undefined },
    discord: {
      send: async (channelId, text) => { discordOut.push({ channelId, text }); },
      gateway: { token: DISCORD_TOKEN, socketFactory: () => new WebSocket(gatewayUrl) as never, reconnectDelayMs: 60_000 },
    },
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await waitFor(() => identifies.length === 1, 'the Gateway IDENTIFY');
}, 180_000);

afterAll(async () => {
  configureRefusalRecorder(undefined);
  vi.unstubAllEnvs();
  if (server) await new Promise((r) => server.close(r));
  for (const client of gateway?.clients ?? []) client.terminate();
  if (gateway) await new Promise((r) => gateway.close(r));
  await fixture.stop();
}, 120_000);

afterEach(async () => {
  await settle();
  turns = []; telegramOut = []; discordOut = [];
  await admin.query('TRUNCATE channel_links, channel_link_codes, channel_inbound_events, oshal_refusals');
});

describe('Telegram through the real webhook', () => {
  it('rejects a delivery without the derived secret: 401 and nothing runs', async () => {
    expect(await telegram('700000101', 'hello', { secret: 'not-the-secret' })).toBe(401);
    await settle();
    expect(turns).toEqual([]);
    expect(telegramOut).toEqual([]);
  });

  it('links through /start, runs one DM once as its owner, answers the same chat, refuses a retried update', async () => {
    expect(await telegram('700000101', `/start ${await mintTelegram(ALICE)}`)).toBe(200);
    await waitFor(() => telegramOut.length === 1, 'the link reply');
    expect(telegramOut[0]).toEqual({ chatId: '700000101', text: TELEGRAM_CHANNEL_REPLIES.linked });
    expect(await ownerOf('telegram', '700000101')).toBe(ALICE);

    await telegram('700000101', 'summarize my day', { updateId: 6001 });
    await waitFor(() => telegramOut.length === 2, 'the answer');
    await telegram('700000101', 'summarize my day', { updateId: 6001 });
    await settle();
    expect(turns).toEqual([{ provider: 'telegram', ownerSub: ALICE, chatId: '700000101', text: 'summarize my day', ambientSub: ALICE, ambientOperator: false }]);
    expect(telegramOut[1]).toEqual({ chatId: '700000101', text: `answer for ${ALICE}` });
    expect(telegramOut).toHaveLength(2);
    expect((await admin.query("SELECT owner_sub FROM channel_inbound_events WHERE provider='telegram' AND event_id='6001'")).rows).toEqual([{ owner_sub: ALICE }]);
  });

  it('refuses and audits an unlinked chat; it reaches no swarm', async () => {
    await telegram('700000102', 'read me alice\'s mail');
    await waitFor(() => telegramOut.length === 1, 'the refusal reply');
    expect(telegramOut[0].text).toBe(TELEGRAM_CHANNEL_REPLIES.unlinked);
    expect(turns).toEqual([]);
    const rows = (await admin.query('SELECT code, actor_sub FROM oshal_refusals')).rows;
    expect(rows).toEqual([{ code: CHANNEL_REFUSAL_CODES.unlinked_identity, actor_sub: channelRefusalActor('telegram', '700000102') }]);
  });

  it('keeps two users isolated: each chat reaches only its own owner', async () => {
    await telegram('700000101', `/start ${await mintTelegram(ALICE)}`);
    await telegram('700000103', `/start ${await mintTelegram(BOB)}`);
    await waitFor(() => telegramOut.length === 2, 'both link replies');
    await telegram('700000101', 'mine');
    await telegram('700000103', 'also mine');
    await waitFor(() => turns.length === 2, 'both turns');
    expect(turns.map((t) => [t.chatId, t.ownerSub, t.ambientSub]).sort()).toEqual([['700000101', ALICE, ALICE], ['700000103', BOB, BOB]]);
  });
});

describe('Discord through the real Gateway protocol', () => {
  it('identified with the configured token and only the DM + message-content intents', () => {
    expect(identifies[0]).toMatchObject({ op: 2, d: { token: DISCORD_TOKEN, intents: 4096 | 32768 } });
  });

  it('links with a code from the auth-gated route, runs one DM once as its owner, refuses a redelivery, ignores a guild post', async () => {
    expect((await fetch(`${baseUrl}/api/channels/discord/link`, { method: 'POST' })).status).toBe(401);
    const minted = await mintViaRoute(ALICE, 'discord');
    expect(minted.status).toBe(200);
    discord('987650001', `LINK ${minted.body.code}`);
    await waitFor(() => discordOut.length === 1, 'the link reply');
    expect(discordOut[0]).toEqual({ channelId: '9987650001', text: DISCORD_CHANNEL_REPLIES.linked });
    expect(await ownerOf('discord', '987650001')).toBe(ALICE);

    const id = discord('987650001', 'what is on my calendar');
    await waitFor(() => discordOut.length === 2, 'the answer');
    discord('987650001', 'what is on my calendar', { messageId: id });
    discord('987650001', 'post in a server', { guildId: '555555555' });
    await settle();
    expect(turns).toEqual([{ provider: 'discord', ownerSub: ALICE, chatId: '9987650001', text: 'what is on my calendar', ambientSub: ALICE, ambientOperator: false }]);
    expect(discordOut).toHaveLength(2);
  });

  it('refuses and audits an unlinked DM', async () => {
    discord('987650002', 'hello');
    await waitFor(() => discordOut.length === 1, 'the refusal reply');
    expect(discordOut[0].text).toBe(DISCORD_CHANNEL_REPLIES.unlinked);
    expect(turns).toEqual([]);
    expect(await refusalCodes()).toEqual([CHANNEL_REFUSAL_CODES.unlinked_identity]);
  });

  it('keeps two users isolated', async () => {
    discord('987650001', `LINK ${(await mintViaRoute(ALICE, 'discord')).body.code}`);
    discord('987650003', `LINK ${(await mintViaRoute(BOB, 'discord')).body.code}`);
    await waitFor(() => discordOut.length === 2, 'both link replies');
    discord('987650001', 'mine');
    discord('987650003', 'also mine');
    await waitFor(() => turns.length === 2, 'both turns');
    expect(turns.map((t) => [t.chatId, t.ownerSub, t.ambientSub]).sort()).toEqual([['9987650001', ALICE, ALICE], ['9987650003', BOB, BOB]]);
  });
});

describe('a link code never crosses providers', () => {
  it('a Telegram code cannot link Discord, and a Discord code cannot link Telegram', async () => {
    discord('987650004', `LINK ${await mintTelegram(ALICE)}`);
    await telegram('700000104', `/start ${(await mintViaRoute(ALICE, 'discord')).body.code}`);
    await waitFor(() => discordOut.length === 1 && telegramOut.length === 1, 'both refusals');
    expect(discordOut[0].text).toBe(DISCORD_CHANNEL_REPLIES.invalid);
    expect(telegramOut[0].text).toBe(TELEGRAM_CHANNEL_REPLIES.invalid);
    expect(await ownerOf('discord', '987650004')).toBeNull();
    expect(await ownerOf('telegram', '700000104')).toBeNull();
    expect(await refusalCodes()).toEqual([CHANNEL_REFUSAL_CODES.invalid_link_code, CHANNEL_REFUSAL_CODES.invalid_link_code]);
  });
});

describe('WhatsApp link advertisement', () => {
  it('mints against the WhatsApp sender the user will message, and the channels surface reports it', async () => {
    const minted = await mintViaRoute(ALICE, 'whatsapp');
    expect(minted.status).toBe(200);
    expect(minted.body).toMatchObject({ textTo: `whatsapp:${WHATSAPP_SENDER}`, message: `LINK ${minted.body.code}` });
    vi.stubEnv('TELEGRAM_BOT_TOKEN', ''); // keep GET / from asking the live Bot API who it is
    try {
      const res = await fetch(`${baseUrl}/api/channels`, { headers: { cookie: `test-user=${ALICE}` } });
      expect(await res.json()).toMatchObject({ whatsapp: { configured: true, number: `whatsapp:${WHATSAPP_SENDER}` }, discord: { configured: true } });
    } finally {
      vi.stubEnv('TELEGRAM_BOT_TOKEN', TELEGRAM_TOKEN);
    }
  });
});

describe('the executable Test Lab round trip', () => {
  /** The server-derived Lab context, as test-lab-routes builds it for a signed-in caller. */
  const lab = () => ({ ctx: { pool: runtime } as unknown as AppContext, ownerSub: CAROL, issuer: 'https://identity.fixture.test', apiBaseUrl: '' });

  it.each(['telegram', 'discord', 'sms', 'whatsapp'] as const)('%s passes as the caller and leaves no link behind', async (provider) => {
    const result = await runChannelRoundTrip(provider, lab());
    expect(result.state, result.detail).toBe('pass');
    expect((await admin.query('SELECT count(*)::int AS n FROM channel_links WHERE user_sub=$1', [CAROL])).rows[0].n).toBe(0);
    expect(await refusalCodes()).toEqual([CHANNEL_REFUSAL_CODES.unlinked_identity]);
    expect((await admin.query('SELECT count(*)::int AS n FROM channel_inbound_events WHERE owner_sub=$1', [CAROL])).rows[0].n).toBe(1);
  });

  it('fails when the stranger refusal is not committed to the ledger', async () => {
    configureRefusalRecorder(undefined);
    try {
      const result = await runChannelRoundTrip('telegram', lab());
      expect(result.state).toBe('fail');
      expect(result.detail).toContain('ledger did not commit');
    } finally {
      configureRefusalRecorder(store);
    }
  });
});
