/**
 * Slack client — the one place that turns a user's Slack token into a normalized message
 * feed. Shared by the live read route (slack-routes) and the durable indexer (feeds-indexing)
 * so both pull the same way: list the user's conversations, pull recent history per channel,
 * resolve author handles, merge newest-first.
 *
 * Bounded by caps (reported in `meta`, never silent) so a single pull stays under Slack's
 * tier-3 rate limits. Pure data fetch — no DB, no Express, no secrets beyond the token.
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — extracted the feed-pull
 *            | out of slack-routes so the Feeds indexer/cron can reuse it.
 * ---------------------------------------------------------------------------
 * @module slack-client
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'slack-client' });
const SLACK_API = 'https://slack.com/api';

export interface SlackFeedMessage {
  channelId: string;
  channel: string;
  type: 'channel' | 'private' | 'im' | 'mpim';
  userId: string | null;
  user: string | null;
  text: string;
  ts: string;
  time: string; // ISO
}

export interface SlackPullMeta {
  channelsScanned: number;
  channelsDropped: number;
  usersDropped: number;
  channelErrors: Array<{ channel: string; error: string }>;
  perChannelLimit: number;
}

export interface SlackPullResult {
  messages: SlackFeedMessage[];
  meta: SlackPullMeta;
}

export interface SlackPullOptions {
  maxChannels?: number; // conversations scanned per pull
  perChannel?: number;  // messages pulled per conversation
  maxUsers?: number;    // unique author handle lookups
}

const DEFAULTS = { maxChannels: 25, perChannel: 15, maxUsers: 80 };

/** A Slack Web API GET. Slack always HTTP-200s; real failure is in { ok:false, error }. */
async function slackGet(token: string, method: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${SLACK_API}/${method}${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.json().catch(() => ({ ok: false, error: 'bad_json' }));
}

/**
 * @description Pull the user's recent messages across channels + DMs + group DMs, merged
 * newest-first, with author handles resolved.
 * @param token - a Slack USER token (xoxp).
 * @param opts - caps.
 * @returns the normalized messages + a meta block describing any caps/errors applied.
 */
export async function pullSlackFeed(token: string, opts: SlackPullOptions = {}): Promise<SlackPullResult> {
  const maxChannels = opts.maxChannels ?? DEFAULTS.maxChannels;
  const perChannel = opts.perChannel ?? DEFAULTS.perChannel;
  const maxUsers = opts.maxUsers ?? DEFAULTS.maxUsers;

  // 1) The conversations the user is a member of.
  const convResp = await slackGet(token, 'users.conversations', {
    types: 'public_channel,private_channel,im,mpim',
    exclude_archived: 'true',
    limit: '200',
  });
  if (!convResp.ok) throw new Error(`slack users.conversations failed: ${convResp.error || 'unknown'}`);
  const allConvos: any[] = Array.isArray(convResp.channels) ? convResp.channels : [];
  const convos = allConvos.slice(0, maxChannels);
  const channelsDropped = Math.max(0, allConvos.length - convos.length);

  // 2) Recent history per conversation (sequential — keeps us under the tier-3 limit).
  const messages: SlackFeedMessage[] = [];
  const userIds = new Set<string>();
  const channelErrors: Array<{ channel: string; error: string }> = [];
  for (const c of convos) {
    const type: SlackFeedMessage['type'] = c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private ? 'private' : 'channel';
    if (c.is_im && c.user) userIds.add(c.user);
    const hist = await slackGet(token, 'conversations.history', { channel: c.id, limit: String(perChannel) });
    if (!hist.ok) { channelErrors.push({ channel: c.id, error: String(hist.error || 'unknown') }); continue; }
    for (const m of (hist.messages || [])) {
      if (m.subtype && m.subtype !== 'thread_broadcast') continue; // skip joins/leaves/bot noise
      if (m.user) userIds.add(m.user);
      messages.push({
        channelId: c.id,
        channel: c.name || (c.is_im ? `dm:${c.user || c.id}` : c.id),
        type,
        userId: m.user || null,
        user: null, // filled in step 3
        text: String(m.text || ''),
        ts: m.ts,
        time: new Date(Math.floor(parseFloat(m.ts) * 1000)).toISOString(),
      });
    }
  }

  // 3) Resolve user ids -> display handles (capped; uncapped ids stay as raw ids).
  const ids = Array.from(userIds).slice(0, maxUsers);
  const usersDropped = Math.max(0, userIds.size - ids.length);
  const names = new Map<string, string>();
  for (const uid of ids) {
    const info = await slackGet(token, 'users.info', { user: uid });
    if (info.ok && info.user) {
      const u = info.user;
      names.set(uid, u.profile?.display_name || u.real_name || u.name || uid);
    }
  }
  for (const m of messages) {
    if (m.userId) m.user = names.get(m.userId) || m.userId;
    if (m.type === 'im' && m.channel.startsWith('dm:')) {
      const partner = m.channel.slice(3);
      m.channel = `DM · ${names.get(partner) || partner}`;
    }
  }

  // 4) Merge newest-first.
  messages.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));

  if (channelsDropped || usersDropped || channelErrors.length) {
    logger.info({ channelsDropped, usersDropped, channelErrors: channelErrors.length }, 'slack pull: caps/errors applied');
  }
  return {
    messages,
    meta: { channelsScanned: convos.length, channelsDropped, usersDropped, channelErrors, perChannelLimit: perChannel },
  };
}

/** Validate a token + return the workspace/handle label (auth.test). */
export async function slackIdentity(token: string): Promise<{ ok: boolean; team?: string; user?: string; userId?: string }> {
  const j = await slackGet(token, 'auth.test');
  return { ok: !!j.ok, team: j.team, user: j.user, userId: j.user_id };
}
