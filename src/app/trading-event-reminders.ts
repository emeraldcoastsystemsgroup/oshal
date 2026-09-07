/**
 * COTP reminders for event playbooks (ADR-136 D6 remainder). Schwab only allocates IPO shares at the
 * offer price to clients who submit a Conditional Offer to Purchase on schwab.com before 4:00 PM ET on
 * the last trading day before pricing and CONFIRM it after pricing — software cannot do that for the
 * operator, so the platform REMINDS. The plan carries the expected pricing date (`params.pricingDate`,
 * operator-entered — EDGAR does not publish it; the 424B4 lands after pricing) and this module fires
 * one reminder per configured offset (default T-3, T-1, T-0 in TRADING DAYS — weekdays in v1, exchange
 * holidays are a follow-up) at the first leg tick at/after TRADING_COTP_REMINDER_HOUR_ET on that day.
 *
 * Every reminder's TEXT is derived from the computed instants — the deadline it names is 16:00 ET on
 * the last trading day before pricing, and "today"/"tomorrow"/"in N days" is computed against the clock
 * at fire time — never a fixed phrase that is only true when the box happened to be awake. A reminder
 * whose window has already closed when the leg finally sees it is recorded as `expired` on the plan's
 * timeline instead of sent: a nudge to submit an offer after the window is noise.
 *
 * Rides the EXISTING `trading-events:<sub>` leg (5-minute cadence, TRADING_EVENT_PLANS-gated) as a
 * dynamic import from dispatchTradingEventSchedule — no new taskType, no cron change. The
 * `jarvis-reminder` schedule type is deliberately NOT used: its schedule id is keyed on (owner, taskType)
 * (src/features/scheduling/services/schedule-service.ts resolveCreateTarget) so three reminders would
 * clobber each other, and each would run through the LLM orchestrator.
 *
 * State lives in its own FORCE-RLS table `oshal_trading_event_reminders` — UNIQUE (plan_id, key) is the
 * idempotency arbiter (INSERT … ON CONFLICT DO NOTHING; the row that wins fires). A pricing-date change
 * recomputes the due instants of what has not fired; keys already sent stay sent (documented).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — config accessors (TRADING_COTP_URL → the Schwab client login root, TRADING_COTP_REMINDER_HOUR_ET → 9, TRADING_COTP_REMINDER_DAYS → 3,1,0), trading-day arithmetic (weekday step-back), the pure schedule (due/closes instants via etWallToInstant, DST-safe), date-derived reminder text, the FORCE-RLS reminders table, setEventPlanPricingDate, and tickEventReminders (claim-first per key, expired past the window, never throws for one plan's sake) delivered through announceEventAlert (Jarvis shelf + per-user NotificationRouter).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review round 2: memoized ensureEventRemindersSchema (the leg fires every minute and listEventReminders re-ensured per plan, so the DDL + two ACCESS EXCLUSIVE RLS ALTERs ran N+1 times per user per tick); the T-n body now measures the distance to pricing at FIRE time instead of restating entry.daysBefore (stale when the leg runs late); the timeline-note fallback logs instead of swallowing.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Review round 3: the outward hop is bounded — fireReminder delivers through withDeliveryDeadline (env TRADING_EVENT_NOTIFY_TIMEOUT_MS, default 20s), so a wedged Gmail/Twilio/Telegram sender can no longer stall the trading-events leg for every other plan of that user; the claim row is already written before delivery, so a timed-out send is recorded and never re-fires. Plus the JSDoc @param/@returns the review asked for on the config accessors and the store helpers.
 *
 * @module trading-event-reminders
 */

import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { TradingError } from './trading-engine';
import { etWallParts, etWallToInstant, formatEt } from './trading-dated-orders';
import { announceEventAlert, normalizePricingDate, withDeliveryDeadline, type EventAlert } from './trading-event-alerts';

const logger = createChildLogger({ module: 'trading-event-reminders' });

