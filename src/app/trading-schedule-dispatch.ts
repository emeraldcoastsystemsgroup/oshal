/**
 * Trading autopilot dispatch — the every-5-minutes branch of the shared scheduler.
 *
 * When a `trading-autopilot:<sub>` schedule fires there is NO user session, so this module
 * (the trading analogue of home-schedule-dispatch.ts):
 *  (a) reads the owner sub + book + universe from the schedule's taskData,
 *  (b) skips quietly when the market is closed or the broker/market-data keys are absent,
 *  (c) scans the universe with the deterministic multi-timeframe engine, sizes each actionable
 *      name by conviction within the guardrails, places PAPER orders through the SAME
 *      `placeDecisionOrder` core the interactive route uses (so the signal → decision → order
 *      provenance invariant holds), and
 *  (d) logs ONE summary `trading-decision` ticket per run (only when something traded).
 *
 * SAFETY: autopilot is PAPER-ONLY. A live book is refused here even if the schedule asks for it —
 * autonomous live trading stays behind the ADR-052 manual sign-off, never a cron. Position churn
 * is bounded: one open long per name (no pyramiding every 5 min, no autopilot shorts), capped at
 * MAX_ORDERS_PER_RUN per fire. The deterministic engine runs in the controller exactly like the
 * existing /scan + /decide-algo paths — no LLM on this path.
 *
 * The shared scheduler stays generic: schedule-runtime only branches here when isTradingSchedule
 * matches. The ScheduleService handle is injected (setTradingScheduleService) for the control route.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — autopilot run loop (market-open guard → multi-timeframe scan → risk-sized paper orders via placeDecisionOrder → summary ticket), paper-only safety, position-aware sizing, and the injected ScheduleService handle for the control route.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Reconcile open orders at the top of every fire (reconcileOpenOrders) so submit-time pending_new rows sync to their real filled/terminal state — the ledger was frozen at pending while Alpaca had filled. Runs before the market-open gate so the last batch still catches up.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Add the sell-side the book was missing: trailing-stop exits (computeExits, peak store) + a short-timeframe BREAKDOWN protective exit (breakdownDecision) that sells a held name crashing on 5Min+1Hour even while the regime is still up — the news-driven intraday selloff the weighted score never caught (book had 0 sells ever). Extracted placeEntries/computeExits to keep runAutopilot small.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Fix the pre-market pyramiding bug: dedup + sizing only saw FILLED positions, so a pre/post-market LIMIT order that sits pending for hours was invisible — every fire re-bought the same name (140 shares of one ticker, cash driven negative) until the open filled them all at once. loadInFlight reads still-working orders from the ledger; entries now exclude in-flight symbols AND reserve their pending buy notional from cash, so a working order counts exactly like a held position.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Scope capAccount to the LIVE book only. The TRADING_CAPITAL_CAP_USD=20K live cap (armed 07-07) applied unscoped to BOTH modes, pinning the $104K paper book's equity to $20K at the 4 AM fire — per-name cap fell to $2K and rebalanceTrims mass-liquidated ~2/3 of every paper position at thin pre-market prices (and polluted the daily-equity store with equity=20000). Paper is the full-size reference book; the cap now no-ops for mode!=='live'.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | freeStaleSells: cancel still-working sells for symbols the engine wants to exit THIS fire before re-placing. A stranded ext-hours marketable limit (price fell away before fill) reserved the shares and rejected every later exit attempt ("insufficient qty available") — AMD/MU rode the 07-07 pre-market crash from 4:05 to the open, locked out of their own protection. Applied to both the protective-exit and breakdown paths.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Book-scope the autopilot requestId (`auto-<mode>-…`). Both books fire on the same 5-min tick, so the book-independent id collided paper vs live on the (user_sub, client_order_id) upsert and a paper Alpaca fill overwrote a LIVE Schwab order's broker id. Note freeStaleSells (07-07) only bounded the SYMPTOM of the stale-limit loop: with the limit priced off a frozen off-hours print it cancelled and re-placed the same unfillable order every fire (MRNA 97×). The cause is fixed in placeDecisionOrder, which now declines to price against a stale tick.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Per-symbol core targets: TRADING_CORE_SYMBOLS now accepts `SPY:35,SKHYV:0` — a `:pct` name is topped up toward its own target, a `:0` name is exemption-only (held, never bought, never sleeve-sold — the SKHY IPO hold shape), bare names keep the legacy equal split of TRADING_CORE_TARGET_PCT. Unblocks arming the SPY beta core beside the operator's IPO hold without the equal-split diluting SPY's share or the top-up hammering a not-yet-tradeable when-issued ticker. coreConfig exported for the unit spec.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Operator blocklist honored at all three autonomous-entry points (scan placeEntries, rotateSleeve targets, pop-catcher surges). A held blocked name is dropped from rotation targets → sold on the next rebalance; protective exits unaffected. rankUniverse also exported 07-10 for the rotation backtest.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | ADR-095 Strategy Library apply-to-profile: dispatchTradingSchedule reads the caller's ACTIVE config override once per fire and threads it through runAutopilot → riskPolicy/coreConfig/rotationConfig/rotateSleeve, plus universe precedence (override explicit universe > schedule pin > DEFAULT_UNIVERSE). No override row → byte-identical env behavior. rotationConfig exported for the lab routes' env-vs-applied comparison.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | CORE TRIM (coreTradePlan) — the beta core now tracks its target % in BOTH directions. ensureCore only ever BOUGHT, and the core is exempt from every sleeve sell, so a `60%` target was really a 60% FLOOR that ratcheted up with nothing able to bring it back: the 16:55 over-buy (above) left the live book at 79.2% SPY vs its 60% target and it would have stayed there forever. A core above target is now trimmed back to it, using the SAME 1%-of-equity dead band as the top-up (a target is a target, not a ratchet). Sizing extracted to the pure, exported `coreTradePlan` so the dangerous edges are testable without a broker: a `:0` exemption-only hold (the SKHY IPO position) is NEVER bought and NEVER trimmed, and a trim is bounded by shares actually held so a stale position row can never open a SHORT. "Exempt from sleeve sells" never meant "exempt from its own rebalance". Operator-approved 07-14; first trim lands at the next regular-session fire (~13 SPY).
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | FAIL-CLOSED on a broker POSITIONS read failure. `getPositions().catch(() => [])` sat one line below the account read's fail-closed guard and quietly did the opposite: an empty array is a LEGITIMATE book state, so the engine could not tell "read failed" from "genuinely flat" and ran the whole fire believing it owned nothing — ensureCore re-buys the core from scratch with all available cash, computeExits fires NO stops, rotation re-buys held names. Live proof: 2026-07-14 16:55 a failed read topped the SPY core up by 14 shares (~$10.5K) against a real shortfall of ~$680, taking the live core from 58.7% to 79% of equity with no trim path back (the core is exempt from sleeve sells). Now a THROW skips the fire, exactly like the account read since the 07-07 "zombie live fires"; a genuinely-empty successful read still proceeds.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | ROTATION ENTRY GUARDS (entry-guards.ts), threaded into both rotation paths. The 2026-07-14 live open stopped IBM out at -23.8% on its Q2 revenue-miss gap and RE-BOUGHT it in the same fire. Two causes: runAutopilot built `exiting` for the protective leg but never passed it to rotation (so rotation re-bought the stop's own exit — voiding the stop and booking a wash sale), and the ranker scores on 1Day closes that PREDATE the gap (so IBM still ranked top-12 on stale data while down 22%). Both rotation paths now split the leaderboard: the HOLD set (drop-out sells) is unchanged and unguarded — guarding it would double-sell a name the protective leg is already exiting — while the BUY set is filtered by entryBlock (exiting-this-fire | gap-down ≥ TRADING_ROTATION_MAX_GAP_DOWN_PCT, default 8), with refused leaders backfilled from the next-best candidates so a block costs the sleeve no deployment. Deterministic and price-only: no wire, no LLM (the event-pop family is closed; a gap IS the price, so it cannot lag it).
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | ADR-095 round 2 — rotateBlendSleeve: an applied BLEND override rotates to blendRotationPlan's merged per-symbol goals (each component ranks its own universe inside its weight-share budget) with rotateSleeve's exact execution discipline (drop-out sells → trims → 6s settle + real-cash re-read → strongest-first buys). Universe for a blend fire = union of component universes.
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | EARNINGS BLACKOUT (TRADING_EARNINGS_GATE, default OFF) — the first scheduled-event rule the evidence earned: the 07-14 proximity study (505 events/12mo, same-symbol random-time control) measured holding THROUGH a print at 1.89x the volatility and 1.87x the left tail of the same names at random times, for a mean of −0.07% vs the control's +0.13% — uncompensated risk. Reads the world calendar we already ingest; the blackout set joins symbolBlocklist at all three entry points (scan / rotation / blend). Also TRADING_WORLD_SENTIMENT_CLEAN: point the sentiment veto at the STRAINED series (real news only) instead of the raw one that counts reactive commentary. Both default OFF → byte-identical behavior until armed.
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Earnings gate made TESTABLE (it was earned by one retrospective study, then generated zero evidence about itself). (1) Mode-aware arming: TRADING_EARNINGS_GATE now accepts paper|live|both|true — the paper-first soak doctrine applied to gates, so the rule can run on the reference book while real money waits for evidence. (2) Counterfactual gate-block ledger (trading-gate-block-store): every entry the blackout suppresses is persisted per (book, gate, symbol, ET-day) with its would-be price at BOTH instrumented entry points (scan placeEntries + rotateSleeve leaderboard; blend not instrumented — plan computes goals internally). Scoring the blocked names' actual through-print outcomes vs a same-symbol random control is what graduates the gate to live. Unarmed behavior stays byte-identical.
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | LIVE SIZING PRICES COME FROM THE EXECUTING VENUE. The three sizing sites — the core top-up (ensureCore) and both rotation priceOf closures (rotateSleeve / rotateBlendSleeve) — sized the LIVE book off the raw Alpaca IEX latestPrice (with a stale Alpaca daily-close fallback) while EXECUTING at Schwab; IEX diverges exactly when it matters (thin names — RGTI 54bps / SOUN 45bps tails per the 07-12 divergence study — gaps, off-hours). All three now route through the per-book source via the new exported sizingPrice(mode, sub, symbol, fallbackClose?) → getMarketData(mode, sub): Schwab quotes for live, FAIL-CLOSED (the positions-read doctrine applied to prices) — a name the executing venue can't price is SKIPPED with a log, never silently sized off the wrong venue. Paper is unchanged: Alpaca first, and only the rotation paths keep their daily-close fallback. ensureCore + sizingPrice exported for the unit spec (trading-sizing-venue.spec.ts).
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Trading engine extraction (ADR-085 pre-carve): import repoint only — guardrails/placeDecisionOrder/ensureTradingSchema now come from app/trading-engine.ts instead of the carvable route surface. Zero behavior change; order semantics, gates, schedule pins and TRADING_* env reads untouched.
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Sector lean becomes a knob: rotateSleeve now runs rankUniverse through applySectorTilt(TRADING_SECTOR_TILT) so "lean harder on materials" is a dial over the ranking instead of percentages hand-baked into TRADING_CORE_SYMBOLS (which pinned capital in ETFs that sit outside the ranked universe and so never rotate out). Unset/empty tilt → byte-identical ranking. All logic lives in features/trading/services/sector-tilt.ts; this file is past the 800-line decomposition threshold and takes only the import + call.
 *
 * @module trading-schedule-dispatch
 */

import * as crypto from 'crypto';
import type { AppContext } from './composition-root';
import type { ScheduleRecord, ScheduleDispatchResult, ScheduleService } from '@/features/scheduling';
import {
  getBrokerAdapter, getBrokerReader, marketDataConfigured, tradableSession, tradableSessionDetailed, multiTimeframeScan, DEFAULT_UNIVERSE, dailyCloses, latestPrice,
  exitsToRun, trailingExits, nextPeaks, isShortTermBreakdown, isShortTermPop, sizeEntry, riskPolicy, rotationBenches, rebalanceTrims, dipExits, symbolBlocklist,
  deriveMasses, displacement, barsBatch, barsBatchSince, scoreSymbol, ensemble,
  maxGapDownPct, priorSessionClose, etSessionDate, selectEntryTargets, entryBlock, getMarketData,
  sectorTiltConfig, applySectorTilt,
  type MtfDecision, type Position, type TradingMode, type TradingBook, type BrokerAccount, type RiskPolicy, type ExitOrder, type NameStrength, type EntryGuardInput, type EntryBlock,
} from '@/features/trading';
import { guardrails, placeDecisionOrder, ensureTradingSchema } from './trading-engine';
// ADR-138 D3: protected (pinned) lots — the operator's manual buys with their own exit rules are
// subtracted from the autopilot's view of the book before ANY decision, and their exit orders are
// never cancelled by freeStaleSells.
import { pinnedQtyBySymbol, subtractPinnedLots, isLotOrderClientId } from './trading-pinned-lots';
// CHANGE LOG addendum (ADR-134 PR1): dispatch resolves the BOOK first under three hard rules
// (bookId absent → legacy book; unresolvable → skip+ERROR, never a legacy fallback; flag-off +
// non-legacy bookId → logged no-op hard-skip). runAutopilot and every helper thread the book:
// ledger writes/reads key (user_sub, book_id), requestId carries book.ref (byte-identical for
// legacy books), capAccount takes LEAST(env, book cap), a disabled book keeps protective exits
// while rotation/pop/entries are skipped, and BOTH breaker call sites fail CLOSED on an
// evaluation error (halted, never null→not-halted).
import { legacyBook, legacyBookId, loadBook, ensureLegacyBooks, multiAccountEnabled } from './trading-books-store';
import { reconcileOpenOrders } from './trading-reconcile';
import { ensurePeaksTable, loadPeaks, savePeaks } from './trading-peaks-store';
import { ensureRotationStateTable, loadLastRotated, saveLastRotated } from './trading-rotation-store';
import { recordDailyEquity } from './trading-daily-equity-store';
import { recordGateBlocks } from './trading-gate-block-store';
import { evaluateEquityGuard } from './trading-equity-guard';
import { loadAlgoMasses } from './trading-signal-weights';
import { loadStrategyParams } from './trading-strategy-params';
import { getActiveOverride, overlayCoreEntries, overlayRotationKnobs, policyOverrideOf, type ConfigOverrideRow } from './trading-config-overrides';
import { blendRotationPlan, blendUnionUniverse } from './trading-blend';
import { createWorldIntelligenceService, type WorldIntelligenceService } from '@/features/world-data';
import { readWorldSignalsBatch, worldRankEnabled } from './trading-world-signals';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-schedule-dispatch' });

