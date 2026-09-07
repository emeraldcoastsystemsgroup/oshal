/**
 * Trading autopilot — the BETA CORE (core-satellite) leg of the dispatch loop.
 *
 * Carved VERBATIM out of trading-schedule-dispatch.ts (its CHANGE LOG SEQ 1-19 hold the history of
 * every function here: SEQ 8 per-symbol core targets, SEQ 11 the core TRIM + coreTradePlan, SEQ 12
 * the fail-closed positions doctrine ensureCore relies on, SEQ 17 venue-routed sizingPrice). Zero
 * behavior change: env reads, dead band, sizing math and log lines are byte-identical to the monolith.
 * The logger keeps module 'trading-schedule-dispatch' on purpose — the log stream is the
 * watchdog/operator contract, and the file split must be invisible to it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — decomposition of trading-schedule-dispatch.ts (890 code lines) along its section seams: CoreConfig/coreConfig, the core buy/trim decision mappers, CORE_BAND_PCT, CoreTrade/coreTradePlan, sizingPrice and ensureCore move here unchanged (same exported names/signatures the unit specs and the store's strategy-lab route import through the entry barrel). Env names unchanged: TRADING_CORE_SYMBOLS, TRADING_CORE_TARGET_PCT. Golden-plan guard: tests/unit/trading-dispatch-golden-plan.spec.ts.
 *
 * @module trading-dispatch-core
 */

import type { AppContext } from './composition-root';
import { getMarketData, type Position, type TradingMode, type TradingBook, type BrokerAccount } from '@/features/trading';
import { legacyBook } from './trading-books-store';
import { overlayCoreEntries, type ConfigOverrideRow } from './trading-config-overrides';
import { placeManaged, type RunOrder, type DecisionInput } from './trading-dispatch-rail';
import { createChildLogger } from '@/shared/logger';

// Module name kept as the monolith's: the log stream is the watchdog/operator contract.
const logger = createChildLogger({ module: 'trading-schedule-dispatch' });

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
 * @param override - The applied Strategy Library override (ADR-095), when one is active.
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
