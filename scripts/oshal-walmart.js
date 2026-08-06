#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Walmart (purchasing bundle) shopping CLI.
 *   Reads the operator's Walmart I/O credential from the OSHAL connector store
 *   (oshal_connections, provider='walmart') — connected once at /utilities, NO keys in
 *   env/compose. Mirrors scripts/oshal-smartthings.js token resolution: prefer a
 *   controller-brokered credential (.oshal-cred-walmart / OSHAL_CRED_WALMART), else
 *   decrypt the connection from the DB. The credential is a JSON blob:
 *     { "consumerId": "...", "keyVersion": "1", "privateKeyPem": "-----BEGIN...", "publisherId": "..." }
 *   The Walmart I/O API only SEARCHES and assembles a cart; ORDERING is a deep link the
 *   shopper opens in their browser and completes on their own Walmart login (no shopper
 *   credentials, no payment, ever touch OSHAL).
 *
 *   node scripts/oshal-walmart.js                         # status digest (configured?)
 *   node scripts/oshal-walmart.js search "2% milk" [n]    # signed catalog search
 *   node scripts/oshal-walmart.js deals [rollback|clearance|bestsellers|specialbuy]
 *   node scripts/oshal-walmart.js cart "ITEMID_QTY,ITEMID_QTY"   # the order deep link
 *   node scripts/oshal-walmart.js accounts                # list this caller's connections
 *
 * Demo responses remain successful JSON so callers can keep the surface usable while inspecting
 * fallbackReason to distinguish a missing connection from a live-provider failure.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Distinguish demo fallback caused by no credential from a signed
 *   provider failure, while returning only bounded credential-safe diagnostics.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export a request-scoped, credential-argument live-search helper for
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the exact scoped OIDC subject through the shared CLI identity reader.
 *   deterministic provider intents; importing this module no longer runs the CLI.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');

const PRODUCT = '/api-proxy/service/affil/product/v2';
const PROVIDER_JSON_MAX_BYTES = 4 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 15_000;
const DEAL_FEEDS = {
  rollback: `${PRODUCT}/feeds/rollback`,
  clearance: `${PRODUCT}/clearance`,
  bestsellers: `${PRODUCT}/feeds/bestsellers`,
  specialbuy: `${PRODUCT}/specialbuy`,
};

// ── Identity (mirrors oshal-smartthings.js — codex sandbox may not forward env) ──
function resolveUserSub() {
  return resolveExactUserSubject();
}

