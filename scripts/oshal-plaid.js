#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — canonical Plaid data-access CLI + localhost test harness for the finance app. Reads/writes the finance-owned oshal_finance_items store (AES-256-GCM, same scheme as the connector tokens). Commands: link-sandbox (seed a Sandbox item with NO Link widget / real bank creds), items, accounts, holdings, transactions, aggregate. Read-only against real money; sandbox-only for the seed command.
 *
 * Read-only Plaid aggregation for a connected OSHAL user. Accounts are linked by the
 * user in the Finance app (Plaid Link) or seeded here for Sandbox testing.
 *
 *   PLAID_ENV=sandbox node scripts/oshal-plaid.js link-sandbox <user_sub> [institution_id]
 *   node scripts/oshal-plaid.js items       <user_sub>
 *   node scripts/oshal-plaid.js accounts     <user_sub>
 *   node scripts/oshal-plaid.js holdings     <user_sub>
 *   node scripts/oshal-plaid.js transactions <user_sub> [days]
 *   node scripts/oshal-plaid.js aggregate    <user_sub> [days]
 *
 * Exit 2 = no linked accounts for that user (link in the Finance app first).
 */
'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');

const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const PLAID_BASE = `https://${PLAID_ENV}.plaid.com`;
const SANDBOX_INSTITUTION = process.env.PLAID_SANDBOX_INSTITUTION || 'ins_109508';

function creds() { return { client_id: process.env.PLAID_CLIENT_ID || '', secret: process.env.PLAID_SECRET || '' }; }
function key() { return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'oshal-dev-secret').digest(); }
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

async function plaid(pathname, body) {
  const r = await fetch(`${PLAID_BASE}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...creds(), ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_message || `plaid ${pathname} ${r.status}`); e.plaidCode = j.error_code; throw e; }
  return j;
}

/** Mint + exchange a Sandbox public_token and persist the item for a user (test seed). */
async function linkSandbox(pool, userSub, institutionId) {
  if (PLAID_ENV !== 'sandbox') { console.error('link-sandbox requires PLAID_ENV=sandbox'); process.exit(1); }
  const pt = await plaid('/sandbox/public_token/create', {
    institution_id: institutionId || SANDBOX_INSTITUTION, initial_products: ['transactions', 'investments'],
  });
  const ex = await plaid('/item/public_token/exchange', { public_token: pt.public_token });
  let institution = 'Linked institution';
  try {
    const it = await plaid('/item/get', { access_token: ex.access_token });
    if (it.item && it.item.institution_id) {
      const inst = await plaid('/institutions/get_by_id', { institution_id: it.item.institution_id, country_codes: ['US'] });
      institution = (inst.institution && inst.institution.name) || institution;
    }
  } catch { /* label fallback */ }
  await pool.query(
    `INSERT INTO oshal_finance_items (item_id, user_sub, institution, access_token)
       VALUES ($1,$2,$3,$4) ON CONFLICT (item_id) DO UPDATE SET institution=EXCLUDED.institution, access_token=EXCLUDED.access_token`,
    [ex.item_id, userSub, institution, encrypt(ex.access_token)]);
  return { itemId: ex.item_id, institution };
}

/** Decrypt the user's linked access tokens. Exit 2 if none. */
async function tokensFor(pool, userSub) {
  const rows = (await pool.query('SELECT institution, access_token FROM oshal_finance_items WHERE user_sub=$1', [userSub])).rows;
  if (!rows.length) { console.error(`No linked accounts for ${userSub}. Link one in the Finance app (or run link-sandbox).`); process.exit(2); }
  return rows.map((r) => ({ institution: r.institution || 'Linked institution', token: decrypt(r.access_token) }));
}

async function accountsFor(pool, userSub) {
  const out = [];
  for (const t of await tokensFor(pool, userSub)) {
    const b = await plaid('/accounts/balance/get', { access_token: t.token });
    for (const a of b.accounts || []) out.push({ institution: t.institution, name: a.name, type: a.type, subtype: a.subtype, mask: a.mask, balance: a.balances && a.balances.current });
  }
  return out;
}

async function holdingsFor(pool, userSub) {
  const out = [];
  for (const t of await tokensFor(pool, userSub)) {
    let inv; try { inv = await plaid('/investments/holdings/get', { access_token: t.token }); } catch { continue; }
    const sec = new Map((inv.securities || []).map((s) => [s.security_id, s]));
    for (const h of inv.holdings || []) {
      const s = sec.get(h.security_id) || {};
      out.push({ institution: t.institution, name: s.name || s.ticker_symbol, ticker: s.ticker_symbol, quantity: h.quantity, value: h.institution_value });
    }
  }
  return out;
}

async function transactionsFor(pool, userSub, days) {
  const end = new Date(); const start = new Date(end - days * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const out = [];
  for (const t of await tokensFor(pool, userSub)) {
    let tx; try { tx = await plaid('/transactions/get', { access_token: t.token, start_date: fmt(start), end_date: fmt(end), options: { count: 250 } }); } catch (e) { out.push({ institution: t.institution, error: e.plaidCode || e.message }); continue; }
    for (const x of tx.transactions || []) out.push({ institution: t.institution, date: x.date, name: x.merchant_name || x.name, amount: x.amount, category: (x.personal_finance_category && x.personal_finance_category.primary) || (x.category && x.category[0]) });
  }
  return out;
}

(async () => {
  const [cmd, userSub, arg] = process.argv.slice(2);
  if (!cmd || !userSub) {
    console.error('usage: oshal-plaid.js <link-sandbox|items|accounts|holdings|transactions|aggregate> <user_sub> [arg]');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    let result;
    if (cmd === 'link-sandbox') result = await linkSandbox(pool, userSub, arg);
    else if (cmd === 'items') result = (await pool.query('SELECT item_id, institution, linked_at FROM oshal_finance_items WHERE user_sub=$1', [userSub])).rows;
    else if (cmd === 'accounts') result = await accountsFor(pool, userSub);
    else if (cmd === 'holdings') result = await holdingsFor(pool, userSub);
    else if (cmd === 'transactions') result = await transactionsFor(pool, userSub, arg ? parseInt(arg, 10) : 30);
    else if (cmd === 'aggregate') result = { accounts: await accountsFor(pool, userSub), holdings: await holdingsFor(pool, userSub), transactions: await transactionsFor(pool, userSub, arg ? parseInt(arg, 10) : 90) };
    else { console.error(`unknown command: ${cmd}`); process.exit(1); }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('oshal-plaid failed: ' + (err && err.message || err));
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
