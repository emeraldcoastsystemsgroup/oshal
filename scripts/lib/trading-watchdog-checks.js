/**
 * Trading watchdog CHECKS - the decidable half of scripts/trading-watchdog.ps1.
 *
 * The PowerShell watchdog fetches (docker exec / HTTP) and delivers (Raise / email); every
 * DECISION about whether a book is silently wrong lives here, as pure functions over plain
 * objects. No I/O, no docker, no database, no clock of its own (callers pass nowMs) - which is
 * what makes each check mutation-provable in tests/unit/trading-watchdog-checks.spec.ts rather
 * than only source-pinned inside a .ps1.
 *
 * THE RULE THIS FILE ENFORCES, IN CODE: a check must NEVER pass because data was missing. Every
 * broker number goes through toNumber() (a finite number or a plain numeric string - Postgres
 * returns qty as "73.000000" and a NaN/'N/A'/'1,234' must not silently become 0), every list goes
 * through requireArray(), and a violation throws WatchdogDataError so the caller reports an ERROR
 * finding instead of an empty, healthy-looking result.
 *
 * Loaded by the container-side fetchers the watchdog docker-cp's in (see trading-watchdog.ps1
 * block E/G and F) and by the spec directly.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the watchdog's decidable checks: strict broker-number parsing, one shared working-order-status list, per-book bleed / stranded-sell / deep-loss / buying-power / position-count / concentration assessment, per-symbol alert hysteresis with one-shot recovery, and the pre-market gap print's size/recency/quote-mid corroboration.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Round-2 review fixes: the hysteresis band now measures from the severity at the LAST ALERT instead of a ratcheted high-water mark (a name drifting -6 -> -8 -> -10 -> -12 in 10-minute steps was suppressed for the whole window); the position-count and concentration floors count MATERIAL positions only, so dust cannot page about a runaway entry loop; and defaultSettings reports an unparseable setting through onInvalid rather than silently defaulting. Adds httpTimeoutSec (the per-read deadline the container-side fetcher applies).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Round-3 review fixes. The two ACCOUNT findings carry a worsening band derived from their own scale (negative funds re-pages when the hole doubles, the position count a quarter of the floor further out); with band null a book could go from -$100 to -$100,000 of buying power and stay silent for the rest of the window. The no-cost-basis warning now respects the materiality floor, so a book of delisted zero-basis dust no longer emits a wall of warnings. And the working-sell JSDoc says what the data actually is: the ORDER LEDGER's opinion (a capped page of oshal_trading_orders), not a venue query - a stale 'accepted' row silences that symbol's bleed finding, which is why the deep-loss check reports a held position regardless of any working sell.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | bleedBookSet + the bleed scope. The BLEED finding asserts "nothing is exiting this position", which is a defect only on a book something MANAGES; on a hand-traded book every position legitimately has no working sell, so the check reported the operator's own strategy back as a failure. evaluateBook now gates the bleed loop on settings.bleedBooks (empty = every book, so an unset or unreadable value fails OPEN rather than muting the one book that needed watching). Deep-loss is deliberately NOT scoped and moved into its own rth block: a position past every shipped stop is worth saying out loud on a hand-traded book too, and scoping both would trade alert noise for a real blind spot on real money.
 */
'use strict';

/**
 * The order statuses that mean "this order is still working at the venue". ONE list for every
 * watchdog conclusion about protection (the live bleed check and the per-book audit both call
 * isWorkingSell), so the two paths can no longer drift apart. The kernel keeps its own copies
 * (trading-dispatch-rail.ts IN_FLIGHT_STATUSES, trading-reconcile.ts OPEN_STATUSES); this is the
 * watchdog's single copy and tests/unit/trading-watchdog-checks.spec.ts fails when it drifts from
 * the kernel's - it is not a claim that the platform has one source of truth.
 */
const WORKING_ORDER_STATUSES = ['pending', 'accepted', 'partially_filled'];

/** Thrown when a broker payload cannot be read exactly. Callers must report, never assume healthy. */
class WatchdogDataError extends Error {
  /**
   * @description Builds the fail-closed data error.
   * @param {string} message - What could not be read, naming the field.
   */
  constructor(message) {
    super(message);
    this.name = 'WatchdogDataError';
  }
}

