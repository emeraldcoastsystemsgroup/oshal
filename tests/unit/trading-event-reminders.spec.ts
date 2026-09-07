/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-136 D6 COTP reminders against the REAL oshal Postgres (fail-loud when the stack is down): the FORCE-RLS reminders table with UNIQUE (plan_id, key); config accessors (URL https-only → Schwab client login root, hour clamped 9–16, days parsed/deduped); trading-day step-back (a Monday pricing's T-1 is the Friday); a DST-safe schedule (a March pricing date keeps 9:00 ET across the switch); reminder text derived from the computed deadline ('today'/'in N days' + the formatted ET instant — the fixed 'Deadline today' string is gone); the tick fires T-3/T-1/T-0 each exactly once at/after the ET hour with the schwab.com link, is idempotent across ticks, keeps already-sent keys sent after a pricing-date edit while later due instants recompute, records EXPIRED (no delivery) for a window the leg only saw after it closed (asleep box over a weekend), never fires for a cancelled plan, and a throwing delivery seam neither throws nor re-fires. Plus the compose passthrough pin for the four new env vars and the hook-contract pins. Run with --no-file-parallelism.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review round 2: a LATE reminder's wording is pinned to the fire-time clock (the stale 'N trading days away' is gone); a weekend pricing date is refused at the input; ensureEventRemindersSchema is proven memoized (zero statements on a repeat call — the leg fires every minute and walked every plan); and the kernel-wiring block (H1-H5 in trading-event-plans.ts) fails loud until the integrator applies the hooks, so the feature cannot ship dark with every other spec green.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Review round 3: every DB case gets its OWN owner (the injected clock moves backwards between cases, so one shared sub meant another case's plans could expire on this case's tick and the assertions had to filter by planId to survive); a hung delivery seam is proven not to stall the tick (TRADING_EVENT_NOTIFY_TIMEOUT_MS bounds it, the claim row stands, the other plan on the same tick still fires); the compose pin covers that fifth env var; and the H4 hook now has to pass the injectable seam (alertNotifierFrom(deps)) — pinned as H4b, because the seam-less form makes the plan module's own spec write real jarvis_tasks rows and build the real notification router.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import {
  ensureEventRemindersSchema, cotpUrl, cotpReminderHourEt, cotpReminderOffsets, shiftTradingDays, cotpDeadlineAt, cotpReminderSchedule,
  cotpReminderText, setEventPlanPricingDate, listEventReminders, tickEventReminders, type EventReminderDeps, type ReminderPlan,
} from '../../src/app/trading-event-reminders';
import { etWallToInstant, etWallParts, formatEt } from '../../src/app/trading-dated-orders';
import {
  ensureEventPlansSchema, createEventPlan, armEventPlan, disarmEventPlan, getEventPlan, normalizeEventPlanParams,
  tickEventPlans, dispatchTradingEventSchedule, isFullTick, type EventPlanDeps, type EdgarHit,
} from '../../src/app/trading-event-plans';
import type { EventAlert } from '../../src/app/trading-event-alerts';
import type { ScheduleRecord } from '../../src/features/scheduling';
import { ensureBooksSchema, ensureLegacyBooks, legacyBook } from '../../src/app/trading-books-store';
import { ensureTradingSchema, TradingError } from '../../src/app/trading-engine';
import type { AppContext } from '../../src/app/composition/app-context';

const DSN = process.env.OSHAL_TEST_DSN || `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-evtr-${RUN}`;
/** Every owner this run created, cleaned in afterAll. */
const SUBS: string[] = [SUB];
let pool: Pool;
const ctx = () => ({ pool } as unknown as AppContext);
const et = (date: string, time: string) => etWallToInstant(date, time);
/**
 * A fresh owner per DB case. tickEventReminders walks EVERY plan of the owner it is given and each case
 * injects its own clock — with one shared sub, a case set in October made an earlier case's November plan
 * expire on its tick, which is coupling the next person to add a case would pay for.
 */
