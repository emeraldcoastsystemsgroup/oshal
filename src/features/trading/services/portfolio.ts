/**
 * Portfolio money-manager — the "how to manage the money" layer (ADR-052/053).
 *
 * The technical autopilot and the research brain both produce per-name BUY/SELL calls. This module
 * sits ABOVE them and turns calls into a managed book: it sizes entries against the account, enforces
 * diversification + exposure limits, runs protective exits (stop-loss / take-profit), and trips a
 * daily-loss circuit breaker. Pure functions of (account, positions, policy) — no I/O, no LLM — so
 * it is deterministic and unit-testable; the dispatch layer feeds it broker state and acts on its output.
 *
 * Risk posture (TRADING_RISK_POSTURE = conservative|balanced|aggressive, default balanced) sets the
 * dials. All percentages are of account EQUITY. Paper-only stays enforced upstream; this layer is the
 * same whether paper or (future, gated) live.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — risk-posture policies, sector map for the default universe, conviction-scaled sizing with per-name/per-sector/total-deployed/max-positions caps + daily-loss halt, and stop-loss/take-profit exit detection.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add the `active` high-turnover/downside-first posture (32 names × 3%, 8% take-profit, 5% backstop stop, 3% daily halt) + trailing-stop dials (trailArmPct/trailGivebackPct) on every posture, and the pure trailingExits + nextPeaks (high-water-mark) functions. Trailing protects winners on a reversal without micro-churn; pairs with the dispatch short-timeframe breakdown exit for news-crash downside.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | TRADING_TAKE_PROFIT_PCT env override on riskPolicy (both books). From the 2026-07-10 config sweep: tp 8→25 on active was the only sleeve-level change whose edge persisted across all backtest windows (+2.5pts return at zero drawdown cost, ~120 fewer trades); the hardcoded posture presets had no dial to deploy it.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SECTOR entries for the 34 up-and-comer names (universe 106 → 140): growth software/semis under 'tech', fintech under 'financials', new 'industrial' and 'ai-power' buckets so defense/space and datacenter-power crowding get their own per-sector caps instead of riding under oil-'energy' headroom.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | symbolBlocklist (TRADING_SYMBOL_BLOCKLIST): operator standing exclusions the engine can never buy — "drop MRNA" said repeatedly had no enforceable home; the engine re-bought whatever ranked. Exits deliberately unaffected.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | PolicyOverride param on riskPolicy (ADR-095 Strategy Library apply-to-profile): an applied lab strategy's posture beats both env postures, and its takeProfitPct (including an explicit null = posture default) beats TRADING_TAKE_PROFIT_PCT. No override → behavior unchanged.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | SECTOR entries for the 19 regime-reweight names (universe 140 → 159): new 'materials' bucket (mining/chemicals/steel get their own cap headroom, not riding under 'consumer' industrials) and new 'storage' bucket for the memory/NAND pool — MU and SKHY MOVE into it from 'tech'/'other' so storage crowding is capped as one trade, not hidden under tech headroom.
 *
 * @module portfolio
 */

import type { BrokerAccount, Position } from './broker-adapter';

/** How aggressively the book is run. */
export type RiskPosture = 'conservative' | 'balanced' | 'aggressive' | 'active';

/** The dials a posture sets. Cap *Pct values are percent of account equity; the trail/stop/take
 *  values are percent moves of the position itself. */
export interface RiskPolicy {
  posture: RiskPosture;
  maxPerNamePct: number;     // cap on one name's market value
  maxSectorPct: number;      // cap on one sector's combined market value
  maxDeployedPct: number;    // cap on total invested (the rest stays cash)
  maxPositions: number;      // cap on simultaneous open names
  stopLossPct: number;       // exit a name down this much from entry (the hard backstop)
  takeProfitPct: number;     // exit a name up this much from entry
  dailyLossHaltPct: number;  // halt NEW buys once the book is down this much on the day
  trailArmPct: number;       // a winner ARMS its trailing stop once up this much from entry
  trailGivebackPct: number;  // once armed, exit if price falls this much from its peak (locks gains)
  maxDrawdownPct: number;    // CIRCUIT BREAKER: halt NEW buys while account equity is this far below its high-water mark
}