const NUMERIC = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * @description Strict broker-number parse: a finite number, or a string that is ENTIRELY a plain
 * decimal number (the shape Postgres numerics arrive in). Anything else - null, undefined, '',
 * 'N/A', '1,234', NaN, Infinity, an object - throws, because a watchdog that reads a bad number as
 * 0 concludes "flat and healthy" about a book it could not actually read.
 * @param {unknown} value - The raw broker/ledger value.
 * @param {string} field - Field name for the error text (e.g. 'AAPL.qty').
 * @returns {number} The finite numeric value.
 */
function toNumber(value, field) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WatchdogDataError('unparseable ' + field + ': ' + String(value));
    return value;
  }
  if (typeof value === 'string' && NUMERIC.test(value.trim())) {
    const n = Number(value.trim());
    if (!Number.isFinite(n)) throw new WatchdogDataError('unparseable ' + field + ': ' + value);
    return n;
  }
  throw new WatchdogDataError('unparseable ' + field + ': ' + JSON.stringify(value === undefined ? null : value));
}

/**
 * @description Asserts a payload field really is an array. A 503/error body that parses to an
 * object must not read as "no positions" (the 2026-07 fail-closed lesson, kept in code).
 * @param {unknown} value - Candidate array.
 * @param {string} field - Field name for the error text.
 * @returns {Array<any>} The same array.
 */
function requireArray(value, field) {
  if (!Array.isArray(value)) throw new WatchdogDataError('missing ' + field + ' (expected an array, got ' + typeof value + ')');
  return value;
}

/**
 * @description Upper-cased non-empty symbol, or a throw. Prevents an undefined symbol becoming
 * the string 'UNDEFINED' and silently never matching a working sell.
 * @param {unknown} value - Candidate symbol.
 * @param {string} field - Field name for the error text.
 * @returns {string} Upper-cased symbol.
 */
function requireSymbol(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new WatchdogDataError('unparseable ' + field);
  return value.trim().toUpperCase();
}

/**
 * @description Parses the operator's core/hold list ("SPY:60,SKHY:0") into an upper-cased symbol
 * set. Core holds are exempt from rotation and every protective exit BY DESIGN, so every loss
 * conclusion below excludes them (the 2026-07-13 SKHY false positive).
 * @param {string} raw - TRADING_CORE_SYMBOLS as the container reports it.
 * @returns {Set<string>} Upper-cased symbols (possibly empty).
 */
function coreSymbolSet(raw) {
  return new Set(String(raw || '').split(',').map((x) => String(x).split(':')[0].trim().toUpperCase()).filter(Boolean));
}

/**
 * @description Parses the operator's bleed-alert book allow-list ("live,b-77146871") into a set of
 * book refs. The BLEED finding says "nothing is exiting this position" - which is only a defect for
 * a book something is supposed to be managing. On a book the operator trades by hand, every open
 * position legitimately has no working sell, so the check reports the operator's own strategy back
 * to them as a failure.
 *
 * EMPTY MEANS EVERY BOOK, deliberately. This gates a safety check, so an unset, blank or unreadable
 * value must fail OPEN (alert on everything) rather than silently muting the one book that needed
 * watching. Only a non-empty list narrows it.
 * @param {string} raw - TRADING_WD_BLEED_BOOKS as the operator set it.
 * @returns {Set<string>} Book refs (possibly empty, meaning "no restriction").
 */
function bleedBookSet(raw) {
  return new Set(String(raw || '').split(',').map((x) => String(x).trim()).filter(Boolean));
}

/**
 * @description True when an order row is a SELL that the LEDGER still calls working, per the one
 * shared status list. Unknown/absent status is NOT working (a filled/rejected order protects
 * nothing). READ THIS AS "the ledger says an exit is working", never "the venue holds an exit":
 * the rows come from the api's /orders read over oshal_trading_orders, so a row still saying
 * 'accepted' after the venue filled or cancelled it makes this return true - a fail-OPEN direction
 * that silences that symbol's bleed finding and depends on trading-reconcile keeping the ledger
 * honest. The deep-loss check exists partly because of that: it reports a held position REGARDLESS
 * of any working sell.
 * @param {{side?:unknown, status?:unknown}} order - Ledger/broker order row.
 * @returns {boolean} Whether the ledger considers it a resting protective sell.
 */
