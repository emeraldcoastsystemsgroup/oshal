/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-136 D6 event playbooks against the REAL oshal Postgres (fail-loud when the stack is down): the FORCE-RLS table exists; params normalize/refuse; the state machine walks armed → watching → priced (EDGAR fakes: S-1 then 424B4 with a parseable price + ticker) → listed → entry_placed (a real 'event-playbook' decision row on the plan's book) → filled → exits_placed (TP limit GTC + stop GTC) → closed on the take-profit with the STOP CANCELLED and P&L recorded; the disarm path cancels working orders; delete refuses an active plan; the 424B4 parser reads price + ticker; the leg refuses to act while TRADING_EVENT_PLANS is off.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import crypto from 'crypto';
import {
  ensureEventPlansSchema, normalizeEventPlanParams, createEventPlan, armEventPlan, disarmEventPlan, deleteEventPlan, getEventPlan,
  tickEventPlans, dryRunEventPlan, parsePricingProspectus, dispatchTradingEventSchedule, eventPlanTaskType, isTradingEventSchedule,
  type EventPlanDeps, type EdgarHit,
} from '../../src/app/trading-event-plans';
import { ensureBooksSchema, ensureLegacyBooks, legacyBook } from '../../src/app/trading-books-store';
import { ensureTradingSchema } from '../../src/app/trading-engine';
import type { AppContext } from '../../src/app/composition/app-context';
import type { OrderResult } from '../../src/features/trading';

const DSN = process.env.OSHAL_TEST_DSN || `postgresql://oshal:oshal@127.0.0.1:${process.env.OSHAL_PG_PORT ?? '55433'}/oshal`;
const RUN = crypto.randomUUID().slice(0, 8);
const SUB = `spec-evt-${RUN}`;
let pool: Pool;
const ctx = () => ({ pool } as unknown as AppContext);

/** A scripted venue: orders are accepted and later report whatever status the test sets. */
function fakeVenue() {
  const orders = new Map<string, OrderResult>(); const cancelled: string[] = []; let n = 0;
  const place = async (_p: unknown, _s: string, _b: unknown, decisionId: string, requestId: string): Promise<OrderResult> => {
    const id = `o-${++n}-${requestId}`;
    const o = { id, clientOrderId: requestId, status: 'accepted', symbol: 'ANTH', side: requestId.includes('entry') ? 'buy' : 'sell', qty: 0, type: 'limit', filledQty: 0, provider: 'alpaca', mode: 'paper', decisionId } as unknown as OrderResult;
    orders.set(id, o); return o;
  };
  const broker = () => ({
    configured: () => true, getAccount: async () => ({ equity: 100_000 }),
    getOrder: async (id: string) => { const o = orders.get(id); if (!o) throw new Error('unknown order ' + id); return o; },
    cancelOrder: async (id: string) => { cancelled.push(id); const o = orders.get(id); if (o && o.status !== 'filled') (o as { status: string }).status = 'canceled'; },
  });
  const fill = (pred: (id: string) => boolean, avg: number) => { for (const [id, o] of orders) if (pred(id) && o.status !== 'filled') Object.assign(o, { status: 'filled', filledQty: 1000, filledAvgPrice: avg }); };
  return { orders, cancelled, place, broker, fill };
}

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || `spec-secret-${RUN}`;
  // Sizing is capped by the engine guardrails; pin them to the operator box's values so the share
  // counts below are deterministic (the code default of $1,000/order would cap the entry at 19 shares).
  process.env.TRADING_MAX_NOTIONAL_USD = '50000'; process.env.TRADING_MAX_QTY = '100000';
  pool = new Pool({ connectionString: DSN, max: 4, options: '-c row_security=off' });
  try { await pool.query('SELECT 1'); } catch (error) {
    throw new Error(`trading-event-plans requires the live oshal Postgres at ${DSN.replace(/:[^:@/]+@/, ':***@')} — bring the stack up with \`bash scripts/oshal-up.sh\` (cause: ${(error as Error).message})`);
  }
  await ensureBooksSchema(pool as never); await ensureTradingSchema(pool as never); await ensureEventPlansSchema(pool as never);
  // The spec connects as the superuser; if IT creates the table first the api (oshal_app) gets 42501 on
  // it. Hand ownership to the app role when that role exists (the 2026-09-01 spec-owned-table lesson).
  await pool.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN EXECUTE 'ALTER TABLE oshal_trading_event_plans OWNER TO oshal_app'; END IF; END $$;`);
  await ensureLegacyBooks(pool as never, SUB);
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM oshal_trading_decisions WHERE user_sub = $1`, [SUB]).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_signals WHERE user_sub = $1`, [SUB]).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_event_plans WHERE user_sub = $1`, [SUB]).catch(() => {});
  await pool.query(`DELETE FROM oshal_trading_books WHERE user_sub = $1`, [SUB]).catch(() => {});
  await pool.end();
});