async function caseSub(tag: string): Promise<string> {
  const sub = `spec-evtr-${RUN}-${tag}`;
  SUBS.push(sub);
  await ensureLegacyBooks(pool as never, sub);
  return sub;
}
const tick = async (sub: string, deps: EventReminderDeps) => (await tickEventReminders(ctx(), sub, deps)).fired;

/** A fake delivery seam: records every alert; optionally throws. */
function fakeNotify(throwing = false) {
  const seen: Array<{ planId: string; alert: EventAlert }> = [];
  const deps = (now: Date): EventReminderDeps => ({ now: () => now, notify: async (_c, _s, planId, alert) => { if (throwing) throw new Error('router exploded'); seen.push({ planId, alert }); } });
  return { seen, deps };
}
/** The plan module's deps, only for disarm (no venue is touched — the plan is still armed). */
const planDeps: EventPlanDeps = {
  now: () => new Date(), session: async () => 'closed', edgarSearch: async () => [], fetchText: async () => null,
  broker: (() => ({ configured: () => true, getAccount: async () => ({ equity: 0 }), getOrder: async () => { throw new Error('no venue'); }, cancelOrder: async () => undefined })) as unknown as EventPlanDeps['broker'],
  latestTrade: async () => null, place: (async () => { throw new Error('no venue'); }) as unknown as EventPlanDeps['place'],
};

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `spec-secret-${RUN}`;
  process.env.TRADING_MAX_NOTIONAL_USD = '50000'; process.env.TRADING_MAX_QTY = '100000';
  delete process.env.TRADING_COTP_URL; delete process.env.TRADING_COTP_REMINDER_HOUR_ET; delete process.env.TRADING_COTP_REMINDER_DAYS;
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try { await pool.query('SELECT 1'); } catch (error) {
    throw new Error(`trading-event-reminders requires the live oshal Postgres at ${DSN.replace(/:[^:@/]+@/, ':***@')} — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  await ensureBooksSchema(pool as never); await ensureTradingSchema(pool as never); await ensureEventPlansSchema(pool as never); await ensureEventRemindersSchema(pool as never);
  // The spec connects as the superuser; if IT creates a table first the api (oshal_app) gets 42501 on it.
  await pool.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN EXECUTE 'ALTER TABLE oshal_trading_event_plans OWNER TO oshal_app'; EXECUTE 'ALTER TABLE oshal_trading_event_reminders OWNER TO oshal_app'; END IF; END $$;`);
  await ensureLegacyBooks(pool as never, SUB);
}, 120_000);

afterAll(async () => {
  for (const sub of SUBS) {
    await pool.query(`DELETE FROM oshal_trading_event_reminders WHERE user_sub = $1`, [sub]).catch(() => {});
    await pool.query(`DELETE FROM oshal_trading_event_plans WHERE user_sub = $1`, [sub]).catch(() => {});
    await pool.query(`DELETE FROM oshal_trading_books WHERE user_sub = $1`, [sub]).catch(() => {});
    await pool.query(`DELETE FROM jarvis_tasks WHERE user_sub = $1`, [sub]).catch(() => {});   // once H4 is wired the real rail can write shelf rows here
  }
  await pool.end();
});

const book = (sub: string) => legacyBook(sub, 'paper');
async function armedPlan(sub: string, name: string, pricingDate: string): Promise<string> {
  const p = await createEventPlan(pool as never, sub, { book: book(sub), name, params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }) });
  await setEventPlanPricingDate(pool as never, sub, p.planId, pricingDate);
  await armEventPlan(pool as never, sub, p.planId);
  return p.planId;
}

describe('the tick against the real DB', () => {
  it('fires T-3, T-1 and T-0 each exactly once at/after 9:00 ET, idempotent across ticks, with the link and timeline events', async () => {
    const sub = await caseSub('a');
    const planId = await armedPlan(sub, 'A', '2026-10-15');
    const n = fakeNotify();
    expect(await tick(sub, n.deps(et('2026-10-12', '08:55')))).toEqual([]);
    expect(await tick(sub, n.deps(et('2026-10-12', '09:00')))).toEqual([`${planId}:t3:sent`]);
    expect(await tick(sub, n.deps(et('2026-10-12', '09:05')))).toEqual([]);
    expect(n.seen).toHaveLength(1); expect(n.seen[0].alert.key).toBe('t3'); expect(n.seen[0].alert.body).toContain(cotpUrl()); expect(n.seen[0].alert.body).toContain('Conditional Offer');
    expect(await tick(sub, n.deps(et('2026-10-14', '09:05')))).toEqual([`${planId}:t1:sent`]);
    expect(await tick(sub, n.deps(et('2026-10-15', '09:00')))).toEqual([`${planId}:t0:sent`]);
    expect(await tick(sub, n.deps(et('2026-10-15', '15:00')))).toEqual([]);
    expect(n.seen.map((x) => x.alert.key)).toEqual(['t3', 't1', 't0']);
    const rows = await listEventReminders(pool as never, sub, planId);
    expect(rows.map((r) => [r.key, r.status])).toEqual([['t3', 'sent'], ['t1', 'sent'], ['t0', 'sent']]);
    const p = (await getEventPlan(pool as never, sub, planId))!;
    expect(p.timeline.map((e) => e.event)).toEqual(expect.arrayContaining(['pricing_date_set', 'cotp_t3_sent', 'cotp_t1_sent', 'cotp_t0_sent']));
    expect(p.timeline.filter((e) => e.event === 'cotp_t3_sent')).toHaveLength(1);
    expect(p.status).toBe('armed');   // the reminders never touch the state machine
  }, 30_000);

  it('a pricing-date edit after a send: sent keys stay sent; later due instants and the deadline text recompute', async () => {
    const sub = await caseSub('b');
    const planId = await armedPlan(sub, 'B', '2026-10-15');
    const n = fakeNotify();
    expect(await tick(sub, n.deps(et('2026-10-12', '09:00')))).toEqual([`${planId}:t3:sent`]);
    await setEventPlanPricingDate(pool as never, sub, planId, '2026-10-22');
    expect(await tick(sub, n.deps(et('2026-10-19', '09:00')))).toEqual([]);   // the new T-3: t3 already sent, stays sent
    expect(await tick(sub, n.deps(et('2026-10-21', '09:00')))).toEqual([`${planId}:t1:sent`]);
    expect(n.seen[1].alert.body).toContain('before Wed Oct 21, 2026 at 4:00 PM ET');
    expect((await listEventReminders(pool as never, sub, planId)).filter((r) => r.key === 't3')).toHaveLength(1);
  }, 30_000);

  it('an asleep box: a Monday pricing seen first on Monday 9:00 ET → T-3 and T-1 EXPIRE (no delivery, the closed window named), T-0 fires', async () => {
    const sub = await caseSub('c');
    const planId = await armedPlan(sub, 'C', '2026-10-19');
    const n = fakeNotify();
    expect(await tick(sub, n.deps(et('2026-10-19', '09:00')))).toEqual([`${planId}:t3:expired`, `${planId}:t1:expired`, `${planId}:t0:sent`]);
    expect(n.seen.map((x) => x.alert.key)).toEqual(['t0']);
    const p = (await getEventPlan(pool as never, sub, planId))!;
    const t1 = p.timeline.find((e) => e.event === 'cotp_t1_expired')!;
    expect(t1.detail).toContain('Fri Oct 16, 2026 at 4:00 PM ET');
    expect(p.timeline.some((e) => e.event === 'cotp_t1_sent')).toBe(false);
    expect(await tick(sub, n.deps(et('2026-10-19', '09:05')))).toEqual([]);
  }, 30_000);

  it('a cancelled (disarmed) plan never fires, and a plan with no pricing date is not even examined', async () => {
    const sub = await caseSub('d');
    const planId = await armedPlan(sub, 'D', '2026-10-15');
    await disarmEventPlan(ctx(), sub, planId, planDeps);
    const noDate = await createEventPlan(pool as never, sub, { book: book(sub), name: 'E', params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }) });
    await armEventPlan(pool as never, sub, noDate.planId);
    const n = fakeNotify();
    const out = await tickEventReminders(ctx(), sub, n.deps(et('2026-10-15', '09:00')));
    expect(out.processed).toBe(0);         // neither plan is even a candidate
    expect(out.fired).toEqual([]);
    expect(await listEventReminders(pool as never, sub, planId)).toEqual([]);
    expect(n.seen).toEqual([]);
  }, 30_000);

  it('a throwing delivery seam neither throws into the leg nor re-fires (the claim stands)', async () => {
    const sub = await caseSub('f');
    const planId = await armedPlan(sub, 'F', '2026-11-05');
    const bad = fakeNotify(true);
    expect(await tick(sub, bad.deps(et('2026-11-02', '09:00')))).toEqual([`${planId}:t3:sent`]);
    const good = fakeNotify();
    expect(await tick(sub, good.deps(et('2026-11-02', '09:05')))).toEqual([]);
    expect(good.seen).toEqual([]);
    expect((await getEventPlan(pool as never, sub, planId))!.timeline.some((e) => e.event === 'reminder_error')).toBe(false);
  }, 30_000);

  it('a HUNG delivery seam costs one deadline, not the tick: the second plan on the same tick still fires', async () => {
    const sub = await caseSub('h');
    process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS = '1000';   // the accessor's floor; below it the 20s default stands
    try {
      const first = await armedPlan(sub, 'H1', '2026-11-05');
      const second = await armedPlan(sub, 'H2', '2026-11-05');
      const hung: EventReminderDeps = { now: () => et('2026-11-02', '09:00'), notify: (_c, _s, planId) => planId === first ? new Promise(() => {}) : Promise.resolve(undefined) };
      const t0 = Date.now();
      expect(await tick(sub, hung)).toEqual([`${first}:t3:sent`, `${second}:t3:sent`]);
      expect(Date.now() - t0).toBeLessThan(8_000);          // unbounded would never return; the 20s default would blow this too
      expect((await listEventReminders(pool as never, sub, first)).map((r) => r.status)).toEqual(['sent']);   // claimed before delivery — it never re-fires
    } finally { delete process.env.TRADING_EVENT_NOTIFY_TIMEOUT_MS; }
  }, 30_000);

  it('setEventPlanPricingDate: refuses a bad date (400), clears with null, refuses a plan in the market (409)', async () => {
    const sub = await caseSub('g');
    const p = await createEventPlan(pool as never, sub, { book: book(sub), name: 'G', params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }) });
    await expect(setEventPlanPricingDate(pool as never, sub, p.planId, '2026-02-30')).rejects.toMatchObject({ code: 'pricing_date_invalid', httpStatus: 400 });
    expect(await setEventPlanPricingDate(pool as never, sub, p.planId, '2026-10-15')).toBe('2026-10-15');
    expect(((await getEventPlan(pool as never, sub, p.planId))!.params as { pricingDate?: string }).pricingDate).toBe('2026-10-15');
    expect(await setEventPlanPricingDate(pool as never, sub, p.planId, null)).toBeNull();
    expect((await pool.query(`SELECT params->>'pricingDate' AS d FROM oshal_trading_event_plans WHERE plan_id = $1`, [p.planId])).rows[0].d).toBeNull();
    await pool.query(`UPDATE oshal_trading_event_plans SET status = 'entry_placed' WHERE plan_id = $1`, [p.planId]);
    await expect(setEventPlanPricingDate(pool as never, sub, p.planId, '2026-10-15')).rejects.toMatchObject({ code: 'plan_locked', httpStatus: 409 });
    await expect(setEventPlanPricingDate(pool as never, 'someone-else', p.planId, '2026-10-15')).rejects.toMatchObject({ code: 'plan_not_found' });
  }, 30_000);
});