/** Default fire cadence: every 5 minutes, all day; the run self-skips when the market is closed. */
export const AUTOPILOT_CRON_DEFAULT = '*/5 * * * *';
/** Cap on orders placed per fire — bounds risk + API calls regardless of how many names signal. */
const MAX_ORDERS_PER_RUN = Number(process.env.TRADING_MAX_ORDERS_PER_RUN) || 8;
/** Agent id stamped on autopilot-authored decisions/signals (deterministic engine, no LLM). */
const AUTOPILOT_AGENT = 'mtf-autopilot';

/** A book's adapter binding — undefined for legacy/unbound books (the factory also ignores bindings
 *  entirely while TRADING_MULTI_ACCOUNT is off; ADR-134 flag-off byte-parity). */
function bookBinding(book: TradingBook): { accountNumber: string; connectionKey: string | null } | undefined {
  return book.accountNumber ? { accountNumber: book.accountNumber, connectionKey: book.connectionKey } : undefined;
}

// ── World-intelligence influence gate ──────────────────────────────────────────
// The shared world layer scores bias-aware news sentiment per ticker (world:ticker:<sym>). We let it
// VETO and TILT technical entries — don't buy a name the press/influencers are actively souring on, and
// size up/down with the mood — without ever forcing a trade the technicals didn't already want. Sells
// are never gated (you always get to exit). Neutral by construction: thin/absent coverage = no effect.
/** Skip a buy when avg world sentiment is at or below this (strongly negative). */
const WORLD_SENT_VETO = -0.35;
/** Minimum sentiment data points before the gate acts at all (else neutral — no veto, no tilt). */
const WORLD_SENT_MIN_POINTS = 3;
/** Lookback window for the ticker sentiment average. */
const WORLD_SENT_DAYS = 30;
/** TRADING_WORLD_SENTIMENT_CLEAN (default false → today's behavior byte-identical): read the
 *  STRAINED sentiment series (`sentiment_clean`, ADR-096) instead of the raw one. The raw series
 *  counts EVERY headline, including the reactive commentary the 2026-07-14 wire-ceiling study
 *  proved is journalism ABOUT a move ("What's Going On With Intel Stock Friday?"), not news — the
 *  gate has been drinking reaction sentiment. `sentiment_clean` counts only headlines that pass the
 *  shared real-news gate. Both series accrue in parallel, so this is a live A/B: flip it only after
 *  the clean series has coverage and a strategy-log row says it's better. */
const worldSentMetric = (): string =>
  String(process.env.TRADING_WORLD_SENTIMENT_CLEAN ?? 'false').toLowerCase() === 'true' ? 'sentiment_clean' : 'sentiment';
/** TRADING_WORLD_RANK: how much the blended world score moves entry RANK (added to confidence 0..1). */
const WORLD_RANK_WEIGHT = Number(process.env.TRADING_WORLD_RANK_WEIGHT || 0.25);

/* ── Earnings blackout (TRADING_EARNINGS_GATE, default OFF) ─────────────────────────────────────
 * The first SCHEDULED-event rule the evidence earned (2026-07-14 earnings-proximity study, 505
 * events / 12 months, market-adjusted, judged against a same-symbol random-time control):
 *
 *   holding THROUGH a print:  mean −0.070% · stdev 9.64 · 5th-pct −14.07%
 *   the same names, random:   mean +0.132% · stdev 5.11 · 5th-pct  −7.50%
 *   → 1.89× the volatility, 1.87× the left tail, and you are paid LESS than random (p=0.81).
 *
 * It is UNCOMPENSATED RISK: a binary event we can see on the calendar, that pays nothing on
 * average and doubles the tail. So: do not INITIATE into a name printing within N sessions.
 * Exits are never gated (you always get to leave), and existing holds are untouched unless the
 * operator also sets the trim (a separate, more aggressive decision).
 * Reads the world calendar we already ingest (world_events: 68 earnings in the next 30 days).
 * Neutral by construction: world layer off / read fails → empty set → today's behavior exactly. */
/** Sessions of blackout before a print (2 = the study's window; the gap is what hurts). */
const EARNINGS_BLACKOUT_DAYS = Math.max(1, Math.min(10, Number(process.env.TRADING_EARNINGS_BLACKOUT_DAYS) || 3));
/**
 * @description True when the earnings no-initiate gate is armed FOR THIS BOOK. Mode-aware
 * (2026-07-17) so the platform's paper-first doctrine applies to gates too: `paper` or `live` arms
 * one book, `true`/`both` arms both, anything else is off. Lets the rule soak on the paper book —
 * with the gate-block ledger collecting its counterfactuals — before real money adopts it.
 * @param mode - Which book is firing.
 * @returns Whether the gate applies to this book's entries.
 */
function earningsGateEnabled(mode: TradingMode): boolean {
  const v = String(process.env.TRADING_EARNINGS_GATE ?? 'false').toLowerCase();
  return v === 'true' || v === 'both' || v === mode;
}
/**
 * @description Symbols with a scheduled earnings print inside the blackout window — never bought
 * fresh while the gate is armed. Best-effort: any failure returns an empty set (no gating).
 * @param svc - World-intelligence service (null when the layer is off).
 * @param mode - Which book is firing (the gate arms per book).
 * @returns Upper-cased symbols printing within EARNINGS_BLACKOUT_DAYS.
 */
async function earningsBlackout(svc: WorldIntelligenceService | null, mode: TradingMode): Promise<Set<string>> {
  if (!svc || !earningsGateEnabled(mode)) return new Set();
  try {
    const evs = await svc.upcomingEvents(EARNINGS_BLACKOUT_DAYS);
    const out = new Set<string>();
    for (const e of evs) {
      if (e.eventType !== 'earnings') continue;
      const sym = e.entityId.replace(/^world:ticker:/, '').toUpperCase();
      if (sym && sym !== e.entityId.toUpperCase()) out.add(sym);
    }
    return out;
  } catch (e) {
    logger.warn({ err: e }, 'earnings blackout read failed — no gating this fire');
    return new Set();
  }
}

/** Clamp a number into [lo, hi]. */
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** A ticker's world-sentiment read: avg score in [-1,1] (null = no usable coverage) + point count. */
interface WorldSent { score: number | null; points: number; }

/**
 * @description Read the bias-aware world sentiment for a ticker from the shared world series.
 * @param svc - World-intelligence service (null when the layer is disabled → neutral).
 * @param symbol - Ticker symbol.
 * @returns Avg sentiment + point count; {null,0} on any miss so the gate stays neutral.
 */
async function worldSentiment(svc: WorldIntelligenceService | null, symbol: string): Promise<WorldSent> {
  if (!svc) return { score: null, points: 0 };
  try {
    const r = await svc.metricAvg(`world:ticker:${symbol.toLowerCase()}`, worldSentMetric(), WORLD_SENT_DAYS);
    return { score: r.avg, points: r.points };
  } catch {
    return { score: null, points: 0 };
  }
}

// Injected by schedule-runtime once the shared service is built (avoids a circular import).
let scheduleSvc: ScheduleService | null = null;
/** @description Provide the shared ScheduleService to the trading autopilot layer. */
export function setTradingScheduleService(svc: ScheduleService): void { scheduleSvc = svc; }
/** @description The shared ScheduleService (null until the scheduler runtime is wired). */
export function getTradingScheduleService(): ScheduleService | null { return scheduleSvc; }

/** @description True for schedules this module owns (the per-user autopilot poll). */
export function isTradingSchedule(taskType: string): boolean {
  return taskType.startsWith('trading-autopilot');
}

/** @description The autopilot schedule taskType for a user (one per owner; createSchedule upserts by id). */
export function autopilotTaskType(sub: string): string { return `trading-autopilot:${sub}`; }

/** A placed/attempted order in a run summary. */
interface RunOrder { symbol: string; side: 'buy' | 'sell'; qty: number; status: string; id: string; reason?: string; }
/** The outcome of one autopilot fire. */
interface RunSummary { scanned: number; entries: number; exits: number; orders: RunOrder[]; errors: Array<{ symbol: string; error: string }>; posture: string; }

/** A persistable decision (entry from a scan, or a protective exit) — the input to persistDecision. */
interface DecisionInput {
  symbol: string; action: 'buy' | 'sell'; side: 'buy' | 'sell'; qty: number;
  confidence: number; rationale: string; indicators: unknown; price: number | null; source: string;
}

/**
 * @description Persist the provenance chain for one decision: a signal snapshot, then a decision row
 * referencing it. Returns the decision id placeDecisionOrder executes. Shared by entries + exits.
 * @param pool - Postgres pool.
 * @param sub - Owner sub.
 * @param mode - Book (paper).
 * @param d - The decision to persist.
 * @returns The persisted decision id.
 */
async function persistDecision(pool: AppContext['pool'], sub: string, bookOrMode: TradingBook | TradingMode, d: DecisionInput): Promise<string> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  // Minute-bucketed hash → each run is a distinct signal; same run de-dupes idempotently.
  const bucket = new Date().toISOString().slice(0, 16);
  const hash = crypto.createHash('sha256').update(JSON.stringify({ s: d.symbol, a: d.action, src: d.source, ind: d.indicators, bucket })).digest('hex');
  const sig = (await pool.query(
    `INSERT INTO oshal_trading_signals (user_sub, mode, book_id, source, title, body, symbols, indicators, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_sub, book_id, content_hash) DO UPDATE SET observed_at = oshal_trading_signals.observed_at
     RETURNING signal_id`,
    [sub, book.kind, book.bookId, d.source, `${d.symbol} ${d.action} @ ${d.price ?? '?'}`, d.rationale, [d.symbol],
     JSON.stringify({ confidence: d.confidence, indicators: d.indicators }), hash])).rows[0];
  const g = guardrails();
  const row = (await pool.query(
    `INSERT INTO oshal_trading_decisions
       (user_sub, mode, book_id, signal_ids, agent_id, action, symbol, side, qty, order_type, confidence, rationale, indicators, guardrails)
     VALUES ($1,$2,$3,$4::uuid[],$5,$6,$7,$8,$9,'market',$10,$11,$12,$13)
     RETURNING decision_id`,
    [sub, book.kind, book.bookId, [sig.signal_id], AUTOPILOT_AGENT, d.action, d.symbol, d.side, d.qty, d.confidence, d.rationale,
     JSON.stringify(d.indicators), JSON.stringify(g)])).rows[0];
  return row.decision_id;
}

/** Persist + place one decision. Pushes to orders/errors. */
async function placeManaged(ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, d: DecisionInput, orders: RunOrder[], errors: Array<{ symbol: string; error: string }>, reason?: string): Promise<void> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  try {
    const decisionId = await persistDecision(ctx.pool, sub, book, d);
    // The BOOK REF must be in the requestId: books fire on the same 5-min tick, so a book-independent
    // id gave two books' orders for one symbol the SAME clientOrderId — and the ON CONFLICT upsert
    // then let one book's fill overwrite the other's broker id (2026-07-08). Legacy refs are literally
    // 'paper'/'live', so this string is BYTE-IDENTICAL to the pre-ADR-134 format for the legacy books.
    // Book-scoped here AND in the unique index (user_sub, book_id, client_order_id); either alone
    // suffices, together they can't regress.
    const requestId = `auto-${book.ref}-${new Date().toISOString().slice(0, 16)}-${d.symbol}-${d.side}`;
    // Live orders require confirm=true (placeDecisionOrder's gate); paper passes false. The minute-
    // granular requestId → clientOrderId is the idempotency key (UNIQUE user_sub,book_id,client_order_id).
    const r = await placeDecisionOrder(ctx.pool, sub, book, decisionId, requestId, book.kind === 'live');
    orders.push({ symbol: d.symbol, side: d.side, qty: d.qty, status: r.status, id: r.id, reason });
  } catch (e) {
    errors.push({ symbol: d.symbol, error: (e as Error).message });
  }
}

/** Non-terminal order statuses — a working order at the venue that getPositions() can't see yet. */
const IN_FLIGHT_STATUSES = ['pending', 'accepted', 'partially_filled'];

/** A still-working order in the book: its symbol (for dedup) + remaining pending buy notional (for
 *  cash reservation). Net of any already-filled shares so a partial fill only reserves the rest. */
export interface InFlight { symbols: Set<string>; pendingBuyNotional: number; }

/**
 * @description Read still-working (non-terminal) orders for a book from the ledger. A pre/post-market
 * limit order sits pending for hours and never shows in getPositions(), so without this the dedup and
 * the cash math only see FILLED positions and re-buy the same name every fire (the pyramiding bug).
 * recordOrder writes the pending row at submit time, so the ledger is the authoritative in-flight view.
 * @param pool - Postgres pool.
 * @param sub - Owner sub (caller-scoped).
 * @param mode - Book (paper|live).
 * @returns The set of symbols with a working order + the total un-filled pending BUY notional.
 */
