/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-transport guard for the platform SMTP mailer (smtp-mailer.ts), added with the nodemailer 9 -> 10 major bump that the 2026-10-02 nightly trivy scan required. Every other spec that reaches this rail mocks @/features/notifications, so nothing proved the real nodemailer still delivers through sendTransactionalMail. These cases drive the real module and the real nodemailer over a real loopback SMTP conversation: a delivery carries the envelope, headers and both bodies; a refused recipient resolves {ok:false} with the server's reply instead of throwing; and an unconfigured box never dials.
 */

import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendTransactionalMail, smtpConfigured } from '@/features/notifications';

/** One SMTP conversation as the loopback server saw it. */
interface SmtpSession {
  commands: string[];
  data: string;
}

/** A running loopback SMTP server and every conversation it has had. */
interface SmtpFixture {
  server: Server;
  port: number;
  sessions: SmtpSession[];
}

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_FROM'] as const;
const FROM = 'noreply@oshal.example.com';
const TO = 'user@oshal.example.com';

/**
 * @description Answers one SMTP command line. Plain SMTP only: no STARTTLS and no AUTH are
 * advertised, so nodemailer has nothing to negotiate and the conversation is fully deterministic.
 * @param socket - The client connection.
 * @param line - The command line without its CRLF.
 * @param rejectRecipient - Whether RCPT TO is refused with a permanent 550.
 * @returns 'data' when the client may now send the message body, otherwise 'command'.
 */
function answer(socket: Socket, line: string, rejectRecipient: boolean): 'data' | 'command' {
  const verb = line.slice(0, 4).toUpperCase();
  if (verb === 'EHLO') socket.write('250-smtp.oshal.example.com\r\n250 8BITMIME\r\n');
  else if (verb === 'RCPT') socket.write(rejectRecipient ? '550 5.1.1 mailbox unavailable\r\n' : '250 2.1.5 ok\r\n');
  else if (verb === 'DATA') { socket.write('354 end with <CRLF>.<CRLF>\r\n'); return 'data'; }
  else if (verb === 'QUIT') socket.end('221 2.0.0 bye\r\n');
  else if (['HELO', 'MAIL', 'RSET', 'NOOP'].includes(verb)) socket.write('250 2.0.0 ok\r\n');
  else socket.write('502 5.5.2 not implemented\r\n');
  return 'command';
}

/**
 * @description Serves one client connection: line-at-a-time commands, then a dot-terminated body.
 * @param socket - The client connection.
 * @param sessions - Where this conversation is recorded.
 * @param rejectRecipient - Whether RCPT TO is refused.
 * @returns Nothing; the conversation is recorded into `sessions`.
 */
function serve(socket: Socket, sessions: SmtpSession[], rejectRecipient: boolean): void {
  const session: SmtpSession = { commands: [], data: '' };
  sessions.push(session);
  let buffer = '';
  let mode: 'data' | 'command' = 'command';
  socket.setEncoding('utf8');
  socket.on('error', (err) => { session.commands.push(`socket error: ${err.message}`); });
  socket.write('220 smtp.oshal.example.com ESMTP\r\n');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const terminator = mode === 'data' ? '\r\n.\r\n' : '\r\n';
      const end = buffer.indexOf(terminator);
      if (end < 0) return;
      const piece = buffer.slice(0, end);
      buffer = buffer.slice(end + terminator.length);
      if (mode === 'data') {
        session.data = piece;
        mode = 'command';
        socket.write('250 2.0.0 queued\r\n');
      } else {
        session.commands.push(piece);
        mode = answer(socket, piece, rejectRecipient);
      }
    }
  });
}

/**
 * @description Starts a loopback SMTP server on an ephemeral port.
 * @param rejectRecipient - Whether every RCPT TO is refused.
 * @returns The server, its port and its recorded conversations.
 */
function startSmtpServer(rejectRecipient = false): Promise<SmtpFixture> {
  const sessions: SmtpSession[] = [];
  const server = createServer((socket) => serve(socket, sessions, rejectRecipient));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, sessions }));
  });
}

describe('smtp-mailer over the real nodemailer transport', () => {
  const saved: Partial<Record<(typeof SMTP_KEYS)[number], string>> = {};
  let fixture: SmtpFixture | null = null;

  beforeEach(() => {
    for (const key of SMTP_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  });

  afterEach(async () => {
    for (const key of SMTP_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    if (fixture) await new Promise<void>((resolve) => fixture!.server.close(() => resolve()));
    fixture = null;
  });

  /** Points the mailer at the loopback server: plain SMTP, no credentials. */
  function pointAt(port: number): void {
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(port);
    process.env.SMTP_FROM = FROM;
  }

  it('delivers the envelope, headers and both bodies through a real SMTP conversation', async () => {
    fixture = await startSmtpServer();
    pointAt(fixture.port);
    const result = await sendTransactionalMail({
      to: TO, subject: 'Reset your oshal password', text: 'Open the one-time link to continue.',
      html: '<p>Open the one-time link to continue.</p>',
    });
    expect(result).toEqual({ ok: true });
    expect(fixture.sessions).toHaveLength(1);
    const [session] = fixture.sessions;
    expect(session.commands.some((c) => c.startsWith(`MAIL FROM:<${FROM}>`))).toBe(true);
    expect(session.commands).toContain(`RCPT TO:<${TO}>`);
    expect(session.data).toContain('Subject: Reset your oshal password');
    expect(session.data).toMatch(new RegExp(`^To: ${TO}$`, 'm'));
    expect(session.data).toMatch(/multipart\/alternative/);
    expect(session.data).toContain('Open the one-time link to continue.');
    expect(session.data).toContain('<p>Open the one-time link to continue.</p>');
  });

  it('resolves a refused recipient as ok:false with the server reply instead of throwing', async () => {
    fixture = await startSmtpServer(true);
    pointAt(fixture.port);
    const result = await sendTransactionalMail({ to: TO, subject: 'Invitation', text: 'Join.' });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/550/);
    expect(fixture.sessions[0].data).toBe('');
  });

  it('never dials when SMTP is not configured', async () => {
    fixture = await startSmtpServer();
    process.env.SMTP_PORT = String(fixture.port);
    expect(smtpConfigured()).toBe(false);
    const result = await sendTransactionalMail({ to: TO, subject: 'Invitation', text: 'Join.' });
    expect(result).toEqual({ ok: false, detail: 'SMTP is not configured (set SMTP_HOST / SMTP_FROM)' });
    expect(fixture.sessions).toHaveLength(0);
  });
});
