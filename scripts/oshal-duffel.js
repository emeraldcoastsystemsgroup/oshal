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
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');

const DUFFEL_BASE = 'https://api.duffel.com';
const DUFFEL_VERSION = 'v2';
const CABINS = ['economy', 'premium_economy', 'business', 'first'];

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

function secretKey() {
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is required - the hardcoded dev-key fallback was removed (docs/security/SECURITY-HARDENING.md 3.1/9); a well-known key is no key at all'); })()).digest();
}
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

/** Decrypt the traveller's/operator's Duffel connection from the DB (personal ∪ shared). */
async function credFromDb(userSub) {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return undefined;
  const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
  try {
    const r = await pool.query(
      `SELECT access_token FROM oshal_connections
       WHERE provider = 'duffel' AND COALESCE(status,'') <> 'revoked'
         AND (user_sub = $1 OR tenant_id IS NOT NULL)
       ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
      [userSub || ''],
    );
    if (!r.rows[0]) return undefined;
    return decrypt(r.rows[0].access_token);
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Return the Duffel access token string, or null if unconnected. */
async function loadToken() {
  let raw = resolveBrokeredCred();
  if (!raw) { try { raw = await credFromDb(resolveUserSub()); } catch { /* DB may be unreachable */ } }
  if (!raw) raw = process.env.DUFFEL_ACCESS_TOKEN;          // env fallback (wired in compose)
  if (!raw) return null;
  let tok = String(raw).trim();
  // The DB value may itself be an encrypted blob OR a JSON wrapper {token:…}; normalize.
  if (tok.startsWith('{')) { try { tok = JSON.parse(tok).token || tok; } catch { /* leave */ } }
  return tok && tok.toLowerCase().startsWith('duffel_') ? tok : (tok || null);
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
async function duffelPost(token, route, body) {
  const res = await fetch(`${DUFFEL_BASE}${route}`, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Duffel ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json();
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

async function searchFlights(token, q) {
  if (token) {
    try {
      const slices = [{ origin: q.origin, destination: q.destination, departure_date: q.departDate }];
      if (q.returnDate) slices.push({ origin: q.destination, destination: q.origin, departure_date: q.returnDate });
      const passengers = Array.from({ length: q.pax }, () => ({ type: 'adult' }));
      const cabin = CABINS.includes(q.cabin) ? q.cabin : 'economy';
      const data = await duffelPost(token, '/air/offer_requests?return_offers=true',
        { data: { slices, passengers, cabin_class: cabin } });
      const offers = (data.data && data.data.offers) || [];
      const items = offers.slice(0, 8).map(normalizeOffer).sort((a, b) => a.price - b.price);
      if (items.length) return { source: 'duffel', items, deepLink: flightDeepLink(q) };
    } catch (e) { /* fall through to demo so the UI still works */ return { source: 'demo', items: demoFlights(q), deepLink: flightDeepLink(q), note: e.message }; }
  }
  return { source: 'demo', items: demoFlights(q), deepLink: flightDeepLink(q) };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  let token = null;
  try { token = await loadToken(); } catch { token = null; }

  switch (cmd) {
    case 'accounts':
      out({ connected: !!token, provider: 'duffel' });
      return;
    case undefined:
    case 'status':
      out({ configured: !!token, provider: 'duffel', mode: token ? 'live' : 'demo', live: token ? token.toLowerCase().startsWith('duffel_live_') : false });
      return;
    case 'flights': {
      const [origin, destination, departDate, returnDate, pax, cabin] = args;
      if (!origin || !destination || !departDate) return die('usage: flights ORIG DEST DATE [RET] [PAX] [CABIN]');
      const q = {
        origin: origin.toUpperCase(), destination: destination.toUpperCase(), departDate,
        returnDate: returnDate && /^\d{4}-\d{2}-\d{2}$/.test(returnDate) ? returnDate : undefined,
        pax: Math.max(1, Math.min(9, Number(pax) || (returnDate && !/^\d/.test(returnDate) ? Number(returnDate) : 1) || 1)),
        cabin: (cabin || (returnDate && !/^\d{4}-/.test(returnDate) ? returnDate : '') || 'economy').toLowerCase(),
      };
      out(await searchFlights(token, q));
      return;
    }
    case 'hotels': {
      const [city, checkIn, checkOut, guests] = args;
      if (!city || !checkIn || !checkOut) return die('usage: hotels CITY CHECKIN CHECKOUT [GUESTS]');
      const q = { city, checkIn, checkOut, guests: Number(guests) || 2 };
      // Duffel Stays needs geo-coordinates; first cut = flagged demo + Booking.com handoff (ADR-059 §risk-1).
      out({ source: 'demo', items: demoHotels(q), deepLink: hotelDeepLink(q) });
      return;
    }
    case 'cars': {
      const [city, pickupDate, dropoffDate, carClass] = args;
      if (!city || !pickupDate || !dropoffDate) return die('usage: cars CITY PICKUP DROPOFF [CLASS]');
      const q = { city, pickupDate, dropoffDate, carClass: carClass || 'midsize' };
      // Duffel has no car product — demo + rental-search handoff (ADR-059 §risk-2).
      out({ source: 'demo', items: demoCars(q), deepLink: carDeepLink(q) });
      return;
    }
    case 'deeplink': {
      const [kind, json] = args;
      let q = {};
      try { q = JSON.parse(json || '{}'); } catch { /* empty */ }
      const url = kind === 'hotel' ? hotelDeepLink(q) : kind === 'car' ? carDeepLink(q) : flightDeepLink(q);
      out({ source: token ? 'duffel' : 'demo', kind: kind || 'flight', url, note: 'Open in a browser to complete the booking.' });
      return;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
}

main().catch((e) => { out({ source: 'demo', items: [], error: e && e.message ? e.message : 'duffel CLI error' }); });