function isWorkingSell(order) {
  const side = String((order && order.side) || '').toLowerCase();
  const status = String((order && order.status) || '').toLowerCase();
  return side === 'sell' && WORKING_ORDER_STATUSES.indexOf(status) >= 0;
}

/**
 * @description The symbols the ORDER LEDGER shows at least one working sell for. The caller's
 * /orders read is a ledger page (the store's order-flow route selects the 100 most recent rows for
 * the book), so on a busy book an older stranded sell can fall off the page and go unseen - the
 * stranded-sell finding is "of the recent orders", not "of everything resting".
 * @param {Array<any>} orders - Order rows.
 * @returns {Set<string>} Upper-cased symbols.
 */
function workingSellSymbols(orders) {
  const out = new Set();
  for (const o of requireArray(orders, 'orders')) if (isWorkingSell(o)) out.add(requireSymbol(o.symbol, 'order.symbol'));
  return out;
}

/**
 * @description Normalizes broker positions into the shape every loss check reads, parsing every
 * number strictly. plPct is null (never 0) when cost basis is non-positive, so an undecidable
 * position is reported as a warning rather than silently counted as flat.
 * @param {Array<any>} positions - Broker position rows.
 * @returns {Array<{symbol:string, qty:number, cost:number, marketValue:number, pl:number, plPct:(number|null)}>} Normalized positions.
 */
function normalizePositions(positions) {
  return requireArray(positions, 'positions').map((p, i) => {
    const symbol = requireSymbol(p && p.symbol, 'positions[' + i + '].symbol');
    const qty = toNumber(p.qty, symbol + '.qty');
    const avgEntryPrice = toNumber(p.avgEntryPrice, symbol + '.avgEntryPrice');
    const marketValue = toNumber(p.marketValue, symbol + '.marketValue');
    const pl = toNumber(p.unrealizedPl, symbol + '.unrealizedPl');
    const cost = Math.abs(qty * avgEntryPrice);
    return { symbol, qty, cost, marketValue, pl, plPct: cost > 0 ? (pl / cost) * 100 : null };
  });
}

/**
 * @description Positions material enough to conclude anything about: |market value| at or above
 * the floor. A worthless delisted holding (real example: 42689 shares worth $0.04 at -100%) would
 * otherwise page forever and train the operator to ignore the whole family.
 * @param {Array<{marketValue:number}>} positions - Normalized positions.
 * @param {number} minValueUsd - Materiality floor in account currency.
 * @returns {Array<any>} The material subset.
 */
function materialPositions(positions, minValueUsd) {
  return positions.filter((p) => Math.abs(p.marketValue) >= minValueUsd);
}

/**
 * @description UNPROTECTED BLEEDERS: material, non-core positions down at least alertPct with NO
 * working sell resting for them. The 2026-07-07 incident shape.
 * @param {Array<any>} positions - Normalized positions.
 * @param {Set<string>} sells - Symbols with a working sell.
 * @param {Set<string>} core - Core/hold symbols to exclude.
 * @param {number} alertPct - Positive percent threshold.
 * @param {number} minValueUsd - Materiality floor.
 * @returns {Array<{symbol:string, plPct:number, pl:number}>} Findings, worst first.
 */
function findBleeders(positions, sells, core, alertPct, minValueUsd) {
  return materialPositions(positions, minValueUsd)
    .filter((p) => p.plPct !== null && p.plPct <= -alertPct && !sells.has(p.symbol) && !core.has(p.symbol))
    .map((p) => ({ symbol: p.symbol, plPct: p.plPct, pl: p.pl }))
    .sort((a, b) => a.plPct - b.plPct);
}

