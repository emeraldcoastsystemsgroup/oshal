#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Email-bot migration: read Gmail + Calendar via the OSHAL connectors token (oshal_connections) instead of the separate google-workspace CLI. Self-contained; reuses the connectors' AES-256-GCM decryption + refresh-token flow.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Multi-tenant safety: fail closed (exit 2) when >1 Google connection exists and GMAIL_ACCOUNT is unset, instead of silently reading the most-recently-connected user's mailbox. The bot must name the account it acts for.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Token broker: PREFER a controller-provided access token (.oshal-cred-google in cwd, or OSHAL_CRED_GOOGLE env) — use it directly and skip ALL DB/SESSION_SECRET decryption. Falls back to the existing per-user DB-decrypt path when no cred is provided. This is the path that lets the bot stop needing SESSION_SECRET.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Preserve Gmail message IDs, provider receive time, and UNREAD/IMPORTANT/STARRED flags in the structured digest.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Add the `verify` verb for ATS sign-up/2FA: the digest reads format=metadata (headers + the ~100-char snippet) ONLY, so a verification LINK in the message BODY was invisible — which is exactly what Workday/account-activation mail sends, blocking those ATS families. `verify` fetches format=full, walks the MIME parts, and extracts a code AND/OR an activation link, with a BOUNDED POLL (the apply flow's one-shot lookup missed codes that had not landed yet) and a client-side recency filter so a stale code from earlier is never returned. Emits ONLY the extracted token — never the body — so the digest's privacy posture holds.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Envelope-crypto compat: OSHAL_ENVELOPE_CRYPTO flipped ON by default 2026-07-20, so connector tokens now re-encrypt to a `v2:` per-user-DEK blob on refresh — but this CLI's decrypt only knew the legacy single-KEK format, so it broke reading the access_token the moment it refreshed to v2 ("Unsupported state or unable to authenticate data"), silently killing the apply flow's Gmail verification-code retrieval. Made decrypt format-aware (new decryptToken + userDek: v2 -> unwrap the per-user DEK from oshal_user_deks under the KEK, then DEK-decrypt; legacy -> KEK) to mirror connector-token-crypto.ts, and made an access_token decrypt failure fall through to a refresh_token refresh instead of aborting.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the token-key derivation - SESSION_SECRET unset now fails loud instead of silently deriving a well-known AES key any reader of this public repo can compute. No change on a correctly-provisioned box; guard: tests/unit/no-dev-secret-fallback.spec.ts.
 *
 * Prints a JSON digest of today's unread-ish mail + calendar for a connected
 * Google account. The account is connected by a user at /utilities (no CLI auth).
 *
 *   node scripts/oshal-gmail.js            # newest Google connection
 *   GMAIL_ACCOUNT=foo@bar.com node …       # a specific connected account
 *
 * Verification (ATS sign-up / 2FA) — waits for the mail to land, prints {code, link}:
 *   node scripts/oshal-gmail.js verify [--from workday.com] [--wait 90] [--grace 180]
 *
 * Exit 2 = no Google connection (tells the operator to connect at /utilities).
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/** The codex sandbox may not forward OSHAL_USER_SUB to shelled commands, so the
 *  codex wrapper also drops it as a cwd-relative file. Read whichever is present. */
function resolveUserSub() {
  if (process.env.OSHAL_USER_SUB) return process.env.OSHAL_USER_SUB;
  try { return (fs.readFileSync(path.join(process.cwd(), '.oshal-user-sub'), 'utf8').trim() || undefined); }
  catch { return undefined; }
}

/** Token broker: a short-lived access token the controller decrypted for THIS user and
 *  dropped into the workspace. Prefer it so we never touch SESSION_SECRET / the DB.
 *  Read the cwd file first (codex's channel), then the env (claude/cline). */
function resolveProvidedToken() {
  try {
    const t = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-google'), 'utf8').trim();
    if (t) return t;
  } catch { /* no file — try env */ }
  return process.env.OSHAL_CRED_GOOGLE || undefined;
}

function key() { return crypto.createHash('sha256').update(process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET is required - the hardcoded dev-key fallback was removed (docs/security/SECURITY-HARDENING.md 3.1/9); a well-known key is no key at all'); })()).digest(); }
function gcmDecryptRaw(k, blob) {
  const [iv, tag, enc] = String(blob).split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]);
}
/** Legacy single-KEK decrypt of an unprefixed `iv:tag:enc` blob. */
function decrypt(blob) { return gcmDecryptRaw(key(), blob).toString('utf8'); }

