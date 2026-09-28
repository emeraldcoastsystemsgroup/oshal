/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - live acceptance for "Political-trades (STOCK Act) signal has never run on this box". Runs the core 'congress-disclosures' Test Lab card (the read-only world_metrics readback of congress_* rows with observed_at), reads GET /api/trading/reports/congress and requires dated rows (a ReportDate day and an observedAt on every row; the route drops any row without observed_at, so a non-empty list proves a post-deploy depth fire wrote them), then walks the surface's Add-to-watchlist step with a SYNTHETIC ticker: refuses to run if the symbol is already on the caller's watchlist, posts the symbol only (as the Add button does), reads it back, deletes it and proves it gone.
 */

'use strict';

const crypto = require('node:crypto');
const common = require('./live-acceptance-common.js');

const CASE_ID = 'congress-disclosures-live';
const KEY = 'congress';
const TITLE = 'Congressional disclosures: dated feed rows and the watchlist Add step';
const NEEDS = Object.freeze(['api']);
const CARD_ID = 'congress-disclosures';
const SOURCE = 'quiver-congress';
/** A synthetic ticker: `ZZT-` + five letters. The trading route accepts /^[A-Z.\-]{1,10}$/; no listed symbol has this shape. */
const SYNTHETIC_RE = /^ZZT-[A-Z]{5}$/;

/**
 * @description Mint a synthetic ticker that no exchange lists.
 * @param {(n: number) => Buffer} [bytes] - Random source (injectable for tests).
 * @returns {string} e.g. `ZZT-QKXWB`.
 */
function syntheticSymbol(bytes = crypto.randomBytes) {
  const letters = [...bytes(5)].map((b) => String.fromCharCode(65 + (b % 26))).join('');
  return `ZZT-${letters}`;
}

/**
 * @description Judge the disclosure list: status ok, at least one row, every row dated with a
 * ReportDate day and an observedAt timestamp from the named source.
 * @param {{status: number, json: object}} res - GET /api/trading/reports/congress.
 * @returns {{ok: boolean, detail: string, rows: number, newestDisclosure: string|null, lastObservedAt: string|null}} The judgement.
 */
function judgeDisclosures(res) {
  const base = { rows: 0, newestDisclosure: null, lastObservedAt: null };
  if (res.status === 404) return { ok: false, blocked: true, detail: 'GET /api/trading/reports/congress is not mounted (trading not installed, or a version before the list)', ...base };
  if (res.status !== 200) return { ok: false, detail: `GET /api/trading/reports/congress answered HTTP ${res.status}`, ...base };
  const body = res.json || {};
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (body.status !== 'ok') return { ok: false, detail: `the disclosure list is ${body.status || 'unknown'}: ${body.reason || 'no reason given'}`, ...base };
  if (!rows.length) return { ok: false, detail: `the disclosure list is empty: no congress_* row carries observed_at in the last ${body.windowDays || 90} days`, ...base };
  const bad = rows.filter((r) => !r || !common.ISO_DAY_RE.test(String(r.disclosureDate)) || Number.isNaN(Date.parse(r.observedAt)) || r.source !== SOURCE);
  const newestDisclosure = rows.map((r) => String(r.disclosureDate)).sort().pop() || null;
  const lastObservedAt = rows.map((r) => String(r.observedAt)).sort().pop() || null;
  const counts = { rows: rows.length, newestDisclosure, lastObservedAt };
  if (bad.length) return { ok: false, detail: `${bad.length} of ${rows.length} disclosure row(s) lack a ReportDate day, an observedAt or the ${SOURCE} source`, ...counts };
  return { ok: true, detail: `${rows.length} dated disclosure row(s); newest disclosure ${newestDisclosure}, last observed ${lastObservedAt}`, ...counts };
}

/**
 * @description Run the core card and summarise its one step.
 * @param {object} ports - api.
 * @returns {Promise<{ok: boolean, detail: string}>} The card's judgement (absent card = not ok, named).
 */
async function runCard(ports) {
  const res = await ports.api('POST', '/api/test-lab/run', { scenarioId: CARD_ID });
  const card = (Array.isArray(res.json && res.json.results) ? res.json.results : []).find((c) => c && c.id === CARD_ID);
  if (!card) return { ok: false, detail: `card ${CARD_ID} did not run (HTTP ${res.status})` };
  const step = (card.steps || [])[0] || {};
  return { ok: step.state === 'pass', detail: `card ${CARD_ID} = ${step.state}: ${String(step.detail || '').slice(0, 240)}` };
}

/**
 * @description The caller's watchlist symbols.
 * @param {object} ports - api.
 * @returns {Promise<{status: number, symbols: string[], items: object[]}>} The list.
 */