describe('input validation and the schema bootstrap', () => {
  it('a weekend pricing date is refused at the input — the leg runs weekdays only, so its T-0 could never fire', async () => {
    const sub = await caseSub('wknd');
    const p = await createEventPlan(pool as never, sub, { book: book(sub), name: 'WKND', params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }) });
    await expect(setEventPlanPricingDate(pool as never, sub, p.planId, '2026-10-17')).rejects.toMatchObject({ code: 'pricing_date_invalid', httpStatus: 400 });  // Saturday
    await expect(setEventPlanPricingDate(pool as never, sub, p.planId, '2026-10-18')).rejects.toMatchObject({ code: 'pricing_date_invalid', httpStatus: 400 });  // Sunday
    expect(await setEventPlanPricingDate(pool as never, sub, p.planId, '2026-10-16')).toBe('2026-10-16');                                                        // Friday
  }, 30_000);

  it('ensureEventRemindersSchema is memoized: a repeat call issues ZERO statements (the leg walks every plan of every user)', async () => {
    await ensureEventRemindersSchema(pool as never);
    let calls = 0;
    const counting = { query: async (...args: unknown[]) => { calls += 1; return (pool as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query(...args); } };
    await ensureEventRemindersSchema(counting as never);
    expect(calls, 'the CREATE TABLE + the two ACCESS EXCLUSIVE RLS ALTERs must not re-run on every tick').toBe(0);
  }, 30_000);
});

