/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | After-hours counterfactual backtest: replay the REAL autopilot exit engine (exitsToRun/trailingExits/rebalanceTrims x TRADING_EXT_STOP_MULT + the 5Min+1Hour breakdown exit via decideSymbol) against the actual 16:00-20:00 ET IEX tape for a given session, to answer "what if extended-hours had been on". Exits-only (no counterfactual entries); fills modeled as marketable limits with TRADING_EXT_LIMIT_SLIPPAGE_PCT.
 */
/*
 * Usage:
 *   npx ts-node -P tsconfig.json -r tsconfig-paths/register scripts/trading-afterhours-backtest.ts --date=2026-07-06
 *
 * Positions come from packages/oshal-vids-operator/out/deck-data.json (positionsDetail = the
 * session-close book). Requires ALPACA_PAPER_KEY_ID/SECRET in .env (IEX data feed — the same
 * feed production trades on, so thin after-hours prints are the SAME prints the bot would see).
 */
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ quiet: true });

import { exitsToRun, trailingExits, nextPeaks, rebalanceTrims, riskPolicy, type ExitOrder } from '../src/features/trading/services/portfolio';
import { decideSymbol, isShortTermBreakdown } from '../src/features/trading/services/multi-timeframe';
import type { Position } from '../src/features/trading/services/broker-adapter';
import type { Timeframe } from '../src/features/trading/services/market-data';

const DATA_BASE = 'https://data.alpaca.markets/v2';
const envFirst = (...names: string[]): string => { for (const n of names) { const v = process.env[n]; if (v) return v.trim(); } return ''; };
const KEY = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SEC = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');

/** A raw bar: start timestamp (ms epoch) + close. */
interface Bar { t: number; c: number; }