/**
 * @description UNCOVERED POSITION, honestly narrowed: a material, non-core position held past
 * deepLossPct - deeper than every shipped risk posture's stopLossPct. The autopilot rests no venue
 * stops, so this cannot mean "a stop is missing"; it means the loop's own synthetic stop should
 * have closed this name and the book still holds it. Reported regardless of working sells, because
 * a resting sell that never fills is exactly the 2026-07-07 lockout.
 * @param {Array<any>} positions - Normalized positions.
 * @param {Set<string>} core - Core/hold symbols to exclude.
 * @param {number} deepLossPct - Positive percent threshold.
 * @param {number} minValueUsd - Materiality floor.
 * @returns {Array<{symbol:string, plPct:number, pl:number}>} Findings, worst first.
 */
function findDeepLosses(positions, core, deepLossPct, minValueUsd) {
  return materialPositions(positions, minValueUsd)
    .filter((p) => p.plPct !== null && p.plPct <= -deepLossPct && !core.has(p.symbol))
    .map((p) => ({ symbol: p.symbol, plPct: p.plPct, pl: p.pl }))
    .sort((a, b) => a.plPct - b.plPct);
}

/**
 * @description STRANDED SELLS: working sells older than maxAgeMin (a limit the market fell away
 * from - the 07-07 lockout signature). An unparseable timestamp throws rather than reading as new.
 * @param {Array<any>} orders - Order rows.
 * @param {number} nowMs - Caller's clock.
 * @param {number} maxAgeMin - Age threshold in minutes.
 * @returns {Array<{symbol:string, qty:number, limitPrice:(number|null), ageMin:number}>} Findings, oldest first.
 */
function findStrandedSells(orders, nowMs, maxAgeMin) {
  const out = [];
  for (const o of requireArray(orders, 'orders')) {
    if (!isWorkingSell(o)) continue;
    const symbol = requireSymbol(o.symbol, 'order.symbol');
    const at = Date.parse(o.created_at || o.createdAt || o.submitted_at);
    if (!Number.isFinite(at)) throw new WatchdogDataError('unparseable created_at for working sell ' + symbol);
    const ageMin = Math.round((nowMs - at) / 60000);
    if (ageMin > maxAgeMin) {
      out.push({ symbol, qty: toNumber(o.qty, symbol + '.qty'), limitPrice: o.limit_price === null || o.limit_price === undefined ? null : toNumber(o.limit_price, symbol + '.limit_price'), ageMin });
    }
  }
  return out.sort((a, b) => b.ageMin - a.ageMin);
}

/**
 * @description ACCOUNT-SHAPE audit: negative buying power / negative cash, an open-position count
 * above the watchdog's coarse anomaly floor, and single-name concentration above its floor. These
 * floors are NOT the engine's risk policy - they sit above every shipped posture's caps on purpose,
 * so they fire on a structurally wrong book (a runaway entry loop, a mis-sized order) and not on a
 * posture change. Core holds are excluded from concentration, as they are from every loss check.
 * @param {any} account - Broker account snapshot ({cash, buyingPower, equity}).
 * @param {Array<any>} positions - Normalized positions.
 * @param {{maxPositions:number, concentrationPct:number, core:Set<string>, minPositionUsd?:number}} limits - Watchdog floors.
 * @returns {{cash:number, buyingPower:number, equity:number, negativeBuyingPower:boolean, negativeCash:boolean, positionCount:number, positionCountOver:boolean, concentration:Array<{symbol:string, weightPct:number, marketValue:number}>, warnings:Array<string>}} Assessment.
 */
