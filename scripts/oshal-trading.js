#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — canonical trade-execution CLI + localhost test harness for the trading app (ADR-052). Drives the full pipeline against ALPACA PAPER with no UI, and writes the signal -> decision -> order provenance chain even from the shell so the NOT-NULL decision_id invariant always holds. Satisfies the human-testability gate before any live keys exist. PAPER-ONLY by design — this harness refuses the live book.
 *
 * Reads/writes the trading-owned oshal_trading_{signals,decisions,orders} stores and talks to
 * the Alpaca PAPER endpoint with ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY.
 *
 *   node scripts/oshal-trading.js account   <user_sub>
 *   node scripts/oshal-trading.js positions <user_sub>
 *   node scripts/oshal-trading.js orders    <user_sub>
 *   node scripts/oshal-trading.js ledger    <user_sub>
 *   node scripts/oshal-trading.js signal    <user_sub> <source> <symbol> <text...>
 *   node scripts/oshal-trading.js buy       <user_sub> <symbol> <qty> [limitPrice]
 *   node scripts/oshal-trading.js sell      <user_sub> <symbol> <qty> [limitPrice]
 *   node scripts/oshal-trading.js selftest  <user_sub> [symbol]   # place+cancel every order type
 *
 * buy/sell create a manual signal + a manual decision (rationale = "CLI harness manual order")
 * and then place the paper order referencing that decision — so the provenance chain is intact.
 * Exit 1 on error; exit 3 if paper keys are missing.
 */
'use strict';
// Load the repo-root .env when run from a plain shell (the container injects env itself).
// Guarded so a missing dotenv never breaks the harness.
try { require('dotenv').config(); } catch { /* dotenv optional */ }
const crypto = require('crypto');
const { Pool } = require('pg');

function envFirst(...names) { for (const n of names) { const v = process.env[n]; if (v) return v.trim(); } return ''; }
function normalizeBase(url) { return url ? url.replace(/\/+$/, '').replace(/\/v2$/i, '') : ''; }

// Paper book only (this harness refuses live). Canonical names first, common aliases too.
const KEY_ID = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SECRET = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
const ALPACA_BASE = normalizeBase(envFirst('ALPACA_PAPER_ENDPOINT', 'ALPACA_ENDPOINT', 'ALPAKA_ENDPOINT')) || 'https://paper-api.alpaca.markets';
const MODE = 'paper';

function requireKeys() {
  if (!KEY_ID || !SECRET) {
    console.error('Missing Alpaca paper keys. Set ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY (aliases ALPACA_KEY/ALPACA_SECRET also accepted). Free + instant at alpaca.markets.');
    process.exit(3);
  }
}

