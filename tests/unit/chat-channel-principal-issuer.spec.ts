/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the live chat-channel failure: a linked Discord DM answered "Something went wrong reaching your swarm" because the owner identity was entered without a principal issuer and user-bound delegation refused it ("User-bound delegation requires a verified principal issuer"). The earlier channel specs doubled the bot turn with a recorder, so they never crossed that boundary. Here it is REAL: BotNodeClient with delegation signing on runs resolveDelegatedPrincipal and signs { sub, principal_iss } onto the HTTP request a local bot-node double receives, and the token is verified with the public key. Also real: the channel identity store on disposable PostgreSQL as the NOSUPERUSER NOBYPASSRLS runtime role under forced RLS (migrations 112/166/170), the shipped auth-gated mint routes over loopback HTTP with a session shaped like express-openid-connect's (presentation user WITHOUT iss, idTokenClaims WITH iss), the shipped Discord Gateway client over a local WebSocket server, the shipped Telegram webhook, the shipped SMS/WhatsApp inbound sink, and the real refusal ledger. Only the bot node's reply and the provider sends are doubled. Covers: a linked message reaches delegation with { sub, issuer } on every provider; a legacy NULL-issuer link is refused with the re-link reply, audited, and never claims or dispatches; a same-user re-link repairs it; a pre-issuer code is not redeemable; no mint route mints without a verified issuer.
 */

import * as http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import type { Pool } from 'pg';
import WebSocket, { WebSocketServer } from 'ws';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { CHANNEL_RLS_TABLES, prepareChannelSchema } from '../helpers/chat-channel-postgres';
import { BotNodeClient } from '@/features/agent-management';
import { CHANNEL_REFUSAL_CODES, ChannelLinkService, deriveWebhookSecret } from '@/features/chat-channels';
import { PostgresRefusalStore } from '@/features/refusal-visibility';
import { configureRefusalRecorder } from '@/shared/refusal-events';
import { createDelegationTokenIssuer, createDelegationTokenVerifier } from '@/shared/security/delegation-token';
import { DELEGATION_HTTP_HEADER } from '@/shared/security/delegation-http-policy';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '@/app/composition/app-context';
import { DISCORD_CHANNEL_REPLIES, TELEGRAM_CHANNEL_REPLIES, createChatChannelRoutes } from '@/app/routes/chat-channel-routes';
import { SMS_LINKED_REPLY, SMS_LINK_FAILED_REPLY, SMS_RELINK_REPLY, createSmsInboundSink } from '@/app/routes/sms-inbound-dispatch';

const ROLE = 'oshal_app';
const ISSUER = 'https://identity.oshal.example.com';
const ALICE = 'auth0|issuer-alice';
const AGENT_ID = 'a0000000-0000-0000-0000-000000000050';
const TELEGRAM_TOKEN = '123456:fixture-telegram-token'; // obviously-fake; never a real credential
const DISCORD_TOKEN = 'fixture-discord-token'; // obviously-fake; never a real credential
const OSHAL_NUMBER = '+15559990000';
const BOT_ANSWER = 'answer from the bot node';
const NOW = 1_800_000_000;
const PAIR = generateKeyPairSync('ed25519');

const fixture = new DisposablePostgres({ purpose: 'chat-channel-principal-issuer', roles: [ROLE], migrations: ['155-refusal-ledger.sql'] });

