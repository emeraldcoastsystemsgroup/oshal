/**
 * Email send + metadata machinery — the kernel-resident half of the comms swarm (ADR-037).
 *
 * As of the 2026-07-19 ADR-085 Wave 3 carve, the Email Summarizer APP SURFACE
 * (createEmailRoutes: inbox/my-day pages, per-user digest store, bot-run
 * summary/draft, the 428-gated /send route) ships as the `email-summarizer`
 * store package. This module is what STAYS core — the shared, vendor-concrete
 * senders and the one Gmail metadata summarizer that multiple owners depend on:
 *
 *   - `sendGmail`      — the ONE RFC-2822 MIME builder + users.messages.send POST,
 *                        carrying the header-injection fence (all header-bound
 *                        values CRLF-flattened at the builder — commit 158fa008).
 *   - `sendOutlookMail`— the Microsoft Graph sibling with the same call shape.
 *   - `summarizeGmailMetadata` — the privacy-bounded message-metadata summary,
 *                        kept in lockstep with scripts/oshal-gmail.js (guarded by
 *                        tests/unit/live-weather-email-wiring.spec.ts).
 *
 * Kernel senders that import this module: notify-routes (notification email
 * channel), jarvis-brief-cron (daily brief). Store packages that import it via
 * @/app/routes/email-routes: email-summarizer (the carved surface), career-hunter
 * (career-digest notifier), presentations (AI Office "email it"). Do NOT fork the
 * MIME builder into a caller — every outbound send must pass the one fence here.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial email app surface: GET /inbox + /my-day pages, GET /messages + /message/:id + /digest (live Gmail/Calendar per connected user), POST /summary + /draft (api-side LLM). Read-only; no send.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added POST /send (Gmail users.messages.send): RFC-2822 MIME builder + optional single attachment, `to` defaults to the caller's own address ("email me a copy"). Needs the gmail.send scope on the Google connection (now in the connector default scopes); a token without it 403s with an actionable "reconnect Google" message. Closes the Test Lab's email-send gap (ADR-063).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added provider message IDs/timestamps and deterministic UNREAD/IMPORTANT/STARRED metadata to list, detail, digest, and bot-summary inputs.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export sendGmail so batch senders (career-digest daily notifier) reuse the one MIME builder + users.messages.send POST instead of replicating it. No behavior change to the route.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Header-injection fence in sendGmail (security review): subject/to/filename/mimeType are concatenated into raw RFC-2822 header lines, so embedded CRLF injected arbitrary headers (and filename could break its quoted-string with a double quote). All header-bound values now flattened at the builder. The Graph sibling (sendOutlookMail) takes JSON — not affected.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Export sendOutlookMail — the Microsoft Graph (users/me/sendMail) sibling of sendGmail with the same call shape, so vendor-generic senders (AI Office "email it", ADR-108) reach whichever mailbox the user actually connected. Dormant like the onedrive adapter until a microsoft/outlook connection exists; no route change here.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 Wave 3 carve: the Email Summarizer app surface (createEmailRoutes + inbox/my-day/social pages + ensureEmailSchema/oshal_email_digests + the bot-run summary/draft + the 428-gated /send route) moved to the email-summarizer store package. This module is trimmed to the SHARED kernel machinery: sendGmail (fence intact), sendOutlookMail, summarizeGmailMetadata + helpers. The path stays @/app/routes/email-routes because notify-routes, jarvis-brief-cron, and the career-hunter/presentations/email-summarizer store packages all import it here. Fence guard now lives in tests/unit/risky-write-guards.spec.ts (source arm) — the no-send ROUTE gate carved with the package; the kernel's surviving no-send owner is the scripts/oshal-twilio.js CLI confirm gate.
 *
 * @module email-routes
 */

import * as crypto from 'crypto';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface MailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  internalDate: string;
  receivedAt: string;
  snippet: string;
  unread: boolean;
  important: boolean;
  starred: boolean;
  providerFlags: {
    unread: boolean;
    important: boolean;
    starred: boolean;
  };
}

