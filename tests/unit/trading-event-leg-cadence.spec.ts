/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-136 D4 follow-up guards for the per-minute trading-events leg. (1) isFullTick is stateless + minute-aligned (ET minute % TRADING_EVENTS_FULL_TICK_MINUTES); scheduleFireInstant judges the schedule's DUE minute, not the poll clock. (2) legWindowFromCron derives the dated-order window from the leg cron — the v1 '*\/5 9-16' yields the hand-typed v1 window, the default yields 07:00–19:59. (3) migrateEventLegSchedules against the REAL Redis schedule store (oshal-local-redis, a spec-unique key prefix, cleaned up after): a v1-cron leg is rewritten in place (same id, executionCount/lastRunAt preserved, timezone set) and its next-run ZSET score is re-indexed to the new cron's next minute; a paused leg stays paused and un-indexed; a current leg and a foreign taskType are untouched; a second run migrates 0. (4) against the live Postgres: an armed plan does NOT step on a non-full fire and DOES step on a full fire of dispatchTradingEventSchedule. (5) source pins: the runtime wires the migration before runner.start, the dispatch keeps tickDatedOrders outside the full branch and catches a plans failure. Run with --no-file-parallelism.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Both servers are now started by this file and removed when it finishes. Entry 2 stopped the Postgres half from reaching the operator's data but left the Redis half resolving OSHAL_REDIS_PORT, which on this box names the port the RUNNING swarm's Redis listens on — the seeding case wrote schedules and the teardown deleted keys in the live scheduler's own store. Refusing an unpointed run was the wrong shape of answer for a spec that must cross a real next-run ZSET: there is now nothing to point, because the fixture starts its own Postgres and its own Redis. The key-prefix sweep and the per-table DELETE pass are gone with them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import Redis from 'ioredis';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { RedisScheduleStore, ScheduleService } from '../../src/features/scheduling';
import {
  EVENT_PLANS_CRON, EVENT_PLANS_TIMEZONE, isFullTick, fullTickMinutes, scheduleFireInstant, legWindowFromCron, migrateEventLegSchedules,
  eventPlanTaskType, ensureEventPlansSchema, createEventPlan, armEventPlan, getEventPlan, normalizeEventPlanParams, dispatchTradingEventSchedule,
} from '../../src/app/trading-event-plans';
import { ensureBooksSchema, ensureLegacyBooks, legacyBook } from '../../src/app/trading-books-store';
import { ensureTradingSchema } from '../../src/app/trading-engine';
import type { AppContext } from '../../src/app/composition/app-context';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { DisposableRedis } from '../helpers/disposable-redis';

// A Postgres and a Redis this file owns: started here, removed in afterAll, reachable from nothing
// else. Both boundaries are real — the migration guard's whole point is that it crosses the actual
// next-run ZSET — but neither is the operator's.
const database = new DisposablePostgres({
  purpose: 'trading-event-leg-cadence', database: 'trading_fixture', memory: '384m', max: 4,
  statementTimeoutMs: 60_000, options: '-c row_security=off',
});
const cache = new DisposableRedis({ purpose: 'trading-event-leg-cadence' });

