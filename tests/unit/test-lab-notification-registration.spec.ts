/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Test Lab registration guard for the Notifications per-channel account tier card: the card is in SCENARIOS, every suite it names exists, and its live step - driven over real HTTP against the real /api/notify router - passes with each channel's tier in its detail, degrades (not fails) without a session, and fails when a channel has no known tier.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('@/app/routes/twilio-sms-operation', () => ({ sendUserTwilioSms: vi.fn() }));

import { createNotifyRoutes } from '@/app/routes/notify-routes';
import { NOTIFICATION_SCENARIOS } from '@/app/routes/test-lab-notification-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import type { AppContext } from '@/app/composition/app-context';

let server: Server;
let broken: Server;
/** Connection probes answer "own Twilio connected, no Gmail"; prefs reads answer none saved. */
const pool = {
  query: vi.fn(async (sql: string) => ({ rows: /provider='twilio'/.test(sql) ? [{ connected: 1 }] : [] })),
} as unknown as AppContext['pool'];

const cookieAuth: RequestHandler = (req, res, next) => {
  const sub = /(?:^|;\s*)test-user=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!sub) { res.status(401).json({ error: 'unauthorized' }); return; }
  Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub } } });
  next();
};

beforeAll(async () => {
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACtest');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok');
  vi.stubEnv('TWILIO_FROM_NUMBER', '+15550001111');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  const app = express();
  app.use('/api/notify', createNotifyRoutes({ pool } as AppContext, cookieAuth));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  // A stand-in prefs route whose sms tier is not a known kind and whose telegram tier is missing.
  const brokenApp = express();
  brokenApp.get('/api/notify/prefs', (_req, res) => { res.json({ prefs: [], channels: [], tiers: { email: 'own', sms: 'shared', voice: 'deployment' } }); });
  broken = brokenApp.listen(0, '127.0.0.1');
  await new Promise((r) => broken.once('listening', r));
  vi.stubEnv('PORT', String((server.address() as AddressInfo).port));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all([server, broken].map((s) => new Promise((r) => s.close(r))));
});

describe('notifications Test Lab registration', () => {
  it('is registered, and every suite it names exists', () => {
    for (const scenario of NOTIFICATION_SCENARIOS) {
      expect(SCENARIOS.find((item) => item.id === scenario.id)).toBe(scenario);
      const paths = scenario.regressionTests!.map((t) => t.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) expect(existsSync(resolve(path)), path).toBe(true);
    }
  });

  it("passes against the real route and names each channel's tier", async () => {
    const result = await NOTIFICATION_SCENARIOS[0].steps[0].run('test-user=lab-user', {});
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('email: unavailable · sms: own · voice: deployment · telegram: unavailable');
  });

  it('degrades, rather than fails, for a caller with no session', async () => {
    const result = await NOTIFICATION_SCENARIOS[0].steps[0].run('', {});
    expect(result.state).toBe('degraded');
    expect(result.status).toBe(401);
  });

  it('fails a response whose channel carries no known tier', async () => {
    vi.stubEnv('PORT', String((broken.address() as AddressInfo).port));
    try {
      const result = await NOTIFICATION_SCENARIOS[0].steps[0].run('test-user=lab-user', {});
      expect(result.state).toBe('fail');
      expect(result.detail).toContain('sms, telegram');
    } finally {
      vi.stubEnv('PORT', String((server.address() as AddressInfo).port));
    }
  });
});
