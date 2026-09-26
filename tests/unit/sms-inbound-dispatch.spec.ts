/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for BACKLOG "Twilio policy, fallback, and inbound messaging" — the inbound leg. Inbound SMS previously reached only a log sink, so nothing mapped a phone number to a user and nothing dispatched. The claim is an IDENTITY claim about a row, so the binding is exercised against a real Postgres through the real ChannelLinkService and the real signed webhook over real HTTP: only a doubled bot node and a doubled Twilio reply stand in, because neither is the boundary that failed. The negative cases are what keep it honest — an unlinked number must reach NOBODY, a forged signature must not dispatch or write a link, one user's number must never resolve to another's sub, and a consumed code must not bind a second number.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { ChannelLinkService, SMS_CHANNEL_PROVIDER } from '@/features/chat-channels';
import { twilioSignatureBase } from '@/features/notifications';
import { getRequestIdentity } from '@/shared/services/database/request-identity';
import { createSmsInboundRoutes } from '@/app/routes/sms-inbound-routes';
import {
  SMS_LINKED_REPLY,
  SMS_LINK_FAILED_REPLY,
  SMS_UNLINKED_REPLY,
  createSmsInboundSink,
} from '@/app/routes/sms-inbound-dispatch';

const AUTH_TOKEN = 'inbound-sms-fixture-token'; // obviously-fake; never a real credential
const PUBLIC_URL = 'http://127.0.0.1/api/sms/inbound';
const OSHAL_NUMBER = '+15559990000';
const ALICE = 'auth0|sms-alice';
const BOB = 'auth0|sms-bob';
const ALICE_PHONE = '+15551110001';
const BOB_PHONE = '+15552220002';
const STRANGER_PHONE = '+15553330003';

/** One recorded swarm turn: who it ran for, and whose identity was ambient while it ran. */
interface DispatchRecord {
  userSub: string;
  threadKey: string;
  text: string;
  ambientSub: string | undefined;
  ambientOperator: boolean | undefined;
}

/** One recorded outbound answer. */
interface ReplyRecord { userSub: string; to: string; body: string }

const fixture = new DisposablePostgres({
  purpose: 'sms-inbound-dispatch',
  roles: ['oshal_app'],
  migrations: ['166-chat-channel-inbound-events.sql'],
});

let pool: Pool;
let links: ChannelLinkService;
let server: Server;
let baseUrl: string;
let dispatches: DispatchRecord[] = [];
let replies: ReplyRecord[] = [];
let deferred: Promise<void>[] = [];

