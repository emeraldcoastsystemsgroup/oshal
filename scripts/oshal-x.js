#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Social swarm (ADR-038): publish a user-approved X/Twitter post (POST /2/tweets) or read the profile, using the OSHAL connector token (oshal_connections, provider=twitter). Mirrors oshal-linkedin.js. X OAuth 2.0 access tokens are short-lived (~2h), so unlike LinkedIn this CLI refreshes them itself — HTTP Basic (client_id:client_secret) + rotating refresh token, the same dialect the connector uses. Never auto-posts: the surface only calls `post` after explicit user approval.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 *
 *   node scripts/oshal-x.js profile               # the connected X profile (@handle, metrics)
 *   node scripts/oshal-x.js post "Hello world"    # publish a tweet (<=280 chars)
 *   TWITTER_ACCOUNT=@handle node … post "…"       # a specific connected account
 *
 * Exit 2 = no X connection (connect at /utilities). Exit 3 = post/refresh rejected.
 * Env: DATABASE_URL, SESSION_SECRET, TWITTER_CLIENT_ID/SECRET (X_* fallback).
 */
'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');

const CLIENT_ID = process.env.TWITTER_CLIENT_ID || process.env.X_CLIENT_ID || '';
const CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET || process.env.X_CLIENT_SECRET || process.env.X_CLIENT_SECRECT || '';

function key() { return crypto.createHash('sha256').update(process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is required - the hardcoded dev-key fallback was removed (docs/security/SECURITY-HARDENING.md 3.1/9); a well-known key is no key at all'); })()).digest(); }
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

/** Exchange a refresh token for a fresh access token (X confidential client: HTTP Basic + rotation). */
async function refreshToken(refresh) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID });
  const r = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!r.ok) { console.error('X token refresh failed: ' + r.status + ' ' + (await r.text()).slice(0, 160)); process.exit(3); }
  return r.json();
}

/** Resolve the caller's X connection (token + author id), refreshing the short-lived token. Fails closed on ambiguity. */
async function getConnection(pool) {
  const account = process.env.TWITTER_ACCOUNT;
  let row;
  if (account) {
    row = (await pool.query(`SELECT * FROM oshal_connections WHERE provider='twitter' AND lower(account_email)=lower($1) LIMIT 1`, [account])).rows[0];
  } else {
    const all = (await pool.query(`SELECT account_email FROM oshal_connections WHERE provider='twitter' ORDER BY updated_at DESC`)).rows;
    if (all.length > 1) {
      console.error(`Refusing to guess: ${all.length} X connections exist (${all.map((r) => r.account_email).join(', ')}). Set TWITTER_ACCOUNT=<handle>.`);
      process.exit(2);
    }
    row = all[0] ? (await pool.query(`SELECT * FROM oshal_connections WHERE provider='twitter' AND account_email=$1 LIMIT 1`, [all[0].account_email])).rows[0] : undefined;
  }
  if (!row || !row.access_token) { console.error('No X/Twitter connection found. Connect X at /utilities first.'); process.exit(2); }
  // X access tokens expire ~2h. Use the stored one if it still has headroom; else refresh + persist (rotating).
  if (row.expiry && new Date(row.expiry).getTime() - Date.now() > 60000) {
    return { token: decrypt(row.access_token), account: row.account_email, authorId: row.account_id };
  }
  if (!row.refresh_token) return { token: decrypt(row.access_token), account: row.account_email, authorId: row.account_id };
  const tok = await refreshToken(decrypt(row.refresh_token));
  await pool.query(
    `UPDATE oshal_connections SET access_token=$3, refresh_token=COALESCE($4, refresh_token), expiry=$5, updated_at=NOW()
     WHERE provider='twitter' AND account_email=$1 AND user_sub=$2`,
    [row.account_email, row.user_sub, encrypt(tok.access_token), tok.refresh_token ? encrypt(tok.refresh_token) : null,
      tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null],
  );
  return { token: tok.access_token, account: row.account_email, authorId: row.account_id };
}

/** GET /2/users/me — handle + display metrics. */
async function readProfile(token) {
  const r = await fetch('https://api.twitter.com/2/users/me?user.fields=username,name,public_metrics', { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, profile: await r.json().catch(() => ({})) };
}

/** POST /2/tweets — publish a tweet (<=280 chars). */
async function publishTweet(token, text) {
  const r = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, id: j && j.data && j.data.id ? j.data.id : null, response: JSON.stringify(j).slice(0, 400) };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const mode = process.argv[2] || 'profile';
    const { token, account } = await getConnection(pool);
    if (mode === 'post') {
      const text = process.argv.slice(3).join(' ').trim() || (process.env.X_POST_TEXT || '').trim();
      if (!text) { console.error('Usage: oshal-x.js post "your text"'); process.exit(1); }
      if (text.length > 280) { console.error(`Tweet is ${text.length} chars (max 280).`); process.exit(1); }
      const res = await publishTweet(token, text);
      const ok = res.status >= 200 && res.status < 300;
      console.log(JSON.stringify({ account, action: 'post', ok, status: res.status, tweetId: res.id, response: ok ? undefined : res.response }, null, 2));
      if (!ok) process.exit(3);
    } else {
      const p = await readProfile(token);
      console.log(JSON.stringify({ account, action: 'profile', status: p.status, profile: p.profile }, null, 2));
    }
  } catch (err) {
    console.error('oshal-x failed: ' + (err && err.message || err));
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
