/**
 * Trading autopilot — gravity-ranked SLEEVE ROTATION (a leg of the dispatch loop).
 *
 * Carved VERBATIM out of trading-schedule-dispatch.ts (its CHANGE LOG SEQ 1-19 hold the history of
 * every function here: SEQ 9 rankUniverse's export for the backtest, SEQ 10 the ADR-095 override
 * threading, SEQ 13 the entry guards, SEQ 14 rotateBlendSleeve, SEQ 16 the gate-block ledger, SEQ 17
 * venue-routed sizing, SEQ 19 the sector-tilt knob). Zero behavior change: ranking math, the 6s settle
 * wait, the real-cash re-read and every rationale string are byte-identical to the monolith. The
 * logger keeps module 'trading-schedule-dispatch' on purpose — the log stream is the watchdog/operator
 * contract, and the file split must be invisible to it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — decomposition of trading-schedule-dispatch.ts (890 code lines) along its section seams: rotationConfig, rankUniverse, buildEntryGuard (private), rotateSleeve and rotateBlendSleeve move here unchanged (rotationConfig/rankUniverse keep their exported names for the lab routes, lab sim and rotation backtest through the entry barrel). Env names unchanged: TRADING_SLEEVE_ROTATION, TRADING_ROTATION_EVERY_DAYS, TRADING_ROTATION_TOPN, TRADING_ROTATION_RANK, TRADING_ROTATION_WEIGHTING, TRADING_ROTATION_EXT_HOURS. rotateSleeve and rotateBlendSleeve remain over the 50-line function guideline exactly as in the monolith (pre-existing; a body change would be a behavior change). Golden-plan guard: tests/unit/trading-dispatch-golden-plan.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Comment-only: rotationConfig's section banner opened with `/*` so its @description/@param/@returns tags were invisible to JSDoc tooling; opened as `/**`. No code line changed.
 *
 * @module trading-dispatch-rotation
 */

import type { AppContext } from './composition-root';
import {
  getBrokerAdapter, latestPrice, symbolBlocklist, deriveMasses, displacement, barsBatch, barsBatchSince, scoreSymbol, ensemble,
  maxGapDownPct, priorSessionClose, etSessionDate, selectEntryTargets, entryBlock, sectorTiltConfig, applySectorTilt,
  type Position, type TradingMode, type TradingBook, type BrokerAccount, type RiskPolicy, type EntryGuardInput, type EntryBlock,
} from '@/features/trading';
import { legacyBook } from './trading-books-store';
import { recordGateBlocks } from './trading-gate-block-store';
import { overlayRotationKnobs, type ConfigOverrideRow } from './trading-config-overrides';
import { blendRotationPlan } from './trading-blend';
import { placeManaged, bookBinding, capAccount, type RunOrder } from './trading-dispatch-rail';
import { coreConfig, sizingPrice } from './trading-dispatch-core';
import { createChildLogger } from '@/shared/logger';

// Module name kept as the monolith's: the log stream is the watchdog/operator contract.
const logger = createChildLogger({ module: 'trading-schedule-dispatch' });

/** ── Gravity-ranked sleeve rotation (TRADING_SLEEVE_ROTATION, default OFF) ──────────────────────────
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
 *    one rotation per day, so it rotates at the first eligible fire — possibly pre-market).
 * @description Parse the rotation knobs from env, then let an applied ADR-095 override own them.
 * @param override - The applied Strategy Library override, when one is active.
 * @returns The effective rotation configuration for this fire. */
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

/** @description Rank the ex-core universe by the configured method on the same daily closes. Returns
 *  [{sym, score}] for every eligible name (closes.length >= 60, non-core). Higher score = stronger.
 *   - momentum: 20-day return (needs >= 21 closes).
 *   - gravity:  displacement pull (the original behavior).
 *   - ensemble: the multi-algo ensemble vote score.
 *   - blend:    50/50 cross-sectional z-score of momentum + gravity (names missing either are dropped).
 * @param rank - The ranking method (gravity | momentum | ensemble | blend).
 * @param bars - UPPERCASE symbol → ascending daily closes.
 * @param coreSet - Beta-core symbols, excluded from the ranking.
 * @returns Every eligible name with its score (unsorted; the caller orders it). */
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
 * @param override - The applied Strategy Library override (ADR-095), when one is active.
 * @param exiting - UPPERCASE symbols the protective leg is selling THIS fire (never re-bought).
 * @param noBuy - The earnings blackout set (empty unless armed).
 * @returns Resolves when the rebalance has been placed (sells, trims, settle, buys).
 */
export async function rotateSleeve(
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
 * @param exiting - UPPERCASE symbols the protective leg is selling THIS fire (never re-bought).
 * @param noBuy - The earnings blackout set (empty unless armed).
 * @returns Resolves when the merged-plan rebalance has been placed.
 */
export async function rotateBlendSleeve(
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