describe('schema + params', () => {
  it('the plan table is FORCE-RLS with an owner policy', async () => {
    const r = await pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'oshal_trading_event_plans'`);
    expect(r.rows[0].relrowsecurity).toBe(true); expect(r.rows[0].relforcerowsecurity).toBe(true);
    const p = await pool.query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'oshal_trading_event_plans'`);
    expect(p.rows[0].n).toBeGreaterThan(0);
  });
  it('params default + clamp, and refuse a plan with no issuer or no size', () => {
    const p = normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 });
    expect(p).toMatchObject({ issuer: 'Anthropic', maxPremiumPct: 5, takeProfitPct: 10, stopLossPct: 10, timeStopDays: 30, entryDeadlineDays: 2, ticker: null });
    expect(() => normalizeEventPlanParams({ sizePctOfEquity: 10 })).toThrow(/issuer/);
    expect(() => normalizeEventPlanParams({ issuer: 'Anthropic' })).toThrow(/size/i);
  });
  it('parses the pricing prospectus for IPO price + ticker', () => {
    const t = 'The initial public offering price is $42.00 per share. Our Class A common stock has been approved for listing on the Nasdaq Global Select Market under the symbol “ANTH”.';
    expect(parsePricingProspectus(t)).toEqual({ ipoPrice: 42, ticker: 'ANTH' });
    expect(parsePricingProspectus('no pricing here')).toEqual({ ipoPrice: null, ticker: null });
  });
  it('taskType helpers', () => {
    expect(isTradingEventSchedule(eventPlanTaskType(SUB))).toBe(true);
    expect(isTradingEventSchedule('trading-autopilot:x')).toBe(false);
  });
});

