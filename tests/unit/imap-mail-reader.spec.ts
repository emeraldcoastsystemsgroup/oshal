/**
 * The fixed Yahoo inbox reader, across the IMAP protocol boundary.
 *
 * BOUNDARY: what core sends to an IMAP server and what it hands a package back. The real imapflow
 * client talks the real IMAP wire protocol to a loopback responder (tests/helpers/loopback-imap.ts)
 * over a real TCP socket; the responder records every command. Doubled OUTSIDE that boundary: the
 * connector broker (a recording getAccessToken), because which stored grant is decrypted is proven
 * against the real broker and forced-RLS store by the email-summarizer package's isolation spec.
 * The loopback endpoint is plain TCP; the production endpoint's TLS and fixed host are pinned by
 * YAHOO_IMAP_ENDPOINT and by the composition root passing no override.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: closed secret schema, fixed endpoint pin, read-only EXAMINE with a bounded envelope FETCH, caller-personal grant selection, LOGIN refusal, missing connection and malformed secrets opening no socket, unreachable server, and the connect-time LOGIN probe.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  IMAP_MAX_MESSAGES, YAHOO_IMAP_ENDPOINT, createImapMailReader, parseYahooSecret, probeYahooLogin,
  type ImapEndpoint,
} from '@/app/routes/imap-mail-reader';
import { LoopbackImap, type LoopbackImapMessage } from '../helpers/loopback-imap';

const ADDRESS = 'reader.a@yahoo.example.com';
const APP_PASSWORD = 'abcdefghijklmnop';
const pool = {} as Pool;

/** 80 messages, oldest first; every third unread, every fifth flagged. */
const INBOX: LoopbackImapMessage[] = Array.from({ length: 80 }, (_, i) => ({
  uid: 1000 + i,
  flags: [...(i % 3 === 0 ? [] : ['\\Seen']), ...(i % 5 === 0 ? ['\\Flagged'] : [])],
  receivedAt: new Date(Date.UTC(2026, 8, 1, 8, 0, 0) + i * 3_600_000).toISOString(),
  subject: `Subject ${i + 1}`,
  fromName: `Sender ${i + 1}`,
  fromAddress: `sender${i + 1}@mail.example.com`,
}));

const responder = new LoopbackImap({ [ADDRESS]: { password: APP_PASSWORD, inbox: INBOX } });
let endpoint: ImapEndpoint;
const brokerCalls: Array<{ sub: string; provider: string; selector: unknown }> = [];

/** A recording broker that answers only the given subject. */
function broker(owner: string, secret: string | null) {
  return async (_pool: Pool, sub: string, provider: string, selector?: unknown): Promise<string | null> => {
    brokerCalls.push({ sub, provider, selector });
    return sub === owner ? secret : null;
  };
}

beforeAll(async () => {
  endpoint = { host: '127.0.0.1', port: await responder.start(), secure: false };
});
afterAll(async () => { await responder.stop(); });
beforeEach(() => {
  responder.commands.length = 0;
  responder.connections = 0;
  brokerCalls.length = 0;
});

describe('the stored secret has a closed schema', () => {
  it('accepts exactly address:app-password and normalizes a grouped paste', () => {
    expect(parseYahooSecret(`${ADDRESS}:${APP_PASSWORD}`)).toEqual({ address: ADDRESS, appPassword: APP_PASSWORD });
    expect(parseYahooSecret(' Reader.A@Yahoo.Example.com :abcd efgh ijkl mnop')).toEqual({ address: ADDRESS, appPassword: APP_PASSWORD });
  });

  it('refuses hosts, ports, JSON, control characters and wrong-length passwords', () => {
    for (const bad of [
      '', 'no-colon', `:${APP_PASSWORD}`, `${ADDRESS}:`, `${ADDRESS}:short`, `${ADDRESS}:${APP_PASSWORD}x`,
      `${ADDRESS}:${APP_PASSWORD}\r\nA1 DELETE INBOX`, `evil.example.com:993:${APP_PASSWORD}`,
      `{"host":"evil.example.com","user":"${ADDRESS}"}:${APP_PASSWORD}`, `user@host:${APP_PASSWORD}`,
      `a b@mail.example.com:${APP_PASSWORD}`, `${ADDRESS}:abcdefghijklmno!`,
    ]) expect(parseYahooSecret(bad), bad).toBeNull();
    expect(parseYahooSecret(42)).toBeNull();
  });
});

describe('the endpoint is fixed', () => {
  it('pins imap.mail.yahoo.com:993 over TLS, and the composition root passes no override', () => {
    expect(YAHOO_IMAP_ENDPOINT).toEqual({ host: 'imap.mail.yahoo.com', port: 993, secure: true });
    expect(Object.isFrozen(YAHOO_IMAP_ENDPOINT)).toBe(true);
    const root = readFileSync(resolve(__dirname, '../../src/app/composition-root.ts'), 'utf8');
    expect(root).toMatch(/imapMail: createImapMailReader\(pool\),/);
  });
});

