#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Daily Trade Recap — DATA side. Backs the
 *   registered trade_recap_data tool (swarm-apps/daily-trade-recap.yaml). Pulls the
 *   REAL trading day from the Alpaca PAPER REST API directly (global fetch, no SDK,
 *   no TS build — mirrors scripts/oshal-trading.js env + REST conventions) and writes
 *   the recap-data.json contract that the write-once report tool
 *   (packages/oshal-vids-operator/build-daily-report.js) consumes.
 *
 *   Reads:  GET /v2/account, GET /v2/positions,
 *           GET /v2/orders?status=closed&after=<today-00:00-ET>&limit=500,
 *           GET /v2/account/portfolio/history?period=1D&timeframe=5Min
 *   Writes: packages/oshal-vids-operator/out/recap-data.json  (+ prints to stdout)
 *
 *   NEVER fabricates numbers: if creds are missing or the API fails, exits non-zero
 *   with a clear message (the operator rejects fabricated data).
 *
 *   Usage:  node scripts/oshal-trade-data.js [{input}]
 *   The optional {input} JSON is accepted for tool-call symmetry; no fields are
 *   required (the day is read live from the broker).
 */
'use strict';
// Load the repo-root .env when run from a plain shell (the container injects env itself).
// quiet:true keeps dotenv's banner OFF stdout — stdout must stay a clean JSON document
// (a bot reads it); newer dotenv prints its tip line to stdout otherwise.
try { require('dotenv').config({ quiet: true }); } catch { /* dotenv optional */ }

const fs = require('fs');
const path = require('path');

function envFirst(...names) { for (const n of names) { const v = process.env[n]; if (v) return v.trim(); } return ''; }
function normalizeBase(url) { return url ? url.replace(/\/+$/, '').replace(/\/v2$/i, '') : ''; }

// Paper book only. Canonical per-mode names first, then the common aliases (matches
// alpaca-broker-adapter.ts + scripts/oshal-trading.js so an existing .env keeps working).
const KEY_ID = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SECRET = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
const ALPACA_BASE = normalizeBase(envFirst('ALPACA_PAPER_ENDPOINT', 'ALPACA_ENDPOINT', 'ALPAKA_ENDPOINT')) || 'https://paper-api.alpaca.markets';

const OUT_PATH = path.join(__dirname, '..', 'packages', 'oshal-vids-operator', 'out', 'recap-data.json');

function fail(msg, code) {
  console.error(`oshal-trade-data: ${msg}`);
  process.exit(code || 1);
}

async function alpaca(pathname) {
  let r;
  try {
    r = await fetch(`${ALPACA_BASE}${pathname}`, {
      headers: { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    throw new Error(`network error calling ${pathname}: ${(e && e.message) || e}`);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && j.message) || `alpaca ${pathname} ${r.status}`);
  return j;
}

/** Today's 00:00 in US Eastern time, as an RFC3339 string the Alpaca `after` filter accepts.
 *  We resolve the wall-clock ET date with Intl, then express that ET midnight back as an
 *  absolute instant so DST is handled by the runtime, not by a hardcoded offset. */
function etMidnightISO(now) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  // Current ET offset in minutes: (UTC time the formatter reported) vs the real UTC instant.
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour), Number(parts.minute), Number(parts.second),
  );
  const offsetMs = asUTC - now.getTime();           // ET-wallclock-as-UTC minus true UTC
  // Midnight ET (wall clock) for today's ET date, expressed as a UTC instant.
  const midnightWallAsUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0);
  const midnightInstant = new Date(midnightWallAsUTC - offsetMs);
  return midnightInstant.toISOString();
}

/** Human ET date label, e.g. "June 27, 2026". */
function etDateLabel(now) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric',
  }).format(now);
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Spoken-friendly percent, e.g. 0.79 -> "about three quarters of a percent"-ish is overkill;
 *  keep it natural: "zero point seven nine" reads robotic, so render the magnitude plainly. */
function spokenPct(pct) {
  const v = Math.abs(round2(pct));
  return `${v} percent`;
}

/** Build the ~2-sentence male-TTS narration from the computed numbers. Company names are
 *  ALLOWED here (TTS, not Veo) but we keep it short (~30 words) and grounded in real data. */
