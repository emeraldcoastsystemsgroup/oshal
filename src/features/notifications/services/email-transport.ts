/**
 * Notifications — Email transport (the first-party inbox sibling).
 *
 * The fifth `NotificationTransport` and the one that reaches an inbox instead of a phone/chat. It
 * deliberately holds NO SMTP credentials: email is a metered-but-free first-party channel delivered
 * over the SAME Gmail/connector token rail the preference-center email sender already uses
 * (getValidAccessToken → sendGmail). Because that rail lives in the app layer and this slice is
 * FSD-clean, the rail is INJECTED via `TransportDeps.email` (an `EmailTransportRail`) rather than
 * imported. No rail injected (or no recipient) => configured() false => a logged no-op skip, exactly
 * like the env-configured siblings when their creds are absent. The access token never appears in a
 * result, error, or log — it stays inside the rail.
 *
 * SMS-style graceful degrade: a message carries only `text` (+ optional media), so the subject is the
 * first line and any media URL is appended to the body as a tappable link (fellBackToLink).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — EmailTransport over an injected Gmail/connector rail (no SMTP creds), no-op when unconfigured or no token, media-URL-in-body, token never surfaced, resolves (never throws) on a rail error.
 *
 * @module features/notifications/services/email-transport
 */

import { createChildLogger } from '@/shared/logger';
import type { NotificationMessage, NotificationResult, NotificationTransport, TransportDeps } from '../types';

const logger = createChildLogger({ module: 'notifications:email' });

/** Subject line for the email: the first non-empty line of the text, bounded (never a header-injection vector). */
function emailSubject(message: NotificationMessage): string {
  const firstLine = message.text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return (firstLine || 'OSHAL notification').slice(0, 120);
}

/** Body for the email: the full text, with any media appended as a tappable link (email carries no inline media here). */
function emailBody(message: NotificationMessage): string {
  if (!message.media) return message.text;
  const caption = message.media.caption ? `${message.media.caption}\n` : '';
  return `${message.text}\n\n${caption}${message.media.url}`;
}

/** Outbound email over the injected Gmail/connector rail (BYO connector token; no SMTP creds). */
export class EmailTransport implements NotificationTransport {
  readonly kind = 'email' as const;
  private readonly rail?: TransportDeps['email'];

  constructor(deps: TransportDeps = {}) {
    this.rail = deps.email;
  }

  /** True only when the app injected a rail AND it carries a non-empty recipient. */
  configured(): boolean {
    return Boolean(this.rail && this.rail.to.trim().length > 0);
  }

  /**
   * @description Deliver an email via the injected connector rail. Resolves (never throws): no rail /
   * no recipient is `skipped`, a missing token is a logged `skipped`, and a rail failure is a
   * sanitized `error` result. The access token is never logged or returned.
   * @param message - The notification (text + optional media appended as a link).
   * @returns The delivery result.
   */
  async send(message: NotificationMessage): Promise<NotificationResult> {
    if (!this.configured()) {
      return { delivered: false, skipped: true, transport: this.kind, error: 'email_not_configured' };
    }
    const rail = this.rail!;
    const to = rail.to.trim();
    try {
      const token = await rail.getAccessToken();
      if (!token) {
        logger.info({ transport: this.kind }, 'email transport: connector rail returned no access token — skipping (not an error)');
        return { delivered: false, skipped: true, transport: this.kind, error: 'email_no_access_token' };
      }
      const sent = await rail.sendEmail(token, { to, subject: emailSubject(message), body: emailBody(message) });
      const fellBackToLink = Boolean(message.media);
      logger.info({ transport: this.kind, id: sent.id }, 'email notification delivered');
      return { delivered: true, transport: this.kind, id: sent.id, ...(fellBackToLink ? { fellBackToLink: true } : {}) };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'email_send_failed';
      logger.warn({ error }, 'email transport send failed');
      return { delivered: false, transport: this.kind, error };
    }
  }
}
