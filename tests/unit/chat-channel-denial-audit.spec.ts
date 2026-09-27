/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for BACKLOG "Chat-channel adapter core" (denial audit + cross-user rebind). The claim is about two database boundaries, so both are real here: the channel identity store runs as a NOSUPERUSER NOBYPASSRLS role over the GUC-stamped pool with migration 112's forced owner RLS on channel_links/channel_link_codes, and every refusal lands through the production chokepoint in the real PostgresRefusalStore (migration 155). Only the bot turn and the provider send are doubled. It proves one refusal row per denial on Telegram, Discord, SMS and WhatsApp (unlinked sender, refused code, cross-user rebind), that no raw channel identity is stored, that the rows are operator-only, that a bound identity is never moved by another user's code (it used to be silently re-pointed, and under forced RLS the same upsert raised), and that a same-user relink still works.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { CHANNEL_RLS_TABLES, prepareChannelSchema } from '../helpers/chat-channel-postgres';
import {
  CHANNEL_REFUSAL_CODES,
  ChannelLinkService,
  channelRefusalActor,
  type InboundChannelMessage,
  type InboundDiscordMessage,
} from '@/features/chat-channels';
import { PostgresRefusalStore } from '@/features/refusal-visibility';
import { configureRefusalRecorder } from '@/shared/refusal-events';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import {
  DISCORD_CHANNEL_REPLIES,
  TELEGRAM_CHANNEL_REPLIES,
  processDiscordInbound,
  processTelegramInbound,
} from '@/app/routes/chat-channel-routes';
import {
  SMS_LINKED_REPLY,
  SMS_LINK_FAILED_REPLY,
  SMS_REBIND_REFUSED_REPLY,
  SMS_UNLINKED_REPLY,
  createSmsInboundSink,
} from '@/app/routes/sms-inbound-dispatch';

const ROLE = 'oshal_app';
const ALICE = 'auth0|channel-alice';
const BOB = 'auth0|channel-bob';
const OSHAL_NUMBER = '+15559990000';

const fixture = new DisposablePostgres({
  purpose: 'chat-channel-denial-audit',
  roles: [ROLE],
  migrations: ['155-refusal-ledger.sql'],
});

let admin: Pool;
let links: ChannelLinkService;
let store: PostgresRefusalStore;
let dispatched: string[] = [];
let sent: string[] = [];

/** The provider-neutral shape each case drives: one inbound text from one identity. */
type Provider = 'telegram' | 'discord' | 'sms' | 'whatsapp';
const IDENTITY: Record<Provider, string> = {
  telegram: '700000001', discord: '987654321', sms: '+15551110001', whatsapp: '+15551110002',
};

let seq = 0;
/** Deliver one message from `identity` on `provider` through that provider's real processor. */
async function deliver(provider: Provider, text: string, identity = IDENTITY[provider]): Promise<void> {
  seq += 1;
  const dispatch = async (sub: string) => { dispatched.push(sub); return `answered ${sub}`; };
  if (provider === 'telegram') {
    const msg: InboundChannelMessage = { provider, eventId: String(9000 + seq), channelUserId: identity, chatId: identity, text, displayName: 'Fixture' };
    await processTelegramInbound(links, msg, dispatch, async (_chat, reply) => { sent.push(reply); });
    return;
  }
  if (provider === 'discord') {
    const msg: InboundDiscordMessage = { provider, eventId: String(333330000 + seq), channelUserId: identity, channelId: '123456789', text, displayName: 'Fixture' };
    await processDiscordInbound(links, msg, dispatch, async (_chat, reply) => { sent.push(reply); });
    return;
  }
  const deferred: Promise<void>[] = [];
  const sink = createSmsInboundSink({
    links,
    dispatch: async (sub) => dispatch(sub),
    reply: async (_sub, _to, body) => { sent.push(body); return { delivered: true }; },
    defer: (work) => { deferred.push(work); },
  });
  const prefix = provider === 'whatsapp' ? 'whatsapp:' : '';
  const twiml = await sink({ messageSid: `SMdenial${seq}`, accountSid: null, from: `${prefix}${identity}`, to: `${prefix}${OSHAL_NUMBER}`,
    body: text, numMedia: 0, mediaUrls: [], receivedAt: new Date().toISOString() });
  if (twiml) sent.push(twiml);
  await Promise.all(deferred);
}

