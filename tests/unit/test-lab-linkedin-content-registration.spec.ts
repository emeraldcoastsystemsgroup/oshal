/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Test Lab registration guard for the LinkedIn content queue card: it is in SCENARIOS, every suite it names exists on disk, and its three steps, driven over real HTTP against the REAL assistant router, pass for a signed-in owner, degrade without a session, and fail when the confirm gate or the ownership answer regresses. The pool is a scripted double; the database, dispatcher, broker and executor boundary is proven by tests/unit/linkedin-content-queue-postgres.spec.ts, which the card lists.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppContext } from '@/app/composition/app-context';
import { createLinkedInAssistantRoutes } from '@/app/routes/linkedin-assistant-routes';
import { LINKEDIN_CONTENT_SCENARIOS } from '@/app/routes/test-lab-linkedin-content-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';

const OWNER = 'auth0|lab-linkedin-owner';
const TICKET = '44444444-4444-4444-8444-444444444444';

/** The owner's drafts as the list route reads them: one published queue draft with its audit hash. */
const pool = {
  query: async (sql: string, params: unknown[] = []) => {
    if (/SELECT .* FROM social_content_drafts WHERE user_sub=\$1 ORDER BY/.test(sql)) {
      return { rows: params[0] === OWNER ? [{
        id: 3, user_sub: OWNER, topic: 't', goal: null, tone: null, source_url: null, source_citations: ['https://example.test/a'],
        source_ticket_id: TICKET, body: 'b', score: 80, dimensions: {}, judge_mode: 'llm', rationale: 'r', refined: false,
        state: 'published', scheduled_for: null, publish_error: null, published_post_id: 'urn:li:share:3',
        publish_params_hash: 'c'.repeat(64), created_at: 'now', updated_at: 'now',
      }] : [] };
    }
    return { rows: [], rowCount: 0 };
  },
};

const cookieAuth: RequestHandler = (req, _res, next) => {
  const sub = /(?:^|;\s*)test-user=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (sub) Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: decodeURIComponent(sub) } } });
  next();
};

let server: Server;
let broken: Server;

async function listen(app: express.Express): Promise<Server> {
  const s = app.listen(0, '127.0.0.1');
  await new Promise((ready) => s.once('listening', ready));
  return s;
}

function usePort(s: Server): void {
  process.env.PORT = String((s.address() as AddressInfo).port);
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieAuth);
  const ctx = { pool, ticketService: { getTicket: async () => null, updateTicket: async () => undefined } } as unknown as AppContext;
  app.use('/api/linkedin-assistant', createLinkedInAssistantRoutes(ctx, path.join(process.cwd(), 'src/api')));
  server = await listen(app);

  // A surface whose confirm gate and ownership answer regressed.
  const brokenApp = express();
  brokenApp.post('/api/linkedin-assistant/drafts/:id/publish', (_req, res) => { res.status(404).json({ error: 'not_found' }); });
  brokenApp.get('/api/linkedin-assistant/drafts/:id', (_req, res) => { res.status(200).json({ draft: { id: 1 } }); });
  broken = await listen(brokenApp);
});

afterAll(async () => {
  await new Promise((done) => server.close(() => done(null)));
  await new Promise((done) => broken.close(() => done(null)));
  delete process.env.PORT;
});

const [card] = LINKEDIN_CONTENT_SCENARIOS;
const step = (id: string) => card.steps.find((s) => s.id === id)!;

describe('LinkedIn content queue Test Lab card', () => {
  it('is registered and every regression suite it names exists', () => {
    expect(SCENARIOS.some((s) => s.id === 'linkedin-content-queue')).toBe(true);
    expect(card.regressionTests?.length).toBeGreaterThan(0);
    for (const test of card.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
  });

  it('passes each step for a signed-in owner against the real router', async () => {
    usePort(server);
    const cookie = `test-user=${encodeURIComponent(OWNER)}`;
    expect(await step('confirm-gate').run(cookie, {})).toMatchObject({ state: 'pass', status: 428 });
    const provenance = await step('queue-provenance').run(cookie, {});
    expect(provenance).toMatchObject({ state: 'pass' });
    expect(provenance.detail).toMatch(/1 queue draft\(s\) name their ticket; 1 of 1 published carry the audited params hash/);
    expect(await step('unknown-draft').run(cookie, {})).toMatchObject({ state: 'pass', status: 404 });
  });

  it('degrades every step without a session', async () => {
    usePort(server);
    for (const id of ['confirm-gate', 'queue-provenance', 'unknown-draft']) {
      expect(await step(id).run('', {})).toMatchObject({ state: 'degraded', status: 401 });
    }
  });

  it('degrades the provenance step for an owner with no queue draft yet', async () => {
    usePort(server);
    const result = await step('queue-provenance').run('test-user=someone-else', {});
    expect(result).toMatchObject({ state: 'degraded' });
    expect(result.detail).toMatch(/linkedin-content-queue/);
  });

  it('fails when the confirm gate or the ownership answer regresses', async () => {
    usePort(broken);
    expect(await step('confirm-gate').run('test-user=x', {})).toMatchObject({ state: 'fail', status: 404 });
    expect(await step('unknown-draft').run('test-user=x', {})).toMatchObject({ state: 'fail', status: 200 });
  });
});