interface BotNodeHit { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
type Provider = 'telegram' | 'discord' | 'sms' | 'whatsapp';

let admin: Pool;
let runtime: Pool;
let links: ChannelLinkService;
let server: http.Server;
let botNode: http.Server;
let gateway: WebSocketServer;
let gatewaySocket: WebSocket | null = null;
let baseUrl = '';
let jti = 0;
let hits: BotNodeHit[] = [];
let out: Array<{ provider: Provider; text: string }> = [];

/** The REAL controller client, delegation signing on, pointed at the local bot-node double. */
let client: BotNodeClient;

/** The production dispatch shape (dispatchToSwarm) minus BYO resolution: one accountable bot turn. */
async function botTurn(provider: string, ownerSub: string, chatId: string, text: string): Promise<string> {
  const taskId = `${provider}-${ownerSub}-${chatId}`;
  const result = await client.execute(AGENT_ID, {
    text, taskId, workspaceFolderId: taskId, agentId: AGENT_ID, agenticMode: true, direct: true, userSub: ownerSub,
  });
  return String(result.response || '').trim();
}

/**
 * A signed-in session exactly as express-openid-connect presents one: `req.oidc.user` is the
 * filtered presentation claims (NO iss); the verified issuer lives on `idTokenClaims`. A
 * `test-no-issuer=1` cookie models a session that carries no verified issuer at all.
 */
const session: RequestHandler = (req, _res, next) => {
  const cookie = req.headers.cookie || '';
  const sub = /(?:^|;\s*)test-user=([^;]+)/.exec(cookie)?.[1];
  if (!sub) { next(); return; }
  const verified = !/(?:^|;\s*)test-no-issuer=1/.test(cookie);
  Object.assign(req, { oidc: {
    isAuthenticated: () => true,
    user: { sub, name: 'Fixture User' },
    ...(verified ? { idTokenClaims: { sub, iss: ISSUER, aud: 'oshal' } } : {}),
  } });
  runWithRequestIdentity({ sub, principalIssuer: verified ? ISSUER : null, isOperator: false }, () => next());
};
const requiresAuth: RequestHandler = (req, res, next) => {
  if (!(req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub) { res.status(401).json({ error: 'unauthorized' }); return; }
  next();
};

async function waitFor(done: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 400));

/** Mint through the REAL auth-gated route. */
async function mintViaRoute(provider: Provider, sub: string, opts: { noIssuer?: boolean } = {}): Promise<{ status: number; body: Record<string, string> }> {
  const cookie = `test-user=${sub}${opts.noIssuer ? '; test-no-issuer=1' : ''}`;
  const res = await fetch(`${baseUrl}/api/channels/${provider}/link`, { method: 'POST', headers: { cookie } });
  return { status: res.status, body: await res.json() as Record<string, string> };
}

let seq = 700_000_000;
/** Deliver one inbound message from `identity` on `provider` through that provider's shipped entry point. */
async function deliver(provider: Provider, identity: string, text: string): Promise<void> {
  const id = String(++seq);
  if (provider === 'discord') {
    gatewaySocket!.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: seq, d: {
      id, channel_id: `9${identity}`, channel_type: 1, content: text, author: { id: identity, username: `user${identity}` },
    } }));
    return;
  }
  if (provider === 'telegram') {
    const hook = deriveWebhookSecret(TELEGRAM_TOKEN);
    await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': hook },
      body: JSON.stringify({ update_id: seq, message: { text, chat: { id: Number(identity), type: 'private' }, from: { id: Number(identity), first_name: 'Fixture' } } }),
    });
    return;
  }
  const deferred: Promise<void>[] = [];
  const sink = createSmsInboundSink({
    links,
    dispatch: (userSub, threadKey, body) => botTurn(provider, userSub, threadKey, body),
    reply: async (_sub, _to, body) => { out.push({ provider, text: body }); return { delivered: true }; },
    defer: (work) => { deferred.push(work); },
  });
  const prefix = provider === 'whatsapp' ? 'whatsapp:' : '';
  const twiml = await sink({ messageSid: `SM${id}`, accountSid: null, from: `${prefix}${identity}`, to: `${prefix}${OSHAL_NUMBER}`,
    body: text, numMedia: 0, mediaUrls: [], receivedAt: new Date().toISOString() });
  if (twiml) out.push({ provider, text: twiml });
  await Promise.all(deferred);
}

/** The identity each provider's user has, and the command that links it. */
const IDENTITY: Record<Provider, string> = { telegram: '700000301', discord: '987650301', sms: '+15551110301', whatsapp: '+15551110302' };
const linkCommand = (provider: Provider, code: string): string => (provider === 'telegram' ? `/start ${code}` : `LINK ${code}`);
const LINKED: Record<Provider, string> = { telegram: TELEGRAM_CHANNEL_REPLIES.linked, discord: DISCORD_CHANNEL_REPLIES.linked, sms: SMS_LINKED_REPLY, whatsapp: SMS_LINKED_REPLY };
const RELINK: Record<Provider, string> = { telegram: TELEGRAM_CHANNEL_REPLIES.relink, discord: DISCORD_CHANNEL_REPLIES.relink, sms: SMS_RELINK_REPLY, whatsapp: SMS_RELINK_REPLY };

/** Mint as the user (route for route-mintable providers; the store for Telegram, whose route needs the live getMe). */
async function mint(provider: Provider, sub: string): Promise<string> {
  if (provider === 'telegram') {
    return runWithRequestIdentity({ sub, principalIssuer: ISSUER, isOperator: false }, () => links.mintLinkCode(sub, 'telegram', ISSUER));
  }
  const minted = await mintViaRoute(provider, sub);
  expect(minted.status, JSON.stringify(minted.body)).toBe(200);
  return minted.body.code;
}

/** Link `identity` to `sub` through the provider's real handshake and wait for the confirmation. */
async function link(provider: Provider, sub: string): Promise<void> {
  const before = out.length;
  await deliver(provider, IDENTITY[provider], linkCommand(provider, await mint(provider, sub)));
  await waitFor(() => out.length === before + 1, `${provider} link reply`);
  expect(out.at(-1)?.text).toBe(LINKED[provider]);
}