async function readWatchlist(ports) {
  const res = await ports.api('GET', '/api/trading/watchlist');
  const items = Array.isArray(res.json && res.json.items) ? res.json.items : [];
  return { status: res.status, symbols: items.map((i) => String(i.symbol || '').toUpperCase()), items };
}

/**
 * @description The Add step with a synthetic ticker, and its exact removal.
 * @param {object} ports - api.
 * @param {string} symbol - The synthetic ticker.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<{ok: boolean, detail: string}>} The Add step's judgement (cleanup is recorded on the ledger).
 */
async function watchlistStep(ports, symbol, ledger) {
  if (!SYNTHETIC_RE.test(symbol)) throw new Error(`refusing a non-synthetic symbol: ${symbol}`);
  const before = await readWatchlist(ports);
  if (before.status !== 200) return { ok: false, detail: `GET /api/trading/watchlist answered HTTP ${before.status}` };
  if (before.symbols.includes(symbol)) return { ok: false, detail: `${symbol} is already on the watchlist; the case will not touch it` };
  const added = await ports.api('POST', '/api/trading/watchlist', { symbol });
  if (added.status === 201) ledger.created('watchlist-symbol', symbol);
  let ok = added.status === 201 && added.json && added.json.item && added.json.item.symbol === symbol;
  const after = await readWatchlist(ports);
  ok = ok && after.symbols.includes(symbol);
  const detail = ok ? `Add posted ${symbol} (symbol only) and the watchlist lists it` : `Add returned HTTP ${added.status} and the watchlist ${after.symbols.includes(symbol) ? 'lists' : 'does not list'} ${symbol}`;
  if (after.symbols.includes(symbol) || added.status === 201) await removeSymbol(ports, symbol, ledger);
  return { ok, detail };
}

/**
 * @description Delete the synthetic symbol and prove it gone.
 * @param {object} ports - api.
 * @param {string} symbol - The synthetic ticker.
 * @param {common.CleanupLedger} ledger - The run's ledger.
 * @returns {Promise<void>} Resolves when recorded.
 */
async function removeSymbol(ports, symbol, ledger) {
  if (!SYNTHETIC_RE.test(symbol)) { ledger.error(`refusing to delete non-synthetic symbol ${symbol}`); return; }
  await ledger.attempt(`watchlist delete ${symbol}`, async () => {
    const res = await ports.api('DELETE', `/api/trading/watchlist/${encodeURIComponent(symbol)}`);
    if (res.status !== 200) return `DELETE /api/trading/watchlist/${symbol} returned HTTP ${res.status}`;
    const left = await readWatchlist(ports);
    if (left.status !== 200) return `the watchlist could not be re-read after the delete (HTTP ${left.status})`;
    if (left.symbols.includes(symbol)) return `${symbol} is still on the watchlist after the delete`;
    ledger.removed('watchlist-symbol', symbol);
    return null;
  });
}

/**
 * @description Run the case once.
 * @param {object} ports - api.
 * @param {object} [options] - `symbol` (a fixed synthetic ticker, tests only).
 * @returns {Promise<object>} The result with its cleanup receipt.
 */
async function run(ports, options = {}) {
  const missing = common.missingPorts(ports, NEEDS);
  if (missing.length) return common.unavailable(CASE_ID, `This runner has no ${missing.join('/')} port.`);
  const ledger = new common.CleanupLedger();
  const symbol = options.symbol || syntheticSymbol();
  let verdict;
  let evidence = { symbol };
  try {
    const card = await runCard(ports);
    const list = judgeDisclosures(await ports.api('GET', '/api/trading/reports/congress?limit=25'));
    if (list.blocked) return common.unavailable(CASE_ID, `${list.detail}.`, { card: card.detail });
    const watch = await watchlistStep(ports, symbol, ledger);
    evidence = { symbol, card: card.detail, rows: list.rows, newestDisclosure: list.newestDisclosure, lastObservedAt: list.lastObservedAt };
    const parts = `${card.detail}; ${list.detail}; ${watch.detail}.`;
    verdict = card.ok && list.ok && watch.ok ? { state: 'pass', detail: parts } : { state: 'fail', detail: parts };
  } catch (error) {
    verdict = { state: 'fail', detail: `The case crashed: ${common.errorText(error)}` };
    if (ledger.outstanding().length) await removeSymbol(ports, symbol, ledger);
  }
  return common.finish(CASE_ID, verdict, ledger, evidence);
}

module.exports = { CASE_ID, KEY, TITLE, NEEDS, SYNTHETIC_RE, syntheticSymbol, judgeDisclosures, watchlistStep, run };