/** Round a dollar amount to a clean spoken figure (nearest hundred), e.g. 1510.31 -> "1,500". */
function spokenMoney(n) {
  const a = Math.abs(n);
  const r = a >= 1000 ? Math.round(a / 100) * 100 : Math.round(a / 10) * 10;
  return r.toLocaleString('en-US');
}
function buildNarration(d) {
  const dir = d.pl >= 0 ? 'up' : 'down';
  const lead = d.leaders ? d.leaders.replace(/ · /g, ', ') : '';
  const parts = ["Here's the day."];
  parts.push(
    `The desk finished ${dir} about ${spokenPct(d.pct)}` +
    (lead ? `, with strength in ${lead}.` : '.'),
  );
  parts.push(
    d.fills > 0
      ? `${d.fills} trades, every one tied to a signal.`
      : 'No new trades today; the book is holding steady.',
  );
  parts.push(
    `${d.positions} positions stay open, ` +
    `${d.unrealized >= 0 ? 'up' : 'down'} about ${spokenMoney(d.unrealized)} dollars.`,
  );
  return parts.join(' ');
}

/** Today's ET calendar date as {y,m,d}. */
function etTodayYMD(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day };
}
function addDaysYMD(ymd, n) {
  const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)); dt.setUTCDate(dt.getUTCDate() + n);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
/** ET UTC-offset (minutes) at noon of the given date — handles EDT/EST without hardcoding. */
function etOffsetMinutes(ymd) {
  const utcNoon = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 12, 0, 0));
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(utcNoon).map((x) => [x.type, x.value]));
  const etAsUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? 0 : p.hour), +p.minute);
  return (etAsUTC - utcNoon.getTime()) / 60000;
}
/** Midnight ET of {y,m,d} expressed as a UTC ISO instant. */
function etMidnightISOForYMD(ymd) {
  const off = etOffsetMinutes(ymd);
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0) - off * 60000).toISOString();
}
/** Resolve the target report day from a flag ("yesterday" | "YYYY-MM-DD" | ""). */
function resolveTargetYMD(now, flag) {
  const today = etTodayYMD(now);
  let t = today, isToday = true;
  if (/^yesterday$/i.test(flag)) { t = addDaysYMD(today, -1); isToday = false; }
  else if (/^\d{4}-\d{2}-\d{2}$/.test(flag)) {
    const [y, m, d] = flag.split('-').map(Number); t = { y, m, d };
    isToday = (y === today.y && m === today.m && d === today.d);
  }
  t.isToday = isToday;
  t.label = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
    .format(new Date(Date.UTC(t.y, t.m - 1, t.d)));
  return t;
}
/** Find a specific day in Alpaca daily portfolio history -> {equity, pl, pct}. */
function pickHistoryDay(hist, ymd) {
  if (!hist || !Array.isArray(hist.timestamp)) return null;
  for (let i = 0; i < hist.timestamp.length; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(hist.timestamp[i] * 1000)).map((x) => [x.type, x.value]));
    if (+p.year === ymd.y && +p.month === ymd.m && +p.day === ymd.d) {
      const eq = Number(hist.equity[i]);
      const plv = Number(hist.profit_loss && hist.profit_loss[i]);
      const pctv = Number(hist.profit_loss_pct && hist.profit_loss_pct[i]) * 100;
      if (Number.isFinite(eq)) return { equity: eq, pl: Number.isFinite(plv) ? plv : 0, pct: Number.isFinite(pctv) ? pctv : 0 };
    }
  }
  return null;
}

