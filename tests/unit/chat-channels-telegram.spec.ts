/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the Telegram channel adapter's pure logic — update parsing, deterministic webhook-secret derivation, and constant-time secret verification (the webhook's authenticity gate).
 */

import { describe, it, expect } from 'vitest';
import {
  parseTelegramUpdate,
  deriveWebhookSecret,
  verifyWebhookSecret,
} from '../../src/features/chat-channels';

describe('parseTelegramUpdate', () => {
  it('normalizes a text message with sender + chat', () => {
    const msg = parseTelegramUpdate({
      message: { text: '  hello swarm  ', chat: { id: 42, type: 'private' }, from: { id: 7, first_name: 'Ada', last_name: 'Lovelace' } },
    });
    expect(msg).toEqual({
      provider: 'telegram',
      channelUserId: '7',
      chatId: '42',
      text: 'hello swarm',
      displayName: 'Ada Lovelace',
    });
  });

  it('falls back to @username when no name is present', () => {
    const msg = parseTelegramUpdate({ message: { text: 'hi', chat: { id: 5, type: 'private' }, from: { id: 5, username: 'octocat' } } });
    expect(msg?.displayName).toBe('@octocat');
  });

  it('ignores non-text updates and empty text', () => {
    expect(parseTelegramUpdate({ message: { chat: { id: 1, type: 'private' }, from: { id: 1 } } })).toBeNull();
    expect(parseTelegramUpdate({ message: { text: '   ', chat: { id: 1, type: 'private' }, from: { id: 1 } } })).toBeNull();
    expect(parseTelegramUpdate({ edited_message: { text: 'x' } })).toBeNull();
    expect(parseTelegramUpdate(null)).toBeNull();
  });

  it('ignores group/supergroup/channel messages — the data boundary, not a feature cut', () => {
    // Double-check finding 2026-07-08: the link is keyed by SENDER (from.id) but the reply
    // goes to the CHAT (chat.id) — a linked user posting in a group would have their private
    // swarm reply delivered INTO the group. Private chats only in v1.
    for (const type of ['group', 'supergroup', 'channel', undefined]) {
      expect(parseTelegramUpdate({ message: { text: 'summarize my inbox', chat: { id: -100200, type }, from: { id: 7 } } })).toBeNull();
    }
  });
});

describe('webhook secret', () => {
  it('derives a stable 32-char hex secret from the token', () => {
    const s1 = deriveWebhookSecret('123:ABC');
    const s2 = deriveWebhookSecret('123:ABC');
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveWebhookSecret('123:XYZ')).not.toBe(s1);
  });

  it('verifies only the exact secret', () => {
    const secret = deriveWebhookSecret('123:ABC');
    expect(verifyWebhookSecret(secret, secret)).toBe(true);
    expect(verifyWebhookSecret('wrong', secret)).toBe(false);
    expect(verifyWebhookSecret(undefined, secret)).toBe(false);
    expect(verifyWebhookSecret('', secret)).toBe(false);
  });
});
