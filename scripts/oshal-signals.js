#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The social bot's db tool — reads the user's OWN social signals from the email DB (oshal_inbox_messages) + connected accounts, scoped to OSHAL_USER_SUB.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Rewrite to match Content Studio's "People to Engage": scan the user's Gmail LIVE by SOCIAL SENDERS (linkedin/facebook/instagram/x newer_than:21d) instead of the narrow Gmail CATEGORY_SOCIAL label (which caught only 3). Uses the broker-provided access token (.oshal-cred-google / OSHAL_CRED_GOOGLE) — NO SESSION_SECRET, no DB decryption — so it runs safely in the communications-bot's no-master-key container. The bot reasons over the result to surface congratulate/follow/engage opportunities.
 *
 *   node scripts/oshal-signals.js            # JSON of accounts + recent social-sender emails for OSHAL_USER_SUB
 *   node scripts/oshal-signals.js --limit 30 # cap (default 25)
 *
 * Exit 2 = no user identity / no Gmail token available (tell the user to connect Google).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/** Per-user scoping: env first, then the cwd file the harness wrappers drop. */
function resolveUserSub() {
  if (process.env.OSHAL_USER_SUB) return process.env.OSHAL_USER_SUB;
  try { return (fs.readFileSync(path.join(process.cwd(), '.oshal-user-sub'), 'utf8').trim() || undefined); }
  catch { return undefined; }
}

/** Token broker: the controller-decrypted Google access token for THIS user (no SESSION_SECRET). */
function resolveGoogleToken() {
  try { const t = fs.readFileSync(path.join(process.cwd(), '.oshal-cred-google'), 'utf8').trim(); if (t) return t; }
  catch { /* try env */ }
  return process.env.OSHAL_CRED_GOOGLE || undefined;
}

function resolveLimit() {
  const i = process.argv.indexOf('--limit');
  const n = i >= 0 ? parseInt(process.argv[i + 1], 10) : NaN;
  return Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : 25;
}

const SOCIAL_PROVIDERS = ['twitter', 'linkedin', 'facebook', 'meta-business', 'instagram'];
// Same senders Content Studio scans — sender-based catches platform notifications that
// Gmail's CATEGORY_SOCIAL label misses (anniversaries, follows, mentions, messages).
const GMAIL_QUERY = '(from:linkedin.com OR from:facebookmail.com OR from:mail.instagram.com OR '
  + 'from:x.com OR from:twitter.com OR from:facebook.com OR from:mail.goodreads.com) newer_than:21d';

/** Live Gmail scan for social-network notification emails (read-only metadata). */
async function scanGmailSocial(token, limit) {
  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + encodeURIComponent(GMAIL_QUERY) + '&maxResults=' + limit,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!listRes.ok) throw new Error('gmail list ' + listRes.status + ' ' + (await listRes.text()).slice(0, 120));
  const list = await listRes.json();
  const out = [];
  for (const m of (list.messages || []).slice(0, limit)) {
    const mr = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!mr.ok) continue;
    const msg = await mr.json();
    const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
    out.push({
      from: h.from || '', subject: h.subject || '(no subject)', snippet: msg.snippet || '',
      date: h.date || '', link: extractPlatformLink(msg.payload),
    });
  }
  return out;
}

/** Domains whose links are the actual post/profile to engage with. */
const LINK_DOMAINS = ['linkedin.com', 'instagram.com', 'facebook.com', 'x.com', 'twitter.com', 'goodreads.com'];

/** Walk a Gmail payload, decode text parts, and return the first platform link (the
 *  click-through to the post/profile) so the bot can hand the user a real link to engage. */
function extractPlatformLink(payload) {
  const texts = [];
  (function walk(p) {
    if (!p) return;
    if (p.body?.data) {
      try { texts.push(Buffer.from(p.body.data, 'base64').toString('utf8')); } catch { /* skip */ }
    }
    (p.parts || []).forEach(walk);
  })(payload);
  const body = texts.join(' ');
  const urls = body.match(/https?:\/\/[^\s"'<>)\]\[]+/g) || [];
  const hit = urls.find((u) => LINK_DOMAINS.some((d) => u.includes(d)));
  return hit ? hit.replace(/[).,]+$/, '') : null;
}

/** Connected social accounts (provider names only — NO token decryption). */
async function connectedSocialAccounts(userSub) {
  if (!process.env.DATABASE_URL) return [];
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const rows = (await pool.query(
      `SELECT provider, account_email FROM oshal_connections WHERE user_sub=$1 AND provider = ANY($2::text[]) ORDER BY provider`,
      [userSub, SOCIAL_PROVIDERS],
    )).rows;
    return rows.map((c) => ({ provider: c.provider, account: c.account_email || null }));
  } finally { await pool.end().catch(() => {}); }
}

async function main() {
  const userSub = resolveUserSub();
  if (!userSub) {
    console.error('No user identity (OSHAL_USER_SUB unset). This tool reads only the signed-in user\'s own social.');
    process.exit(2);
  }
  const token = resolveGoogleToken();
  const connectedAccounts = await connectedSocialAccounts(userSub).catch(() => []);

  let socialSignals = [];
  let scanError = null;
  if (token) {
    try { socialSignals = await scanGmailSocial(token, resolveLimit()); }
    catch (e) { scanError = e && e.message ? e.message : String(e); }
  }

  const out = {
    connectedAccounts,
    socialSignals,
    signalCount: socialSignals.length,
    note: !token
      ? 'No Google token available — tell the user to connect Google at /utilities so their social notifications can be read.'
      : scanError
        ? `Couldn't scan Gmail (${scanError}). Tell the user to reconnect Google at /utilities.`
        : socialSignals.length
          ? 'These are the user\'s REAL recent social notifications. Pick the genuine engagement opportunities (congratulate a work anniversary/new job, reply to a message, follow-back, react/comment), name the person, and INCLUDE the `link` so they can click straight to the post/profile. Then offer to draft the note. IMPORTANT — what OSHAL can actually do: it CAN publish a post to the user\'s own LinkedIn/X/Facebook-Page (human-approved in the Composer); it CANNOT comment on someone else\'s post or send a DM (no platform API for that), so for a reply/comment, offer to draft the text and tell them to paste it via the link. Do NOT invent activity or fall back to generic web trends.'
          : 'No recent social notifications. Suggest the user forward their X/LinkedIn/Facebook email alerts to their connected inbox so this feed fills in.',
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((err) => { console.error('oshal-signals failed:', err && err.message ? err.message : String(err)); process.exit(1); });