export async function loadInFlight(pool: AppContext['pool'], sub: string, bookOrMode: TradingBook | TradingMode): Promise<InFlight> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const rows = (await pool.query(
    `SELECT symbol, side, COALESCE(qty,0) AS qty, COALESCE(filled_qty,0) AS filled_qty, COALESCE(limit_price,0) AS px
       FROM oshal_trading_orders
      WHERE user_sub=$1 AND book_id=$2 AND status = ANY($3)`,
    [sub, book.bookId, IN_FLIGHT_STATUSES])).rows;
  const symbols = new Set<string>();
  let pendingBuyNotional = 0;
  for (const r of rows) {
    symbols.add(String(r.symbol).toUpperCase());
    if (r.side === 'buy') {
      const remaining = Math.max(0, Number(r.qty) - Number(r.filled_qty));
      pendingBuyNotional += remaining * Number(r.px || 0); // ext-hours entries are limit orders → px is set
    }
  }
  return { symbols, pendingBuyNotional };
}

/**
 * @description Cancel still-working SELL orders for symbols the engine wants to exit THIS fire.
 * Why: an extended-hours protective sell is a marketable LIMIT; if the price falls away before it
 * fills, the order strands above the market and its reserved shares BLOCK every later exit attempt
 * ("insufficient qty available") — the 2026-07-07 pre-market failure where AMD/MU rode a crash from
 * 4:05 all the way to the open because their 4 AM limits never filled. Canceling the stale order
 * frees the shares so this fire's exit re-prices at the CURRENT market (the chase-down a protective
 * exit must do). Best-effort: a failed cancel just means this fire's sell rejects again and the next
 * fire retries — strictly better than locked-forever.
 * @param ctx - App context (ledger pool).
 * @param sub - Owner sub.
 * @param mode - Book (paper|live).
 * @param exitSymbols - UPPERCASE symbols the engine wants to exit this fire.
 * @returns Count of canceled orders.
 */
async function freeStaleSells(ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, exitSymbols: Set<string>): Promise<number> {
  if (!exitSymbols.size) return 0;
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const mode = book.kind;
  const rows = (await ctx.pool.query(
    `SELECT broker_order_id, symbol, client_order_id FROM oshal_trading_orders
      WHERE user_sub=$1 AND book_id=$2 AND side='sell' AND broker_order_id IS NOT NULL AND status = ANY($3)`,
    [sub, book.bookId, IN_FLIGHT_STATUSES])).rows;
  const broker = getBrokerAdapter(mode, sub, bookBinding(book));
  let canceled = 0;
  for (const r of rows) {
    const sym = String(r.symbol).toUpperCase();
    if (!exitSymbols.has(sym)) continue;
    // ADR-138 D3: a protected lot's take-profit/stop/trailing orders are NOT the autopilot's to cancel.
    if (isLotOrderClientId(r.client_order_id)) continue;
    try {
      await broker.cancelOrder(String(r.broker_order_id));
      canceled += 1;
      logger.info({ sub, mode, symbol: sym, brokerOrderId: r.broker_order_id }, 'stale working sell canceled so the exit can re-price');
    } catch (e) {
      logger.warn({ err: e, sub, mode, symbol: sym, brokerOrderId: r.broker_order_id }, 'stale sell cancel failed — exit may reject this fire and retry next');
    }
  }
  // Give the venue a beat to release the reserved shares before the fresh sells go in.
  if (canceled > 0) await new Promise((r) => setTimeout(r, 1500));
  return canceled;
}

/** Map a protective exit (or a rotation bench) to a persistable sell decision. */
function exitDecision(e: ExitOrder): DecisionInput {
  const rationale = e.reason === 'rotation'
    ? `Benched (rotation) — gone cold, capital rotated to a hotter name. Position P&L ${e.pnlPct.toFixed(1)}%.`
    : e.reason === 'cap_trim'
      ? `Cap trim — position grew past the per-name cap; sold the excess to rebalance. Position P&L ${e.pnlPct.toFixed(1)}%.`
      : e.reason === 'ext_dip'
        ? `Extended-hours defensive exit — printed past the off-hours dip line (TRADING_EXT_DIP_SELL_PCT below the regular close). Off-hours doctrine: protect, never chase. Position P&L ${e.pnlPct.toFixed(1)}%.`
        : `Risk exit (${e.reason}) — position P&L ${e.pnlPct.toFixed(1)}%.`;
  return {
    symbol: e.symbol, action: 'sell', side: 'sell', qty: e.qty, confidence: 1, rationale,
    indicators: { reason: e.reason, pnlPct: e.pnlPct }, price: null, source: e.reason === 'rotation' ? 'rotation' : 'risk-exit',
  };
}

/** Map a technical scan call to a persistable decision. `world` (entries only) records the influence
 *  signal that shaped sizing, so the decision journal shows WHY the size was tilted. */
function scanDecision(d: MtfDecision, side: 'buy' | 'sell', qty: number, world?: WorldSent): DecisionInput {
  const worldNote = world && world.score != null && world.points >= WORLD_SENT_MIN_POINTS
    ? ` World sentiment ${world.score >= 0 ? '+' : ''}${world.score.toFixed(2)} (${world.points} pts) → size tilted.`
    : '';
  return {
    symbol: d.symbol, action: side, side, qty, confidence: d.confidence, rationale: `${d.rationale}${worldNote}`,
    indicators: { score: d.score, regime: d.regime, perTimeframe: d.perTimeframe, world: world ?? null },
    price: d.price, source: 'mtf-autopilot',
  };
}

/** Map a fast short-timeframe breakdown to a protective sell decision (its own clear journal entry). */
function breakdownDecision(d: MtfDecision, qty: number): DecisionInput {
  const fast = d.perTimeframe.filter((v) => v.timeframe === '5Min' || v.timeframe === '1Hour');
  return {
    symbol: d.symbol, action: 'sell', side: 'sell', qty, confidence: 1,
    rationale: `Protective exit — short-timeframe breakdown (${fast.map((v) => `${v.timeframe}:${v.score.toFixed(2)}`).join(', ')}) while regime ${d.regime.toFixed(2)} still up.`,
    indicators: { reason: 'breakdown', regime: d.regime, perTimeframe: d.perTimeframe }, price: d.price, source: 'mtf-breakdown',
  };
}

/* ── Beta core (core-satellite) ──────────────────────────────────────────────────────────────────
 * The active sleeve is a low-drawdown chop-trader; it protects but can't ride a rally (backtest:
 * sleeve +2-3% vs SPY +9% over the same up window). A market-index CORE captures that beta. This
 * deploys idle cash toward a target % in the core symbol(s), holds it, and exempts it from every
 * sleeve sell/trim/rotation. Uses CASH ONLY — never sells the sleeve to fund the core, so it grows
 * toward target as cash frees up. Off unless TRADING_CORE_SYMBOLS is set. Paper-safe + reversible. */
/** Parsed beta-core config: the exemption set, the TOTAL core % (drives the sleeve budget), and the
 *  per-symbol target % each name is topped up toward. */
export interface CoreConfig { symbols: string[]; targetPct: number; perSymbolPct: Map<string, number>; }

/**
 * @description Parse TRADING_CORE_SYMBOLS with optional per-symbol targets: `SPY:35,SKHYV:0,SKHY:0`.
 * A bare symbol (no `:pct`) shares TRADING_CORE_TARGET_PCT equally with the other bare symbols —
 * exactly the legacy behavior when no entry carries a colon. A `:0` name is core-EXEMPT only (held,
 * never topped up, never sleeve-sold) — the shape an operator hold like the SKHY IPO position needs.
 * @returns Symbols (upper-case), total target % (clamped 0-95), and the per-symbol target map.
 */