/** Verify the delegation token the controller signed onto one bot-node request, with the public key. */
function verifiedClaims(hit: BotNodeHit, sub: string, taskId: string) {
  const verifier = createDelegationTokenVerifier({
    env: { OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({ current: PAIR.publicKey.export({ format: 'pem', type: 'spki' }).toString() }) },
    nowEpochSeconds: () => NOW,
  });
  return verifier.verify(String(hit.headers[DELEGATION_HTTP_HEADER]), {
    iss: 'urn:oshal:controller', aud: 'urn:oshal:bot-node', sub, principal_iss: ISSUER, azp: AGENT_ID, task_id: taskId,
    method: 'POST', path: '/api/swarm-execute', body_sha256: delegationRequestBodySha256(hit.body), scope: ['swarm:execute'],
  });
}

async function linkRow(provider: Provider): Promise<{ user_sub: string; user_issuer: string | null } | undefined> {
  return (await admin.query('SELECT user_sub, user_issuer FROM channel_links WHERE provider=$1 AND channel_user_id=$2', [provider, IDENTITY[provider]])).rows[0];
}

/** The local bot-node double: records each /api/swarm-execute request and answers success. */
async function startBotNode(): Promise<string> {
  botNode = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      hits.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, response: BOT_ANSWER, cost: 0, model: 'fixture', provider: 'noop', durationMs: 1,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
    });
  });
  botNode.listen(0, '127.0.0.1');
  await new Promise((r) => botNode.once('listening', r));
  return `http://127.0.0.1:${(botNode.address() as AddressInfo).port}`;
}

/** The REAL controller client with Ed25519 delegation signing on, as production composes it. */
function delegatingClient(endpoint: string): BotNodeClient {
  return new BotNodeClient(() => endpoint, 5_000, {
    env: {},
    delegationIssuer: createDelegationTokenIssuer({
      env: {
        OSHAL_DELEGATION_SIGNING_KID: 'current',
        OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: PAIR.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        OSHAL_DELEGATION_TTL_SECONDS: '300',
      },
      nowEpochSeconds: () => NOW,
      generateJti: () => `nonce-channel-${++jti}`,
    }),
  });
}

/** A local Discord Gateway that says HELLO and notes the client's IDENTIFY. */
async function startGateway(): Promise<{ url: string; identified: () => boolean }> {
  gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => gateway.once('listening', r));
  let identified = false;
  gateway.on('connection', (socket) => {
    gatewaySocket = socket;
    socket.on('message', (raw) => { if (JSON.parse(String(raw)).op === 2) identified = true; });
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
  });
  return { url: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, identified: () => identified };
}

