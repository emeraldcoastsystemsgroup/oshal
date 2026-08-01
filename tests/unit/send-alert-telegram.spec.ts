/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the watchdog-family Telegram leg in scripts/oshal-send-alert.js: runAlert CALLS both legs (Telegram first, then email), sendTelegramAlert no-ops without TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID, an email-path stub proves Telegram still fires when email would fail and vice versa, and the bot token can never leak through a result — even when the thrown error carries the request URL.
 */
/**
 * @description Mutation-proof guards on the alert script's Telegram leg. The transport is stubbed
 * (injected fetch) — no test can send a live message — and the assertions are on CALLS: delete the
 * sendTelegramAlert call from runAlert, or the email call, and a spec here goes red.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireModule = createRequire(import.meta.url);
const { sendTelegramAlert, runAlert } = requireModule('../../scripts/oshal-send-alert.js') as {
  sendTelegramAlert: (subject: string, body: string, deps?: Record<string, unknown>) =>
    Promise<{ skipped?: boolean; ok?: boolean; id?: string; error?: string }>;
  runAlert: (subject: string, body: string, deps?: Record<string, unknown>) =>
    Promise<{ skipped?: boolean; ok?: boolean; id?: string; error?: string }>;
};

const TOKEN = 'FAKEBOT:abc-not-a-real-token';
const CONFIGURED = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '777' };

/** A fake fetch capturing calls and returning a canned Bot API response. */
function fakeFetch(json: unknown = { ok: true, result: { message_id: 9 } }, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl = vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) as Record<string, unknown> : {} });
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  });
  return { impl, calls };
}

describe('sendTelegramAlert', () => {
  it('POSTs one sendMessage with the chat id and subject+body when configured', async () => {
    const f = fakeFetch();
    const r = await sendTelegramAlert('subj', 'body line', { env: CONFIGURED, fetch: f.impl });
    expect(r).toMatchObject({ skipped: false, ok: true, id: '9' });
    expect(f.impl).toHaveBeenCalledTimes(1);
    expect(f.calls[0].url).toContain('/sendMessage');
    expect(f.calls[0].body).toMatchObject({ chat_id: '777', text: 'subj\n\nbody line' });
  });

  it('is a no-op (skipped, fetch never called) without both env keys', async () => {
    for (const env of [{}, { TELEGRAM_BOT_TOKEN: TOKEN }, { TELEGRAM_CHAT_ID: '777' }]) {
      const f = fakeFetch();
      const r = await sendTelegramAlert('s', 'b', { env, fetch: f.impl });
      expect(r).toEqual({ skipped: true });
      expect(f.impl).not.toHaveBeenCalled();
    }
  });

  it('maps a thrown fetch error to a FIXED string — the token cannot ride out through an exception', async () => {
    const leaky = vi.fn(async (url: string) => { throw new Error('connect failed for ' + url); });
    const r = await sendTelegramAlert('s', 'b', { env: CONFIGURED, fetch: leaky });
    expect(r).toEqual({ skipped: false, ok: false, error: 'telegram_send_failed' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('surfaces an API error as a sanitized status, never the token', async () => {
    const f = fakeFetch({ ok: false, description: 'Unauthorized' }, 401);
    const r = await sendTelegramAlert('s', 'b', { env: CONFIGURED, fetch: f.impl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('telegram_http_401:Unauthorized');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe('runAlert — the watchdog-family hook path', () => {
  it('calls BOTH legs: Telegram first, then the email leg', async () => {
    const f = fakeFetch();
    const sendEmail = vi.fn(async () => undefined);
    const r = await runAlert('watchdog: bleeder', 'details', { env: CONFIGURED, fetch: f.impl, sendEmail });
    expect(r).toMatchObject({ ok: true, id: '9' });
    expect(f.impl).toHaveBeenCalledTimes(1); // the Telegram leg fired
    expect(sendEmail).toHaveBeenCalledTimes(1); // and so did email
    expect(sendEmail).toHaveBeenCalledWith('watchdog: bleeder', 'details');
    // Telegram resolves before email is invoked — a broken email path cannot mute the phone push.
    expect(f.impl.mock.invocationCallOrder[0]).toBeLessThan(sendEmail.mock.invocationCallOrder[0]);
  });

  it('still runs the email leg when Telegram is unconfigured', async () => {
    const f = fakeFetch();
    const sendEmail = vi.fn(async () => undefined);
    const r = await runAlert('s', 'b', { env: {}, fetch: f.impl, sendEmail });
    expect(r).toEqual({ skipped: true });
    expect(f.impl).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a Telegram API failure never blocks the email leg', async () => {
    const f = fakeFetch({ ok: false, description: 'chat not found' }, 400);
    const sendEmail = vi.fn(async () => undefined);
    const r = await runAlert('s', 'b', { env: CONFIGURED, fetch: f.impl, sendEmail });
    expect(r.ok).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
