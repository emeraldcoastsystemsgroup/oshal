/**
 * Event playbooks (ADR-136 D6) — single-event trade plans, IPO first. The operator's brief: "get in
 * as early as possible on the Anthropic IPO, sell at +10% over the strike (IPO price) or stop out;
 * call it the 401k 10% plan; it triggers right before the IPO." The Strategy Studio designs a plan;
 * this module STORES it and RUNS it as a small state machine on the per-user 'trading-events' leg:
 *
 *   draft → armed → watching ─(EDGAR: public S-1/F-1 seen; 424B4 pricing → IPO price + ticker)→ priced
 *   priced ─(first fresh trade in a regular session)→ listed → entry_placed (LIMIT ≤ IPO×(1+premium), day)
 *   entry_placed ─(fill)→ filled → exits_placed (TP sell LIMIT GTC at IPO×(1+tp); STOP sell GTC at IPO×(1−sl))
 *   exits_placed ─(one exit fills → the sibling is cancelled)→ closed | (time stop → market out) → closed
 *   any → cancelled (disarm)  |  entry never fills by the deadline → missed  |  invariant broken → error
 *
 * Every order goes through the engine's ONE order path (placeDecisionOrder: guardrails, live gate,
 * reservation arbiter, disabled-book BUY refusal) as an 'event-playbook' decision, so the journal
 * shows why. What software cannot do is secure offer-price allocation: Schwab requires the client to
 * submit a Conditional Offer to Purchase on schwab.com and confirm after pricing — the dry-run lists
 * that as a manual step. The leg only executes while TRADING_EVENT_PLANS=true (ADR-136 D8).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — FORCE-RLS plan table, CRUD + arm/disarm/delete, dry-run, EDGAR full-text watch (S-1/F-1 → 424B4 pricing parse), the tick state machine with injectable deps (clock, session, EDGAR, broker, market data, order placement) so the real-DB spec drives every transition without a venue, and the 'trading-events:<sub>' schedule leg gated by TRADING_EVENT_PLANS.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | dispatchTradingEventSchedule also ticks the ADR-136 D4 dated orders (trading-dated-orders.ts) on this same 5-minute leg — one cadence, one gate (TRADING_EVENT_PLANS), one order path; dynamic import for the same cycle reason as the pinned lots.
 *
 * @module trading-event-plans
 */

import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import type { ScheduleRecord, ScheduleDispatchResult } from '@/features/scheduling';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import {
  getBrokerAdapter, getMarketData, liveTradingEnabled, tradingSession, isTickStale,
  type TradingBook, type OrderResult,
} from '@/features/trading';
import { loadBook } from './trading-books-store';
import { placeDecisionOrder, guardrails, TradingError } from './trading-engine';

const logger = createChildLogger({ module: 'trading-event-plans' });

/** Cron for the executor leg (ET): every 5 minutes, 09:00–16:55, weekdays. 09:00 catches a 424B4 posted overnight. */
export const EVENT_PLANS_CRON = '*/5 9-16 * * 1-5';
/** The leg's timezone (the cron above is an ET clock). */
export const EVENT_PLANS_TIMEZONE = 'America/New_York';
const EDGAR_UA = 'oshal-trading/1.0 (maintainer@emeraldcoastsystemsgroup.com)';
const EDGAR_SEARCH = 'https://efts.sec.gov/LATEST/search-index';

/** @description True when the executor leg may act (TRADING_EVENT_PLANS=true). Plans can be designed/armed regardless. */
export function eventPlansEnabled(): boolean { return String(process.env.TRADING_EVENT_PLANS ?? 'false').toLowerCase() === 'true'; }
/** @description The per-user schedule taskType for the executor leg. */
export function eventPlanTaskType(sub: string): string { return `trading-events:${sub}`; }
/** @description Router predicate for schedule-runtime. */
export function isTradingEventSchedule(taskType: string): boolean { return taskType.startsWith('trading-events:'); }

export type EventPlanStatus = 'draft' | 'armed' | 'watching' | 'priced' | 'listed' | 'entry_placed' | 'filled' | 'exits_placed' | 'closed' | 'missed' | 'cancelled' | 'error';
const LIVE_STATUSES: EventPlanStatus[] = ['armed', 'watching', 'priced', 'listed', 'entry_placed', 'filled', 'exits_placed'];
const EDITABLE: EventPlanStatus[] = ['draft', 'armed', 'watching', 'priced'];
const DELETABLE: EventPlanStatus[] = ['draft', 'cancelled', 'closed', 'missed', 'error'];

/** The operator's knobs. Percentages are whole percents (10 = 10%). */
export interface EventPlanParams {
  issuer: string; ticker?: string | null; ipoPrice?: number | null;
  maxPremiumPct: number; sizePctOfEquity?: number | null; notionalUsd?: number | null;
  takeProfitPct: number; stopLossPct: number; timeStopDays: number; entryDeadlineDays: number;
}
/** One plan row as the routes/UI see it. */
export interface EventPlanRow {
  planId: string; userSub: string; bookId: string; bookRef: string; name: string; kind: 'ipo'; status: EventPlanStatus;
  params: EventPlanParams; hypothesis: string | null; narration: string | null; citations: unknown[];
  filings: Record<string, unknown>; ipoPrice: number | null; ticker: string | null;
  entry: Record<string, unknown> | null; exits: Record<string, unknown> | null; result: Record<string, unknown> | null;
  timeline: Array<{ at: string; event: string; detail?: string }>; createdAt: string; updatedAt: string;
}

