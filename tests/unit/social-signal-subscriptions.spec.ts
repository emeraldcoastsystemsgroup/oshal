/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Selector bounds/matching, distinct derived owner/bot lanes, and claim release on a failed mesh publish.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Covers the owner-proof slice. The cron is driven through its real timers under OSHAL_DB_GUC_STRICT=deny and the production GUC pool wrapper, and must stamp the trusted-operator identity (it stamped anonymous before, so the FORCE-RLS inbox join saw nothing). A failed publish and a failed poll are logged at ERROR. The delivery claim carries user_sub, bot_agent_id, channel and the same correlation id the stream envelope carries. Bot binding refuses an id no registry entry carries. The routes are driven over real loopback HTTP: 401 without a caller, 400 for a bad selector, 400 unknown_bot with nothing persisted, 201 for a registered bot, and a deliveries read that is 404 for a subscription the caller does not own. The pool here is a scripted double; the database boundary itself is proven in tests/unit/social-signal-subscriptions-postgres.spec.ts.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

import {
  isRegisteredSocialSignalBot,
  matchesSocialSignalSelector,
  parseSocialSignalBotAgentId,
  parseSocialSignalSelector,
  pollSocialSignalSubscriptions,
  socialSignalChannel,
  startSocialSignalSubscriptionCron,
} from '../../src/app/routes/social-signal-subscriptions';
import { mountSocialSignalSubscriptionRoutes } from '../../src/app/routes/social-signal-routes';
import { getActiveRegistry } from '../../src/app/extensions/swarm/swarm-bot-registry';
import { wrapPoolWithGuc, _resetFailOpenAudit } from '../../src/shared/services/database/guc-pool';
import type { MeshCommunicationService } from '../../src/features/agent-management';
import type { AppContext } from '../../src/app/composition/app-context';

const ALICE_SUB_ID = '11111111-1111-1111-1111-111111111111';
const BOB_SUB_ID = '22222222-2222-2222-2222-222222222222';

afterEach(() => {
  vi.useRealTimers();
  logSpies.error.mockClear();
  logSpies.info.mockClear();
});

/** A joined subscription/inbox row as the poll's SELECT returns it. */
function joinedRow(subscriptionId: string, userSub: string, botAgentId: string, msgId: string) {
  return {
    subscription_id: subscriptionId, user_sub: userSub, bot_agent_id: botAgentId,
    selector: { kind: 'keyword', value: 'futures' }, msg_id: msgId, from_addr: 'news@example.com',
    subject: 'Futures update', snippet: 'basis', received_at: '2026-09-25T10:00:00.000Z', source: 'gmail',
  };
}