/** POST JSON to a Google API URL with the bearer token; throws on non-2xx (preserving the status). */
async function gpost(token: string, url: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`google ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<Record<string, unknown>>;
}

/**
 * @description Build a base64url RFC-2822 message (optionally with a single attachment) and send it
 * via the Gmail API (users.messages.send). Requires the connected Google account to hold the
 * `gmail.send` scope — a token without it returns 403 (surfaced by the caller as actionable).
 * @param token - The caller's Google access token.
 * @param m - to/subject/body (+ optional single attachment).
 * @returns The provider message id.
 */
export async function sendGmail(
  token: string,
  m: { to: string; subject: string; body: string; attachment?: { filename: string; contentBase64: string; mimeType?: string } },
): Promise<{ id: string }> {
  const join = (lines: string[]) => lines.join('\r\n');
  // Header-injection fence: this builder concatenates caller values into raw RFC-2822
  // header LINES, so a CR/LF inside any of them would inject arbitrary headers into the
  // outbound message. Every header-bound value is flattened here, at the one builder,
  // rather than trusting each caller's validation. Filenames additionally lose double
  // quotes (they sit inside a quoted-string) and mime types anything non-token.
  const headerSafe = (s: string) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
  const to = headerSafe(m.to);
  const subject = headerSafe(m.subject);
  let raw: string;
  if (m.attachment && m.attachment.contentBase64) {
    const boundary = `oshal_${crypto.randomBytes(8).toString('hex')}`;
    const att = m.attachment;
    const filename = headerSafe(att.filename).replace(/"/g, '');
    const mimeType = (att.mimeType || 'application/octet-stream').replace(/[^\w./+-]/g, '');
    raw = join([
      `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', '', m.body, '',
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64', '',
      att.contentBase64.replace(/\s+/g, ''), '',
      `--${boundary}--`,
    ]);
  } else {
    raw = join([`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset="UTF-8"', '', m.body]);
  }
  const resp = await gpost(token, `${GMAIL}/messages/send`, { raw: Buffer.from(raw, 'utf8').toString('base64url') });
  return { id: String(resp.id || '') };
}

/**
 * @description Send via Microsoft Graph (users/me/sendMail) — the Outlook sibling of sendGmail
 * with the same call shape, so vendor-generic senders (AI Office "email it") reach whichever
 * mailbox the user actually connected. Requires a `microsoft`/`outlook` connection whose grant
 * carries Mail.Send; Graph answers 202 with an empty body, so there is no provider message id.
 * @param token - The caller's Microsoft Graph access token.
 * @param m - to/subject/body (+ optional single attachment).
 * @returns An empty provider id (Graph returns no message id).
 */
export async function sendOutlookMail(
  token: string,
  m: { to: string; subject: string; body: string; attachment?: { filename: string; contentBase64: string; mimeType?: string } },
): Promise<{ id: string }> {
  const message: Record<string, unknown> = {
    subject: m.subject,
    body: { contentType: 'Text', content: m.body },
    toRecipients: [{ emailAddress: { address: m.to } }],
  };
  if (m.attachment?.contentBase64) {
    message.attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: m.attachment.filename,
      contentType: m.attachment.mimeType || 'application/octet-stream',
      contentBytes: m.attachment.contentBase64.replace(/\s+/g, ''),
    }];
  }
  const r = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (!r.ok) throw new Error(`graph sendMail ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { id: '' };
}

/** Read a header value (case-insensitive) from a Gmail message payload. */
function header(msg: Record<string, unknown>, name: string): string {
  const payload = msg.payload as { headers?: Array<{ name: string; value: string }> } | undefined;
  const h = (payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

/** Convert Gmail's provider-owned millisecond timestamp to a stable ISO time. */
function gmailReceivedAt(internalDate: string): string {
  const millis = Number(internalDate);
  if (!Number.isFinite(millis) || millis <= 0) return '';
  const received = new Date(millis);
  return Number.isNaN(received.getTime()) ? '' : received.toISOString();
}

/**
 * @description Build the privacy-bounded metadata returned by message list/digest surfaces.
 * Provider labels are reduced to the three deterministic prioritization flags; message bodies
 * and the rest of the mailbox label set stay out of summaries. Kept in lockstep with
 * scripts/oshal-gmail.js `summarizeGmailMessage` (the bot's CLI leg) — see
 * tests/unit/live-weather-email-wiring.spec.ts.
 * @param id - Fallback message id when the payload lacks one.
 * @param msg - The Gmail message payload.
 * @returns The bounded metadata summary.
 */
export function summarizeGmailMetadata(id: string, msg: Record<string, unknown>): MailSummary {
  const labelIds = (msg.labelIds as string[]) || [];
  const unread = labelIds.includes('UNREAD');
  const important = labelIds.includes('IMPORTANT');
  const starred = labelIds.includes('STARRED');
  const internalDate = msg.internalDate == null ? '' : String(msg.internalDate);
  return {
    id: String(msg.id || id),
    from: header(msg, 'From'),
    subject: header(msg, 'Subject') || '(no subject)',
    date: header(msg, 'Date'),
    internalDate,
    receivedAt: gmailReceivedAt(internalDate),
    snippet: (msg.snippet as string) || '',
    unread,
    important,
    starred,
    providerFlags: { unread, important, starred },
  };
}