const num = (v: unknown): number | null => { const n = Number(v); return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n; };
const clamp = (v: number | null, lo: number, hi: number, d: number): number => v == null ? d : Math.min(hi, Math.max(lo, v));
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * @description Validate + default the operator's plan knobs. Throws TradingError(400) when the issuer
 * or the size is missing — a plan that cannot size itself must never be armed.
 * @param raw - The knobs as posted (or as the Studio drafted them).
 * @returns Normalized params.
 */
export function normalizeEventPlanParams(raw: unknown): EventPlanParams {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const issuer = String(r.issuer ?? '').trim().slice(0, 120);
  if (issuer.length < 2) throw new TradingError(400, 'issuer_required', 'The plan needs the issuer name to watch (e.g. "Anthropic").');
  const sizePct = num(r.sizePctOfEquity); const notional = num(r.notionalUsd);
  if (!(sizePct && sizePct > 0) && !(notional && notional > 0)) throw new TradingError(400, 'size_required', 'Size the plan as a percent of the account (sizePctOfEquity) or in dollars (notionalUsd).');
  const tickerRaw = String(r.ticker ?? '').trim().toUpperCase();
  return {
    issuer, ticker: /^[A-Z][A-Z.\-]{0,5}$/.test(tickerRaw) ? tickerRaw : null,
    ipoPrice: (num(r.ipoPrice) ?? 0) > 0 ? num(r.ipoPrice) : null,
    maxPremiumPct: clamp(num(r.maxPremiumPct), 0, 50, 5),
    sizePctOfEquity: sizePct && sizePct > 0 ? clamp(sizePct, 0.5, 100, 10) : null,
    notionalUsd: notional && notional > 0 ? notional : null,
    takeProfitPct: clamp(num(r.takeProfitPct), 1, 200, 10), stopLossPct: clamp(num(r.stopLossPct), 1, 90, 10),
    timeStopDays: Math.round(clamp(num(r.timeStopDays), 1, 365, 30)), entryDeadlineDays: Math.round(clamp(num(r.entryDeadlineDays), 1, 30, 2)),
  };
}

/* ── schema ────────────────────────────────────────────────────────────────── */
/** @description Create the FORCE-RLS plan table (idempotent; runs at first use). */
export async function ensureEventPlansSchema(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool, moduleName: 'trading event plans',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_event_plans (
        plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL, book_id UUID NOT NULL, book_ref TEXT NOT NULL,
        name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'ipo', status TEXT NOT NULL DEFAULT 'draft',
        params JSONB NOT NULL, hypothesis TEXT, narration TEXT, citations JSONB NOT NULL DEFAULT '[]'::jsonb,
        filings JSONB NOT NULL DEFAULT '{}'::jsonb, ipo_price NUMERIC(18,4), ticker TEXT,
        entry JSONB, exits JSONB, result JSONB, timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_trd_event_plans_user_status ON oshal_trading_event_plans (user_sub, status)',
      ...buildOwnerRlsPolicyStatements('oshal_trading_event_plans', 'user_sub'),
    ],
    requirements: [{ table: 'oshal_trading_event_plans', columns: ['plan_id', 'user_sub', 'book_id', 'status', 'params', 'timeline'] }],
  });
}

