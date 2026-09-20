/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-136 D6 S-1 alert rail against the REAL oshal Postgres (fail-loud when the stack is down): announceEventAlert lands a `done` jarvis_tasks row under the owner whose result carries the EDGAR URL and routes ONE notification on the 'trading-events' topic through an injected router; the shelf id carries the FULL planId + an owner hash so two owners' plans can never share a row (jarvis_tasks.id is a global PK with ON CONFLICT DO UPDATE) and a retry is idempotent; a throwing router never fails the caller; alertFirstS1 is claim-first (one `s1_alerted` timeline event, one delivery, however many times the hook is reached; a throwing seam still leaves the claim); the S-1 text names the FILING date, never "today"; normalizePricingDate refuses 2026-02-30 and garbage. Run with --no-file-parallelism (concurrent schema bootstrap races). The outward transports themselves are covered by notification-fanout / notification-prefs-router specs.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review round 2: normalizePricingDate also refuses a WEEKEND date (the reminder leg runs weekdays only, so a Saturday pricing date gave a T-0 whose due minute could never be reached).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Review round 3: the outward hop is now proven BOUNDED (a router that never resolves costs one deadline, not the tick — announceEventAlert returns notified:null and the shelf row still lands, and alertFirstS1 with a hanging seam still returns having claimed), notifyTimeoutMs config is pinned (env → clamped → 20s default), and alertNotifierFrom is pinned as the seam the state-machine hook passes: a deps bag carrying `notify` wins, anything else falls back to the real two-rail announce. That resolver is what keeps the design's injectable notify seam without the plan module's EventPlanDeps having to change before the hook can land.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The database this spec connects to is resolved by tests/helpers/spec-database-url.ts and has NO default. The fallback it replaces resolved to the published port of the local stack — the operator's LIVE trading Postgres — so any run that set no environment variable created and destroyed data in production, which is what happened twice on 2026-09-14. An unpointed run now throws and names the variable to set; a value that lands on the live stack is refused unless the run acknowledges it explicitly.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | This spec now STARTS its own PostgreSQL and removes it, the way its trading-event-plans sibling does, instead of taking an address from the environment at all. Refusing an unpointed run made the accident impossible but not the run: nothing supplied OSHAL_TEST_DSN, so `const DSN = specDatabaseUrl(...)` threw at MODULE LOAD and vitest reported a failed suite with zero cases executed — a guard that cannot run is not protecting the alert rail, it is only silent about it. A private server is both safe and executable, and there is no longer any value a caller can supply that would reach a deployment. The DELETE-by-sub teardown for both subs goes with it: the container is destroyed, so no cleanup SQL runs anywhere, which is precisely the statement class that ran in production twice on 2026-09-14. The `ALTER TABLE oshal_trading_event_plans OWNER TO oshal_app` handoff is gone too — that role exists only in the shared deployment this spec no longer touches, and its `IF EXISTS (SELECT 1 FROM pg_roles ...)` guard made it a no-op on a private server. The pool's `max: 4` and `-c row_security=off` carry over unchanged onto the fixture. One setting is NEW rather than carried: `statementTimeoutMs: 60_000`. The old pool declared no statement timeout at all, and the fixture's own default is 15 s, which a cold container plus schema bootstrap can exceed on a loaded box; it matches the trading-event-plans reference conversion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import {
  announceEventAlert, alertFirstS1, s1FiledAlert, eventAlertTaskId, eventAlertTopic, normalizePricingDate, claimTimelineEvent,
  alertNotifierFrom, notifyTimeoutMs, withDeliveryDeadline,
  type EventAlert, type EventAlertDeps, type AlertPlanRef, type S1Filing,
} from '../../src/app/trading-event-alerts';
import { ensureEventPlansSchema, createEventPlan, normalizeEventPlanParams, getEventPlan, type EventPlanRow, type EdgarHit } from '../../src/app/trading-event-plans';
import { ensureBooksSchema, ensureLegacyBooks, legacyBook } from '../../src/app/trading-books-store';
import { ensureTradingSchema } from '../../src/app/trading-engine';
import type { AppContext } from '../../src/app/composition/app-context';
import type { NotifyOutcome } from '../../src/features/notifications';
import { DisposablePostgres } from '../helpers/disposable-postgres';

