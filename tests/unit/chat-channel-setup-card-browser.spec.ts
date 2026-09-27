/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the cockpit "Chat channels" card (operator directive 2026-09-27: "one click to a user"). The shipped page is served by the real cockpit static registrar into headless Chromium over loopback, with the channel routes answered by a recording fixture whose payload shapes are the ones the router spec pins. Covers: the operator section appears only when the admin read answers 200; "Save & connect" posts exactly the pasted token, clears the field, and renders Connected / bot name / invite link / Disconnect; token_invalid and intent_missing are worded specifically; "Link my Discord" renders the exact LINK text, Copy puts that text on the clipboard, the DM opener carries the bot's user id, and the expiry counts down; each not-configured and issuer_required refusal is worded, never a bare error; Telegram, SMS and WhatsApp get their own openers; linked accounts list with a working Unlink.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { registerCockpitStaticRoutes } from '@/app/routes/cockpit-static-routes';

const HOOK_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 45_000;
const BOT_ID = '123456789012345678';
const APP_ID = '223456789012345678';
const TOKEN = 'fixture-bot-token.aaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // obviously fake; never a real credential

/** The Discord admin state the fixture answers, in the shape the router spec pins. */
function adminState(configured: boolean, extra: Record<string, unknown> = {}) {
  return {
    configured, source: configured ? 'database' : null,
    bot: configured ? { userId: BOT_ID, username: 'oshal-fixture-bot', applicationId: APP_ID, applicationName: 'oshal fixture app' } : null,
    messageContentIntent: configured ? true : null,
    inviteUrl: configured ? `https://discord.com/oauth2/authorize?client_id=${APP_ID}&permissions=2048&scope=bot` : null,
    dmUrl: configured ? `https://discord.com/users/${BOT_ID}` : null,
    connection: { state: configured ? 'connected' : 'stopped', lastCloseCode: null, problem: null, connectedAt: null, botUserId: null, botUsername: null, running: configured, source: configured ? 'database' : null },
    updatedAt: null, updatedBy: null, ...extra,
  };
}

/** What the fixture answers; each test shapes it, and every request is recorded. */
const world = {
  operator: true,
  admin: adminState(false) as Record<string, unknown>,
  saveAnswer: { status: 200, body: adminState(true) as Record<string, unknown> },
  channels: {} as Record<string, unknown>,
  links: {} as Record<string, { status: number; body: Record<string, unknown> }>,
  requests: [] as Array<{ method: string; path: string; body: unknown }>,
};

function defaultChannels(discordConfigured: boolean) {
  return {
    telegram: { configured: true, bot: { username: 'oshal_fixture_bot', id: 42 } },
    sms: { configured: true, number: '+15559990000' },
    whatsapp: { configured: true, number: 'whatsapp:+14155238886' },
    discord: discordConfigured
      ? { configured: true, connected: true, problem: null, bot: { userId: BOT_ID, username: 'oshal-fixture-bot' }, dmUrl: `https://discord.com/users/${BOT_ID}` }
      : { configured: false, connected: false, problem: null, bot: null, dmUrl: null },
    links: [
      { provider: 'discord', channelUserId: '987654321', chatId: '9987654321', userSub: 'me', userIssuer: 'https://identity.oshal.example.com', displayName: 'Roger', linkedAt: '2026-09-27T04:00:00.000Z' },
      { provider: 'telegram', channelUserId: '700000101', chatId: '700000101', userSub: 'me', userIssuer: 'https://identity.oshal.example.com', displayName: null, linkedAt: '2026-09-27T04:01:00.000Z' },
    ] as Array<Record<string, unknown>>,
  };
}

