#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Backtest the operator's defensive extended-hours rule ("we are not trying to make money off-hours, we are trying to not lose it"): SELL a held name when it prints <= -X% off its regular close in post (16:00-20:00 ET) or the following pre-market (04:00-09:30 ET); NO rebuy off-hours. Books reconstructed per session from the Alpaca fills ledger; benchmark = holding to the next regular open. Includes a 2-consecutive-bars confirmation variant (thin-print noise gauge).
 */
/*
 * Usage: node trading-exthours-rule-backtest.js [--pct=0.5] [--slip=0.3]
 * Reads ALPACA keys from .env. Read-only.
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch { /* env may be set */ }

const TRIG = (Number((process.argv.find((a) => a.startsWith('--pct=')) || '').slice(6)) || 0.5) / 100;
const SLIP = (Number((process.argv.find((a) => a.startsWith('--slip=')) || '').slice(7)) || 0.3) / 100;
const envFirst = (...n) => { for (const k of n) if (process.env[k]) return process.env[k].trim(); return ''; };
const KEY = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SEC = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC };
// Trading sessions with a book, and the NEXT trading day (holiday-aware).
const SESSIONS = [
  ['2026-06-26', '2026-06-29'], ['2026-06-29', '2026-06-30'], ['2026-06-30', '2026-07-01'],
  ['2026-07-01', '2026-07-02'], ['2026-07-02', '2026-07-06'], ['2026-07-06', '2026-07-07'],
];
const usd = (n) => (n < 0 ? '-$' : '+$') + Math.abs(n).toFixed(0);

async function allFills() {
  const fills = []; let page = '';
  for (let i = 0; i < 40; i++) {
    const u = 'https://paper-api.alpaca.markets/v2/account/activities/FILL?after=2026-06-20T00:00:00Z&direction=asc&page_size=100' + (page ? '&page_token=' + page : '');
    const r = await (await fetch(u, { headers: H })).json();
    if (!Array.isArray(r) || !r.length) break;
    fills.push(...r); page = r[r.length - 1].id;
    if (r.length < 100) break;
  }
  return fills;
}

/** Long book (sym -> qty) as of an instant, from cumulative signed fills. */
function bookAt(fills, cutoffMs) {
  const q = new Map();
  for (const f of fills) {
    if (Date.parse(f.transaction_time) > cutoffMs) continue;
    const s = f.symbol, d = (f.side === 'buy' ? 1 : -1) * Number(f.qty);
    q.set(s, (q.get(s) || 0) + d);
  }
  return new Map([...q].filter(([, n]) => n > 0.5).map(([s, n]) => [s, Math.round(n)]));
}