/** Version tag on per-user-DEK envelope blobs (mirrors src/app/routes/connector-token-crypto.ts). */
const ENVELOPE_V2 = 'v2:';
const _dekCache = new Map();
/**
 * @description Unwrap this user's 32-byte data-encryption-key from oshal_user_deks. The stored
 * wrapped_dek is itself an `iv:tag:enc` blob encrypted under the KEK = SHA256(SESSION_SECRET).
 * @param {object} pool pg pool
 * @param {string} userSub connection owner's OIDC sub
 * @returns {Promise<Buffer>} the raw 32-byte DEK
 */
async function userDek(pool, userSub) {
  if (_dekCache.has(userSub)) return _dekCache.get(userSub);
  const row = (await pool.query('SELECT wrapped_dek FROM oshal_user_deks WHERE user_sub=$1', [userSub])).rows[0];
  if (!row) throw new Error(`no DEK row in oshal_user_deks for user ${userSub} (v2 blob but DEK missing)`);
  const dek = gcmDecryptRaw(key(), String(row.wrapped_dek));
  _dekCache.set(userSub, dek);
  return dek;
}
/**
 * @description Format-aware connector-token decrypt. Mirrors connector-token-crypto.ts decryptToken:
 * a `v2:`-prefixed blob is per-user-DEK encrypted (envelope crypto, ON by default since 2026-07-20);
 * an unprefixed blob is legacy single-KEK. Without this the CLI reads only legacy blobs and breaks
 * the moment a token is refreshed/reconnected into v2 (which is what silently broke the apply flow's
 * email-verification code retrieval).
 * @param {object} pool pg pool
 * @param {string|undefined} userSub token owner's OIDC sub (required for v2 blobs)
 * @param {string} blob at-rest token blob
 * @returns {Promise<string>} plaintext token
 */
async function decryptToken(pool, userSub, blob) {
  if (String(blob).startsWith(ENVELOPE_V2)) {
    if (!userSub) throw new Error('decryptToken: v2 blob requires a userSub');
    return gcmDecryptRaw(await userDek(pool, userSub), String(blob).slice(ENVELOPE_V2.length)).toString('utf8');
  }
  return decrypt(blob);
}

async function getAccessToken(pool) {
  const userSub = resolveUserSub(); // preferred: scope to the signed-in user (env or wrapper-dropped file)
  const account = process.env.GMAIL_ACCOUNT;  // fallback: a specific connected account
  let row;
  if (userSub) {
    // Per-user scoping: act only for THIS user's own Google connection. Resolves
    // multi-account ambiguity correctly (each user's sub owns one connection).
    row = (await pool.query(`SELECT * FROM oshal_connections WHERE provider='google' AND user_sub=$1 ORDER BY updated_at DESC LIMIT 1`, [userSub])).rows[0];
    if (!row) { console.error(`No Google connection for user ${userSub}. Connect at /utilities first.`); process.exit(2); }
  } else if (account) {
    row = (await pool.query(`SELECT * FROM oshal_connections WHERE provider='google' AND lower(account_email)=lower($1) LIMIT 1`, [account])).rows[0];
  } else {
    // No identity given: never silently pick "newest" when more than one user has
    // connected Google — that would read the wrong person's mailbox. Require an
    // explicit OSHAL_USER_SUB or GMAIL_ACCOUNT so the bot acts only for whom it was given.
    const all = (await pool.query(`SELECT account_email FROM oshal_connections WHERE provider='google' ORDER BY updated_at DESC`)).rows;
    if (all.length > 1) {
      console.error(`Refusing to guess: ${all.length} Google connections exist (${all.map((r) => r.account_email).join(', ')}). Set OSHAL_USER_SUB or GMAIL_ACCOUNT.`);
      process.exit(2);
    }
    row = all[0] ? (await pool.query(`SELECT * FROM oshal_connections WHERE provider='google' AND account_email=$1 LIMIT 1`, [all[0].account_email])).rows[0] : undefined;
  }
  if (!row) { console.error('No Google connection found. Connect a Google account at /utilities first.'); process.exit(2); }
  if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60000) {
    try {
      return { token: await decryptToken(pool, row.user_sub, row.access_token), account: row.account_email };
    } catch (e) {
      // Format drift (e.g. a v2 blob we can't unwrap) or a stale access_token must not be fatal —
      // fall through to a live refresh using the refresh_token below.
      console.error('access_token decrypt failed (' + e.message + '); refreshing via refresh_token');
    }
  }
  if (!row.refresh_token) { console.error('Connection has no refresh token; reconnect at /utilities.'); process.exit(2); }
  const clientId = process.env.GOOGLE_CONNECT_CLIENT_ID || process.env.OIDC_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CONNECT_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET || '';
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: await decryptToken(pool, row.user_sub, row.refresh_token), grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) { console.error('Token refresh failed: ' + r.status + ' ' + (await r.text()).slice(0, 160)); process.exit(3); }
  const tok = await r.json();
  await pool.query(`UPDATE oshal_connections SET access_token=$3, expiry=$4, updated_at=NOW() WHERE provider='google' AND account_email=$1 AND user_sub=$2`,
    [row.account_email, row.user_sub, encrypt(tok.access_token), tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null]);
  return { token: tok.access_token, account: row.account_email };
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

