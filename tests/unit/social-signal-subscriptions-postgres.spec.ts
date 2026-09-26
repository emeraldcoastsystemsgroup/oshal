/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary proof for subscription-driven social signals (BACKLOG "Subscription-driven social signals"): one caller-scoped subscription produces exactly one auditable matched signal on that caller's bot lane, and another user cannot read the subscription, the captured post, the delivery record or the stream event. Nothing on the boundary is doubled: a private PostgreSQL started by this file with the NOSUPERUSER NOBYPASSRLS enforcing role `oshal_app` connecting through the production GUC pool wrapper under OSHAL_DB_GUC_STRICT=deny; the production schema chokepoints (ensureInboxSchema, ensureContentSchema) run AS that role so it owns the tables and FORCE RLS binds it; the real migration 060 file applies the inbox owner policy; a private Redis carries the real RedisMeshTransport XADD; and the real subscription router runs over loopback HTTP behind the server.ts identity-middleware shape. Only the sign-in rail is stood in for (a header names the caller). The bare poll (no identity) is shown to see nothing under deny, which is the defect the SYSTEM wrap fixes; the cron's own entry point then publishes.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Redis from 'ioredis';
import type { Pool } from 'pg';

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { wrapPoolWithGuc } from '@/shared/services/database';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { MeshCommunicationService, RedisMeshTransport, type MeshEnvelope } from '@/features/agent-management';
import { ensureContentSchema } from '@/app/routes/content-routes';
import { ensureInboxSchema } from '@/app/routes/inbox-ingest';
import { mountSocialSignalSubscriptionRoutes } from '@/app/routes/social-signal-routes';
import {
  pollSocialSignalSubscriptions,
  runSocialSignalPollAsSystem,
  socialSignalChannel,
} from '@/app/routes/social-signal-subscriptions';
import { getActiveRegistry } from '@/app/extensions/swarm/swarm-bot-registry';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { DisposableRedis } from '../helpers/disposable-redis';

const ENFORCING_ROLE = 'oshal_app';
const ALICE = 'auth0|social-signal-alice';
const BOB = 'auth0|social-signal-bob';
const SELECTOR = { kind: 'keyword', value: 'orbital' } as const;
const TABLES = ['oshal_inbox_messages', 'oshal_social_signal_subscriptions', 'oshal_social_signal_deliveries'];

const database = new DisposablePostgres({
  purpose: 'social-signal-subscriptions-postgres', database: 'social_signal_fixture',
  memory: '256m', max: 2, connectionTimeoutMillis: 10_000, statementTimeoutMs: 30_000,
  roles: [{ name: ENFORCING_ROLE, max: 4 }],
});
const redis = new DisposableRedis({ purpose: 'social-signal-subscriptions-redis' });

let admin: Pool;
let appPool: Pool;
let transport: RedisMeshTransport;
let mesh: MeshCommunicationService;
let reader: Redis;
let server: Server;
let base = '';
let bot = '';
const ids: Record<string, string> = {};
const envelopes: Record<string, MeshEnvelope> = {};
const savedEnv = { strict: process.env.OSHAL_DB_GUC_STRICT, bootstrap: process.env.OSHAL_SCHEMA_BOOTSTRAP };

/** The sign-in rail double (a header names the caller) and the server.ts identity middleware shape. */
function signedInWithIdentity(req: Request, _res: Response, next: NextFunction): void {
  const sub = req.header('x-test-sub') || null;
  if (sub) Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub } } });
  runWithRequestIdentity({ sub, isOperator: false }, () => next());
}