/** Plan statuses that still want reminders: before the stock is listed, the offer window matters. */
const REMINDER_STATUSES = ['armed', 'watching', 'priced'];
/** Statuses in which the pricing date may still be edited (mirrors the plan module's EDITABLE set). */
const EDITABLE_STATUSES = ['draft', 'armed', 'watching', 'priced'];
/** The leg ticks 09:00–16:55 ET; an hour outside that is clamped to the nearest tick hour. */
const HOUR_MIN = 9, HOUR_MAX = 16;
const DEFAULT_COTP_URL = 'https://client.schwab.com/';

/** The subset of a plan row a reminder needs. */
export interface ReminderPlan { planId: string; name: string; bookRef: string; status: string; issuer: string; pricingDate: string }
/** One reminder slot computed from the pricing date. */
export interface ReminderEntry { key: string; daysBefore: number; dueDate: string; dueAt: Date; deadlineAt: Date; closesAt: Date }
/** One recorded reminder (sent or expired). */
export interface EventReminderRow { reminderId: string; userSub: string; planId: string; key: string; dueAt: string; closesAt: string; status: 'sent' | 'expired'; firedAt: string; detail: string | null }
/** What the tick touches outside the database — the spec injects a clock and a fake delivery seam. */
export interface EventReminderDeps {
  now: () => Date;
  notify: (ctx: AppContext, sub: string, planId: string, alert: EventAlert) => Promise<unknown>;
}

/**
 * @description Production deps: the real clock and the two-rail alert delivery.
 * @returns The deps tickEventReminders uses when the caller injects none.
 */
export function defaultReminderDeps(): EventReminderDeps { return { now: () => new Date(), notify: announceEventAlert }; }

/* ── config (env → default; each named here and in the compose passthrough) ─── */
/**
 * @description The link every COTP reminder carries. Config → env TRADING_COTP_URL (https only) →
 * Schwab's client login root. The default is the LOGIN page, not a deep link: the IPO-center URL is
 * behind authentication and was not verifiable publicly, so the reminder words the path instead
 * ("log in → IPO center") and the operator sets the exact page when they know it.
 * @returns An https URL.
 */
export function cotpUrl(): string {
  const u = String(process.env.TRADING_COTP_URL ?? '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : DEFAULT_COTP_URL;
}
/**
 * @description The ET hour a reminder becomes due on its day. Config → env TRADING_COTP_REMINDER_HOUR_ET
 * (9–16, outside that range the default) → 9, the leg's first tick hour.
 * @returns The ET hour.
 */
export function cotpReminderHourEt(): number {
  const n = Number(String(process.env.TRADING_COTP_REMINDER_HOUR_ET ?? '').trim());
  return Number.isInteger(n) && n >= HOUR_MIN && n <= HOUR_MAX ? n : HOUR_MIN;
}
/**
 * @description Trading days before pricing to remind on. Config → env TRADING_COTP_REMINDER_DAYS
 * ('3,1,0') → [3, 1, 0]; ints 0–30, deduped, largest first.
 * @returns The offsets.
 */
export function cotpReminderOffsets(): number[] {
  const raw = String(process.env.TRADING_COTP_REMINDER_DAYS ?? '').trim();
  // Empty tokens are dropped BEFORE Number(): Number('') is 0, so a blank env (compose forwards '') would have read as [0].
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 30);
  const days = [...new Set(parsed)].sort((a, b) => b - a);
  return days.length ? days : [3, 1, 0];
}

/* ── pure calendar math ────────────────────────────────────────────────────── */
const isoOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

/**
 * @description Step an ISO date back N trading days (weekdays; exchange holidays are a follow-up once a
 * holiday table exists). 0 returns the date itself even on a weekend — the caller's expiry rule covers it.
 * @param isoDate - YYYY-MM-DD.
 * @param daysBack - Trading days to step back (≥ 0).
 * @returns YYYY-MM-DD.
 */