function rowToPlan(r: Record<string, unknown>): EventPlanRow {
  return {
    planId: String(r.plan_id), userSub: String(r.user_sub), bookId: String(r.book_id), bookRef: String(r.book_ref), name: String(r.name),
    kind: 'ipo', status: String(r.status) as EventPlanStatus, params: r.params as EventPlanParams,
    hypothesis: (r.hypothesis as string) ?? null, narration: (r.narration as string) ?? null, citations: (r.citations as unknown[]) ?? [],
    filings: (r.filings as Record<string, unknown>) ?? {}, ipoPrice: r.ipo_price == null ? null : Number(r.ipo_price), ticker: (r.ticker as string) ?? null,
    entry: (r.entry as Record<string, unknown>) ?? null, exits: (r.exits as Record<string, unknown>) ?? null, result: (r.result as Record<string, unknown>) ?? null,
    timeline: (r.timeline as EventPlanRow['timeline']) ?? [], createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

/* ── CRUD ──────────────────────────────────────────────────────────────────── */
/** @description Create a draft plan bound to ONE book (the account it will trade). */
export async function createEventPlan(pool: AppContext['pool'], sub: string, input: { book: TradingBook; name: string; params: EventPlanParams; hypothesis?: string | null; narration?: string | null; citations?: unknown[] }): Promise<EventPlanRow> {
  await ensureEventPlansSchema(pool);
  const name = String(input.name || 'Event playbook').trim().slice(0, 120);
  const r = await pool.query(
    `INSERT INTO oshal_trading_event_plans (user_sub, book_id, book_ref, name, params, hypothesis, narration, citations, ipo_price, ticker, timeline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [sub, input.book.bookId, input.book.ref, name, JSON.stringify(input.params), input.hypothesis ?? null, input.narration ?? null,
      JSON.stringify(input.citations ?? []), input.params.ipoPrice ?? null, input.params.ticker ?? null,
      JSON.stringify([{ at: new Date().toISOString(), event: 'created', detail: `draft on ${input.book.ref}` }])]);
  logger.info({ sub, planId: r.rows[0].plan_id, book: input.book.ref, issuer: input.params.issuer }, 'event plan created');
  return rowToPlan(r.rows[0]);
}

/** @description Edit knobs/name while the plan has not entered the market (draft|armed|watching|priced). */
export async function updateEventPlan(pool: AppContext['pool'], sub: string, planId: string, patch: { name?: string; params?: Partial<EventPlanParams>; hypothesis?: string | null; narration?: string | null; citations?: unknown[] }): Promise<EventPlanRow | null> {
  const cur = await getEventPlan(pool, sub, planId); if (!cur) return null;
  if (!EDITABLE.includes(cur.status)) throw new TradingError(409, 'plan_locked', `Plan is ${cur.status} — it has orders in the market and cannot be edited; disarm it first.`);
  const params = patch.params ? normalizeEventPlanParams({ ...cur.params, ...patch.params }) : cur.params;
  const r = await pool.query(
    `UPDATE oshal_trading_event_plans SET name = COALESCE($3, name), params = $4, hypothesis = COALESCE($5, hypothesis), narration = COALESCE($6, narration),
        citations = COALESCE($7::jsonb, citations), ipo_price = $8, ticker = $9, updated_at = now(),
        timeline = timeline || $10::jsonb
      WHERE user_sub = $1 AND plan_id = $2 RETURNING *`,
    [sub, planId, patch.name ? String(patch.name).trim().slice(0, 120) : null, JSON.stringify(params), patch.hypothesis ?? null, patch.narration ?? null,
      patch.citations ? JSON.stringify(patch.citations) : null, params.ipoPrice ?? cur.ipoPrice, params.ticker ?? cur.ticker,
      JSON.stringify([{ at: new Date().toISOString(), event: 'edited' }])]);
  return r.rows[0] ? rowToPlan(r.rows[0]) : null;
}

/** @description The caller's plans, optionally for one book, newest first. */
export async function listEventPlans(pool: AppContext['pool'], sub: string, opts?: { bookId?: string }): Promise<EventPlanRow[]> {
  await ensureEventPlansSchema(pool);
  const r = opts?.bookId
    ? await pool.query('SELECT * FROM oshal_trading_event_plans WHERE user_sub = $1 AND book_id = $2 ORDER BY created_at DESC', [sub, opts.bookId])
    : await pool.query('SELECT * FROM oshal_trading_event_plans WHERE user_sub = $1 ORDER BY created_at DESC', [sub]);
  return r.rows.map(rowToPlan);
}

/** @description One plan (owner-scoped). */
export async function getEventPlan(pool: AppContext['pool'], sub: string, planId: string): Promise<EventPlanRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(String(planId))) return null;
  await ensureEventPlansSchema(pool);
  const r = await pool.query('SELECT * FROM oshal_trading_event_plans WHERE user_sub = $1 AND plan_id = $2', [sub, planId]);
  return r.rows[0] ? rowToPlan(r.rows[0]) : null;
}

async function patchPlan(pool: AppContext['pool'], sub: string, planId: string, fields: Record<string, unknown>, event?: { event: string; detail?: string }): Promise<EventPlanRow> {
  const cols = Object.keys(fields); const vals: unknown[] = [sub, planId];
  const sets = cols.map((c, i) => { vals.push(typeof fields[c] === 'object' && fields[c] !== null ? JSON.stringify(fields[c]) : fields[c]); return `${c} = $${i + 3}`; });
  if (event) { vals.push(JSON.stringify([{ at: new Date().toISOString(), ...event }])); sets.push(`timeline = timeline || $${vals.length}::jsonb`); }
  sets.push('updated_at = now()');
  const r = await pool.query(`UPDATE oshal_trading_event_plans SET ${sets.join(', ')} WHERE user_sub = $1 AND plan_id = $2 RETURNING *`, vals);
  if (!r.rows[0]) throw new TradingError(404, 'plan_not_found', 'Plan not found.');
  return rowToPlan(r.rows[0]);
}

/** @description Arm a draft (or a cancelled) plan. The confirm gate lives in the route (428). */
export async function armEventPlan(pool: AppContext['pool'], sub: string, planId: string): Promise<EventPlanRow> {
  const cur = await getEventPlan(pool, sub, planId); if (!cur) throw new TradingError(404, 'plan_not_found', 'Plan not found.');
  if (!['draft', 'cancelled'].includes(cur.status)) throw new TradingError(409, 'plan_not_armable', `Plan is ${cur.status}.`);
  normalizeEventPlanParams(cur.params);
  return patchPlan(pool, sub, planId, { status: 'armed', entry: null, exits: null, result: null }, { event: 'armed', detail: 'the executor watches EDGAR from its next fire' });
}

/** @description Disarm: cancel any working orders this plan placed, then mark cancelled. A filled position stays. */
export async function disarmEventPlan(ctx: AppContext, sub: string, planId: string, deps: EventPlanDeps = defaultDeps()): Promise<EventPlanRow> {
  const cur = await getEventPlan(ctx.pool, sub, planId); if (!cur) throw new TradingError(404, 'plan_not_found', 'Plan not found.');
  if (!LIVE_STATUSES.includes(cur.status)) throw new TradingError(409, 'plan_not_active', `Plan is ${cur.status}.`);
  const notes: string[] = [];
  const book = await loadBook(ctx.pool, sub, cur.bookId);
  if (book) {
    const broker = deps.broker(book, sub);
    for (const id of workingOrderIds(cur)) { try { await broker.cancelOrder(id); notes.push(`cancelled ${id}`); } catch (err) { logger.error({ err, planId, id }, 'disarm cancel failed'); notes.push(`cancel FAILED ${id}`); } }
    if (cur.status === 'exits_placed') notes.push('position remains open — its protective orders are cancelled; manage it manually');
  }
  return patchPlan(ctx.pool, sub, planId, { status: 'cancelled' }, { event: 'disarmed', detail: notes.join('; ') || undefined });
}

function workingOrderIds(p: EventPlanRow): string[] {
  const ids: string[] = [];
  if (p.status === 'entry_placed' && p.entry?.orderId) ids.push(String(p.entry.orderId));
  if (p.status === 'exits_placed') { if (p.exits?.tpOrderId) ids.push(String(p.exits.tpOrderId)); if (p.exits?.stopOrderId) ids.push(String(p.exits.stopOrderId)); }
  return ids;
}

/** @description Delete a plan that has nothing in the market (draft|cancelled|closed|missed|error). */
export async function deleteEventPlan(pool: AppContext['pool'], sub: string, planId: string): Promise<boolean> {
  const cur = await getEventPlan(pool, sub, planId); if (!cur) return false;
  if (!DELETABLE.includes(cur.status)) throw new TradingError(409, 'plan_active', `Plan is ${cur.status} — disarm it first.`);
  const r = await pool.query('DELETE FROM oshal_trading_event_plans WHERE user_sub = $1 AND plan_id = $2', [sub, planId]);
  return (r.rowCount ?? 0) > 0;
}

/* ── dry run ───────────────────────────────────────────────────────────────── */
/**
 * @description What the executor WOULD place at example IPO prices — the honest substitute for a
 * backtest on an unlisted stock. Sizing uses the account equity when known.
 * @param plan - The plan.
 * @param equity - The account's equity, or null when unknown (rows then show the sizing formula's inputs).
 * @param examplePrices - IPO prices to tabulate (default: the known IPO price, else 25/50/100).
 * @returns Assumptions, one row per example price, the manual steps, and a guardrail note when the cap binds.
 */
export function dryRunEventPlan(plan: EventPlanRow, equity: number | null, examplePrices?: number[]) {
  const p = plan.params; const g = guardrails();
  const prices = examplePrices?.length ? examplePrices : (plan.ipoPrice ? [plan.ipoPrice] : [25, 50, 100]);
  const size = p.notionalUsd ?? (equity != null && p.sizePctOfEquity ? equity * p.sizePctOfEquity / 100 : null);
  let capped = false;
  const rows = prices.map((ipo) => {
    const entryLimit = round2(ipo * (1 + p.maxPremiumPct / 100));
    let shares = size != null ? Math.floor(size / entryLimit) : 0;
    if (g.maxNotionalUsd && shares * entryLimit > g.maxNotionalUsd) { shares = Math.floor(g.maxNotionalUsd / entryLimit); capped = true; }
    const takeProfit = round2(ipo * (1 + p.takeProfitPct / 100)); const stop = round2(ipo * (1 - p.stopLossPct / 100));
    return { ipoPrice: ipo, entryLimit, shares, entryNotional: round2(shares * entryLimit), takeProfit, stop, maxLossUsd: round2((entryLimit - stop) * shares), targetGainUsd: round2((takeProfit - entryLimit) * shares) };
  });
  const assumptions = [
    `Watch EDGAR for ${p.issuer}: the public S-1/F-1, then the 424B4 pricing prospectus (IPO price + ticker).`,
    `Enter on the FIRST trade in a regular session with a day LIMIT at IPO price × ${(1 + p.maxPremiumPct / 100).toFixed(2)} (no market-on-open).`,
    size != null ? `Size ${p.notionalUsd ? money(p.notionalUsd) : p.sizePctOfEquity + '% of equity ' + money(equity!)} = ${money(size)}.` : `Size ${p.sizePctOfEquity}% of the account — equity unknown right now, so shares show as 0 until it is read.`,
    `After the fill: take-profit SELL LIMIT GTC at IPO × ${(1 + p.takeProfitPct / 100).toFixed(2)}; STOP SELL GTC at IPO × ${(1 - p.stopLossPct / 100).toFixed(2)}; whichever fills cancels the other.`,
    `Time stop: market out after ${p.timeStopDays} days. Entry deadline: ${p.entryDeadlineDays} trading day(s) after listing, else the plan is marked missed.`,
  ];
  const manualSteps = [
    'Offer-price allocation is not something software can secure: if you want IPO shares at the offer, submit a Conditional Offer to Purchase on schwab.com before 4 p.m. ET the day before pricing and CONFIRM it after pricing.',
    `Make sure ${plan.bookRef} is set to trading (Start trading) before listing day — the engine refuses buys on a view-only account.`,
    'Keep the sized cash available in the account; a cash (IRA) account cannot buy on margin.',
  ];
  return { assumptions, rows, manualSteps, guardrailNote: capped ? `Capped by the per-order guardrail: max ${money(g.maxNotionalUsd)} per order (TRADING_MAX_NOTIONAL_USD).` : null };
}
const money = (n: number | null | undefined): string => n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

/* ── deps (injectable for the real-DB spec) ────────────────────────────────── */
/** One EDGAR full-text hit we care about. */
export interface EdgarHit { form: string; date: string; url: string; displayName: string; cik: string }
/** The venue surface the state machine needs. */
export interface EventBroker { configured(): boolean; getAccount(): Promise<{ equity: number }>; getOrder(id: string): Promise<OrderResult>; cancelOrder(id: string): Promise<void> }
/** Everything the tick touches outside the database — swapped for fakes in the spec. */
export interface EventPlanDeps {
  now: () => Date;
  session: () => Promise<'closed' | 'pre' | 'regular' | 'post'>;
  edgarSearch: (issuer: string) => Promise<EdgarHit[]>;
  fetchText: (url: string) => Promise<string | null>;
  broker: (book: TradingBook, sub: string) => EventBroker;
  latestTrade: (book: TradingBook, sub: string, ticker: string) => Promise<{ price: number; asOf: Date } | null>;
  place: (pool: AppContext['pool'], sub: string, book: TradingBook, decisionId: string, requestId: string) => Promise<OrderResult>;
}
const bindingOf = (b: TradingBook) => b.accountNumber ? { accountNumber: b.accountNumber, connectionKey: b.connectionKey } : undefined;

/** @description The production deps: real clock, venue session, EDGAR, broker adapter, market data, and the engine's order path. */
export function defaultDeps(): EventPlanDeps {
  return {
    now: () => new Date(),
    session: async () => (await tradingSession()) as 'closed' | 'pre' | 'regular' | 'post',
    edgarSearch: edgarFullTextSearch,
    fetchText: fetchDocumentText,
    broker: (book, sub) => getBrokerAdapter(book.kind, sub, bindingOf(book)) as unknown as EventBroker,
    latestTrade: async (book, sub, ticker) => { const t = await getMarketData(book.kind, sub).latestTrade(ticker).catch(() => null); return t && !isTickStale(t) ? { price: t.price, asOf: t.asOf } : null; },
    place: (pool, sub, book, decisionId, requestId) => placeDecisionOrder(pool, sub, book, decisionId, requestId, true),
  };
}

async function edgarFullTextSearch(issuer: string): Promise<EdgarHit[]> {
  const url = `${EDGAR_SEARCH}?q=${encodeURIComponent('"' + issuer + '"')}&forms=S-1,F-1,424B4,424B1`;
  const r = await fetch(url, { headers: { 'User-Agent': EDGAR_UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`EDGAR search ${r.status}`);
  const j = await r.json() as { hits?: { hits?: Array<{ _id: string; _source: Record<string, unknown> }> } };
  const want = issuer.toLowerCase();
  return (j.hits?.hits ?? []).map((h) => {
    const s = h._source; const names = (s.display_names as string[]) ?? []; const ciks = (s.ciks as string[]) ?? [];
    const adsh = String(s.adsh ?? ''); const file = String(h._id ?? '').split(':')[1] ?? '';
    return { form: String(s.form ?? (s.root_forms as string[])?.[0] ?? ''), date: String(s.file_date ?? ''), displayName: names[0] ?? '', cik: ciks[0] ?? '',
      url: ciks[0] && adsh && file ? `https://www.sec.gov/Archives/edgar/data/${Number(ciks[0])}/${adsh.replace(/-/g, '')}/${file}` : '' };
  }).filter((h) => h.displayName.toLowerCase().includes(want));
}

async function fetchDocumentText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': EDGAR_UA } });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 3_000_000);
    return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  } catch (err) { logger.error({ err, url }, 'EDGAR document fetch failed'); return null; }
}

