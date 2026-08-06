#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | DEVICE-AWARE links. The old link was the
 *   app-only universal deep link (m.uber.com/ul/) — it face-plants on a PC. Now buildRideLinks() returns
 *   BOTH: webUrl = the Uber WEB RIDER (m.uber.com/go/product-selection) that opens in any browser and
 *   shows real prices (the right link on a computer, the default), and appUrl = the /ul/ deep link for a
 *   phone. Also fixed two reasons the old link never worked: product_id was the keyword "uberx" (Uber's
 *   product_id is a region-specific UUID — dropped it; the rider picks the type in-app) and it carried no
 *   coordinates (Uber sets the pins from latitude+longitude; the address strings are display-only). Now
 *   geocodes via OpenStreetMap Nominatim (no API key) with a fallback ladder (full → drop a leading
 *   business-name segment → drop the house number); an unresolvable address falls back to its label.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Uber Rides (transportation) CLI.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | REAL distance, and the coordinates the map needs.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the exact scoped OIDC subject through the shared CLI identity reader.
 *   The estimate was a fake: pseudoKm() SHA-256-hashed the pickup+dropoff STRINGS into a 2-19.9 km
 *   pseudo-distance and every fare/ETA derived from it — so "1 Main St" and "1 Main Street" quoted
 *   different trips, and neither number meant anything. Meanwhile buildRideLinks() already geocoded
 *   BOTH endpoints (Uber sets its pins from lat/lon), so real coordinates existed and were discarded.
 *   Now: estimate geocodes both ends, measures haversine great-circle distance, and applies
 *   ROAD_FACTOR for street routing. When an address does NOT resolve the fares come back NULL with
 *   basis:'unresolved' — an honest "I can't price this" beats a confident hash. estimate/ride now
 *   share a per-process geocode cache so a rider who estimates and then books geocodes once, and
 *   Nominatim's ~1 req/s ask is honoured by a serialized queue rather than a sleep between retries.
 *   Adds `geocode` + `reverse` subcommands: the rides surface's map drops and drags pins, and it
 *   must resolve them through the SAME Nominatim contract (User-Agent, fallback ladder, rate limit)
 *   instead of hitting the public endpoint from every rider's browser. Guard:
 *   tests/unit/uber-rides-estimate.spec.ts.
 *   Reads the operator's OPTIONAL Uber Rides config from the OSHAL connector store
 *   (oshal_connections, provider='uber-rides') — connected once at /utilities, NO keys in
 *   env/compose. Mirrors scripts/oshal-uber.js credential resolution: prefer a brokered
 *   credential (.oshal-cred-uber-rides / OSHAL_CRED_UBER_RIDES), else decrypt from the DB.
 *   The credential is an OPTIONAL JSON blob: { "clientId": "...", "baseUrl": "..." }.
 *
 *   Honest reality: requesting a ride on a third party's behalf needs Uber for Business
 *   (the org pays). For a personal handoff there is the well-supported Uber UNIVERSAL DEEP
 *   LINK (m.uber.com/ul/) — this CLI builds that link with pickup + dropoff prefilled; the
 *   person opens it, and confirms + pays in their OWN Uber app/login. Fare/ETA values are
 *   clearly-labelled ESTIMATES (no live pricing API on this path).
 *
 *   node scripts/oshal-uber-rides.js                                  # status digest
 *   node scripts/oshal-uber-rides.js estimate "<pickup>" "<dropoff>"  # ride options (estimate)
 *   node scripts/oshal-uber-rides.js ride "<pickup>" "<dropoff>" [rideType]  # the request deep link
 *   node scripts/oshal-uber-rides.js geocode "<address>"              # address  -> {lat,lon,label}
 *   node scripts/oshal-uber-rides.js reverse <lat> <lon>              # a dropped pin -> an address
 *   node scripts/oshal-uber-rides.js accounts                         # is a Rides config connected?
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');

// ── Identity ────────────────────────────────────────────────────────────────
function resolveUserSub() {
  return resolveExactUserSubject();
}

