/**
 * Notifications — Telegram transport (first-party, free, bidirectional-capable channel).
 *
 * The reference `NotificationTransport`: pushes to the operator's Telegram chat via the Bot API. It
 * is the free first-party default (vs Twilio, the paid universal-reach sibling). Config is BYO by
 * The operator's own hand (never through a chat transcript, per the security rule): `TELEGRAM_BOT_TOKEN`
 * (@BotFather) + `TELEGRAM_CHAT_ID` (the chat that messaged the bot first). No token => configured()
 * false => send() is a no-op. The token is never placed in a result, error, or log.
 *
 * Video ≤ the Bot API's ~50MB cap is sent inline via sendVideo; larger (or unknown-size) media falls
 * back to a text+link sendMessage so a big creative-studio render still arrives as a playable link.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — TelegramTransport (sendMessage/sendVideo, 50MB link fallback, no-op when unconfigured, token never surfaced).
 *
 * @module features/notifications/services/telegram-transport
 */

import { createChildLogger } from '@/shared/logger';
import type { NotificationMessage, NotificationResult, NotificationTransport, TransportDeps } from '../types';

const logger = createChildLogger({ module: 'notifications:telegram' });

/** Telegram Bot API inline-upload cap for video (~50 MB); larger media is sent as a link. */
export const TELEGRAM_MAX_INLINE_BYTES = 50 * 1024 * 1024;

/** Outbound Telegram transport over the Bot API. */
export class TelegramTransport implements NotificationTransport {
  readonly kind = 'telegram' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: TransportDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.env = deps.env ?? process.env;
  }

  private token(): string { return (this.env.TELEGRAM_BOT_TOKEN || '').trim(); }
  private chatId(): string { return (this.env.TELEGRAM_CHAT_ID || '').trim(); }

  /** True only when both the bot token and the target chat id are present. */
  configured(): boolean {
    return this.token().length > 0 && this.chatId().length > 0;
  }

  /**
   * @description Deliver a message to the configured Telegram chat. Resolves (never throws): a
   * missing config is `skipped`, an API/network error is a sanitized `error` result.
   * @param message - The notification (text + optional media).
   * @returns The delivery result.
   */
  async send(message: NotificationMessage): Promise<NotificationResult> {
    if (!this.configured()) {
      return { delivered: false, skipped: true, transport: this.kind, error: 'telegram_not_configured' };
    }
    const inlineVideo = message.media
      && message.media.kind === 'video'
      && typeof message.media.sizeBytes === 'number'
      && message.media.sizeBytes <= TELEGRAM_MAX_INLINE_BYTES;

    try {
      return inlineVideo
        ? await this.sendVideo(message)
        : await this.sendMessage(message);
    } catch (err) {
      // Sanitized: the message here is our own string / a status line, never the token.
      const error = err instanceof Error ? err.message : 'telegram_send_failed';
      logger.warn({ error }, 'telegram send failed');
      return { delivered: false, transport: this.kind, error };
    }
  }

  /** POST a text message (with the media link appended when media is present but not inlined). */
  private async sendMessage(message: NotificationMessage): Promise<NotificationResult> {
    const fellBackToLink = Boolean(message.media);
    const text = message.media
      ? `${message.text}\n${message.media.caption ? `${message.media.caption}\n` : ''}${message.media.url}`
      : message.text;
    const res = await this.call('sendMessage', { chat_id: this.chatId(), text, disable_web_page_preview: false });
    return { delivered: true, transport: this.kind, id: res, ...(fellBackToLink ? { fellBackToLink: true } : {}) };
  }

  /** POST an inline video (Telegram fetches the URL). */
  private async sendVideo(message: NotificationMessage): Promise<NotificationResult> {
    const res = await this.call('sendVideo', {
      chat_id: this.chatId(), video: message.media!.url,
      caption: message.media!.caption ?? message.text,
    });
    return { delivered: true, transport: this.kind, id: res };
  }

  /** One Bot API call. Returns the message id string. Throws a sanitized Error on non-ok. */
  private async call(method: string, body: Record<string, unknown>): Promise<string> {
    const url = `https://api.telegram.org/bot${this.token()}/${method}`;
    const resp = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Read the Telegram result WITHOUT reproducing the request (which carried the token in the URL).
    const json = (await resp.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id?: number }; description?: string };
    if (!resp.ok || !json.ok) {
      throw new Error(`telegram_${method}_http_${resp.status}${json.description ? `:${json.description}` : ''}`);
    }
    return String(json.result?.message_id ?? '');
  }
}
