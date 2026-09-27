/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Test Lab registration guard for the messaging-channels card: the card is in SCENARIOS, every suite it names exists on disk, and its live step — driven over real HTTP against the REAL /api/channels router — passes with each channel's wired state in its detail, degrades (not fails) without a session, and fails when the surface omits a channel's state. A card whose suites are named but absent, or whose step passes against a payload missing the state it claims to read, is registration in name only.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The bindings step now requires all four channel states (telegram, sms, whatsapp, discord), and the round-trip card is registered with one step per provider that degrades - never passes, never writes - without a signed-in caller and the app database. Its pass path runs against real Postgres in chat-channel-inbound-postgres.spec.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createChatChannelRoutes } from '@/app/routes/chat-channel-routes';
import { CHANNEL_SCENARIOS } from '@/app/routes/test-lab-channel-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import type { AppContext } from '@/app/composition/app-context';

let server: Server;
let broken: Server;

/** No saved links for anyone; the channels surface reads nothing else from the pool here. */
const pool = { query: async () => ({ rows: [] }) } as unknown as AppContext['pool'];

const cookieAuth: RequestHandler = (req, res, next) => {
  const sub = /(?:^|;\s*)test-user=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!sub) { res.status(401).json({ error: 'unauthorized' }); return; }
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub } } });
  next();
};

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TWILIO_INBOUND_NUMBER = '+15559990000';
  const app = express();
  app.use('/api/channels', createChatChannelRoutes({ pool } as AppContext, cookieAuth));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  // A stand-in surface that reports no sms state at all — what a regressed payload looks like.
  const brokenApp = express();
  brokenApp.get('/api/channels', (_req, res) => { res.json({ telegram: { configured: false }, links: [] }); });
  broken = brokenApp.listen(0, '127.0.0.1');
  await new Promise((r) => broken.once('listening', r));

  process.env.PORT = String((server.address() as AddressInfo).port);
});

afterAll(async () => {
  delete process.env.TWILIO_INBOUND_NUMBER;
  delete process.env.PORT;
  await Promise.all([server, broken].map((s) => new Promise((r) => s.close(r))));
});

describe('messaging channels Test Lab registration', () => {
  it('is registered, and every suite it names exists', () => {
    for (const scenario of CHANNEL_SCENARIOS) {
      expect(SCENARIOS.map((s) => s.id)).toContain(scenario.id);
      expect(scenario.regressionTests?.length).toBeGreaterThan(0);
      for (const test of scenario.regressionTests ?? []) {
        expect(existsSync(resolve(process.cwd(), test.path)), `${test.path} is registered but missing`).toBe(true);
      }
    }
  });

  it('the live step passes against the real router and names each channel state', async () => {
    const step = CHANNEL_SCENARIOS[0].steps[0];
    const result = await step.run('test-user=auth0|lab-user');
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('Wired on this deployment');
    expect(result.detail).toContain('Identities linked to you: 0');
  });

  it('degrades (never fails) when the caller has no session', async () => {
    const result = await CHANNEL_SCENARIOS[0].steps[0].run('');
    expect(result).toMatchObject({ state: 'degraded', status: 401 });
  });

  it('names all four channel states when the surface reports them', async () => {
    const result = await CHANNEL_SCENARIOS[0].steps[0].run('test-user=auth0|lab-user', {});
    expect(result.detail).toMatch(/Wired on this deployment: (?:.*sms.*|none)/);
    const response = await fetch(`http://127.0.0.1:${process.env.PORT}/api/channels`, { headers: { cookie: 'test-user=auth0|lab-user' } });
    const payload = await response.json() as Record<string, { configured?: unknown }>;
    for (const channel of ['telegram', 'sms', 'whatsapp', 'discord']) expect(typeof payload[channel]?.configured, channel).toBe('boolean');
  });

  it('registers one round-trip step per provider, each degrading without a caller and database', async () => {
    const card = CHANNEL_SCENARIOS.find((s) => s.id === 'channel-inbound-round-trip');
    expect(card?.steps.map((s) => s.id)).toEqual(['round-trip-telegram', 'round-trip-discord', 'round-trip-sms', 'round-trip-whatsapp']);
    for (const step of card?.steps ?? []) {
      const result = await step.run('', {});
      expect(result.state, step.id).toBe('degraded');
    }
  });

  it('fails when the surface omits a channel wired/not-wired state', async () => {
    const realPort = process.env.PORT;
    process.env.PORT = String((broken.address() as AddressInfo).port);
    try {
      const result = await CHANNEL_SCENARIOS[0].steps[0].run('test-user=auth0|lab-user');
      expect(result.state).toBe('fail');
      expect(result.detail).toContain('sms');
    } finally {
      process.env.PORT = realPort;
    }
  });
});