export function shiftTradingDays(isoDate: string, daysBack: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new TradingError(400, 'pricing_date_invalid', 'Give the pricing date as YYYY-MM-DD.');
  let t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  for (let left = Math.max(0, Math.floor(daysBack)); left > 0;) {
    t -= DAY_MS;
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return isoOf(t);
}

/**
 * @description 16:00 ET on the last trading day before pricing — the COTP submission deadline.
 * @param pricingDate - YYYY-MM-DD (already validated).
 * @returns The deadline instant.
 */
export function cotpDeadlineAt(pricingDate: string): Date { return etWallToInstant(shiftTradingDays(pricingDate, 1), '16:00'); }

/**
 * @description The reminder slots for a pricing date: for each offset, the due instant (offset trading
 * days before pricing at the configured ET hour) and the instant after which that reminder is noise
 * (the deadline for T-n≥1; the end of pricing day for T-0). Pure; DST-safe through etWallToInstant.
 * @param pricingDate - YYYY-MM-DD (already validated).
 * @param hourEt - The ET hour (default from config).
 * @param offsets - Trading-day offsets (default from config).
 * @returns Entries sorted by due instant.
 */
export function cotpReminderSchedule(pricingDate: string, hourEt: number = cotpReminderHourEt(), offsets: number[] = cotpReminderOffsets()): ReminderEntry[] {
  const deadlineAt = cotpDeadlineAt(pricingDate);
  const hh = String(hourEt).padStart(2, '0');
  return offsets.map((daysBefore) => {
    const dueDate = shiftTradingDays(pricingDate, daysBefore);
    const dueAt = etWallToInstant(dueDate, `${hh}:00`);
    const closesAt = daysBefore >= 1 ? deadlineAt : etWallToInstant(pricingDate, '23:59');
    return { key: `t${daysBefore}`, daysBefore, dueDate, dueAt, deadlineAt, closesAt };
  }).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

/** 'today' / 'tomorrow' / 'in N days' / 'N days ago' by ET calendar date — the words the reminder uses. */
function relativeDayWords(now: Date, at: Date): string {
  const a = etWallParts(now), b = etWallParts(at);
  const days = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return days > 1 ? `in ${days} days` : `${-days} day${days === -1 ? '' : 's'} ago`;
}
const dateWords = (iso: string): string => formatEt(etWallToInstant(iso, '12:00')).replace(/ at .*$/, '');

/**
 * @description The reminder for one slot, worded from the computed instants. T-n (n ≥ 1): submit the
 * Conditional Offer before the named deadline; T-0: confirm it once the offering prices.
 * @param plan - Issuer/name/book.
 * @param entry - The slot.
 * @param now - The clock at fire time (drives today/tomorrow).
 * @param url - The link (default cotpUrl()).
 * @returns The alert.
 */
export function cotpReminderText(plan: ReminderPlan, entry: ReminderEntry, now: Date, url: string = cotpUrl()): EventAlert {
  const pricing = dateWords(plan.pricingDate);
  // Measured at FIRE time, never from entry.daysBefore: a reminder the leg only reached a day late (an
  // asleep box) would otherwise say "3 trading days away" when it is 2. Same class as "Deadline today".
  const relPricing = relativeDayWords(now, etWallToInstant(plan.pricingDate, '09:30'));
  const where = 'log in to schwab.com → IPO center → submit (or confirm) the Conditional Offer to Purchase';
  const tail = `Plan "${plan.name}" on ${plan.bookRef}.`;
  if (entry.daysBefore >= 1) {
    const due = formatEt(entry.deadlineAt), rel = relativeDayWords(now, entry.deadlineAt);
    return {
      key: entry.key,
      subject: `${plan.issuer} IPO: Conditional Offer to Purchase due ${rel} (${due})`,
      body: `${plan.issuer} is expected to price ${pricing} (${relPricing}). To get shares at the offer price, ${where} for ${plan.issuer} — it must be in before ${due}, the last trading day before pricing. After pricing, CONFIRM the offer: unconfirmed offers lapse. Log in: ${url} ${tail}`,
      url, shortText: `${plan.issuer} COTP due ${rel} — ${due}. ${url}`.slice(0, 160),
    };
  }
  const rel = relPricing;
  return {
    key: entry.key,
    subject: `${plan.issuer} IPO prices ${rel} (${pricing}): confirm your Conditional Offer`,
    body: `${plan.issuer} is expected to price ${rel} (${pricing}). Once the offering prices, ${where} and CONFIRM it — unconfirmed offers lapse. The plan enters on the first trade at IPO × (1 + the premium cap). Log in: ${url} ${tail}`,
    url, shortText: `${plan.issuer} prices ${rel} — CONFIRM your Conditional Offer. ${url}`.slice(0, 160),
  };
}

/* ── schema + store ────────────────────────────────────────────────────────── */
/**
 * Set once the bootstrap has succeeded in THIS process. The leg fires every minute and every fire walks
 * every plan, so an un-memoized ensure issued CREATE TABLE IF NOT EXISTS + two ALTER TABLE … ROW LEVEL
 * SECURITY (ACCESS EXCLUSIVE locks on the shared table) N+1 times per user per tick. Same short-circuit
 * shape as ensureJarvisSchema. A THROWN bootstrap leaves the flag unset, so the next tick retries.
 */
let remindersSchemaReady = false;

/**
 * @description Create the FORCE-RLS reminders table (idempotent, and memoized per process — see
 * {@link remindersSchemaReady}; owner policy on user_sub; UNIQUE (plan_id, key) is the once-only arbiter).
 * @param pool - DB pool.
 * @returns Nothing; throws only if the bootstrap itself fails (the flag then stays unset and the next tick retries).
 */
export async function ensureEventRemindersSchema(pool: AppContext['pool']): Promise<void> {
  if (remindersSchemaReady) return;
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading event reminders',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_event_reminders (
        reminder_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL, plan_id UUID NOT NULL, key TEXT NOT NULL,
        due_at TIMESTAMPTZ NOT NULL, closes_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL,
        fired_at TIMESTAMPTZ NOT NULL DEFAULT now(), detail TEXT,
        UNIQUE (plan_id, key)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_trd_event_reminders_plan ON oshal_trading_event_reminders (user_sub, plan_id)',
      ...buildOwnerRlsPolicyStatements('oshal_trading_event_reminders', 'user_sub'),
    ],
    requirements: [{ table: 'oshal_trading_event_reminders', columns: ['reminder_id', 'user_sub', 'plan_id', 'key', 'due_at', 'closes_at', 'status'] }],
  });
  remindersSchemaReady = true;
}