function assessAccount(account, positions, limits) {
  if (!account || typeof account !== 'object') throw new WatchdogDataError('missing account snapshot');
  const cash = toNumber(account.cash, 'account.cash');
  const buyingPower = toNumber(account.buyingPower, 'account.buyingPower');
  const equity = toNumber(account.equity, 'account.equity');
  // MATERIAL open positions only. Dust (a delisted lot worth $0.04) is exactly what the
  // materiality floor exists to keep out of a conclusion, and counting it toward the position-count
  // anomaly floor would page about a runaway entry loop that is not there.
  const held = materialPositions(positions.filter((p) => p.qty !== 0), Number(limits.minPositionUsd) || 0);
  const warnings = [];
  let concentration = [];
  if (equity > 0) {
    concentration = held
      .filter((p) => !limits.core.has(p.symbol) && (Math.abs(p.marketValue) / equity) * 100 > limits.concentrationPct)
      .map((p) => ({ symbol: p.symbol, weightPct: (Math.abs(p.marketValue) / equity) * 100, marketValue: p.marketValue }))
      .sort((a, b) => b.weightPct - a.weightPct);
  } else {
    warnings.push('account equity is ' + equity + ' - concentration could not be computed');
  }
  return {
    cash, buyingPower, equity,
    negativeBuyingPower: buyingPower < 0, negativeCash: cash < 0,
    positionCount: held.length, positionCountOver: held.length > limits.maxPositions,
    concentration, warnings,
  };
}

const pct = (n) => (Math.round(n * 10) / 10).toFixed(1);
const usd = (n) => Math.round(n).toString();

/**
 * @description Builds one finding: the alert key (stable across runs - never a symbol SET, whose
 * churn minted a new key every run and defeated suppression in 2026-07-08), the severity the
 * hysteresis band compares, and the operator-facing message naming the book and the action.
 * @param {string} kind - Check family (also the key prefix).
 * @param {string} ref - Book ref the finding belongs to.
 * @param {(string|null)} symbol - Symbol, when the finding is per-name.
 * @param {number} severity - Positive, increasing with badness.
 * @param {(number|null)} band - Severity increase that re-alerts inside the window; null = window only.
 * @param {string} message - The alert text.
 * @returns {{kind:string, ref:string, symbol:(string|null), key:string, severity:number, band:(number|null), message:string}} The finding.
 */
function finding(kind, ref, symbol, severity, band, message) {
  return { kind, ref, symbol: symbol || null, key: kind + '-' + ref + (symbol ? '-' + symbol : ''), severity, band, message };
}

/**
 * @description Turns one book's reads into findings. `rth` gates only the LOSS conclusions
 * (pre/post-market the autopilot rests no intraday sells by design); account shape and stranded
 * sells are true at any hour. Throws WatchdogDataError on anything unreadable - the caller turns
 * that into an error finding, never an empty healthy result.
 * @param {{ref:string, enabled:boolean}} book - The book being audited.
 * @param {{account:any, positions:Array<any>, orders:Array<any>}} data - Its caller-scoped reads.
 * @param {any} settings - Thresholds (see defaultSettings) plus core (Set), rth (boolean), nowMs.
 * @returns {{ref:string, findings:Array<any>, warnings:Array<string>, positionCount:number}} Assessment.
 *
 * Two decisions worth knowing before reading the body:
 * BANDS on the two ACCOUNT findings (round-3 review). With band null they paged once per window no
 * matter how much worse they got, so a book going from -$100 to -$100,000 of buying power, or from
 * 41 to 400 open positions, stayed silent for the rest of the hour. Both bands come from the
 * finding's own scale rather than a new knob: negative funds re-pages when the hole DOUBLES
 * (severity - prior > severity/2 is exactly "prior was less than half"), and the position count
 * re-pages a quarter of the floor further out (10 more names at the default 40).
 * BLEED AND DEEP-LOSS BOTH FIRE for one name that is deep enough with no working sell, on purpose:
 * they are different failures (nothing is exiting it vs the loop's own stop should already have
 * closed it) with different keys and different bands, and collapsing them would hide the second
 * whenever the first is suppressed.
 */
