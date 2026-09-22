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
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the exact scoped OIDC subject through the shared CLI identity reader.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Add an import-safe request-scoped operation helper so
 *   controller routes pass credentials as function arguments. Ambient file/env/DB resolution is
 *   retained only for the guarded standalone CLI entrypoint.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Read Uber Rides connector configuration through the shared v2/k2/legacy connector-token codec.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Operator-owned geocoding, a geocode cache that survives a
 *   restart, and an optional routing engine. Three things this file hardcoded, all of which the
 *   operator has now decided on (2026-09-20):
 *     - THE GEOCODER WAS A LITERAL. `https://nominatim.openstreetmap.org` was written into both
 *       lookups, so an operator running their own Nominatim (or an air-gapped box, where the public
 *       one is unreachable and every address silently fails to resolve) had no way to point at it
 *       without editing this file. OSHAL_GEOCODER_URL now does it, validated the same way the
 *       connector's baseUrl is — http(s), no credentials, no query, no fragment — and falling back
 *       to the public endpoint rather than to something the operator did not ask for.
 *     - THE CACHE DIED WITH THE PROCESS. `geoCache` was a bare Map, so every api restart re-asked
 *       Nominatim for addresses it already knew, against a public endpoint whose usage policy this
 *       file goes to some length to honour (~1 req/s, serialized). It is now backed by a JSON file
 *       under OSHAL_WORKSPACE_ROOT (a named volume, so it survives a recreate as well as a
 *       restart), overridable with OSHAL_GEOCODE_CACHE_PATH, TTL'd at 30 days and capped. Only
 *       RESOLVED addresses are persisted: a miss is usually transient (rate limit, no egress) and
 *       writing one to disk would make a one-off outage permanent for that address.
 *     - THE ROAD DISTANCE WAS ALWAYS A MODEL. straight line x ROAD_FACTOR is ACCEPTED as the
 *       keyless default and is now labelled as an estimate end to end, but an operator with an
 *       OSRM/Valhalla endpoint can set OSHAL_ROUTING_URL and get a real road distance with no code
 *       change; `basis` then says 'routed' instead of 'geocoded' and roadFactor comes back null,
 *       because no factor was applied. An engine that is slow, down or malformed falls back to the
 *       accepted straight-line estimate rather than failing the trip.
 *   No new credential, no new connector: all three are plain operator env. Guard:
 *   tests/unit/uber-rides-routing-and-cache.spec.ts.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');