describe('the state machine — armed → priced → listed → entry → fill → exits → take-profit closes and cancels the stop', () => {
  const book = legacyBook(SUB, 'paper');
  let planId = '';
  const venue = fakeVenue();
  let session: 'closed' | 'regular' = 'closed';
  let edgar: EdgarHit[] = [];
  let clock = new Date('2026-10-20T14:00:00Z');
  const deps: EventPlanDeps = {
    now: () => clock, session: async () => session, edgarSearch: async () => edgar,
    fetchText: async () => 'The initial public offering price is $50.00 per share ... under the symbol “ANTH”',
    broker: venue.broker as unknown as EventPlanDeps['broker'],
    latestTrade: async () => (session === 'regular' ? { price: 61, asOf: clock } : null),
    place: venue.place as unknown as EventPlanDeps['place'],
  };

  it('creates + arms; the first tick starts watching', async () => {
    const plan = await createEventPlan(pool as never, SUB, { book, name: '401k 10% plan', params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10, maxPremiumPct: 5, takeProfitPct: 10, stopLossPct: 10 }) });
    planId = plan.planId;
    expect(plan.status).toBe('draft');
    await expect(deleteEventPlan(pool as never, SUB, planId)).resolves.toBe(true);   // a draft may be deleted…
    const again = await createEventPlan(pool as never, SUB, { book, name: '401k 10% plan', params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }) });
    planId = again.planId;
    await armEventPlan(pool as never, SUB, planId);
    const t = await tickEventPlans(ctx(), SUB, deps);
    expect(t.transitions).toContain(`${planId}:watching`);
    await expect(deleteEventPlan(pool as never, SUB, planId)).rejects.toThrow(/plan_active|disarm/);   // …an armed one may not
  });

  it('EDGAR: S-1 alone records the filing; the 424B4 prices it (price + ticker parsed)', async () => {
    edgar = [{ form: 'S-1', date: '2026-09-15', url: 'https://www.sec.gov/x/s1.htm', displayName: 'Anthropic PBC', cik: '1' }];
    await tickEventPlans(ctx(), SUB, deps);
    let p = (await getEventPlan(pool as never, SUB, planId))!;
    expect(p.status).toBe('watching'); expect((p.filings.s1 as { form: string }).form).toBe('S-1');
    edgar.push({ form: '424B4', date: '2026-10-19', url: 'https://www.sec.gov/x/424b4.htm', displayName: 'Anthropic PBC', cik: '1' });
    await tickEventPlans(ctx(), SUB, deps);
    p = (await getEventPlan(pool as never, SUB, planId))!;
    expect(p.status).toBe('priced'); expect(p.ipoPrice).toBe(50); expect(p.ticker).toBe('ANTH');
  });

  it('no entry outside a regular session; on the first trade it places a day LIMIT at IPO × 1.05 as a real event-playbook decision', async () => {
    await tickEventPlans(ctx(), SUB, deps);
    expect((await getEventPlan(pool as never, SUB, planId))!.status).toBe('priced');
    session = 'regular';
    const t = await tickEventPlans(ctx(), SUB, deps);
    expect(t.transitions).toContain(`${planId}:entry_placed`);
    const p = (await getEventPlan(pool as never, SUB, planId))!;
    expect(p.entry).toMatchObject({ limitPx: 52.5, qty: 190 });   // 10% of $100k = $10k / 52.5 = 190 shares
    const d = await pool.query(`SELECT agent_id, side, order_type, limit_price, time_in_force, book_id FROM oshal_trading_decisions WHERE decision_id = $1`, [p.entry!.decisionId]);
    expect(d.rows[0]).toMatchObject({ agent_id: 'event-playbook', side: 'buy', order_type: 'limit', time_in_force: 'day' });
    expect(Number(d.rows[0].limit_price)).toBe(52.5); expect(String(d.rows[0].book_id)).toBe(book.bookId);
  });

  it('the fill places BOTH exits: TP limit GTC at IPO × 1.10 and a stop GTC at IPO × 0.90', async () => {
    venue.fill((id) => id.includes('entry'), 51.2);
    const t = await tickEventPlans(ctx(), SUB, deps);
    expect(t.transitions).toContain(`${planId}:exits_placed`);
    const p = (await getEventPlan(pool as never, SUB, planId))!;
    expect(p.exits).toMatchObject({ tpPx: 55, stopPx: 45 });
    const d = await pool.query(`SELECT side, order_type, limit_price, stop_price, time_in_force FROM oshal_trading_decisions WHERE user_sub = $1 AND side = 'sell' ORDER BY created_at`, [SUB]);
    expect(d.rows.map((r) => [r.order_type, r.time_in_force])).toEqual([['limit', 'gtc'], ['stop', 'gtc']]);
  });

  it('the take-profit fills → the stop is CANCELLED and the plan closes with P&L', async () => {
    venue.fill((id) => id.includes('-tp-'), 55);
    const t = await tickEventPlans(ctx(), SUB, deps);
    expect(t.transitions).toContain(`${planId}:closed`);
    const p = (await getEventPlan(pool as never, SUB, planId))!;
    expect(p.result).toMatchObject({ reason: 'take_profit', exitPx: 55 });
    expect(Number(p.result!.pnl)).toBeCloseTo((55 - 51.2) * 1000, 1);
    expect(venue.cancelled.some((id) => id.includes('-stop-'))).toBe(true);
    expect(p.timeline.map((e) => e.event)).toEqual(expect.arrayContaining(['armed', 'watching', 'priced', 'listed', 'entry_placed', 'filled', 'exits_placed', 'closed']));
  });

  it('disarm cancels working orders on another plan and marks it cancelled', async () => {
    const v2 = fakeVenue(); let s2: 'closed' | 'regular' = 'regular';
    const d2: EventPlanDeps = { ...deps, broker: v2.broker as unknown as EventPlanDeps['broker'], place: v2.place as unknown as EventPlanDeps['place'], session: async () => s2,
      edgarSearch: async () => [{ form: '424B4', date: '2026-10-19', url: 'u', displayName: 'Anthropic PBC', cik: '1' }] };
    const plan = await createEventPlan(pool as never, SUB, { book, name: 'second', params: normalizeEventPlanParams({ issuer: 'Anthropic', notionalUsd: 5000 }) });
    await armEventPlan(pool as never, SUB, plan.planId);
    await tickEventPlans(ctx(), SUB, d2); await tickEventPlans(ctx(), SUB, d2); await tickEventPlans(ctx(), SUB, d2);
    expect((await getEventPlan(pool as never, SUB, plan.planId))!.status).toBe('entry_placed');
    const out = await disarmEventPlan(ctx(), SUB, plan.planId, d2);
    expect(out.status).toBe('cancelled'); expect(v2.cancelled.length).toBe(1);
    s2 = 'closed';
  });

  it('the leg refuses to act while TRADING_EVENT_PLANS is off, and acts when on', async () => {
    const prev = process.env.TRADING_EVENT_PLANS;
    process.env.TRADING_EVENT_PLANS = 'false';
    const off = await dispatchTradingEventSchedule(ctx(), { id: 's1', taskType: eventPlanTaskType(SUB), taskData: { userSub: SUB } } as never);
    expect(off.success).toBe(true);
    process.env.TRADING_EVENT_PLANS = prev;
  });

  it('dry run tabulates entry/exit/size per example IPO price and lists the manual COTP step', () => {
    const p = { params: normalizeEventPlanParams({ issuer: 'Anthropic', sizePctOfEquity: 10 }), ipoPrice: null, bookRef: 'b-x' } as never;
    const dr = dryRunEventPlan(p, 461_000, [50]);
    expect(dr.rows[0]).toMatchObject({ ipoPrice: 50, entryLimit: 52.5, takeProfit: 55, stop: 45 });
    expect(dr.rows[0].shares).toBe(Math.floor(Math.min(46_100, 50_000) / 52.5));
    expect(dr.manualSteps.join(' ')).toMatch(/Conditional Offer to Purchase/);
  });
});
