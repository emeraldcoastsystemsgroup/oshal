/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Test Lab registration guard for the social-signals card: it is in SCENARIOS, every suite it names exists on disk, and its four steps, driven over real HTTP against the REAL subscription router (with the real bot registry), pass for a signed-in owner, degrade without a session, and fail when the bot refusal regresses (disabling the watch the regression created). The pool is a scripted double; the database boundary is proven by tests/unit/social-signal-subscriptions-postgres.spec.ts, which the card lists.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { Router, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { mountSocialSignalSubscriptionRoutes } from '@/app/routes/social-signal-routes';
import { SOCIAL_SIGNAL_SCENARIOS } from '@/app/routes/test-lab-social-signal-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';

const OWNED = '33333333-3333-3333-3333-333333333333';
const OWNER = 'auth0|lab-owner';

let server: Server;
let broken: Server;
const deleted: string[] = [];

/** Subscriptions and deliveries as the routes read them; only OWNER has a watch. */
const pool = {
  query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM oshal_social_signal_subscriptions') && sql.includes('ORDER BY created_at')) {
      return { rows: params[0] === OWNER ? [{ subscription_id: OWNED, user_sub: OWNER, bot_agent_id: 'bot', selector: { kind: 'keyword', value: 'x' }, active: true, created_at: '2026-09-25T10:00:00.000Z' }] : [] };
    }
    if (sql.includes('SELECT 1 FROM oshal_social_signal_subscriptions')) return { rows: params[0] === OWNED && params[1] === OWNER ? [{}] : [] };
    if (sql.includes('FROM oshal_social_signal_deliveries')) {
      return { rows: [{ msg_id: 'm-1', bot_agent_id: 'bot', channel: 'social.signal.x.bot', correlation_id: 'c-1', claimed_at: '2026-09-25T10:00:00.000Z', published_at: '2026-09-25T10:00:01.000Z' }] };
    }
    return { rows: [], rowCount: 0 };
  },
} as unknown as Pool;

const cookieAuth: RequestHandler = (req, _res, next) => {
  const sub = /(?:^|;\s*)test-user=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (sub) Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: decodeURIComponent(sub) } } });
  next();
};

async function listen(app: express.Express): Promise<Server> {
  const s = app.listen(0, '127.0.0.1');
  await new Promise((ready) => s.once('listening', ready));
  return s;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieAuth);
  const router = Router();
  mountSocialSignalSubscriptionRoutes(router, { pool });
  app.use('/api/content', router);
  server = await listen(app);

  // A surface whose bot binding regressed: it accepts any bot.
  const brokenApp = express();
  brokenApp.post('/api/content/subscriptions', (_req, res) => { res.status(201).json({ subscriptionId: OWNED }); });
  brokenApp.delete('/api/content/subscriptions/:id', (req, res) => { deleted.push(req.params.id); res.json({ ok: true }); });
  broken = await listen(brokenApp);
  process.env.PORT = String((server.address() as AddressInfo).port);
});

afterAll(async () => {
  delete process.env.PORT;
  await Promise.all([server, broken].map((s) => new Promise((closed) => s.close(closed))));
});

/** Run the card's steps in order with the Lab runner's prior-output threading. */
async function runCard(cookie: string) {
  const prior: Record<string, unknown> = {};
  const results = [];
  for (const step of SOCIAL_SIGNAL_SCENARIOS[0].steps) {
    const r = await step.run(cookie, prior);
    if (r.output !== undefined) prior[step.id] = r.output;
    results.push(r);
  }
  return results;
}

describe('social signals Test Lab registration', () => {
  it('is registered, and every suite it names exists', () => {
    for (const scenario of SOCIAL_SIGNAL_SCENARIOS) {
      expect(SCENARIOS.map((s) => s.id)).toContain(scenario.id);
      expect(scenario.regressionTests?.map((t) => t.path)).toContain('tests/unit/social-signal-subscriptions-postgres.spec.ts');
      for (const test of scenario.regressionTests ?? []) {
        expect(existsSync(resolve(process.cwd(), test.path)), `${test.path} is registered but missing`).toBe(true);
      }
    }
  });

  it('passes every step for a signed-in owner against the real router', async () => {
    const results = await runCard(`test-user=${encodeURIComponent(OWNER)}`);
    expect(results.map((r) => r.state)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(results[1].detail).toContain('1 watch(es)');
    expect(results[3].detail).toContain('1 delivery record(s)');
  });

  it('degrades the own-audit step when the caller has no watch yet', async () => {
    const results = await runCard('test-user=auth0%7Clab-newcomer');
    expect(results.map((r) => r.state)).toEqual(['pass', 'pass', 'pass', 'degraded']);
  });

  it('degrades (never fails) without a session', async () => {
    const results = await runCard('');
    expect(results.slice(0, 3).map((r) => [r.state, r.status])).toEqual([['degraded', 401], ['degraded', 401], ['degraded', 401]]);
  });

  it('fails, and disables the accidental watch, when the bot refusal regresses', async () => {
    const realPort = process.env.PORT;
    process.env.PORT = String((broken.address() as AddressInfo).port);
    try {
      const refused = await SOCIAL_SIGNAL_SCENARIOS[0].steps[0].run(`test-user=${encodeURIComponent(OWNER)}`, {});
      expect(refused.state).toBe('fail');
      expect(refused.detail).toContain('ACCEPTED');
      expect(deleted).toEqual([OWNED]);
    } finally {
      process.env.PORT = realPort;
    }
  });
});
