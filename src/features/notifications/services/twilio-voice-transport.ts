/**
 * Notifications — Twilio voice transport (the "call me" leg).
 *
 * The third `NotificationTransport` sibling: places a phone CALL that speaks the message via inline
 * TwiML `<Say>`, for the highest-urgency alerts (the millionaire-alarm "call me" leg the backlog
 * names — text+SMS+call). Reaches any phone with no app. BYO-Twilio-account, same as the SMS sibling
 * (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER` + a destination); missing any =>
 * no-op. The auth token never appears in a result, error, or log.
 *
 * Voice carries no media, so a media link is NOT spoken (a URL read aloud is useless) — the caption
 * is spoken when present; otherwise just the text. The spoken text is XML-escaped so it can never
 * break (or inject into) the TwiML document.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — TwilioVoiceTransport (Calls API, inline TwiML <Say>, XML-escaped text, no-op when unconfigured, auth token never surfaced).
 *
 * @module features/notifications/services/twilio-voice-transport
 */

import { createChildLogger } from '@/shared/logger';
import type { NotificationMessage, NotificationResult, NotificationTransport, TransportDeps } from '../types';

const logger = createChildLogger({ module: 'notifications:twilio-voice' });

/** Escape text for safe inclusion inside a TwiML XML element. */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Outbound voice call over the Twilio Calls API (BYO account). */
export class TwilioVoiceTransport implements NotificationTransport {
  readonly kind = 'twilio-voice' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: TransportDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.env = deps.env ?? process.env;
  }

  private sid(): string { return (this.env.TWILIO_ACCOUNT_SID || '').trim(); }
  private authToken(): string { return (this.env.TWILIO_AUTH_TOKEN || '').trim(); }
  private from(): string { return (this.env.TWILIO_FROM_NUMBER || '').trim(); }
  private to(): string { return (this.env.TWILIO_TO_NUMBER || this.env.NOTIFY_VOICE_TO || '').trim(); }

  /** True only when account, auth token, from-number, and destination are all present. */
  configured(): boolean {
    return this.sid().length > 0 && this.authToken().length > 0 && this.from().length > 0 && this.to().length > 0;
  }

  /**
   * @description Place a call that speaks the message. Resolves (never throws): missing config is
   * `skipped`, an API/network failure is a sanitized `error` result.
   * @param message - The notification (the media caption, else the text, is spoken).
   * @returns The delivery result.
   */
  async send(message: NotificationMessage): Promise<NotificationResult> {
    if (!this.configured()) {
      return { delivered: false, skipped: true, transport: this.kind, error: 'twilio_voice_not_configured' };
    }
    const spoken = message.media?.caption?.trim() || message.text;
    const twiml = `<Response><Say>${xmlEscape(spoken)}</Say></Response>`;
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.sid()}/Calls.json`;
      const form = new URLSearchParams({ From: this.from(), To: this.to(), Twiml: twiml });
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.sid()}:${this.authToken()}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      const json = (await resp.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!resp.ok || !json.sid) {
        throw new Error(`twilio_voice_http_${resp.status}${json.message ? `:${json.message}` : ''}`);
      }
      return { delivered: true, transport: this.kind, id: json.sid };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'twilio_voice_send_failed';
      logger.warn({ error }, 'twilio voice send failed');
      return { delivered: false, transport: this.kind, error };
    }
  }
}