/** A scripted pool that answers the poll's SELECT with `rows` and records every statement. */
function pollPool(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM oshal_social_signal_subscriptions s')) return { rows };
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('subscription-driven social signals', () => {
  it('bounds selector descriptors and matches account, keyword, and topic watches', () => {
    expect(parseSocialSignalSelector({ kind: 'keyword', value: ' futures ' })).toEqual({ kind: 'keyword', value: 'futures' });
    expect(parseSocialSignalSelector({ kind: 'unknown', value: 'futures' })).toBeNull();
    expect(parseSocialSignalSelector({ kind: 'keyword', value: 'x'.repeat(161) })).toBeNull();
    expect(parseSocialSignalBotAgentId('bot:research-1')).toBe('bot:research-1');
    expect(parseSocialSignalBotAgentId('bot with spaces')).toBeNull();

    const signal = { fromAddr: 'alerts@example.com', subject: 'Futures research note', snippet: 'Curve and basis update' };
    expect(matchesSocialSignalSelector({ kind: 'account', value: 'example.com' }, signal)).toBe(true);
    expect(matchesSocialSignalSelector({ kind: 'keyword', value: 'basis' }, signal)).toBe(true);
    expect(matchesSocialSignalSelector({ kind: 'topic', value: 'futures curve' }, signal)).toBe(true);
  });

  it('publishes matching rows to distinct derived owner/bot lanes and never leaks a raw subject key', async () => {
    const published: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const mesh = {
      send: async (envelope: { channel: string; payload: Record<string, unknown> }) => { published.push(envelope); },
    } as unknown as MeshCommunicationService;
    const { pool, calls } = pollPool([
      joinedRow(ALICE_SUB_ID, 'alice', 'research-a', 'a-1'),
      joinedRow(BOB_SUB_ID, 'bob', 'research-b', 'b-1'),
    ]);

    const result = await pollSocialSignalSubscriptions(pool, mesh);
    expect(result).toEqual({ matched: 2, published: 2, failed: 0 });
    expect(published).toHaveLength(2);
    expect(published[0].channel).toBe(socialSignalChannel('alice', 'research-a'));
    expect(published[1].channel).toBe(socialSignalChannel('bob', 'research-b'));
    expect(published[0].channel).not.toContain('alice');
    expect(published[0].payload.ownerSub).toBe('alice');
    expect(published[1].payload.ownerSub).toBe('bob');
    expect(calls.filter((c) => c.sql.includes('UPDATE oshal_social_signal_deliveries')).length).toBe(2);
  });

  it('records the owner, bot, lane and the envelope correlation id on the delivery claim', async () => {
    const published: Array<{ correlationId: string; channel: string }> = [];
    const mesh = { send: async (envelope: { correlationId: string; channel: string }) => { published.push(envelope); } } as unknown as MeshCommunicationService;
    const { pool, calls } = pollPool([joinedRow(ALICE_SUB_ID, 'alice', 'research-a', 'a-1')]);

    await pollSocialSignalSubscriptions(pool, mesh);
    const claim = calls.find((c) => c.sql.includes('INSERT INTO oshal_social_signal_deliveries'));
    expect(claim?.sql).toContain('(subscription_id, msg_id, user_sub, bot_agent_id, channel, correlation_id)');
    expect(claim?.params).toEqual([
      ALICE_SUB_ID, 'a-1', 'alice', 'research-a', socialSignalChannel('alice', 'research-a'), published[0].correlationId,
    ]);
    expect(published[0].correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('removes a delivery claim when mesh publication fails, logs it at ERROR, and lets the next poll retry', async () => {
    const mesh = { send: async () => { throw new Error('mesh unavailable'); } } as unknown as MeshCommunicationService;
    const { pool, calls } = pollPool([joinedRow(ALICE_SUB_ID, 'alice', 'research-a', 'a-1')]);

    await expect(pollSocialSignalSubscriptions(pool, mesh)).resolves.toEqual({ matched: 1, published: 0, failed: 1 });
    expect(calls.some((c) => c.sql.includes('DELETE FROM oshal_social_signal_deliveries'))).toBe(true);
    expect(logSpies.error).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: ALICE_SUB_ID, channel: socialSignalChannel('alice', 'research-a') }),
      expect.stringContaining('social signal delivery failed'),
    );
  });

  it('binds a subscription only to an exact agentId in the bot registry', () => {
    const registry = () => [{ agentId: 'b0000000-0000-0000-0000-00000000aaaa' }, { agentId: undefined }];
    expect(isRegisteredSocialSignalBot('b0000000-0000-0000-0000-00000000aaaa', registry)).toBe(true);
    expect(isRegisteredSocialSignalBot('bot:research-1', registry)).toBe(false);
    // The default reads the active registry: a real registered bot passes, an invented one does not.
    const real = getActiveRegistry().find((bot) => bot.agentId)?.agentId;
    expect(real, 'the active registry has no bot with an agentId').toBeTruthy();
    expect(isRegisteredSocialSignalBot(String(real))).toBe(true);
    expect(isRegisteredSocialSignalBot('not-a-registered-bot')).toBe(false);
  });
});

describe('social signal cron identity', () => {
  it('stamps the trusted SYSTEM identity on the poll under deny-by-default, and logs a failed poll at ERROR', async () => {
    const saved = process.env.OSHAL_DB_GUC_STRICT;
    process.env.OSHAL_DB_GUC_STRICT = 'deny';
    _resetFailOpenAudit();
    vi.useFakeTimers();
    const stamps: string[] = [];
    let failPoll = false;
    const client = {
      query: async (sql: string) => {
        if (sql.includes('set_config')) stamps.push(/is_operator',\s*'(on|off)'/.exec(sql)?.[1] ?? 'param');
        if (failPoll && sql.includes('FROM oshal_social_signal_subscriptions s')) throw new Error('inbox unavailable');
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = wrapPoolWithGuc({ connect: async () => client } as unknown as Pool);
    const ctx = { pool, swarm: { meshCommunicationService: { send: async () => undefined } } } as unknown as AppContext;
    try {
      startSocialSignalSubscriptionCron(ctx);
      await vi.advanceTimersByTimeAsync(90_000);
      // Without the sentinel this is 'off' (anonymous) and RLS hides every inbox row.
      expect(stamps).toEqual(['on']);

      failPoll = true;
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(stamps).toEqual(['on', 'on']);
      expect(logSpies.error).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'interval' }),
        expect.stringContaining('social signal subscription poll failed'),
      );
    } finally {
      if (saved === undefined) delete process.env.OSHAL_DB_GUC_STRICT; else process.env.OSHAL_DB_GUC_STRICT = saved;
    }
  });
});

/** Route double: the subscription and delivery rows the handlers read, keyed like the tables. */
function routePool() {
  const calls: string[] = [];
  const owned = new Map<string, string>([[ALICE_SUB_ID, 'alice']]);
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push(sql);
      if (sql.includes('INSERT INTO oshal_social_signal_subscriptions')) return { rowCount: 1, rows: [] };
      if (sql.includes('SELECT subscription_id FROM oshal_social_signal_subscriptions')) return { rows: [{ subscription_id: ALICE_SUB_ID }] };
      if (sql.includes('SELECT 1 FROM oshal_social_signal_subscriptions')) {
        return { rows: owned.get(String(params[0])) === params[1] ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('FROM oshal_social_signal_deliveries')) {
        return { rows: [{ msg_id: 'a-1', bot_agent_id: 'bot-a', channel: socialSignalChannel('alice', 'bot-a'), correlation_id: 'c-1', claimed_at: '2026-09-25T10:00:00.000Z', published_at: '2026-09-25T10:00:01.000Z' }] };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('social signal subscription routes (real HTTP)', () => {
  let server: Server;
  let base = '';
  const { pool, calls } = routePool();

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const sub = req.header('x-test-sub');
      if (sub) Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub } } });
      next();
    });
    const router = Router();
    mountSocialSignalSubscriptionRoutes(router, { pool, isRegisteredBot: (id) => id === 'bot-a' });
    app.use('/api/content', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/content`;
  });

  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

  const post = (sub: string | null, body: unknown) => fetch(`${base}/subscriptions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(sub ? { 'x-test-sub': sub } : {}) }, body: JSON.stringify(body),
  });

  it('refuses a caller-less request, a bad selector, and an unregistered bot without persisting anything', async () => {
    expect((await post(null, { botAgentId: 'bot-a', selector: { kind: 'keyword', value: 'futures' } })).status).toBe(401);
    expect((await post('alice', { botAgentId: 'bot-a', selector: { kind: 'nope', value: 'futures' } })).status).toBe(400);
    const unknown = await post('alice', { botAgentId: 'bot-unregistered', selector: { kind: 'keyword', value: 'futures' } });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: 'unknown_bot' });
    expect(calls.some((sql) => sql.includes('INSERT INTO oshal_social_signal_subscriptions'))).toBe(false);
  });

  it('registers a subscription for a registered bot', async () => {
    const created = await post('alice', { botAgentId: 'bot-a', selector: { kind: 'keyword', value: 'futures' } });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ subscriptionId: ALICE_SUB_ID, botAgentId: 'bot-a', selector: { kind: 'keyword', value: 'futures' }, active: true });
  });

  it('returns the delivery audit to its owner and 404 to anyone else', async () => {
    const own = await fetch(`${base}/subscriptions/${ALICE_SUB_ID}/deliveries`, { headers: { 'x-test-sub': 'alice' } });
    expect(own.status).toBe(200);
    const body = await own.json() as { deliveries: Array<Record<string, unknown>> };
    expect(body.deliveries).toEqual([{
      msgId: 'a-1', botAgentId: 'bot-a', channel: socialSignalChannel('alice', 'bot-a'), correlationId: 'c-1',
      claimedAt: '2026-09-25T10:00:00.000Z', publishedAt: '2026-09-25T10:00:01.000Z',
    }]);
    const foreign = await fetch(`${base}/subscriptions/${ALICE_SUB_ID}/deliveries`, { headers: { 'x-test-sub': 'bob' } });
    expect(foreign.status).toBe(404);
    expect((await fetch(`${base}/subscriptions/${ALICE_SUB_ID}/deliveries`)).status).toBe(401);
    expect((await fetch(`${base}/subscriptions/not-a-uuid/deliveries`, { headers: { 'x-test-sub': 'alice' } })).status).toBe(400);
  });
});
