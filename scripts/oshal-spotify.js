#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Spotify (music bundle) CLI.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 *   The bot-facing tool runtime for the spotify-concierge. Mirrors scripts/oshal-uber.js
 *   credential resolution: prefer a controller-brokered access token
 *   (.oshal-cred-spotify / OSHAL_CRED_SPOTIFY — a FRESH token the controller already
 *   refreshed via getValidAccessToken), else decrypt the user's connection from the DB
 *   (oshal_connections, provider='spotify'). No keys live in env/compose.
 *
 *   Unlike Uber, Spotify has a real consumer Web API, so discovery + playlist-building are
 *   REAL calls on the user's OWN account. PLAYBACK stays a deep-link handoff (open.spotify.com)
 *   — starting playback needs Premium + the Web Playback SDK, which OSHAL does not drive.
 *
 *   node scripts/oshal-spotify.js                         # status (connected?)
 *   node scripts/oshal-spotify.js accounts                # is Spotify connected for this caller?
 *   node scripts/oshal-spotify.js search "lo-fi" [n]      # search tracks
 *   node scripts/oshal-spotify.js now-playing             # currently playing track (or null)
 *   node scripts/oshal-spotify.js playlists [n]           # the user's playlists
 *   node scripts/oshal-spotify.js build-playlist "<name>" "<uri,uri,...>"  # create + fill, returns the deep link
 *
 * Exit 2 = no command match.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const API = 'https://api.spotify.com/v1';

// ── Identity + brokered credential (mirrors oshal-uber.js) ──────────────────--
function resolveUserSub() {
  if (process.env.OSHAL_USER_SUB) return process.env.OSHAL_USER_SUB;
  try { return fs.readFileSync(path.join(process.cwd(), '.oshal-user-sub'), 'utf8').trim() || undefined; }
  catch { return undefined; }
}
function resolveBrokeredCred() {
  try {
    const c = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-spotify'), 'utf8').trim();
    if (c) return c;
  } catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_SPOTIFY || undefined;
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
/** Decrypt the user's Spotify access token from the DB (brokered token preferred + fresher). */
async function tokenFromDb(userSub) {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) return undefined;
  const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
  try {
    const r = await pool.query(
      `SELECT access_token FROM oshal_connections
       WHERE provider = 'spotify' AND COALESCE(status,'') <> 'revoked'
         AND (user_sub = $1 OR tenant_id IS NOT NULL)
       ORDER BY is_default DESC, updated_at DESC LIMIT 1`,
      [userSub || ''],
    );
    if (!r.rows[0]) return undefined;
    return decrypt(r.rows[0].access_token);
  } finally { await pool.end().catch(() => {}); }
}
async function loadToken() {
  const brokered = resolveBrokeredCred();
  if (brokered) return brokered;
  try { return await tokenFromDb(resolveUserSub()); } catch { return undefined; }
}

// ── Spotify Web API helpers ──────────────────────────────────────────────────
async function api(token, pathAndQuery, init) {
  const r = await fetch(`${API}${pathAndQuery}`, {
    ...(init || {}),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...((init && init.headers) || {}) },
  });
  if (r.status === 204) return {};
  const text = await r.text();
  if (!r.ok) { const e = new Error(`spotify ${r.status}: ${text.slice(0, 200)}`); e.status = r.status; throw e; }
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}
const pickImg = (imgs) => (Array.isArray(imgs) && imgs.length ? (imgs[imgs.length - 1].url || imgs[0].url || null) : null);
function normTrack(t) {
  return {
    id: String(t && t.id || ''),
    uri: String((t && t.uri) || (t && t.id ? `spotify:track:${t.id}` : '')),
    title: String((t && t.name) || 'Unknown'),
    artist: ((t && t.artists) || []).map((a) => a && a.name).filter(Boolean).join(', ') || 'Unknown',
    album: String((t && t.album && t.album.name) || ''),
    imageUrl: pickImg(t && t.album && t.album.images),
    url: String((t && t.external_urls && t.external_urls.spotify) || (t && t.id ? `https://open.spotify.com/track/${t.id}` : '')),
  };
}
function normPlaylist(p) {
  return {
    id: String(p && p.id || ''), name: String((p && p.name) || 'Untitled'),
    trackCount: Number((p && p.tracks && p.tracks.total) || 0),
    url: String((p && p.external_urls && p.external_urls.spotify) || (p && p.id ? `https://open.spotify.com/playlist/${p.id}` : '')),
  };
}

// ── Commands ──────────────────────────────────────────────────────────────--
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function die(msg, code = 2) { process.stdout.write(JSON.stringify({ error: msg })); process.exit(code); }

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const token = await loadToken();

  if (cmd === 'accounts' || cmd === undefined || cmd === 'status') {
    out({ connected: !!token, provider: 'spotify', note: 'Playback is a deep-link handoff (open.spotify.com); needs Premium + Web Playback SDK to start in-app.' });
    return;
  }
  if (!token) return die('not connected — connect Spotify on /utilities (or the account is not on the app allowlist)');

  try {
    switch (cmd) {
      case 'search': {
        const q = String(args[0] || '').trim();
        const limit = Math.min(50, Math.max(1, Number(args[1]) || 12));
        if (!q) return die('usage: search "<query>" [n]');
        const market = process.env.SPOTIFY_MARKET || 'from_token';
        const j = await api(token, `/search?type=track&limit=${limit}&market=${encodeURIComponent(market)}&q=${encodeURIComponent(q)}`);
        out({ items: ((j.tracks && j.tracks.items) || []).map(normTrack).filter((t) => t.id) });
        return;
      }
      case 'now-playing': {
        const j = await api(token, '/me/player/currently-playing?market=from_token');
        out({ nowPlaying: j && j.item ? { track: normTrack(j.item), isPlaying: !!j.is_playing } : null });
        return;
      }
      case 'playlists': {
        const limit = Math.min(50, Math.max(1, Number(args[0]) || 24));
        const j = await api(token, `/me/playlists?limit=${limit}`);
        out({ items: ((j.items) || []).map(normPlaylist).filter((p) => p.id) });
        return;
      }
      case 'build-playlist': {
        const name = String(args[0] || '').trim();
        const uris = String(args[1] || '').split(/[\s,]+/).filter((u) => u.startsWith('spotify:track:')).slice(0, 100);
        if (!name) return die('usage: build-playlist "<name>" "<uri,uri,...>"');
        if (!uris.length) return die('no valid spotify:track: URIs supplied');
        const me = await api(token, '/me');
        const pl = await api(token, `/users/${encodeURIComponent(me.id)}/playlists`, {
          method: 'POST',
          body: JSON.stringify({ name: name.slice(0, 100), description: 'Built by the OSHAL Spotify concierge', public: false }),
        });
        await api(token, `/playlists/${pl.id}/tracks`, { method: 'POST', body: JSON.stringify({ uris }) });
        out({ playlist: { ...normPlaylist(pl), trackCount: uris.length }, added: uris.length });
        return;
      }
      default:
        return die(`unknown command: ${cmd}`);
    }
  } catch (e) {
    // 403 here is almost always the Spotify dev-mode allowlist (account not registered).
    out({ error: e && e.message ? e.message : 'spotify CLI error', status: e && e.status });
  }
}

main().catch((e) => { out({ error: e && e.message ? e.message : 'spotify CLI error' }); });