export function coreConfig(override?: ConfigOverrideRow | null): CoreConfig {
  const entries = String(process.env.TRADING_CORE_SYMBOLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const envTarget = Math.max(0, Math.min(95, Number(process.env.TRADING_CORE_TARGET_PCT || 0)));
  let perSymbolPct = new Map<string, number>();
  const bare: string[] = [];
  for (const e of entries) {
    const [rawSym, rawPct] = e.split(':');
    const sym = rawSym.trim().toUpperCase();
    if (!sym) continue;
    if (rawPct !== undefined && Number.isFinite(Number(rawPct))) perSymbolPct.set(sym, Math.max(0, Math.min(95, Number(rawPct))));
    else bare.push(sym);
  }
  for (const sym of bare) perSymbolPct.set(sym, bare.length ? envTarget / bare.length : 0);
  // ADR-095: an applied Strategy Library override owns the core TARGET (its coreSymbol at the
  // applyPct-scaled percentage); operator `:0` exemption holds always survive.
  perSymbolPct = overlayCoreEntries(perSymbolPct, override);
  const total = Math.min(95, [...perSymbolPct.values()].reduce((s, v) => s + v, 0));
  return { symbols: [...perSymbolPct.keys()], targetPct: total, perSymbolPct };
}

/* ── Gravity-ranked sleeve rotation (TRADING_SLEEVE_ROTATION, default OFF) ──────────────────────────
 * An OPTIONAL alternative to the per-fire scan-based sleeve management. When enabled, the sleeve is
 * rebalanced on a cadence (every TRADING_ROTATION_EVERY_DAYS days, not every 5-min fire): rank the
 * universe by the gravity model's `displacement` pull, hold the top-N, and rotate capital out of names
 * that fell off the leaderboard into the new leaders. The protective exits (stops/trailing/breakdown)
 * still run every fire as a safety net. Off by default → the autopilot behaves exactly as before.
 *
 * Tuning knobs (all optional, defaults keep the engine sane):
 *  - rank: how the ex-core universe is ranked — gravity (displacement pull, the original behavior),
 *    momentum (20-day return), ensemble (the multi-algo vote score), or blend (50/50 cross-sectional
 *    z-score of momentum + gravity). Unrecognized → blend.
 *  - weighting: how the sleeve budget is split across the target leaders — equal (eq/N, original) or
 *    conviction (tilt toward higher-scored names, still capped per name).
 *  - extHours: when true, rotation MAY fire in pre/post-market (the daily cadence still limits it to
 *    one rotation per day, so it rotates at the first eligible fire — possibly pre-market). */
export function rotationConfig(override?: ConfigOverrideRow | null): { enabled: boolean; everyDays: number; topN: number; rank: string; weighting: string; extHours: boolean } {
  const rank = String(process.env.TRADING_ROTATION_RANK || 'blend').toLowerCase();
  const weighting = String(process.env.TRADING_ROTATION_WEIGHTING || 'conviction').toLowerCase();
  const base = {
    enabled: String(process.env.TRADING_SLEEVE_ROTATION || 'false').toLowerCase() === 'true',
    everyDays: Math.max(1, Number(process.env.TRADING_ROTATION_EVERY_DAYS) || 5),
    topN: Math.max(0, Number(process.env.TRADING_ROTATION_TOPN) || 0), // 0 = auto from sleeve budget
    rank: ['gravity', 'momentum', 'ensemble', 'blend'].includes(rank) ? rank : 'blend',
    weighting: weighting === 'equal' ? 'equal' : 'conviction',
    extHours: String(process.env.TRADING_ROTATION_EXT_HOURS || 'false').toLowerCase() === 'true',
  };
  // ADR-095: an applied 'rotation' strategy owns the sleeve (its rank/cadence/topN/weighting);
  // an applied 'ensemble' strategy turns rotation OFF so the scan sleeve owns it. No override → env.
  return overlayRotationKnobs(base, override);
}

/* ── Intraday pop-catcher (TRADING_POP_CATCHER, default OFF) ────────────────────────────────────────
 * The "watch it at $0, grab it when it actually pops" layer. The daily rotation funds the proven leaders;
 * a name that is NOT funded stays on the bench — and this pulls it IN the moment it surges on the 5-minute
 * bar (isShortTermPop), from the idle cash reserve, in a small tranche, capped in count. It is the mirror
 * of the 2a breakdown exit (fast 5-min protection) but for entries, and it runs independent of the
 * rotation. Every pop position is a normal position — the step-1 protective stops/trailing exit it like
 * any other. Off by default → nothing changes. */
function popCatcherConfig(): { enabled: boolean; tranchePct: number; maxPositions: number; threshold: number } {
  return {
    enabled: String(process.env.TRADING_POP_CATCHER || 'false').toLowerCase() === 'true',
    tranchePct: Math.max(0.1, Math.min(5, Number(process.env.TRADING_POP_TRANCHE_PCT) || 1)),
    maxPositions: Math.max(1, Math.min(20, Number(process.env.TRADING_POP_MAX) || 5)),
    threshold: Math.max(0, Math.min(1, Number(process.env.TRADING_POP_THRESHOLD) || 0.34)),
  };
}

/** A beta-core BUY decision (idle cash → market index; held as a core, never traded by the sleeve). */
function coreDecision(symbol: string, qty: number, price: number | null): DecisionInput {
  return {
    symbol, action: 'buy', side: 'buy', qty, confidence: 1,
    rationale: `Beta core — deploying idle cash into ${symbol} for market exposure; held as a core (the sleeve never sells it).`,
    indicators: { reason: 'beta-core' }, price, source: 'beta-core',
  };
}

/** A beta-core TRIM decision (core drifted ABOVE its target % → sell the excess back to target). */
function coreTrimDecision(symbol: string, qty: number, price: number | null, targetPct: number): DecisionInput {
  return {
    symbol, action: 'sell', side: 'sell', qty, confidence: 1,
    rationale: `Beta core — trimming ${symbol} back to its ${targetPct}% target; the core tracks its target in BOTH directions (it is exempt from SLEEVE sells, not from its own rebalance).`,
    indicators: { reason: 'core-trim', targetPct }, price, source: 'beta-core',
  };
}

/** How far the core may drift from its target before the top-up/trim acts (1% of equity — the same
 *  dead-band on both sides, so a target is a TARGET and not a one-way ratchet). */
const CORE_BAND_PCT = 0.01;

/** What the core should do about one symbol this fire. */
export interface CoreTrade { action: 'hold' | 'buy' | 'trim'; qty: number; }

/**
 * @description Pure sizing for ONE core symbol: buy it up to its target, trim it back down to its
 *   target, or leave it inside the dead band. Extracted from ensureCore so the dangerous edges are
 *   testable without a broker — above all the `:0` exemption-only hold (the SKHY IPO position), which
 *   must NEVER be bought and must NEVER be trimmed, and the short-sale guard (a trim can never sell
 *   more shares than are actually held, however stale the position rows).
 * @param symPct - This symbol's target % of equity. `<= 0` = exemption-only hold → always 'hold'.
 * @param equity - Account equity.
 * @param curValue - Current market value held in this symbol.
 * @param heldQty - Shares actually held (bounds a trim — no accidental shorts).
 * @param price - Current price.
 * @param cashAvail - Cash available to a BUY (a trim needs none).
 * @returns The action and share count (qty 0 ⇒ 'hold').
 */
export function coreTradePlan(
  symPct: number, equity: number, curValue: number, heldQty: number, price: number, cashAvail: number,
): CoreTrade {
  const hold: CoreTrade = { action: 'hold', qty: 0 };
  if (symPct <= 0) return hold;                    // :0 — exemption-only hold. Never bought, never trimmed.
  if (!(equity > 0) || !(price > 0)) return hold;
  const target = (symPct / 100) * equity;
  const drift = target - curValue;                 // >0 under target, <0 over target
  if (Math.abs(drift) < equity * CORE_BAND_PCT) return hold;
  if (drift < 0) {
    const qty = Math.min(Math.floor(-drift / price), Math.floor(Math.max(0, heldQty)));
    return qty >= 1 ? { action: 'trim', qty } : hold;
  }
  const qty = Math.floor(Math.min(drift, Math.max(0, cashAvail) * 0.98) / price); // keep a sliver of cash
  return qty >= 1 ? { action: 'buy', qty } : hold;
}

/**
 * @description The price a SIZING decision may use for one symbol, read from the book's OWN
 *   market-data source (getMarketData — the same per-mode selection as getBrokerAdapter): the live
 *   book prices off its EXECUTING venue (Schwab), paper off the Alpaca IEX feed it has always used.
 *   FAIL-CLOSED for live — the positions-read doctrine applied to prices: when the executing venue
 *   cannot price the name (the read throws, or returns no positive price), return null so the
 *   caller SKIPS the name this fire, with a log — never silently size a live order off the paper
 *   vendor's tick or a stale Alpaca daily close (the venues disagree exactly when it matters: thin
 *   names, gaps, off-hours). Paper semantics are unchanged: feed price first, then the caller's
 *   daily-close fallback (the rotation paths' behavior since inception). Exported for the unit spec
 *   (the coreTradePlan pattern — the dangerous edge testable without a broker).
 * @param mode - Book ('paper' | 'live') — selects the venue, exactly like getBrokerAdapter.
 * @param sub - Owner sub (the live Schwab feed is per-user; ignored by Alpaca).
 * @param symbol - Ticker to price.
 * @param fallbackClose - Optional last daily close, honored ONLY by the paper book on a feed miss.
 * @returns A positive price, or null ⇒ the caller must skip the name (never a wrong-venue price).
 */
export async function sizingPrice(mode: TradingMode, sub: string, symbol: string, fallbackClose: number | null = null): Promise<number | null> {
  const md = getMarketData(mode, sub);
  const px = await md.latestPrice(symbol).catch((err) => {
    logger.warn({ err, mode, symbol, source: md.kind }, 'sizing price read failed from the book\'s venue');
    return null;
  });
  if (px != null && px > 0) return px;
  if (mode === 'live') {
    logger.warn({ mode, symbol, source: md.kind }, 'live sizing price unavailable from the executing venue — name SKIPPED this fire (fail-closed; never sized off the paper feed)');
    return null;
  }
  return fallbackClose != null && fallbackClose > 0 ? fallbackClose : null;
}

/**
 * @description Track the beta core to its target % of equity in BOTH directions. Buys use AVAILABLE
 *   CASH ONLY; sells trim a core that has drifted above target back down to it.
 *
 *   The trim exists because the core previously had NO path back down: it is exempt from every sleeve
 *   sell, and this function only ever bought — so a `60%` target was really a 60% FLOOR that ratcheted
 *   up and never came back. On 2026-07-14 a failed positions read (now fixed) made it re-buy the core
 *   from scratch and left the live book at 79.2% SPY against its 60% target, with nothing in the system
 *   able to correct it. "Exempt from sleeve sells" was never meant to mean "exempt from its own
 *   rebalance".
 *
 *   `:0` names are NEVER touched on either side — they are exemption-only holds (the SKHY IPO
 *   position): never bought, never trimmed, never sleeve-sold.
 *
 * @param ctx - App context.
 * @param sub - Owner sub.
 * @param mode - Book.
 * @param account - Broker snapshot (already capped for live).
 * @param positions - Current positions.
 * @param core - Parsed core config (per-symbol target %).
 * @param orders - Run-order accumulator.
 * @param errors - Run-error accumulator.
 * @returns Cash committed to core BUYS this fire, so the sleeve reserves it and can't over-deploy the
 *   same dollars. Trims are not netted off — their proceeds are unsettled this fire.
 *   Exported for the unit spec (venue-routed sizing — live prices come from the executing venue).
 */
export async function ensureCore(
  ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, account: BrokerAccount, positions: Position[],
  core: CoreConfig, orders: RunOrder[], errors: Array<{ symbol: string; error: string }>,
): Promise<number> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const mode = book.kind;
  const equity = account.equity > 0 ? account.equity : account.cash;
  if (equity <= 0 || !core.symbols.length || core.targetPct <= 0) return 0;
  let cashLeft = account.cash; let spent = 0;
  for (const sym of core.symbols) {
    const symPct = core.perSymbolPct.get(sym) ?? 0;
    // :0 names are exemption-only holds (the SKHY IPO position): never bought, never TRIMMED, never
    // sleeve-sold. Skipping here also spares them a pointless price fetch; coreTradePlan re-asserts it.
    if (symPct <= 0) continue;
    const held = positions.filter((p) => p.symbol.toUpperCase() === sym);
    const cur = held.reduce((s, p) => s + Math.max(0, p.marketValue), 0);
    const heldQty = held.reduce((s, p) => s + Math.max(0, p.qty), 0);
    // Venue-routed sizing price: live reads the EXECUTING venue (Schwab) and fails closed — an
    // unpriceable core name is skipped this fire, never sized off the paper (Alpaca IEX) feed.
    const px = await sizingPrice(mode, sub, sym);
    if (!px || px <= 0) continue;
    const plan = coreTradePlan(symPct, equity, cur, heldQty, px, cashLeft);
    if (plan.action === 'trim') {
      await placeManaged(ctx, sub, book, coreTrimDecision(sym, plan.qty, px, symPct), orders, errors, 'core-trim');
    } else if (plan.action === 'buy') {
      await placeManaged(ctx, sub, book, coreDecision(sym, plan.qty, px), orders, errors, 'beta-core');
      spent += plan.qty * px; cashLeft -= plan.qty * px;
    }
  }
  return spent;
}

/** Rank the ex-core universe by the configured method on the same daily closes. Returns
 *  [{sym, score}] for every eligible name (closes.length >= 60, non-core). Higher score = stronger.
 *   - momentum: 20-day return (needs >= 21 closes).
 *   - gravity:  displacement pull (the original behavior).
 *   - ensemble: the multi-algo ensemble vote score.
 *   - blend:    50/50 cross-sectional z-score of momentum + gravity (names missing either are dropped). */
export function rankUniverse(rank: string, bars: Map<string, number[]>, coreSet: Set<string>): Array<{ sym: string; score: number }> {
  const mom20 = (closes: number[]): number | null =>
    closes.length >= 21 ? closes[closes.length - 1] / closes[closes.length - 1 - 20] - 1 : null;
  const grav = (sym: string, closes: number[]): number => displacement(deriveMasses(sym, closes), 0);

  if (rank === 'blend') {
    // Collect both components per eligible name, then z-score each across the set and average.
    const rows: Array<{ sym: string; mom: number; grav: number }> = [];
    for (const [sym, closes] of bars) {
      if (coreSet.has(sym.toUpperCase()) || closes.length < 60) continue;
      const m = mom20(closes);
      if (m == null) continue; // missing momentum → dropped from the blend
      rows.push({ sym: sym.toUpperCase(), mom: m, grav: grav(sym, closes) });
    }
    const z = (vals: number[]): { mean: number; sd: number } => {
      const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      const sd = vals.length ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) : 0;
      return { mean, sd };
    };
    const zm = z(rows.map((r) => r.mom));
    const zg = z(rows.map((r) => r.grav));
    return rows.map((r) => ({
      sym: r.sym,
      score: 0.5 * ((r.mom - zm.mean) / (zm.sd || 1)) + 0.5 * ((r.grav - zg.mean) / (zg.sd || 1)),
    }));
  }

  const ranked: Array<{ sym: string; score: number }> = [];
  for (const [sym, closes] of bars) {
    if (coreSet.has(sym.toUpperCase()) || closes.length < 60) continue;
    let score: number | null;
    if (rank === 'momentum') score = mom20(closes);
    else if (rank === 'ensemble') score = ensemble(scoreSymbol(sym, closes, undefined, 'SPY'), {}).score;
    else score = grav(sym, closes); // 'gravity'
    if (score == null) continue;
    ranked.push({ sym: sym.toUpperCase(), score });
  }
  return ranked;
}

/**
 * @description Gather the rotation entry-guard inputs for a candidate slate: each name's PRIOR-session
 *   close and its current price. Uses the DATED daily series (barsBatchSince) rather than the plain
 *   close series the ranker uses, because the last element of a plain series can be today's own forming
 *   bar — which would compute the gap as ~0 and no-op the guard on exactly the day it matters. Fails
 *   OPEN: any name we cannot price simply gets no opinion and stays eligible.
 * @param candidates - The candidate symbols to price (bounded by the caller — not the whole universe).
 * @param exiting - Symbols the protective leg is selling in THIS fire.
 * @returns Guard inputs for entryBlock/selectEntryTargets.
 */
async function buildEntryGuard(candidates: string[], exiting: Set<string>): Promise<EntryGuardInput> {
  const bar = maxGapDownPct();
  const input: EntryGuardInput = { exiting, priorCloses: new Map(), currentPrices: new Map(), maxGapDownPct: bar };
  if (bar <= 0 || !candidates.length) return input; // guard disabled → skip the data fetch entirely
  const today = etSessionDate();
  const since = new Date(Date.now() - 20 * 86400000).toISOString(); // ~14 sessions: plenty for "yesterday"
  const dated = await barsBatchSince(candidates, since).catch(() => new Map());
  for (const sym of candidates) {
    const prior = priorSessionClose(dated.get(sym.toUpperCase()), today); // barsBatchSince keys uppercase
    if (prior != null) input.priorCloses.set(sym.toUpperCase(), prior);
  }
  const prices = await Promise.all(candidates.map((s) => latestPrice(s).catch(() => null)));
  candidates.forEach((s, i) => {
    const px = prices[i];
    if (px && px > 0) input.currentPrices.set(s.toUpperCase(), px);
  });
  return input;
}

/**
 * @description Sleeve rotation (TRADING_SLEEVE_ROTATION). Rank the ex-core universe by the configured
 * method (TRADING_ROTATION_RANK: gravity|momentum|ensemble|blend), hold the top-N strongest, and rotate
 * capital out of held sleeve names that dropped off the leaderboard into the new leaders. The buy split
 * honors TRADING_ROTATION_WEIGHTING (equal|conviction). Core symbols are exempt (held forever).
 * Caller has already gated this on the cadence + the drawdown circuit breaker; this just does the
 * rebalance. Orders are PAPER, placed through the same placeManaged provenance chain as every other path.
 * @param ctx - App context (pool).
 * @param sub - Owner sub.
 * @param mode - Book (paper).
 * @param account - Broker account snapshot (equity/cash).
 * @param positions - Current positions (sleeve = non-core held longs).
 * @param policy - Active risk policy (maxPerNamePct, maxPositions).
 * @param coreSet - Beta-core symbols, exempt from all sleeve sells.
 * @param symbols - The universe to rank (the same list runAutopilot received).
 * @param orders - Run-order accumulator.
 * @param errors - Run-error accumulator.
 */