async function startRouter(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(signedInWithIdentity);
  const router = Router();
  mountSocialSignalSubscriptionRoutes(router, { pool: appPool });
  app.use('/api/content', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise((ready) => server.once('listening', ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/content`;
}

/** Run a query through the production GUC pool as one signed-in user. */
function asUser<T>(sub: string, run: () => Promise<T>): Promise<T> {
  return runWithRequestIdentity({ sub, isOperator: false }, run);
}

function http(sub: string | null, method: string, path: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(sub ? { 'x-test-sub': sub } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Every envelope XADDed to one derived lane, parsed from the stream's `data` field. */
async function lane(sub: string): Promise<MeshEnvelope[]> {
  const entries = await reader.xrange(`oshal:mesh:${socialSignalChannel(sub, bot)}`, '-', '+');
  return entries.map(([, fields]) => JSON.parse(fields[fields.indexOf('data') + 1]) as MeshEnvelope);
}

async function insertInbox(sub: string, msgId: string, category: string, subject: string): Promise<void> {
  await asUser(sub, () => appPool.query(
    `INSERT INTO oshal_inbox_messages (user_sub, msg_id, from_addr, subject, snippet, category, received_at, source)
     VALUES ($1,$2,'updates@example.com',$3,'captured fixture post',$4, now() + interval '1 second','gmail')`,
    [sub, msgId, subject, category],
  ));
}

beforeAll(async () => {
  process.env.OSHAL_DB_GUC_STRICT = 'deny';
  delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
  bot = getActiveRegistry().find((entry) => entry.agentId)?.agentId ?? '';
  admin = await database.start();
  await redis.start();
  appPool = wrapPoolWithGuc(database.rolePool(ENFORCING_ROLE));
  // The production chokepoints, run AS the enforcing role, so it owns what it creates.
  await ensureInboxSchema(appPool);
  await ensureContentSchema(appPool);
  // The inbox owner policy ships in migration 060, applied by the superuser pass in production.
  await admin.query(readFileSync(resolve(__dirname, '../../scripts/migrations/060-platform-rls-tenancy.sql'), 'utf8'));
  transport = new RedisMeshTransport({ redisUrl: redis.url });
  mesh = new MeshCommunicationService(transport);
  reader = new Redis(redis.url);
  await startRouter();
}, 180_000);

afterAll(async () => {
  if (server) await new Promise((closed) => server.close(closed));
  await reader?.quit().catch(() => undefined);
  await transport?.disconnect().catch(() => undefined);
  await database.stop();
  await redis.stop();
  if (savedEnv.strict === undefined) delete process.env.OSHAL_DB_GUC_STRICT; else process.env.OSHAL_DB_GUC_STRICT = savedEnv.strict;
  if (savedEnv.bootstrap !== undefined) process.env.OSHAL_SCHEMA_BOOTSTRAP = savedEnv.bootstrap;
}, 120_000);

describe('social signals over the enforcing role, real RLS and real Redis', () => {
  it('runs as a non-privileged owner role with FORCE row-level security on every table in the path', async () => {
    expect(bot, 'the active bot registry has no bot with an agentId').not.toBe('');
    const role = await admin.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [ENFORCING_ROLE]);
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const tables = await admin.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner) AS owner
         FROM pg_class WHERE relname = ANY($1) ORDER BY relname`, [TABLES],
    );
    expect(tables.rows).toEqual([...TABLES].sort().map((relname) => ({
      relname, relrowsecurity: true, relforcerowsecurity: true, owner: ENFORCING_ROLE,
    })));
  });

  it('registers one subscription per caller and refuses a caller-less request and an unregistered bot', async () => {
    expect((await http(null, 'POST', '/subscriptions', { botAgentId: bot, selector: SELECTOR })).status).toBe(401);
    const unknown = await http(ALICE, 'POST', '/subscriptions', { botAgentId: 'social-signal-unregistered-bot', selector: SELECTOR });
    expect(unknown.status).toBe(400);
    for (const [name, sub] of [['alice', ALICE], ['bob', BOB]] as const) {
      const created = await http(sub, 'POST', '/subscriptions', { botAgentId: bot, selector: SELECTOR });
      expect(created.status).toBe(201);
      ids[name] = ((await created.json()) as { subscriptionId: string }).subscriptionId;
    }
    expect(ids.alice).not.toBe(ids.bob);
    const stored = await admin.query('SELECT user_sub, bot_agent_id FROM oshal_social_signal_subscriptions ORDER BY user_sub');
    expect(stored.rows).toEqual([{ user_sub: ALICE, bot_agent_id: bot }, { user_sub: BOB, bot_agent_id: bot }]);
  });

  it('keeps each captured post with its owner, at write and at read', async () => {
    await insertInbox(ALICE, 'alice-match', 'social', 'Orbital launch window moved');
    await insertInbox(ALICE, 'alice-other', 'social', 'A different topic');
    await insertInbox(ALICE, 'alice-primary', 'primary', 'Orbital note in the primary tab');
    await insertInbox(BOB, 'bob-match', 'social', 'Orbital debris briefing');
    await expect(asUser(BOB, () => appPool.query(
      `INSERT INTO oshal_inbox_messages (user_sub, msg_id, category, received_at) VALUES ($1,'forged','social',now())`, [ALICE],
    ))).rejects.toThrow(/row-level security/);
    const bobView = await asUser(BOB, () => appPool.query('SELECT msg_id FROM oshal_inbox_messages ORDER BY msg_id'));
    expect(bobView.rows).toEqual([{ msg_id: 'bob-match' }]);
  });

  it('a poll with no identity in scope sees nothing under deny-by-default (the defect the SYSTEM wrap fixes)', async () => {
    await expect(pollSocialSignalSubscriptions(appPool, mesh)).resolves.toEqual({ matched: 0, published: 0, failed: 0 });
    expect(await reader.keys('oshal:mesh:social.signal.*')).toEqual([]);
  });

  it('the cron entry point publishes exactly one owner-bound event to each owner lane', async () => {
    await expect(runSocialSignalPollAsSystem(appPool, mesh)).resolves.toEqual({ matched: 2, published: 2, failed: 0 });
    const [aliceLane, bobLane] = [await lane(ALICE), await lane(BOB)];
    expect(aliceLane).toHaveLength(1);
    expect(bobLane).toHaveLength(1);
    [envelopes.alice, envelopes.bob] = [aliceLane[0], bobLane[0]];
    expect(envelopes.alice).toMatchObject({
      toAgentId: bot, channel: socialSignalChannel(ALICE, bot), messageType: 'event',
      payload: { type: 'social_signal', subscriptionId: ids.alice, ownerSub: ALICE, signal: { msgId: 'alice-match' } },
    });
    expect(envelopes.bob.payload).toMatchObject({ subscriptionId: ids.bob, ownerSub: BOB, signal: { msgId: 'bob-match' } });
    const keys = (await reader.keys('oshal:mesh:social.signal.*')).sort();
    expect(keys).toEqual([`oshal:mesh:${socialSignalChannel(ALICE, bot)}`, `oshal:mesh:${socialSignalChannel(BOB, bot)}`].sort());
    expect(keys.join(' ')).not.toContain('auth0|');
    expect(JSON.stringify(bobLane)).not.toContain('alice-match');
  });

  it('records an auditable delivery row tied to the owner and the stream envelope, once', async () => {
    const rows = await admin.query(
      `SELECT subscription_id, msg_id, user_sub, bot_agent_id, channel, correlation_id, published_at IS NOT NULL AS published
         FROM oshal_social_signal_deliveries ORDER BY user_sub`,
    );
    expect(rows.rows).toEqual([
      { subscription_id: ids.alice, msg_id: 'alice-match', user_sub: ALICE, bot_agent_id: bot, channel: socialSignalChannel(ALICE, bot), correlation_id: envelopes.alice.correlationId, published: true },
      { subscription_id: ids.bob, msg_id: 'bob-match', user_sub: BOB, bot_agent_id: bot, channel: socialSignalChannel(BOB, bot), correlation_id: envelopes.bob.correlationId, published: true },
    ]);
    await expect(runSocialSignalPollAsSystem(appPool, mesh)).resolves.toEqual({ matched: 0, published: 0, failed: 0 });
    expect(await lane(ALICE)).toHaveLength(1);
  });

  it('gives the owner their subscription and delivery audit over HTTP and gives another user nothing', async () => {
    const aliceList = await (await http(ALICE, 'GET', '/subscriptions')).json() as { subscriptions: Array<{ subscriptionId: string }> };
    expect(aliceList.subscriptions.map((s) => s.subscriptionId)).toEqual([ids.alice]);
    const bobList = await (await http(BOB, 'GET', '/subscriptions')).json() as { subscriptions: Array<{ subscriptionId: string }> };
    expect(bobList.subscriptions.map((s) => s.subscriptionId)).toEqual([ids.bob]);

    const audit = await http(ALICE, 'GET', `/subscriptions/${ids.alice}/deliveries`);
    expect(audit.status).toBe(200);
    const { deliveries } = await audit.json() as { deliveries: Array<Record<string, unknown>> };
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ msgId: 'alice-match', botAgentId: bot, channel: socialSignalChannel(ALICE, bot), correlationId: envelopes.alice.correlationId });

    expect((await http(BOB, 'GET', `/subscriptions/${ids.alice}/deliveries`)).status).toBe(404);
    expect(await (await http(BOB, 'DELETE', `/subscriptions/${ids.alice}`)).json()).toEqual({ ok: false });
    const still = await admin.query('SELECT active FROM oshal_social_signal_subscriptions WHERE subscription_id = $1', [ids.alice]);
    expect(still.rows).toEqual([{ active: true }]);
  });

  it('refuses another user every row of the owner in the database itself, even when asked by id', async () => {
    const reads = await asUser(BOB, async () => ({
      subscription: (await appPool.query('SELECT 1 FROM oshal_social_signal_subscriptions WHERE subscription_id = $1', [ids.alice])).rowCount,
      deliveries: (await appPool.query('SELECT 1 FROM oshal_social_signal_deliveries WHERE subscription_id = $1', [ids.alice])).rowCount,
      posts: (await appPool.query('SELECT 1 FROM oshal_inbox_messages WHERE user_sub = $1', [ALICE])).rowCount,
      disable: (await appPool.query('UPDATE oshal_social_signal_subscriptions SET active = FALSE WHERE subscription_id = $1', [ids.alice])).rowCount,
    }));
    expect(reads).toEqual({ subscription: 0, deliveries: 0, posts: 0, disable: 0 });
    const own = await asUser(ALICE, async () => (await appPool.query('SELECT 1 FROM oshal_social_signal_deliveries WHERE subscription_id = $1', [ids.alice])).rowCount);
    expect(own).toBe(1);
  });
});