/** Fetch multi-symbol bars (feed=iex, adjustment=all — mirrors market-data.ts) with pagination. */
async function fetchBars(symbols: string[], timeframe: string, startIso: string, endIso: string): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>(symbols.map((s) => [s, []]));
  let pageToken = '';
  for (let page = 0; page < 40; page++) {
    const url = `${DATA_BASE}/stocks/bars?symbols=${encodeURIComponent(symbols.join(','))}&timeframe=${timeframe}` +
      `&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&limit=10000&adjustment=all&feed=iex` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
    const r = await fetch(url, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } });
    if (!r.ok) throw new Error(`bars ${timeframe} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { bars?: Record<string, Array<{ t: string; c: number }>>; next_page_token?: string | null };
    for (const [sym, bars] of Object.entries(j.bars || {})) {
      const arr = out.get(sym) || [];
      for (const b of bars) arr.push({ t: Date.parse(b.t), c: b.c });
      out.set(sym, arr);
    }
    if (!j.next_page_token) break;
    pageToken = j.next_page_token;
  }
  for (const arr of out.values()) arr.sort((a, b) => a.t - b.t);
  return out;
}

/** Closes of bars strictly started before asOf (the series the live scan would have had). */
const closesAsOf = (bars: Bar[] | undefined, asOf: number): number[] => (bars || []).filter((b) => b.t < asOf).map((b) => b.c);
/** Last close printed strictly before asOf, or null. */
const lastPxAsOf = (bars: Bar[] | undefined, asOf: number): number | null => { const c = closesAsOf(bars, asOf); return c.length ? c[c.length - 1] : null; };
const usd = (n: number): string => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);

(async () => {
  const dateArg = (process.argv.find((a) => a.startsWith('--date=')) || '').slice(7) || new Date().toISOString().slice(0, 10);
  if (!KEY || !SEC) { console.error('FAIL: no Alpaca data keys in env'); process.exit(1); }

  // Book at the close: qty + avg from the session's deck data (positionsDetail).
  const deck = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'packages', 'oshal-vids-operator', 'out', 'deck-data.json'), 'utf8'));
  const book: Array<{ sym: string; qty: number; avg: number }> = (deck.positionsDetail || []).map((p: { sym: string; qty: number; avg: number }) => ({ sym: p.sym.toUpperCase(), qty: p.qty, avg: p.avg }));
  if (!book.length) { console.error('FAIL: no positionsDetail in deck-data.json'); process.exit(1); }
  const symbols = book.map((b) => b.sym);
  const equityBase = Number(deck.results?.equity) || 100000;

  // Session boundaries (EDT: ET = UTC-4). 16:00 ET close / 20:00 ET after-hours end.
  const close = Date.parse(`${dateArg}T20:00:00Z`);
  const ahEndMs = close + 4 * 3600 * 1000; // 20:00 ET
  const iso = (ms: number) => new Date(ms).toISOString();

  // The tape: every timeframe the production scan feeds decideSymbol (TF_WEIGHTS).
  const day = 24 * 3600 * 1000;
  console.error(`[backtest] fetching IEX tape for ${symbols.length} names…`);
  const tf5 = await fetchBars(symbols, '5Min', iso(close - 5 * day), iso(ahEndMs));
  const tf1h = await fetchBars(symbols, '1Hour', iso(close - 45 * day), iso(ahEndMs));
  const tf1d = await fetchBars(symbols, '1Day', iso(close - 550 * day), iso(ahEndMs));
  const tf1w = await fetchBars(symbols, '1Week', iso(close - 1200 * day), iso(ahEndMs));
  const tf3m = await fetchBars(symbols, '3Month', iso(close - 2200 * day), iso(ahEndMs));
  const tfMap: Array<[Timeframe, Map<string, Bar[]>]> = [['5Min', tf5], ['1Hour', tf1h], ['1Day', tf1d], ['1Week', tf1w], ['3Month', tf3m]];

  // ── The damage: close mark vs last after-hours print ──
  const damage = book.map((b) => {
    const pxClose = lastPxAsOf(tf5.get(b.sym), close + 1) ?? b.avg;
    const pxAh = lastPxAsOf(tf5.get(b.sym), ahEndMs + 1) ?? pxClose;
    const ahBars = (tf5.get(b.sym) || []).filter((x) => x.t >= close && x.t < ahEndMs).length;
    return { ...b, pxClose, pxAh, ahBars, ahMove: (pxAh - pxClose) * b.qty, ahPct: pxClose ? ((pxAh / pxClose) - 1) * 100 : 0 };
  });

  // ── Replay: the real exit engine, every 5 minutes, 16:05 → 20:00 ET ──
  const policy = riskPolicy(); // reads TRADING_RISK_POSTURE from .env — same posture as production
  const stopMult = Number(process.env.TRADING_EXT_STOP_MULT || 1.4);
  const slip = Number(process.env.TRADING_EXT_LIMIT_SLIPPAGE_PCT || 0.3) / 100;
  const holdings = new Map(book.map((b) => [b.sym, { qty: b.qty, avg: b.avg }]));
  // Peak seed: max(entry, session-day closes up to 16:00). Underestimates a multi-day peak → the
  // trail fires LATER than production would have → the counterfactual saving is CONSERVATIVE.
  const dayStart = close - 6.5 * 3600 * 1000;
  let peaks = new Map<string, number>(book.map((b) => {
    const dayCloses = (tf5.get(b.sym) || []).filter((x) => x.t >= dayStart && x.t <= close).map((x) => x.c);
    return [b.sym, Math.max(b.avg, ...(dayCloses.length ? dayCloses : [b.avg]))];
  }));
  const fills: Array<{ time: string; sym: string; reason: string; qty: number; px: number; pl: number }> = [];
  let realized = 0;

  for (let t = close + 5 * 60 * 1000; t <= ahEndMs; t += 5 * 60 * 1000) {
    const positions: Position[] = [...holdings.entries()].filter(([, h]) => h.qty > 0).map(([sym, h]) => {
      const cur = lastPxAsOf(tf5.get(sym), t) ?? h.avg;
      return { symbol: sym, qty: h.qty, avgEntryPrice: h.avg, currentPrice: cur, marketValue: h.qty * cur, unrealizedPl: (cur - h.avg) * h.qty };
    });
    if (!positions.length) break;
    peaks = nextPeaks(positions, peaks);

    // computeExits order (trading-schedule-dispatch): stop/TP > trailing > cap trim, dedup by symbol.
    const bySym = new Map<string, ExitOrder>();
    for (const e of [...exitsToRun(positions, policy, stopMult), ...trailingExits(positions, peaks, policy, stopMult), ...rebalanceTrims(positions, equityBase, policy)]) {
      const k = e.symbol.toUpperCase();
      if (!bySym.has(k)) bySym.set(k, e);
    }
    // 2a) breakdown protective exit — the REAL decideSymbol on the as-of-T series, default weights
    // (oshal_trading_algo_masses is empty in this deployment, so {} is exactly what production ran).
    for (const p of positions) {
      if (bySym.has(p.symbol)) continue;
      const closesByTf = new Map<Timeframe, number[]>();
      for (const [tf, bars] of tfMap) { const c = closesAsOf(bars.get(p.symbol), t); if (c.length) closesByTf.set(tf, c); }
      const d = decideSymbol(p.symbol, closesByTf);
      // Production's breakdown sell isn't an ExitOrder (it goes through breakdownDecision) — model
      // it as a full-position exit tagged 'breakdown' for the fill loop.
      if (isShortTermBreakdown(d)) bySym.set(p.symbol, { symbol: p.symbol, qty: p.qty, reason: 'breakdown' as ExitOrder['reason'], pnlPct: 0 });
    }

    for (const e of bySym.values()) {
      const h = holdings.get(e.symbol); if (!h || h.qty <= 0) continue;
      const cur = lastPxAsOf(tf5.get(e.symbol), t); if (!cur) continue; // no print → no fill this fire (production same)
      const qty = Math.min(e.qty, h.qty);
      const fill = Math.round(cur * (1 - slip) * 100) / 100; // marketable limit crossing the spread
      realized += qty * fill;
      fills.push({ time: new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }), sym: e.symbol, reason: String(e.reason), qty, px: fill, pl: (fill - h.avg) * qty });
      h.qty -= qty;
    }
  }

  // ── Compare at 20:00 ET ──
  const markAh = (sym: string) => lastPxAsOf(tf5.get(sym), ahEndMs + 1) ?? lastPxAsOf(tf5.get(sym), close + 1) ?? 0;
  const heldValueActual = damage.reduce((s, d) => s + d.qty * d.pxAh, 0);
  const heldValueClose = damage.reduce((s, d) => s + d.qty * d.pxClose, 0);
  const remainValue = [...holdings.entries()].reduce((s, [sym, h]) => s + h.qty * markAh(sym), 0);
  const counterfactual = realized + remainValue;

  console.log(JSON.stringify({
    date: dateArg, posture: policy.posture, stopMult, slippagePct: slip * 100,
    effStopPct: policy.stopLossPct * stopMult, trailArmPct: policy.trailArmPct, effGivebackPct: policy.trailGivebackPct * stopMult,
    bookValueAtClose: Math.round(heldValueClose * 100) / 100,
    damage: damage.map((d) => ({ sym: d.sym, qty: d.qty, close: d.pxClose, ah: d.pxAh, ahPct: Math.round(d.ahPct * 100) / 100, ahMoveUsd: Math.round(d.ahMove * 100) / 100, ahPrints: d.ahBars })),
    actual: { bookValueAt2000: Math.round(heldValueActual * 100) / 100, ahPl: Math.round((heldValueActual - heldValueClose) * 100) / 100 },
    counterfactual: { fills, realizedProceeds: Math.round(realized * 100) / 100, remainingBookAt2000: Math.round(remainValue * 100) / 100, total: Math.round(counterfactual * 100) / 100, ahPl: Math.round((counterfactual - heldValueClose) * 100) / 100 },
    savedByExtHours: Math.round((counterfactual - heldValueActual) * 100) / 100,
  }, null, 2));
})().catch((e) => { console.error('FAIL:', (e as Error).message); process.exit(1); });
