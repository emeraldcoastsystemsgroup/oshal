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
 *   node scripts/oshal-uber-rides.js accounts                         # is a Rides config connected?
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ── Identity ────────────────────────────────────────────────────────────────
function resolveUserSub() {
  if (process.env.OSHAL_USER_SUB) return process.env.OSHAL_USER_SUB;
  try { return fs.readFileSync(path.join(process.cwd(), '.oshal-user-sub'), 'utf8').trim() || undefined; }
  catch { return undefined; }
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
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'oshal-dev-secret').digest();
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

// ── Ride types + deterministic estimate ──────────────────────────────────────
// No live pricing API on the deep-link path, so estimates are deterministic from the
// pickup+dropoff text (stable, clearly labelled). The REAL fare shows in the rider's
// Uber app at confirm time.
const RIDE_TYPES = [
  { key: 'uberx',   label: 'UberX',   emoji: '🚗', seats: 4, base: 9,  perKm: 1.1 },
  { key: 'comfort', label: 'Comfort', emoji: '🚙', seats: 4, base: 12, perKm: 1.4 },
  { key: 'xl',      label: 'UberXL',  emoji: '🚐', seats: 6, base: 15, perKm: 1.8 },
  { key: 'black',   label: 'Uber Black', emoji: '🚘', seats: 4, base: 22, perKm: 2.6 },
];
function pseudoKm(pickup, dropoff) {
  const h = crypto.createHash('sha256').update(`${pickup}=>${dropoff}`).digest();
  return 2 + (h[0] % 18) + (h[1] % 10) / 10; // 2.0 – 19.9 km, stable per route
}
function estimateRides(pickup, dropoff) {
  const km = pseudoKm(pickup, dropoff);
  const etaPickup = 2 + (crypto.createHash('sha256').update(pickup).digest()[0] % 8); // min to pickup
  return RIDE_TYPES.map((t) => {
    const fare = t.base + t.perKm * km;
    return {
      type: t.key, label: t.label, emoji: t.emoji, seats: t.seats,
      fareLow: Math.round(fare * 0.9), fareHigh: Math.round(fare * 1.15),
      etaPickupMin: etaPickup, tripMin: Math.round(km * 2.2 + 4),
      estimate: true,
    };
  });
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
async function geocode(address) {
  if (!address) return null;
  const cands = geoCandidates(address);
  for (let i = 0; i < cands.length; i++) {
    try {
      const u = new URL('https://nominatim.openstreetmap.org/search');
      u.searchParams.set('format', 'json');
      u.searchParams.set('q', cands[i]);
      u.searchParams.set('limit', '1');
      const r = await fetch(u, { headers: { 'User-Agent': 'oshal-uber-rides/1.0' } });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j) && j[0] && j[0].lat && j[0].lon) return { lat: Number(j[0].lat), lon: Number(j[0].lon) };
      }
    } catch { /* try the next, broader candidate */ }
    if (i < cands.length - 1) await new Promise((s) => setTimeout(s, 1100)); // Nominatim asks for ~1 req/s
  }
  return null;
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
      out({ source: 'estimate', pickup: pickup || 'my location', dropoff, options: estimateRides(pickup || 'my location', dropoff) });
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

main().catch((e) => { out({ source: 'estimate', options: [], error: e && e.message ? e.message : 'uber-rides CLI error' }); });
