/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Telegram Bot API adapter: parse inbound updates, send replies, register/verify the webhook. The bot token is a single shared demo bot via TELEGRAM_BOT_TOKEN (BYO-per-user bot tokens are a documented follow-up). Webhook authenticity is enforced by Telegram's secret_token header (sent on every delivery) plus a defense-in-depth path segment; the secret derives deterministically from the bot token so it's stable across restarts without extra config.
 */

import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'telegram-channel-adapter' });

const TELEGRAM_API = 'https://api.telegram.org';

/** A normalized inbound message, provider-agnostic so the dispatcher is channel-neutral. */
export interface InboundChannelMessage {
  provider: 'telegram';
  channelUserId: string;
  chatId: string;
  text: string;
  displayName: string | null;
}

/**
 * @description Reads the configured Telegram bot token. Single shared demo bot for v1.
 * @returns The token, or null when unconfigured (the surface then reports "not set up").
 */
export function getTelegramBotToken(): string | null {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  return token.length > 0 ? token : null;
}

/**
 * @description The webhook secret Telegram sends in `X-Telegram-Bot-Api-Secret-Token` on every
 * delivery. Derived deterministically from the bot token so it's stable without extra config, and
 * unguessable without the token. Also used as the webhook URL path segment (defense in depth).
 * @param token - The bot token.
 * @returns A 32-char hex secret.
 */
export function deriveWebhookSecret(token: string): string {
  return crypto.createHash('sha256').update(`oshal-telegram:${token}`).digest('hex').slice(0, 32);
}

/**
 * @description Constant-time check that an inbound webhook carries the expected secret token.
 * @param provided - The value of the X-Telegram-Bot-Api-Secret-Token header (or path segment).
 * @param expected - The derived secret for this bot.
 * @returns true when they match.
 */
export function verifyWebhookSecret(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * @description Parses a raw Telegram update into a normalized inbound message.
 * Only text messages in PRIVATE chats are handled in v1 — everything else returns null.
 * The private-chat guard is a data boundary, not a feature cut (double-check 2026-07-08):
 * the link is keyed by the SENDER (from.id) while the reply goes to the CHAT (chat.id), so
 * a linked user posting in a group the bot was added to would have their private swarm
 * reply — their data — delivered into the group.
 * @param body - The JSON body Telegram POSTs to the webhook.
 * @returns The normalized message, or null when there's no actionable private-chat text.
 */
export function parseTelegramUpdate(body: unknown): InboundChannelMessage | null {
  const update = body as { message?: TelegramMessage } | null;
  const msg = update?.message;
  if (!msg || typeof msg.text !== 'string' || msg.text.trim().length === 0) return null;
  if (msg.chat?.type !== 'private') return null;
  const from = msg.from;
  const channelUserId = from?.id != null ? String(from.id) : (msg.chat?.id != null ? String(msg.chat.id) : '');
  const chatId = msg.chat?.id != null ? String(msg.chat.id) : channelUserId;
  if (!channelUserId || !chatId) return null;
  return {
    provider: 'telegram',
    channelUserId,
    chatId,
    text: msg.text.trim(),
    displayName: buildDisplayName(from),
  };
}

/** Raw Telegram message shape (only the fields we read). */
interface TelegramMessage {
  text?: string;
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string; first_name?: string; last_name?: string; username?: string };
}

function buildDisplayName(from?: TelegramMessage['from']): string | null {
  if (!from) return null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return name || (from.username ? `@${from.username}` : null);
}

/**
 * @description Sends a text reply back to a Telegram chat via the Bot API.
 * @param chatId - The target chat id (from the inbound message).
 * @param text - The reply text (Telegram caps a single message at 4096 chars — long replies are chunked).
 * @throws Error when the token is unconfigured or the API rejects the send.
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const token = getTelegramBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  for (const chunk of chunkText(text || '(no reply)', 4096)) {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Telegram sendMessage ${res.status}: ${errBody}`);
    }
  }
}

/**
 * @description Sends the "typing…" chat action so the user sees the bot is working while the
 * accountable swarm produces the reply. Best-effort — a failure never blocks the turn.
 * @param chatId - The target chat id.
 */
export async function sendTelegramTyping(chatId: string): Promise<void> {
  const token = getTelegramBotToken();
  if (!token) return;
  try {
    await fetch(`${TELEGRAM_API}/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch (err) {
    logger.debug({ err }, 'telegram typing action failed (non-fatal)');
  }
}

/**
 * @description Registers the webhook with Telegram so it delivers updates to this deployment.
 * @param publicBaseUrl - The public origin OSHAL is reachable at (e.g. https://oswarm.ai).
 * @returns The webhook URL that was registered.
 * @throws Error when the token is unset or Telegram rejects the registration.
 */
export async function registerTelegramWebhook(publicBaseUrl: string): Promise<string> {
  const token = getTelegramBotToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const secret = deriveWebhookSecret(token);
  // FIXED path — the secret travels ONLY as Telegram's secret_token header. Embedding it
  // in the URL persisted it to container logs and the append-only audit log on every
  // delivery (double-check 2026-07-08), turning routine log access into a full
  // impersonation primitive against any linked user.
  const webhookUrl = `${publicBaseUrl.replace(/\/+$/, '')}/api/channels/telegram/webhook`;
  const res = await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: ['message'],
      drop_pending_updates: true,
    }),
  });
  const body = await res.json().catch(() => ({})) as { ok?: boolean; description?: string };
  if (!res.ok || !body.ok) {
    throw new Error(`Telegram setWebhook failed: ${body.description || res.status}`);
  }
  logger.info({ webhookUrl }, 'telegram webhook registered');
  return webhookUrl;
}

/**
 * @description Reads the bot's own identity (used by the setup UI to show which bot is wired and to
 * build the t.me deep link).
 * @returns The bot's username and id, or null when the token is unset/invalid.
 */
export async function getTelegramBotIdentity(): Promise<{ username: string; id: number } | null> {
  const token = getTelegramBotToken();
  if (!token) return null;
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
    const body = await res.json().catch(() => ({})) as { ok?: boolean; result?: { username?: string; id?: number } };
    if (!res.ok || !body.ok || !body.result?.username || body.result.id == null) return null;
    return { username: body.result.username, id: body.result.id };
  } catch (err) {
    logger.warn({ err }, 'telegram getMe failed');
    return null;
  }
}

/** Splits text into <=limit-char chunks on line/space boundaries where possible. */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