/** @description Pull the IPO price and ticker out of a pricing prospectus's text (null when absent). */
export function parsePricingProspectus(text: string): { ipoPrice: number | null; ticker: string | null } {
  const px = text.match(/initial public offering price(?: per share)?\s+(?:is|of|will be|at)\s+\$\s?(\d{1,4}(?:\.\d{1,2})?)/i) ?? text.match(/offering price of\s+\$\s?(\d{1,4}(?:\.\d{1,2})?)\s+per share/i);
  const tk = text.match(/under the (?:ticker )?symbol\s+[“"']?([A-Z][A-Z.\-]{0,5})[”"']?/);
  return { ipoPrice: px ? Number(px[1]) : null, ticker: tk ? tk[1] : null };
}

/* ── the state machine ─────────────────────────────────────────────────────── */
/**
 * @description Run one tick over every active plan of one user. Each plan advances at most one
 * step per tick; every step is recorded on the plan's timeline. Never throws for one plan's sake —
 * a plan that errors is marked and the others still run.
 * @param ctx - App context (pool).
 * @param sub - The owner.
 * @param deps - Venue/EDGAR/clock deps (defaults to production; the spec injects fakes).
 * @returns Which plans transitioned.
 */
export async function tickEventPlans(ctx: AppContext, sub: string, deps: EventPlanDeps = defaultDeps()): Promise<{ processed: number; transitions: string[] }> {
  await ensureEventPlansSchema(ctx.pool);
  const r = await ctx.pool.query(`SELECT * FROM oshal_trading_event_plans WHERE user_sub = $1 AND status = ANY($2::text[]) ORDER BY created_at`, [sub, LIVE_STATUSES]);
  const transitions: string[] = [];
  for (const row of r.rows) {
    const plan = rowToPlan(row);
    try {
      const book = await loadBook(ctx.pool, sub, plan.bookId);
      if (!book) { await patchPlan(ctx.pool, sub, plan.planId, { status: 'error' }, { event: 'error', detail: 'account/book no longer exists' }); transitions.push(`${plan.planId}:error`); continue; }
      if (book.kind === 'live' && !liveTradingEnabled()) { logger.warn({ planId: plan.planId }, 'live trading disabled — event plan waits'); continue; }
      const next = await stepPlan(ctx, sub, plan, book, deps);
      if (next) transitions.push(`${plan.planId}:${next}`);
    } catch (err) {
      logger.error({ err, planId: plan.planId, status: plan.status }, 'event plan tick failed');
      await patchPlan(ctx.pool, sub, plan.planId, {}, { event: 'tick_error', detail: (err as Error).message.slice(0, 300) }).catch(() => undefined);
    }
  }
  return { processed: r.rows.length, transitions };
}

async function stepPlan(ctx: AppContext, sub: string, plan: EventPlanRow, book: TradingBook, deps: EventPlanDeps): Promise<string | null> {
  switch (plan.status) {
    case 'armed': await patchPlan(ctx.pool, sub, plan.planId, { status: 'watching' }, { event: 'watching', detail: `EDGAR full-text watch for "${plan.params.issuer}"` }); return 'watching';
    case 'watching': return stepWatching(ctx, sub, plan, deps);
    case 'priced': return stepPriced(ctx, sub, plan, book, deps);
    case 'listed': return stepListed(ctx, sub, plan, book, deps);
    case 'entry_placed': return stepEntryPlaced(ctx, sub, plan, book, deps);
    case 'filled': return stepFilled(ctx, sub, plan, book, deps);
    case 'exits_placed': return stepExitsPlaced(ctx, sub, plan, book, deps);
    default: return null;
  }
}

/** EDGAR: record the first public S-1/F-1 and the 424B4 pricing prospectus; parse price + ticker. */
async function stepWatching(ctx: AppContext, sub: string, plan: EventPlanRow, deps: EventPlanDeps): Promise<string | null> {
  const hits = await deps.edgarSearch(plan.params.issuer);
  const filings: Record<string, unknown> = { ...plan.filings };
  const s1 = hits.filter((h) => /^(S-1|F-1)/.test(h.form)).sort((a, b) => a.date.localeCompare(b.date))[0];
  const pricing = hits.filter((h) => /^424B[14]/.test(h.form)).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (s1 && !filings.s1) filings.s1 = { form: s1.form, date: s1.date, url: s1.url };
  if (pricing && !filings.pricing) filings.pricing = { form: pricing.form, date: pricing.date, url: pricing.url };
  let ipoPrice = plan.params.ipoPrice ?? plan.ipoPrice; let ticker = plan.params.ticker ?? plan.ticker;
  if (pricing && (!ipoPrice || !ticker)) {
    const text = await deps.fetchText(pricing.url);
    if (text) { const parsed = parsePricingProspectus(text); ipoPrice = ipoPrice ?? parsed.ipoPrice; ticker = ticker ?? parsed.ticker; }
  }
  const changed = JSON.stringify(filings) !== JSON.stringify(plan.filings) || ipoPrice !== plan.ipoPrice || ticker !== plan.ticker;
  if (ipoPrice && ticker) {
    await patchPlan(ctx.pool, sub, plan.planId, { status: 'priced', filings, ipo_price: ipoPrice, ticker }, { event: 'priced', detail: `${ticker} @ ${money(ipoPrice)} (${String((filings.pricing as { form?: string })?.form ?? 'operator-supplied')})` });
    return 'priced';
  }
  if (changed) await patchPlan(ctx.pool, sub, plan.planId, { filings, ipo_price: ipoPrice, ticker }, { event: 'filing_seen', detail: [s1 && `S-1 ${s1.date}`, pricing && `${pricing.form} ${pricing.date}`].filter(Boolean).join(', ') || undefined });
  return null;
}

/** Listing detection: a fresh trade for the ticker inside a regular session. */
async function stepPriced(ctx: AppContext, sub: string, plan: EventPlanRow, book: TradingBook, deps: EventPlanDeps): Promise<string | null> {
  if ((await deps.session()) !== 'regular') return null;
  const t = await deps.latestTrade(book, sub, plan.ticker!);
  if (!t) return null;
  await patchPlan(ctx.pool, sub, plan.planId, { status: 'listed', entry: { listedAt: deps.now().toISOString(), firstPrice: t.price, attempts: 0 } }, { event: 'listed', detail: `first trade ${money(t.price)}` });
  return stepListed(ctx, sub, { ...plan, status: 'listed', entry: { listedAt: deps.now().toISOString(), firstPrice: t.price, attempts: 0 } }, book, deps);
}

/** Place the entry: day LIMIT at IPO × (1 + premium), sized from equity or notional, guardrail-capped. */
async function stepListed(ctx: AppContext, sub: string, plan: EventPlanRow, book: TradingBook, deps: EventPlanDeps): Promise<string | null> {
  if ((await deps.session()) !== 'regular') return null;
  if (String(process.env.TRADING_HALT ?? '').toLowerCase() === 'true') return null;
  const entry = { ...(plan.entry ?? {}) } as Record<string, unknown>;
  const listedAt = new Date(String(entry.listedAt ?? deps.now().toISOString()));
  if (deps.now().getTime() - listedAt.getTime() > plan.params.entryDeadlineDays * 86_400_000) {
    await patchPlan(ctx.pool, sub, plan.planId, { status: 'missed' }, { event: 'missed', detail: 'entry deadline passed without a fill' }); return 'missed';
  }
  const ipo = plan.ipoPrice!; const limitPx = round2(ipo * (1 + plan.params.maxPremiumPct / 100));
  const broker = deps.broker(book, sub);
  const size = plan.params.notionalUsd ?? (await broker.getAccount()).equity * (plan.params.sizePctOfEquity ?? 0) / 100;
  let qty = Math.floor(size / limitPx); const g = guardrails();
  if (g.maxNotionalUsd && qty * limitPx > g.maxNotionalUsd) qty = Math.floor(g.maxNotionalUsd / limitPx);
  if (qty < 1) { await patchPlan(ctx.pool, sub, plan.planId, { status: 'error' }, { event: 'error', detail: `size ${money(size)} buys no shares at ${money(limitPx)}` }); return 'error'; }
  const attempt = Number(entry.attempts ?? 0) + 1;
  try {
    const decisionId = await mintDecision(ctx.pool, sub, book, plan, { side: 'buy', symbol: plan.ticker!, qty, orderType: 'limit', limitPrice: limitPx, tif: 'day', why: `Event playbook "${plan.name}": first-trade entry, limit ${money(limitPx)} = IPO ${money(ipo)} × ${(1 + plan.params.maxPremiumPct / 100).toFixed(2)}` });
    const res = await deps.place(ctx.pool, sub, book, decisionId, `evt-${plan.planId.slice(0, 8)}-entry-${attempt}`);
    await patchPlan(ctx.pool, sub, plan.planId, { status: 'entry_placed', entry: { ...entry, attempts: attempt, decisionId, orderId: res.id, limitPx, qty, placedAt: deps.now().toISOString() } }, { event: 'entry_placed', detail: `BUY ${qty} ${plan.ticker} limit ${money(limitPx)} day (${res.status})` });
    return 'entry_placed';
  } catch (err) {
    const code = err instanceof TradingError ? err.code : 'error';
    if (code === 'book_disabled') { await patchPlan(ctx.pool, sub, plan.planId, {}, { event: 'blocked', detail: 'account is view-only — Start trading on it to allow the buy; retrying each fire' }); return null; }
    logger.error({ err, planId: plan.planId }, 'event plan entry failed');
    const status = attempt >= 3 ? 'error' : 'listed';
    await patchPlan(ctx.pool, sub, plan.planId, { status, entry: { ...entry, attempts: attempt } }, { event: 'entry_failed', detail: `${code}: ${(err as Error).message.slice(0, 200)}` });
    return status === 'error' ? 'error' : null;
  }
}

/** Poll the entry order; on a fill move to filled (exits placed next); expired/cancelled → retry or missed. */
async function stepEntryPlaced(ctx: AppContext, sub: string, plan: EventPlanRow, book: TradingBook, deps: EventPlanDeps): Promise<string | null> {
  const entry = plan.entry ?? {}; const broker = deps.broker(book, sub);
  const o = await broker.getOrder(String(entry.orderId));
  if (o.status === 'filled' || (o.filledQty > 0 && ['canceled', 'cancelled', 'expired'].includes(String(o.status)))) {
    const filledQty = Number(o.filledQty || o.qty), avg = Number(o.filledAvgPrice ?? entry.limitPx);
    const next = { ...entry, filledQty, filledAvgPrice: avg, filledAt: deps.now().toISOString() };
    await patchPlan(ctx.pool, sub, plan.planId, { status: 'filled', entry: next }, { event: 'filled', detail: `${filledQty} @ ${money(avg)}` });
    return stepFilled(ctx, sub, { ...plan, status: 'filled', entry: next }, book, deps);
  }
  if (['canceled', 'cancelled', 'expired', 'rejected'].includes(String(o.status))) {
    await patchPlan(ctx.pool, sub, plan.planId, { status: 'listed' }, { event: 'entry_unfilled', detail: `${o.status}${o.rejectReason ? ': ' + o.rejectReason : ''} — re-placing while inside the deadline` });
    return 'listed';
  }
  return null;
}

/** Place both exits for the filled quantity: TP limit GTC + stop GTC (sibling cancelled on fill). */
async function stepFilled(ctx: AppContext, sub: string, plan: EventPlanRow, book: TradingBook, deps: EventPlanDeps): Promise<string | null> {
  const entry = plan.entry ?? {}; const qty = Number(entry.filledQty); const ipo = plan.ipoPrice!;
  const tpPx = round2(ipo * (1 + plan.params.takeProfitPct / 100)); const stopPx = round2(ipo * (1 - plan.params.stopLossPct / 100));
  const attempt = Number((plan.exits ?? {}).attempts ?? 0) + 1; const tag = plan.planId.slice(0, 8);
  const tpDecision = await mintDecision(ctx.pool, sub, book, plan, { side: 'sell', symbol: plan.ticker!, qty, orderType: 'limit', limitPrice: tpPx, tif: 'gtc', why: `Event playbook "${plan.name}": take-profit +${plan.params.takeProfitPct}% over the IPO price` });
  const tp = await deps.place(ctx.pool, sub, book, tpDecision, `evt-${tag}-tp-${attempt}`);
  const stopDecision = await mintDecision(ctx.pool, sub, book, plan, { side: 'sell', symbol: plan.ticker!, qty, orderType: 'stop', stopPrice: stopPx, tif: 'gtc', why: `Event playbook "${plan.name}": stop −${plan.params.stopLossPct}% under the IPO price` });
  const st = await deps.place(ctx.pool, sub, book, stopDecision, `evt-${tag}-stop-${attempt}`);
  await patchPlan(ctx.pool, sub, plan.planId, { status: 'exits_placed', exits: { attempts: attempt, tpOrderId: tp.id, tpPx, stopOrderId: st.id, stopPx, qty, placedAt: deps.now().toISOString() } },
    { event: 'exits_placed', detail: `TP sell ${qty} limit ${money(tpPx)} GTC · STOP sell ${qty} @ ${money(stopPx)} GTC` });
  return 'exits_placed';
}

/** Poll both exits; whichever fills cancels the other; time stop → market out. */
async function stepExitsPlaced(ctx: AppContext, sub: string, plan: EventPlanRow, book: TradingBook, deps: EventPlanDeps): Promise<string | null> {
  const ex = plan.exits ?? {}; const entry = plan.entry ?? {}; const broker = deps.broker(book, sub);
  const [tp, st] = await Promise.all([broker.getOrder(String(ex.tpOrderId)), broker.getOrder(String(ex.stopOrderId))]);
  const tpFilled = tp.status === 'filled', stFilled = st.status === 'filled';
  if (tpFilled && stFilled) { await patchPlan(ctx.pool, sub, plan.planId, { status: 'error' }, { event: 'error', detail: 'BOTH exits filled — position may be short; review the account NOW' }); return 'error'; }
  if (tpFilled || stFilled) {
    const winner = tpFilled ? tp : st; const loserId = tpFilled ? ex.stopOrderId : ex.tpOrderId;
    try { await broker.cancelOrder(String(loserId)); } catch (err) { logger.error({ err, planId: plan.planId }, 'sibling cancel failed'); }
    const exitPx = Number(winner.filledAvgPrice ?? (tpFilled ? ex.tpPx : ex.stopPx)); const qty = Number(winner.filledQty || ex.qty);
    const pnl = round2((exitPx - Number(entry.filledAvgPrice)) * qty);
    await patchPlan(ctx.pool, sub, plan.planId, { status: 'closed', result: { reason: tpFilled ? 'take_profit' : 'stop', exitPx, qty, pnl, closedAt: deps.now().toISOString() } }, { event: 'closed', detail: `${tpFilled ? 'take-profit' : 'stop'} ${qty} @ ${money(exitPx)} · P&L ${money(pnl)}` });
    return 'closed';
  }
  const filledAt = new Date(String(entry.filledAt ?? deps.now().toISOString()));
  if (deps.now().getTime() - filledAt.getTime() > plan.params.timeStopDays * 86_400_000 && (await deps.session()) === 'regular') {
    for (const id of [ex.tpOrderId, ex.stopOrderId]) { try { await broker.cancelOrder(String(id)); } catch (err) { logger.error({ err, planId: plan.planId }, 'time-stop cancel failed'); } }
    const decisionId = await mintDecision(ctx.pool, sub, book, plan, { side: 'sell', symbol: plan.ticker!, qty: Number(ex.qty), orderType: 'market', tif: 'day', why: `Event playbook "${plan.name}": time stop after ${plan.params.timeStopDays} days` });
    const out = await deps.place(ctx.pool, sub, book, decisionId, `evt-${plan.planId.slice(0, 8)}-time-${Number(ex.attempts ?? 1)}`);
    const exitPx = Number(out.filledAvgPrice ?? 0); const pnl = exitPx ? round2((exitPx - Number(entry.filledAvgPrice)) * Number(ex.qty)) : null;
    await patchPlan(ctx.pool, sub, plan.planId, { status: 'closed', result: { reason: 'time_stop', exitPx: exitPx || null, qty: Number(ex.qty), pnl, orderId: out.id, closedAt: deps.now().toISOString() } }, { event: 'closed', detail: `time stop — market sell ${ex.qty} (${out.status})` });
    return 'closed';
  }
  return null;
}

/** Mint the 'event-playbook' signal + decision the engine executes (book_id explicit on both). */
async function mintDecision(pool: AppContext['pool'], sub: string, book: TradingBook, plan: EventPlanRow, o: { side: 'buy' | 'sell'; symbol: string; qty: number; orderType: 'market' | 'limit' | 'stop'; limitPrice?: number; stopPrice?: number; tif: 'day' | 'gtc'; why: string }): Promise<string> {
  const artifact = JSON.stringify({ source: 'event-playbook', planId: plan.planId, ...o, at: Date.now() });
  const hash = crypto.createHash('sha256').update(artifact).digest('hex');
  const sig = (await pool.query(
    `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, title, body, url, symbols, indicators, content_hash)
       VALUES ($1,$2,$3,'event-playbook',$4,$5,$6,$7,$8,$9) RETURNING signal_id`,
    [sub, book.kind, book.bookId, `Event playbook: ${plan.name}`, o.why, (plan.filings.pricing as { url?: string })?.url ?? null, [o.symbol], JSON.stringify({ planId: plan.planId, ipoPrice: plan.ipoPrice, params: plan.params }), hash])).rows[0];
  const row = (await pool.query(
    `INSERT INTO oshal_trading_decisions (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, limit_price, stop_price, time_in_force, confidence, rationale, indicators, guardrails)
       VALUES ($1,$2,$3,$4::uuid[],'event-playbook',$5,$6,$5,$7,$8,$9,$10,$11,1,$12,$13,$14) RETURNING decision_id`,
    [sub, book.kind, book.bookId, [sig.signal_id], o.side, o.symbol, o.qty, o.orderType, o.limitPrice ?? null, o.stopPrice ?? null, o.tif, o.why, JSON.stringify({ planId: plan.planId }), JSON.stringify(guardrails())])).rows[0];
  return String(row.decision_id);
}

/* ── schedule leg ──────────────────────────────────────────────────────────── */
/**
 * @description The 'trading-events:<sub>' leg. Refuses to act while TRADING_EVENT_PLANS is off
 * (logged, success — the schedule is not an error, the flag is a choice).
 * @param ctx - App context.
 * @param schedule - The fired schedule (taskData.userSub).
 * @returns Dispatch result.
 */
export async function dispatchTradingEventSchedule(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const sub = String((schedule.taskData as Record<string, unknown>).userSub || '');
  if (!sub) return { success: false, scheduleId: schedule.id, error: 'event schedule missing userSub' };
  if (!eventPlansEnabled()) { logger.warn({ scheduleId: schedule.id }, 'TRADING_EVENT_PLANS is off — event plans not executed this fire'); return { success: true, scheduleId: schedule.id }; }
  const t0 = Date.now();
  const out = await tickEventPlans(ctx, sub);
  // ADR-138 D3: protected lots ride the same cadence (dynamic import — the lot module imports this
  // module's deps, so a static import would be a cycle).
  const lots = await import('./trading-pinned-lots.js').then((m) => m.tickPinnedLots(ctx, sub)).catch((err) => { logger.error({ err, sub }, 'pinned lots tick failed'); return null; });
  // ADR-136 D4: dated (timed) operator orders ride the same 5-minute leg — fired once each through the
  // engine at their chosen ET time (same dynamic-import reason as the lots).
  const dated = await import('./trading-dated-orders.js').then((m) => m.tickDatedOrders(ctx, sub)).catch((err) => { logger.error({ err, sub }, 'dated orders tick failed'); return null; });
  logger.info({ sub, ...out, lots, dated, ms: Date.now() - t0 }, 'event plans + protected lots + dated orders tick');
  return { success: true, scheduleId: schedule.id };
}