/**
 * The kernel hooks (H1–H5) this module is wired through. They live in src/app/trading-event-plans.ts,
 * which another item owns this wave, so they are applied by the integrator AFTER that item lands. Until
 * then this block is RED ON PURPOSE: without it every spec here stays green while the feature is dark —
 * the S-1 alert never called, the reminder tick never called, and PATCH params.pricingDate silently
 * dropped by normalizeEventPlanParams (it rebuilds params from a fixed key set).
 */
export function missingKernelHooks(plans: string): string[] {
  const missing: string[] = [];
  if (!/^import \{[^}]*\balertFirstS1\b[^}]*\} from '\.\/trading-event-alerts';/m.test(plans)) missing.push("H1: import { alertFirstS1, alertNotifierFrom, normalizePricingDate } from './trading-event-alerts'");
  if (!/\bpricingDate\?:\s*string/.test(plans)) missing.push('H2: EventPlanParams declares pricingDate?: string | null');
  if (!/pricingDate: normalizePricingDate\(/.test(plans)) missing.push('H3: normalizeEventPlanParams keeps pricingDate (else the PATCH from the surface is dropped)');
  const s1Line = plans.split('\n').find((l) => l.includes('alertFirstS1(') && !l.trimStart().startsWith('*')) ?? '';
  if (!/\bawait alertFirstS1\(/.test(s1Line)) missing.push('H4: stepWatching awaits alertFirstS1 before BOTH of its exits');
  else if (!s1Line.includes('alertNotifierFrom(deps)')) missing.push('H4b: the hook must pass the injectable seam — alertFirstS1(ctx, sub, plan, s1, alertNotifierFrom(deps)). The seam-less form defaults to the REAL two rails, so the plan module\'s own spec would write jarvis_tasks rows and build the notification router on a fake context.');
  const remLine = plans.split('\n').find((l) => l.includes('tickEventReminders(')) ?? '';
  if (!remLine.includes('trading-event-reminders.js')) missing.push('H5: dispatchTradingEventSchedule dynamic-imports ./trading-event-reminders.js and calls tickEventReminders(ctx, sub)');
  else if (!/\bfull \?/.test(remLine)) missing.push('H5b: the reminders tick must be gated on `full ?` — the leg cron fires EVERY minute, the reminders are hour-granular');
  return missing;
}

describe('kernel wiring (ADR-136 D6 hooks H1-H5 in src/app/trading-event-plans.ts)', () => {
  const planSource = () => readFileSync(path.resolve(process.cwd(), 'src/app/trading-event-plans.ts'), 'utf8');
  /** The detector is only the FAILURE MESSAGE — every assertion below crosses the real call site. */
  const why = () => `not wired yet — ${missingKernelHooks(planSource()).join(' | ') || 'the hooks are present but the path did not behave'}`;

  it('the detector itself is sound: a wired source reports nothing missing, an unwired one reports every hook', () => {
    const wired = [
      "import { alertFirstS1, alertNotifierFrom, normalizePricingDate } from './trading-event-alerts';",
      '  pricingDate?: string | null;',
      '    pricingDate: normalizePricingDate(r.pricingDate),',
      '  if (s1 && !plan.filings.s1) await alertFirstS1(ctx, sub, plan, s1, alertNotifierFrom(deps));',
      "  const reminders = full ? await import('./trading-event-reminders.js').then((m) => m.tickEventReminders(ctx, sub)).catch(() => null) : null;",
    ].join('\n');
    expect(missingKernelHooks(wired)).toEqual([]);
    expect(missingKernelHooks('')).toHaveLength(5);
    expect(missingKernelHooks(wired.replace('full ? ', ''))[0]).toContain('H5b');
    expect(missingKernelHooks(wired.replace(', alertNotifierFrom(deps)', ''))[0]).toContain('H4b');
  });

  it('H2+H3 — the REAL normalizer keeps params.pricingDate (this is the path the surface PATCH takes)', () => {
    const params = normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10, pricingDate: '2026-10-15' }) as { pricingDate?: string | null };
    expect(params.pricingDate, why()).toBe('2026-10-15');
    // and the validation really runs inside the normalizer, not only in the explicit setter
    expect((normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10, pricingDate: '2026-10-17' }) as { pricingDate?: string | null }).pricingDate ?? null).toBeNull();
  });

  it('H1+H4+H4b — the REAL state machine raises the S-1 alert through the caller\'s own seam', async () => {
    const sub = await caseSub('wire-s1');
    const plan = await createEventPlan(pool as never, sub, { book: book(sub), name: 'WIRE', params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }) });
    await armEventPlan(pool as never, sub, plan.planId);
    const hit: EdgarHit = { form: 'S-1', date: '2026-09-15', url: 'https://www.sec.gov/x/s1.htm', displayName: 'Anthropic PBC', cik: '0001234567' };
    const seen: EventAlert[] = [];
    // `notify` is the seam the hook must pass on (EventPlanDeps.notify, optional) — the cast keeps this
    // spec compiling before the plan module declares it, which is exactly the state H4b guards.
    const deps = { ...planDeps, edgarSearch: async () => [hit], notify: async (_c: unknown, _s: string, _p: string, a: EventAlert) => { seen.push(a); } } as unknown as EventPlanDeps;
    await tickEventPlans(ctx(), sub, deps);          // armed → watching
    await tickEventPlans(ctx(), sub, deps);          // watching: the S-1 is seen for the first time
    const p = (await getEventPlan(pool as never, sub, plan.planId))!;
    expect(p.filings.s1, why()).toBeTruthy();
    expect(p.timeline.filter((e) => e.event === 's1_alerted'), why()).toHaveLength(1);
    expect(seen.map((a) => a.key), why()).toEqual(['s1']);                      // H4b: the injected seam really received it
    expect(seen[0]?.subject ?? '').toContain('filed 2026-09-15');
    await tickEventPlans(ctx(), sub, deps);          // a later tick must not re-announce
    expect(seen).toHaveLength(1);
  }, 60_000);

  it('H5+H5b — the REAL leg dispatch runs the reminders tick on a full tick, and not on a partial one', async () => {
    const sub = await caseSub('wire-leg');
    // A pricing date in the recent PAST: every offset is due and its window closed, so the tick records
    // `expired` rows — proof it ran, with no outward delivery and no venue contact.
    const back = new Date(Date.now() - 9 * 86_400_000);
    while (back.getUTCDay() === 0 || back.getUTCDay() === 6) back.setUTCDate(back.getUTCDate() - 1);
    const pricingDate = back.toISOString().slice(0, 10);
    const planId = await armedPlan(sub, 'LEG', pricingDate);
    const leg = (minuteUtc: number) => ({ id: `spec-leg-${sub}`, taskType: `trading-events:${sub}`, taskData: { userSub: sub }, nextRunAt: new Date(Date.UTC(2026, 8, 8, 14, minuteUtc)).toISOString() } as unknown as ScheduleRecord);
    const prev = process.env.TRADING_EVENT_PLANS;
    process.env.TRADING_EVENT_PLANS = 'true';
    try {
      expect(isFullTick(new Date(Date.UTC(2026, 8, 8, 14, 10)))).toBe(true);
      expect(isFullTick(new Date(Date.UTC(2026, 8, 8, 14, 12)))).toBe(false);
      expect((await dispatchTradingEventSchedule(ctx(), leg(12))).success).toBe(true);       // partial tick
      expect(await listEventReminders(pool as never, sub, planId), 'H5b: the reminders tick must be gated on the full tick').toEqual([]);
      expect((await dispatchTradingEventSchedule(ctx(), leg(10))).success).toBe(true);       // full tick
      const rows = await listEventReminders(pool as never, sub, planId);
      expect(rows.map((r) => r.key), why()).toEqual(['t3', 't1', 't0']);
      expect(rows.every((r) => r.status === 'expired')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TRADING_EVENT_PLANS; else process.env.TRADING_EVENT_PLANS = prev;
    }
  }, 60_000);
});