async function rotateSleeve(
  ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, account: BrokerAccount, positions: Position[],
  policy: RiskPolicy, coreSet: Set<string>, symbols: string[],
  orders: RunOrder[], errors: Array<{ symbol: string; error: string }>,
  override: ConfigOverrideRow | null = null,
  exiting: Set<string> = new Set(),
  noBuy: Set<string> = new Set(),
): Promise<void> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const mode = book.kind;
  const cfg = rotationConfig(override);
  const equity = account.equity > 0 ? account.equity : account.cash;
  if (equity <= 0) return;
  const core = coreConfig(override);
  // Sleeve = the non-core slice of the book; the core target % is reserved for the held beta core.
  const sleevePct = Math.max(0, 100 - (core.symbols.length ? core.targetPct : 0));
  if (sleevePct <= 0) return;
  const perNamePct = policy.maxPerNamePct;
  // How many names the sleeve holds: explicit topN, or auto from how many per-name slots fit the budget.
  const N = cfg.topN > 0 ? cfg.topN : Math.max(1, Math.floor(sleevePct / perNamePct));

  // Rank the universe (ex-core) by the configured method on daily closes.
  const universe = symbols.filter((s) => !coreSet.has(s.toUpperCase()));
  const bars = await barsBatch(universe, '1Day', 150);
  // The operator's sector lean (TRADING_SECTOR_TILT) rides the RANKING, not the core symbol list, so
  // it can be dialed back down without moving capital. Neutral/unset → the untilted ranking. A tilt
  // is a positive multiplier and so cannot flip a score's sign: it re-orders the `score > 0` set
  // below, it never promotes a name the ranker scored negative.
  const ranked = applySectorTilt(rankUniverse(cfg.rank, bars, coreSet), sectorTiltConfig());
  ranked.sort((a, b) => b.score - a.score);
  // A "positive score" filter: gravity/ensemble pull > 0, momentum return > 0, blend above the
  // cross-sectional mean (z > 0). Naturally goes lighter when few names are strong.
  // Operator exclusions + (when armed) the earnings blackout: never a rotation target → a held one
  // drops off the leaderboard and gets sold, which is exactly the "don't hold through the print" rule.
  const blocked = new Set([...symbolBlocklist(), ...noBuy]);
  const eligible = ranked.filter((r) => r.score > 0 && !blocked.has(r.sym)).map((r) => r.sym);
  // Counterfactual ledger: leaderboard names the earnings blackout suppressed (they would have made
  // the top-N without it). Persisted fire-and-forget so the gate accumulates scoreable evidence;
  // ref price = the ranker's own last daily close. (The blend path is not instrumented — its plan
  // computes goals internally; instrument it if a blend override ever arms the gate.)
  if (noBuy.size) {
    const opBlock = symbolBlocklist();
    const wouldTarget = ranked.filter((r) => r.score > 0 && !opBlock.has(r.sym)).slice(0, N);
    const suppressed = wouldTarget.filter((r) => noBuy.has(r.sym));
    if (suppressed.length) {
      void recordGateBlocks(ctx.pool, sub, book, 'earnings', suppressed.map((r) => {
        const closes = bars.get(r.sym) || [];
        return { symbol: r.sym, refPrice: closes.length ? closes[closes.length - 1] : null };
      }));
    }
  }
  // The HOLD leaderboard — drives the drop-out sells below. Deliberately UNGUARDED: the entry guards
  // gate BUYS only. Guarding this set would drop a gap-down name off the leaderboard and make rotation
  // place a second full-qty sell on a name the protective leg is already exiting this fire (a double
  // sell), and would force-sell a held gap-down name that the stop should be the one to judge.
  const target = eligible.slice(0, N);
  const targetSet = new Set(target);
  const scoreBySym = new Map(ranked.map((r) => [r.sym, r.score]));

  // The BUY leaderboard — the same ranking, minus whatever the entry guards refuse: a name the
  // protective leg is selling RIGHT NOW (never re-buy the stop's own exit — it voids the stop and
  // books a wash sale), and a name trading far below its prior close (the ranker scores on daily
  // closes, so on a gap day it is ranking a price that no longer exists). A refused leader frees its
  // slot to the next-best candidate, so a blocked name costs the sleeve nothing. Born 2026-07-14:
  // the live open stopped IBM out at -23.8% on its Q2 revenue-miss gap and re-bought it the same fire.
  const slate = eligible.slice(0, N * 2 + 5); // bounded: enough depth to backfill every refusal
  const guardIn = await buildEntryGuard(slate, exiting);
  const picked = selectEntryTargets(slate, N, guardIn);
  const buyTargets = picked.targets;
  if (picked.blocked.length) {
    logger.info({ scheduleId: sub, mode, refused: picked.blocked, maxGapDownPct: guardIn.maxGapDownPct },
      'rotation entry guard refused candidates');
  }

  // SELLS — rotate OUT every held sleeve name that is no longer in the target leaderboard.
  const currentSleeve = positions.filter((p) => p.qty > 0 && !coreSet.has(p.symbol.toUpperCase()));
  const sold = new Set<string>();
  for (const p of currentSleeve) {
    const sym = p.symbol.toUpperCase();
    if (targetSet.has(sym)) continue; // still a leader — keep holding
    await placeManaged(ctx, sub, book, {
      symbol: p.symbol, action: 'sell', side: 'sell', qty: p.qty, confidence: 1,
      rationale: `Rotation (${cfg.rank}) — dropped out of the top ${N}; rotating capital to stronger names.`,
      indicators: { reason: 'rotation', rank: cfg.rank }, price: null, source: 'gravity-rotation',
    }, orders, errors, 'rotation');
    sold.add(sym);
  }

  // REBALANCE every leader to its TARGET WEIGHT. This is the fix for "a held winner stays oversized" — an
  // 85% SPY that ranks in the top-N used to be KEPT at 85% because held names were skipped; now it's trimmed
  // to its share like any other name ("SPY is just another stock"). Goal per name: conviction = its score's
  // share of the sleeve budget capped at the per-name cap (strongest get the most); equal = sleeveBudget/N.
  // TRIM over-goal holdings first (frees cash), then BUY the under-goal names strongest-first. No forced
  // count — a name with no pull gets $0. cashAvail is an estimate (fills are async); caps bound it.
  const heldNow = new Map(currentSleeve.filter((p) => !sold.has(p.symbol.toUpperCase())).map((p) => [p.symbol.toUpperCase(), Math.max(0, p.marketValue)]));
  const sleeveBudget = (sleevePct / 100) * equity;
  const perName = (perNamePct / 100) * equity;
  const scoreSum = buyTargets.reduce((s, sym) => s + Math.max(0, scoreBySym.get(sym) ?? 0), 0);
  const dust = equity * 0.005;
  const goalOf = (sym: string): number => {
    const score = Math.max(0, scoreBySym.get(sym) ?? 0);
    return (cfg.weighting === 'conviction' && scoreSum > 0)
      ? Math.min(perName, (score / scoreSum) * sleeveBudget)
      : Math.min(perName, sleeveBudget / Math.max(1, N));
  };
  // Venue-routed sizing price (sizingPrice): live reads the EXECUTING venue (Schwab) and fails
  // closed — an unpriceable name is skipped, never sized off the paper feed or a stale IEX daily
  // close; paper keeps Alpaca + the ranker's own last daily close as fallback (unchanged semantics).
  const priceOf = async (sym: string): Promise<number | null> => {
    const closes = bars.get(sym) || bars.get(sym.toUpperCase());
    return sizingPrice(mode, sub, sym, closes && closes.length ? closes[closes.length - 1] : null);
  };
  // 1) TRIM every target we hold ABOVE its goal back down to the goal (the 85%-SPY fix; frees real cash).
  //    Guard-refused names are skipped here too: a name the stop is already selling must not also get a
  //    rotation trim (two sells for one position), and a gap-down name's "goal" is meaningless today.
  for (const sym of buyTargets) {
    const cur = heldNow.get(sym) ?? 0; const goal = goalOf(sym);
    if (cur - goal <= dust || cur <= 0) continue;
    const px = await priceOf(sym); if (!px) continue;
    const qty = Math.floor((cur - goal) / px); if (qty < 1) continue;
    await placeManaged(ctx, sub, book, {
      symbol: sym, action: 'sell', side: 'sell', qty, confidence: 1,
      rationale: `Rotation (${cfg.rank}/${cfg.weighting}) — trim to target weight ($${Math.round(goal)}); no single name dominates.`,
      indicators: { reason: 'rotation-trim', rank: cfg.rank, weighting: cfg.weighting }, price: px, source: 'gravity-rotation',
    }, orders, errors, 'rotation');
  }
  // LEVERAGE-PROOF FUNDING: wait for the drop-out sells + trims above to actually SETTLE, then re-read the
  // REAL cash and fund buys ONLY from that — never spend anticipated proceeds. A rejected or slow sell then
  // just means less cash and fewer buys, NEVER an over-deploy. (Fixes the 2026-07-01 bug where a sell's
  // proceeds were counted before it confirmed, so a rejected trim let the buys leverage the book to 1.6x.)
  await new Promise((r) => setTimeout(r, 6000));
  const acctNow = capAccount((await getBrokerAdapter(mode, sub, bookBinding(book)).getAccount().catch(() => null)) ?? account, book);
  let cashAvail = Math.max(0, Number((acctNow && acctNow.cash) ?? account.cash) || 0);
  // 2) BUY every target BELOW its goal (held-under-goal + brand-new names), strongest score first.
  let openCount = positions.filter((p) => p.qty > 0).length - sold.size;
  for (const sym of buyTargets) {
    if (openCount >= policy.maxPositions) break;
    const cur = heldNow.get(sym) ?? 0; const goal = goalOf(sym);
    if (goal - cur <= dust) continue;
    const px = await priceOf(sym); if (!px) continue;
    const notional = Math.min(goal - cur, Math.max(0, cashAvail));
    const qty = Math.floor(notional / px); if (qty < 1) continue;
    await placeManaged(ctx, sub, book, {
      symbol: sym, action: 'buy', side: 'buy', qty, confidence: 1,
      rationale: `Rotation (${cfg.rank}/${cfg.weighting}) — size into top-${N} at target weight ($${Math.round(goal)}; score ${(scoreBySym.get(sym) ?? 0).toFixed(2)}).`,
      indicators: { reason: 'rotation', rank: cfg.rank, weighting: cfg.weighting, score: scoreBySym.get(sym) ?? 0 }, price: px, source: 'gravity-rotation',
    }, orders, errors, 'rotation');
    cashAvail -= qty * px; if (!heldNow.has(sym)) openCount += 1;
  }
}

/**
 * @description Blend rotation (ADR-095 round 2) — the merged-target sibling of rotateSleeve for an
 * applied BLEND override ("30% gravity + 20% momentum"). blendRotationPlan ranks each component's
 * own universe, sizes goals inside its weight-share of the sleeve budget (per-name capped by the
 * COMPONENT's posture), and merges overlapping picks by summing goals; this function then executes
 * the plan with rotateSleeve's exact discipline: drop-out sells → over-goal trims → settle-wait +
 * real-cash re-read (leverage-proof funding, the 2026-07-01 lesson) → under-goal buys strongest
 * merged score first. `policy` arrives as the most-conservative component policy (caps + count).
 * @param ctx - App context.
 * @param sub - Owner sub.
 * @param mode - Book.
 * @param account - Broker snapshot (already capped for live).
 * @param positions - Current positions.
 * @param policy - Most-conservative blend policy (book-level caps).
 * @param coreSet - Core symbols (exempt).
 * @param symbols - The union universe this fire scanned.
 * @param orders - Run-order accumulator.
 * @param errors - Run-error accumulator.
 * @param override - The active blend override (components + applyPct already reflected in core).
 */
async function rotateBlendSleeve(
  ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, account: BrokerAccount, positions: Position[],
  policy: RiskPolicy, coreSet: Set<string>, symbols: string[],
  orders: RunOrder[], errors: Array<{ symbol: string; error: string }>,
  override: ConfigOverrideRow,
  exiting: Set<string> = new Set(),
  noBuy: Set<string> = new Set(),
): Promise<void> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const mode = book.kind;
  const components = override.config.components ?? [];
  const equity = account.equity > 0 ? account.equity : account.cash;
  if (!components.length || equity <= 0) return;
  const core = coreConfig(override);
  const sleevePct = Math.max(0, 100 - (core.symbols.length ? core.targetPct : 0));
  if (sleevePct <= 0) return;
  const sleeveBudget = (sleevePct / 100) * equity;

  const universe = symbols.filter((s) => !coreSet.has(s.toUpperCase()));
  const bars = await barsBatch(universe, '1Day', 150);
  const plan = blendRotationPlan(components, sleeveBudget, equity, bars, coreSet, new Set([...symbolBlocklist(), ...noBuy]), rankUniverse);

  // SELLS — rotate OUT every held sleeve name no component targets anymore.
  const currentSleeve = positions.filter((p) => p.qty > 0 && !coreSet.has(p.symbol.toUpperCase()));
  const sold = new Set<string>();
  for (const p of currentSleeve) {
    const sym = p.symbol.toUpperCase();
    if (plan.targetSet.has(sym)) continue;
    await placeManaged(ctx, sub, book, {
      symbol: p.symbol, action: 'sell', side: 'sell', qty: p.qty, confidence: 1,
      rationale: `Blend rotation — no component targets ${sym} anymore; rotating capital to the merged leaders.`,
      indicators: { reason: 'rotation', rank: 'blend-multi' }, price: null, source: 'gravity-rotation',
    }, orders, errors, 'rotation');
    sold.add(sym);
  }

  const heldNow = new Map(currentSleeve.filter((p) => !sold.has(p.symbol.toUpperCase())).map((p) => [p.symbol.toUpperCase(), Math.max(0, p.marketValue)]));
  const dust = equity * 0.005;
  // ENTRY GUARDS (same contract as rotateSleeve): refuse a merged target that the protective leg is
  // exiting this fire, or that is trading far below its prior close. Entries only — plan.targetSet
  // above (the drop-out sells) is deliberately left unguarded.
  const guardIn = await buildEntryGuard([...plan.goals.keys()], exiting);
  const refused = new Set<string>();
  const refusals: EntryBlock[] = [];
  for (const sym of plan.goals.keys()) {
    const block = entryBlock(sym, guardIn);
    if (block) { refused.add(sym.toUpperCase()); refusals.push(block); }
  }
  if (refusals.length) {
    logger.info({ scheduleId: sub, mode, refused: refusals, maxGapDownPct: guardIn.maxGapDownPct },
      'blend rotation entry guard refused candidates');
  }
  // Venue-routed sizing price (sizingPrice): live reads the EXECUTING venue (Schwab) and fails
  // closed — an unpriceable name is skipped, never sized off the paper feed or a stale IEX daily
  // close; paper keeps Alpaca + the ranker's own last daily close as fallback (unchanged semantics).
  const priceOf = async (sym: string): Promise<number | null> => {
    const closes = bars.get(sym) || bars.get(sym.toUpperCase());
    return sizingPrice(mode, sub, sym, closes && closes.length ? closes[closes.length - 1] : null);
  };
  // 1) TRIM every target held ABOVE its merged goal (frees real cash before the buys).
  for (const [sym, g] of plan.goals) {
    if (refused.has(sym.toUpperCase())) continue;
    const cur = heldNow.get(sym) ?? 0;
    if (cur - g.goal <= dust || cur <= 0) continue;
    const px = await priceOf(sym); if (!px) continue;
    const qty = Math.floor((cur - g.goal) / px); if (qty < 1) continue;
    await placeManaged(ctx, sub, book, {
      symbol: sym, action: 'sell', side: 'sell', qty, confidence: 1,
      rationale: `Blend rotation — trim to merged target weight ($${Math.round(g.goal)}).`,
      indicators: { reason: 'rotation-trim', rank: 'blend-multi' }, price: px, source: 'gravity-rotation',
    }, orders, errors, 'rotation');
  }
  // LEVERAGE-PROOF FUNDING: wait for sells/trims to settle, re-read REAL cash, fund buys only from it.
  await new Promise((r) => setTimeout(r, 6000));
  const acctNow = capAccount((await getBrokerAdapter(mode, sub, bookBinding(book)).getAccount().catch(() => null)) ?? account, book);
  let cashAvail = Math.max(0, Number((acctNow && acctNow.cash) ?? account.cash) || 0);
  // 2) BUY every target BELOW its merged goal, strongest merged score first.
  let openCount = positions.filter((p) => p.qty > 0).length - sold.size;
  const buyOrder = [...plan.goals.entries()].filter(([sym]) => !refused.has(sym.toUpperCase())).sort((x, y) => y[1].score - x[1].score);
  for (const [sym, g] of buyOrder) {
    if (openCount >= policy.maxPositions) break;
    const cur = heldNow.get(sym) ?? 0;
    if (g.goal - cur <= dust) continue;
    const px = await priceOf(sym); if (!px) continue;
    const notional = Math.min(g.goal - cur, Math.max(0, cashAvail));
    const qty = Math.floor(notional / px); if (qty < 1) continue;
    await placeManaged(ctx, sub, book, {
      symbol: sym, action: 'buy', side: 'buy', qty, confidence: 1,
      rationale: `Blend rotation — size into merged target ($${Math.round(g.goal)}; strongest component score ${g.score.toFixed(2)}).`,
      indicators: { reason: 'rotation', rank: 'blend-multi', score: g.score }, price: px, source: 'gravity-rotation',
    }, orders, errors, 'rotation');
    cashAvail -= qty * px; if (!heldNow.has(sym)) openCount += 1;
  }
}