const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-cadence-${RUN}`;
const PREFIX = `oshal:scheduler-spec-${RUN}`;
const V1_CRON = '*/5 9-16 * * 1-5';
const AGENT_ID = '00000000-0000-4000-8000-000000000032';
const src = (rel: string) => readFileSync(path.resolve(__dirname, '../../', rel), 'utf8');
const nextOf = (cron: string, from: Date) => CronExpressionParser.parse(cron, { currentDate: from, tz: EVENT_PLANS_TIMEZONE }).next().getTime();

let pool: Pool; let redis: Redis; let store: RedisScheduleStore; let svc: ScheduleService;
const ctx = () => ({ pool } as unknown as AppContext);

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `spec-secret-${RUN}`;
  process.env.TRADING_MAX_NOTIONAL_USD = '50000'; process.env.TRADING_MAX_QTY = '100000';
  pool = await database.start();
  const redisUrl = (await cache.start()).url;
  redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  await redis.connect(); await redis.ping();
  store = new RedisScheduleStore({ redisUrl, keyPrefix: PREFIX });
  svc = new ScheduleService(store, async (s) => ({ success: true, scheduleId: s.id }), { defaultTargetAgentId: AGENT_ID, ensureSchedulingEnabled: async () => undefined });
  await ensureBooksSchema(pool as never); await ensureTradingSchema(pool as never); await ensureEventPlansSchema(pool as never);
  await pool.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN EXECUTE 'ALTER TABLE oshal_trading_event_plans OWNER TO oshal_app'; END IF; END $$;`);
  await ensureLegacyBooks(pool as never, SUB);
}, 120_000);

// No key sweep and no DELETE pass: both servers go away, so there is nothing to clean and nowhere
// to clean it. The clients are closed FIRST so ioredis is not reconnecting to a removed container.
afterAll(async () => {
  await store?.close().catch(() => {}); await redis?.quit().catch(() => {});
  await cache.stop(); await database.stop();
});

describe('full tick — stateless, minute-aligned, judged on the DUE minute', () => {
  const et = (hhmmZ: string) => new Date(`2026-09-09T${hhmmZ}:00Z`); // EDT: 13:35Z = 09:35 ET
  it('the ET minute divisible by TRADING_EVENTS_FULL_TICK_MINUTES (default 5) is a full tick; no in-process memory', () => {
    delete process.env.TRADING_EVENTS_FULL_TICK_MINUTES;
    expect(fullTickMinutes()).toBe(5);
    expect(isFullTick(et('13:30'))).toBe(true); expect(isFullTick(et('13:35'))).toBe(true); expect(isFullTick(et('13:00'))).toBe(true);
    expect(isFullTick(et('13:31'))).toBe(false); expect(isFullTick(et('13:34'))).toBe(false); expect(isFullTick(et('13:36'))).toBe(false);
    // same instant twice → same answer (a Map-based throttle would say true then false)
    expect(isFullTick(et('13:35'))).toBe(true);
    process.env.TRADING_EVENTS_FULL_TICK_MINUTES = '1';
    expect(isFullTick(et('13:31'))).toBe(true);
    process.env.TRADING_EVENTS_FULL_TICK_MINUTES = '0'; expect(fullTickMinutes()).toBe(5);   // nonsense → default
    delete process.env.TRADING_EVENTS_FULL_TICK_MINUTES;
  });
  it('scheduleFireInstant uses the schedule\'s nextRunAt (the cron minute), falling back to the clock', () => {
    expect(scheduleFireInstant({ nextRunAt: '2026-09-09T13:35:00.000Z' }).toISOString()).toBe('2026-09-09T13:35:00.000Z');
    expect(Math.abs(scheduleFireInstant({ nextRunAt: null }).getTime() - Date.now())).toBeLessThan(5_000);
    expect(Math.abs(scheduleFireInstant({ nextRunAt: 'garbage' }).getTime() - Date.now())).toBeLessThan(5_000);
  });
});

describe('one source of truth — the dated-order window is the leg cron\'s window', () => {
  it('default cron → 07:00–19:59 ET; the v1 cron → the v1 hand-typed 09:00–16:55', () => {
    expect(EVENT_PLANS_CRON).toBe(process.env.TRADING_EVENTS_CRON || '* 7-19 * * 1-5');
    expect(legWindowFromCron('* 7-19 * * 1-5')).toEqual({ startMin: 7 * 60, endMin: 19 * 60 + 59 });
    expect(legWindowFromCron(V1_CRON)).toEqual({ startMin: 9 * 60, endMin: 16 * 60 + 55 });
    expect(legWindowFromCron('*/15 4,20 * * *')).toEqual({ startMin: 4 * 60, endMin: 20 * 60 + 45 });
  });
});

