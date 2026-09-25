/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Cross real files/workers, durable claims, forced RLS and per-user routing with fixture-only notification transports.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import type { AppContext } from '@/app/composition-root';
import { NotificationRouter, upsertUserPref, type NotifyOutcome } from '@/features/notifications';
import { listFuturesResearchRuns, runFuturesResearch } from '@/app/trading-futures-research-dispatch';
import { notifyFuturesSourceFailure, FUTURES_SOURCE_ALERT_TOPIC, type FuturesSourceAlert } from '@/app/trading-futures-source-alert';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const routing = vi.hoisted(() => ({ notify: vi.fn(), build: vi.fn() }));
vi.mock('@/app/routes/notify-routes', () => ({ buildNotificationRouter: routing.build }));
const database = new DisposablePostgres({ purpose: 'futures-source-alerts', database: 'source_alert_fixture', memory: '384m', max: 6, roles: ['oshal_app'] });
let pool: Pool, ctx: AppContext, dir: string;
const issue = { code: 'empty', root: 'ES' } as const;
const config = { roots: ['ES'], source: 'kibot-file', timeframe: '1Day', ltfTimeframe: '1Day',
  start: '2021-01-01', endMode: 'fixed', end: '2021-05-31T23:59:59Z', sourceAlerts: true,
  split: { inSampleMonths: 1, oosMonths: 1, stepMonths: 1 },
  stageGrids: { Entry: {}, StopLoss: {}, Trail: {}, Targets: {}, EmergencyExit: {}, Sizing: {} } };

beforeAll(async () => {
  pool = await database.start();
  for (const file of ['159-futures-research-runs', '160-futures-research-review', '163-futures-source-alerts', '079-notification-prefs']) {
    await pool.query(readFileSync(resolve(`scripts/migrations/${file}.sql`), 'utf8'));
  }
  await pool.query(readFileSync(resolve('scripts/migrations/163-futures-source-alerts.sql'), 'utf8'));
  ctx = { pool, ticketService: { createTicket: vi.fn(async () => ({})) } } as unknown as AppContext;
  dir = mkdtempSync(join(tmpdir(), 'futures-source-alerts-'));
  mkdirSync(join(dir, 'minute'));
}, 180_000);
afterAll(async () => { if (dir) rmSync(dir, { recursive: true, force: true }); await database.stop(); });
beforeEach(() => {
  routing.notify.mockReset().mockResolvedValue({ delivered: true, channel: 'email', id: 'fixture-message' });
  routing.build.mockReset().mockReturnValue({ notify: routing.notify });
});

async function receipt(runId: string): Promise<FuturesSourceAlert | null> {
  return (await pool.query('SELECT source_alert FROM oshal_trading_futures_research_runs WHERE run_id=$1', [runId])).rows[0].source_alert;
}
async function insert(options: { owner?: string; enabled?: boolean; status?: string; alertStatus?: string } = {}): Promise<string> {
  return (await pool.query(`INSERT INTO oshal_trading_futures_research_runs (owner_sub,schedule_id,status,config,source_alert)
    VALUES ($1,'schedule-fixture',$2,$3::jsonb,$4::jsonb) RETURNING run_id`,
  [options.owner ?? 'owner-a', options.status ?? 'failed', JSON.stringify({ sourceAlerts: options.enabled ?? true }),
    JSON.stringify({ issue, status: options.alertStatus ?? 'ready' })])).rows[0].run_id;
}
async function waitFor(runId: string, alertStatus?: string): Promise<void> {
  await vi.waitFor(async () => {
    const row = (await pool.query('SELECT status,source_alert FROM oshal_trading_futures_research_runs WHERE run_id=$1', [runId])).rows[0];
    expect(row.status).not.toBe('running');
    if (alertStatus) expect(row.source_alert?.status).toBe(alertStatus);
  }, { timeout: 20_000, interval: 50 });
}

