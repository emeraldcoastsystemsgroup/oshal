#!/usr/bin/env node
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                          | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2026-06-20 ... | maintainer@emeraldcoastsystemsgroup.com | Feeds provider CLI: the
 *   registered `slack_feed` tool. Returns the signed-in user's indexed Slack feed as a
 *   JSON snapshot (recent messages, hot channels, top voices, counts, sentiment) so the
 *   feeds-curator bot — and Jarvis routing to it — can answer "what did I miss" over real
 *   data. Reads the feed_messages index the cron builds; no Slack token needed here. Mirrors
 *   scripts/oshal-jobhunter.js (per-user via OSHAL_USER_SUB / .oshal-user-sub, pg via DATABASE_URL).
 *
 * Verbs: query (default) — emit the JSON snapshot to stdout. Exit 2 = no user identity.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** OSHAL_USER_SUB env, or the cwd-relative file the dispatcher drops (sandbox may not forward env). */
function resolveUserSub() {
  if (process.env.OSHAL_USER_SUB) return process.env.OSHAL_USER_SUB.trim();
  try { return fs.readFileSync(path.join(process.cwd(), '.oshal-user-sub'), 'utf8').trim() || undefined; }
  catch { return undefined; }
}

async function main() {
  const userSub = resolveUserSub();
  if (!userSub) { console.error('No user identity. Set OSHAL_USER_SUB (the signed-in user).'); process.exit(2); }

  const { Pool } = require('pg');
  // node-postgres reads PG* env, NOT DATABASE_URL — pass the connection string explicitly.
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const pool = new Pool(connectionString ? { connectionString } : {});
  try {
    const rows = (await pool.query(
      `SELECT channel_name, channel_type, author_name, text, posted_at, sentiment, sentiment_label
         FROM feed_messages WHERE user_sub = $1 AND source = 'slack'
         ORDER BY posted_at DESC LIMIT 200`, [userSub])).rows;
    const settings = (await pool.query(
      `SELECT poll_enabled, last_synced_at, sentiment_enabled FROM feed_settings WHERE user_sub = $1`, [userSub])).rows[0] || {};

    // The user's own Slack member id, so we can detect @-mentions of them (raw text holds <@Uxxxx>).
    const meRow = (await pool.query(
      `SELECT account_id FROM oshal_connections WHERE user_sub = $1 AND provider = 'slack' ORDER BY updated_at DESC LIMIT 1`, [userSub],
    )).rows[0];
    const mentionTag = meRow && meRow.account_id ? `<@${String(meRow.account_id)}` : null;

    const byChannel = {}; const byUser = {}; let scored = 0; let sentimentSum = 0; let mentionsTotal = 0;
    for (const r of rows) {
      const ch = r.channel_name || 'unknown';
      const c = byChannel[ch] = byChannel[ch] || { count: 0, people: new Set(), mentions: 0, type: r.channel_type, last: r.posted_at };
      c.count++; if (r.author_name) c.people.add(r.author_name);
      if (r.posted_at && (!c.last || new Date(r.posted_at) > new Date(c.last))) c.last = r.posted_at;
      if (mentionTag && String(r.text || '').includes(mentionTag)) { c.mentions++; mentionsTotal++; }
      if (r.author_name) byUser[r.author_name] = (byUser[r.author_name] || 0) + 1;
      if (r.sentiment != null) { scored++; sentimentSum += Number(r.sentiment); }
    }
    const now = Date.now();
    const recencyBoost = (t) => { if (!t) return 0; const h = (now - new Date(t).getTime()) / 3600e3; return h < 24 ? 3 : h < 72 ? 1 : 0; };

    const hotChannels = Object.entries(byChannel)
      .map(([channel, v]) => ({ channel, messages: v.count, people: v.people.size, mentionsOfYou: v.mentions }))
      .sort((a, b) => b.messages - a.messages).slice(0, 8);
    const topVoices = Object.entries(byUser)
      .map(([person, messages]) => ({ person, messages }))
      .sort((a, b) => b.messages - a.messages).slice(0, 8);
    // What to FOLLOW: rank real channels (skip 1:1 DMs — already direct) by mentions-of-you,
    // then volume, then recency. Each carries a one-line reason the curator can read out.
    const followSuggestions = Object.entries(byChannel)
      .filter(([, v]) => v.type !== 'im')
      .map(([channel, v]) => ({
        channel, type: v.type, messages: v.count, mentionsOfYou: v.mentions,
        score: v.mentions * 5 + v.count + recencyBoost(v.last),
        reason: v.mentions
          ? `${v.mentions} mention${v.mentions > 1 ? 's' : ''} of you · ${v.count} msgs`
          : `${v.count} msgs${recencyBoost(v.last) >= 3 ? ' · active today' : ''} · ${v.people.size} ${v.people.size === 1 ? 'person' : 'people'}`,
      }))
      .sort((a, b) => b.score - a.score).slice(0, 6);
    const recent = rows.slice(0, 40).map((r) => ({
      channel: r.channel_name, type: r.channel_type, from: r.author_name,
      text: String(r.text || '').slice(0, 500), at: r.posted_at,
      sentiment: r.sentiment != null ? Number(r.sentiment) : null, mood: r.sentiment_label || null,
    }));

    console.log(JSON.stringify({
      connected: rows.length > 0 || settings.poll_enabled != null,
      totalIndexed: rows.length,
      lastSyncedAt: settings.last_synced_at || null,
      sentimentEnabled: !!settings.sentiment_enabled,
      overallMood: scored ? (sentimentSum / scored) : null,
      activeChannels: Object.keys(byChannel).length,
      peopleTalking: Object.keys(byUser).length,
      mentionsOfYou: mentionsTotal,
      followSuggestions,
      hotChannels,
      topVoices,
      recent,
    }));
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message || String(e)); process.exit(1); });