// A PostgreSQL this file owns: started here, removed in afterAll, reachable from nothing else.
// `row_security=off` keeps the superuser's reads across the FORCE-RLS plan table explicit.
const database = new DisposablePostgres({
  purpose: 'trading-event-alerts', database: 'trading_fixture', memory: '384m', max: 4,
  statementTimeoutMs: 60_000, options: '-c row_security=off',
});
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-evta-${RUN}`;
const SUB_B = `spec-evtb-${RUN}`;
let pool: Pool;
const ctx = () => ({ pool } as unknown as AppContext);

const S1 = { form: 'S-1', date: '2026-09-15', url: 'https://www.sec.gov/x/s1.htm' };

/** A fake per-user router: records every notify() and answers a fixed outcome (or throws). */
function fakeRouter(outcome: NotifyOutcome = { delivered: true, channel: 'email', id: 'm-1' }, throwing = false) {
  const calls: Array<{ sub: string; topic: string; subject: string; body: string; shortText?: string }> = [];
  const deps: EventAlertDeps = {
    pool: pool as never,
    router: async () => ({ notify: async (sub: string, topic: string, m: { subject: string; body: string; shortText?: string }) => { if (throwing) throw new Error('router down'); calls.push({ sub, topic, ...m }); return outcome; } }),
  };
  return { calls, deps };
}

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `spec-secret-${RUN}`;
  process.env.TRADING_MAX_NOTIONAL_USD = '50000'; process.env.TRADING_MAX_QTY = '100000';
  pool = await database.start();
  await ensureBooksSchema(pool as never); await ensureTradingSchema(pool as never); await ensureEventPlansSchema(pool as never);
  await ensureLegacyBooks(pool as never, SUB);
}, 120_000);

// No DELETE pass: the whole server goes away, so there is nothing to clean and nowhere to clean it.
afterAll(async () => { await database.stop(); });

describe('pure pieces', () => {
  it('the shelf task id carries the FULL planId and differs per owner (global-PK collision guard)', () => {
    const planId = crypto.randomUUID();
    const a = eventAlertTaskId(SUB, planId, 's1'), b = eventAlertTaskId(SUB_B, planId, 's1');
    expect(a).toContain(planId); expect(a).toContain('-s1-');
    expect(a).not.toBe(b);
    expect(eventAlertTaskId(SUB, planId, 't3')).not.toBe(a);
  });
  it('the topic is trading-events unless TRADING_EVENT_ALERT_TOPIC names another (garbage → default)', () => {
    const prev = process.env.TRADING_EVENT_ALERT_TOPIC;
    delete process.env.TRADING_EVENT_ALERT_TOPIC; expect(eventAlertTopic()).toBe('trading-events');
    process.env.TRADING_EVENT_ALERT_TOPIC = 'ipo-alerts'; expect(eventAlertTopic()).toBe('ipo-alerts');
    process.env.TRADING_EVENT_ALERT_TOPIC = 'bad topic!'; expect(eventAlertTopic()).toBe('trading-events');
    if (prev === undefined) delete process.env.TRADING_EVENT_ALERT_TOPIC; else process.env.TRADING_EVENT_ALERT_TOPIC = prev;
  });
  it('normalizePricingDate: YYYY-MM-DD that round-trips, else null — never a guessed date', () => {
    expect(normalizePricingDate('2026-10-15')).toBe('2026-10-15');
    expect(normalizePricingDate(' 2026-10-15 ')).toBe('2026-10-15');
    expect(normalizePricingDate('2026-02-30')).toBeNull();
    expect(normalizePricingDate('2026-1-5')).toBeNull();
    expect(normalizePricingDate('2026-10-17')).toBeNull();   // Saturday — an offering prices on a trading day, and the leg is weekdays-only
    expect(normalizePricingDate('2026-10-18')).toBeNull();   // Sunday
    expect(normalizePricingDate('2026-10-16')).toBe('2026-10-16');   // Friday
    expect(normalizePricingDate('next tuesday')).toBeNull();
    expect(normalizePricingDate(null)).toBeNull();
    expect(normalizePricingDate(20261015)).toBeNull();
  });
  it('the S-1 alert names the FILING date and links the filing — never "today"', () => {
    const a = s1FiledAlert({ planId: 'p', name: '401k 10% plan', bookRef: 'ira-1', params: { issuer: 'Anthropic' } }, S1);
    expect(a.key).toBe('s1');
    expect(a.subject).toContain('filed 2026-09-15');
    expect(a.body).toContain('is on EDGAR (S-1, filed 2026-09-15)');
    expect(a.body).toContain('401k 10% plan'); expect(a.body).toContain('ira-1'); expect(a.body).toContain('Conditional Offer to Purchase');
    expect(a.url).toBe(S1.url); expect(a.shortText).toContain(S1.url); expect(a.shortText.length).toBeLessThanOrEqual(160);
    expect(a.subject + a.body).not.toMatch(/today/i);
  });
});

describe('announceEventAlert — the two rails against the real DB', () => {
  const planId = crypto.randomUUID();
  const alert: EventAlert = { key: 's1', subject: 'Anthropic: S-1 filed', body: 'The S-1 is on EDGAR.', url: S1.url, shortText: `Anthropic S-1 — ${S1.url}` };

  it('lands a done jarvis_tasks row for the owner (result carries the URL) and routes ONE notification on the trading-events topic', async () => {
    const r = fakeRouter();
    const out = await announceEventAlert(ctx(), SUB, planId, alert, r.deps);
    expect(out.jarvisTaskId).toBe(eventAlertTaskId(SUB, planId, 's1'));
    expect(out.notified).toEqual({ delivered: true, channel: 'email', id: 'm-1' });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ sub: SUB, topic: 'trading-events', subject: 'Anthropic: S-1 filed' });
    expect(r.calls[0].body).toContain(S1.url);
    const row = (await pool.query('SELECT user_sub, status, result, title, kind FROM jarvis_tasks WHERE id = $1', [out.jarvisTaskId])).rows[0];
    expect(row).toMatchObject({ user_sub: SUB, status: 'done', title: 'Anthropic: S-1 filed', kind: 'simple' });
    expect(String(row.result)).toContain(S1.url);
  }, 30_000);

  it('a retry of the same alert is idempotent on the shelf (one row) and two owners never share a row', async () => {
    const rb = fakeRouter();
    await announceEventAlert(ctx(), SUB_B, planId, { ...alert, subject: 'B sees it too' }, rb.deps);   // same plan id + key, other owner
    const ra = fakeRouter();
    await announceEventAlert(ctx(), SUB, planId, alert, ra.deps);                                        // owner A again
    const rows = (await pool.query('SELECT id, user_sub, title FROM jarvis_tasks WHERE id = ANY($1::text[]) ORDER BY user_sub', [[eventAlertTaskId(SUB, planId, 's1'), eventAlertTaskId(SUB_B, planId, 's1')]])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.user_sub === SUB)!.title).toBe('Anthropic: S-1 filed');
    expect(rows.find((r) => r.user_sub === SUB_B)!.title).toBe('B sees it too');
    expect((await pool.query('SELECT count(*)::int AS n FROM jarvis_tasks WHERE user_sub = $1', [SUB])).rows[0].n).toBe(1);
  }, 30_000);

  it('a throwing router never fails the caller — the shelf row still lands, notified is null', async () => {
    const r = fakeRouter(undefined, true);
    const other = crypto.randomUUID();
    const out = await announceEventAlert(ctx(), SUB, other, alert, r.deps);
    expect(out.notified).toBeNull();
    expect((await pool.query('SELECT status FROM jarvis_tasks WHERE id = $1', [out.jarvisTaskId])).rows[0].status).toBe('done');
  }, 30_000);
});

describe('alertFirstS1 — the state-machine hook is claim-first and once-only', () => {
  const book = legacyBook(SUB, 'paper');

  it('first call: one timeline s1_alerted + one delivery; second call: nothing more (whatever branch reached it)', async () => {
    const plan = await createEventPlan(pool as never, SUB, { book, name: 'watch', params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }) });
    const seen: EventAlert[] = [];
    const notify = async (_c: AppContext, _s: string, _p: string, a: EventAlert) => { seen.push(a); };
    expect(await alertFirstS1(ctx(), SUB, plan, S1, notify)).toBe(true);
    expect(await alertFirstS1(ctx(), SUB, plan, S1, notify)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe('s1'); expect(seen[0].url).toBe(S1.url);
    const p = (await getEventPlan(pool as never, SUB, plan.planId))!;
    expect(p.timeline.filter((e) => e.event === 's1_alerted')).toHaveLength(1);
    expect(p.timeline.find((e) => e.event === 's1_alerted')!.detail).toBe(S1.url);
  }, 30_000);

  it('a throwing delivery seam still leaves the claim (no retry storm) and never throws into the tick', async () => {
    const plan = await createEventPlan(pool as never, SUB, { book, name: 'watch-2', params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }) });
    const notify = async () => { throw new Error('router exploded'); };
    await expect(alertFirstS1(ctx(), SUB, plan, S1, notify)).resolves.toBe(true);
    const p = (await getEventPlan(pool as never, SUB, plan.planId))!;
    expect(p.timeline.filter((e) => e.event === 's1_alerted')).toHaveLength(1);
    expect(p.timeline.some((e) => e.event === 'tick_error')).toBe(false);
  }, 30_000);

  it('claimTimelineEvent is owner-scoped: another sub cannot claim on this plan', async () => {
    const plan = await createEventPlan(pool as never, SUB, { book, name: 'watch-3', params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }) });
    expect(await claimTimelineEvent(pool as never, SUB_B, plan.planId, 's1_alerted')).toBe(false);
    expect(await claimTimelineEvent(pool as never, SUB, plan.planId, 's1_alerted')).toBe(true);
  }, 30_000);
});

describe('the outward hop is bounded (a wedged sender must not stall the leg tick that raised the alert)', () => {
  const planId = crypto.randomUUID();
  const alert: EventAlert = { key: 's1', subject: 'Anthropic: S-1 filed', body: 'The S-1 is on EDGAR.', url: S1.url, shortText: 'Anthropic S-1' };
  /** A router whose notify NEVER settles — the real failure shape of a hung Gmail/Twilio send. */
  const hangingDeps = (): EventAlertDeps => ({ pool: pool as never, router: async () => ({ notify: () => new Promise(() => {}) as Promise<never> }) });

  it('config: TRADING_EVENT_NOTIFY_TIMEOUT_MS, clamped, default 20s', () => {
    const prev = process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS;
    delete process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS; expect(notifyTimeoutMs()).toBe(20_000);
    process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS = '5'; expect(notifyTimeoutMs()).toBe(20_000);            // under the floor
    process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS = '999999'; expect(notifyTimeoutMs()).toBe(20_000);       // over the ceiling
    process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS = 'soon'; expect(notifyTimeoutMs()).toBe(20_000);
    process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS = '4500'; expect(notifyTimeoutMs()).toBe(4500);
    if (prev === undefined) delete process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS; else process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS = prev;
  });

  it('withDeliveryDeadline gives up on a hung send, keeps a late rejection handled, and clears its timer on a fast one', async () => {
    await expect(withDeliveryDeadline(new Promise(() => {}), 60)).rejects.toThrow(/exceeded 60ms/);
    let boom: (e: Error) => void = () => {};
    const late = new Promise((_r, rej) => { boom = rej; });
    await expect(withDeliveryDeadline(late, 40)).rejects.toThrow(/exceeded/);
    boom(new Error('the sender failed after we stopped waiting'));   // must NOT become an unhandled rejection
    await new Promise((r) => setTimeout(r, 30));
    expect(await withDeliveryDeadline(Promise.resolve('sent'), 10_000)).toBe('sent');
  }, 30_000);

  it('a router that never answers costs ONE deadline, not the tick: the shelf row lands, notified is null', async () => {
    process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS = '1000';   // the floor; below it the accessor clamps back to the 20s default
    try {
      const t0 = Date.now();
      const out = await announceEventAlert(ctx(), SUB, planId, alert, hangingDeps());
      expect(out.notified).toBeNull();
      expect(Date.now() - t0).toBeLessThan(8_000);   // unbounded would be forever; the 20s default would blow this too
      expect((await pool.query('SELECT status FROM jarvis_tasks WHERE id = $1', [out.jarvisTaskId])).rows[0].status).toBe('done');
    } finally { delete process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS; }
  }, 30_000);

  it('alertFirstS1 with a hung seam still returns (claim stands) instead of holding stepWatching open', async () => {
    process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS = '1000';   // the floor; below it the accessor clamps back to the 20s default
    try {
      const plan = await createEventPlan(pool as never, SUB, { book: legacyBook(SUB, 'paper'), name: 'hang', params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }) });
      const t0 = Date.now();
      expect(await alertFirstS1(ctx(), SUB, plan, S1, () => new Promise(() => {}))).toBe(true);
      expect(Date.now() - t0).toBeLessThan(8_000);   // unbounded would be forever; the 20s default would blow this too
      expect((await getEventPlan(pool as never, SUB, plan.planId))!.timeline.filter((e) => e.event === 's1_alerted')).toHaveLength(1);
    } finally { delete process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS; }
  }, 30_000);
});

describe('alertNotifierFrom — the seam the kernel hook passes (design CORE 2c, without the plan module having to change first)', () => {
  it('a deps bag carrying notify wins; anything else falls back to the real two-rail announce', async () => {
    const seen: string[] = [];
    const injected = async (_c: AppContext, _s: string, p: string) => { seen.push(p); };
    expect(alertNotifierFrom({ notify: injected })).toBe(injected);
    for (const bag of [undefined, null, {}, { notify: 'nope' }, { now: () => new Date() }]) expect(alertNotifierFrom(bag)).toBe(announceEventAlert);
    // and it composes with the hook exactly as the H4 line does
    const plan = await createEventPlan(pool as never, SUB, { book: legacyBook(SUB, 'paper'), name: 'seam', params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }) });
    expect(await alertFirstS1(ctx(), SUB, plan, S1, alertNotifierFrom({ notify: injected }))).toBe(true);
    expect(seen).toEqual([plan.planId]);
    expect((await pool.query('SELECT count(*)::int AS n FROM jarvis_tasks WHERE id = $1', [eventAlertTaskId(SUB, plan.planId, 's1')])).rows[0].n).toBe(0);   // the injected seam really replaced BOTH rails
  }, 30_000);
});

describe('hook contract (the state machine wires these by name — pinned so the wiring cannot drift silently)', () => {
  it('exports alertFirstS1(ctx, sub, plan, s1[, notify]) and stays a leaf (no static import of the plan/clock modules)', () => {
    expect(typeof alertFirstS1).toBe('function');
    expect(alertFirstS1.length).toBeGreaterThanOrEqual(4);
    expect(typeof alertNotifierFrom).toBe('function');   // the hook line is alertFirstS1(ctx, sub, plan, s1, alertNotifierFrom(deps))
    const src = readFileSync(path.resolve(process.cwd(), 'src/app/trading-event-alerts.ts'), 'utf8');
    expect(src).not.toMatch(/^import .* from '\.\/trading-event-plans'/m);
    expect(src).not.toMatch(/^import .* from '\.\/trading-dated-orders'/m);
    expect(src).not.toMatch(/^import .* from '\.\/routes\/notify-routes'/m);   // router is a lazy dynamic import per fire
    expect(src).toContain("import('./routes/notify-routes.js')");
  });
  it('the state machine can pass its OWN values: an EventPlanRow is an AlertPlanRef and an EdgarHit is an S1Filing (compile-time)', () => {
    // The wiring is one line in stepWatching — `if (s1 && !plan.filings.s1) await alertFirstS1(ctx, sub, plan, s1, alertNotifierFrom(deps));`
    // — so the hook's parameter types must accept the plan module's row and hit types unchanged. This
    // assignment IS the assertion: it stops compiling the moment either shape drifts.
    const asPlan: AlertPlanRef = {} as EventPlanRow;
    const asFiling: S1Filing = {} as EdgarHit;
    expect([typeof asPlan, typeof asFiling]).toEqual(['object', 'object']);
  });
});