describe('migrateEventLegSchedules — REAL Redis schedule store, spec-unique key prefix', () => {
  const legA = eventPlanTaskType(`${SUB}-A`), legB = eventPlanTaskType(`${SUB}-B`), legP = eventPlanTaskType(`${SUB}-P`);
  const taskData = (sub: string) => ({ prompt: 'Event playbooks — IPO watch/entry/exit state machine', userSub: sub });
  let idA = '', idP = '', oldScoreA = 0, t0 = new Date();

  it('seeds: a v1-cron active leg with history, a v1-cron PAUSED leg, a current-cron leg, and a foreign schedule', async () => {
    const a = await svc.createSchedule({ taskType: legA, schedule: V1_CRON, timezone: EVENT_PLANS_TIMEZONE, ownerSub: `${SUB}-A`, queue: 'intelligent-trades', taskData: taskData(`${SUB}-A`) });
    idA = a.id;
    await store.saveSchedule({ ...a, executionCount: 7, lastRunAt: '2026-09-04T18:00:00.000Z' });
    const p = await svc.createSchedule({ taskType: legP, schedule: V1_CRON, timezone: EVENT_PLANS_TIMEZONE, ownerSub: `${SUB}-P`, queue: 'intelligent-trades', taskData: taskData(`${SUB}-P`) });
    idP = p.id; await svc.pauseSchedule(idP);
    await svc.createSchedule({ taskType: legB, schedule: EVENT_PLANS_CRON, timezone: EVENT_PLANS_TIMEZONE, ownerSub: `${SUB}-B`, queue: 'intelligent-trades', taskData: taskData(`${SUB}-B`) });
    await svc.createSchedule({ taskType: `reminder-${RUN}`, schedule: V1_CRON, ownerSub: `${SUB}-A`, taskData: { prompt: 'not a trading leg', targetAgent: AGENT_ID } });
    const scoreA = await redis.zscore(`${PREFIX}:next-run`, idA);
    oldScoreA = Number(scoreA);
    expect(oldScoreA).toBe(Date.parse(a.nextRunAt!));
    expect(await redis.zscore(`${PREFIX}:next-run`, idP)).toBeNull();
  });

  it('rewrites ONLY the stale legs in place: same id, executionCount/lastRunAt kept, status kept, timezone set, next-run ZSET re-scored', async () => {
    t0 = new Date();
    const out = await migrateEventLegSchedules(svc);
    const t1 = new Date();
    expect(out).toEqual({ scanned: 3, migrated: 2 });
    const a = (await svc.getSchedule(idA))!;
    expect(a).toMatchObject({ id: idA, taskType: legA, cron: EVENT_PLANS_CRON, timezone: EVENT_PLANS_TIMEZONE, status: 'active', executionCount: 7, lastRunAt: '2026-09-04T18:00:00.000Z', ownerSub: `${SUB}-A`, queue: 'intelligent-trades' });
    // the next-run index is the boundary the fix depends on: the ZSET score IS the new cron's next minute
    const score = Number(await redis.zscore(`${PREFIX}:next-run`, idA));
    expect(score).toBe(Date.parse(a.nextRunAt!));
    expect([nextOf(EVENT_PLANS_CRON, t0), nextOf(EVENT_PLANS_CRON, t1)]).toContain(score);
    expect(new Date(score).getUTCSeconds()).toBe(0);
    if (score === oldScoreA) expect(nextOf(V1_CRON, t0)).toBe(score);   // unchanged ONLY when both crons name the same next minute
    const p = (await svc.getSchedule(idP))!;
    expect(p).toMatchObject({ cron: EVENT_PLANS_CRON, status: 'paused', nextRunAt: null });
    expect(await redis.zscore(`${PREFIX}:next-run`, idP)).toBeNull();
    const all = await svc.listSchedules({ scope: 'all' });
    expect(all.find((r) => r.taskType === legB)!.cron).toBe(EVENT_PLANS_CRON);
    expect(all.find((r) => r.taskType === `reminder-${RUN}`)!.cron).toBe(V1_CRON);
    expect(all.filter((r) => r.taskType.startsWith('trading-events:')).length).toBe(3); // no duplicates minted
  });

  it('a second run is a no-op', async () => {
    expect(await migrateEventLegSchedules(svc)).toEqual({ scanned: 3, migrated: 0 });
  });
});