/**
 * @description Account circuit breaker: true once equity has fallen maxDrawdownPct below its
 * high-water mark — the bot stops opening new positions (exits still run) until equity recovers.
 * Protects against a sustained bleed the per-trade stops + daily halt don't cover.
 * @param equity - Current account equity.
 * @param highWaterMark - The peak equity seen so far.
 * @param policy - Active risk policy.
 * @returns Whether new entries should be halted.
 */
export function drawdownHaltTriggered(equity: number, highWaterMark: number, policy: RiskPolicy): boolean {
  if (!(highWaterMark > 0)) return false;
  return (highWaterMark - equity) / highWaterMark >= policy.maxDrawdownPct / 100;
}

/**
 * The four postures. Balanced is the code default; the deployed autopilot runs `active`.
 *
 * `active` is the high-turnover, downside-first profile (the operator's "lots of trades, minimize
 * the downside, don't bleed micro-losses" mandate): MANY small positions (32 names × 3% cap) so no
 * single name can hurt the book and more names are in play, a take-profit (8%) that locks gains and
 * frees the slot so capital ROTATES into the next-best name — rotation is what produces the trade
 * volume — a TRAILING stop (arms at +5% gain, exits on a 3% giveback from the peak) that protects
 * winners, and a 5% hard stop as a BACKSTOP (not the primary tool: the short-timeframe breakdown
 * exit in the dispatch catches a news-driven intraday crash earlier, and the moderate 5% stop keeps
 * normal noise from whipsawing the book into micro-losses). Backed by a tight 3% daily-loss halt.
 * It is NOT `aggressive` (which WIDENS the stop to 15% — more downside). The higher-timeframe regime
 * gate (multi-timeframe.ts) still blocks buying into a falling trend.
 */
export const RISK_POLICIES: Record<RiskPosture, RiskPolicy> = {
  conservative: { posture: 'conservative', maxPerNamePct: 3, maxSectorPct: 12, maxDeployedPct: 30, maxPositions: 12, stopLossPct: 5, takeProfitPct: 12, dailyLossHaltPct: 2, trailArmPct: 6, trailGivebackPct: 3, maxDrawdownPct: 8 },
  balanced: { posture: 'balanced', maxPerNamePct: 5, maxSectorPct: 22, maxDeployedPct: 60, maxPositions: 16, stopLossPct: 9, takeProfitPct: 20, dailyLossHaltPct: 4, trailArmPct: 8, trailGivebackPct: 4, maxDrawdownPct: 12 },
  aggressive: { posture: 'aggressive', maxPerNamePct: 10, maxSectorPct: 40, maxDeployedPct: 95, maxPositions: 12, stopLossPct: 15, takeProfitPct: 35, dailyLossHaltPct: 7, trailArmPct: 12, trailGivebackPct: 7, maxDrawdownPct: 25 },
  active: { posture: 'active', maxPerNamePct: 3, maxSectorPct: 25, maxDeployedPct: 85, maxPositions: 32, stopLossPct: 5, takeProfitPct: 8, dailyLossHaltPct: 3, trailArmPct: 5, trailGivebackPct: 3, maxDrawdownPct: 10 },
};

/** A per-run policy override (ADR-095 profile overrides): posture always wins over the env
 *  postures when set; takeProfitPct wins over env TRADING_TAKE_PROFIT_PCT when PRESENT — a null
 *  value deliberately means "the posture's own take-profit" (the armed 07-10 rotation config
 *  left tp unset, so an applied strategy must be able to express that against a set env var). */
export interface PolicyOverride { posture?: RiskPosture; takeProfitPct?: number | null }

/**
 * @description The active risk policy. Base posture comes from TRADING_RISK_POSTURE (default
 * balanced); the LIVE book can override via TRADING_RISK_POSTURE_LIVE. The split exists because the
 * two books have different jobs: paper is the full-size reference book and runs the operator's
 * downside-first mandate (the `active` posture — "don't lose 7% in a day"), while the small capped
 * live book may need a wider per-name budget just to afford whole shares. 2026-07-07 incident:
 * a single global `aggressive` posture put a 15% hard stop on the paper book, so an -8.7% one-name
 * slide never triggered the stop the operator expected.
 * An applied Strategy Library override (ADR-095) beats BOTH env postures — a profile that has been
 * switched onto a saved strategy runs that strategy's posture on both books, like every historical
 * env-level config change did.
 * @param mode - Which book is asking; 'live' consults TRADING_RISK_POSTURE_LIVE first.
 * @param override - Optional applied-strategy override (posture / take-profit).
 * @returns The risk policy for that book.
 */