/** Mint a code as the signed-in owner, exactly as the auth-gated route does. */
function mint(sub: string, provider: Provider): Promise<string> {
  return runWithRequestIdentity({ sub, isOperator: false }, () => links.mintLinkCode(sub, provider));
}

/** The link command each provider's user sends. */
const linkText = (provider: Provider, code: string): string => (provider === 'telegram' ? `/start ${code}` : `LINK ${code}`);

/** Every refusal row, read as the fixture superuser (the ledger's own RLS is asserted separately). */
async function refusals(): Promise<Array<Record<string, any>>> {
  return (await admin.query('SELECT code, owner_sub, actor_sub, owning_package, target_kind, target, metadata FROM oshal_refusals ORDER BY occurred_at, id')).rows;
}

async function ownerOf(provider: Provider, identity = IDENTITY[provider]): Promise<string | null> {
  const { rows } = await admin.query('SELECT user_sub FROM channel_links WHERE provider=$1 AND channel_user_id=$2', [provider, identity]);
  return rows[0]?.user_sub ?? null;
}

const REPLIES: Record<Provider, { linked: string; invalid: string; rebind: string; unlinked: string }> = {
  telegram: TELEGRAM_CHANNEL_REPLIES,
  discord: DISCORD_CHANNEL_REPLIES,
  sms: { linked: SMS_LINKED_REPLY, invalid: SMS_LINK_FAILED_REPLY, rebind: SMS_REBIND_REFUSED_REPLY, unlinked: SMS_UNLINKED_REPLY },
  whatsapp: { linked: SMS_LINKED_REPLY, invalid: SMS_LINK_FAILED_REPLY, rebind: SMS_REBIND_REFUSED_REPLY, unlinked: SMS_UNLINKED_REPLY },
};
const TARGETS: Record<Provider, string> = {
  telegram: '/api/channels/telegram/webhook', discord: 'discord-gateway:MESSAGE_CREATE', sms: '/api/sms/inbound', whatsapp: '/api/sms/inbound',
};
const PROVIDERS: Provider[] = ['telegram', 'discord', 'sms', 'whatsapp'];

beforeAll(async () => {
  vi.stubEnv('OSHAL_DB_GUC_STRICT', 'deny');
  admin = await fixture.start();
  const { runtime, forcedTables, roleFlags } = await prepareChannelSchema(fixture, ROLE);
  expect(forcedTables).toEqual([...CHANNEL_RLS_TABLES]);
  expect(roleFlags).toEqual({ rolsuper: false, rolbypassrls: false });

  // The runtime role is not the schema owner, so it validates rather than applies DDL.
  vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', 'validate-only');
  links = new ChannelLinkService(runtime as never);
  await links.ensureSchema();
  store = new PostgresRefusalStore(runtime);
  configureRefusalRecorder(store);
}, 180_000);

afterAll(async () => {
  configureRefusalRecorder(undefined);
  vi.unstubAllEnvs();
  await fixture.stop();
}, 120_000);

afterEach(async () => {
  dispatched = []; sent = [];
  await admin.query('TRUNCATE channel_links, channel_link_codes, channel_inbound_events, oshal_refusals');
});

describe('an unlinked sender is refused and audited on every provider', () => {
  it.each(PROVIDERS)('%s: guidance only, one ledger row under a hashed actor, no raw identity', async (provider) => {
    await deliver(provider, 'read me my messages');

    expect(dispatched).toEqual([]);
    expect(sent).toEqual([REPLIES[provider].unlinked]);
    const rows = await refusals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: CHANNEL_REFUSAL_CODES.unlinked_identity,
      actor_sub: channelRefusalActor(provider, IDENTITY[provider]),
      owner_sub: channelRefusalActor(provider, IDENTITY[provider]),
      owning_package: 'chat-channels',
      target: TARGETS[provider],
      metadata: { provider, reason: 'unlinked_identity' },
    });
    expect(JSON.stringify(rows[0]), 'the raw channel identity must never be persisted').not.toContain(IDENTITY[provider].replace('+', ''));
  });
});