function evaluateBook(book, data, settings) {
  const ref = String(book.ref);
  const positions = normalizePositions(data.positions);
  const sells = workingSellSymbols(data.orders);
  const acct = assessAccount(data.account, positions, { maxPositions: settings.maxPositions, concentrationPct: settings.concentrationPct, core: settings.core, minPositionUsd: settings.minPositionUsd });
  // MATERIAL positions only, like every conclusion: a book full of delisted zero-basis dust would
  // otherwise emit a wall of 'audit warning:' lines the operator learns to scroll past.
  const warnings = acct.warnings.concat(materialPositions(positions, settings.minPositionUsd)
    .filter((p) => p.plPct === null)
    .map((p) => 'position ' + p.symbol + ' in book ' + ref + ' has no cost basis - its loss percent could not be decided'));
  const out = [];
  const off = book.enabled ? '' : ' (this book is DISABLED: it takes no new risk, but its protective exits still run and its positions are still real money.)';
  if (acct.negativeBuyingPower || acct.negativeCash) {
    const hole = Math.abs(Math.min(acct.buyingPower, acct.cash));
    out.push(finding('acct-negative-funds', ref, null, hole, hole / 2,
      'Book ' + ref + ' reports NEGATIVE funds: buying power $' + usd(acct.buyingPower) + ', cash $' + usd(acct.cash) + ', equity $' + usd(acct.equity) + '. A negative balance means an order sized against money the account does not have (or an unsettled-funds violation on a cash account). Stop new entries for this book and reconcile with the venue.' + off));
  }
  if (acct.positionCountOver) {
    out.push(finding('acct-position-count', ref, null, acct.positionCount, Math.max(1, settings.maxPositions / 4),
      'Book ' + ref + ' holds ' + acct.positionCount + ' open positions worth $' + settings.minPositionUsd + ' or more, above the watchdog floor of ' + settings.maxPositions + ' (TRADING_WD_MAX_POSITIONS - a coarse anomaly floor above every shipped risk posture, not the engine policy). Either the entry loop is not respecting maxPositions or the book is being traded by something else. Check the autopilot run summaries for this book.' + off));
  }
  for (const c of acct.concentration) {
    out.push(finding('acct-concentration', ref, c.symbol, c.weightPct, settings.hysteresisPct,
      'Book ' + ref + ' has ' + pct(c.weightPct) + ' percent of equity in ' + c.symbol + ' ($' + usd(c.marketValue) + ' of $' + usd(acct.equity) + '), above the watchdog floor of ' + settings.concentrationPct + ' percent (TRADING_WD_CONCENTRATION_PCT). Trim the name or confirm it is a deliberate hold (deliberate holds belong in TRADING_CORE_SYMBOLS, which this check exempts).' + off));
  }
  for (const s of findStrandedSells(data.orders, settings.nowMs, settings.staleOrderMin)) {
    out.push(finding('stranded-sell', ref, s.symbol, s.ageMin, null,
      'Book ' + ref + ' has a STRANDED sell: ' + s.symbol + ' x' + s.qty + (s.limitPrice === null ? '' : ' limit@' + s.limitPrice) + ' still working after ' + s.ageMin + ' min (a limit the market fell away from - the 2026-07-07 lockout signature, where the stranded order blocks the position from ever exiting). Cancel or reprice it.' + off));
  }
  // The bleed check is scoped to the books something is MANAGING (see bleedBookSet): an empty set
  // means every book, a non-empty one means only these. Deep-loss is deliberately NOT scoped - a
  // position past its stop is worth saying out loud on a hand-traded book too.
  const bleedScoped = !settings.bleedBooks || settings.bleedBooks.size === 0 || settings.bleedBooks.has(ref);
  if (settings.rth && bleedScoped) {
    for (const b of findBleeders(positions, sells, settings.core, settings.alertPct, settings.minPositionUsd)) {
      out.push(finding('bleed', ref, b.symbol, Math.abs(b.plPct), settings.hysteresisPct,
        'Book ' + ref + ': ' + b.symbol + ' is down ' + pct(b.plPct) + ' percent ($' + usd(b.pl) + ') during regular hours with NO working sell. The strategy exits via market orders each run and rests no stops, so this is a failure only if the loop is not exiting it - confirm the autopilot is firing for this book (look for a live-loop-silent / live-exits-silent / run-errors alert).' + off));
    }
  }
  if (settings.rth) {
    for (const d of findDeepLosses(positions, settings.core, settings.deepLossPct, settings.minPositionUsd)) {
      out.push(finding('deep-loss', ref, d.symbol, Math.abs(d.plPct), settings.hysteresisPct,
        'Book ' + ref + ' is HOLDING PAST ITS STOP: ' + d.symbol + ' is down ' + pct(d.plPct) + ' percent ($' + usd(d.pl) + '), deeper than the watchdog floor of ' + settings.deepLossPct + ' percent (TRADING_WD_DEEP_LOSS_PCT, set above every shipped posture stopLossPct). The percent is the WHOLE broker position, including any operator-pinned lot. Exit it by hand or confirm why the loop is not.' + off));
    }
  }
  return { ref, findings: out, warnings, positionCount: acct.positionCount };
}