export function riskPolicy(mode?: 'paper' | 'live', override?: PolicyOverride): RiskPolicy {
  const base = String(process.env.TRADING_RISK_POSTURE || 'balanced').toLowerCase();
  const live = String(process.env.TRADING_RISK_POSTURE_LIVE || '').toLowerCase();
  const p = override?.posture && override.posture in RISK_POLICIES ? override.posture : (mode === 'live' && live ? live : base);
  const pol = RISK_POLICIES[(p as RiskPosture)] ?? RISK_POLICIES.balanced;
  if (override && override.takeProfitPct !== undefined) {
    const t = Number(override.takeProfitPct);
    return override.takeProfitPct != null && Number.isFinite(t) && t > 0 ? { ...pol, takeProfitPct: Math.min(95, t) } : pol;
  }
  // Take-profit override (2026-07-10 config sweep): widening tp 8→25 on the active posture was the
  // sleeve-level change whose edge persisted across every backtest window — the incumbent's
  // 577-trade / 37%-win profile was churn from clipping winners at +8% in a trending tape.
  // Applies to BOTH books; the 07-08 operator rule keeps live posture identical to paper.
  const tp = Number(process.env.TRADING_TAKE_PROFIT_PCT);
  return Number.isFinite(tp) && tp > 0 ? { ...pol, takeProfitPct: Math.min(95, tp) } : pol;
}

/**
 * @description Operator symbol blocklist (TRADING_SYMBOL_BLOCKLIST, comma-separated): names the
 * engine must NEVER buy on its own — scan entries, rotation targets, and pop-catcher all consult
 * it; exits are deliberately unaffected (a held blocked name still gets protected, and the
 * rotation drops it from targets, which sells it). Born 2026-07-11: the operator said "drop
 * MRNA" repeatedly and the platform had no mechanism to make a standing exclusion stick — the
 * engine re-bought any name that ranked. This converts the operator's call into an enforced rule.
 * @returns Upper-cased set of blocked symbols (empty set when unset).
 */
