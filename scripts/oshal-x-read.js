#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | X/Twitter reader for the social swarm: reads the connected account's OWN home timeline (reverse_chronological = tweets from accounts you follow) and the list of accounts you follow, via the per-user connector token (oshal_connections). This is the keyless path — follow accounts (e.g. @realDonaldTrump) from your logged-in X account and they stream into your home timeline; no paid search tier needed. Refreshes the OAuth2 token (confidential client, HTTP Basic) when expired. The social bot uses this to sense signals for other swarm bots (e.g. notify the trading bot on a market-moving tweet).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: PREFER a controller-provided access token (.oshal-cred-twitter in cwd, or OSHAL_CRED_TWITTER env) — use it directly and skip ALL DB/SESSION_SECRET decryption. Falls back to the existing per-user DB-decrypt+refresh path when no cred is provided.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Preserve the exact scoped OIDC subject through the shared CLI identity reader.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Use the shared version-aware connector-token codec and persist X token rotations as caller-owned v2 envelopes.
 *
 *   OSHAL_USER_SUB=... node scripts/oshal-x-read.js              # home timeline (default)
 *   X_MODE=following OSHAL_USER_SUB=... node scripts/oshal-x-read.js   # who I follow
 *
 * Exit 2 = no X connection. Exit 3 = token refresh failed. Exit 4 = API tier blocks reads.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { resolveExactUserSubject } = require('./lib/exact-user-subject');
const { decryptToken, encryptToken } = require('./lib/connector-token-crypto');

/** Codex may not forward OSHAL_USER_SUB to shelled commands; the wrapper also drops
 *  it as a cwd-relative file. Read whichever is present. */
function resolveUserSub() {
  return resolveExactUserSubject();
}

/** Token broker: a short-lived X access token the controller decrypted for THIS user and
 *  dropped into the workspace. Prefer it so we never touch SESSION_SECRET / the DB.
 *  Read the cwd file first (codex's channel), then the env (claude/cline). */
function resolveProvidedToken() {
  try {
    const t = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-twitter'), 'utf8').trim();
    if (t) return t;
  } catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_TWITTER || undefined;
}

async function getToken(pool) {
  const userSub = resolveUserSub();
  const account = process.env.X_ACCOUNT;
  let row;
  if (userSub) row = (await pool.query(`SELECT * FROM oshal_connections WHERE provider='twitter' AND user_sub=$1 ORDER BY updated_at DESC LIMIT 1`, [userSub])).rows[0];
  else if (account) row = (await pool.query(`SELECT * FROM oshal_connections WHERE provider='twitter' AND lower(account_email)=lower($1) LIMIT 1`, [account])).rows[0];
  else {
    const all = (await pool.query(`SELECT account_email FROM oshal_connections WHERE provider='twitter' ORDER BY updated_at DESC`)).rows;
    if (all.length > 1) { console.error(`Refusing to guess: ${all.length} X connections. Set OSHAL_USER_SUB or X_ACCOUNT.`); process.exit(2); }
    row = all[0] ? (await pool.query(`SELECT * FROM oshal_connections WHERE provider='twitter' AND account_email=$1 LIMIT 1`, [all[0].account_email])).rows[0] : undefined;
  }
  if (!row) { console.error('No X connection. Connect X at /utilities first.'); process.exit(2); }
  if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60000) {
    return { token: await decryptToken(pool, row.user_sub, row.access_token), account: row.account_email };
  }
  if (!row.refresh_token) { console.error('No refresh token; reconnect X at /utilities.'); process.exit(2); }
  const clientId = process.env.TWITTER_CLIENT_ID || process.env.X_CLIENT_ID || '';
  const clientSecret = process.env.TWITTER_CLIENT_SECRET || process.env.X_CLIENT_SECRET || process.env.X_CLIENT_SECRECT || '';
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: await decryptToken(pool, row.user_sub, row.refresh_token), client_id: clientId }),
  });
  if (!r.ok) { console.error('X token refresh failed: ' + r.status + ' ' + (await r.text()).slice(0, 200)); process.exit(3); }
  const tok = await r.json();
  await pool.query(`UPDATE oshal_connections SET access_token=$2, refresh_token=COALESCE($3, refresh_token), expiry=$4, updated_at=NOW() WHERE connection_id=$1`,
    [row.connection_id, await encryptToken(pool, row.user_sub, tok.access_token), tok.refresh_token ? await encryptToken(pool, row.user_sub, tok.refresh_token) : null, tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null]);
  return { token: tok.access_token, account: row.account_email };
}

async function xGet(token, path) {
  const r = await fetch(`https://api.twitter.com/2${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

async function readTimeline(token, account) {
  const me = await xGet(token, '/users/me');
  if (me.status !== 200) { console.error(`/users/me -> ${me.status}: ${JSON.stringify(me.body).slice(0, 200)}`); process.exit(4); }
  const id = me.body.data.id;
  const mode = process.env.X_MODE || 'timeline';
  const max = Math.min(Number(process.env.X_MAX) || 20, 100);
  const path = mode === 'following'
    ? `/users/${id}/following?max_results=${max}&user.fields=description,public_metrics`
    : `/users/${id}/timelines/reverse_chronological?max_results=${max}&tweet.fields=created_at,public_metrics&expansions=author_id&user.fields=username,name`;
  const res = await xGet(token, path);
  if (res.status !== 200) {
    // 403 = the app's access tier blocks this read (free tier); 429 = rate-limited.
    console.error(`READ ${mode} -> ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    process.exit(res.status === 403 ? 4 : 1);
  }
  const users = Object.fromEntries((res.body.includes?.users || []).map((u) => [u.id, u]));
  const out = mode === 'following'
    ? (res.body.data || []).map((u) => ({ handle: '@' + u.username, name: u.name, followers: u.public_metrics?.followers_count, bio: u.description }))
    : (res.body.data || []).map((t) => ({ from: '@' + (users[t.author_id]?.username || '?'), text: t.text, at: t.created_at, likes: t.public_metrics?.like_count }));
  console.log(JSON.stringify({ account, mode, count: out.length, items: out }, null, 2));
}

(async () => {
  // Token broker: if the controller handed us a token, use it directly — no DB, no SESSION_SECRET.
  const provided = resolveProvidedToken();
  if (provided) {
    try {
      await readTimeline(provided, process.env.X_ACCOUNT || 'connected');
    } catch (err) {
      console.error('oshal-x-read failed: ' + (err && err.message || err));
      process.exit(1);
    }
    return;
  }
  // Fallback: decrypt + refresh the per-user token from the DB (legacy; needs SESSION_SECRET).
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { token, account } = await getToken(pool);
    await readTimeline(token, account);
  } catch (err) {
    console.error('oshal-x-read failed: ' + (err && err.message || err));
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