describe('reading the caller inbox', () => {
  it('opens INBOX read-only and fetches only the newest 50 envelopes, newest first', async () => {
    const read = createImapMailReader(pool, { getAccessToken: broker('user-a', `${ADDRESS}:${APP_PASSWORD}`), endpoint });
    const result = await read({ userSub: 'user-a', limit: 500 });
    expect(result.status).toBe('connected');
    expect(result.messages).toHaveLength(IMAP_MAX_MESSAGES);
    expect(result.messages[0]).toMatchObject({ id: '1079', subject: 'Subject 80', from: 'Sender 80 <sender80@mail.example.com>' });
    expect(result.messages.at(-1)?.id).toBe('1030');
    const byId = new Map(result.messages.map((m) => [m.id, m]));
    expect(byId.get('1075')).toMatchObject({ unread: true, starred: true, providerFlags: { unread: true, important: false, starred: true } });
    expect(byId.get('1076')).toMatchObject({ unread: false, starred: false });
    expect(byId.get('1079')?.receivedAt).toBe(INBOX[79].receivedAt);
    const names = responder.commands.map((c) => c.split(' ')[0]);
    expect(names).toContain('EXAMINE');
    expect(responder.commands).toContain('EXAMINE INBOX');
    expect(responder.commands.find((c) => c.startsWith('FETCH'))).toMatch(/^FETCH 31:80 /);
    for (const forbidden of ['SELECT', 'STORE', 'EXPUNGE', 'APPEND', 'COPY', 'MOVE', 'DELETE', 'UID']) expect(names).not.toContain(forbidden);
    expect(responder.commands.find((c) => c.startsWith('FETCH'))).not.toMatch(/BODY/i);
    expect(names.at(-1)).toBe('LOGOUT');
  });

  it("resolves only the caller's personal yahoo grant", async () => {
    const read = createImapMailReader(pool, { getAccessToken: broker('user-a', `${ADDRESS}:${APP_PASSWORD}`), endpoint });
    await read({ userSub: 'user-a', limit: 5 });
    expect(brokerCalls).toEqual([{ sub: 'user-a', provider: 'yahoo', selector: { tenantId: 'personal' } }]);
    const other = await read({ userSub: 'user-b', limit: 5 });
    expect(other).toEqual({ status: 'not_connected', messages: [] });
    expect(responder.connections).toBe(1);
  });

  it('reports reconnect_required when the server refuses the LOGIN, and opens no mailbox', async () => {
    const read = createImapMailReader(pool, { getAccessToken: broker('user-a', `${ADDRESS}:zzzzzzzzzzzzzzzz`), endpoint });
    expect(await read({ userSub: 'user-a' })).toEqual({ status: 'reconnect_required', messages: [] });
    expect(responder.commands).toContain('LOGIN <redacted>');
    expect(responder.commands.some((c) => /^(EXAMINE|SELECT|FETCH)/.test(c))).toBe(false);
  });

  it('opens no socket without a connection, for a stored secret outside the schema, or without a caller', async () => {
    const none = createImapMailReader(pool, { getAccessToken: broker('user-a', null), endpoint });
    expect(await none({ userSub: 'user-a' })).toEqual({ status: 'not_connected', messages: [] });
    const malformed = createImapMailReader(pool, { getAccessToken: broker('user-a', `imap.evil.example.com:${APP_PASSWORD}`), endpoint });
    expect(await malformed({ userSub: 'user-a' })).toEqual({ status: 'reconnect_required', messages: [] });
    expect(await none({ userSub: '  ' })).toEqual({ status: 'not_connected', messages: [] });
    expect(responder.connections).toBe(0);
  });

  it('reports unavailable when the broker fails or the server cannot be reached', async () => {
    const failing = createImapMailReader(pool, { getAccessToken: async () => { throw new Error('no DEK row'); }, endpoint });
    expect(await failing({ userSub: 'user-a' })).toEqual({ status: 'unavailable', messages: [] });
    const closed = new LoopbackImap({});
    const port = await closed.start();
    await closed.stop();
    const unreachable = createImapMailReader(pool, {
      getAccessToken: broker('user-a', `${ADDRESS}:${APP_PASSWORD}`), endpoint: { host: '127.0.0.1', port, secure: false },
    });
    expect(await unreachable({ userSub: 'user-a' })).toEqual({ status: 'unavailable', messages: [] });
  });
});

describe('the connect-time LOGIN probe', () => {
  it('returns the address for a working app password and null otherwise', async () => {
    expect(await probeYahooLogin(`${ADDRESS}:${APP_PASSWORD}`, endpoint)).toBe(ADDRESS);
    expect(await probeYahooLogin(`${ADDRESS}:zzzzzzzzzzzzzzzz`, endpoint)).toBeNull();
    expect(responder.commands.filter((c) => c.startsWith('EXAMINE') || c.startsWith('FETCH'))).toEqual([]);
    const before = responder.connections;
    expect(await probeYahooLogin('not-a-yahoo-secret', endpoint)).toBeNull();
    expect(responder.connections).toBe(before);
  });
});