// ── Credential resolution: brokered first, then DB ──────────────────────────
/** A short-lived credential the controller decrypted for THIS caller and dropped in. */
function resolveBrokeredCred() {
  try {
    const c = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-walmart'), 'utf8').trim();
    if (c) return c;
  } catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_WALMART || undefined;
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

/** Decrypt the operator's Walmart connection from the DB (personal ∪ shared/operator). */
async function credFromDb(userSub) {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return undefined;
  const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
  try {
    // Walmart is an operator/business account — resolve the caller's personal connection
    // or any shared one (is_default first). Single business connection is the norm.
    const r = await pool.query(
      `SELECT access_token FROM oshal_connections
       WHERE provider = 'walmart' AND COALESCE(status,'') <> 'revoked'
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

/** Return the parsed credential blob, or null if unconnected. */
async function loadCred() {
  let raw = resolveBrokeredCred();
  if (!raw) raw = await credFromDb(resolveUserSub());
  if (!raw) return null;
  const direct = parseLegacyCredential(raw);
  if (direct) return direct;
  try {
    // Legacy encrypted workspace values remain CLI-compatible. The exported request-scoped helper
    // never reaches this ambient SESSION_SECRET-dependent branch.
    return parseLegacyCredential(decrypt(raw));
  } catch {
    return null;
  }
}

/** Parse only the credential value supplied by the caller; never consult env, disk, or the DB. */
function parseCredentialArgument(raw) {
  return parseCredential(raw, false);
}

/** Preserve the standalone CLI's existing operator-configurable base URL behavior. */
function parseLegacyCredential(raw) {
  return parseCredential(raw, true);
}

function parseCredential(raw, allowCustomBaseUrl) {
  let candidate = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text || text.length > 32_768 || !text.startsWith('{')) return null;
    try { candidate = JSON.parse(text); } catch { return null; }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const consumerId = typeof candidate.consumerId === 'string' ? candidate.consumerId.trim() : '';
  const privateKeyPem = typeof candidate.privateKeyPem === 'string' ? candidate.privateKeyPem.trim() : '';
  if (!consumerId || consumerId.length > 512 || !privateKeyPem || privateKeyPem.length > 32_768) return null;
  const rawBaseUrl = typeof candidate.baseUrl === 'string' && candidate.baseUrl.trim()
    ? candidate.baseUrl.trim().replace(/\/$/, '')
    : 'https://developer.api.walmart.com';
  let baseUrl;
  try {
    const parsedBase = new URL(rawBaseUrl);
    const isApproved = rawBaseUrl === 'https://developer.api.walmart.com'
      && parsedBase.protocol === 'https:'
      && parsedBase.hostname.toLowerCase() === 'developer.api.walmart.com'
      && !parsedBase.port
      && !parsedBase.username
      && !parsedBase.password
      && (parsedBase.pathname === '/' || parsedBase.pathname === '')
      && !parsedBase.search
      && !parsedBase.hash;
    if (!allowCustomBaseUrl && !isApproved) return null;
    baseUrl = rawBaseUrl;
  } catch {
    return null;
  }
  return {
    consumerId,
    keyVersion: String(candidate.keyVersion || '1').slice(0, 64),
    privateKeyPem,
    publisherId: typeof candidate.publisherId === 'string' ? candidate.publisherId.slice(0, 512) : '',
    baseUrl,
  };
}

// ── Signing + HTTP ──────────────────────────────────────────────────────────
function authHeaders(cred) {
  const ts = Date.now().toString();
  const canonical = `${cred.consumerId}\n${ts}\n${cred.keyVersion}\n`;
  const signature = crypto.createSign('RSA-SHA256').update(canonical).sign(cred.privateKeyPem, 'base64');
  return {
    'WM_CONSUMER.ID': cred.consumerId,
    'WM_CONSUMER.INTIMESTAMP': ts,
    'WM_SEC.KEY_VERSION': cred.keyVersion,
    'WM_SEC.AUTH_SIGNATURE': signature,
    Accept: 'application/json',
  };
}

async function signedGet(cred, routePath, query = {}, fetchImpl = fetch, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const params = new URLSearchParams(query);
  if (cred.publisherId && !params.has('publisherId')) params.set('publisherId', cred.publisherId);
  const boundedTimeout = Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30_000
    ? timeoutMs
    : PROVIDER_TIMEOUT_MS;
  let res;
  try {
    res = await fetchImpl(`${cred.baseUrl}${routePath}?${params.toString()}`, {
      headers: authHeaders(cred),
      redirect: 'manual',
      signal: AbortSignal.timeout(boundedTimeout),
    });
  } catch {
    throw providerReadError('Walmart provider request could not be completed.');
  }
  if (!res.ok) {
    // Never reflect a provider body. It can echo request identifiers or credential-adjacent data.
    await cancelResponseBody(res);
    throw providerReadError(`Walmart provider returned HTTP ${res.status}.`, res.status);
  }
  if (!isJsonContentType(res.headers.get('content-type'))) {
    await cancelResponseBody(res);
    throw providerReadError('Walmart provider returned a non-JSON response.');
  }
  const declaredLength = res.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength.trim())) {
      await cancelResponseBody(res);
      throw providerReadError('Walmart provider returned an invalid Content-Length.');
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > PROVIDER_JSON_MAX_BYTES) {
      await cancelResponseBody(res);
      throw providerReadError('Walmart provider response exceeded the JSON byte limit.');
    }
  }
  const body = await readBoundedProviderBody(res, PROVIDER_JSON_MAX_BYTES);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw providerReadError('Walmart provider returned invalid JSON.');
  }
}

function providerReadError(message, status) {
  const error = new Error(message);
  error.walmartSafeProviderError = true;
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.walmartProviderStatus = status;
  return error;
}

async function cancelResponseBody(response) {
  try { if (response?.body) await response.body.cancel(); } catch { /* best-effort connection cleanup */ }
}

function isJsonContentType(value) {
  const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json'
    || (mediaType.startsWith('application/') && mediaType.endsWith('+json'));
}

async function readBoundedProviderBody(response, maximum) {
  if (!response.body) throw providerReadError('Walmart provider returned an empty response.');
  let reader;
  try { reader = response.body.getReader(); } catch {
    throw providerReadError('Walmart provider response could not be read.');
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      let part;
      try { part = await reader.read(); } catch {
        throw providerReadError('Walmart provider response could not be read.');
      }
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      total += chunk.byteLength;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw providerReadError('Walmart provider response exceeded the JSON byte limit.');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* best effort */ }
    if (error?.walmartSafeProviderError === true) throw error;
    throw providerReadError('Walmart provider response could not be read.');
  } finally {
    try { reader.releaseLock(); } catch { /* best effort */ }
  }
  if (!total) throw providerReadError('Walmart provider returned an empty response.');
  return Buffer.concat(chunks, total);
}

/** Convert any signed-request failure into a fixed, bounded diagnostic with no raw exception data. */
function safeProviderError(error) {
  const candidate = Number(error && error.walmartProviderStatus);
  const status = Number.isInteger(candidate) && candidate >= 100 && candidate <= 599 ? candidate : undefined;
  const message = status
    ? `Walmart provider returned HTTP ${status}.`
    : 'Walmart provider request could not be completed.';
  return {
    code: status ? 'http_error' : 'request_failed',
    ...(status ? { status } : {}),
    message: message.slice(0, 160),
  };
}

/** Metadata shared by every demo response so callers can diagnose the fallback honestly. */
function demoFallback(cred, error) {
  if (!cred) return { fallbackReason: 'not_connected' };
  const providerError = safeProviderError(error);
  return { fallbackReason: 'provider_error', providerError, error: providerError.message };
}

function normalize(raw) {
  const price = typeof raw.salePrice === 'number' ? raw.salePrice : (raw.msrp ?? null);
  const onSale = typeof raw.salePrice === 'number' && typeof raw.msrp === 'number' && raw.salePrice < raw.msrp;
  // Strip Walmart's HTML-ish description markup down to plain feature bullets.
  const descText = String(raw.shortDescription || raw.longDescription || '')
    .replace(/<li>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').trim();
  const features = Array.isArray(raw.features) && raw.features.length
    ? raw.features.map((f) => String(f).trim()).filter(Boolean)
    : descText.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6);
  return {
    retailer: 'walmart',
    productId: String(raw.itemId ?? raw.usItemId ?? ''),
    title: raw.name || raw.title || '',
    brand: raw.brandName || raw.brand || '',
    price,
    msrp: typeof raw.msrp === 'number' ? raw.msrp : null,
    onSale,
    savings: onSale ? Number((raw.msrp - raw.salePrice).toFixed(2)) : null,
    imageUrl: raw.largeImage || raw.mediumImage || raw.thumbnailImage || '',
    productUrl: normalizeProductUrl(raw),
    // Descriptive fields for the showcase panel (passed through verbatim by the routes).
    shortDescription: descText.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280) || null,
    features,
    size: raw.size || null,
    modelNumber: raw.modelNumber || null,
    rating: typeof raw.customerRating === 'number' ? raw.customerRating
      : (raw.customerRating ? Number(raw.customerRating) || null : null),
    reviews: typeof raw.numReviews === 'number' ? raw.numReviews : (Number(raw.numReviews) || null),
    category: Array.isArray(raw.categoryPath) ? raw.categoryPath.join(' / ')
      : (raw.categoryPath || raw.category || null),
  };
}

/** Prefer a stable direct product URL; unwrap Walmart affiliate destinations when needed. */
function normalizeProductUrl(raw) {
  const direct = typeof raw?.productUrl === 'string' ? raw.productUrl.trim() : '';
  if (direct) return direct;
  const tracking = typeof raw?.productTrackingUrl === 'string' ? raw.productTrackingUrl.trim() : '';
  if (!tracking) return '';
  try {
    const destination = new URL(tracking).searchParams.get('u');
    if (destination) {
      const parsed = new URL(destination);
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol === 'https:' && (host === 'walmart.com' || host.endsWith('.walmart.com'))) {
        return parsed.toString();
      }
    }
  } catch { /* provider record validation will reject an invalid fallback URL */ }
  return tracking;
}

const SAFE_PRODUCT_QUERY = /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}.,&'()/%+\-:]{0,199}$/u;

/**
 * Execute a live signed catalog read from an explicit request-scoped credential.
 * This helper has no demo, DB, filesystem, environment, shell, or global-mutation fallback.
 */
async function searchLiveCatalog(rawCredential, rawQuery, rawLimit = 6, options = {}) {
  const credential = parseCredentialArgument(rawCredential);
  if (!credential) throw new Error('Walmart live search requires a valid request-scoped credential');
  const query = String(rawQuery || '').trim();
  if (!SAFE_PRODUCT_QUERY.test(query)) throw new Error('Walmart live search query is invalid');
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 6) {
    throw new Error('Walmart live search limit must be an integer from 1 to 6');
  }
  return executeLiveSearch(credential, query, rawLimit, options);
}

/** Shared signed read after the caller-specific validation policy has already run. */
async function executeLiveSearch(credential, query, limit, options = {}) {
  const data = await signedGet(
    credential,
    `${PRODUCT}/search`,
    { query, numItems: limit },
    options.fetchImpl || fetch,
    options.timeoutMs,
  );
  const now = typeof options.now === 'function' ? options.now() : new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Walmart live search clock is invalid');
  return {
    source: 'walmart',
    retrievedAt: now.toISOString(),
    items: (Array.isArray(data?.items) ? data.items : []).slice(0, limit).map(normalize),
  };
}

/** The order deep link: shopper opens it, signs into their OWN Walmart, clicks checkout. */
function cartDeepLink(cred, itemsSpec) {
  const items = String(itemsSpec || '').trim();
  const pub = cred && cred.publisherId ? `&affiliateId=${encodeURIComponent(cred.publisherId)}` : '';
  return `https://affil.walmart.com/cart/addToCart?items=${encodeURIComponent(items)}${pub}`;
}

// ── Demo catalog ────────────────────────────────────────────────────────────
// Shown (flagged source:'demo') when there's no working Walmart credential yet,
// so the whole flow — search -> items+prices -> cart -> deep link — is usable.
// Drops out automatically the moment a live credential returns real results.
const DEMO = [
  { itemId: '10450115', name: 'Great Value 2% Reduced Fat Milk, 1 Gallon', brandName: 'Great Value', salePrice: 2.78, msrp: 2.98, tags: ['milk'],
    size: '1 Gallon', customerRating: 4.6, numReviews: 1820, category: 'Food / Dairy & Eggs / Milk',
    shortDescription: 'Reduced-fat 2% milk, Grade A and vitamin A & D fortified.',
    features: ['Grade A, 2% reduced fat', 'Vitamin A & D fortified', 'Great in coffee, cereal, and baking', 'Resealable 1-gallon jug'] },
  { itemId: '10291646', name: 'Great Value Whole Vitamin D Milk, 1 Gallon', brandName: 'Great Value', salePrice: 2.82, tags: ['milk'],
    size: '1 Gallon', customerRating: 4.7, numReviews: 2410, category: 'Food / Dairy & Eggs / Milk',
    shortDescription: 'Whole milk fortified with vitamin D, rich and creamy.',
    features: ['Whole milk, 3.25% milkfat', 'Excellent source of calcium', 'Vitamin D fortified', '1-gallon family size'] },
  { itemId: '44390948', name: 'Fresh Bananas, each', brandName: 'Fresh', salePrice: 0.24, tags: ['banana', 'bananas', 'fruit'],
    size: 'each', customerRating: 4.5, numReviews: 9650, category: 'Food / Fresh Produce / Fruit',
    shortDescription: 'Fresh whole bananas, sold individually.',
    features: ['Good source of potassium', 'Naturally fat free', 'Ripens at room temperature', 'Sold by each'] },
  { itemId: '10324110', name: 'Dawn Ultra Dishwashing Liquid Dish Soap, 19.4 fl oz', brandName: 'Dawn', salePrice: 3.97, tags: ['soap', 'dish soap', 'dish'],
    size: '19.4 fl oz', customerRating: 4.8, numReviews: 5340, category: 'Household / Cleaning / Dish Soap',
    shortDescription: 'Concentrated dish soap that cuts grease fast.',
    features: ['3x more grease-cleaning power per drop', 'Long-lasting concentrated suds', 'Original blue scent', '19.4 fl oz bottle'] },
  { itemId: '13176893', name: 'Method Gel Hand Wash, Sweet Water, 12 fl oz', brandName: 'Method', salePrice: 3.84, msrp: 4.48, tags: ['soap', 'hand soap'],
    size: '12 fl oz', customerRating: 4.7, numReviews: 1290, category: 'Personal Care / Hand Soap',
    shortDescription: 'Naturally derived gel hand wash with a sweet water scent.',
    features: ['Naturally derived cleansers', 'Biodegradable formula', 'Sweet water scent', 'Recyclable pump bottle'] },
  { itemId: '15206353', name: 'Folgers Classic Roast Ground Coffee, 25.9 oz', brandName: 'Folgers', salePrice: 8.98, tags: ['coffee'],
    size: '25.9 oz', customerRating: 4.8, numReviews: 7210, category: 'Food / Beverages / Coffee',
    shortDescription: 'Medium-roast ground coffee, makes up to 210 cups.',
    features: ['Mountain Grown 100% pure coffee', 'Medium roast, classic flavor', 'Makes up to 210 6-oz cups', 'Resealable 25.9 oz canister'] },
  { itemId: '23656343', name: 'Great Value Large White Eggs, 12 Count', brandName: 'Great Value', salePrice: 2.12, tags: ['eggs', 'egg'],
    size: '12 Count', customerRating: 4.6, numReviews: 3110, category: 'Food / Dairy & Eggs / Eggs',
    shortDescription: 'Grade A large white eggs, one dozen.',
    features: ['Grade A, large', 'Good source of protein', 'Versatile for any meal', '12-count carton'] },
];
function demoSearch(query, limit) {
  const q = String(query).toLowerCase();
  const hits = DEMO.filter((m) => m.name.toLowerCase().includes(q) || (m.tags || []).some((t) => q.includes(t) || t.includes(q)));
  return (hits.length ? hits : DEMO).slice(0, limit).map(normalize);
}
function demoDeals() { return DEMO.filter((m) => m.msrp && m.salePrice < m.msrp).map(normalize); }

// ── Commands ──────────────────────────────────────────────────────────────--
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function die(msg, code = 1) { process.stdout.write(JSON.stringify({ error: msg })); process.exit(code); }

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  let cred = null;
  try { cred = await loadCred(); } catch { cred = null; } // DB fallback may not be reachable — demo handles it

  switch (cmd) {
    case 'accounts':
      out({ connected: !!cred, provider: 'walmart' });
      return;
    case undefined:
    case 'status':
      out({ configured: !!cred, retailer: 'walmart', baseUrl: cred ? cred.baseUrl : null, mode: cred ? 'live' : 'demo' });
      return;
    case 'search': {
      const query = args[0];
      const limit = Number(args[1]) || 8;
      if (!query) return die('usage: search "<query>" [limit]');
      let providerFailure;
      if (cred) {
        try {
          // Standalone CLI compatibility: retain its historical default of eight and operator test
          // base URLs. Deterministic provider intents use the stricter exported helper above.
          out(await executeLiveSearch(cred, query, limit));
          return;
        } catch (error) { providerFailure = error; /* preserve demo items, but diagnose honestly */ }
      }
      out({ source: 'demo', ...demoFallback(cred, providerFailure), items: demoSearch(query, limit) });
      return;
    }
    case 'deals': {
      const feed = args[0] && DEAL_FEEDS[args[0]] ? args[0] : 'rollback';
      let providerFailure;
      if (cred) {
        try {
          const data = await signedGet(cred, DEAL_FEEDS[feed], { soldByWmt: true });
          out({ source: 'walmart', feed, items: (data.items || data || []).slice(0, 12).map(normalize) });
          return;
        } catch (error) { providerFailure = error; }
      }
      out({ source: 'demo', ...demoFallback(cred, providerFailure), feed, items: demoDeals() });
      return;
    }
    case 'cart': {
      if (!args[0]) return die('usage: cart "ITEMID_QTY,ITEMID_QTY"');
      out({ source: cred ? 'walmart' : 'demo', ...(cred ? {} : demoFallback(null)), checkoutUrl: cartDeepLink(cred, args[0]), note: 'Open in a browser; sign in to Walmart and check out.' });
      return;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const providerError = safeProviderError(error);
    out({ source: 'demo', fallbackReason: 'provider_error', providerError, items: [], error: providerError.message });
  });
}

module.exports = {
  parseCredentialArgument,
  searchLiveCatalog,
};