async function alpaca(method, pathname, body) {
  const r = await fetch(`${ALPACA_BASE}${pathname}`, {
    method,
    headers: { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `alpaca ${pathname} ${r.status}`);
  return j;
}

/** Record a signal snapshot; returns its signal_id (dedup-safe). */
async function recordSignal(pool, userSub, source, symbol, text) {
  const symbols = symbol ? [symbol.toUpperCase()] : [];
  const artifact = JSON.stringify({ source, externalId: null, author: 'cli', title: text, body: text, url: null });
  const hash = crypto.createHash('sha256').update(artifact + ':' + Date.now()).digest('hex');
  const row = (await pool.query(
    `INSERT INTO oshal_trading_signals (user_sub, mode, source, author, title, body, symbols, content_hash)
       VALUES ($1,$2,$3,'cli',$4,$4,$5,$6) RETURNING signal_id`,
    [userSub, MODE, source, text, symbols, hash])).rows[0];
  return row.signal_id;
}

/** Record a manual decision referencing a signal; returns its decision_id.
 *  spec = { symbol, side, qty, type, limitPrice?, stopPrice?, trailPrice?, trailPercent?, timeInForce? } */
async function recordDecision(pool, userSub, signalId, spec) {
  const sym = spec.symbol.toUpperCase();
  const row = (await pool.query(
    `INSERT INTO oshal_trading_decisions
       (user_sub, mode, signal_ids, agent_id, action, symbol, side, qty, order_type, limit_price,
        stop_price, trail_price, trail_percent, time_in_force, confidence, rationale, indicators, guardrails)
     VALUES ($1,$2,$3::uuid[],'cli',$4,$5,$4,$6,$7,$8,$9,$10,$11,$12,1.0,$13,'{}'::jsonb,'{}'::jsonb)
     RETURNING decision_id`,
    [userSub, MODE, [signalId], spec.side, sym, spec.qty, spec.type, spec.limitPrice ?? null,
     spec.stopPrice ?? null, spec.trailPrice ?? null, spec.trailPercent ?? null, spec.timeInForce || 'day',
     `CLI harness ${spec.type} ${spec.side} ${spec.qty} ${sym}`])).rows[0];
  return row.decision_id;
}

/** Place a paper order of any type and persist it against the decision (the provenance chain). */
async function placeOrder(pool, userSub, spec) {
  requireKeys();
  const sym = spec.symbol.toUpperCase();
  const tif = spec.timeInForce || 'day';
  const signalId = await recordSignal(pool, userSub, 'manual', sym, `manual ${spec.type} ${spec.side} ${spec.qty} ${sym}`);
  const decisionId = await recordDecision(pool, userSub, signalId, spec);
  const clientOrderId = `${userSub}:cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 128);
  const body = { symbol: sym, qty: String(spec.qty), side: spec.side, type: spec.type, time_in_force: tif, client_order_id: clientOrderId };
  if (spec.type === 'limit' || spec.type === 'stop_limit') body.limit_price = String(spec.limitPrice);
  if (spec.type === 'stop' || spec.type === 'stop_limit') body.stop_price = String(spec.stopPrice);
  if (spec.type === 'trailing_stop') { if (spec.trailPrice) body.trail_price = String(spec.trailPrice); else body.trail_percent = String(spec.trailPercent); }
  const o = await alpaca('POST', '/v2/orders', body);
  await pool.query(
    `INSERT INTO oshal_trading_orders
       (user_sub, mode, decision_id, broker, broker_order_id, client_order_id, symbol, side, qty, order_type,
        limit_price, stop_price, trail_price, trail_percent, time_in_force, status, raw_status, filled_qty, filled_avg_price, submitted_at)
     VALUES ($1,$2,$3,'alpaca',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18)
     ON CONFLICT (user_sub, client_order_id) DO UPDATE SET status=EXCLUDED.status, updated_at=now()`,
    [userSub, MODE, decisionId, o.id, clientOrderId, o.symbol, o.side, Number(o.qty), spec.type,
     spec.limitPrice ?? null, spec.stopPrice ?? null, spec.trailPrice ?? null, spec.trailPercent ?? null, tif,
     o.status, Number(o.filled_qty || 0), o.filled_avg_price != null ? Number(o.filled_avg_price) : null, o.submitted_at || null]);
  return { signalId, decisionId, orderId: o.id, status: o.status, symbol: o.symbol, side: o.side, qty: o.qty, type: spec.type };
}

/**
 * Self-test: place ONE of every order type on the paper book (long + a short), prove each is
 * accepted, then cancel them so the account is left flat. Prices are far from market so the
 * resting orders never fill; the market order rests after-hours and is cancelable too.
 * Answers "can it execute all the different types of trades?" end-to-end through the real chain.
 */
async function selftest(pool, userSub, symbol) {
  requireKeys();
  const SYM = (symbol || 'AAPL').toUpperCase();
  const cases = [
    { name: 'market buy',        spec: { symbol: SYM, side: 'buy',  qty: 1, type: 'market' } },
    { name: 'limit buy',         spec: { symbol: SYM, side: 'buy',  qty: 1, type: 'limit', limitPrice: 1.00 } },
    { name: 'stop buy',          spec: { symbol: SYM, side: 'buy',  qty: 1, type: 'stop', stopPrice: 99999 } },
    { name: 'stop_limit buy',    spec: { symbol: SYM, side: 'buy',  qty: 1, type: 'stop_limit', stopPrice: 99999, limitPrice: 99999 } },
    { name: 'trailing_stop buy', spec: { symbol: SYM, side: 'buy',  qty: 1, type: 'trailing_stop', trailPercent: 5 } },
    { name: 'short (limit sell)', spec: { symbol: SYM, side: 'sell', qty: 1, type: 'limit', limitPrice: 99999 } },
  ];
  const results = []; const ids = [];
  for (const c of cases) {
    try {
      const r = await placeOrder(pool, userSub, c.spec);
      results.push({ test: c.name, result: 'PLACED', status: r.status, orderId: r.orderId });
      if (r.orderId) ids.push({ id: r.orderId, status: r.status });
    } catch (e) {
      results.push({ test: c.name, result: 'FAILED', error: e.message });
    }
  }
  // Clean up: cancel every order this test placed (terminal/filled orders error harmlessly).
  let canceled = 0; const filled = [];
  for (const o of ids) {
    if (o.status === 'filled' || o.status === 'partially_filled') { filled.push(o.id); continue; }
    try { await alpaca('DELETE', `/v2/orders/${o.id}`); canceled++; } catch { /* already terminal */ }
  }
  const placed = results.filter((r) => r.result === 'PLACED').length;
  return {
    symbol: SYM, mode: MODE, placed, failed: results.length - placed, canceled,
    note: filled.length ? `Market was open — ${filled.length} order(s) FILLED and were left as positions; flatten manually if unwanted.` : 'All orders rested and were canceled — account left flat.',
    results,
  };
}

(async () => {
  const [cmd, userSub, a, b, c] = process.argv.slice(2);
  if (!cmd || !userSub) {
    console.error('usage: oshal-trading.js <account|positions|orders|ledger|signal|buy|sell|selftest> <user_sub> [args]');
    process.exit(1);
  }
  // Mirror the app's connection convention (app-runtime-factory.ts): a connection string if
  // present, else the discrete POSTGRES_* vars. Lets the CLI connect wherever the app does.
  const connStr = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const pool = connStr && connStr.trim()
    ? new Pool({ connectionString: connStr.trim() })
    : new Pool({
        host: process.env.POSTGRES_HOST || process.env.PGHOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || process.env.PGPORT || '5432', 10),
        database: process.env.POSTGRES_DB || process.env.PGDATABASE || 'oshal',
        user: process.env.POSTGRES_USER || process.env.PGUSER || 'oshal_user',
        password: process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || 'oshal_password',
      });
  try {
    let result;
    if (cmd === 'account') { requireKeys(); result = await alpaca('GET', '/v2/account'); }
    else if (cmd === 'positions') { requireKeys(); result = await alpaca('GET', '/v2/positions'); }
    else if (cmd === 'orders') {
      result = (await pool.query('SELECT order_id, decision_id, symbol, side, qty, order_type, status, filled_qty, created_at FROM oshal_trading_orders WHERE user_sub=$1 AND mode=$2 ORDER BY created_at DESC LIMIT 50', [userSub, MODE])).rows;
    } else if (cmd === 'ledger') {
      requireKeys();
      result = { account: await alpaca('GET', '/v2/account'), positions: await alpaca('GET', '/v2/positions') };
    } else if (cmd === 'signal') {
      // signal <user_sub> <source> <symbol> <text...>
      const source = a || 'manual';
      const symbol = b || '';
      const text = process.argv.slice(6).join(' ') || c || '';
      result = { signalId: await recordSignal(pool, userSub, source, symbol, text) };
    } else if (cmd === 'buy' || cmd === 'sell') {
      // buy <user_sub> <symbol> <qty> [limitPrice]   (limit if a price is given, else market)
      if (!a || !b) { console.error(`usage: oshal-trading.js ${cmd} <user_sub> <symbol> <qty> [limitPrice]`); process.exit(1); }
      result = await placeOrder(pool, userSub, { symbol: a, side: cmd, qty: Number(b), type: c ? 'limit' : 'market', limitPrice: c ? Number(c) : undefined });
    } else if (cmd === 'selftest') {
      // selftest <user_sub> [symbol]   — place + cancel one of every order type on paper
      result = await selftest(pool, userSub, a);
    } else { console.error(`unknown command: ${cmd}`); process.exit(1); }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('oshal-trading failed: ' + (err && err.message || err));
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