describe('owned Futures source failure notifications', () => {
  it('preserves stale evidence across an actual file worker, persists it and routes only to the owner', async () => {
    writeFileSync(join(dir, 'minute', 'ESH21.txt'), '01/04/2021,10:00,3700,3701,3699,3700,900\n');
    const run = await runFuturesResearch(ctx, 'owner-a', 'stale-schedule', { ...config, dataDir: dir });
    await waitFor(run.runId, 'delivered');
    const [owner, topic, message] = routing.notify.mock.calls[0];
    expect(owner).toBe('owner-a'); expect(topic).toBe(FUTURES_SOURCE_ALERT_TOPIC);
    expect(message.body).toContain('2021-01-04'); expect(message.body).toContain('147/147 days');
    expect(message.body).toContain(run.runId); expect(message.body).not.toContain(dir);
    const row = (await listFuturesResearchRuns(ctx.pool, 'owner-a')).find(item => item.runId === run.runId)!;
    expect(row).toMatchObject({ status: 'failed', markets: [], sourceAlert: { status: 'delivered', channel: 'email', issue: { code: 'stale', root: 'ES' } } });
    expect(row.sourceAlert?.claimedAt).toBeTruthy(); expect(row.sourceAlert?.completedAt).toBeTruthy();
    expect(await listFuturesResearchRuns(ctx.pool, 'owner-b')).toEqual([]);
    expect(ctx.ticketService.createTicket).not.toHaveBeenCalled();
  }, 60_000);

  it('leaves an old schedule opted out and does not classify other study errors as source failures', async () => {
    const absent = await runFuturesResearch(ctx, 'owner-a', 'missing', { ...config, sourceAlerts: undefined, dataDir: join(dir, 'absent') });
    await waitFor(absent.runId, 'disabled');
    expect((await receipt(absent.runId))?.issue.code).toBe('unconfigured');
    await notifyFuturesSourceFailure(ctx, 'owner-a', absent.runId);
    // A fresh single bar has no complete OOS window: it is not a stale-source event.
    writeFileSync(join(dir, 'minute', 'ESH21.txt'), '');
    writeFileSync(join(dir, 'minute', 'ESM21.txt'), '05/31/2021,10:00,3700,3701,3699,3700,900\n');
    const short = await runFuturesResearch(ctx, 'owner-a', 'short', { ...config, dataDir: dir });
    await waitFor(short.runId);
    expect(await receipt(short.runId)).toBeNull();
    const row = (await listFuturesResearchRuns(ctx.pool, 'owner-a')).find(item => item.runId === short.runId)!;
    expect(row.error).toContain('no complete out-of-sample');
    expect(routing.build).not.toHaveBeenCalled();
  }, 60_000);

  it('claims once under concurrency, refuses a wrong owner or saved opt-out, and never replays a claim', async () => {
    const runId = await insert();
    await notifyFuturesSourceFailure(ctx, 'owner-b', runId);
    await notifyFuturesSourceFailure(ctx, 'owner-a', await insert({ enabled: false }));
    await notifyFuturesSourceFailure(ctx, 'owner-a', await insert({ status: 'completed' }));
    expect(routing.build).not.toHaveBeenCalled();
    await Promise.all(Array.from({ length: 8 }, () => notifyFuturesSourceFailure(ctx, 'owner-a', runId)));
    await notifyFuturesSourceFailure(ctx, 'owner-a', runId);
    expect(routing.notify).toHaveBeenCalledTimes(1);
    expect((await receipt(runId))?.status).toBe('delivered');
    await notifyFuturesSourceFailure(ctx, 'owner-a', await insert({ alertStatus: 'claimed' }));
    expect(routing.notify).toHaveBeenCalledTimes(1);
  });

  it('enforces RLS even when a non-owner supplies the victim owner as an argument', async () => {
    const runId = await insert();
    await pool.query('GRANT SELECT, UPDATE ON oshal_trading_futures_research_runs TO oshal_app');
    const client = await database.rolePool('oshal_app').connect();
    try {
      await client.query("SELECT set_config('oshal.current_sub','owner-b',false), set_config('oshal.is_operator','off',false)");
      await notifyFuturesSourceFailure({ ...ctx, pool: client } as unknown as AppContext, 'owner-a', runId);
      expect((await client.query('SELECT source_alert FROM oshal_trading_futures_research_runs WHERE run_id=$1', [runId])).rows).toEqual([]);
    } finally { client.release(); }
    expect((await receipt(runId))?.status).toBe('ready'); expect(routing.build).not.toHaveBeenCalled();
  });

  it.each([
    ['muted', false, 'email', null, 'skipped', 'disabled'],
    ['none', true, 'none', null, 'skipped', 'channel-none'],
    ['quiet', true, 'email', 22, 'skipped', 'quiet-hours'],
    ['unavailable', true, 'sms', null, 'skipped', 'no-sender-registered'],
    ['failure', true, 'email', null, 'failed', 'send-failed'],
  ] as const)('honors real saved routing: %s, without leaking a provider error', async (owner, enabled, channel, quietHoursStart, status, reason) => {
    const runId = await insert({ owner });
    await upsertUserPref(pool, { userSub: owner, topic: FUTURES_SOURCE_ALERT_TOPIC, channel, enabled, quietHoursStart,
      quietHoursEnd: quietHoursStart === null ? null : 6, phone: null, telegramChatId: null });
    const send = vi.fn(async () => ({ delivered: false, error: 'PRIVATE_PROVIDER_ERROR' }));
    const router = new NotificationRouter({ pool, defaultChannel: async () => 'none', now: () => new Date('2026-09-25T04:00:00Z'),
      senders: owner === 'unavailable' ? {} : { email: { channel: 'email', available: async () => true, send } } });
    await notifyFuturesSourceFailure(ctx, owner, runId, { router: async () => router, timeoutMs: 1000 });
    expect(await receipt(runId)).toMatchObject({ status, reason });
    expect(JSON.stringify(await receipt(runId))).not.toContain('PRIVATE_PROVIDER_ERROR');
    expect(send).toHaveBeenCalledTimes(owner === 'failure' ? 1 : 0);
    await notifyFuturesSourceFailure(ctx, owner, runId);
    expect(routing.build).not.toHaveBeenCalled();
  });

  it('records the actual fallback channel when the real router cannot attempt the requested channel', async () => {
    const runId = await insert({ owner: 'fallback' });
    await upsertUserPref(pool, { userSub: 'fallback', topic: FUTURES_SOURCE_ALERT_TOPIC, channel: 'sms', enabled: true,
      quietHoursStart: null, quietHoursEnd: null, phone: null, telegramChatId: null });
    const send = vi.fn(async () => ({ delivered: true }));
    const router = new NotificationRouter({ pool, defaultChannel: async () => 'none',
      senders: { email: { channel: 'email', available: async () => true, send } } });
    await notifyFuturesSourceFailure(ctx, 'fallback', runId, { router: async () => router, timeoutMs: 1000 });
    expect(await receipt(runId)).toMatchObject({ status: 'delivered', channel: 'email', fallbackFrom: 'sms' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung router build, retains unknown delivery, and never overwrites it with a late result', async () => {
    const runId = await insert();
    let resolveBuild!: (value: Pick<NotificationRouter, 'notify'>) => void;
    const router = vi.fn(() => new Promise<Pick<NotificationRouter, 'notify'>>(resolve => { resolveBuild = resolve; }));
    await notifyFuturesSourceFailure(ctx, 'owner-a', runId, { router, timeoutMs: 20 });
    expect(await receipt(runId)).toMatchObject({ status: 'unknown', reason: 'delivery-deadline' });
    const lateNotify = vi.fn(async (): Promise<NotifyOutcome> => ({ delivered: true, channel: 'email' }));
    resolveBuild({ notify: lateNotify });
    await notifyFuturesSourceFailure(ctx, 'owner-a', runId, { router, timeoutMs: 20 });
    expect(router).toHaveBeenCalledTimes(1);
    expect(lateNotify).not.toHaveBeenCalled();
    expect((await receipt(runId))?.status).toBe('unknown');
  });

  it('leaves a failed receipt-write claim uncertain and never repeats its completed outward hop', async () => {
    const runId = await insert();
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes('source_alert=source_alert || $3')) throw new Error('fixture receipt write unavailable');
      return pool.query(sql, values);
    });
    await notifyFuturesSourceFailure({ ...ctx, pool: { query } } as unknown as AppContext, 'owner-a', runId);
    expect((await receipt(runId))?.status).toBe('claimed');
    await notifyFuturesSourceFailure(ctx, 'owner-a', runId);
    expect(routing.notify).toHaveBeenCalledTimes(1);
  });
  it('keeps a thrown transport or late send uncertain without leaking errors or retrying', async () => {
    const thrown = await insert();
    routing.notify.mockRejectedValueOnce(new Error('PRIVATE_TRANSPORT_ERROR'));
    await notifyFuturesSourceFailure(ctx, 'owner-a', thrown);
    expect(await receipt(thrown)).toMatchObject({ status: 'unknown', reason: 'delivery-exception' });
    expect(JSON.stringify(await receipt(thrown))).not.toContain('PRIVATE_TRANSPORT_ERROR');
    const late = await insert();
    let complete!: (value: NotifyOutcome) => void;
    const notify = vi.fn(() => new Promise<NotifyOutcome>(resolve => { complete = resolve; }));
    await notifyFuturesSourceFailure(ctx, 'owner-a', late, { router: async () => ({ notify }), timeoutMs: 20 });
    complete({ delivered: true, channel: 'email' });
    await notifyFuturesSourceFailure(ctx, 'owner-a', late, { router: async () => ({ notify }), timeoutMs: 20 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await receipt(late)).toMatchObject({ status: 'unknown', reason: 'delivery-deadline' });
  });
});
