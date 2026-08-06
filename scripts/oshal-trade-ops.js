#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Preserve the exact acting OIDC subject in internal trading requests.
 *
 * OSHAL Trading OPERATOR CLI — backs the registered trading_* tools (ADR-052/053).
 *
 * Lets the trading-analyst bot / Jarvis TURN THE KNOBS on the signal-justified trader
 * (not just reason): start/stop the every-5-min autopilot, run the deterministic scan,
 * read positions, and place PAPER trades. Calls the LOCAL /api/trading* control surface in
 * the same container, authenticating as an INTERNAL service call (X-Service-Secret =
 * SWARM_SERVICE_SECRET) on behalf of the acting user (X-OSHAL-User-Sub = OSHAL_USER_SUB) —
 * the same session-OR-shared-secret pattern eats/rides/spotify/purchasing routes use. The cli
 * re-uses the wired engine + broker I/O; it re-implements none of it. Mirrors oshal-world.js.
 *
 * Distinct from scripts/oshal-trading.js (the DB+Alpaca shell test harness): this one is the
 * tool-executor backend ({input} JSON contract, OSHAL_USER_SUB env, HTTP to the local API).
 *
 * PAPER-ONLY: live execution stays behind the cockpit's manual confirm — no verb here ever
 * places a live order (trade sends confirm:false; the route refuses live without confirm).
 *
 * Verbs (argv[2]) with a JSON input object (argv[3], the tool's {input}):
 *   status                              -> book config + autopilot legs (every knob at a glance)
 *   autopilot {action,cron?,universe?}  -> action: enable | disable | status
 *   scan      {symbols}                 -> per-algo + ensemble signals (deterministic, no LLM)
 *   positions                           -> equity + open positions (paper book)
 *   trade     {symbol}                  -> deterministic decision -> place PAPER order
 */
'use strict';
const { resolveExactUserSubject } = require('./lib/exact-user-subject');

const PORT = process.env.PORT || '5000';
const BASE = `http://localhost:${PORT}/api/trading`;
const SECRET = (process.env.SWARM_SERVICE_SECRET || '').trim();
const USER_SUB = resolveExactUserSubject({ env: process.env, cwd: process.cwd() }) || '';

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (SECRET) h['X-Service-Secret'] = SECRET;
  if (USER_SUB) h['X-OSHAL-User-Sub'] = USER_SUB;
  return h;
}

/** Parse the tool {input} JSON (argv[3]); tolerate empty/garbage. */
function parseInput(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function req(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: headers(), body: body != null ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: j.message || j.error || ('HTTP ' + r.status) };
  return j;
}

async function run(verb, input) {
  switch (verb) {
    case 'status': {
      const [book, auto] = await Promise.all([req('GET', '/status?mode=paper'), req('GET', '/autopilot')]);
      return { book, autopilot: auto };
    }
    case 'autopilot': {
      const action = String(input.action || 'status').toLowerCase();
      if (action === 'enable' || action === 'start' || action === 'on') {
        const body = {};
        if (input.cron) body.cron = input.cron;
        if (Array.isArray(input.universe) && input.universe.length) body.universe = input.universe.map((s) => String(s).toUpperCase());
        return req('POST', '/autopilot', body);
      }
      if (action === 'disable' || action === 'stop' || action === 'off') return req('DELETE', '/autopilot');
      return req('GET', '/autopilot');
    }
    case 'scan': {
      const symbols = Array.isArray(input.symbols)
        ? input.symbols
        : String(input.symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!symbols.length) throw new Error('symbols required (array or comma-separated list)');
      return req('POST', '/scan?mode=paper', { symbols: symbols.map((s) => String(s).toUpperCase()) });
    }
    case 'positions': {
      return req('GET', '/ledger?mode=paper');
    }
    case 'trade': {
      const sym = String(input.symbol || '').toUpperCase().trim();
      if (!sym) throw new Error('symbol required');
      const d = await req('POST', '/decide-algo?mode=paper', { symbol: sym });
      if (d.ok === false) return d;
      const dec = d.decision || {};
      if (dec.action === 'hold') return { placed: false, action: 'hold', symbol: sym, rationale: dec.rationale || '' };
      const o = await req('POST', '/orders?mode=paper', { decisionId: d.decisionId, requestId: 'op-' + Date.now(), confirm: false });
      return { placed: o.ok !== false, symbol: sym, decision: dec, order: o.order || o };
    }
    default:
      return { error: `unknown verb "${verb}"`, verbs: ['status', 'autopilot', 'scan', 'positions', 'trade'] };
  }
}

async function main() {
  const verb = process.argv[2] || 'status';
  const input = parseInput(process.argv[3]);
  const out = await run(verb, input);
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });
