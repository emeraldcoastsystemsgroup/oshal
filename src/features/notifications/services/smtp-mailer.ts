/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Platform-owned transactional mail (ADR-117). Every email path before this one rides a PER-USER OAuth connector token (Gmail/Graph), which a standalone deployment doesn't have — so invitations had no way out of the box. This is the missing platform-credential sibling, following the Telegram/Twilio transport discipline: env-owned credentials (SMTP_*), configured() fails closed when any piece is missing, send() resolves with {ok,detail} and never throws, secrets never appear in results or logs. Variable recipient by design (an invitation addresses the invitee, not the operator inbox) — deliberately NOT the fixed-destination EmailTransportRail. nodemailer is now an explicit dependency (it was already in the tree transitively under imapflow).
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'smtp-mailer' });

/** A transactional message: one recipient, subject, text body, optional HTML alternative. */
export interface TransactionalMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Outcome of a send — `detail` explains a failure without ever carrying credentials. */
export interface MailSendResult {
  ok: boolean;
  detail?: string;
}

function smtpEnv(): { host: string; port: number; user: string; pass: string; secure: boolean; from: string } {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = (process.env.SMTP_SECURE || '').toLowerCase().trim() === 'true' || port === 465;
  const from = (process.env.SMTP_FROM || user).trim();
  return { host, port, user, pass, secure, from };
}

/**
 * @description True when enough SMTP configuration exists to attempt a send. Callers use
 * this to fall back to a copyable link instead of a doomed send (the invite flow must
 * work on a box with no mail server at all).
 *
 * @returns true when SMTP_HOST and a from-address are configured.
 */
export function smtpConfigured(): boolean {
  const { host, from } = smtpEnv();
  return host.length > 0 && from.length > 0;
}

let cachedTransporter: Transporter | null = null;
let cachedKey = '';

function transporter(): Transporter {
  const { host, port, user, pass, secure } = smtpEnv();
  // Rebuild when config changes (tests, live env edits); reuse the pooled socket otherwise.
  const key = `${host}|${port}|${user}|${secure}`;
  if (!cachedTransporter || cachedKey !== key) {
    cachedTransporter = nodemailer.createTransport({
      host, port, secure,
      ...(user || pass ? { auth: { user, pass } } : {}),
    });
    cachedKey = key;
  }
  return cachedTransporter;
}

/**
 * @description Sends one transactional email with the platform's SMTP credential. Never
 * throws: an unconfigured or failing transport resolves {ok:false, detail} so the caller
 * can surface "copy the link instead" rather than 500 the admin action.
 *
 * @param mail - Recipient, subject, and body.
 * @returns Send outcome.
 */
export async function sendTransactionalMail(mail: TransactionalMail): Promise<MailSendResult> {
  if (!smtpConfigured()) {
    return { ok: false, detail: 'SMTP is not configured (set SMTP_HOST / SMTP_FROM)' };
  }
  const { from } = smtpEnv();
  try {
    await transporter().sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    logger.info({ to: mail.to, subject: mail.subject }, 'transactional mail sent');
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error({ err, to: mail.to }, 'transactional mail send failed');
    return { ok: false, detail };
  }
}