// ── Credential resolution: brokered first, then DB ──────────────────────────
function resolveBrokeredCred() {
  try {
    const c = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-uber-rides'), 'utf8').trim();
    if (c) return c;
  } catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_UBER_RIDES || undefined;
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
async function credFromDb(userSub) {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return undefined;
  const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
  try {
    const r = await pool.query(
      `SELECT access_token FROM oshal_connections
       WHERE provider = 'uber-rides' AND COALESCE(status,'') <> 'revoked'
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
async function loadCred() {
  let raw = resolveBrokeredCred();
  if (!raw) raw = await credFromDb(resolveUserSub());
  if (!raw) return null;
  let parsed;
  try {
    const s = String(raw).trim();
    parsed = s.startsWith('{') ? JSON.parse(s) : { clientId: s.slice(0, 64) };
  } catch { parsed = { clientId: String(raw).slice(0, 64) }; }
  return {
    clientId: String(parsed.clientId || parsed.client_id || '').trim(),
    baseUrl: String(parsed.baseUrl || 'https://m.uber.com').replace(/\/$/, ''),
  };
}
function baseUrlOf(cred) { return (cred && cred.baseUrl) || 'https://m.uber.com'; }

// ── Ride types + distance-based estimate ─────────────────────────────────────
// No live pricing API on the deep-link path, so the fare is MODELLED — but it is modelled on the
// real distance between the two geocoded pins, not on the address text. The REAL fare shows in the
// rider's Uber app at confirm time; everything here stays labelled `estimate: true`.
const RIDE_TYPES = [
  { key: 'uberx',   label: 'UberX',   emoji: '🚗', seats: 4, base: 9,  perKm: 1.1 },
  { key: 'comfort', label: 'Comfort', emoji: '🚙', seats: 4, base: 12, perKm: 1.4 },
  { key: 'xl',      label: 'UberXL',  emoji: '🚐', seats: 6, base: 15, perKm: 1.8 },
  { key: 'black',   label: 'Uber Black', emoji: '🚘', seats: 4, base: 22, perKm: 2.6 },
];
// Streets are not great circles. 1.3 is the widely-used detour ratio for urban road networks —
// it is a stated modelling assumption, not a measured route, which is why `basis` says so.
const ROAD_FACTOR = 1.3;
const AVG_SPEED_KMH = 32; // door-to-door city average incl. lights/turns

/**
 * Great-circle distance between two {lat,lon} points, in kilometres.
 *
 * @description The honest half of the estimate: this is a real measurement over real coordinates.
 *   The modelling (road factor, fare curve) sits on top of it and is labelled as modelling.
 * @param {{lat:number,lon:number}} a - first point
 * @param {{lat:number,lon:number}} b - second point
 * @returns {number} distance in km
 */
function haversineKm(a, b) {
  const R = 6371; // mean earth radius, km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Build the ride options for a trip of a known road distance.
 *
 * @description `distanceKm` null means we could not place one of the pins. In that case every fare
 *   comes back NULL rather than a plausible-looking number — a rider who is shown "$14-18" for a
 *   trip we could not locate has been lied to, and the old hash did exactly that. The option rows
 *   still render (seats, ride type) so the surface can offer the handoff; only the money is absent.
 * @param {number|null} distanceKm - road-adjusted distance, or null when unresolved
 * @param {number|null} pickupEtaMin - minutes to pickup, or null when unknown
 * @returns {Array<object>} one row per ride type
 */
function buildRideOptions(distanceKm, pickupEtaMin) {
  const known = typeof distanceKm === 'number' && Number.isFinite(distanceKm);
  return RIDE_TYPES.map((t) => {
    const fare = known ? t.base + t.perKm * distanceKm : null;
    return {
      type: t.key, label: t.label, emoji: t.emoji, seats: t.seats,
      fareLow: known ? Math.round(fare * 0.9) : null,
      fareHigh: known ? Math.round(fare * 1.15) : null,
      etaPickupMin: pickupEtaMin,
      tripMin: known ? Math.max(4, Math.round((distanceKm / AVG_SPEED_KMH) * 60 + 3)) : null,
      estimate: true,
    };
  });
}

/**
 * Price a trip from its two endpoints.
 *
 * @description Geocodes both ends (through the shared cache), measures, and prices. `basis` tells
 *   the caller exactly how much to trust the number: 'geocoded' = measured between two resolved
 *   pins; 'unresolved' = at least one address did not geocode, so fares are null.
 * @param {string} pickup - pickup address, or "my location"
 * @param {string} dropoff - destination address
 * @returns {Promise<{options:Array<object>,distanceKm:number|null,basis:string,coords:object}>}
 */
async function estimateRides(pickup, dropoff) {
  const isMyLocation = !pickup || /my location|current/i.test(pickup);
  const [pg, dg] = await Promise.all([
    isMyLocation ? Promise.resolve(null) : geocode(pickup),
    dropoff ? geocode(dropoff) : Promise.resolve(null),
  ]);
  const straightKm = pg && dg ? haversineKm(pg, dg) : null;
  const distanceKm = straightKm === null ? null : Math.round(straightKm * ROAD_FACTOR * 10) / 10;
  // Minutes to pickup is genuinely unknowable without Uber's driver supply — it is not modelled
  // from the address any more. The surface shows Uber's own ETA once the rider opens the handoff.
  const options = buildRideOptions(distanceKm, null);
  return {
    options,
    distanceKm,
    straightLineKm: straightKm === null ? null : Math.round(straightKm * 10) / 10,
    basis: distanceKm === null ? 'unresolved' : 'geocoded',
    roadFactor: ROAD_FACTOR,
    coords: { pickup: pg, dropoff: dg },
  };
}

/**
 * Geocode an address → {lat, lon} via OpenStreetMap Nominatim (no API key needed). Best-effort:
 * returns null on any failure so the link still builds from the address text. Uber's deep link sets
 * the pickup/dropoff pins from latitude/longitude — without them the route never prefills (the
 * formatted_address/nickname fields are display-only labels). Nominatim asks for a User-Agent.
 */
/** Address variants to try, broadest-useful first — Nominatim chokes on a business-name prefix or an
 *  exact house number, so we fall back to the bare street / street-level, which is close enough to drop
 *  a pin the rider confirms in-app. */
function geoCandidates(address) {
  const out = [address];
  const segs = address.split(',').map((s) => s.trim()).filter(Boolean);
  // Drop a leading business-name segment ("Hurricane Lanes, 34876 …" → "34876 …").
  if (segs.length > 1 && !/^\d/.test(segs[0])) out.push(segs.slice(1).join(', '));
  // Drop a leading house number ("34876 Emerald Coast Pkwy …" → "Emerald Coast Pkwy …").
  const base = (segs.length > 1 && !/^\d/.test(segs[0])) ? segs.slice(1) : segs.slice();
  if (base.length) { const noNum = base[0].replace(/^\d+\s+/, ''); if (noNum !== base[0]) out.push([noNum, ...base.slice(1)].join(', ')); }
  return [...new Set(out)];
}
// Nominatim's usage policy asks for at most ~1 request/second from an application, with a real
// User-Agent. A sleep between RETRIES was not enough once estimate and ride both geocode and the
// surface geocodes on every pin drag: serialize every call through one promise chain so concurrent
// callers queue instead of bursting, and cache per process so the same address is asked once.
const NOMINATIM_UA = 'oshal-uber-rides/1.1 (+https://github.com/emeraldcoastsystemsgroup/oshal)';
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const geoCache = new Map();
let nominatimChain = Promise.resolve();
let lastNominatimAt = 0;

/**
 * Run a Nominatim request behind the shared rate limiter.
 *
 * @description Every outbound call to the public endpoint goes through here — one at a time, never
 *   closer together than NOMINATIM_MIN_INTERVAL_MS. Callers just await; the queueing is invisible.
 * @param {URL} url - the fully-built Nominatim URL
 * @returns {Promise<any|null>} parsed JSON, or null on any failure
 */
function nominatim(url) {
  const run = nominatimChain.then(async () => {
    const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimAt);
    if (wait > 0) await new Promise((s) => setTimeout(s, wait));
    lastNominatimAt = Date.now();
    try {
      const r = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  });
  // Keep the chain alive even when one call rejects, or every later lookup inherits the rejection.
  nominatimChain = run.then(() => undefined, () => undefined);
  return run;
}

async function geocode(address) {
  if (!address) return null;
  const key = `f:${address.trim().toLowerCase()}`;
  if (geoCache.has(key)) return geoCache.get(key);
  let hit = null;
  for (const cand of geoCandidates(address)) {
    const u = new URL('https://nominatim.openstreetmap.org/search');
    u.searchParams.set('format', 'json');
    u.searchParams.set('q', cand);
    u.searchParams.set('limit', '1');
    const j = await nominatim(u);
    if (Array.isArray(j) && j[0] && j[0].lat && j[0].lon) {
      hit = { lat: Number(j[0].lat), lon: Number(j[0].lon), label: String(j[0].display_name || cand) };
      break;
    }
  }
  geoCache.set(key, hit);
  return hit;
}

/**
 * Turn a dropped/dragged map pin back into an address.
 *
 * @description The map surface lets a rider place a pin instead of typing. Uber still wants a
 *   display address on the deep link, and the rider wants to read back where they just pointed, so
 *   the pin round-trips through Nominatim's reverse endpoint on the SAME rate-limited queue.
 * @param {number} lat - latitude
 * @param {number} lon - longitude
 * @returns {Promise<{lat:number,lon:number,label:string}|null>} the resolved place, or null
 */
async function reverseGeocode(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const key = `r:${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const u = new URL('https://nominatim.openstreetmap.org/reverse');
  u.searchParams.set('format', 'json');
  u.searchParams.set('lat', String(lat));
  u.searchParams.set('lon', String(lon));
  u.searchParams.set('zoom', '18');
  const j = await nominatim(u);
  const hit = j && j.display_name ? { lat, lon, label: String(j.display_name) } : null;
  geoCache.set(key, hit);
  return hit;
}

/**
 * Build BOTH ride links from the (geocoded) pickup/dropoff. Device matters:
 *  - webUrl  → the Uber WEB RIDER (m.uber.com/go/product-selection). Opens in ANY browser — desktop
 *    AND mobile — and shows Uber's real product list + price estimates. This is the right link on a PC.
 *  - appUrl  → the universal app deep link (m.uber.com/ul/?action=setPickup). Built for a PHONE: it
 *    jumps into the installed Uber app. On desktop it just face-plants, which is why a /ul link is wrong
 *    when the user is on a computer.
 * The caller/surface picks by device; webUrl is the safe default because it works everywhere.
 * Uber sets the pins from latitude/longitude (the address strings are display-only), so we geocode.
 */
async function buildRideLinks(cred, pickup, dropoff) {
  const isMyLocation = !pickup || /my location|current/i.test(pickup);
  const pg = isMyLocation ? null : await geocode(pickup);
  const dg = dropoff ? await geocode(dropoff) : null;

  // ── Web rider (desktop + mobile browser): pickup / drop[0] are URL-encoded JSON place objects.
  const place = (addr, geo) => {
    const o = {};
    if (geo) { o.latitude = geo.lat; o.longitude = geo.lon; }
    if (addr) o.addressLine1 = addr;
    return JSON.stringify(o);
  };
  // Build the query by hand: the JSON VALUES are percent-encoded (%20 for spaces, not "+", which a
  // JSON parser would keep literally), while the key `drop[0]` is left literal as Uber expects it.
  const wparts = [];
  if (!isMyLocation) wparts.push('pickup=' + encodeURIComponent(place(pickup, pg)));  // omit → web rider asks for current location
  if (dropoff) wparts.push('drop[0]=' + encodeURIComponent(place(dropoff, dg)));
  wparts.push('utm_source=oshal');
  const webUrl = `https://m.uber.com/go/product-selection?${wparts.join('&')}`;

  // ── App deep link (phone): jumps into the Uber app with pickup/dropoff prefilled.
  const base = baseUrlOf(cred);
  const a = new URLSearchParams();
  a.set('action', 'setPickup');
  if (cred && cred.clientId) a.set('client_id', cred.clientId);
  if (isMyLocation) {
    a.set('pickup', 'my_location');
  } else {
    if (pg) { a.set('pickup[latitude]', String(pg.lat)); a.set('pickup[longitude]', String(pg.lon)); }
    a.set('pickup[formatted_address]', pickup); a.set('pickup[nickname]', pickup.slice(0, 40));
  }
  if (dropoff) {
    if (dg) { a.set('dropoff[latitude]', String(dg.lat)); a.set('dropoff[longitude]', String(dg.lon)); }
    a.set('dropoff[formatted_address]', dropoff); a.set('dropoff[nickname]', dropoff.slice(0, 40));
  }
  // NOTE: no product_id — Uber's product_id is a region-specific UUID (Products API), not a keyword
  // like "uberx"; a bare keyword breaks the link. The rider picks the type in-app.
  a.set('utm_source', 'oshal');
  const appUrl = `${base}/ul/?${a.toString()}`;

  return { webUrl, appUrl, geocoded: { pickup: !!pg, dropoff: !!dg } };
}

// ── Commands ─────────────────────────────────────────────────────────────────
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function die(msg, code = 2) { process.stdout.write(JSON.stringify({ error: msg })); process.exit(code); }

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  let cred = null;
  try { cred = await loadCred(); } catch { cred = null; }

  switch (cmd) {
    case 'accounts':
      out({ connected: !!cred, provider: 'uber-rides', client: !!(cred && cred.clientId) });
      return;
    case undefined:
    case 'status':
      out({
        configured: !!cred, service: 'uber-rides', baseUrl: baseUrlOf(cred),
        ordering: 'deep-link-handoff', pricing: 'estimate',
        note: 'Requesting a ride on someone else\'s behalf needs Uber for Business; this path is a universal deep link the rider confirms + pays in their own Uber app.',
      });
      return;
    case 'estimate': {
      const [pickup, dropoff] = args;
      if (!dropoff) return die('usage: estimate "<pickup>" "<dropoff>"');
      const e = await estimateRides(pickup || 'my location', dropoff);
      out({
        source: 'estimate', pickup: pickup || 'my location', dropoff,
        options: e.options,
        // The map surface draws its pins from these — no second geocode round-trip from the browser.
        coords: e.coords, distanceKm: e.distanceKm, straightLineKm: e.straightLineKm,
        basis: e.basis, roadFactor: e.roadFactor,
        note: e.basis === 'geocoded'
          ? `Fares are modelled from a measured ${e.straightLineKm} km straight line × ${e.roadFactor} road factor. Uber quotes the real price at confirm time.`
          : 'One of these addresses did not resolve to a location, so no fare is shown. Add a city or a street number and try again.',
      });
      return;
    }
    case 'geocode': {
      const [address] = args;
      if (!address) return die('usage: geocode "<address>"');
      const hit = await geocode(address);
      out(hit ? { source: 'nominatim', ...hit } : { source: 'nominatim', error: 'address did not resolve' });
      return;
    }
    case 'reverse': {
      const [lat, lon] = args;
      if (lat === undefined || lon === undefined) return die('usage: reverse <lat> <lon>');
      const hit = await reverseGeocode(Number(lat), Number(lon));
      out(hit ? { source: 'nominatim', ...hit } : { source: 'nominatim', error: 'no address at that point' });
      return;
    }
    case 'ride':
    case 'request': {
      const [pickup, dropoff, rideType] = args;
      if (!dropoff) return die('usage: ride "<pickup>" "<dropoff>" [rideType]');
      const links = await buildRideLinks(cred, pickup || 'my location', dropoff);
      out({
        source: 'uber',
        // rideUrl = the WEB rider (opens in any browser + shows real prices) — the right default on a
        // PC. webUrl/appUrl are also returned explicitly so the surface can choose by device.
        rideUrl: links.webUrl,
        webUrl: links.webUrl,
        appUrl: links.appUrl,
        rideType: rideType || null,
        geocoded: links.geocoded,
        note: 'On a computer use the web link (opens in your browser and shows live prices). On a phone the app link jumps into the Uber app. You confirm pickup + pay in your own Uber account — this is a handoff, not a charge.',
      });
      return;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
}

// Exported for the guard (tests/unit/uber-rides-estimate.spec.ts). The pure pieces — distance,
// the fare curve, the address ladder — are testable without touching Nominatim or the DB.
module.exports = { haversineKm, buildRideOptions, geoCandidates, ROAD_FACTOR, AVG_SPEED_KMH, RIDE_TYPES };

if (require.main === module) {
  main().catch((e) => { out({ source: 'estimate', options: [], error: e && e.message ? e.message : 'uber-rides CLI error' }); });
}