/** The shipped channel router behind the session middleware; only the provider sends are doubled. */
async function startChannelApp(gatewayUrl: string): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(session);
  app.use('/api/channels', createChatChannelRoutes({ pool: runtime } as unknown as AppContext, requiresAuth, {
    dispatch: botTurn,
    telegram: { send: async (_chatId, text) => { out.push({ provider: 'telegram', text }); }, typing: async () => undefined },
    discord: {
      send: async (_channelId, text) => { out.push({ provider: 'discord', text }); },
      gateway: { token: DISCORD_TOKEN, socketFactory: () => new WebSocket(gatewayUrl) as never, reconnectDelayMs: 60_000 },
    },
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  vi.stubEnv('TWILIO_INBOUND_NUMBER', OSHAL_NUMBER);
  configureRefusalRecorder(new PostgresRefusalStore(runtime));
  links = new ChannelLinkService(runtime as never);
  client = delegatingClient(await startBotNode());
  expect(client.isDelegationEnforced()).toBe(true);
  const discordGateway = await startGateway();
  await startChannelApp(discordGateway.url);
  await waitFor(discordGateway.identified, 'the Gateway IDENTIFY');
}, 180_000);

afterAll(async () => {
  configureRefusalRecorder(undefined);
  vi.unstubAllEnvs();
  if (server) await new Promise((r) => server.close(r));
  if (botNode) await new Promise((r) => botNode.close(r));
  for (const socket of gateway?.clients ?? []) socket.terminate();
  if (gateway) await new Promise((r) => gateway.close(r));
  await fixture.stop();
}, 120_000);

afterEach(async () => {
  await settle();
  hits = []; out = [];
  await admin.query('TRUNCATE channel_links, channel_link_codes, channel_inbound_events, oshal_refusals');
});

describe('a linked message reaches user-bound delegation with the verified issuer', () => {
  it.each(['discord', 'telegram', 'sms', 'whatsapp'] as const)('%s: the bot node receives a token signed for { sub, principal_iss }', async (provider) => {
    await link(provider, ALICE);
    expect(await linkRow(provider)).toEqual({ user_sub: ALICE, user_issuer: ISSUER });

    await deliver(provider, IDENTITY[provider], 'what is on my calendar');
    await waitFor(() => out.length === 2, `${provider} answer`);
    expect(out[1]).toEqual({ provider, text: BOT_ANSWER });
    expect(hits).toHaveLength(1);
    expect(hits[0].body).toMatchObject({ agentId: AGENT_ID, userSub: ALICE, principalIssuer: ISSUER });
    const claims = verifiedClaims(hits[0], ALICE, String(hits[0].body.taskId));
    expect({ sub: claims.sub, principal_iss: claims.principal_iss }).toEqual({ sub: ALICE, principal_iss: ISSUER });
  });
});

describe('a legacy link recorded without an issuer never dispatches', () => {
  it.each(['discord', 'telegram', 'sms', 'whatsapp'] as const)('%s: re-link reply, audited, no occurrence claim, no bot turn', async (provider) => {
    await admin.query('INSERT INTO channel_links (provider, channel_user_id, chat_id, user_sub) VALUES ($1, $2, $2, $3)',
      [provider, IDENTITY[provider], ALICE]);
    await deliver(provider, IDENTITY[provider], 'hello');
    await waitFor(() => out.length === 1, `${provider} re-link reply`);
    await settle();
    expect(out).toEqual([{ provider, text: RELINK[provider] }]);
    expect(hits).toEqual([]);
    expect((await admin.query('SELECT count(*)::int AS n FROM channel_inbound_events')).rows[0].n).toBe(0);
    const refusals = (await admin.query('SELECT code, metadata FROM oshal_refusals')).rows;
    expect(refusals).toEqual([{ code: CHANNEL_REFUSAL_CODES.link_issuer_missing, metadata: expect.objectContaining({ provider, reason: 'link_issuer_missing' }) }]);
    expect(refusals[0].code).toBe('channel_link_required');
  });

  it('the same user re-linking repairs it: the fresh code refreshes the issuer and the next DM reaches delegation', async () => {
    await admin.query('INSERT INTO channel_links (provider, channel_user_id, chat_id, user_sub) VALUES ($1, $2, $3, $4)',
      ['discord', IDENTITY.discord, `9${IDENTITY.discord}`, ALICE]);
    await link('discord', ALICE);
    expect(await linkRow('discord')).toEqual({ user_sub: ALICE, user_issuer: ISSUER });
    await deliver('discord', IDENTITY.discord, 'now it works');
    await waitFor(() => out.length === 2, 'the answer');
    expect(out[1].text).toBe(BOT_ANSWER);
    expect(verifiedClaims(hits[0], ALICE, String(hits[0].body.taskId)).principal_iss).toBe(ISSUER);
  });

  it('a code minted before codes carried an issuer is not redeemable, so no new legacy link is created', async () => {
    await admin.query(`INSERT INTO channel_link_codes (code, user_sub, provider, expires_at) VALUES ('0a1b2c3d', $1, 'sms', NOW() + interval '10 minutes')`, [ALICE]);
    await deliver('sms', IDENTITY.sms, 'LINK 0a1b2c3d');
    expect(out).toEqual([{ provider: 'sms', text: SMS_LINK_FAILED_REPLY }]);
    expect(await linkRow('sms')).toBeUndefined();
  });
});

describe('a link code is never minted without a verified issuer', () => {
  it.each(['discord', 'telegram', 'sms', 'whatsapp'] as const)('%s: a session with no verified issuer is refused 403 issuer_required and no code is written', async (provider) => {
    const minted = await mintViaRoute(provider, ALICE, { noIssuer: true });
    expect(minted.status).toBe(403);
    expect(minted.body.error).toBe('issuer_required');
    expect((await admin.query('SELECT count(*)::int AS n FROM channel_link_codes')).rows[0].n).toBe(0);
  });

  it.each(['discord', 'sms', 'whatsapp'] as const)('%s: the real library session shape (user without iss, idTokenClaims with iss) mints and stores the issuer', async (provider) => {
    const minted = await mintViaRoute(provider, ALICE);
    expect(minted.status).toBe(200);
    const rows = (await admin.query('SELECT user_sub, user_issuer, provider FROM channel_link_codes WHERE code=$1', [minted.body.code])).rows;
    expect(rows).toEqual([{ user_sub: ALICE, user_issuer: ISSUER, provider }]);
  });

  it('the store itself refuses a code without an issuer and writes nothing', async () => {
    await expect(runWithRequestIdentity({ sub: ALICE, isOperator: false }, () => links.mintLinkCode(ALICE, 'sms', '  '))).rejects.toThrow(/verified principal issuer/);
    expect((await admin.query('SELECT count(*)::int AS n FROM channel_link_codes')).rows[0].n).toBe(0);
  });
});