describe('deployment pins', () => {
  it('compose forwards the four new env vars to the api (the silent-env-var class: unforwarded = code defaults, whatever .env says)', () => {
    const compose = readFileSync(path.resolve(process.cwd(), 'docker-compose.oshal-local.yml'), 'utf8');
    const apiStart = compose.indexOf('\n  oshal-api:');
    const after = compose.slice(apiStart + 1);
    const nextService = after.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const apiBlock = nextService === -1 ? after : after.slice(0, nextService + 1);
    const sharedAnchor = compose.slice(0, compose.indexOf('\n  oshal-db:'));
    for (const name of ['TRADING_COTP_URL', 'TRADING_COTP_REMINDER_HOUR_ET', 'TRADING_COTP_REMINDER_DAYS', 'TRADING_EVENT_ALERT_TOPIC', 'TRADING_EVENT_NOTIFY_TIMEOUT_MS']) {
      const declared = new RegExp(`^\\s*${name}:\\s`, 'm');
      expect(declared.test(apiBlock) || declared.test(sharedAnchor), `${name} is not forwarded to the api by compose`).toBe(true);
    }
  });
  it('hook contract: tickEventReminders(ctx, sub[, deps]) reads params.pricingDate; the plan module never imports this module statically (cycle guard)', () => {
    expect(typeof tickEventReminders).toBe('function');
    expect(tickEventReminders.length).toBeGreaterThanOrEqual(2);
    const self = readFileSync(path.resolve(process.cwd(), 'src/app/trading-event-reminders.ts'), 'utf8');
    expect(self).toContain("(params->>'pricingDate') IS NOT NULL");
    const plans = readFileSync(path.resolve(process.cwd(), 'src/app/trading-event-plans.ts'), 'utf8');
    expect(plans).not.toMatch(/^import .* from '\.\/trading-event-reminders'/m);
    expect(plans).not.toMatch(/^import .* from '\.\/trading-dated-orders'/m);
  });
});
