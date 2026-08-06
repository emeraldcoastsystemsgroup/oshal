#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Travel (ADR-059) shopping CLI.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the exact scoped OIDC subject through the shared CLI identity reader.
 *   Reads the traveller's/operator's Duffel access token from the OSHAL connector store
 *   (oshal_connections, provider='duffel'), else the DUFFEL_ACCESS_TOKEN env fallback — NO
 *   keys baked in. Mirrors scripts/oshal-walmart.js token resolution: prefer a
 *   controller-brokered credential (.oshal-cred-duffel / OSHAL_CRED_DUFFEL), else decrypt the
 *   connection from the DB, else the env token. The credential is a plain Duffel token string
 *   (duffel_test_… sandbox / duffel_live_… real).
 *
 *   FLIGHTS are REAL via the Duffel air API (offer requests). HOTELS attempt Duffel Stays when
 *   coordinates are supplied, else fall back to a flagged demo + a Booking.com deep link. CARS
 *   are demo + a rental-search deep link (Duffel has no car product). On no token / any error,
 *   every verb falls back to a clearly-flagged demo so the surface flow always works, and drops
 *   out the moment a live token returns real results — the LIVE Walmart pattern.
 *
 *   node scripts/oshal-duffel.js                                   # status digest (configured?)
 *   node scripts/oshal-duffel.js flights ORIG DEST DATE [RET] [PAX] [CABIN]   # real flight search
 *   node scripts/oshal-duffel.js hotels CITY CHECKIN CHECKOUT [GUESTS]        # stays (demo+handoff)
 *   node scripts/oshal-duffel.js cars CITY PICKUP DROPOFF [CLASS]             # cars (demo+handoff)
 *   node scripts/oshal-duffel.js deeplink flight|hotel|car '<json>'           # build a booking link
 *   node scripts/oshal-duffel.js accounts                                     # is a token connected?
 *
 * Exit 2 = no Duffel token (connect at /utilities or set DUFFEL_ACCESS_TOKEN).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Add an import-safe request-scoped operation helper and
 *   bounded provider transport. Library calls receive a Duffel token explicitly and cannot consult
 *   ambient env/files/DB; only the guarded standalone CLI keeps those compatibility fallbacks.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Read Duffel credentials through the shared v2/k2/legacy connector-token codec.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');
const { decryptToken } = require('./lib/connector-token-crypto');

const DUFFEL_BASE = 'https://api.duffel.com';
const DUFFEL_VERSION = 'v2';
const CABINS = ['economy', 'premium_economy', 'business', 'first'];
const PROVIDER_JSON_MAX_BYTES = 4 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 15_000;

// ── Identity (mirrors oshal-walmart.js — codex sandbox may not forward env) ──
function resolveUserSub() {
  return resolveExactUserSubject();
}

// ── Credential resolution: brokered → DB → env ──────────────────────────────
function resolveBrokeredCred() {
  try {
    const c = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-duffel'), 'utf8').trim();
    if (c) return c;
  } catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_DUFFEL || undefined;
}