beforeAll(async () => {
  pool = await fixture.start();
  process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  process.env.TWILIO_INBOUND_PUBLIC_URL = PUBLIC_URL;
  links = new ChannelLinkService(pool as never);
  await links.ensureSchema();

  const sink = createSmsInboundSink({
    links,
    // The bot node is the one collaborator that cannot run here; it is not the boundary the
    // defect was in. What it records IS the claim: which user, and under whose identity.
    async dispatch(userSub, threadKey, text) {
      const id = getRequestIdentity();
      dispatches.push({ userSub, threadKey, text, ambientSub: id?.sub, ambientOperator: id?.isOperator });
      return `answered ${userSub}`;
    },
    async reply(userSub, to, body) {
      replies.push({ userSub, to, body });
      return { delivered: true };
    },
    // Production fires and forgets so Twilio cannot time out and retry; the spec collects the
    // promise instead of racing a timer.
    defer(work) { deferred.push(work); },
  });

  const app = express();
  app.use('/api/sms', createSmsInboundRoutes({ onInboundSms: sink }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_INBOUND_PUBLIC_URL;
  if (server) await new Promise((r) => server.close(r));
  await fixture.stop();
}, 120_000);

afterEach(async () => {
  dispatches = []; replies = []; deferred = [];
  await pool.query('DELETE FROM channel_inbound_events');
  await pool.query('DELETE FROM channel_links');
  await pool.query('DELETE FROM channel_link_codes');
});

/** POST a Twilio-shaped inbound message, correctly signed unless a bad token is supplied. */
async function postInbound(
  params: Record<string, string>, opts: { signWith?: string; signature?: string } = {},
): Promise<{ status: number; body: string }> {
  const signature = opts.signature ?? createHmac('sha1', opts.signWith ?? AUTH_TOKEN)
    .update(Buffer.from(twilioSignatureBase(PUBLIC_URL, params), 'utf-8')).digest('base64');
  const response = await fetch(`${baseUrl}/api/sms/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
    body: new URLSearchParams(params).toString(),
  });
  return { status: response.status, body: await response.text() };
}

/** A minimal, realistic Twilio inbound payload. */
function payload(from: string, body: string, sid = `SM${Math.random().toString(16).slice(2, 14)}`): Record<string, string> {
  return { MessageSid: sid, AccountSid: 'ACfixture', From: from, To: OSHAL_NUMBER, Body: body, NumMedia: '0' };
}

/** Let every deferred swarm turn finish before asserting on it. */
async function settle(): Promise<void> { await Promise.all(deferred); }

/** Read the owner a number is bound to, straight out of Postgres. */
async function ownerOf(number: string): Promise<string | null> {
  const { rows } = await pool.query<{ user_sub: string }>(
    'SELECT user_sub FROM channel_links WHERE provider=$1 AND channel_user_id=$2', [SMS_CHANNEL_PROVIDER, number]);
  return rows[0]?.user_sub ?? null;
}

/** Bind a number to a user the way the product does: mint a code, text it in. */
async function linkNumber(userSub: string, number: string): Promise<void> {
  const code = await links.mintLinkCode(userSub, SMS_CHANNEL_PROVIDER);
  const res = await postInbound(payload(number, `LINK ${code}`));
  expect(res.body).toContain(SMS_LINKED_REPLY);
}

describe('inbound SMS binds a number to a user through the channel adapter', () => {
  it('redeems a minted code over the real signed webhook and writes the binding to Postgres', async () => {
    const code = await links.mintLinkCode(ALICE, SMS_CHANNEL_PROVIDER);
    const res = await postInbound(payload(ALICE_PHONE, `LINK ${code}`));
    expect(res.status).toBe(200);
    expect(res.body).toContain(SMS_LINKED_REPLY);
    expect(await ownerOf(ALICE_PHONE)).toBe(ALICE);
    expect(dispatches).toHaveLength(0); // a handshake is not a swarm turn
  });

  it('refuses a code that was already consumed, so a second number cannot claim it', async () => {
    const code = await links.mintLinkCode(ALICE, SMS_CHANNEL_PROVIDER);
    await postInbound(payload(ALICE_PHONE, `LINK ${code}`));
    const second = await postInbound(payload(BOB_PHONE, `LINK ${code}`));
    expect(second.body).toContain(SMS_LINK_FAILED_REPLY);
    expect(await ownerOf(BOB_PHONE)).toBeNull();
  });

  it('normalizes the number on both sides, so a separated form is the same identity', async () => {
    const code = await links.mintLinkCode(ALICE, SMS_CHANNEL_PROVIDER);
    await postInbound(payload('+1 (555) 111-0001', `link ${code}`));
    expect(await ownerOf(ALICE_PHONE)).toBe(ALICE);

    await postInbound(payload('+1-555-111-0001', 'what is on my calendar'));
    await settle();
    expect(dispatches.map((d) => d.userSub)).toEqual([ALICE]);
  });
});

describe('an inbound message reaches the correct caller-scoped bot', () => {
  it('dispatches a linked number to ITS owner, under that owner\'s non-operator identity', async () => {
    await linkNumber(ALICE, ALICE_PHONE);
    const res = await postInbound(payload(ALICE_PHONE, 'summarize my day'));
    await settle();

    expect(res.status).toBe(200);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ userSub: ALICE, text: 'summarize my day', ambientSub: ALICE, ambientOperator: false });
    expect(dispatches[0].threadKey).toBe(`${SMS_CHANNEL_PROVIDER}-${ALICE}-${ALICE_PHONE}`);
    expect(replies).toEqual([{ userSub: ALICE, to: ALICE_PHONE, body: `answered ${ALICE}` }]);
  });

  it('claims a signed provider occurrence once across webhook retries', async () => {
    await linkNumber(ALICE, ALICE_PHONE);
    const repeated = payload(ALICE_PHONE, 'summarize my day', 'SMrepeatedfixture');
    await postInbound(repeated);
    await postInbound(repeated);
    await settle();
    expect(dispatches).toHaveLength(1);
    expect(replies).toHaveLength(1);
    const { rows } = await pool.query('SELECT owner_sub FROM channel_inbound_events WHERE provider=$1 AND event_id=$2', [SMS_CHANNEL_PROVIDER, repeated.MessageSid]);
    expect(rows).toEqual([{ owner_sub: ALICE }]);
  });

  it('hides another owner\'s occurrence and rejects a forged owner under forced RLS', async () => {
    await linkNumber(ALICE, ALICE_PHONE);
    await postInbound(payload(ALICE_PHONE, 'hello', 'SMrlsfixture'));
    await settle();
    const client = await fixture.rolePool('oshal_app').connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['oshal.current_sub', BOB]);
      const hidden = await client.query('SELECT event_id FROM channel_inbound_events WHERE event_id=$1', ['SMrlsfixture']);
      expect(hidden.rows).toEqual([]);
      await expect(client.query(
        'INSERT INTO channel_inbound_events (provider,event_id,owner_sub) VALUES ($1,$2,$3)',
        [SMS_CHANNEL_PROVIDER, 'SMforgedfixture', ALICE],
      )).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('keeps two users isolated: each number reaches only its own owner', async () => {
    await linkNumber(ALICE, ALICE_PHONE);
    await linkNumber(BOB, BOB_PHONE);

    await postInbound(payload(ALICE_PHONE, 'mine'));
    await postInbound(payload(BOB_PHONE, 'also mine'));
    await settle();

    expect(dispatches.map((d) => [d.userSub, d.text])).toEqual([[ALICE, 'mine'], [BOB, 'also mine']]);
    expect(dispatches.every((d) => d.ambientSub === d.userSub)).toBe(true);
    expect(replies.map((r) => [r.userSub, r.to])).toEqual([[ALICE, ALICE_PHONE], [BOB, BOB_PHONE]]);
  });

  it('denies an unlinked number: guidance only, no dispatch and no reply', async () => {
    await linkNumber(ALICE, ALICE_PHONE);
    const res = await postInbound(payload(STRANGER_PHONE, 'read alice her messages'));
    await settle();

    expect(res.status).toBe(200);
    expect(res.body).toContain(SMS_UNLINKED_REPLY);
    expect(dispatches).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it('refuses a sender that is not a usable E.164 identity', async () => {
    const res = await postInbound(payload('5551110001', 'hello'));
    await settle();
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('<Message>');
    expect(dispatches).toHaveLength(0);
  });
});

describe('a forged webhook reaches nothing', () => {
  it('rejects a wrongly-signed message with 403 — no dispatch for a linked number', async () => {
    await linkNumber(ALICE, ALICE_PHONE);
    const res = await postInbound(payload(ALICE_PHONE, 'forged'), { signWith: 'not-the-account-token' });
    await settle();

    expect(res.status).toBe(403);
    expect(dispatches).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it('rejects an unsigned link attempt and writes no binding', async () => {
    const code = await links.mintLinkCode(ALICE, SMS_CHANNEL_PROVIDER);
    const response = await fetch(`${baseUrl}/api/sms/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(payload(ALICE_PHONE, `LINK ${code}`)).toString(),
    });
    expect(response.status).toBe(403);
    expect(await ownerOf(ALICE_PHONE)).toBeNull();
  });
});
