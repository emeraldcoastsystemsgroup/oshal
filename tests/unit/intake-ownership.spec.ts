/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards from the signed-in route review (2026-10-05): an intake session belongs to the user who started it (message, read and submit answer 404 for anyone else), and both intake routes file the ticket as the caller's instead of as nobody's.
 */

import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/intake', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/intake')>(),
  // The real extractor runs an LLM CLI; the route's filing is what is under test.
  FastIntakeService: class {
    async extractTicket() {
      return { needsClarification: false, title: 'Fix the login page', description: 'It fails', priority: 'medium' };
    }
  },
}));

import { registerFastIntakeRoutes } from '@/app/routes/fast-intake-routes';
import { createIntakeAssistantRoutes } from '@/app/routes/intake-assistant-routes';

afterEach(() => { vi.clearAllMocks(); });

const signIn: RequestHandler = (req, _res, next) => {
  Object.assign(req, { oidc: { user: { sub: String(req.headers['x-test-sub'] ?? '') } } });
  next();
};

/** @description Serves an app built by `mount` and returns a caller-aware fetch helper. */
async function serve(mount: (app: express.Express) => void) {
  const app = express();
  app.use(express.json());
  app.use(signIn);
  mount(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    call: (path: string, sub: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-test-sub': sub },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function ticketService() {
  return { createTicket: vi.fn(async () => ({ ticketId: 'ticket-1' })) };
}

describe('fast intake files the ticket as the caller', () => {
  it('stamps the signed-in user as owner', async () => {
    const tickets = ticketService();
    const app = await serve((a) => registerFastIntakeRoutes(a, (_req, _res, next) => next(), tickets));
    try {
      const res = await app.call('/api/intake/fast', 'alice', 'POST', { message: 'The login page fails' });
      expect(res.status).toBe(200);
      expect(tickets.createTicket).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'alice', source: 'fast-intake' }));
    } finally { await app.close(); }
  });
});

describe('an intake session belongs to the user who started it', () => {
  it('reads as missing to anyone else, who can neither continue nor submit it', async () => {
    const tickets = ticketService();
    const app = await serve((a) => a.use('/api/v1/intake', createIntakeAssistantRoutes(tickets as never)));
    try {
      const { sessionId } = await (await app.call('/api/v1/intake/start', 'alice', 'POST', {})).json() as { sessionId: string };
      expect((await app.call(`/api/v1/intake/${sessionId}`, 'bob')).status).toBe(404);
      expect((await app.call(`/api/v1/intake/${sessionId}/message`, 'bob', 'POST', { message: 'done' })).status).toBe(404);
      expect((await app.call(`/api/v1/intake/${sessionId}/submit`, 'bob', 'POST', {})).status).toBe(404);
      expect(tickets.createTicket).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('lets the owner continue and submit, filing the ticket as theirs', async () => {
    const tickets = ticketService();
    const app = await serve((a) => a.use('/api/v1/intake', createIntakeAssistantRoutes(tickets as never)));
    try {
      const { sessionId } = await (await app.call('/api/v1/intake/start', 'alice', 'POST', {})).json() as { sessionId: string };
      expect((await app.call(`/api/v1/intake/${sessionId}`, 'alice')).status).toBe(200);
      expect((await app.call(`/api/v1/intake/${sessionId}/message`, 'alice', 'POST', { message: 'A status page for the team' })).status).toBe(200);
      expect((await app.call(`/api/v1/intake/${sessionId}/submit`, 'alice', 'POST', {})).status).toBe(200);
      expect(tickets.createTicket).toHaveBeenCalledWith(expect.objectContaining({ ownerSub: 'alice' }));
    } finally { await app.close(); }
  });
});