/**
 * @description Per-key alert hysteresis. One condition, one key, at most one page per window -
 * unless the condition WORSENS by more than its band, which pages again inside the window (a -6
 * percent name that becomes -22 percent must not be suppressed by its own earlier alert). Keys the
 * run evaluated and no longer finds are RECOVERED: one log line, then the key is cleared so a
 * re-entry alerts again. Keys outside the evaluated scope are left untouched, so a book that could
 * not be read this run never silently "recovers".
 * @param {Record<string, any>} priorState - The persisted state map (key -> {at, severity, kind, ref}).
 * @param {Array<any>} findings - This run's findings.
 * @param {{nowMs:number, windowMin:number, scope:{refs:Array<string>, kinds:Array<string>}}} opts - Decision inputs.
 * @returns {{alerts:Array<{key:string, message:string}>, suppressed:Array<string>, recovered:Array<string>, state:Record<string, any>}} Decisions plus the state to persist.
 */
function decideAlerts(priorState, findings, opts) {
  const prior = priorState && typeof priorState === 'object' ? priorState : {};
  const state = {};
  const alerts = [];
  const suppressed = [];
  const seen = new Set();
  for (const key of Object.keys(prior)) {
    const e = prior[key];
    if (!e || typeof e !== 'object') continue;
    if (Number.isFinite(Date.parse(String(e.at))) && opts.nowMs - Date.parse(String(e.at)) <= 24 * 3600 * 1000) state[key] = e;
  }
  for (const f of findings) {
    seen.add(f.key);
    const e = state[f.key];
    const at = e ? Date.parse(String(e.at)) : NaN;
    const stale = !Number.isFinite(at) || (opts.nowMs - at) >= opts.windowMin * 60000;
    const worsened = !!e && f.band !== null && Number.isFinite(Number(e.severity)) && f.severity - Number(e.severity) > f.band;
    if (!e || stale || worsened) {
      alerts.push({ key: f.key, message: f.message });
      state[f.key] = { at: new Date(opts.nowMs).toISOString(), severity: f.severity, kind: f.kind, ref: f.ref };
    } else {
      // The stored severity stays the severity AT THE LAST ALERT, deliberately: ratcheting it to
      // each suppressed reading made the band measure only the last 10-minute STEP, so a name
      // drifting -6 -> -8 -> -10 -> -12 (band 3) stayed suppressed the whole window even though it
      // had doubled. The baseline the operator was last told about is the one worth comparing to.
      suppressed.push(f.key);
    }
  }
  const recovered = [];
  for (const key of Object.keys(state)) {
    const e = state[key];
    if (seen.has(key)) continue;
    if (opts.scope.kinds.indexOf(String(e.kind)) < 0 || opts.scope.refs.indexOf(String(e.ref)) < 0) continue;
    recovered.push(key);
    delete state[key];
  }
  return { alerts, suppressed, recovered, state };
}

/**
 * @description Pre-market gap decision (check F). A gap pages only on a print the tape actually
 * supports: at least minSize shares, no older than maxAgeMin, dated today, AND corroborated by the
 * quote mid crossing the same threshold. One thin 1-share odd-lot print at a stale price is the
 * classic pre-market false alarm this refuses.
 * @param {{trade:any, quote:any, priorClose:unknown, todayIso:string, nowMs:number, minSize:number, maxAgeMin:number, gapPct:number}} input - Tape + thresholds.
 * @returns {{skip:string}|{alert:boolean, gap:number, midGap:number, size:number, ageMin:number, last:number, mid:number}} Decision.
 */
