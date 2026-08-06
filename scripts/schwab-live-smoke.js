#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One-share LIVE smoke test of the Schwab write path (operator-requested): quote -> market BUY <qty> <symbol> -> poll to fill -> position readback -> record decision+order in the ledger. Deliberately direct-to-venue (bypasses TRADING_HALT/engine) so the API rail can be proven while the engine stays halted. Refuses to run without SMOKE_CONFIRM=yes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Envelope-crypto v2 fix (the oshal-recap-email.js drift's unaudited sibling, found live 2026-07-26): token decrypt is now format-aware — a `v2:`-prefixed blob unwraps the per-user DEK from oshal_user_deks first; legacy unprefixed blobs keep the single-KEK path. Without this the script dies "Unsupported state or unable to authenticate data" on any token refreshed since envelope crypto went on (2026-07-20).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Reuse the shared version-aware connector-token codec so this explicitly confirmed live-money smoke can read hkdf1/k2/v2 plus legacy formats without a private crypto fork.
 */
/*
 * Usage (in the api container):  SMOKE_CONFIRM=yes node schwab-live-smoke.js [SYMBOL] [QTY]
 * Defaults: BAC 1. Prints a step-by-step audit trail; exits non-zero on any failed step.
 */
'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');
const { decryptToken } = require('./lib/connector-token-crypto');

const SYMBOL = (process.argv[2] || 'BAC').toUpperCase();
const QTY = Math.max(1, Math.min(2, Number(process.argv[3]) || 1)); // hard-capped tiny
const SUB = process.env.OSHAL_USER_SUB || 'example-user-sub';
const TRADER = (process.env.SCHWAB_TRADER_BASE_URL || 'https://api.schwabapi.com/trader/v1').replace(/\/+$/, '');
const MKT = (process.env.SCHWAB_MARKETDATA_BASE_URL || 'https://api.schwabapi.com/marketdata/v1').replace(/\/+$/, '');
const step = (m) => console.log('[smoke] ' + m);