/** Convert Gmail's provider-owned millisecond timestamp to a stable ISO time. */
function gmailReceivedAt(internalDate) {
  const millis = Number(internalDate);
  if (!Number.isFinite(millis) || millis <= 0) return '';
  const received = new Date(millis);
  return Number.isNaN(received.getTime()) ? '' : received.toISOString();
}

/** Build the privacy-bounded message metadata emitted by the digest. */
function summarizeGmailMessage(msg) {
  const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [String(x.name || '').toLowerCase(), x.value]));
  const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds : [];
  const unread = labelIds.includes('UNREAD');
  const important = labelIds.includes('IMPORTANT');
  const starred = labelIds.includes('STARRED');
  const internalDate = msg.internalDate == null ? '' : String(msg.internalDate);
  return {
    id: String(msg.id || ''),
    from: h.from || '',
    subject: h.subject || '(no subject)',
    date: h.date || '',
    internalDate,
    receivedAt: gmailReceivedAt(internalDate),
    snippet: msg.snippet || '',
    unread,
    important,
    starred,
    providerFlags: { unread, important, starred },
  };
}

/** Fetch one Gmail JSON resource and fail closed on HTTP/provider errors. */
async function gmailGet(token, url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gmail API ${response.status}: ${detail.slice(0, 160)}`);
  }
  const data = await response.json();
  if (data?.error) {
    throw new Error(`Gmail API error: ${String(data.error.message || data.error).slice(0, 160)}`);
  }
  return data;
}

async function gmailDigest(token) {
  const list = await gmailGet(
    token,
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + encodeURIComponent('newer_than:1d') + '&maxResults=25',
  );
  const out = [];
  for (const m of (list.messages || []).slice(0, 25)) {
    const msg = await gmailGet(
      token,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    );
    out.push(summarizeGmailMessage(msg));
  }
  return out;
}

/** Decode one base64url Gmail body part. */
function decodeB64Url(data) {
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Walk a Gmail payload tree and concatenate every text/plain + text/html part. The digest
 *  path deliberately never does this; `verify` needs it because activation LINKS live in the
 *  body, past the snippet. The text is used ONLY to extract a token and is never emitted. */
function collectBodyText(payload) {
  const out = [];
  const walk = (p) => {
    if (!p) return;
    const mime = String(p.mimeType || '');
    if (p.body && p.body.data && (mime === 'text/plain' || mime === 'text/html')) out.push(decodeB64Url(p.body.data));
    for (const part of (p.parts || [])) walk(part);
  };
  walk(payload);
  return out.join('\n');
}

/** Extract a verification CODE and/or activation LINK from one message's text.
 *  Ordered patterns: a code sitting next to a verify/code word beats a bare number, because a
 *  bare \d{4,8} in ATS mail is usually a year, salary, or requisition id — the naive first-number
 *  grab is why the old lookup returned junk. Returns nulls when absent rather than guessing. */
function extractVerification(text) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  let code = null;
  const codePatterns = [
    /(?:verification|security|one[- ]?time|access|confirmation|login)\s*(?:code|pin|passcode)\D{0,24}?\b([A-Z0-9]{4,8})\b/i,
    /\b(?:code|pin|passcode)\s*(?:is|:)\s*\b([A-Z0-9]{4,8})\b/i,
    /\b(\d{6})\b/, // the ubiquitous 6-digit shape — last resort only
  ];
  for (const re of codePatterns) {
    const m = flat.match(re);
    if (m) { code = m[1]; break; }
  }
  const urls = flat.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
  const link = urls.find((u) => /verify|verification|activate|activation|confirm|invitation|invite|setpassword|createpassword|token/i.test(u)) || null;
  return { code, link };
}

/** Poll for a verification mail and return ONLY the extracted token.
 *
 *  Two things the old one-shot lookup got wrong and this fixes:
 *   - it did not WAIT, so calling it the moment a site says "we emailed you" usually raced the
 *     mail and returned null; this polls until `waitSec`.
 *   - Gmail's `newer_than:` only understands d/m/y (an `1h` window is silently NOT an hour), so
 *     recency is enforced client-side off internalDate: only mail newer than (start - graceSec)
 *     counts, which keeps a stale code from an earlier signup out of the result.
 *  @param {string} token Bearer access token for the caller's own mailbox.
 *  @param {{fromDomain?:string, waitSec?:number, graceSec?:number}} opts
 *  @returns {Promise<{code:string|null, link:string|null, from?:string, subject?:string, receivedAt?:string, id?:string, reason?:string}>}
 */
async function gmailVerify(token, opts) {
  const { fromDomain = '', waitSec = 90, graceSec = 180 } = opts || {};
  const terms = '(verification OR verify OR code OR passcode OR "one-time" OR confirm OR activate OR activation)';
  const q = `newer_than:1d ${terms}` + (fromDomain ? ` from:${fromDomain}` : '');
  const floorMs = Date.now() - graceSec * 1000; // ignore anything older than the grace window
  const deadline = Date.now() + waitSec * 1000;
  const seen = new Set();
  for (;;) {
    const list = await gmailGet(
      token,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + encodeURIComponent(q) + '&maxResults=10',
    );
    for (const m of (list.messages || [])) { // Gmail lists newest-first
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const msg = await gmailGet(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`);
      if (Number(msg.internalDate) < floorMs) continue; // stale — predates this request
      const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [String(x.name || '').toLowerCase(), x.value]));
      const { code, link } = extractVerification((msg.snippet || '') + ' ' + collectBodyText(msg.payload));
      if (code || link) {
        return { code, link, from: h.from || '', subject: h.subject || '', receivedAt: gmailReceivedAt(msg.internalDate), id: String(msg.id) };
      }
    }
    if (Date.now() >= deadline) return { code: null, link: null, reason: `no verification mail within ${waitSec}s` };
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function calendarDigest(token) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}&singleEvents=true&orderBy=startTime`;
  const data = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json();
  return (data.items || []).map((e) => ({ summary: e.summary || '(busy)', start: e.start?.dateTime || e.start?.date || '' }));
}

async function digestForToken(token, account) {
  // Gmail is the provider record used for priority-email facts, so it must fail closed. Calendar is
  // ancillary to this record and remains optional: a Calendar outage must not falsify Gmail state.
  const [emails, events] = await Promise.all([gmailDigest(token), calendarDigest(token).catch(() => [])]);
  const retrievedAt = new Date().toISOString();
  console.log(JSON.stringify({ account, date: retrievedAt.slice(0, 10), retrievedAt, emails, events }, null, 2));
}

/** Dispatch the requested verb for an already-resolved token, so `verify` and the digest share
 *  the identical (token-broker OR per-user DB-decrypt) auth path and its multi-account guards. */
async function runForToken(token, account) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'verify') {
    const flag = (name, dflt) => {
      const i = argv.indexOf('--' + name);
      return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
    };
    const res = await gmailVerify(token, {
      fromDomain: flag('from', ''),
      waitSec: Math.max(0, Number(flag('wait', '90')) || 0),
      graceSec: Math.max(0, Number(flag('grace', '180')) || 0),
    });
    console.log(JSON.stringify({ account, ...res }, null, 2));
    return;
  }
  await digestForToken(token, account);
}

async function main() {
  // Token broker: if the controller handed us a token, use it directly — no DB, no SESSION_SECRET.
  const provided = resolveProvidedToken();
  if (provided) {
    try {
      await runForToken(provided, process.env.GMAIL_ACCOUNT || 'connected');
    } catch (err) {
      console.error('oshal-gmail failed: ' + (err && err.message || err));
      process.exit(1);
    }
    return;
  }
  // Fallback: decrypt the per-user token from the DB (legacy path; needs SESSION_SECRET).
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { token, account } = await getAccessToken(pool);
    await runForToken(token, account);
  } catch (err) {
    console.error('oshal-gmail failed: ' + (err && err.message || err));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
}

module.exports = { gmailDigest, summarizeGmailMessage, gmailVerify, extractVerification, collectBodyText, key, gcmDecryptRaw, decrypt, userDek, decryptToken };
