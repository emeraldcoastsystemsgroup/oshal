#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Session guard for the daily recap: ask the Alpaca calendar whether a given ET date is a real trading session, so run-daily-recap.ps1 can skip weekends/holidays instead of recapping a day with no close.
 */
/*
 * alpaca-is-session.js — was/is the given ET date a US equity trading session?
 * Prints one line: "SESSION <date>" / "NO_SESSION <date>" / "CAL_ERR <date> <why>".
 * Always exits 0 — callers gate on stdout (a transient calendar error must not
 * hard-block a real trading day's recap).
 *
 *   Usage:  node alpaca-is-session.js [YYYY-MM-DD]   (default: today ET)
 */
'use strict';
try { require('dotenv').config({ quiet: true }); } catch { /* env may already be set */ }

/**
 * @description Return the first non-empty environment variable among the given names.
 * @param {...string} names - env var names in priority order.
 * @returns {string} the first non-empty value, trimmed, or ''.
 */
function envFirst(...names) { for (const n of names) { const v = process.env[n]; if (v) return v.trim(); } return ''; }

const KEY_ID = envFirst('ALPACA_PAPER_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_KEY', 'ALPAKA_KEY');
const SECRET = envFirst('ALPACA_PAPER_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET');
const BASE = (envFirst('ALPACA_PAPER_ENDPOINT', 'ALPACA_ENDPOINT', 'ALPAKA_ENDPOINT') || 'https://paper-api.alpaca.markets').replace(/\/+$/, '').replace(/\/v2$/i, '');

const etDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const date = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || etDate();

(async () => {
  try {
    const r = await fetch(`${BASE}/v2/calendar?start=${date}&end=${date}`, {
      headers: { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET },
    });
    if (!r.ok) throw new Error(`calendar HTTP ${r.status}`);
    const days = await r.json();
    // Alpaca returns the NEXT session when the range has none — match the exact date.
    console.log(Array.isArray(days) && days.some((d) => d.date === date) ? `SESSION ${date}` : `NO_SESSION ${date}`);
  } catch (e) { console.log(`CAL_ERR ${date} ${(e && e.message) || e}`); }
})();