function rowToReminder(r: Record<string, unknown>): EventReminderRow {
  const iso = (v: unknown) => new Date(v as string).toISOString();
  return { reminderId: String(r.reminder_id), userSub: String(r.user_sub), planId: String(r.plan_id), key: String(r.key), dueAt: iso(r.due_at), closesAt: iso(r.closes_at), status: r.status as 'sent' | 'expired', firedAt: iso(r.fired_at), detail: r.detail == null ? null : String(r.detail) };
}

/**
 * @description The owner's recorded reminders, optionally for one plan, oldest first.
 * @param pool - DB pool.
 * @param sub - Owner.
 * @param planId - Optional plan filter.
 * @returns The recorded reminders (sent and expired), oldest due first.
 */
export async function listEventReminders(pool: AppContext['pool'], sub: string, planId?: string): Promise<EventReminderRow[]> {
  await ensureEventRemindersSchema(pool);
  const r = planId
    ? await pool.query('SELECT * FROM oshal_trading_event_reminders WHERE user_sub = $1 AND plan_id = $2 ORDER BY due_at', [sub, planId])
    : await pool.query('SELECT * FROM oshal_trading_event_reminders WHERE user_sub = $1 ORDER BY due_at', [sub]);
  return r.rows.map(rowToReminder);
}