const { decryptToken } = require('./lib/connector-token-crypto');

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
async function credFromDb(userSub) {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return undefined;
  const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
  try {
    const r = await pool.query(
      `SELECT user_sub, access_token FROM oshal_connections
       WHERE provider = 'uber-rides' AND COALESCE(status,'') <> 'revoked'
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
async function loadCred() {
  let raw = resolveBrokeredCred();
  if (!raw) raw = await credFromDb(resolveUserSub());
  if (!raw) return null;
  return parseLegacyCredential(raw);
}

/** Parse only the explicit credential argument supplied by a library caller. */
function parseCredentialArgument(raw) { return parseCredential(raw, false); }

/** Preserve valid custom HTTP(S) targets for standalone CLI development and compatibility. */
function parseLegacyCredential(raw) { return parseCredential(raw, true); }

function parseCredential(raw, allowCustomBaseUrl) {
  let candidate = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text || text.length > 4096) return null;
    if (text.startsWith('{')) {
      try { candidate = JSON.parse(text); } catch { return null; }
    } else {
      candidate = { clientId: text };
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const clientId = String(candidate.clientId || candidate.client_id || '').trim();
  if (clientId.length > 512 || /[\u0000-\u001f\u007f]/u.test(clientId)) return null;
  const rawBaseUrl = String(candidate.baseUrl || 'https://m.uber.com').trim().replace(/\/$/, '');
  let parsedBase;
  try { parsedBase = new URL(rawBaseUrl); } catch { return null; }
  const officialBase = rawBaseUrl === 'https://m.uber.com'
    && parsedBase.protocol === 'https:'
    && parsedBase.hostname.toLowerCase() === 'm.uber.com'
    && !parsedBase.port
    && !parsedBase.username
    && !parsedBase.password
    && (parsedBase.pathname === '/' || parsedBase.pathname === '')
    && !parsedBase.search
    && !parsedBase.hash;
  const validLegacyBase = allowCustomBaseUrl
    && (parsedBase.protocol === 'https:' || parsedBase.protocol === 'http:')
    && !parsedBase.username
    && !parsedBase.password
    && !parsedBase.search
    && !parsedBase.hash;
  if (!officialBase && !validLegacyBase) return null;
  return { clientId, baseUrl: rawBaseUrl };
}
function baseUrlOf(cred) { return (cred && cred.baseUrl) || 'https://m.uber.com'; }

// ── Operator-owned endpoints ────────────────────────────────────────────────
// Both of these are plain operator env, never a credential and never a connector: they name a
// service, they carry no secret, and an unset or unusable value falls back to the documented
// default rather than to whatever was typed.
const DEFAULT_GEOCODER_URL = 'https://nominatim.openstreetmap.org';

/**
 * Validate an operator-supplied service URL.
 *
 * @description Same shape the connector's baseUrl is held to: http(s) only, no embedded
 *   credentials, no query and no fragment — those are how a "base URL" turns into something that
 *   leaks or is appended to wrongly. A trailing slash is dropped so callers can concatenate.
 * @param {string} raw - the raw env value
 * @returns {string} the normalized base URL, or '' when it is absent or unusable
 */
function operatorServiceUrl(raw) {
  const text = String(raw || '').trim().replace(/\/+$/, '');
  if (!text || text.length > 512) return '';
  let parsed;
  try { parsed = new URL(text); } catch { return ''; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return '';
  return text;
}

/**
 * The geocoding service this box talks to.
 *
 * @description OSHAL_GEOCODER_URL points at an operator's own Nominatim (or a compatible service)
 *   — the reason it exists is that the public endpoint is unreachable on an air-gapped install and
 *   rate-limited everywhere else. Unset, or set to something unusable, means the public endpoint.
 * @returns {string} base URL, no trailing slash
 */
function geocoderBaseUrl() {
  return operatorServiceUrl(process.env.OSHAL_GEOCODER_URL) || DEFAULT_GEOCODER_URL;
}

/**
 * The optional routing engine.
 *
 * @description Empty means the accepted keyless default — straight line × ROAD_FACTOR. Set to an
 *   OSRM-compatible endpoint it means a real road distance, with no other code change anywhere.
 * @returns {string} base URL, or '' when no engine is configured
 */
function routingBaseUrl() {
  return operatorServiceUrl(process.env.OSHAL_ROUTING_URL);
}

// A routing engine is an optimisation, never a dependency: a rider waiting on a wedged OSRM is
// worse off than a rider shown the straight-line estimate the operator already accepted.
const ROUTING_TIMEOUT_MS = 4000;

/**
 * Road distance between two pins, measured by the configured routing engine.
 *
 * @description Asks an OSRM-compatible `/route/v1/driving/{lon},{lat};{lon},{lat}` for the driving
 *   distance in metres. Returns null for every reason it could fail — no engine configured, a
 *   timeout, a non-2xx, a body without a usable distance — and the caller then prices the trip the
 *   accepted keyless way. It never throws, because the fallback is a correct answer, not an error.
 * @param {{lat:number,lon:number}} a - pickup pin
 * @param {{lat:number,lon:number}} b - dropoff pin
 * @returns {Promise<number|null>} road distance in km, or null when no engine answered
 */
async function routedKm(a, b) {
  const base = routingBaseUrl();
  if (!base || !a || !b) return null;
  let url;
  try {
    url = new URL(`${base}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}`);
  } catch { return null; }
  url.searchParams.set('overview', 'false');
  url.searchParams.set('alternatives', 'false');
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_UA },
      signal: AbortSignal.timeout(ROUTING_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const metres = body && Array.isArray(body.routes) && body.routes[0]
      ? Number(body.routes[0].distance)
      : NaN;
    if (!Number.isFinite(metres) || metres <= 0) return null;
    return metres / 1000;
  } catch { return null; }
}

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
 *   the caller exactly how much to trust the number: 'routed' = a configured routing engine
 *   measured the streets; 'geocoded' = the measured straight line between two resolved pins times
 *   the stated ROAD_FACTOR, which is a model and is labelled as one; 'unresolved' = at least one
 *   address did not geocode, so fares are null. `roadFactor` comes back null on a routed answer
 *   because no factor was applied to it — the caller must not print one that was not used.
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
  // A configured engine measures the streets; without one the accepted keyless estimate is the
  // straight line times the stated detour factor. Either way the pins were measured for real.
  const routed = straightKm === null ? null : await routedKm(pg, dg);
  const modelled = straightKm === null ? null : Math.round(straightKm * ROAD_FACTOR * 10) / 10;
  const distanceKm = routed === null ? modelled : Math.round(routed * 10) / 10;
  // Minutes to pickup is genuinely unknowable without Uber's driver supply — it is not modelled
  // from the address any more. The surface shows Uber's own ETA once the rider opens the handoff.
  const options = buildRideOptions(distanceKm, null);
  return {
    options,
    distanceKm,
    straightLineKm: straightKm === null ? null : Math.round(straightKm * 10) / 10,
    basis: distanceKm === null ? 'unresolved' : (routed === null ? 'geocoded' : 'routed'),
    roadFactor: routed === null ? ROAD_FACTOR : null,
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

// ── The cache that survives a restart ───────────────────────────────────────
// A per-process Map meant every api restart re-asked the public endpoint for addresses this box
// had already resolved — the exact pattern its usage policy asks callers not to produce, and the
// reason the rate limiter above exists at all. The Map is still the hot path; a JSON file behind
// it carries the resolved entries across a restart, a recreate and a redeploy.
//
// Only RESOLVED addresses are written. A miss is usually transient — rate limited, no egress, the
// endpoint down — and persisting one would turn a five-minute outage into a permanently
// unresolvable address for as long as the TTL runs. Misses stay in the Map, so they still stop a
// tight retry loop inside one process, and are re-asked after a restart.
const GEO_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GEO_CACHE_MAX_ENTRIES = 5000;
const geoCacheStampedAt = new Map();
let geoCacheLoaded = false;

/**
 * Where the durable geocode cache lives.
 *
 * @description Operator-owned: OSHAL_GEOCODE_CACHE_PATH wins outright. Otherwise it sits under
 *   OSHAL_WORKSPACE_ROOT, which compose backs with a named volume mounted into the api and every
 *   bot — so it survives a container recreate, not just a restart. With neither set (a bare CLI
 *   run on a laptop) it falls back to the temp directory, where a lost cache costs a re-geocode
 *   and nothing else.
 * @returns {string} absolute path to the cache file
 */
function geocodeCachePath() {
  const explicit = String(process.env.OSHAL_GEOCODE_CACHE_PATH || '').trim();
  if (explicit) return explicit;
  const workspace = String(process.env.OSHAL_WORKSPACE_ROOT || '').trim();
  if (workspace) return path.join(workspace, '.oshal', 'uber-rides-geocode-cache.json');
  return path.join(os.tmpdir(), 'oshal-uber-rides-geocode-cache.json');
}

/**
 * Populate the in-process cache from disk, once.
 *
 * @description Every row is re-validated rather than trusted: a file that was hand-edited,
 *   truncated by a crash mid-write, or written by a future version must not put a bogus coordinate
 *   in front of a rider. Anything unparseable, expired, or not a finite lat/lon pair is dropped,
 *   and a cache that cannot be read at all is simply an empty one.
 * @returns {void}
 */
function loadDurableGeoCache() {
  if (geoCacheLoaded) return;
  geoCacheLoaded = true;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(geocodeCachePath(), 'utf8'));
  } catch { return; } // no cache yet, unreadable, or not JSON — all of them mean "start empty"
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return;
  if (!parsed.entries || typeof parsed.entries !== 'object') return;
  const now = Date.now();
  for (const [key, row] of Object.entries(parsed.entries)) {
    if (!row || typeof row !== 'object' || !Number.isFinite(row.at)) continue;
    if (now - row.at > GEO_CACHE_TTL_MS || row.at > now) continue;
    const hit = row.hit;
    if (!hit || typeof hit !== 'object') continue;
    if (!Number.isFinite(hit.lat) || !Number.isFinite(hit.lon)) continue;
    if (Math.abs(hit.lat) > 90 || Math.abs(hit.lon) > 180) continue;
    geoCache.set(key, { lat: hit.lat, lon: hit.lon, label: String(hit.label || '') });
    geoCacheStampedAt.set(key, row.at);
  }
}

/**
 * Write the resolved entries back to disk.
 *
 * @description Written to a sibling temp file and renamed, so a process that dies mid-write leaves
 *   the previous cache intact rather than a truncated one. Best effort throughout: this is a cache,
 *   and a box where it cannot be written (read-only mount, full disk) must still be able to hail a
 *   ride. Nothing is logged because this CLI's stdout IS its result contract — a stray line there
 *   breaks every caller that parses it.
 * @returns {void}
 */
function saveDurableGeoCache() {
  const file = geocodeCachePath();
  const entries = {};
  let written = 0;
  for (const [key, hit] of geoCache) {
    if (!hit || written >= GEO_CACHE_MAX_ENTRIES) continue;
    entries[key] = { hit, at: geoCacheStampedAt.get(key) || Date.now() };
    written += 1;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
    fs.renameSync(tmp, file);
  } catch {
    // Unwritable cache: the lookup already succeeded, so the rider is served either way.
    try { fs.unlinkSync(tmp); } catch { /* the temp file was never created */ }
  }
}

/**
 * Record one resolved lookup in both tiers of the cache.
 *
 * @description A miss updates the in-process Map only — see the note above the TTL constant.
 * @param {string} key - the cache key ('f:<address>' or 'r:<lat>,<lon>')
 * @param {{lat:number,lon:number,label:string}|null} hit - the resolved place, or null
 * @returns {void}
 */
function rememberGeocode(key, hit) {
  geoCache.set(key, hit);
  if (!hit) return;
  geoCacheStampedAt.set(key, Date.now());
  saveDurableGeoCache();
}

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
  loadDurableGeoCache();
  const key = `f:${address.trim().toLowerCase()}`;
  if (geoCache.has(key)) return geoCache.get(key);
  let hit = null;
  for (const cand of geoCandidates(address)) {
    const u = new URL(`${geocoderBaseUrl()}/search`);
    u.searchParams.set('format', 'json');
    u.searchParams.set('q', cand);
    u.searchParams.set('limit', '1');
    const j = await nominatim(u);
    if (Array.isArray(j) && j[0] && j[0].lat && j[0].lon) {
      hit = { lat: Number(j[0].lat), lon: Number(j[0].lon), label: String(j[0].display_name || cand) };
      break;
    }
  }
  rememberGeocode(key, hit);
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
  loadDurableGeoCache();
  const key = `r:${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const u = new URL(`${geocoderBaseUrl()}/reverse`);
  u.searchParams.set('format', 'json');
  u.searchParams.set('lat', String(lat));
  u.searchParams.set('lon', String(lon));
  u.searchParams.set('zoom', '18');
  const j = await nominatim(u);
  const hit = j && j.display_name ? { lat, lon, label: String(j.display_name) } : null;
  rememberGeocode(key, hit);
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

function operationUsage(message) {
  const error = new Error(message);
  error.operationUsageError = true;
  return error;
}

/**
 * Say, in one sentence a rider can read, where the distance came from.
 *
 * @description The note is the honesty surface of the estimate: each `basis` gets its own sentence
 *   and none of them borrows another's confidence. A modelled distance names the factor; a routed
 *   one says it was measured and does not mention a factor that was never applied; an unresolved
 *   trip says there is no fare rather than implying one is coming.
 * @param {{basis:string,distanceKm:number|null,straightLineKm:number|null,roadFactor:number|null}} e - an estimateRides result
 * @returns {string} the rider-facing note
 */
function estimateNote(e) {
  if (e.basis === 'routed') {
    return `Distance is a measured ${e.distanceKm} km road route from the configured routing engine. `
      + 'Fares are still modelled from it; Uber quotes the real price at confirm time.';
  }
  if (e.basis === 'geocoded') {
    return `Fares are modelled from a measured ${e.straightLineKm} km straight line × ${e.roadFactor} road factor `
      + '— an estimate of the road distance, not a driven route. Uber quotes the real price at confirm time.';
  }
  return 'One of these addresses did not resolve to a location, so no fare is shown. Add a city or a street number and try again.';
}

/** Bound route-controlled values before geocoding or constructing third-party links. */
function operationArguments(rawArgs) {
  if (!Array.isArray(rawArgs) || rawArgs.length > 8) throw operationUsage('Uber Rides operation arguments are invalid');
  return rawArgs.map((value) => {
    if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw operationUsage('Uber Rides operation arguments are invalid');
    }
    return value;
  });
}

/** Execute a deterministic operation with an already-parsed, request-local credential. */
async function executeUberRidesCommand(cred, rawArgs, options = {}) {
  const [cmd, ...args] = operationArguments(rawArgs);
  const estimateImpl = options.estimateRides || estimateRides;
  const geocodeImpl = options.geocode || geocode;
  const reverseImpl = options.reverseGeocode || reverseGeocode;
  const linksImpl = options.buildRideLinks || buildRideLinks;
  switch (cmd) {
    case 'accounts':
      return { connected: !!cred, provider: 'uber-rides', client: !!(cred && cred.clientId) };
    case undefined:
    case 'status':
      return {
        configured: !!cred, service: 'uber-rides', baseUrl: baseUrlOf(cred),
        ordering: 'deep-link-handoff', pricing: 'estimate',
        // Which of the two distance paths this box is on, without printing the endpoint itself.
        routing: routingBaseUrl() ? 'routing-engine' : 'straight-line-x-road-factor',
        geocoder: geocoderBaseUrl() === DEFAULT_GEOCODER_URL ? 'public-nominatim' : 'operator-configured',
        note: 'Requesting a ride on someone else\'s behalf needs Uber for Business; this path is a universal deep link the rider confirms + pays in their own Uber app.',
      };
    case 'estimate': {
      const [pickup, dropoff] = args;
      if (!dropoff) throw operationUsage('usage: estimate "<pickup>" "<dropoff>"');
      const e = await estimateImpl(pickup || 'my location', dropoff);
      return {
        source: 'estimate', pickup: pickup || 'my location', dropoff,
        options: e.options,
        // The map surface draws its pins from these — no second geocode round-trip from the browser.
        coords: e.coords, distanceKm: e.distanceKm, straightLineKm: e.straightLineKm,
        basis: e.basis, roadFactor: e.roadFactor,
        note: estimateNote(e),
      };
    }
    case 'geocode': {
      const [address] = args;
      if (!address) throw operationUsage('usage: geocode "<address>"');
      const hit = await geocodeImpl(address);
      return hit ? { source: 'nominatim', ...hit } : { source: 'nominatim', error: 'address did not resolve' };
    }
    case 'reverse': {
      const [lat, lon] = args;
      const latitude = Number(lat);
      const longitude = Number(lon);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw operationUsage('usage: reverse <lat> <lon>');
      }
      const hit = await reverseImpl(latitude, longitude);
      return hit ? { source: 'nominatim', ...hit } : { source: 'nominatim', error: 'no address at that point' };
    }
    case 'ride':
    case 'request': {
      const [pickup, dropoff, rideType] = args;
      if (!dropoff) throw operationUsage('usage: ride "<pickup>" "<dropoff>" [rideType]');
      if (rideType && !RIDE_TYPES.some((candidate) => candidate.key === rideType)) {
        throw operationUsage('rideType is invalid');
      }
      const links = await linksImpl(cred, pickup || 'my location', dropoff);
      return {
        source: 'uber',
        // rideUrl = the WEB rider (opens in any browser + shows real prices) — the right default on a
        // PC. webUrl/appUrl are also returned explicitly so the surface can choose by device.
        rideUrl: links.webUrl,
        webUrl: links.webUrl,
        appUrl: links.appUrl,
        rideType: rideType || null,
        geocoded: links.geocoded,
        note: 'On a computer use the web link (opens in your browser and shows live prices). On a phone the app link jumps into the Uber app. You confirm pickup + pay in your own Uber account — this is a handoff, not a charge.',
      };
    }
    default:
      throw operationUsage(`unknown command: ${cmd}`);
  }
}

/**
 * Request-scoped Uber Rides entrypoint. A missing credential keeps the supported untracked
 * deep-link/estimate behavior; an invalid supplied credential fails closed with no ambient lookup.
 */
async function executeUberRidesOperation(rawCredential, rawArgs, options = {}) {
  let cred = null;
  if (rawCredential !== undefined && rawCredential !== null && rawCredential !== '') {
    cred = parseCredentialArgument(rawCredential);
    if (!cred) throw new Error('Uber Rides operation requires a valid request-scoped credential');
  }
  return executeUberRidesCommand(cred, rawArgs, options);
}

async function main() {
  let cred = null;
  try { cred = await loadCred(); } catch { cred = null; }
  try {
    out(await executeUberRidesCommand(cred, process.argv.slice(2)));
  } catch (error) {
    if (error && error.operationUsageError === true) return die(error.message);
    throw error;
  }
}

// Exported for the guard (tests/unit/uber-rides-estimate.spec.ts). The pure pieces — distance,
// the fare curve, the address ladder — are testable without touching Nominatim or the DB.
module.exports = {
  executeUberRidesOperation,
  parseCredentialArgument,
  haversineKm,
  buildRideOptions,
  geoCandidates,
  estimateNote,
  geocoderBaseUrl,
  routingBaseUrl,
  geocodeCachePath,
  DEFAULT_GEOCODER_URL,
  GEO_CACHE_TTL_MS,
  ROAD_FACTOR,
  AVG_SPEED_KMH,
  RIDE_TYPES,
};

if (require.main === module) {
  main().catch((e) => { out({ source: 'estimate', options: [], error: e && e.message ? e.message : 'uber-rides CLI error' }); });
}