export function symbolBlocklist(): Set<string> {
  return new Set(String(process.env.TRADING_SYMBOL_BLOCKLIST || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
}

/** Symbol → sector for the default universe (drives the per-sector cap). Unknown → 'other'. */
export const SECTOR: Record<string, string> = Object.fromEntries([
  ...['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'AMD', 'INTC', 'CSCO', 'QCOM', 'TXN', 'IBM', 'NOW', 'INTU', 'AMAT', 'PANW', 'SNOW', 'SHOP', 'UBER', 'PLTR', 'VRSN'].map((s) => [s, 'tech']),
  ...['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'SCHW', 'BLK', 'AXP', 'SPGI', 'BX', 'V', 'MA', 'PYPL', 'COF', 'USB', 'PNC', 'TFC', 'CB', 'MMC', 'MCO', 'AB'].map((s) => [s, 'financials']),
  ...['WMT', 'COST', 'PG', 'KO', 'PEP', 'MCD', 'DIS', 'NKE', 'HD', 'LOW', 'SBUX', 'TGT', 'CAT', 'GE', 'HON', 'UPS', 'BA', 'MMM', 'CL', 'PM', 'KHC'].map((s) => [s, 'consumer']),
  ...['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'PSX', 'MPC', 'VLO', 'OXY', 'WMB', 'KMI', 'HAL', 'DVN', 'HES', 'BKR'].map((s) => [s, 'energy']),
  ...['JNJ', 'LLY', 'PFE', 'MRK', 'ABBV', 'TMO', 'ABT', 'DHR', 'BMY', 'AMGN', 'GILD', 'CVS', 'UNH', 'MDT', 'ISRG', 'VRTX', 'REGN', 'ZTS', 'BIIB', 'MRNA', 'TEM'].map((s) => [s, 'pharma']),
  // Regime-change reweight (2026-07-26, universe 140 → 159). Materials/mining get their OWN
  // bucket (a copper/gold/lithium crowding is one trade — it must not ride under industrial or
  // consumer headroom). Storage = the memory/NAND pool; MU + SKHY MOVE here from 'tech'/'other'
  // because HBM/DRAM/NAND names crash together — the cap has to see them as one sector.
  ...['FCX', 'NEM', 'LIN', 'APD', 'SCCO', 'NUE', 'STLD', 'ALB', 'MP'].map((s) => [s, 'materials']),
  ...['MU', 'SKHY', 'STX', 'WDC', 'SNDK', 'PSTG', 'NTAP'].map((s) => [s, 'storage']),
  // Biotech/genomics ETFs get their OWN sector bucket so the per-sector cap bounds the combined
  // fund exposure separately from single-name pharma (they overlap heavily with each other).
  ...['XBI', 'IBB', 'FBT', 'ARKG', 'GNOM'].map((s) => [s, 'biotech-etf']),
  // Up-and-comers (2026-07-10 universe expansion to 140). Growth software/semis join 'tech' (the
  // sector cap bounds exposure, not name count); AI-datacenter power gets its own bucket so a
  // power-trade crowding doesn't ride under 'energy' (oil) headroom.
  ...['ARM', 'MRVL', 'TSM', 'ASML', 'LRCX', 'KLAC', 'MPWR', 'ANET', 'SMCI', 'CRWD', 'DDOG', 'NET', 'MDB', 'ZS', 'APP'].map((s) => [s, 'tech']),
  ...['COIN', 'HOOD', 'SOFI', 'NU', 'AFRM'].map((s) => [s, 'financials']),
  ...['DASH', 'ABNB', 'RBLX', 'CVNA', 'DUOL'].map((s) => [s, 'consumer']),
  ...['AXON', 'RKLB', 'PWR', 'ETN', 'VRT'].map((s) => [s, 'industrial']),
  ...['VST', 'CEG', 'GEV', 'NRG'].map((s) => [s, 'ai-power']),
]);

/** @description The sector for a symbol (default universe), or 'other'. */
export function sectorOf(symbol: string): string { return SECTOR[symbol.toUpperCase()] || 'other'; }

/** A protective exit the manager wants to take right now. */
export interface ExitOrder { symbol: string; qty: number; reason: 'stop_loss' | 'take_profit' | 'trailing_stop' | 'rotation' | 'cap_trim' | 'ext_dip'; pnlPct: number; }

/**
 * @description Extended-hours DEFENSIVE exits (the operator's off-hours doctrine, 2026-07-07:
 * "we are not trying to make money off-hours, we are trying to not lose it"): sell a held name
 * outright when its current price is at or below `dipPct` percent UNDER its last regular-session
 * close. No profit targets, no trailing math, no partial trims off-hours — a dip past the line is
 * a full protective exit. Backtested over every session night since inception (6 windows, 108
 * name-nights): +$461 vs holding to the next open, zero negative windows; caught the 07-07
 * pre-market AMD/MU crash for +$426. Pure — the dispatch supplies prior closes.
 * @param positions - Current open longs (need currentPrice).
 * @param priorClose - Symbol → last regular-session close (the dip anchor).
 * @param dipPct - Trigger: percent below the close (e.g. 0.5).
 * @returns Full-position exits for every name at/under the line.
 */
export function dipExits(positions: Position[], priorClose: Map<string, number>, dipPct: number): ExitOrder[] {
  const exits: ExitOrder[] = [];
  for (const p of positions) {
    if (!(p.qty > 0)) continue;
    const cur = p.currentPrice ?? 0;
    const ref = priorClose.get(p.symbol.toUpperCase()) ?? 0;
    if (!(cur > 0) || !(ref > 0)) continue;
    const offClosePct = ((cur - ref) / ref) * 100;
    if (offClosePct <= -Math.abs(dipPct) + 1e-9) { // epsilon: a print exactly ON the line triggers
      const cost = p.avgEntryPrice * p.qty;
      exits.push({ symbol: p.symbol, qty: p.qty, reason: 'ext_dip', pnlPct: cost > 0 ? (p.unrealizedPl / cost) * 100 : 0 });
    }
  }
  return exits;
}

/** A name's current directional strength (from the multi-timeframe scan), for rotation ranking. */
export interface NameStrength { score: number; action: 'buy' | 'sell' | 'hold'; }

/**
 * @description Protective exits across open longs: sell anything down past stop-loss or up past
 * take-profit. This is the standing "manage the money" loop, run every cycle before new entries.
 * @param positions - Current open positions.
 * @param policy - Active risk policy.
 * @returns The exits to place (whole-share sells).
 */
export function exitsToRun(positions: Position[], policy: RiskPolicy, stopMult = 1): ExitOrder[] {
  const exits: ExitOrder[] = [];
  for (const p of positions) {
    if (!(p.qty > 0)) continue; // v1 manages long book only
    const cost = p.avgEntryPrice * p.qty;
    if (!(cost > 0)) continue;
    const pnlPct = (p.unrealizedPl / cost) * 100;
    // stopMult widens the hard stop in thin sessions (pre/post) so a low-liquidity wick doesn't
    // whipsaw us out at a bad print — the "lost in extended hours" failure mode.
    if (pnlPct <= -policy.stopLossPct * stopMult) exits.push({ symbol: p.symbol, qty: p.qty, reason: 'stop_loss', pnlPct });
    else if (pnlPct >= policy.takeProfitPct) exits.push({ symbol: p.symbol, qty: p.qty, reason: 'take_profit', pnlPct });
  }
  return exits;
}

/**
 * @description Roll each open long's high-water-mark forward: the new peak is the max of its prior
 * peak and its current price; closed names drop out. Pure — the dispatch persists the returned map
 * so the trailing stop has a memory across fires.
 * @param positions - Current open positions (need currentPrice).
 * @param peaks - The peak price seen so far per symbol (from the store).
 * @returns The updated peak map (open longs only).
 */
export function nextPeaks(positions: Position[], peaks: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of positions) {
    if (!(p.qty > 0)) continue;
    const sym = p.symbol.toUpperCase();
    const cur = p.currentPrice ?? p.avgEntryPrice;
    const prior = peaks.get(sym) ?? p.avgEntryPrice;
    out.set(sym, Math.max(prior, cur, p.avgEntryPrice));
  }
  return out;
}

/**
 * @description Trailing-stop exits: a winner ARMS once it is up trailArmPct from entry, then is sold
 * if it gives back trailGivebackPct from its peak. Locks in gains on a reversal (the news-crash after
 * a run-up) while leaving room for normal wiggle — adds sell trades without micro-churn.
 * @param positions - Current open positions (need currentPrice + avgEntryPrice).
 * @param peaks - The rolled-forward peak per symbol (see nextPeaks).
 * @param policy - Active risk policy.
 * @returns The trailing exits to place (whole-share sells).
 */
export function trailingExits(positions: Position[], peaks: Map<string, number>, policy: RiskPolicy, givebackMult = 1): ExitOrder[] {
  const exits: ExitOrder[] = [];
  for (const p of positions) {
    if (!(p.qty > 0) || !(p.avgEntryPrice > 0)) continue;
    const cur = p.currentPrice ?? 0;
    if (!(cur > 0)) continue; // no live price → can't trail this fire
    const sym = p.symbol.toUpperCase();
    const peak = peaks.get(sym) ?? p.avgEntryPrice;
    const gainPct = ((cur - p.avgEntryPrice) / p.avgEntryPrice) * 100;
    const givebackPct = peak > 0 ? ((peak - cur) / peak) * 100 : 0;
    // Only armed (in profit past trailArmPct) winners trail — below that the hard stop governs.
    // givebackMult widens the trail in thin sessions so a wick doesn't book a winner early.
    if (gainPct >= policy.trailArmPct && givebackPct >= policy.trailGivebackPct * givebackMult) {
      exits.push({ symbol: p.symbol, qty: p.qty, reason: 'trailing_stop', pnlPct: gainPct });
    }
  }
  return exits;
}

/**
 * @description Cap-breach TRIMS: sell down any single name whose market value has grown past the
 * per-name cap (maxPerNamePct of equity) back to the cap. The caps were previously enforced only at
 * ENTRY (sizeEntry), so a name that pyramided (the pre-market working-order bug) or simply ran up could
 * sit well over its cap indefinitely — concentration risk the exits never addressed. Partial sell of
 * just the excess shares; leaves the capped core in place. Needs currentPrice to value + price the trim.
 * @param positions - Current open positions.
 * @param equity - Account equity (the cap base).
 * @param policy - Active risk policy.
 * @returns Partial-share trims for names over the per-name cap (empty when all within cap).
 */
export function rebalanceTrims(positions: Position[], equity: number, policy: RiskPolicy): ExitOrder[] {
  if (!(equity > 0)) return [];
  const cap = (policy.maxPerNamePct / 100) * equity;
  const trims: ExitOrder[] = [];
  for (const p of positions) {
    if (!(p.qty > 0)) continue;
    const price = p.currentPrice ?? p.avgEntryPrice;
    if (!(price > 0)) continue;
    const mktVal = p.marketValue > 0 ? p.marketValue : p.qty * price;
    if (mktVal <= cap) continue;
    const excessShares = Math.floor((mktVal - cap) / price);
    if (excessShares < 1) continue;
    const qty = Math.min(excessShares, p.qty - 1); // keep at least the capped core, never flatten via a trim
    if (qty < 1) continue;
    const cost = p.avgEntryPrice * p.qty;
    trims.push({ symbol: p.symbol, qty, reason: 'cap_trim', pnlPct: cost > 0 ? (p.unrealizedPl / cost) * 100 : 0 });
  }
  return trims;
}

/* ── relative-strength rotation: "coach the team" — bench the cold, start the hot ─────────────── */
const ROTATION_HOT = 0.30;     // a bench candidate must score at least this to rotate INTO
const ROTATION_COLD = 0.15;    // a held name below this strength is "cold" / benchable
const ROTATION_MARGIN = 0.25;  // the hot hand must beat the cold starter by this much (anti-churn)

/**
 * @description Relative-strength rotation. Holds the hottest roster: when a held name has gone COLD
 * (its multi-timeframe strength fell below ROTATION_COLD — even a usual blue-chip "starter") AND a
 * meaningfully hotter name is sitting on the bench (an un-held regime-approved buy scoring ≥ ROTATION_HOT
 * and beating the cold name by ROTATION_MARGIN), bench the cold name to free its capital. The caller's
 * entry step then starts the hot name in the freed slot. Coldest benched first; churn-capped per fire.
 * This is what moves the money to the hot hand instead of riding a cold starter down to its stop.
 * @param positions - Current open positions.
 * @param strength - Per-symbol current strength (score + action) from the scan.
 * @param policy - Active risk policy (maxPositions bounds the per-fire swap count).
 * @returns The cold held names to bench now (reason 'rotation').
 */
export function rotationBenches(positions: Position[], strength: Map<string, NameStrength>, policy: RiskPolicy): ExitOrder[] {
  const held = positions.filter((p) => p.qty > 0);
  if (!held.length) return [];
  const heldSyms = new Set(held.map((p) => p.symbol.toUpperCase()));

  // Hottest available bench (regime-approved buys we don't already hold), best score first.
  const candidates = [...strength.entries()]
    .filter(([sym, s]) => s.action === 'buy' && !heldSyms.has(sym))
    .map(([, s]) => s.score)
    .sort((a, b) => b - a);
  const bestAvail = candidates[0] ?? -Infinity;
  if (bestAvail < ROTATION_HOT) return []; // nobody hot enough on the bench to swap anyone for

  // Cold held names that a much-hotter candidate clearly beats, coldest first.
  const cold = held
    .map((p) => ({ p, score: strength.get(p.symbol.toUpperCase())?.score ?? -Infinity }))
    .filter((x) => x.score < ROTATION_COLD && bestAvail - x.score >= ROTATION_MARGIN)
    .sort((a, b) => a.score - b.score);

  const maxSwaps = Math.max(1, Math.floor(policy.maxPositions / 4)); // bound churn per fire
  const n = Math.min(cold.length, candidates.length, maxSwaps);
  return cold.slice(0, n).map((x) => {
    const cost = x.p.avgEntryPrice * x.p.qty;
    return { symbol: x.p.symbol, qty: x.p.qty, reason: 'rotation' as const, pnlPct: cost > 0 ? (x.p.unrealizedPl / cost) * 100 : 0 };
  });
}

/** The result of sizing a proposed entry. qty 0 + a `blocked` reason = the manager declined it. */
export interface SizingResult { qty: number; notional: number; blocked?: string; }

/**
 * @description Size a proposed BUY against the book and the risk policy. Position size scales with
 * conviction up to the per-name cap, then is trimmed to whatever room the sector cap, total-deployed
 * cap, max-positions cap, and available cash allow. Returns qty 0 with a reason when a limit blocks it.
 * @param symbol - Ticker to buy.
 * @param price - Reference price per share.
 * @param confidence - Decision confidence (0..1) — scales the target size.
 * @param account - Broker account snapshot (equity + cash).
 * @param positions - Current open positions (for caps + dedup).
 * @param policy - Active risk policy.
 * @returns The whole-share quantity to buy (0 if blocked) + the dollar notional.
 */
export function sizeEntry(
  symbol: string, price: number, confidence: number,
  account: BrokerAccount, positions: Position[], policy: RiskPolicy, volPct?: number,
): SizingResult {
  const sym = symbol.toUpperCase();
  const equity = account.equity > 0 ? account.equity : account.cash;
  if (!(price > 0) || !(equity > 0)) return { qty: 0, notional: 0, blocked: 'no price/equity' };
  if (positions.some((p) => p.symbol.toUpperCase() === sym && p.qty > 0)) return { qty: 0, notional: 0, blocked: 'already holding' };
  if (positions.filter((p) => p.qty > 0).length >= policy.maxPositions) return { qty: 0, notional: 0, blocked: `max positions (${policy.maxPositions})` };

  // Daily-loss circuit breaker: halt new buys when the open book is down past the threshold.
  const openPnl = positions.reduce((s, p) => s + p.unrealizedPl, 0);
  if (openPnl < -(policy.dailyLossHaltPct / 100) * equity) return { qty: 0, notional: 0, blocked: 'daily-loss halt' };

  const deployed = positions.reduce((s, p) => s + Math.max(0, p.marketValue), 0);
  const sector = sectorOf(sym);
  const sectorDeployed = positions.filter((p) => sectorOf(p.symbol) === sector).reduce((s, p) => s + Math.max(0, p.marketValue), 0);

  // VOLATILITY-NORMALIZED per-name cap: at an equal $ cap, a volatile name loses far more than a calm
  // one on the same % move (the win/loss SKEW — one MU-type loss erasing many small wins). Scale the
  // per-name cap DOWN by the name's recent daily volatility vs a baseline, so every position carries
  // similar downside $ risk. Only ever reduces (clamp ≤ 1); floor at 25% so a wild name still trades small.
  const baseVol = Number(process.env.TRADING_BASELINE_VOL_PCT || 2);
  const volScale = volPct && volPct > 0 ? Math.max(0.25, Math.min(1, baseVol / volPct)) : 1;
  const perNameRoom = (policy.maxPerNamePct / 100) * equity * volScale;
  const sectorRoom = (policy.maxSectorPct / 100) * equity - sectorDeployed;
  const totalRoom = (policy.maxDeployedPct / 100) * equity - deployed;
  const cashRoom = Math.max(0, account.cash);

  // Target scales with conviction, capped by the tightest constraint.
  const target = perNameRoom * Math.max(0.2, Math.min(1, confidence));
  const notionalCap = Math.min(target, sectorRoom, totalRoom, cashRoom);
  if (notionalCap <= price) {
    const why = sectorRoom <= price ? `sector cap (${policy.maxSectorPct}%)`
      : totalRoom <= price ? `deployed cap (${policy.maxDeployedPct}%)`
      : cashRoom <= price ? 'insufficient cash' : 'below 1 share';
    return { qty: 0, notional: 0, blocked: why };
  }
  const qty = Math.floor(notionalCap / price);
  return { qty, notional: qty * price };
}
