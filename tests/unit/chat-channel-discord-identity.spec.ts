/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the live bot-token validation behind the cockpit's "Save & connect": against a local HTTP server speaking Discord's two reads (a real protocol seam, not a mocked fetch), a bot token yields the bot user, the application and the Message Content intent flag; a rejected token, a user (non-bot) token, a 5xx and an unreachable API each name their code; the invite and DM URLs are built from the reported ids. The token is asserted absent from every error message.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DISCORD_FLAG_MESSAGE_CONTENT,
  DISCORD_FLAG_MESSAGE_CONTENT_LIMITED,
  DiscordTokenValidationError,
  discordDmUrl,
  discordInviteUrl,
  validateDiscordBotToken,
} from '@/features/chat-channels';

const VALID = 'fixture-bot-token.aaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbb'; // obviously fake; never a real credential
const USER_TOKEN = 'fixture-user-token.cccccc.dddddddddddddddddddddddddd';
const BOT_ID = '123456789012345678';
const APP_ID = '223456789012345678';

let server: Server;
let apiBase = '';
/** What the fake application read answers; each case sets the flags it needs. */
const fake = { flags: 0, failApplication: false };

beforeAll(async () => {
  const app = express();
  app.get('/users/@me', (req, res) => {
    const auth = req.header('authorization');
    if (auth === `Bot ${VALID}`) { res.json({ id: BOT_ID, username: 'oshal-fixture-bot', discriminator: '0', bot: true }); return; }
    if (auth === `Bot ${USER_TOKEN}`) { res.json({ id: '323456789012345678', username: 'a-person', bot: false }); return; }
    res.status(401).json({ message: '401: Unauthorized', code: 0 });
  });
  app.get('/oauth2/applications/@me', (req, res) => {
    if (fake.failApplication) { res.status(500).json({ message: 'boom' }); return; }
    if (req.header('authorization') !== `Bot ${VALID}`) { res.status(401).json({ message: '401: Unauthorized', code: 0 }); return; }
    res.json({ id: APP_ID, name: 'oshal fixture app', flags: fake.flags, bot_public: true });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

async function failure(token: string, base = apiBase): Promise<DiscordTokenValidationError> {
  try {
    await validateDiscordBotToken(token, { apiBase: base, timeoutMs: 3_000 });
  } catch (err) {
    expect(err).toBeInstanceOf(DiscordTokenValidationError);
    expect((err as Error).message).not.toContain(token);
    return err as DiscordTokenValidationError;
  }
  throw new Error('validation unexpectedly succeeded');
}

describe('validateDiscordBotToken against a local Discord API', () => {
  it('describes a bot token: bot user, application, and the Message Content intent from the flags', async () => {
    fake.flags = DISCORD_FLAG_MESSAGE_CONTENT_LIMITED;
    expect(await validateDiscordBotToken(VALID, { apiBase })).toEqual({
      botUserId: BOT_ID, botUsername: 'oshal-fixture-bot', applicationId: APP_ID, applicationName: 'oshal fixture app', messageContentIntent: true,
    });
    fake.flags = DISCORD_FLAG_MESSAGE_CONTENT;
    expect((await validateDiscordBotToken(VALID, { apiBase })).messageContentIntent).toBe(true);
    fake.flags = 0;
    expect((await validateDiscordBotToken(VALID, { apiBase })).messageContentIntent).toBe(false);
  });

  it('names token_invalid for a rejected token and for a token that is not a bot user', async () => {
    fake.flags = 0;
    expect((await failure('not-a-real-token.xxxxxx.yyyyyyyyyyyyyyyyyyyy')).code).toBe('token_invalid');
    const userFailure = await failure(USER_TOKEN);
    expect(userFailure.code).toBe('token_invalid');
    expect(userFailure.message).toMatch(/not belong to a Discord bot user/);
  });

  it('names discord_unreachable for a 5xx and for an API nobody answers on', async () => {
    fake.failApplication = true;
    try {
      expect((await failure(VALID)).code).toBe('discord_unreachable');
    } finally {
      fake.failApplication = false;
    }
    const closed = express().listen(0, '127.0.0.1');
    await new Promise((r) => closed.once('listening', r));
    const deadBase = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise((r) => closed.close(r));
    expect((await failure(VALID, deadBase)).code).toBe('discord_unreachable');
  });

  it('builds the invite (bot scope, Send Messages) and the DM link from the reported ids', () => {
    expect(discordInviteUrl(APP_ID)).toBe(`https://discord.com/oauth2/authorize?client_id=${APP_ID}&permissions=2048&scope=bot`);
    expect(discordDmUrl(BOT_ID)).toBe(`https://discord.com/users/${BOT_ID}`);
  });
});
