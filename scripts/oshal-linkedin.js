#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Social swarm (ADR-038): publish a LinkedIn post (Share on LinkedIn / w_member_social) or read the profile, using the OSHAL connector token (oshal_connections) — no separate login. Mirrors oshal-gmail.js (AES-256-GCM decrypt). The author URN uses the OIDC `sub` (stored as account_id).
 *
 *   node scripts/oshal-linkedin.js profile               # the connected LinkedIn profile
 *   node scripts/oshal-linkedin.js post "Hello world"    # publish a public post
 *   LINKEDIN_ACCOUNT=foo@bar.com node … post "…"         # a specific connected account
 *
 * Exit 2 = no LinkedIn connection (connect at /utilities). Exit 3 = post rejected.
 */
'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');

function key() { return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'oshal-dev-secret').digest(); }
function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

/** Resolve the caller's LinkedIn connection (token + author id). Fails closed on ambiguity. */
async function getConnection(pool) {
  const account = process.env.LINKEDIN_ACCOUNT;
  let row;
  if (account) {
    row = (await pool.query(`SELECT * FROM oshal_connections WHERE provider='linkedin' AND lower(account_email)=lower($1) LIMIT 1`, [account])).rows[0];
  } else {
    const all = (await pool.query(`SELECT account_email FROM oshal_connections WHERE provider='linkedin' ORDER BY updated_at DESC`)).rows;
    if (all.length > 1) {
      console.error(`Refusing to guess: ${all.length} LinkedIn connections exist. Set LINKEDIN_ACCOUNT=<email>.`);
      process.exit(2);
    }
    row = all[0] ? (await pool.query(`SELECT * FROM oshal_connections WHERE provider='linkedin' AND account_email=$1 LIMIT 1`, [all[0].account_email])).rows[0] : undefined;
  }
  if (!row || !row.access_token) { console.error('No LinkedIn connection found. Connect LinkedIn at /utilities first.'); process.exit(2); }
  return { token: decrypt(row.access_token), authorId: row.account_id, account: row.account_email };
}

/** GET the OIDC userinfo profile. */
async function readProfile(token) {
  const r = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, profile: await r.json().catch(() => ({})) };
}

/** Publish a public text post via the UGC Posts API (w_member_social). */
async function publishPost(token, authorId, text) {
  if (!authorId) throw new Error('missing LinkedIn author id (reconnect at /utilities)');
  const body = {
    author: `urn:li:person:${authorId}`,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };
  const r = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' },
    body: JSON.stringify(body),
  });
  const id = r.headers.get('x-restli-id') || r.headers.get('x-linkedin-id') || null;
  return { status: r.status, id, response: (await r.text()).slice(0, 400) };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const mode = process.argv[2] || 'profile';
    const { token, authorId, account } = await getConnection(pool);
    if (mode === 'post') {
      const text = process.argv.slice(3).join(' ').trim() || (process.env.LINKEDIN_POST_TEXT || '').trim();
      if (!text) { console.error('Usage: oshal-linkedin.js post "your text"'); process.exit(1); }
      const res = await publishPost(token, authorId, text);
      const ok = res.status >= 200 && res.status < 300;
      console.log(JSON.stringify({ account, action: 'post', ok, status: res.status, postId: res.id, response: ok ? undefined : res.response }, null, 2));
      if (!ok) process.exit(3);
    } else {
      const p = await readProfile(token);
      console.log(JSON.stringify({ account, action: 'profile', status: p.status, profile: p.profile }, null, 2));
    }
  } catch (err) {
    console.error('oshal-linkedin failed: ' + (err && err.message || err));
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