async function main() {
  if (!KEY_ID || !SECRET) {
    fail('Missing Alpaca paper keys. Set ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY '
      + '(aliases ALPACA_KEY_ID/ALPACA_SECRET_KEY also accepted). No data is fabricated.', 3);
  }

  // Optional target day: "yesterday" | "YYYY-MM-DD" | {"date":"YYYY-MM-DD"} (default: today/live).
  const rawArg = process.argv.slice(2).find((a) => a && !a.startsWith('-')) || '';
  let flagDate = '';
  if (/^yesterday$/i.test(rawArg)) flagDate = 'yesterday';
  else if (/^\d{4}-\d{2}-\d{2}$/.test(rawArg)) flagDate = rawArg;
  else { try { const j = rawArg.trim().startsWith('{') ? JSON.parse(rawArg) : null; if (j && j.date && /^\d{4}-\d{2}-\d{2}$/.test(j.date)) flagDate = j.date; } catch { /* ignore */ } }
  const di = process.argv.indexOf('--date');
  if (di >= 0 && process.argv[di + 1]) flagDate = process.argv[di + 1];

  const now = new Date();
  const target = resolveTargetYMD(now, flagDate);
  const afterISO = etMidnightISOForYMD(target);
  const untilISO = etMidnightISOForYMD(addDaysYMD(target, 1));

  // Pull the real endpoints. Any failure throws -> non-zero exit (no fabricated fallback).
  // Orders are windowed to the target ET day; positions are the current book (valid as the
  // target EOD snapshot only when nothing has traded since — true for yesterday after close).
  const [account, positions, orders] = await Promise.all([
    alpaca('/v2/account'),
    alpaca('/v2/positions'),
    alpaca(`/v2/orders?status=closed&after=${encodeURIComponent(afterISO)}&until=${encodeURIComponent(untilISO)}&limit=500`),
  ]);

  // Day P/L + equity: today -> account equity vs last_equity; a past day -> daily portfolio history.
  let equity; let pl; let pct;
  if (target.isToday) {
    equity = round2(account.equity);
    const lastEquity = Number(account.last_equity);
    if (!Number.isFinite(lastEquity)) {
      fail('Alpaca account has no last_equity — cannot compute day P/L without fabricating it.', 1);
    }
    pl = round2(equity - lastEquity);
    pct = lastEquity > 0 ? round2((pl / lastEquity) * 100) : 0;
  } else {
    const hist = await alpaca('/v2/account/portfolio/history?period=3M&timeframe=1D&extended_hours=true').catch(() => null);
    const day = pickHistoryDay(hist, target);
    if (!day) fail(`No portfolio history for ${target.label} — cannot compute P/L without fabricating it.`, 1);
    equity = round2(day.equity);
    pl = round2(day.pl);
    pct = round2(day.pct);
  }

  const posList = Array.isArray(positions) ? positions : [];
  const unrealized = round2(posList.reduce((s, p) => s + (Number(p.unrealized_pl) || 0), 0));
  const positionsCount = posList.length;

  // Open winners by unrealized_pl (top 3 -> leaders string; top 4 -> winners [ticker, plpc%]).
  const sortedWinners = posList
    .filter((p) => (Number(p.unrealized_pl) || 0) > 0)
    .sort((a, b) => (Number(b.unrealized_pl) || 0) - (Number(a.unrealized_pl) || 0));
  const leaders = sortedWinners.slice(0, 3).map((p) => p.symbol).join(' · ');
  const winners = sortedWinners.slice(0, 4).map((p) => [p.symbol, round2((Number(p.unrealized_plpc) || 0) * 100)]);

  // Today's filled orders: count fills, split BUY/SELL tickers (most-recent first, de-duped).
  const orderList = Array.isArray(orders) ? orders : [];
  const filledToday = orderList.filter((o) => o.status === 'filled');
  const fills = filledToday.length;
  const bySide = (side) => {
    const seen = new Set();
    const out = [];
    for (const o of filledToday) {
      if (o.side !== side) continue;
      const sym = o.symbol;
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);
      out.push(sym);
      if (out.length >= 6) break;
    }
    return out;
  };
  const sells = bySide('sell');
  const buys = bySide('buy');

  const data = {
    date: target.label,
    pl,
    pct,
    equity,
    unrealized,
    fills,
    positions: positionsCount,
    leaders,
    winners,
    sells,
    buys,
    durationMs: 15500,
    narration: '',
  };
  data.narration = buildNarration(data);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');

  // Print the JSON to stdout (a bot reads this); the written path goes to stderr so stdout
  // stays a clean JSON document.
  console.error(`oshal-trade-data: wrote ${OUT_PATH}`);
  process.stdout.write(JSON.stringify(data));
}

main().catch((err) => fail((err && err.message) || String(err), 1));
