#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Uber Eats (eats bundle) food CLI.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the exact scoped OIDC subject through the shared CLI identity reader.
 *   Reads the operator's OPTIONAL Uber Eats affiliate/marketing config from the OSHAL
 *   connector store (oshal_connections, provider='uber') — connected once at /utilities,
 *   NO keys in env/compose. Mirrors scripts/oshal-walmart.js credential resolution: prefer
 *   a controller-brokered credential (.oshal-cred-uber / OSHAL_CRED_UBER), else decrypt the
 *   connection from the DB. The credential is an OPTIONAL JSON blob:
 *     { "affiliateId": "...", "marketUrl": "https://www.ubereats.com/...", "baseUrl": "..." }
 *   (or a bare affiliate-id string).
 *
 *   IMPORTANT — the honest reality: Uber publishes NO consumer API to search Eats or to
 *   place an order on a third party's behalf. So this CLI:
 *     • returns a curated catalog (source:'catalog') so the assistant flow works, and
 *     • ORDERING is a DEEP LINK to ubereats.com the person opens in their browser and
 *       completes on their OWN Uber login + payment — no shopper credentials, no payment,
 *       ever touch OSHAL. The affiliate config (if connected) only adds tracking params.
 *
 *   node scripts/oshal-uber.js                          # status digest (configured?)
 *   node scripts/oshal-uber.js search "tacos" [n]       # search the catalog (restaurants/items)
 *   node scripts/oshal-uber.js menu "<storeId>"         # items for one restaurant
 *   node scripts/oshal-uber.js order "<storeId>"        # the order deep link (store page)
 *   node scripts/oshal-uber.js order "search:<terms>"   # a search deep link when no store id
 *   node scripts/oshal-uber.js accounts                 # is an Uber Eats config connected?
 *
 * Exit 2 = no command match. The catalog + deep link work with or without a connection.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');

// ── Identity (mirrors oshal-walmart.js — codex sandbox may not forward env) ──
function resolveUserSub() {
  return resolveExactUserSubject();
}

