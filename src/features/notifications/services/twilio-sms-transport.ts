/**
 * Notifications — Twilio SMS transport (the paid, universal-reach sibling).
 *
 * The second `NotificationTransport` implementation, proving the harness is genuinely pluggable
 * (BACKLOG done-when: "≥2 real implementations, a first-party channel + Twilio"). Twilio reaches ANY
 * phone number with no app install — the "text me" leg the free first-party channels can't cover.
 * It is a metered third-party pipe, so it is a CHOSEN BYO-account option, never a mandatory default
 * (the ownership caveat in the backlog): config is BYO — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
 * `TWILIO_FROM_NUMBER`, and a destination (`TWILIO_TO_NUMBER` / `NOTIFY_SMS_TO`). Missing any =>
 * configured() false => no-op. The auth token is never surfaced in a result, error, or log.
 *
 * SMS carries no inline media, so a message's media URL is appended to the body (a link the operator
 * taps) — the same graceful degrade the Telegram transport uses for oversized media.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — TwilioSmsTransport (Messages API, Basic auth, media-URL-in-body, no-op when unconfigured, auth token never surfaced).
 *
 * @module features/notifications/services/twilio-sms-transport
 */

import { createChildLogger } from '@/shared/logger';
import type { NotificationMessage, NotificationResult, NotificationTransport, TransportDeps } from '../types';

const logger = createChildLogger({ module: 'notifications:twilio-sms' });

/** Outbound SMS over the Twilio Messages API (BYO account). */
export class TwilioSmsTransport implements NotificationTransport {
  readonly kind = 'twilio-sms' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: TransportDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.env = deps.env ?? process.env;
  }

  private sid(): string { return (this.env.TWILIO_ACCOUNT_SID || '').trim(); }
  private authToken(): string { return (this.env.TWILIO_AUTH_TOKEN || '').trim(); }
  private from(): string { return (this.env.TWILIO_FROM_NUMBER || '').trim(); }
  private to(): string { return (this.env.TWILIO_TO_NUMBER || this.env.NOTIFY_SMS_TO || '').trim(); }

  /** True only when the account, auth token, from-number, and destination are all present. */
  configured(): boolean {
    return this.sid().length > 0 && this.authToken().length > 0 && this.from().length > 0 && this.to().length > 0;
  }

  /**
   * @description Deliver an SMS via the Twilio Messages API. Resolves (never throws): missing config
   * is `skipped`, an API/network failure is a sanitized `error` result.
   * @param message - The notification (text + optional media appended as a link).
   * @returns The delivery result.
   */
  async send(message: NotificationMessage): Promise<NotificationResult> {
    if (!this.configured()) {
      return { delivered: false, skipped: true, transport: this.kind, error: 'twilio_sms_not_configured' };
    }
    const fellBackToLink = Boolean(message.media);
    const body = message.media
      ? `${message.text}\n${message.media.caption ? `${message.media.caption}\n` : ''}${message.media.url}`
      : message.text;

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.sid()}/Messages.json`;
      const form = new URLSearchParams({ From: this.from(), To: this.to(), Body: body });
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          // Basic auth: base64(sid:authToken). The header is never logged / returned.
          Authorization: `Basic ${Buffer.from(`${this.sid()}:${this.authToken()}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      const json = (await resp.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
      if (!resp.ok || !json.sid) {
        throw new Error(`twilio_sms_http_${resp.status}${json.message ? `:${json.message}` : ''}`);
      }
      return { delivered: true, transport: this.kind, id: json.sid, ...(fellBackToLink ? { fellBackToLink: true } : {}) };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'twilio_sms_send_failed';
      logger.warn({ error }, 'twilio sms send failed');
      return { delivered: false, transport: this.kind, error };
    }
  }
}