function assessGapPrint(input) {
  const t = input.trade;
  if (!t || input.priorClose === null || input.priorClose === undefined) return { skip: 'no prior close or no trade' };
  const close = toNumber(input.priorClose, 'priorClose');
  if (close <= 0) return { skip: 'prior close is not positive' };
  if (String(t.t || '').slice(0, 10) !== input.todayIso) return { skip: 'no pre-market print yet' };
  const size = toNumber(t.s, 'trade.size');
  if (size < input.minSize) return { skip: 'thin print (size=' + size + ' < ' + input.minSize + ')' };
  const at = Date.parse(String(t.t));
  if (!Number.isFinite(at)) throw new WatchdogDataError('unparseable trade timestamp');
  const ageMin = Math.round(((input.nowMs - at) / 60000) * 10) / 10;
  if (ageMin > input.maxAgeMin) return { skip: 'stale print (age=' + ageMin + 'min > ' + input.maxAgeMin + ')' };
  const q = input.quote;
  const bid = q ? Number(q.bp) : NaN;
  const ask = q ? Number(q.ap) : NaN;
  if (!(bid > 0) || !(ask > 0)) return { skip: 'no two-sided quote to corroborate the print' };
  const mid = (bid + ask) / 2;
  const last = toNumber(t.p, 'trade.price');
  const gap = (last / close - 1) * 100;
  const midGap = (mid / close - 1) * 100;
  return { alert: gap <= -input.gapPct && midGap <= -input.gapPct, gap, midGap, size, ageMin, last, mid };
}

/**
 * @description The check kinds a run with this `rth` flag actually evaluates. decideAlerts only
 * reconciles (recovers + clears) keys in this scope, so the loss checks going quiet outside regular
 * hours - when they are not evaluated at all - can never read as "the position recovered".
 * @param {boolean} rth - Whether the run is inside regular trading hours.
 * @returns {Array<string>} Kind names.
 */
function evaluatedKinds(rth) {
  const base = ['acct-negative-funds', 'acct-position-count', 'acct-concentration', 'stranded-sell'];
  return rth ? base.concat(['bleed', 'deep-loss']) : base;
}

/**
 * @description The watchdog's threshold defaults, applied to whatever the .env/params supply. Each
 * loss/shape floor sits ABOVE every shipped risk posture (portfolio.ts POLICIES: max stopLossPct
 * 15, max maxPositions 32, max maxPerNamePct 10) so a posture change never pages;
 * tests/unit/trading-watchdog-checks.spec.ts re-derives that from portfolio.ts and fails on drift.
 * A value that will not parse falls back to its default AND is reported through `onInvalid` - this
 * module has no logger of its own (it runs inside a container-side fetcher whose only output channel
 * is the JSON it prints), so the caller is what turns a bad setting into a visible warning instead
 * of a silent default.
 * @param {Record<string, any>} raw - Partial settings (numbers or numeric strings).
 * @param {(function(string, any, Error): void)=} onInvalid - Called with (key, rawValue, error) for
 * every value that could not be parsed. Optional; omitting it is what makes a bad setting silent.
 * @returns {Record<string, number>} Complete numeric settings.
 */
function defaultSettings(raw, onInvalid) {
  const d = { alertPct: 5, deepLossPct: 20, minPositionUsd: 100, maxPositions: 40, concentrationPct: 25, hysteresisPct: 3, staleOrderMin: 30, windowMin: 60, gapMinPrintSize: 100, gapMaxPrintAgeMin: 15, gapPct: 1, httpTimeoutSec: 20 };
  const out = {};
  for (const k of Object.keys(d)) {
    const v = raw ? raw[k] : undefined;
    let n = d[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      try { n = toNumber(v, k); } catch (e) { n = d[k]; if (typeof onInvalid === 'function') onInvalid(k, v, e); }
    }
    out[k] = n;
  }
  return out;
}

module.exports = {
  WORKING_ORDER_STATUSES, WatchdogDataError,
  toNumber, requireArray, requireSymbol, coreSymbolSet, bleedBookSet,
  isWorkingSell, workingSellSymbols, normalizePositions, materialPositions,
  findBleeders, findDeepLosses, findStrandedSells, assessAccount,
  finding, evaluateBook, evaluatedKinds, decideAlerts, assessGapPrint, defaultSettings,
};