(async () => {
  if (String(process.env.SMOKE_CONFIRM || '').toLowerCase() !== 'yes') { console.error('REFUSED: set SMOKE_CONFIRM=yes to place a REAL one-share order'); process.exit(2); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query("SELECT set_config('oshal.is_operator','on',false)");
    // 1) Token (decrypt; refresh if <60s left) — same connection row the production resolver uses.
    const row = (await c.query("SELECT * FROM oshal_connections WHERE provider='schwab' AND user_sub=$1 ORDER BY updated_at DESC LIMIT 1", [SUB])).rows[0];
    if (!row) throw new Error('no schwab connection row');
    let token;
    if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60000) {
      token = await decryptToken(c, SUB, row.access_token); step('token: cached (expires ' + row.expiry.toISOString?.() + ')');
    } else {
      const basic = Buffer.from(`${process.env.SCHWAB_CLIENT_ID_PRD}:${process.env.SCHWAB_CLIENT_SECRET_PRD}`).toString('base64');
      const r = await fetch('https://api.schwabapi.com/v1/oauth/token', {
        method: 'POST', headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: await decryptToken(c, SUB, row.refresh_token) }),
      });
      if (!r.ok) throw new Error('token refresh HTTP ' + r.status + ' ' + (await r.text()).slice(0, 150));
      token = (await r.json()).access_token; step('token: refreshed');
    }
    const GH = { Authorization: 'Bearer ' + token };
    const H = { ...GH, 'Content-Type': 'application/json' };
    const getJson = async (url) => {
      const r = await fetch(url, { headers: GH });
      if (!r.ok) throw new Error(`GET ${url.replace(/hash[^/]*/, '<hash>')} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    };

    // 2) Account hash + cash
    const accts = await getJson(`${TRADER}/accounts/accountNumbers`);
    const want = process.env.TRADING_LIVE_ACCOUNT || '';
    if (!Array.isArray(accts) || !accts.length) throw new Error('accountNumbers returned no accounts: ' + JSON.stringify(accts).slice(0, 150));
    const acct = accts.find((a) => !want || String(a.accountNumber).endsWith(want)) || accts[0];
    if (!acct?.hashValue) throw new Error('no account hashValue');
    step('account: …' + String(acct.accountNumber).slice(-4));
    const bal = await getJson(`${TRADER}/accounts/${acct.hashValue}`);
    const cash = bal?.securitiesAccount?.currentBalances?.cashBalance ?? bal?.securitiesAccount?.currentBalances?.liquidationValue;
    step('cash before: $' + cash);

    // 3) Quote
    const q = await getJson(`${MKT}/quotes?symbols=${SYMBOL}&fields=quote&indicative=false`);
    const quote = q?.[SYMBOL]?.quote || {};
    const px = quote.lastPrice ?? quote.mark ?? quote.regularMarketLastPrice;
    if (!px) throw new Error('no quote for ' + SYMBOL);
    step(`quote ${SYMBOL}: $${px}`);

    // 4) Place: MARKET BUY QTY (NORMAL session, DAY) — the exact adapter order shape.
    const body = {
      orderType: 'MARKET', session: 'NORMAL', duration: 'DAY', orderStrategyType: 'SINGLE',
      orderLegCollection: [{ instruction: 'BUY', quantity: QTY, instrument: { symbol: SYMBOL, assetType: 'EQUITY' } }],
    };
    const po = await fetch(`${TRADER}/accounts/${acct.hashValue}/orders`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    if (po.status !== 201) throw new Error('place HTTP ' + po.status + ' ' + (await po.text()).slice(0, 300));
    const loc = po.headers.get('location') || '';
    const orderId = loc.split('/').pop();
    step(`ORDER PLACED: id=${orderId} (BUY ${QTY} ${SYMBOL} MARKET)`);

    // 5) Poll to fill (~45s max)
    let ord = null;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      ord = await getJson(`${TRADER}/accounts/${acct.hashValue}/orders/${orderId}`);
      step(`status: ${ord.status} filled=${ord.filledQuantity ?? 0}`);
      if (['FILLED', 'REJECTED', 'CANCELED', 'EXPIRED'].includes(String(ord.status))) break;
    }
    const fillPx = (ord.orderActivityCollection || []).flatMap((a) => a.executionLegs || []).map((l) => Number(l.price)).filter(Boolean);
    const avgFill = fillPx.length ? fillPx.reduce((s, x) => s + x, 0) / fillPx.length : null;
    if (String(ord.status) !== 'FILLED') throw new Error('order did not fill: ' + ord.status + ' ' + (ord.statusDescription || ''));
    step(`FILLED @ $${avgFill}`);

    // 6) Position readback
    const pos = await getJson(`${TRADER}/accounts/${acct.hashValue}?fields=positions`);
    const p = (pos?.securitiesAccount?.positions || []).find((x) => x?.instrument?.symbol === SYMBOL);
    step(`position readback: ${SYMBOL} qty=${p ? (p.longQuantity || 0) : 0}`);

    // 7) Ledger record (decision + order) — tight logs: the smoke test is in the same journal as the engine.
    const decisionId = crypto.randomUUID();
    await c.query(
      `INSERT INTO oshal_trading_decisions (decision_id, user_sub, mode, signal_ids, agent_id, action, symbol, side, qty, order_type, confidence, rationale, indicators)
       VALUES ($1,$2,'live','{}','operator-smoke','buy',$3,'buy',$4,'market',1,$5,$6)`,
      [decisionId, SUB, SYMBOL, QTY, `Operator-requested one-share LIVE smoke test of the Schwab write path (engine halted via TRADING_HALT; direct venue call).`, JSON.stringify({ reason: 'smoke-test' })]);
    await c.query(
      `INSERT INTO oshal_trading_orders (user_sub, mode, decision_id, broker, broker_order_id, client_order_id, symbol, side, qty, order_type, status, raw_status, filled_qty, filled_avg_price, submitted_at)
       VALUES ($1,'live',$2,'schwab',$3,$4,$5,'buy',$6,'market','filled',$7,$6,$8,now())`,
      [SUB, decisionId, String(orderId), 'smoke-' + Date.now(), SYMBOL, QTY, String(ord.status), avgFill]);
    step('ledger: decision + order recorded (source operator-smoke)');
    console.log(JSON.stringify({ ok: true, symbol: SYMBOL, qty: QTY, orderId, fill: avgFill, position: p ? p.longQuantity : 0 }));
  } finally { c.release(); await pool.end(); }
})().catch((e) => { console.error('SMOKE_FAIL: ' + (e.message || e)); process.exit(1); });