let server: Server;
let origin = '';
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { world.requests.push({ method: req.method, path: req.path, body: req.body }); next(); });
  app.get('/api/channels', (_req, res) => { res.json(world.channels); });
  app.get('/api/channels/admin/discord', (_req, res) => { if (!world.operator) { res.status(403).json({ error: 'Operator privilege required' }); return; } res.json(world.admin); });
  // A saved token changes what the next GET answers, exactly as the shipped router's readback does.
  app.post('/api/channels/admin/discord', (_req, res) => {
    if (world.saveAnswer.status === 200) world.admin = world.saveAnswer.body;
    res.status(world.saveAnswer.status).json(world.saveAnswer.body);
  });
  app.delete('/api/channels/admin/discord', (_req, res) => { world.admin = adminState(false); res.json(world.admin); });
  app.post('/api/channels/:provider/link', (req, res) => {
    const answer = world.links[req.params.provider] ?? { status: 503, body: { error: `${req.params.provider}_not_configured` } };
    res.status(answer.status).json(answer.body);
  });
  app.delete('/api/channels/:provider/:channelUserId', (req, res) => {
    const channels = world.channels as ReturnType<typeof defaultChannels>;
    channels.links = channels.links.filter((l) => !(l.provider === req.params.provider && l.channelUserId === req.params.channelUserId));
    res.json({ removed: true });
  });
  registerCockpitStaticRoutes({ app, requiresAuth: (_req, _res, next) => next(),
    cockpitDir: resolve('src/pages/cockpit'), uiEnhancedDir: resolve('any-bot/ui-enhanced'),
    codiconFontsDir: resolve('node_modules/@vscode/codicons/dist'), sharedUiCssDir: resolve('src/shared/ui/css'),
    sharedUiJsDir: resolve('src/shared/ui/js') });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  world.operator = true;
  world.admin = adminState(false);
  world.saveAnswer = { status: 200, body: adminState(true) };
  world.channels = defaultChannels(false);
  world.links = {};
  world.requests = [];
  context = await browser.newContext({ viewport: { width: 1200, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
});

afterEach(async () => { await context?.close(); });

async function open(): Promise<void> {
  await page.goto(`${origin}/cockpit/tools/channels.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('status')?.textContent?.startsWith('Loading'));
}
const byId = (id: string) => page.locator(`[data-testid="${id}"]`);

describe('the Chat channels cockpit card', () => {
  it('shows the operator section only for an operator, and says how to enable Discord when no bot exists', async () => {
    await open();
    await expect.poll(() => byId('operator-section').isVisible()).toBe(true);
    expect(await byId('discord-admin-pill').textContent()).toBe('not configured');
    expect(await byId('discord-admin-meta').textContent()).toContain('Paste a bot token below');
    expect(await byId('discord-user-pill').textContent()).toBe('not set up');
    expect(await byId('discord-link').isDisabled()).toBe(true);
    expect(await byId('discord-user-card').textContent()).toContain('An operator pastes the bot token');

    world.operator = false;
    await open();
    expect(await byId('operator-section').isVisible()).toBe(false);
    expect(await byId('telegram-user-pill').textContent()).toBe('available');
  }, TEST_TIMEOUT_MS);

  it('Save & connect posts the pasted token, clears the field, and renders Connected with the invite and Disconnect', async () => {
    await open();
    await byId('discord-token').fill(TOKEN);
    world.channels = defaultChannels(true);
    await byId('discord-save').click();
    await expect.poll(() => byId('discord-admin-pill').textContent()).toBe('Connected');
    const post = world.requests.find((r) => r.method === 'POST' && r.path === '/api/channels/admin/discord');
    expect(post?.body).toEqual({ token: TOKEN });
    expect(await byId('discord-token').inputValue()).toBe('');
    expect(await byId('discord-admin-meta').textContent()).toContain('@oshal-fixture-bot');
    expect(await byId('discord-admin-meta').textContent()).toContain('Message Content intent: ON');
    expect(await byId('discord-invite').getAttribute('href')).toBe(`https://discord.com/oauth2/authorize?client_id=${APP_ID}&permissions=2048&scope=bot`);
    expect(await byId('discord-disconnect').isVisible()).toBe(true);
    expect(await byId('discord-admin-result').textContent()).toBe('Connected as @oshal-fixture-bot.');
    await expect.poll(() => byId('discord-user-pill').textContent()).toBe('available');
    expect(await byId('discord-link').isDisabled()).toBe(false);
    expect(await page.content()).not.toContain(TOKEN);
  }, TEST_TIMEOUT_MS);

  it('names a rejected token and an intent that is off, with the portal path', async () => {
    await open();
    world.saveAnswer = { status: 422, body: { error: 'token_invalid', message: 'Discord rejected this token. Reset the token under Bot in the Developer Portal and paste the new one.' } };
    await byId('discord-token').fill(TOKEN);
    await byId('discord-save').click();
    await expect.poll(() => byId('discord-admin-result').textContent()).toContain('Token invalid: Discord rejected this token');

    world.saveAnswer = { status: 200, body: adminState(true, { connection: { ...adminState(true).connection, state: 'offline', problem: 'intent_missing', lastCloseCode: 4014 } }) };
    await byId('discord-token').fill(TOKEN);
    await byId('discord-save').click();
    await expect.poll(() => byId('discord-admin-pill').textContent()).toBe('intent off');
    expect(await byId('discord-admin-problem').isVisible()).toBe(true);
    expect(await byId('discord-admin-problem').textContent()).toContain('Message Content intent is off');
    expect(await byId('discord-admin-problem').textContent()).toContain('Bot → Privileged Gateway Intents');
    expect(await byId('discord-admin-result').textContent()).toContain('Message Content intent is off');
  }, TEST_TIMEOUT_MS);

  it('Link my Discord shows the exact LINK text, copies it, opens the DM by bot id, and counts the code down', async () => {
    world.channels = defaultChannels(true);
    world.links.discord = { status: 200, body: { code: 'abcd1234', send: 'LINK abcd1234', message: 'DM the Discord bot: LINK abcd1234', expiresInMinutes: 15, botUsername: 'oshal-fixture-bot', botUserId: BOT_ID, dmUrl: `https://discord.com/users/${BOT_ID}` } };
    await open();
    await byId('discord-link').click();
    await expect.poll(() => byId('discord-code-panel').isVisible()).toBe(true);
    expect(await byId('discord-send-text').textContent()).toBe('LINK abcd1234');
    expect(await byId('discord-open-dm').getAttribute('href')).toBe(`https://discord.com/users/${BOT_ID}`);
    expect(await byId('discord-code-panel').textContent()).toContain("click the bot's name → Message");
    expect(await byId('discord-expiry').textContent()).toMatch(/^Code expires in 1[45]:\d\d$/);
    await byId('discord-copy').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('LINK abcd1234');
  }, TEST_TIMEOUT_MS);

  it('words each refusal specifically: not configured, issuer required', async () => {
    world.channels = defaultChannels(true);
    world.links.discord = { status: 503, body: { error: 'discord_not_configured' } };
    world.links.telegram = { status: 403, body: { error: 'issuer_required', message: 'Your sign-in did not carry a verified issuer. Sign out, sign back in, and generate a fresh link code.' } };
    await open();
    await byId('discord-link').click();
    await expect.poll(() => byId('discord-link-result').textContent()).toContain('Discord is not set up on this deployment yet');
    await byId('telegram-link').click();
    await expect.poll(() => byId('telegram-link-result').textContent()).toContain('Sign out, sign back in');
  }, TEST_TIMEOUT_MS);

  it('Telegram, SMS and WhatsApp each get a one-click opener with the code inside', async () => {
    world.links.telegram = { status: 200, body: { code: 'beef0001', botUsername: 'oshal_fixture_bot', deepLink: 'https://t.me/oshal_fixture_bot?start=beef0001', expiresInMinutes: 15 } };
    world.links.sms = { status: 200, body: { code: 'beef0002', textTo: '+15559990000', message: 'LINK beef0002', expiresInMinutes: 15 } };
    world.links.whatsapp = { status: 200, body: { code: 'beef0003', textTo: 'whatsapp:+14155238886', message: 'LINK beef0003', expiresInMinutes: 15 } };
    await open();
    await byId('telegram-link').click();
    await expect.poll(() => byId('telegram-open').getAttribute('href')).toBe('https://t.me/oshal_fixture_bot?start=beef0001');
    await byId('sms-link').click();
    await expect.poll(() => byId('sms-number').textContent()).toBe('Number: +15559990000');
    expect(await byId('sms-send-text').textContent()).toBe('LINK beef0002');
    expect(await byId('sms-open').getAttribute('href')).toBe('sms:+15559990000?body=LINK%20beef0002');
    await byId('whatsapp-link').click();
    await expect.poll(() => byId('whatsapp-number').textContent()).toBe('Number: +14155238886');
    expect(await byId('whatsapp-open').getAttribute('href')).toBe('https://wa.me/14155238886?text=LINK%20beef0003');
  }, TEST_TIMEOUT_MS);

  it('lists linked accounts and Unlink removes exactly that identity', async () => {
    await open();
    expect(await byId('links').locator('.link-row').count()).toBe(2);
    expect(await byId('link-discord').textContent()).toContain('Discord: Roger · 987654321');
    await byId('unlink-discord-987654321').click();
    await expect.poll(() => byId('links').locator('.link-row').count()).toBe(1);
    expect(world.requests.some((r) => r.method === 'DELETE' && r.path === '/api/channels/discord/987654321')).toBe(true);
    expect(await byId('link-telegram').textContent()).toContain('Telegram: 700000101');
  }, TEST_TIMEOUT_MS);
});