/** Hard stop / take-profit (exitsToRun) + trailing-stop exits for the book, deduped by symbol with
 *  the trailing peak rolled forward + persisted. Stop/TP win over trailing when both fire on a name. */
async function computeExits(ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, positions: Position[], policy: RiskPolicy, equity: number, extHours: boolean): Promise<ExitOrder[]> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  await ensurePeaksTable(ctx.pool);
  const peaks = nextPeaks(positions, await loadPeaks(ctx.pool, sub, book));
  await savePeaks(ctx.pool, sub, book, peaks);
  // EXTENDED HOURS = DEFENSE ONLY (operator doctrine 2026-07-07): the ONLY off-hours exit is the
  // close-anchored dip rule — sell a name outright when it prints TRADING_EXT_DIP_SELL_PCT (default
  // 0.5%) below its last regular close. No take-profits, no trailing, no cap trims off-hours (the
  // 4 AM cap-trim liquidation was an off-hours trim). Backtested +$461 over all 6 session nights,
  // zero negative windows (trading-exthours-rule-backtest.js).
  if (extHours) {
    const dipPct = Number(process.env.TRADING_EXT_DIP_SELL_PCT || 0.5);
    const held = positions.filter((p) => p.qty > 0).map((p) => p.symbol.toUpperCase());
    if (!held.length) return [];
    const dailyBars = await barsBatch(held, '1Day').catch(() => new Map<string, number[]>());
    const priorClose = new Map<string, number>();
    for (const sym of held) {
      const closes = dailyBars.get(sym) || [];
      if (closes.length) priorClose.set(sym, closes[closes.length - 1]);
    }
    return dipExits(positions, priorClose, dipPct);
  }
  const stopMult = 1;
  const bySym = new Map<string, ExitOrder>();
  // Order = priority: a full stop/TP wins over trailing, and any full exit wins over a partial cap trim
  // (no point trimming a name we're about to flatten this fire).
  for (const e of [...exitsToRun(positions, policy, stopMult), ...trailingExits(positions, peaks, policy, stopMult), ...rebalanceTrims(positions, equity, policy)]) {
    const k = e.symbol.toUpperCase();
    if (!bySym.has(k)) bySym.set(k, e);
  }
  return [...bySym.values()];
}

/** Place new conviction-sized entries from the scan, portfolio-gated, capped per fire. The world
 *  influence gate vetoes names the press/influencers are actively souring on and tilts size with the
 *  mood (both no-ops when coverage is thin). It never creates a buy the technicals didn't already pick. */
async function placeEntries(
  ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, scan: Map<string, MtfDecision>,
  held: Map<string, number>, account: BrokerAccount, policy: RiskPolicy, positions: Position[],
  orders: RunOrder[], errors: Array<{ symbol: string; error: string }>, worldSvc: WorldIntelligenceService | null,
  inFlight: Set<string>, extHours: boolean, noBuy: Set<string> = new Set(),
): Promise<void> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const mode = book.kind;
  // Trade SMALLER in thin pre/post sessions — gaps + wide spreads make ext-hours the high-variance
  // window (where money is made AND lost). Halve the size by default so a gap can't hurt the book as much.
  const extSizeMult = extHours ? Number(process.env.TRADING_EXT_SIZE_MULT || 0.5) : 1;
  // A candidate that clears every buy predicate below EXCEPT the gates: the entry the engine WOULD
  // have made. Shared by the buys filter and the counterfactual capture so they cannot drift apart.
  const wouldBuy = (d: MtfDecision): boolean =>
    d.action === 'buy' && (held.get(d.symbol) || 0) <= 0 && !inFlight.has(d.symbol.toUpperCase())
    && !!d.price && !isShortTermBreakdown(d)
    && !symbolBlocklist().has(d.symbol.toUpperCase());    // operator blocklist — the engine never buys these
  const buys = [...scan.values()]
    // Don't catch a falling knife: skip names breaking down on the short timeframes even when the
    // regime-weighted call is "buy the dip" — this also stops the sell→rebuy→sell churn on a crash.
    // Exclude names with a WORKING order (a pending pre/post-market limit getPositions() can't see) so
    // we don't pyramid the same ticker across fires until they all fill at the open.
    .filter((d) => wouldBuy(d)
      && !noBuy.has(d.symbol.toUpperCase()));             // earnings blackout (when armed) — never initiate into a print
  // Counterfactual ledger: entries the blackout suppressed, persisted so the gate accumulates
  // scoreable evidence (fire-and-forget — evidence loss must never affect the fire).
  if (noBuy.size) {
    const blocked = [...scan.values()].filter((d) => wouldBuy(d) && noBuy.has(d.symbol.toUpperCase()));
    if (blocked.length) void recordGateBlocks(ctx.pool, sub, book, 'earnings', blocked.map((d) => ({ symbol: d.symbol, refPrice: d.price ?? null })));
  }

  // World-intelligence RANK + sizing tilt (TRADING_WORLD_RANK, default off). Prefetch a blended
  // smart-money/sentiment score per candidate so the world layer becomes a POSITIVE conviction input —
  // it reorders the buy queue and tilts size — instead of only the existing negative veto. The veto on
  // raw sentiment below is unchanged. Off (or no world svc) → identical to the confidence-only baseline.
  const rankWorld = worldRankEnabled() && worldSvc != null;
  const worldBlend = new Map<string, number>();
  if (rankWorld) {
    // ONE batched query for the whole candidate set (not 8×N single reads) — see readWorldSignalsBatch.
    const basket = await readWorldSignalsBatch(worldSvc as WorldIntelligenceService, buys.map((d) => d.symbol), WORLD_SENT_DAYS);
    for (const [sym, w] of basket) if (w.score != null) worldBlend.set(sym, w.score);
  }
  const rankScore = (d: MtfDecision): number => d.confidence + (rankWorld ? WORLD_RANK_WEIGHT * (worldBlend.get(d.symbol.toUpperCase()) ?? 0) : 0);
  buys.sort((a, b) => rankScore(b) - rankScore(a));
  let entries = 0;
  for (const d of buys) {
    if (entries >= MAX_ORDERS_PER_RUN) break;
    const world = await worldSentiment(worldSvc, d.symbol);
    const acts = world.score != null && world.points >= WORLD_SENT_MIN_POINTS;
    // VETO: the influence layer is strongly negative on this name — stand aside even if technicals like it.
    if (acts && (world.score as number) <= WORLD_SENT_VETO) {
      logger.info({ sub, symbol: d.symbol, sentiment: world.score, points: world.points }, 'autopilot entry vetoed by world sentiment');
      continue;
    }
    // Recent daily volatility (14-day return stdev %) → volatility-normalized sizing so a high-vol name
    // gets a smaller position and can't dominate the loss side (fixes the win/loss size skew).
    let volPct: number | undefined;
    try {
      const closes = await dailyCloses(d.symbol, 15);
      if (closes.length > 5) {
        const rets: number[] = []; for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        volPct = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * 100;
      }
    } catch { /* vol optional — fall back to flat sizing */ }
    const sized = sizeEntry(d.symbol, d.price as number, d.confidence, account, positions, policy, volPct);
    if (sized.qty <= 0) continue; // blocked by a cap — skip quietly
    // TILT: scale size with the mood (±40%, floored at 1 share) when coverage is real. Under
    // TRADING_WORLD_RANK the tilt uses the BLENDED score (insider+congress+sentiment momentum), else
    // the raw news sentiment as before.
    const tiltScore = (rankWorld && worldBlend.has(d.symbol.toUpperCase())) ? (worldBlend.get(d.symbol.toUpperCase()) as number) : (world.score ?? 0);
    let qty = (acts || (rankWorld && worldBlend.has(d.symbol.toUpperCase())))
      ? Math.max(1, Math.round(sized.qty * clamp(1 + 0.4 * tiltScore, 0.6, 1.4)))
      : sized.qty;
    // Extended-hours size-down (thin/gappy session).
    qty = Math.floor(qty * extSizeMult);
    if (qty < 1) continue; // too small after the ext-hours haircut — skip rather than place a token share
    await placeManaged(ctx, sub, book, scanDecision(d, 'buy', qty, world), orders, errors);
    entries += 1;
  }
}

/** Run one autopilot fire: protective exits (incl. trailing + breakdown) first, then new entries.
 *  `session` ('pre'|'regular'|'post') drives extended-hours-aware risk (size-down + wider stops off-hours). */
/**
 * @description Autonomous LIVE autopilot is a DOUBLE opt-in: the master live gate
 * (TRADING_LIVE_ENABLED) AND TRADING_AUTOPILOT_LIVE. Default OFF — the cron stays paper even when
 * manual live is armed. Only the main autopilot honors this; the swing/research legs remain paper.
 * @returns True when the cron is authorized to place LIVE orders.
 */
function autopilotLiveAllowed(): boolean {
  return process.env.TRADING_LIVE_ENABLED === 'true' && process.env.TRADING_AUTOPILOT_LIVE === 'true';
}

/**
 * @description Cap the account snapshot to TRADING_CAPITAL_CAP_USD so the strategy sizes as if the
 * account were that small — e.g. run a 10K book on a 50K account. Equity (the % sizing base) is capped
 * to the cap; cash/buyingPower are capped to the HEADROOM left under the cap after the current position
 * value (derived as equity−cash), so `positions + new buys ≤ cap` on every run and every deploy path —
 * it can never leverage the real account past the cap. No-op when the cap is unset/≤0.
 * LIVE-ONLY: the cap exists to bound the real-money book (ADR-052 arming). It must NEVER apply to
 * paper — on 2026-07-07 the unscoped cap pinned the $104K paper book's equity to $20K, so the
 * per-name cap became $2K and rebalanceTrims "cap-trimmed" (mass-liquidated) two-thirds of every
 * paper position at 4 AM pre-market prices. Paper is the full-size reference book by design.
 * NOTE: because equity is pinned at the cap while the real account exceeds it, the account-level
 * daily-loss breaker is muted at the capped scale; per-position stops (trailing/backstop) stay active.
 * @param account - The real broker account snapshot.
 * @param mode - The book being run; the cap applies to 'live' only.
 * @returns The capped snapshot (or the original for paper / when no cap is set).
 */
function capAccount(account: BrokerAccount, book: TradingBook): BrokerAccount {
  if (book.kind !== 'live') return account;
  // ADR-134: effective cap = LEAST(env fleet floor, the book's own cap); nulls fall through.
  const envCap = Number(process.env.TRADING_CAPITAL_CAP_USD) || 0;
  const bookCap = book.capitalCapUsd ?? 0;
  const cap = envCap > 0 && bookCap > 0 ? Math.min(envCap, bookCap) : (envCap > 0 ? envCap : bookCap);
  if (cap <= 0) return account;
  const positionsValue = Math.max(0, (account.equity || 0) - (account.cash || 0)); // equity = cash + positions
  const room = Math.max(0, cap - positionsValue); // cash headroom so positions + new buys ≤ cap
  return {
    ...account,
    equity: Math.min(account.equity, cap),
    cash: Math.min(account.cash, room),
    buyingPower: Math.min(account.buyingPower, room),
  };
}

