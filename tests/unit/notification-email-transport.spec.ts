/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the EmailTransport: no-op (skipped) when no rail / no recipient is injected, formats subject (first line) + body (text, media appended as a link) and hands off to the injected connector rail, skips-with-log when the rail returns no token, resolves (never throws) on a rail error, appends a media link (fellBackToLink), and never surfaces the access token in a result/error.
 */

import { describe, expect, it, vi } from 'vitest';
import { EmailTransport, resolveTransport, type EmailTransportRail } from '../../src/features/notifications';

const TOKEN = 'gmail-access-token-fake'; // obviously-fake; must never leak into a result/error

/** A rail that resolves a token + a message id, recording every send for assertions. */
function fakeRail(over: Partial<EmailTransportRail> = {}): EmailTransportRail & { sent: Array<{ to: string; subject: string; body: string }> } {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  return {
    to: 'ops@example.test',
    sent,
    getAccessToken: over.getAccessToken ?? (async () => TOKEN),
    sendEmail: over.sendEmail ?? (async (_t, m) => { sent.push(m); return { id: 'EM-42' }; }),
    ...(over.to !== undefined ? { to: over.to } : {}),
  } as EmailTransportRail & { sent: Array<{ to: string; subject: string; body: string }> };
}

describe('EmailTransport', () => {
  it('is a no-op (skipped, not error) when no rail is injected', async () => {
    const t = new EmailTransport({});
    expect(t.configured()).toBe(false);
    expect(await t.send({ text: 'hi' })).toMatchObject({ delivered: false, skipped: true, transport: 'email' });
  });

  it('is a no-op when the rail has no recipient', async () => {
    const t = new EmailTransport({ email: fakeRail({ to: '   ' }) });
    expect(t.configured()).toBe(false);
    expect(await t.send({ text: 'hi' })).toMatchObject({ delivered: false, skipped: true });
  });

  it('formats subject (first line) + body and hands off to the connector rail', async () => {
    const rail = fakeRail();
    const t = new EmailTransport({ email: rail });
    expect(t.configured()).toBe(true);
    const r = await t.send({ text: 'Deploy finished\nAll 12 services healthy.' });
    expect(r).toMatchObject({ delivered: true, transport: 'email', id: 'EM-42' });
    expect(rail.sent).toHaveLength(1);
    expect(rail.sent[0]).toMatchObject({
      to: 'ops@example.test',
      subject: 'Deploy finished',
      body: 'Deploy finished\nAll 12 services healthy.',
    });
  });

  it('appends a media URL to the body as a link (fellBackToLink)', async () => {
    const rail = fakeRail();
    const t = new EmailTransport({ email: rail });
    const r = await t.send({ text: 'episode ready', media: { url: 'https://x/v.mp4', kind: 'video', caption: 'clip' } });
    expect(r).toMatchObject({ delivered: true, fellBackToLink: true });
    expect(rail.sent[0].body).toContain('https://x/v.mp4');
    expect(rail.sent[0].body).toContain('clip');
  });

  it('skips-with-log (not an error) when the rail returns no access token', async () => {
    const t = new EmailTransport({ email: fakeRail({ getAccessToken: async () => null }) });
    const r = await t.send({ text: 'hi' });
    expect(r).toMatchObject({ delivered: false, skipped: true, transport: 'email', error: 'email_no_access_token' });
  });

  it('resolves (never throws) when the rail send fails, and never surfaces the token', async () => {
    const rail = fakeRail({ sendEmail: vi.fn(async () => { throw new Error('gmail_403_forbidden'); }) });
    const t = new EmailTransport({ email: rail });
    const r = await t.send({ text: 'hi' });
    expect(r).toMatchObject({ delivered: false, transport: 'email', error: 'gmail_403_forbidden' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('is selectable through the transport registry by kind', () => {
    expect(resolveTransport('email', { email: fakeRail() }).kind).toBe('email');
    // No rail injected → the registry still returns the email transport, but it is unconfigured.
    expect(resolveTransport('email').configured()).toBe(false);
  });
});