/**
 * @description Set (or clear, with null) the plan's expected pricing date — `params.pricingDate`. Refuses
 * a malformed date (400) and a plan already in the market (409). Writes a `pricing_date_set` timeline event.
 * @param pool - DB pool.
 * @param sub - Owner.
 * @param planId - The plan.
 * @param raw - YYYY-MM-DD, or null to clear.
 * @returns The stored date (or null).
 */
export async function setEventPlanPricingDate(pool: AppContext['pool'], sub: string, planId: string, raw: unknown): Promise<string | null> {
  const date = raw == null || raw === '' ? null : normalizePricingDate(raw);
  if (raw != null && raw !== '' && !date) throw new TradingError(400, 'pricing_date_invalid', 'Give the expected pricing date as YYYY-MM-DD.');
  const cur = await pool.query('SELECT status FROM oshal_trading_event_plans WHERE user_sub = $1 AND plan_id = $2', [sub, planId]);
  if (!cur.rows[0]) throw new TradingError(404, 'plan_not_found', 'Plan not found.');
  if (!EDITABLE_STATUSES.includes(String(cur.rows[0].status))) throw new TradingError(409, 'plan_locked', `Plan is ${cur.rows[0].status} — it has orders in the market; the pricing date no longer applies.`);
  await pool.query(
    `UPDATE oshal_trading_event_plans SET params = ${date ? `params || jsonb_build_object('pricingDate', $3::text)` : `(params - 'pricingDate')`},
        timeline = timeline || $${date ? 4 : 3}::jsonb, updated_at = now() WHERE user_sub = $1 AND plan_id = $2`,
    [sub, planId, ...(date ? [date] : []), JSON.stringify([{ at: new Date().toISOString(), event: 'pricing_date_set', detail: date ? `expected pricing ${date}; COTP deadline ${formatEt(cotpDeadlineAt(date))}` : 'cleared' }])]);
  logger.info({ sub, planId, pricingDate: date }, 'event plan pricing date set');
  return date;
}

async function listReminderPlans(pool: AppContext['pool'], sub: string): Promise<ReminderPlan[]> {
  const r = await pool.query(
    `SELECT plan_id, name, book_ref, status, params FROM oshal_trading_event_plans
      WHERE user_sub = $1 AND status = ANY($2::text[]) AND (params->>'pricingDate') IS NOT NULL ORDER BY created_at`, [sub, REMINDER_STATUSES]);
  return r.rows.map((row) => { const p = (row.params ?? {}) as Record<string, unknown>; return { planId: String(row.plan_id), name: String(row.name), bookRef: String(row.book_ref), status: String(row.status), issuer: String(p.issuer ?? ''), pricingDate: String(p.pricingDate) }; });
}

async function appendTimeline(pool: AppContext['pool'], sub: string, planId: string, event: string, detail?: string): Promise<void> {
  await pool.query('UPDATE oshal_trading_event_plans SET timeline = timeline || $3::jsonb, updated_at = now() WHERE user_sub = $1 AND plan_id = $2',
    [sub, planId, JSON.stringify([{ at: new Date().toISOString(), event, ...(detail ? { detail } : {}) }])]);
}

/* ── the tick ──────────────────────────────────────────────────────────────── */
/**
 * @description Fire every due, not-yet-recorded COTP reminder for this owner's pre-listing plans that
 * carry a pricing date. Rides the trading-events leg. Never throws for one plan's sake — a plan whose
 * reminders error is noted on its timeline and the others still run.
 * @param ctx - App context.
 * @param sub - Owner.
 * @param deps - Clock + delivery seam (production by default; the spec injects fakes).
 * @returns How many plans were examined and which reminders fired/expired ('planId:key:status').
 */