describe('the dispatch — plans step on a FULL fire only, against this file\'s own Postgres', () => {
  it('an armed plan stays armed on a non-full fire and moves to watching on the next full fire', async () => {
    const prev = process.env.TRADING_EVENT_PLANS; process.env.TRADING_EVENT_PLANS = 'true';
    try {
      const book = legacyBook(SUB, 'paper');
      const plan = await createEventPlan(pool as never, SUB, { book, name: 'cadence', params: normalizeEventPlanParams({ issuer: `Spec Cadence Issuer ${RUN}`, sizePctOfEquity: 5 }) });
      await armEventPlan(pool as never, SUB, plan.planId);
      const fire = (iso: string) => dispatchTradingEventSchedule(ctx(), { id: `s-${RUN}`, taskType: eventPlanTaskType(SUB), taskData: { userSub: SUB }, nextRunAt: iso } as never);
      expect((await fire('2026-09-09T13:36:00.000Z')).success).toBe(true);              // 09:36 ET — not a full tick
      const after1 = (await getEventPlan(pool as never, SUB, plan.planId))!;
      expect(after1.status).toBe('armed'); expect(after1.timeline.map((t) => t.event)).toEqual(['created', 'armed']);
      expect((await fire('2026-09-09T13:40:00.000Z')).success).toBe(true);              // 09:40 ET — full tick
      const after2 = (await getEventPlan(pool as never, SUB, plan.planId))!;
      expect(after2.status).toBe('watching'); expect(after2.timeline.at(-1)).toMatchObject({ event: 'watching' });
      await pool.query(`UPDATE oshal_trading_event_plans SET status = 'cancelled' WHERE user_sub = $1`, [SUB]);
    } finally { if (prev === undefined) delete process.env.TRADING_EVENT_PLANS; else process.env.TRADING_EVENT_PLANS = prev; }
  });
});

describe('source pins — wiring the guards above cannot see', () => {
  it('schedule-runtime migrates the legs BEFORE the runner starts, under the ENABLE_AGENT_SCHEDULER gate', () => {
    const rt = src('src/app/schedule-runtime.ts');
    const mig = rt.indexOf('void migrateEventLegSchedules(service)');
    expect(mig).toBeGreaterThan(rt.indexOf("if (process.env.ENABLE_AGENT_SCHEDULER === 'true') {"));
    expect(mig).toBeLessThan(rt.indexOf('runner.start(true);'));
    expect(rt).toContain(".finally(() => {\n        runner.start(true);");
  });
  it('the dispatch: full = isFullTick(scheduleFireInstant(schedule)); plans + lots inside `full ?`, a plans failure caught, dated orders on EVERY fire', () => {
    const plans = src('src/app/trading-event-plans.ts');
    expect(plans).toContain('const full = isFullTick(scheduleFireInstant(schedule));');
    expect(plans).toContain("const out = full ? await tickEventPlans(ctx, sub).catch(");
    expect(plans).toContain("const lots = full ? await import('./trading-pinned-lots.js')");
    const dated = plans.indexOf("const dated = await import('./trading-dated-orders.js').then((m) => m.tickDatedOrders(ctx, sub))");
    expect(dated).toBeGreaterThan(plans.indexOf("const lots = full ?"));
    expect(plans.slice(dated, dated + 40)).not.toContain('full ?');
  });
});