async function runAutopilot(ctx: AppContext, sub: string, bookOrMode: TradingBook | TradingMode, symbols: string[], session: string, override: ConfigOverrideRow | null = null): Promise<RunSummary> {
  const book = typeof bookOrMode === 'string' ? legacyBook(sub, bookOrMode) : bookOrMode;
  const mode = book.kind;
  await ensureTradingSchema(ctx.pool);
  const extHours = session === 'pre' || session === 'post';
  // The sub is REQUIRED here: the live (Schwab) adapter resolves the per-user brokered token by sub.
  // Without it every account/position read silently returns empty and the engine sizes against a $0
  // account — the 2026-07-07 "zombie live fires" (scanned 101, entries 0, no errors, all day).
  const broker = getBrokerAdapter(mode, sub, bookBinding(book));
  const policy = riskPolicy(mode, policyOverrideOf(override));
  // Both reads must SUCCEED or the fire is skipped. A failed POSITIONS read used to `.catch(() => [])`,
  // which is strictly more dangerous than the $0-account case it sat next to: an empty book is a
  // LEGITIMATE state, so the engine cannot tell "read failed" from "genuinely flat" and proceeds on the
  // false premise that it owns nothing — ensureCore re-buys the whole core from scratch with all
  // available cash, computeExits fires NO stops (no positions to exit), and rotation re-buys names it
  // already holds. That is not hypothetical: on 2026-07-14 a failed read took the live SPY core from
  // 58.7% to 79% of equity in one fire (a 14-share top-up against a shortfall that was really ~$680).
  // A throw is unambiguous where an empty array is not — so we abort on the throw, exactly like the
  // account read has since the 2026-07-07 "zombie live fires".
  const [positionsRead, accountRaw] = await Promise.all([
    broker.getPositions().then((p) => ({ ok: true as const, positions: p })).catch((err) => ({ ok: false as const, err })),
    broker.getAccount().catch(() => null),
  ]);
  if (!accountRaw) {
    logger.warn({ sub, mode }, 'autopilot fire: broker account read FAILED — engine would size against $0; skipping this fire');
    return { scanned: 0, entries: 0, exits: 0, orders: [], errors: [{ symbol: '*', error: 'broker account read failed' }], posture: policy.posture };
  }
  if (!positionsRead.ok) {
    logger.warn({ sub, mode, err: positionsRead.err },
      'autopilot fire: broker POSITIONS read FAILED — engine would believe the book is flat (re-buy the core, skip every stop); skipping this fire');
    return { scanned: 0, entries: 0, exits: 0, orders: [], errors: [{ symbol: '*', error: 'broker positions read failed' }], posture: policy.posture };
  }
  // ADR-138 D3 — THE OVERLAY: subtract protected-lot shares from the autopilot's view. A symbol the
  // operator pinned in full disappears; a partial pin leaves the residual. If the lot ledger cannot be
  // read we fail CLOSED exactly like the positions read: acting on an unknown book could liquidate
  // shares the operator explicitly protected.
  const pinnedRead = await pinnedQtyBySymbol(ctx.pool, sub, book.bookId).then((m) => ({ ok: true as const, m })).catch((err) => ({ ok: false as const, err }));
  if (!pinnedRead.ok) {
    logger.warn({ sub, mode, err: pinnedRead.err }, 'autopilot fire: protected-lot ledger read FAILED — engine could sell pinned shares; skipping this fire');
    return { scanned: 0, entries: 0, exits: 0, orders: [], errors: [{ symbol: '*', error: 'protected-lot ledger read failed' }], posture: policy.posture };
  }
  const positions = subtractPinnedLots(positionsRead.positions, pinnedRead.m);
  if (pinnedRead.m.size) logger.info({ sub, mode, pinned: [...pinnedRead.m.entries()] }, 'protected lots subtracted from the autopilot view');
  // Snapshot the REAL equity for the honest day-P&L baseline (latest-per-ET-day ≈ that day's close)
  // BEFORE the sizing cap — the store is the truth source for recaps/guards and must never carry the
  // capped sizing fiction (07-07: capped paper equity=20000 was recorded and poisoned the day P&L).
  if (accountRaw && accountRaw.equity > 0) await recordDailyEquity(ctx.pool, sub, book, accountRaw.equity).catch(() => {});
  // Cap to the configured book size (e.g. run a 10K book on the real 50K account) — LIVE only; the
  // paper reference book always runs full-size. All sizing below reads this snapshot.
  const account: BrokerAccount = capAccount(accountRaw ?? { cash: 0, buyingPower: 0, equity: 0, currency: 'USD' }, book);
  const orders: RunOrder[] = [];
  const errors: Array<{ symbol: string; error: string }> = [];
  // Shared world-intelligence read used by the entry influence gate (null when the layer is off → neutral).
  const worldSvc = createWorldIntelligenceService();
  // EARNINGS BLACKOUT (TRADING_EARNINGS_GATE, default off; mode-aware: paper|live|both) — read ONCE
  // per fire. Empty set unless armed for THIS book, so the default path is byte-identical.
  // Evidence: 2026-07-14 earnings-proximity study; counterfactuals accrue in the gate-block ledger.
  const noBuy = await earningsBlackout(worldSvc, mode);
  if (noBuy.size) logger.info({ sub, mode, blackout: [...noBuy].join(','), days: EARNINGS_BLACKOUT_DAYS }, 'earnings blackout active — these names will not be bought');

  // 0) Beta core — deploy idle cash into a market-index core (captures the market beta the active
  //    sleeve can't ride). Cash-only, regular-hours only; exempt from every sleeve sell below.
  const core = coreConfig(override);
  const coreSet = new Set(core.symbols);
  let coreSpent = 0;
  if (core.symbols.length && core.targetPct > 0 && !extHours) {
    try { coreSpent = await ensureCore(ctx, sub, book, account, positions, core, orders, errors); }
    catch (e) { logger.warn({ err: e, scheduleId: sub }, 'beta-core top-up failed'); }
  }

  // 1) Protective exits — hard stop / take-profit / trailing stop + cap-breach trims on open longs.
  //    Core symbols are exempt (we hold the core; the sleeve never sells it).
  const exits = (await computeExits(ctx, sub, book, positions, policy, account.equity, extHours)).filter((e) => !coreSet.has(e.symbol.toUpperCase()));
  const exiting = new Set(exits.map((e) => e.symbol.toUpperCase()));
  // Free shares locked by STALE working sells (a stranded ext-hours limit) before re-placing, so a
  // protective exit can chase a falling market instead of being rejected fire after fire.
  await freeStaleSells(ctx, sub, book, exiting).catch((e) => logger.warn({ err: e }, 'freeStaleSells failed'));
  for (const e of exits) await placeManaged(ctx, sub, book, exitDecision(e), orders, errors, e.reason);

  // 1b) OPTIONAL gravity-ranked sleeve rotation (TRADING_SLEEVE_ROTATION, default OFF). When enabled,
  //     rotation OWNS the sleeve: on a weekly cadence (TRADING_ROTATION_EVERY_DAYS) it ranks the
  //     universe by gravity pull and rotates capital into the leaders, and the scan-based sleeve logic
  //     below (2b technical sells / 2c benches / 2d entries) is SKIPPED. The protective exits above and
  //     the 2a breakdown exit still run as a safety net in both modes. Off → everything below is unchanged.
  const rot = rotationConfig(override);
  const rotationOwnsSleeve = rot.enabled;
  // ADR-134: a DISABLED book takes no NEW risk — rotation (which buys) is skipped — while the
  // protective exits above and the breakdown leg below KEEP RUNNING for any open positions.
  // "Disable" means stop adding risk, never abandon the book.
  if (rot.enabled && !book.enabled) {
    logger.info({ sub, mode, bookRef: book.ref }, 'book disabled — rotation skipped (protective exits still ran)');
  }
  if (rot.enabled && book.enabled) {
    try {
      await ensureRotationStateTable(ctx.pool);
      const last = await loadLastRotated(ctx.pool, sub, book).catch(() => null);
      // Cadence in CALENDAR days (US/Eastern), NOT 24h-since-last. So daily (everyDays=1) fires on the
      // first regular-session fire of each new trading day — i.e. the OPEN — instead of drifting to
      // whenever 24h elapses from the prior rotation (mid-afternoon). Pre-market fires are still blocked
      // by the extHours gate below, so "first regular fire of a new ET day" lands at the open.
      const dueDays = last
        ? Math.round((Date.parse(etSessionDate() + 'T00:00:00Z') - Date.parse(etSessionDate(last.getTime()) + 'T00:00:00Z')) / 86400000)
        : Infinity;
      // FAIL-CLOSED breaker (ADR-134 live-safety review): an evaluation ERROR used to read as
      // "not halted" — any exception the re-key could introduce would silently DISARM the breaker
      // on real money. An error now halts NEW risk for this fire (exits above are unaffected),
      // mirroring the account/positions read doctrine.
      const guard = await evaluateEquityGuard(ctx.pool, sub, book, account.equity, policy).catch((err) => {
        logger.error({ err, sub, mode, bookRef: book.ref }, 'equity-guard evaluation FAILED — failing CLOSED (no new risk this fire)');
        return { halted: true, drawdownPct: -1, highWaterMark: 0 };
      });
      // Rotate when the cadence is due and the drawdown breaker hasn't tripped. By default regular hours
      // only; TRADING_ROTATION_EXT_HOURS lets it fire pre/post too (the daily cadence still caps it to
      // one rotation/day, so with ext-hours on it rotates at the first eligible fire — possibly pre-market).
      if ((!extHours || rot.extHours) && dueDays >= rot.everyDays && !(guard && guard.halted)) {
        const beforeRotation = orders.length;
        // `exiting` (the protective leg's sells, placed just above) is threaded in so rotation cannot
        // re-buy a name the stop is selling in this same fire — the 2026-07-14 IBM round-trip.
        if (override?.config.kind === 'blend') await rotateBlendSleeve(ctx, sub, book, account, positions, policy, coreSet, symbols, orders, errors, override, exiting, noBuy);
        else await rotateSleeve(ctx, sub, book, account, positions, policy, coreSet, symbols, orders, errors, override, exiting, noBuy);
        const rotationPlaced = orders.length - beforeRotation;
        const sleeveHeld = positions.filter((p) => p.qty > 0 && !coreSet.has(p.symbol.toUpperCase())).length;
        // Consume the daily rotation slot only when rotation DEPLOYED something or the sleeve is
        // already positioned. An EMPTY sleeve that bought nothing (an all-red open where no target
        // was buyable) must NOT burn the day's only buy window — 2026-07-07: live "rotated" nothing
        // at the 9:30 open and then sat 100% cash while the tape turned buyable at noon.
        if (rotationPlaced > 0 || sleeveHeld > 0) {
          await saveLastRotated(ctx.pool, sub, book).catch(() => {});
        } else {
          logger.info({ sub, mode }, 'rotation deployed nothing on an empty sleeve — daily slot NOT consumed; retrying next fire');
        }
      }
    } catch (e) {
      logger.warn({ err: e, scheduleId: sub }, 'gravity sleeve rotation failed');
    }
  }

  // 2) Multi-timeframe scan → fast breakdown protections, technical closes, then new entries.
  //    Weighted by the OVERNIGHT-LEARNED per-algo masses so proven signals pull harder, and using the
  //    APPROVED tuned strategy params (defaults = unchanged engine until the operator approves a tweak).
  const algoMasses = await loadAlgoMasses(ctx.pool);
  const strategyParams = await loadStrategyParams(ctx.pool);
  const scan = await multiTimeframeScan(symbols.filter((s) => !coreSet.has(s.toUpperCase())), algoMasses, strategyParams);
  const held = new Map(positions.map((p) => [p.symbol.toUpperCase(), p.qty]));

  // 2a) Short-timeframe breakdown — a held name crashing on 5Min+1Hour even if the regime is up
  //     (the news-driven intraday selloff the regime-weighted score is too slow to flag).
  const breakdowns = new Set<string>();
  for (const [sym, qty] of held) {
    const d = scan.get(sym);
    if (qty > 0 && d && !exiting.has(sym) && !coreSet.has(sym) && isShortTermBreakdown(d)) breakdowns.add(sym);
  }
  if (breakdowns.size) {
    // Same stale-sell release as the protective exits above — a breakdown sell must never be
    // blocked by its own stranded prior attempt while the name is crashing.
    await freeStaleSells(ctx, sub, book, breakdowns).catch((e) => logger.warn({ err: e }, 'freeStaleSells failed'));
    for (const sym of breakdowns) {
      const d = scan.get(sym);
      const qty = held.get(sym) ?? 0;
      if (!d || !(qty > 0)) continue;
      await placeManaged(ctx, sub, book, breakdownDecision(d, qty), orders, errors, 'breakdown');
      exiting.add(sym);
    }
  }

  // 2a-pop) POP-CATCHER (opt-in, off by default) — pull an UNFUNDED name IN when it surges on the 5-minute
  //   bar. The daily rotation funds the proven leaders; this catches a fast intraday move they missed, from
  //   the idle cash reserve, in a small tranche, capped in count. Reuses the scan already computed above (no
  //   extra fetch); runs regardless of who owns the sleeve; step-1 protective stops exit it like any name.
  const pop = popCatcherConfig();
  if (pop.enabled && book.enabled && account.equity > 0) {
    const heldNow = new Set(positions.filter((p) => p.qty > 0).map((p) => p.symbol.toUpperCase()));
    const tranche = (pop.tranchePct / 100) * account.equity;
    let popCash = Math.max(0, account.cash - coreSpent); // don't double-spend what the core top-up claimed
    let placed = 0;
    const surges = [...scan.values()]
      .filter((d) => {
        const s = d.symbol.toUpperCase();
        return !heldNow.has(s) && !coreSet.has(s) && !exiting.has(s) && !symbolBlocklist().has(s) && d.score > 0 && isShortTermPop(d, pop.threshold);
      })
      .sort((a, b) => b.score - a.score); // strongest surge first
    for (const d of surges) {
      if (placed >= pop.maxPositions) break;
      const notional = Math.min(tranche, popCash);
      if (notional < account.equity * 0.005) break; // cash reserve exhausted
      const px = d.price ?? await latestPrice(d.symbol).catch(() => null);
      if (!px || px <= 0) continue;
      const qty = Math.floor(notional / px);
      if (qty < 1) continue;
      const fiveScore = d.perTimeframe.find((v) => v.timeframe === '5Min')?.score ?? 0;
      await placeManaged(ctx, sub, book, {
        symbol: d.symbol, action: 'buy', side: 'buy', qty, confidence: d.confidence,
        rationale: `Pop-catcher — 5-min momentum surge (5m ${fiveScore.toFixed(2)}, overall ${d.score.toFixed(2)}); intraday pull-in from cash.`,
        indicators: { reason: 'pop-catcher', mtfScore: d.score, fiveMin: fiveScore }, price: px, source: 'pop-catcher',
      }, orders, errors, 'pop');
      popCash -= qty * px; placed += 1;
    }
  }

  // The scan-based sleeve management (technical sells / benches / new entries) runs ONLY when the
  // gravity rotation is NOT in charge. With rotation enabled, rotateSleeve (1b) owns these decisions;
  // the protective exits (1) + the 2a breakdown exit above remain the always-on safety net.
  if (!rotationOwnsSleeve) {
    // 2b) Technical sells (weighted decision) not already exiting → close the long.
    for (const d of scan.values()) {
      const sym = d.symbol.toUpperCase();
      if (d.action === 'sell' && (held.get(sym) || 0) > 0 && !exiting.has(sym) && !coreSet.has(sym)) {
        await placeManaged(ctx, sub, book, scanDecision(d, 'sell', held.get(sym) as number), orders, errors);
        exiting.add(sym);
      }
    }
    // 2c) Coach the team — relative-strength rotation: bench a COLD held name (even a usual starter)
    //     to free its capital when a meaningfully hotter name is on the bench. The entries step (2d)
    //     then starts the hot name in the freed slot. This moves the money to the hot hand.
    const strength = new Map<string, NameStrength>(
      [...scan.values()].map((d) => [d.symbol.toUpperCase(), { score: d.score, action: d.action }]));
    for (const e of rotationBenches(positions, strength, policy)) {
      if (!exiting.has(e.symbol.toUpperCase()) && !coreSet.has(e.symbol.toUpperCase())) {
        await placeManaged(ctx, sub, book, exitDecision(e), orders, errors, 'rotation');
        exiting.add(e.symbol.toUpperCase());
      }
    }
    // 2d) New entries — UNLESS the account-drawdown circuit breaker has tripped OR the book is
    //     disabled (ADR-134: disable = no new risk). Exits already ran above; the breaker only stops
    //     NEW risk while equity is maxDrawdownPct below its high-water mark, until it recovers.
    //     FAIL-CLOSED (ADR-134): a guard-evaluation ERROR halts entries instead of reading as
    //     "not halted" — the .catch(() => null) shape silently disarmed the breaker on any exception.
    const guard = await evaluateEquityGuard(ctx.pool, sub, book, account.equity, policy).catch((err) => {
      logger.error({ err, sub, mode, bookRef: book.ref }, 'equity-guard evaluation FAILED — failing CLOSED (entries halted this fire)');
      return { halted: true, drawdownPct: -1, highWaterMark: 0 };
    });
    if (!book.enabled) {
      logger.info({ sub, mode, bookRef: book.ref }, 'book disabled — new entries skipped (exits/sells still ran)');
    } else if (guard?.halted) {
      logger.warn({ scheduleId: sub, drawdownPct: guard.drawdownPct.toFixed(1), maxDrawdownPct: policy.maxDrawdownPct }, 'autopilot — entries halted by account-drawdown circuit breaker');
    } else {
      const remaining = positions.filter((p) => !exiting.has(p.symbol.toUpperCase()));
      // Working orders (pending pre/post-market limits) aren't in positions or in cash yet. Exclude their
      // symbols from new entries and RESERVE their pending notional from cash so sizing can't over-deploy
      // the same dollars a working order already claimed (what drove cash negative in the open burst).
      const inFlight = await loadInFlight(ctx.pool, sub, book).catch(() => ({ symbols: new Set<string>(), pendingBuyNotional: 0 }));
      const reservedAccount: BrokerAccount = { ...account, cash: Math.max(0, account.cash - inFlight.pendingBuyNotional - coreSpent) };
      // NO BUYING OFF-HOURS (operator doctrine 2026-07-07): extended hours are defense-only — the
      // dip rule sells, nothing rebuys until the regular session. TRADING_EXT_ENTRIES=true re-enables
      // the old halved-size ext-hours entries if ever wanted.
      if (!extHours || String(process.env.TRADING_EXT_ENTRIES || 'false').toLowerCase() === 'true') {
        await placeEntries(ctx, sub, book, scan, held, reservedAccount, policy, remaining, orders, errors, worldSvc, inFlight.symbols, extHours, noBuy);
      }
    }
  }

  return {
    scanned: scan.size, entries: orders.filter((o) => o.side === 'buy').length,
    exits: orders.filter((o) => o.side === 'sell').length, orders, errors, posture: policy.posture,
  };
}