export async function tickEventReminders(ctx: AppContext, sub: string, deps: EventReminderDeps = defaultReminderDeps()): Promise<{ processed: number; fired: string[] }> {
  const t0 = Date.now();
  await ensureEventRemindersSchema(ctx.pool);
  const plans = await listReminderPlans(ctx.pool, sub);
  const fired: string[] = [];
  for (const plan of plans) {
    try {
      fired.push(...await fireDueReminders(ctx, sub, plan, deps));
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, sub, planId: plan.planId }, 'event reminders tick failed for plan');
      await appendTimeline(ctx.pool, sub, plan.planId, 'reminder_error', (err as Error).message.slice(0, 300))
        .catch((noteErr) => logger.error({ err: noteErr, stack: (noteErr as Error).stack, sub, planId: plan.planId }, 'event reminders: could not record the failure on the plan timeline either'));
    }
  }
  if (plans.length) logger.info({ sub, processed: plans.length, fired, ms: Date.now() - t0 }, 'event reminders tick');
  return { processed: plans.length, fired };
}

async function fireDueReminders(ctx: AppContext, sub: string, plan: ReminderPlan, deps: EventReminderDeps): Promise<string[]> {
  const schedule = normalizePricingDate(plan.pricingDate) ? cotpReminderSchedule(plan.pricingDate) : [];
  if (!schedule.length) return [];
  const done = new Set((await listEventReminders(ctx.pool, sub, plan.planId)).map((r) => r.key));
  const now = deps.now();
  const out: string[] = [];
  for (const entry of schedule) {
    if (done.has(entry.key) || now.getTime() < entry.dueAt.getTime()) continue;
    const fired = await fireReminder(ctx, sub, plan, entry, now, deps);
    if (fired) out.push(fired);
  }
  return out;
}

/** Claim the (plan, key) row first; deliver only when the claim won; a closed window records `expired` instead of nagging. */
async function fireReminder(ctx: AppContext, sub: string, plan: ReminderPlan, entry: ReminderEntry, now: Date, deps: EventReminderDeps): Promise<string | null> {
  const status: 'sent' | 'expired' = now.getTime() > entry.closesAt.getTime() ? 'expired' : 'sent';
  const alert = cotpReminderText(plan, entry, now);
  const detail = status === 'sent'
    ? `${entry.key.toUpperCase()} reminder — due ${formatEt(entry.dueAt)}; COTP deadline ${formatEt(entry.deadlineAt)}`
    : `${entry.key.toUpperCase()} reminder skipped — its window closed ${formatEt(entry.closesAt)} before the leg saw it (leg not running?). Check your Conditional Offer status on schwab.com.`;
  const claim = await ctx.pool.query(
    `INSERT INTO oshal_trading_event_reminders (user_sub, plan_id, key, due_at, closes_at, status, fired_at, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (plan_id, key) DO NOTHING RETURNING reminder_id`,
    [sub, plan.planId, entry.key, entry.dueAt.toISOString(), entry.closesAt.toISOString(), status, now.toISOString(), detail]);
  if (!claim.rows[0]) return null;
  if (status === 'sent') {
    // Bounded: the claim row is already written, so a sender that wedges costs this reminder its
    // delivery — never the rest of the user's plans on this leg tick (TRADING_EVENT_NOTIFY_TIMEOUT_MS).
    try { await withDeliveryDeadline(Promise.resolve(deps.notify(ctx, sub, plan.planId, alert))); }
    catch (err) { logger.error({ err, stack: (err as Error).stack, sub, planId: plan.planId, key: entry.key }, 'COTP reminder delivery failed or timed out (claim stands — no retry storm)'); }
  } else {
    logger.warn({ sub, planId: plan.planId, key: entry.key, closesAt: entry.closesAt.toISOString() }, 'COTP reminder expired unsent — window closed before the leg saw it');
  }
  await appendTimeline(ctx.pool, sub, plan.planId, `cotp_${entry.key}_${status}`, detail);
  return `${plan.planId}:${entry.key}:${status}`;
}