async function bars5m(symbols, startIso, endIso) {
  const out = new Map(symbols.map((s) => [s, []])); let page = '';
  for (let i = 0; i < 40; i++) {
    const u = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbols.join(',')}&timeframe=5Min&start=${startIso}&end=${endIso}&limit=10000&adjustment=all&feed=iex` + (page ? '&page_token=' + page : '');
    const j = await (await fetch(u, { headers: H })).json();
    for (const [s, bs] of Object.entries(j.bars || {})) { const a = out.get(s) || []; for (const b of bs) a.push({ t: Date.parse(b.t), c: b.c, v: b.v }); out.set(s, a); }
    if (!j.next_page_token) break; page = j.next_page_token;
  }
  for (const a of out.values()) a.sort((x, y) => x.t - y.t);
  return out;
}

(async () => {
  if (!KEY) { console.error('no alpaca keys'); process.exit(1); }
  const fills = await allFills();
  console.error(`[bt] ${fills.length} fills loaded; rule: sell at <= -${(TRIG * 100).toFixed(2)}% off close, slippage ${(SLIP * 100).toFixed(1)}%, no rebuy`);
  const grand = { rule: 0, rule2: 0, windows: 0, trig: 0, trig2: 0, names: 0 };
  const perSession = [];

  for (const [d, n] of SESSIONS) {
    const closeMs = Date.parse(`${d}T20:00:00Z`);               // 16:00 ET (EDT)
    const postEnd = closeMs + 4 * 3600e3;                        // 20:00 ET
    const preStart = Date.parse(`${n}T08:00:00Z`);               // 04:00 ET next day
    const openMs = Date.parse(`${n}T13:30:00Z`);                 // 09:30 ET next day
    const book = bookAt(fills, closeMs);
    if (!book.size) { perSession.push({ session: d, note: 'no positions' }); continue; }
    const syms = [...book.keys()];
    const bars = await bars5m(syms, new Date(closeMs - 86400e3).toISOString(), new Date(openMs + 1800e3).toISOString());
    const rows = [];
    let ruleTot = 0, rule2Tot = 0;
    for (const [sym, qty] of book) {
      const bs = bars.get(sym) || [];
      const ref = [...bs].reverse().find((b) => b.t <= closeMs && b.t > closeMs - 6.5 * 3600e3)?.c; // last regular close
      const openB = bs.find((b) => b.t >= openMs && b.t < openMs + 1800e3);
      if (!ref || !openB) { rows.push({ sym, qty, note: 'no ref/open bar' }); continue; }
      const win = bs.filter((b) => (b.t >= closeMs && b.t < postEnd) || (b.t >= preStart && b.t < openMs));
      const lim = ref * (1 - TRIG);
      // Variant A: first print at/below trigger sells all.
      const hitIdx = win.findIndex((b) => b.c <= lim);
      // Variant B: two CONSECUTIVE prints below trigger (thin-print noise filter).
      let hit2Idx = -1;
      for (let i = 1; i < win.length; i++) if (win[i].c <= lim && win[i - 1].c <= lim) { hit2Idx = i; break; }
      const openPx = openB.c;
      const holdVal = qty * openPx;
      const evalHit = (idx) => idx < 0 ? { pnl: 0, px: null } : { pnl: qty * (win[idx].c * (1 - SLIP)) - holdVal, px: win[idx].c };
      const A = evalHit(hitIdx), B = evalHit(hit2Idx);
      ruleTot += A.pnl; rule2Tot += B.pnl;
      grand.names += 1; if (hitIdx >= 0) grand.trig += 1; if (hit2Idx >= 0) grand.trig2 += 1;
      rows.push({
        sym, qty, close: ref, nextOpen: openPx,
        gapPct: Math.round(((openPx / ref) - 1) * 10000) / 100,
        trigA: hitIdx >= 0 ? { px: A.px, when: new Date(win[hitIdx].t).toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }), savedVsHold: Math.round(A.pnl) } : null,
        trigB2bar: hit2Idx >= 0 ? { savedVsHold: Math.round(B.pnl) } : null,
      });
    }
    grand.rule += ruleTot; grand.rule2 += rule2Tot; grand.windows += 1;
    perSession.push({ session: `${d} 16:00 -> ${n} 09:30`, names: book.size, ruleSavedVsHold: Math.round(ruleTot), rule2barSavedVsHold: Math.round(rule2Tot), detail: rows.filter((r) => r.trigA || r.trigB2bar || Math.abs(r.gapPct) > 2) });
  }
  console.log(JSON.stringify({
    rule: `sell all at <= -${(TRIG * 100).toFixed(2)}% off regular close in post/pre, ${(SLIP * 100).toFixed(1)}% slippage, no rebuy; benchmark = hold to next 09:30 open`,
    grandTotal: { firstPrintVariant: Math.round(grand.rule), twoBarConfirmVariant: Math.round(grand.rule2), windows: grand.windows, nameNights: grand.names, triggersA: grand.trig, triggersB: grand.trig2 },
    perSession,
  }, null, 2));
})().catch((e) => { console.error('FAIL:', e.message || e); process.exit(1); });
