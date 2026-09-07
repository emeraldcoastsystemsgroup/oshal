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
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | DECOMPOSITION (zero behavior change) — the 890-code-line monolith is carved along its own section seams into four kernel legs: trading-dispatch-world-gate.ts (world-sentiment gate + earnings blackout), trading-dispatch-rail.ts (bookBinding, persistDecision/placeManaged, loadInFlight, the decision mappers, capAccount), trading-dispatch-core.ts (coreConfig/coreTradePlan/sizingPrice/ensureCore) and trading-dispatch-rotation.ts (rotationConfig/rankUniverse/rotateSleeve/rotateBlendSleeve), plus trading-dispatch-exits-entries.ts (computeExits/placeEntries and the 2a-pop block as placePopCatches). This entry keeps runAutopilot, freeStaleSells, logRunTicket, dispatchTradingSchedule and the ScheduleService handle byte-identical, and re-exports the pre-split public surface (loadInFlight/InFlight, coreConfig/CoreConfig, coreTradePlan/CoreTrade, sizingPrice, ensureCore, rotationConfig, rankUniverse) so every importer compiles unchanged. History for the moved code stays in SEQ 1-19 above. Every leg logs as module 'trading-schedule-dispatch' (the watchdog contract). Guards: tests/unit/trading-dispatch-golden-plan.spec.ts (real-Postgres golden plan, written against the unsplit file), tests/unit/trading-dispatch-decomposition.spec.ts.
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | The autopilot's legacy-book branches resolve through loadLegacyBook (the DB row, which carries the account binding) instead of the pure constructor. Required by the Schwab account-pin retirement: an UNBOUND reader now refuses rather than guessing among the login's enumerated accounts, and this fire drives protective exits, so an unbound legacy live book here would have silenced them.
 *
 * @module trading-schedule-dispatch
 */

import type { AppContext } from './composition-root';
import type { ScheduleRecord, ScheduleDispatchResult, ScheduleService } from '@/features/scheduling';
import {
  getBrokerAdapter, getBrokerReader, marketDataConfigured, tradableSessionDetailed, multiTimeframeScan, DEFAULT_UNIVERSE,
  isShortTermBreakdown, riskPolicy, rotationBenches, etSessionDate,
  type TradingMode, type TradingBook, type BrokerAccount, type NameStrength,
} from '@/features/trading';
import { ensureTradingSchema } from './trading-engine';
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
import { legacyBook, legacyBookId, loadBook, ensureLegacyBooks, multiAccountEnabled, loadLegacyBook } from './trading-books-store';
import { reconcileOpenOrders } from './trading-reconcile';
import { ensureRotationStateTable, loadLastRotated, saveLastRotated } from './trading-rotation-store';
import { recordDailyEquity } from './trading-daily-equity-store';
import { evaluateEquityGuard } from './trading-equity-guard';
import { loadAlgoMasses } from './trading-signal-weights';
import { loadStrategyParams } from './trading-strategy-params';
import { getActiveOverride, policyOverrideOf, type ConfigOverrideRow } from './trading-config-overrides';
import { blendUnionUniverse } from './trading-blend';
import { createWorldIntelligenceService } from '@/features/world-data';
// The four legs (SEQ 20). Local bindings for what this file still calls; the barrel below re-exports
// the pre-split public surface from the same modules.
import { bookBinding, placeManaged, IN_FLIGHT_STATUSES, loadInFlight, exitDecision, scanDecision, breakdownDecision, capAccount, type RunOrder, type RunSummary } from './trading-dispatch-rail';
import { earningsBlackout, EARNINGS_BLACKOUT_DAYS } from './trading-dispatch-world-gate';
import { coreConfig, ensureCore } from './trading-dispatch-core';
import { rotationConfig, rotateSleeve, rotateBlendSleeve } from './trading-dispatch-rotation';
import { computeExits, placeEntries, placePopCatches } from './trading-dispatch-exits-entries';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-schedule-dispatch' });

/** Default fire cadence: every 5 minutes, all day; the run self-skips when the market is closed. */
export const AUTOPILOT_CRON_DEFAULT = '*/5 * * * *';

/* ── Pre-split public surface (byte-for-byte import compatibility for schedule-runtime, the research
 *    dispatch, the strategy-lab sim, the rotation backtest, the unit specs and the store's src-routes) ── */
export { loadInFlight, type InFlight } from './trading-dispatch-rail';
export { coreConfig, coreTradePlan, sizingPrice, ensureCore, type CoreConfig, type CoreTrade } from './trading-dispatch-core';
export { rotationConfig, rankUniverse } from './trading-dispatch-rotation';

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

  // 2a-pop) POP-CATCHER (opt-in, off by default) — the monolith's block, moved verbatim to
  //   placePopCatches (trading-dispatch-exits-entries.ts); nothing reordered, TRADING_POP_CATCHER read per fire.
  await placePopCatches(ctx, sub, book, scan, positions, account, coreSet, exiting, coreSpent, orders, errors);

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
    await ensureLegacyBooks(ctx.pool, sub).catch(() => { /* mint is lazy-best-effort; the row is what carries the binding */ });
    // The legacy book must come from its DB ROW: the row carries the account binding, and an unbound
    // Schwab reader now REFUSES rather than guessing which enumerated account to use. A decrypt
    // failure propagates deliberately — degrading to an unbound book is the one shape that refusal
    // cannot interpret, and this fire drives protective exits.
    book = await loadLegacyBook(ctx.pool, sub, mode);
  } else if (!multiAccountEnabled()) {
    if (rawBookId !== legacyBookId(sub, 'paper') && rawBookId !== legacyBookId(sub, 'live')) {
      logger.warn({ scheduleId: schedule.id, bookId: rawBookId }, 'TRADING_MULTI_ACCOUNT is off - per-book schedule hard-skipped (no fallback to the legacy book)');
      return { success: true, scheduleId: schedule.id };
    }
    mode = rawBookId === legacyBookId(sub, 'live') ? 'live' : 'paper';
    book = await loadLegacyBook(ctx.pool, sub, mode);
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