describe('a refused link code is audited and binds nothing', () => {
  it.each(PROVIDERS)('%s: unknown, other-provider and consumed codes each leave one row', async (provider) => {
    const other: Provider = provider === 'telegram' ? 'discord' : 'telegram';
    const foreign = await mint(ALICE, other);
    await deliver(provider, linkText(provider, 'deadbeef'));
    await deliver(provider, linkText(provider, foreign));
    const own = await mint(ALICE, provider);
    await deliver(provider, linkText(provider, own), provider === 'telegram' || provider === 'discord' ? '111111111' : '+15551119999');
    await deliver(provider, linkText(provider, own));

    expect(await ownerOf(provider)).toBeNull();
    expect(sent.filter((s) => s === REPLIES[provider].invalid)).toHaveLength(3);
    const rows = await refusals();
    expect(rows.map((r) => r.code)).toEqual(Array(3).fill(CHANNEL_REFUSAL_CODES.invalid_link_code));
    expect(rows.every((r) => r.actor_sub === channelRefusalActor(provider, IDENTITY[provider]))).toBe(true);
    expect(dispatched).toEqual([]);
  });
});

describe('an identity bound to one user is never moved by another user\'s code', () => {
  it.each(PROVIDERS)('%s: rebind refused under forced RLS, audited with both subjects; same-user relink still allowed', async (provider) => {
    await deliver(provider, linkText(provider, await mint(ALICE, provider)));
    expect(await ownerOf(provider)).toBe(ALICE);
    sent = [];

    await deliver(provider, linkText(provider, await mint(BOB, provider)));
    expect(sent).toEqual([REPLIES[provider].rebind]);
    expect(await ownerOf(provider)).toBe(ALICE);
    const rows = await refusals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: CHANNEL_REFUSAL_CODES.identity_bound_to_another_user,
      actor_sub: channelRefusalActor(provider, IDENTITY[provider]),
      metadata: { provider, reason: 'identity_bound_to_another_user', codeOwnerSub: BOB, boundOwnerSub: ALICE },
    });

    await deliver(provider, 'still mine?');
    expect(dispatched).toEqual([ALICE]);

    sent = [];
    await deliver(provider, linkText(provider, await mint(ALICE, provider)));
    expect(sent).toEqual([REPLIES[provider].linked]);
    expect(await ownerOf(provider)).toBe(ALICE);
    expect(await refusals()).toHaveLength(1);
  });

  it('BOB can link the identity once ALICE has unlinked it', async () => {
    await deliver('telegram', linkText('telegram', await mint(ALICE, 'telegram')));
    const removed = await runWithRequestIdentity({ sub: ALICE, isOperator: false }, () => links.unlink(ALICE, 'telegram', IDENTITY.telegram));
    expect(removed).toBe(true);
    await deliver('telegram', linkText('telegram', await mint(BOB, 'telegram')));
    expect(await ownerOf('telegram')).toBe(BOB);
    expect(await refusals()).toEqual([]);
  });
});

describe('the channel refusal rows are operator-only', () => {
  it('neither the bound owner nor the code owner can read them; an operator can', async () => {
    await deliver('sms', linkText('sms', await mint(ALICE, 'sms')));
    await deliver('sms', linkText('sms', await mint(BOB, 'sms')));
    await deliver('discord', 'hello from nobody');

    const asAlice = await runWithRequestIdentity({ sub: ALICE, isOperator: false }, () => store.listRecent(1, 50));
    const asBob = await runWithRequestIdentity({ sub: BOB, isOperator: false }, () => store.listRecent(1, 50));
    const asOperator = await runWithRequestIdentity({ sub: 'auth0|operator', isOperator: true }, () => store.listRecent(1, 50));
    expect(asAlice).toEqual([]);
    expect(asBob).toEqual([]);
    expect(asOperator.map((r) => r.code).sort()).toEqual([
      CHANNEL_REFUSAL_CODES.identity_bound_to_another_user, CHANNEL_REFUSAL_CODES.unlinked_identity,
    ].sort());
  });

  it('a ledger outage never changes what the sender gets', async () => {
    configureRefusalRecorder({ record: async () => { throw new Error('ledger down'); } });
    try {
      await deliver('telegram', 'anyone there?');
      expect(sent).toEqual([TELEGRAM_CHANNEL_REPLIES.unlinked]);
      expect(dispatched).toEqual([]);
    } finally {
      configureRefusalRecorder(store);
    }
  });
});