// ── Credential resolution: brokered first, then DB ──────────────────────────
/** A short-lived credential the controller decrypted for THIS caller and dropped in. */
function resolveBrokeredCred() {
  try {
    const c = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-uber'), 'utf8').trim();
    if (c) return c;
  } catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_UBER || undefined;
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

/** Decrypt the operator's Uber Eats connection from the DB (personal ∪ shared/operator). */
async function credFromDb(userSub) {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return undefined;
  const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
  try {
    const r = await pool.query(
      `SELECT access_token FROM oshal_connections
       WHERE provider = 'uber' AND COALESCE(status,'') <> 'revoked'
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

/** Return the parsed credential (optional), or null if unconnected. Deep links work either way. */
async function loadCred() {
  let raw = resolveBrokeredCred();
  if (!raw) raw = await credFromDb(resolveUserSub());
  if (!raw) return null;
  // The stored blob may be plaintext JSON (brokered) or an encrypted DB value already
  // decrypted above. Tolerate a bare affiliate-id string too.
  let parsed;
  try {
    const s = String(raw).trim();
    parsed = s.startsWith('{') ? JSON.parse(s) : { affiliateId: s.slice(0, 64) };
  } catch {
    parsed = { affiliateId: String(raw).slice(0, 64) };
  }
  return {
    affiliateId: String(parsed.affiliateId || parsed.affiliate_id || parsed.publisherId || '').trim(),
    marketUrl: String(parsed.marketUrl || '').trim(),
    baseUrl: String(parsed.baseUrl || 'https://www.ubereats.com').replace(/\/$/, ''),
  };
}

function baseUrlOf(cred) { return (cred && cred.baseUrl) || 'https://www.ubereats.com'; }

/** Append optional affiliate / source tracking to a ubereats.com URL. */
function track(url, cred) {
  const u = new URL(url);
  u.searchParams.set('utm_source', 'oshal');
  if (cred && cred.affiliateId) u.searchParams.set('utm_campaign', cred.affiliateId);
  return u.toString();
}

/** The order deep link: the person opens it, signs into their OWN Uber, adds + checks out. */
function orderDeepLink(cred, spec) {
  const base = baseUrlOf(cred);
  const s = String(spec || '').trim();
  if (s.toLowerCase().startsWith('search:')) {
    return track(`${base}/search?q=${encodeURIComponent(s.slice(7).trim())}`, cred);
  }
  const store = CATALOG.find((r) => r.storeId === s);
  if (store) return track(`${base}/store/${store.slug}`, cred);
  // Unknown id → fall back to a search deep link so the handoff still lands somewhere useful.
  return track(`${base}/search?q=${encodeURIComponent(s)}`, cred);
}

// ── Curated catalog ─────────────────────────────────────────────────────────
// Uber Eats has no public consumer search API, so the assistant browses this curated
// set (source:'catalog'); the REAL action is the deep-link handoff to ubereats.com,
// where live availability, prices, and checkout happen on the person's own account.
// Each entry carries an `emoji` (the always-renders branded tile glyph — no network)
// and an `imageUrl` (a real food photo, best-effort; the surface falls back to the
// emoji tile if it 404s, so there is NEVER a broken/blank image on the glass).
const IMG = (id) => `https://images.unsplash.com/photo-${id}?w=600&h=400&q=70&auto=format&fit=crop`;
const CATALOG = [
  {
    storeId: 'chipotle', slug: 'chipotle-mexican-grill', name: 'Chipotle Mexican Grill',
    cuisine: 'Mexican', etaMinutes: 25, emoji: '🌯', rating: 4.7,
    imageUrl: IMG('1626700051175-6818013e1d4f'),
    tags: ['burrito', 'bowl', 'tacos', 'mexican', 'chipotle'],
    items: [
      { itemId: 'chp-burrito', name: 'Chicken Burrito', price: 9.95, emoji: '🌯', imageUrl: IMG('1626700051175-6818013e1d4f') },
      { itemId: 'chp-bowl', name: 'Burrito Bowl', price: 9.95, emoji: '🥗', imageUrl: IMG('1543339308-43e59d6b73a6') },
      { itemId: 'chp-tacos', name: 'Three Tacos', price: 9.45, emoji: '🌮', imageUrl: IMG('1551504734-5ee1c4a1479b') },
      { itemId: 'chp-chips', name: 'Chips & Guacamole', price: 4.55, emoji: '🥑', imageUrl: IMG('1600688640154-9619e002df30') },
    ],
  },
  {
    storeId: 'mcdonalds', slug: 'mcdonalds', name: "McDonald's",
    cuisine: 'Fast food', etaMinutes: 18, emoji: '🍔', rating: 4.3,
    imageUrl: IMG('1568901346375-23c9450c58cd'),
    tags: ['burger', 'fries', 'mcdonalds', 'fast food', 'breakfast'],
    items: [
      { itemId: 'mcd-bigmac', name: 'Big Mac', price: 5.99, emoji: '🍔', imageUrl: IMG('1568901346375-23c9450c58cd') },
      { itemId: 'mcd-mcnuggets', name: '10 pc Chicken McNuggets', price: 5.49, emoji: '🍗', imageUrl: IMG('1562967914-608f82629710') },
      { itemId: 'mcd-fries', name: 'Large French Fries', price: 3.99, emoji: '🍟', imageUrl: IMG('1573080496219-bb080dd4f877') },
      { itemId: 'mcd-mccafe', name: 'McCafé Latte', price: 3.29, emoji: '☕', imageUrl: IMG('1541167760496-1628856ab772') },
    ],
  },
  {
    storeId: 'sushi-house', slug: 'sushi-house', name: 'Sushi House',
    cuisine: 'Japanese', etaMinutes: 35, emoji: '🍣', rating: 4.8,
    imageUrl: IMG('1579871494447-9811cf80d66c'),
    tags: ['sushi', 'japanese', 'ramen', 'roll'],
    items: [
      { itemId: 'sh-cali', name: 'California Roll', price: 7.50, emoji: '🍣', imageUrl: IMG('1579871494447-9811cf80d66c') },
      { itemId: 'sh-spicytuna', name: 'Spicy Tuna Roll', price: 8.25, emoji: '🍣', imageUrl: IMG('1617196034796-73dfa7b1fd56') },
      { itemId: 'sh-ramen', name: 'Tonkotsu Ramen', price: 13.95, emoji: '🍜', imageUrl: IMG('1569718212165-3a8278d5f624') },
      { itemId: 'sh-edamame', name: 'Edamame', price: 4.50, emoji: '🫛', imageUrl: IMG('1564834724105-918b73d1b9e0') },
    ],
  },
  {
    storeId: 'pizza-corner', slug: 'pizza-corner', name: 'Pizza Corner',
    cuisine: 'Italian', etaMinutes: 30, emoji: '🍕', rating: 4.6,
    imageUrl: IMG('1513104890138-7c749659a591'),
    tags: ['pizza', 'italian', 'pasta', 'wings'],
    items: [
      { itemId: 'pc-pepperoni', name: 'Large Pepperoni Pizza', price: 16.99, emoji: '🍕', imageUrl: IMG('1513104890138-7c749659a591') },
      { itemId: 'pc-margherita', name: 'Margherita Pizza', price: 15.49, emoji: '🍕', imageUrl: IMG('1574071318508-1cdbab80d002') },
      { itemId: 'pc-wings', name: 'Buffalo Wings (10)', price: 11.99, emoji: '🍗', imageUrl: IMG('1608039755401-742074f0548d') },
      { itemId: 'pc-garlic', name: 'Garlic Knots', price: 5.99, emoji: '🥖', imageUrl: IMG('1509440159596-0249088772ff') },
    ],
  },
  {
    storeId: 'green-bowl', slug: 'green-bowl-salads', name: 'Green Bowl Salads',
    cuisine: 'Healthy', etaMinutes: 22, emoji: '🥗', rating: 4.5,
    imageUrl: IMG('1512621776951-a57141f2eefd'),
    tags: ['salad', 'healthy', 'bowl', 'vegan', 'vegetarian'],
    items: [
      { itemId: 'gb-cobb', name: 'Cobb Salad', price: 10.95, emoji: '🥗', imageUrl: IMG('1512621776951-a57141f2eefd') },
      { itemId: 'gb-caesar', name: 'Chicken Caesar Salad', price: 9.95, emoji: '🥬', imageUrl: IMG('1550304943-4f24f54ddde9') },
      { itemId: 'gb-buddha', name: 'Vegan Buddha Bowl', price: 11.50, emoji: '🍲', imageUrl: IMG('1512852939750-1305098529bf') },
    ],
  },
];

function normalizeStore(cred, r) {
  return {
    retailer: 'ubereats',
    productId: r.storeId,
    title: r.name,
    brand: r.name,
    cuisine: r.cuisine,
    etaMinutes: r.etaMinutes,
    rating: r.rating || null,
    emoji: r.emoji || '🍽️',
    priceFrom: r.items.length ? Math.min(...r.items.map((i) => i.price)) : null,
    imageUrl: r.imageUrl || '',
    productUrl: track(`${baseUrlOf(cred)}/store/${r.slug}`, cred),
  };
}
function normalizeItem(cred, r, it) {
  return {
    retailer: 'ubereats',
    productId: it.itemId,
    storeId: r.storeId,
    title: it.name,
    brand: r.name,
    price: it.price,
    emoji: it.emoji || r.emoji || '🍽️',
    imageUrl: it.imageUrl || '',
    productUrl: track(`${baseUrlOf(cred)}/store/${r.slug}`, cred),
  };
}

/** Search the catalog by restaurant name, cuisine, tags, OR item names. */
function catalogSearch(cred, query, limit) {
  const q = String(query || '').toLowerCase().trim();
  const stores = CATALOG.filter((r) =>
    !q
    || r.name.toLowerCase().includes(q)
    || r.cuisine.toLowerCase().includes(q)
    || (r.tags || []).some((t) => q.includes(t) || t.includes(q))
    || r.items.some((it) => it.name.toLowerCase().includes(q)));
  const hits = stores.length ? stores : CATALOG;
  return hits.slice(0, limit).map((r) => normalizeStore(cred, r));
}

// ── Commands ──────────────────────────────────────────────────────────────--
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function die(msg, code = 2) { process.stdout.write(JSON.stringify({ error: msg })); process.exit(code); }

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  let cred = null;
  try { cred = await loadCred(); } catch { cred = null; } // DB fallback may be unreachable — deep links still work

  switch (cmd) {
    case 'accounts':
      out({ connected: !!cred, provider: 'uber', affiliate: !!(cred && cred.affiliateId) });
      return;
    case undefined:
    case 'status':
      out({
        configured: !!cred, retailer: 'ubereats', baseUrl: baseUrlOf(cred),
        affiliate: !!(cred && cred.affiliateId),
        catalog: 'curated', ordering: 'deep-link-handoff',
        note: 'Uber Eats has no consumer order API — ordering is a deep link the person completes on their own Uber login.',
      });
      return;
    case 'search': {
      const query = args[0];
      const limit = Number(args[1]) || 8;
      out({ source: 'catalog', items: catalogSearch(cred, query, limit) });
      return;
    }
    case 'menu': {
      const storeId = args[0];
      if (!storeId) return die('usage: menu "<storeId>"');
      const r = CATALOG.find((s) => s.storeId === storeId || s.slug === storeId);
      if (!r) { out({ source: 'catalog', storeId, items: [] }); return; }
      out({ source: 'catalog', storeId: r.storeId, store: r.name, items: r.items.map((it) => normalizeItem(cred, r, it)) });
      return;
    }
    case 'order':
    case 'cart': {
      if (!args[0]) return die('usage: order "<storeId>"  (or  order "search:<terms>")');
      out({
        source: 'ubereats',
        checkoutUrl: orderDeepLink(cred, args[0]),
        tracked: !!(cred && cred.affiliateId),
        note: 'Open in a browser; sign in to Uber Eats and place the order. This is a handoff, not an in-app charge.',
      });
      return;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
}

main().catch((e) => { out({ source: 'catalog', items: [], error: e && e.message ? e.message : 'uber CLI error' }); });