/** Decrypt the traveller's/operator's Duffel connection from the DB (personal ∪ shared). */
async function credFromDb(userSub) {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return undefined;
  const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
  try {
    const r = await pool.query(
      `SELECT user_sub, access_token FROM oshal_connections
       WHERE provider = 'duffel' AND COALESCE(status,'') <> 'revoked'
         AND (user_sub = $1 OR tenant_id IS NOT NULL)
       ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
      [userSub || ''],
    );
    if (!r.rows[0]) return undefined;
    return decryptToken(pool, r.rows[0].user_sub, r.rows[0].access_token);
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Return the Duffel access token string, or null if unconnected. */
async function loadToken() {
  let raw = resolveBrokeredCred();
  if (!raw) { try { raw = await credFromDb(resolveUserSub()); } catch { /* DB may be unreachable */ } }
  if (!raw) raw = process.env.DUFFEL_ACCESS_TOKEN;          // env fallback (wired in compose)
  return raw ? parseLegacyToken(raw) : null;
}

/** Parse only a request-scoped Duffel token supplied by the controller. */
function parseTokenArgument(raw) {
  const token = unwrapToken(raw);
  if (!token || token.length > 4096 || /\s/u.test(token)) return null;
  return /^duffel_(?:test|live)_[A-Za-z0-9_-]{8,}$/u.test(token) ? token : null;
}

/** Preserve the standalone CLI's historical acceptance of non-empty provider test tokens. */
function parseLegacyToken(raw) {
  const token = unwrapToken(raw);
  return token && token.length <= 16_384 && !/[\u0000-\u001f\u007f]/u.test(token) ? token : null;
}

function unwrapToken(raw) {
  let candidate = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text || text.length > 16_384) return null;
    if (text.startsWith('{')) {
      try { candidate = JSON.parse(text); } catch { return null; }
    } else {
      return text;
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  return typeof candidate.token === 'string' ? candidate.token.trim() : null;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Duffel-Version': DUFFEL_VERSION,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}
async function duffelPost(token, route, body, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs >= 1 && options.timeoutMs <= 30_000
    ? options.timeoutMs
    : PROVIDER_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || fetch;
  let res;
  try {
    res = await fetchImpl(`${DUFFEL_BASE}${route}`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw duffelProviderError('Duffel provider request could not be completed.');
  }
  if (!res.ok) {
    await cancelResponseBody(res);
    throw duffelProviderError(`Duffel provider returned HTTP ${res.status}.`, res.status);
  }
  const mediaType = String(res.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json' && !(mediaType.startsWith('application/') && mediaType.endsWith('+json'))) {
    await cancelResponseBody(res);
    throw duffelProviderError('Duffel provider returned a non-JSON response.');
  }
  const declaredLength = res.headers.get('content-length');
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength.trim())
    || !Number.isSafeInteger(Number(declaredLength))
    || Number(declaredLength) > PROVIDER_JSON_MAX_BYTES)) {
    await cancelResponseBody(res);
    throw duffelProviderError('Duffel provider response exceeded the JSON byte limit.');
  }
  const bytes = await readBoundedResponse(res, PROVIDER_JSON_MAX_BYTES);
  try { return JSON.parse(bytes.toString('utf8')); } catch {
    throw duffelProviderError('Duffel provider returned invalid JSON.');
  }
}

function duffelProviderError(message, status) {
  const error = new Error(message);
  error.duffelSafeProviderError = true;
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.duffelProviderStatus = status;
  return error;
}

async function cancelResponseBody(response) {
  try { if (response && response.body) await response.body.cancel(); } catch { /* best effort */ }
}

async function readBoundedResponse(response, maximum) {
  if (!response.body) throw duffelProviderError('Duffel provider returned an empty response.');
  let reader;
  try { reader = response.body.getReader(); } catch {
    throw duffelProviderError('Duffel provider response could not be read.');
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      total += chunk.byteLength;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw duffelProviderError('Duffel provider response exceeded the JSON byte limit.');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* best effort */ }
    if (error && error.duffelSafeProviderError === true) throw error;
    throw duffelProviderError('Duffel provider response could not be read.');
  } finally {
    try { reader.releaseLock(); } catch { /* best effort */ }
  }
  if (!total) throw duffelProviderError('Duffel provider returned an empty response.');
  return Buffer.concat(chunks, total);
}

function safeDuffelProviderError(error) {
  const status = Number(error && error.duffelProviderStatus);
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? `Duffel provider returned HTTP ${status}.`
    : 'Duffel provider request could not be completed.';
}

// ── Normalizers ───────────────────────────────────────────────────────────────
function isoMinutes(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/); // ISO-8601 duration
  if (!m) return null;
  return (Number(m[1] || 0) * 1440) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}
function hm(mins) {
  if (mins == null) return null;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
/** A Duffel offer → a flat card the surface/bot can use. */
function normalizeOffer(o) {
  const slices = (o.slices || []).map((s) => {
    const segs = s.segments || [];
    const first = segs[0] || {};
    const last = segs[segs.length - 1] || {};
    return {
      origin: (s.origin && s.origin.iata_code) || first.origin?.iata_code || '',
      destination: (s.destination && s.destination.iata_code) || last.destination?.iata_code || '',
      departAt: first.departing_at || null,
      arriveAt: last.arriving_at || null,
      duration: hm(isoMinutes(s.duration)),
      stops: Math.max(0, segs.length - 1),
      carriers: [...new Set(segs.map((g) => g.marketing_carrier?.name).filter(Boolean))],
    };
  });
  return {
    id: o.id,
    price: Number(o.total_amount),
    currency: o.total_currency || 'USD',
    airline: (o.owner && o.owner.name) || slices[0]?.carriers?.[0] || '',
    cabin: (o.slices?.[0]?.segments?.[0]?.passengers?.[0]?.cabin_class) || null,
    slices,
    expiresAt: o.expires_at || null,
  };
}

// ── Deep links (the booking handoff) ──────────────────────────────────────────
function flightDeepLink(q) {
  // Duffel can BOOK via API later; today we hand off a Google Flights search for the slice.
  const o = encodeURIComponent(q.origin || ''), d = encodeURIComponent(q.destination || '');
  const date = encodeURIComponent(q.departDate || '');
  const ret = q.returnDate ? `%20through%20${encodeURIComponent(q.returnDate)}` : '';
  return `https://www.google.com/travel/flights?q=Flights%20from%20${o}%20to%20${d}%20on%20${date}${ret}`;
}
function hotelDeepLink(q) {
  const where = encodeURIComponent(q.city || q.destination || '');
  const ci = encodeURIComponent(q.checkIn || ''), co = encodeURIComponent(q.checkOut || '');
  return `https://www.booking.com/searchresults.html?ss=${where}&checkin=${ci}&checkout=${co}`;
}
function carDeepLink(q) {
  const where = encodeURIComponent(q.city || q.pickup || '');
  return `https://www.kayak.com/cars/${where}/${encodeURIComponent(q.pickupDate || '')}/${encodeURIComponent(q.dropoffDate || '')}`;
}

// ── Demo catalogs ──────────────────────────────────────────────────────────────
// Shown (flagged source:'demo') when there's no working Duffel token yet, so the whole
// flow — search → cards → price read → handoff — is usable. Drops out automatically the
// moment a live token returns real results.
function demoFlights(q) {
  const base = 280 + (String(q.destination || '').length * 7);
  const mk = (airline, addPrice, stops, dur, dep) => ({
    id: `demo-${airline}-${stops}`,
    price: Number((base + addPrice).toFixed(2)),
    currency: 'USD',
    airline,
    cabin: q.cabin || 'economy',
    slices: [{
      origin: q.origin, destination: q.destination, departAt: `${q.departDate}T${dep}:00`,
      arriveAt: `${q.departDate}T${dep === '08' ? '14' : '21'}:30:00`, duration: dur, stops,
      carriers: [airline],
    }],
    expiresAt: null,
  });
  return [
    mk('Delta', 0, 0, '5h 30m', '08'),
    mk('United', -42, 1, '7h 10m', '13'),
    mk('American', 65, 0, '5h 25m', '17'),
  ];
}
function demoHotels(q) {
  const mk = (name, brand, price, rating) => ({ id: `demo-${name}`, name, brand, price, currency: 'USD', rating, city: q.city });
  return [
    mk('Grand Central Hotel', 'Marriott', 189, 4.5),
    mk('Harbor Suites', 'Hilton', 215, 4.7),
    mk('Old Town Inn', 'Independent', 142, 4.2),
  ];
}
function demoCars(q) {
  const mk = (brand, cls, price) => ({ id: `demo-${brand}-${cls}`, brand, carClass: cls, price, currency: 'USD', city: q.city });
  return [
    mk('Enterprise', 'Midsize', 41),
    mk('Hertz', 'SUV', 63),
    mk('Budget', 'Economy', 34),
  ];
}

// ── Commands ──────────────────────────────────────────────────────────────────
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function die(msg, code = 1) { process.stdout.write(JSON.stringify({ error: msg })); process.exit(code); }

async function searchFlights(token, q, options = {}) {
  if (token) {
    try {
      const slices = [{ origin: q.origin, destination: q.destination, departure_date: q.departDate }];
      if (q.returnDate) slices.push({ origin: q.destination, destination: q.origin, departure_date: q.returnDate });
      const passengers = Array.from({ length: q.pax }, () => ({ type: 'adult' }));
      const cabin = CABINS.includes(q.cabin) ? q.cabin : 'economy';
      const data = await duffelPost(token, '/air/offer_requests?return_offers=true',
        { data: { slices, passengers, cabin_class: cabin } }, options);
      const offers = (data.data && data.data.offers) || [];
      const items = offers.slice(0, 8).map(normalizeOffer).sort((a, b) => a.price - b.price);
      if (items.length) return { source: 'duffel', items, deepLink: flightDeepLink(q) };
    } catch (e) { /* fall through to demo so the UI still works */ return { source: 'demo', items: demoFlights(q), deepLink: flightDeepLink(q), note: safeDuffelProviderError(e) }; }
  }
  return { source: 'demo', items: demoFlights(q), deepLink: flightDeepLink(q) };
}

function operationUsage(message) {
  const error = new Error(message);
  error.operationUsageError = true;
  return error;
}

/** Bound route-controlled arguments before provider requests or booking-link construction. */
function operationArguments(rawArgs) {
  if (!Array.isArray(rawArgs) || rawArgs.length > 8) throw operationUsage('Duffel operation arguments are invalid');
  return rawArgs.map((value) => {
    if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw operationUsage('Duffel operation arguments are invalid');
    }
    return value;
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** Execute one travel operation using only the supplied request-local token. */
async function executeDuffelCommand(token, rawArgs, options = {}) {
  const [cmd, ...args] = operationArguments(rawArgs);
  switch (cmd) {
    case 'accounts':
      return { connected: !!token, provider: 'duffel' };
    case undefined:
    case 'status':
      return { configured: !!token, provider: 'duffel', mode: token ? 'live' : 'demo', live: token ? token.toLowerCase().startsWith('duffel_live_') : false };
    case 'flights': {
      const [rawOrigin, rawDestination, departDate, ...optional] = args;
      const origin = String(rawOrigin || '').toUpperCase();
      const destination = String(rawDestination || '').toUpperCase();
      if (!/^[A-Z]{3}$/u.test(origin) || !/^[A-Z]{3}$/u.test(destination) || !ISO_DATE.test(departDate || '')) {
        throw operationUsage('usage: flights ORIG DEST DATE [RET] [PAX] [CABIN]');
      }
      let returnDate;
      if (optional[0] && ISO_DATE.test(optional[0])) returnDate = optional.shift();
      const pax = Math.max(1, Math.min(9, Math.floor(Number(optional[0]) || 1)));
      const cabin = String(optional[1] || 'economy').toLowerCase();
      const q = {
        origin, destination, departDate, returnDate, pax,
        cabin: CABINS.includes(cabin) ? cabin : 'economy',
      };
      return searchFlights(token, q, options);
    }
    case 'hotels': {
      const [city, checkIn, checkOut, guests] = args;
      if (!city || !ISO_DATE.test(checkIn || '') || !ISO_DATE.test(checkOut || '')) {
        throw operationUsage('usage: hotels CITY CHECKIN CHECKOUT [GUESTS]');
      }
      const q = { city, checkIn, checkOut, guests: Math.max(1, Math.min(20, Math.floor(Number(guests) || 2))) };
      // Duffel Stays needs geo-coordinates; first cut = flagged demo + Booking.com handoff (ADR-059 §risk-1).
      return { source: 'demo', items: demoHotels(q), deepLink: hotelDeepLink(q) };
    }
    case 'cars': {
      const [city, pickupDate, dropoffDate, carClass] = args;
      if (!city || !ISO_DATE.test(pickupDate || '') || !ISO_DATE.test(dropoffDate || '')) {
        throw operationUsage('usage: cars CITY PICKUP DROPOFF [CLASS]');
      }
      const q = { city, pickupDate, dropoffDate, carClass: carClass || 'midsize' };
      // Duffel has no car product — demo + rental-search handoff (ADR-059 §risk-2).
      return { source: 'demo', items: demoCars(q), deepLink: carDeepLink(q) };
    }
    case 'deeplink': {
      const [kind, json] = args;
      if (!['flight', 'hotel', 'car'].includes(kind)) throw operationUsage('usage: deeplink flight|hotel|car "<json>"');
      let q = {};
      try { q = JSON.parse(json || '{}'); } catch { throw operationUsage('deeplink query JSON is invalid'); }
      if (!q || typeof q !== 'object' || Array.isArray(q)) throw operationUsage('deeplink query JSON is invalid');
      const url = kind === 'hotel' ? hotelDeepLink(q) : kind === 'car' ? carDeepLink(q) : flightDeepLink(q);
      return { source: token ? 'duffel' : 'demo', kind, url, note: 'Open in a browser to complete the booking.' };
    }
    default:
      throw operationUsage(`unknown command: ${cmd}`);
  }
}

/**
 * Request-scoped Duffel entrypoint. Missing credentials select the documented demo handoff; a
 * malformed supplied token fails closed and can never fall through to ambient token resolution.
 */
async function executeDuffelOperation(rawToken, rawArgs, options = {}) {
  let token = null;
  if (rawToken !== undefined && rawToken !== null && rawToken !== '') {
    token = parseTokenArgument(rawToken);
    if (!token) throw new Error('Duffel operation requires a valid request-scoped token');
  }
  return executeDuffelCommand(token, rawArgs, options);
}

async function main() {
  let token = null;
  try { token = await loadToken(); } catch { token = null; }
  try {
    out(await executeDuffelCommand(token, process.argv.slice(2)));
  } catch (error) {
    if (error && error.operationUsageError === true) return die(error.message);
    throw error;
  }
}

module.exports = { executeDuffelOperation, parseTokenArgument };

if (require.main === module) {
  main().catch((e) => { out({ source: 'demo', items: [], error: e && e.message ? e.message : 'duffel CLI error' }); });
}