/** Log one summary ticket per fire — but only when something actually traded (no 5-min flood). */
async function logRunTicket(ctx: AppContext, sub: string, mode: TradingMode, s: RunSummary): Promise<void> {
  if (!s.orders.length && !s.errors.length) {
    logger.info({ sub, scanned: s.scanned }, 'autopilot run — no actionable trades');
    return;
  }
  await ctx.ticketService.createTicket({
    title: `🤖 Autopilot: ${s.entries} buy · ${s.exits} exit · ${s.scanned} scanned [${mode}/${s.posture}]`,
    ticketType: 'trading-decision', ownerSub: sub, status: 'complete',
    description: `Multi-timeframe autopilot run (${s.posture} risk) — ${s.entries} new entr(ies), ${s.exits} protective exit(s), ${s.errors.length} error(s).`,
    priority: 'none', labels: [], workspaceId: null, assignedAgentId: null, parentTicketId: null,
    externalProvider: null, externalId: null, externalUrl: null,
    metadata: { source: 'trading-autopilot', book: mode, posture: s.posture, firedAt: new Date().toISOString(), orders: s.orders, errors: s.errors, scanned: s.scanned, entries: s.entries, exits: s.exits },
  });
}

/**
 * @description Dispatch a trading-autopilot schedule that just came due.
 * @param ctx - App context (pool, ticketService).
 * @param schedule - The due schedule record (taskData carries userSub, mode, universe).
 * @returns Dispatch result for scheduler accounting.
 */
export async function dispatchTradingSchedule(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const td = schedule.taskData as Record<string, unknown>;
  const sub = String(td.userSub || '');
  let mode: TradingMode = String(td.mode || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';

  if (!sub) return { success: false, scheduleId: schedule.id, error: 'autopilot schedule missing userSub' };

  // ── ADR-134 book resolution — three hard rules (adversarial live-safety review) ────────────────
  //  1. bookId ABSENT → the legacy book for taskData.mode (the existing out-of-band schedules keep
  //     working unmodified).
  //  2. bookId present but UNRESOLVABLE (deleted book, foreign id) → SKIP the fire with an ERROR —
  //     never fall back to the legacy book: a stale per-book LIVE schedule falling through would
  //     silently trade the WRONG Schwab account. loadBook is keyed (user_sub, book_id) — dispatch
  //     runs under system identity where RLS does not scope reads, so that WHERE is the only wall.
  //  3. bookId present while the flag is OFF → hard-skip as a logged no-op unless it IS the legacy
  //     book: flag-off (the PR4 rollback path) must never turn N per-book schedules into N duplicate
  //     dispatchers of the one real account (cross-minute duplicate orders Schwab cannot dedupe).
  const rawBookId = td.bookId ? String(td.bookId) : null;
  let book: TradingBook;
  if (!rawBookId) {
    await ensureLegacyBooks(ctx.pool, sub).catch(() => { /* mint is lazy-best-effort; legacyBook() needs no row */ });
    book = legacyBook(sub, mode);
  } else if (!multiAccountEnabled()) {
    if (rawBookId !== legacyBookId(sub, 'paper') && rawBookId !== legacyBookId(sub, 'live')) {
      logger.warn({ scheduleId: schedule.id, bookId: rawBookId }, 'TRADING_MULTI_ACCOUNT is off - per-book schedule hard-skipped (no fallback to the legacy book)');
      return { success: true, scheduleId: schedule.id };
    }
    mode = rawBookId === legacyBookId(sub, 'live') ? 'live' : 'paper';
    book = legacyBook(sub, mode);
  } else {
    const loaded = await loadBook(ctx.pool, sub, rawBookId).catch((err) => { logger.error({ err, scheduleId: schedule.id, bookId: rawBookId }, 'book load failed'); return null; });
    if (!loaded) {
      logger.error({ scheduleId: schedule.id, bookId: rawBookId, sub }, 'schedule carries an UNRESOLVABLE bookId - fire skipped, never falling back to the legacy book');
      return { success: true, scheduleId: schedule.id };
    }
    book = loaded;
    mode = book.kind;
  }
  // ADR-095: one DB read per fire — THIS BOOK's applied Strategy Library override (null = env
  // defaults; ADR-134 PR2 re-keyed actives per (user, book), so each book runs its own strategy).
  // A read failure must NEVER stop the fire; it just means env behavior this round.
  const override = await getActiveOverride(ctx.pool, sub, book.bookId)
    .catch((e) => { logger.warn({ err: e, scheduleId: schedule.id }, 'config-override read failed — env defaults in effect this fire'); return null; });
  // Universe precedence: an applied strategy's EXPLICIT universe > the schedule pin > DEFAULT_UNIVERSE.
  // An applied strategy with universe [] deliberately tracks the default (the 2026-07-13 pin lesson).
  // A blend scans the UNION of its components' universes (breakdown exits need bars for anything held).
  const universe = override && override.config.kind === 'blend'
    ? blendUnionUniverse(override.config.components ?? [])
    : override && override.config.universe.length
      ? override.config.universe.map((s) => String(s).toUpperCase())
      : Array.isArray(td.universe) && td.universe.length
        ? (td.universe as unknown[]).map((s) => String(s).toUpperCase())
        : DEFAULT_UNIVERSE;
  // Autonomous LIVE trading requires the DOUBLE opt-in (TRADING_LIVE_ENABLED + TRADING_AUTOPILOT_LIVE).
  // Without both, a live schedule is refused so it can never place a real order by accident.
  if (mode === 'live' && !autopilotLiveAllowed()) {
    return { success: false, scheduleId: schedule.id, error: 'autopilot live is disabled; set TRADING_LIVE_ENABLED=true AND TRADING_AUTOPILOT_LIVE=true to arm it' };
  }

  // The scan reads Alpaca market data (batched bars) for BOTH books; execution routes to this book's
  // broker (Schwab for live). getBrokerReader avoids the live-enable gate for this config check.
  if (!marketDataConfigured() || !getBrokerReader(mode, sub).configured()) {
    logger.info({ scheduleId: schedule.id, mode }, 'autopilot skipped — market-data or broker keys not configured');
    return { success: true, scheduleId: schedule.id };
  }
  // Reconcile any still-open orders from prior fires BEFORE deciding — turns submit-time
  // pending_new into the real filled/terminal state so the ledger (and the position/holdings
  // read below) reflect venue reality. Runs even when the market is closed: the venue fills
  // during hours, we just catch the ledger up here. Failure here must not block the run.
  await reconcileOpenOrders(ctx.pool, sub, book).catch((e) => logger.warn({ err: e, scheduleId: schedule.id }, 'autopilot order reconcile failed'));
  // Trade in regular OR (when TRADING_EXTENDED_HOURS is on) pre/post-market — ext-hours orders
  // route as marketable limits via placeDecisionOrder. Closed/weekend/holiday → skip.
  // Log the CAUSE, not a catch-all. "market closed" used to cover three unrelated states — a blind
  // clock (2026-07-16: the desk went dark 28 min, silently) and an engaged TRADING_HALT both left a
  // funded live book with NO protective exits while the watchdog read the line as a healthy heartbeat.
  const st = await tradableSessionDetailed();
  if (!st.session) {
    // ASCII-only in these strings: the watchdog (PowerShell 5.1) greps them and would mojibake an em dash.
    const why = st.reason === 'halt'
      ? 'autopilot skipped - TRADING_HALT kill switch engaged (NO entries AND NO protective exits while set)'
      : st.reason === 'ext-disabled'
        ? 'autopilot skipped - extended hours disabled (TRADING_EXTENDED_HOURS=false)'
        : st.blind
          ? 'autopilot skipped - session UNKNOWN (venue clock unreachable), standing down; NO protective exits until this clears'
          : 'autopilot skipped — market closed (no tradable session)';
    logger.info({ scheduleId: schedule.id, reason: st.reason, blind: st.blind }, why);
    return { success: true, scheduleId: schedule.id };
  }
  const session = st.session;
  // LIVE safety default: trade only the REGULAR session (9:30–16:00 ET), skipping thin, wide-spread
  // pre/post-market on real money — so the first live fills land at the watched open, not 4am. Opt into
  // extended-hours live with TRADING_AUTOPILOT_LIVE_EXT=true. Paper is unaffected (keeps ext-hours).
  if (mode === 'live' && session !== 'regular' && String(process.env.TRADING_AUTOPILOT_LIVE_EXT ?? 'false').toLowerCase() !== 'true') {
    logger.info({ scheduleId: schedule.id, session }, 'live autopilot skipped — regular-hours-only (set TRADING_AUTOPILOT_LIVE_EXT=true to allow pre/post)');
    return { success: true, scheduleId: schedule.id };
  }

  try {
    const summary = await runAutopilot(ctx, sub, book, universe, session, override);
    await logRunTicket(ctx, sub, mode, summary).catch((e) => logger.warn({ err: e }, 'autopilot ticket log failed'));
    logger.info({ scheduleId: schedule.id, session, ...summary, orders: summary.orders.length }, 'autopilot run complete');
    return { success: true, scheduleId: schedule.id, taskId: `autopilot-${schedule.id}` };
  } catch (e) {
    logger.error({ err: e, scheduleId: schedule.id }, 'autopilot run failed');
    return { success: false, scheduleId: schedule.id, error: (e as Error).message };
  }
}
