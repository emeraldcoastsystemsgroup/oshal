#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | TMDB (movies bundle) CLI.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the exact scoped OIDC subject through the shared CLI identity reader.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Read TMDB credentials through the shared v2/k2/legacy connector-token codec.
 *   The bot-facing tool runtime for the movies-concierge. Mirrors scripts/oshal-uber.js
 *   credential resolution: prefer a controller-brokered key (.oshal-cred-tmdb /
 *   OSHAL_CRED_TMDB), else decrypt the operator's connection from the DB
 *   (oshal_connections, provider='tmdb'), else the TMDB_API_KEY /
 *   THEMOVIEDB_API_READ_ACCESS_TOKEN / THEMOVIEDB_API_KEY env fallback. The key is a v3
 *   API key (?api_key=) OR a v4 read access token (Bearer JWT) — detected by shape.
 *
 *   Discovery is REAL (free TMDB API). WATCHING + TICKETS are deep-link handoffs:
 *   where-to-watch returns TMDB's JustWatch page; showtimes returns a Fandango search.
 *   watchlist-add writes the viewer's own movies_watchlist row (DB) so the bot can save
 *   a pick when tasked agentically.
 *
 *   node scripts/oshal-tmdb.js                                  # status (configured?)
 *   node scripts/oshal-tmdb.js accounts                         # is a TMDB key available?
 *   node scripts/oshal-tmdb.js search "<q>" [n]                 # search movies + TV
 *   node scripts/oshal-tmdb.js trending [n]                     # trending this week
 *   node scripts/oshal-tmdb.js where-to-watch <movie|tv> <id>   # streaming providers + link
 *   node scripts/oshal-tmdb.js recommendations <movie|tv> <id>  # similar titles
 *   node scripts/oshal-tmdb.js showtimes "<title>" ["location"] # Fandango ticket-search link
 *   node scripts/oshal-tmdb.js watchlist-add <movie|tv> <id> "<title>" ["year"]  # save to the viewer's watchlist
 *
 * Exit 2 = no command match.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');
const { decryptToken } = require('./lib/connector-token-crypto');

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const REGION = process.env.MOVIES_REGION || 'US';

