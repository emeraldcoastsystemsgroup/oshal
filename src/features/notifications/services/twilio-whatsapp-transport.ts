/**
 * Notifications — WhatsApp-via-Twilio transport (the sanctioned WhatsApp path).
 *
 * The fourth `NotificationTransport` and the one that closes the WhatsApp gap WITHOUT direct Meta
 * Business verification: Twilio is a sanctioned WhatsApp Business API reseller, so this is "the same
 * adapter with a different Twilio endpoint" the backlog called out. It hits the SAME Messages API as
 * the SMS sibling — the only differences are the `whatsapp:` address prefix on From/To and native
 * media via `MediaUrl` (WhatsApp carries media inline, so — unlike SMS — there is no link fallback).
 *
 * BYO-account, reusing the same Twilio credentials as the SMS/voice siblings: `TWILIO_ACCOUNT_SID`,
 * `TWILIO_AUTH_TOKEN`, plus a WhatsApp-enabled sender `TWILIO_WHATSAPP_FROM` and a destination
 * `TWILIO_WHATSAPP_TO` / `NOTIFY_WHATSAPP_TO`. Missing any => configured() false => no-op. The auth
 * token is never surfaced in a result, error, or log. Numbers are accepted with or without the
 * `whatsapp:` prefix (added if absent), so operators can paste a bare E.164 number.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — TwilioWhatsAppTransport (Messages API, whatsapp: prefix, native MediaUrl, BYO account, no-op when unconfigured, auth token never surfaced).
 *
 * @module features/notifications/services/twilio-whatsapp-transport
 */

import { createChildLogger } from '@/shared/logger';
import type { NotificationMessage, NotificationResult, NotificationTransport, TransportDeps } from '../types';

const logger = createChildLogger({ module: 'notifications:twilio-whatsapp' });

/**
 * @description Normalises a phone number into a Twilio WhatsApp address by prefixing `whatsapp:`
 * when it isn't already present. Accepts a bare E.164 number so operators needn't know the prefix.
 * @param n - a phone number, with or without the `whatsapp:` prefix
 * @returns the `whatsapp:`-prefixed address
 */
export function whatsAppAddr(n: string): string {
  const trimmed = n.trim();
  return trimmed.toLowerCase().startsWith('whatsapp:') ? trimmed : `whatsapp:${trimmed}`;
}

/** Outbound WhatsApp over the Twilio Messages API (BYO account, sanctioned WhatsApp reseller path). */
export class TwilioWhatsAppTransport implements NotificationTransport {
  readonly kind = 'twilio-whatsapp' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: TransportDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.env = deps.env ?? process.env;
  }

  private sid(): string { return (this.env.TWILIO_ACCOUNT_SID || '').trim(); }
  private authToken(): string { return (this.env.TWILIO_AUTH_TOKEN || '').trim(); }
  private from(): string { return (this.env.TWILIO_WHATSAPP_FROM || '').trim(); }
  private to(): string { return (this.env.TWILIO_WHATSAPP_TO || this.env.NOTIFY_WHATSAPP_TO || '').trim(); }

  /** True only when the account, auth token, WhatsApp sender, and destination are all present. */
  configured(): boolean {
    return this.sid().length > 0 && this.authToken().length > 0 && this.from().length > 0 && this.to().length > 0;
  }

  /**
   * @description Deliver a WhatsApp message via the Twilio Messages API. Media is sent natively as
   * `MediaUrl` (no link fallback — WhatsApp carries it inline), with any caption folded into the body.
   * Resolves (never throws): missing config is `skipped`, an API/network failure is a sanitized `error`.
   * @param message - The notification (text + optional media).
   * @returns The delivery result.
   */
  async send(message: NotificationMessage): Promise<NotificationResult> {
    if (!this.configured()) {
      return { delivered: false, skipped: true, transport: this.kind, error: 'twilio_whatsapp_not_configured' };
    }
    const body = message.media?.caption ? `${message.text}\n${message.media.caption}` : message.text;

    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.sid()}/Messages.json`;
      const form = new URLSearchParams({ From: whatsAppAddr(this.from()), To: whatsAppAddr(this.to()), Body: body });
      if (message.media) form.set('MediaUrl', message.media.url);
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
        throw new Error(`twilio_whatsapp_http_${resp.status}${json.message ? `:${json.message}` : ''}`);
      }
      return { delivered: true, transport: this.kind, id: json.sid };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'twilio_whatsapp_send_failed';
      logger.warn({ error }, 'twilio whatsapp send failed');
      return { delivered: false, transport: this.kind, error };
    }
  }
}