// ── Identity + brokered credential (mirrors oshal-uber.js) ──────────────────--
function resolveUserSub() {
  return resolveExactUserSubject();
}
function resolveBrokeredCred() {
  try {
    const c = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-tmdb'), 'utf8').trim();
    if (c) return c;
  } catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_TMDB || undefined;
}
async function keyFromDb(userSub) {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return undefined;
  const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
  try {
    const r = await pool.query(
      `SELECT user_sub, access_token FROM oshal_connections
       WHERE provider = 'tmdb' AND COALESCE(status,'') <> 'revoked'
         AND (user_sub = $1 OR tenant_id IS NOT NULL)
       ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
      [userSub || ''],
    );
    if (!r.rows[0]) return undefined;
    return decryptToken(pool, r.rows[0].user_sub, r.rows[0].access_token);
  } finally { await pool.end().catch(() => {}); }
}
async function loadKey() {
  const brokered = resolveBrokeredCred();
  if (brokered) return brokered;
  try { const k = await keyFromDb(resolveUserSub()); if (k) return k; } catch { /* fall through */ }
  return process.env.TMDB_API_KEY || process.env.THEMOVIEDB_API_READ_ACCESS_TOKEN || process.env.THEMOVIEDB_API_KEY || undefined;
}

// ── TMDB helpers (v3 key OR v4 bearer token) ─────────────────────────────────
const isV4 = (k) => String(k).startsWith('eyJ');
async function get(key, pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = isV4(key) ? `${BASE}${pathAndQuery}` : `${BASE}${pathAndQuery}${sep}api_key=${encodeURIComponent(key)}`;
  const r = await fetch(url, isV4(key) ? { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } } : { headers: { Accept: 'application/json' } });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`tmdb ${r.status}: ${text.slice(0, 200)}`); e.status = r.status; throw e; }
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}
const img = (p, size) => (p ? `${IMG}/${size}${p}` : null);
function normTitle(r, forceType) {
  const mediaType = forceType || r.media_type || (r.title ? 'movie' : 'tv');
  if (mediaType !== 'movie' && mediaType !== 'tv') return null;
  const id = Number(r.id || 0);
  if (!id) return null;
  const date = String(r.release_date || r.first_air_date || '');
  return {
    id, mediaType, key: `${mediaType}:${id}`,
    title: String(r.title || r.name || 'Untitled'),
    year: date ? date.slice(0, 4) : '',
    overview: String(r.overview || ''),
    posterUrl: img(r.poster_path, 'w342'),
    rating: Math.round((Number(r.vote_average) || 0) * 10) / 10,
    tmdbUrl: `https://www.themoviedb.org/${mediaType}/${id}`,
  };
}
function buildTicketsUrl(title, location) {
  const q = [title, location].filter(Boolean).join(' ');
  return `https://www.fandango.com/search?q=${encodeURIComponent(q)}`;
}

// ── Commands ──────────────────────────────────────────────────────────────--
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function die(msg, code = 2) { process.stdout.write(JSON.stringify({ error: msg })); process.exit(code); }

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  // showtimes needs no key — it's a pure Fandango deep link.
  if (cmd === 'showtimes') {
    if (!args[0]) return die('usage: showtimes "<title>" ["location"]');
    out({ url: buildTicketsUrl(args[0], args[1] || ''), note: 'Opens a Fandango search — pick a theater + showtime and check out there.' });
    return;
  }

  const key = await loadKey();
  if (cmd === 'accounts' || cmd === undefined || cmd === 'status') {
    out({ connected: !!key, provider: 'tmdb', region: REGION });
    return;
  }
  if (!key) return die('not configured — connect a TMDB key on /utilities or set TMDB_API_KEY');

  try {
    switch (cmd) {
      case 'search': {
        const q = String(args[0] || '').trim();
        const limit = Math.min(20, Math.max(1, Number(args[1]) || 12));
        if (!q) return die('usage: search "<query>" [n]');
        const j = await get(key, `/search/multi?include_adult=false&query=${encodeURIComponent(q)}`);
        out({ items: (j.results || []).map((r) => normTitle(r)).filter(Boolean).slice(0, limit) });
        return;
      }
      case 'trending': {
        const limit = Math.min(20, Math.max(1, Number(args[0]) || 12));
        const j = await get(key, `/trending/all/week`);
        out({ items: (j.results || []).map((r) => normTitle(r)).filter(Boolean).slice(0, limit) });
        return;
      }
      case 'where-to-watch': {
        const type = args[0] === 'tv' ? 'tv' : 'movie';
        const id = Number(args[1]);
        if (!id) return die('usage: where-to-watch <movie|tv> <id>');
        const j = await get(key, `/${type}/${id}/watch/providers`);
        const region = (j.results && j.results[REGION]) || {};
        const map = (arr) => (arr || []).map((p) => ({ name: String(p.provider_name || ''), logoUrl: img(p.logo_path, 'w92') })).filter((p) => p.name);
        out({ where: { link: region.link || null, flatrate: map(region.flatrate), rent: map(region.rent), buy: map(region.buy) } });
        return;
      }
      case 'recommendations': {
        const type = args[0] === 'tv' ? 'tv' : 'movie';
        const id = Number(args[1]);
        if (!id) return die('usage: recommendations <movie|tv> <id>');
        const j = await get(key, `/${type}/${id}/recommendations`);
        out({ items: (j.results || []).map((r) => normTitle(r, type)).filter(Boolean).slice(0, 12) });
        return;
      }
      case 'watchlist-add': {
        const type = args[0] === 'tv' ? 'tv' : 'movie';
        const id = Number(args[1]);
        const title = String(args[2] || '').trim();
        const year = String(args[3] || '');
        const sub = resolveUserSub();
        if (!id || !title) return die('usage: watchlist-add <movie|tv> <id> "<title>" ["year"]');
        if (!sub) return die('no user identity (OSHAL_USER_SUB) — cannot write a personal watchlist');
        if (!process.env.DATABASE_URL && !process.env.PGHOST) return die('no DB available for watchlist write');
        const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
        try {
          await pool.query(
            `INSERT INTO movies_watchlist (user_sub, item_key, media_type, tmdb_id, title, year, tmdb_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_sub, item_key) DO NOTHING`,
            [sub, `${type}:${id}`, type, id, title, year, `https://www.themoviedb.org/${type}/${id}`],
          );
        } finally { await pool.end().catch(() => {}); }
        out({ added: { key: `${type}:${id}`, title, year } });
        return;
      }
      default:
        return die(`unknown command: ${cmd}`);
    }
  } catch (e) {
    out({ error: e && e.message ? e.message : 'tmdb CLI error', status: e && e.status });
  }
}

main().catch((e) => { out({ error: e && e.message ? e.message : 'tmdb CLI error' }); });
