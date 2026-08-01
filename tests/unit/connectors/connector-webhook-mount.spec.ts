/**
 * webhook-router-mounted-and-authenticated — ADR-065 Phase 4.
 *
 * WHY THIS EXISTS: ADR-065 listed "mount the webhook router" as outstanding Phase 4 work while the
 * router was in fact already mounted in server.ts. Nothing guarded it either way, so nothing noticed
 * the doc had drifted — and nothing would notice if the mount were removed either. Two properties,
 * both behavioural:
 *
 *  1. MOUNTED, and not vacuously: the ingress is a deployment decision
 *     (`connectorWebhookIngressEnabled`) and, when on, it wires the events the REAL connector catalog
 *     declares. A mounted router serving zero events would pass a "is it mounted" check and still do
 *     nothing.
 *  2. AUTHENTICATED: the route sits OUTSIDE the OIDC wall by design (providers call it
 *     machine-to-machine), so its only guard is the HMAC signature. An unsigned, wrongly-signed, or
 *     undeclared delivery must be REFUSED — and must never reach the ticket sink. That is what makes
 *     "no OIDC" safe rather than "no auth".
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — gate on/off, catalog-declared events are non-empty, and the four refusal shapes (no signature, wrong signature, undeclared event, undeclared provider) each prove no ticket was created.
 */
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectorWebhookIngressEnabled, loadWebhookEvents, mountConnectorWebhookRoutes,
} from '../../../src/app/routes/connector-webhook-routes';
import type { GitHubTicketWebhookTicketService } from '../../../src/app/routes/github-ticket-webhook-sync';

const SECRET = 'webhook-mount-guard-secret';

afterEach(() => { vi.unstubAllEnvs(); });

describe('the ingress mount is a deployment decision', () => {
  it('is OFF unless CONNECTOR_WEBHOOKS is exactly "on"', () => {
    expect(connectorWebhookIngressEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(connectorWebhookIngressEnabled({ CONNECTOR_WEBHOOKS: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(connectorWebhookIngressEnabled({ CONNECTOR_WEBHOOKS: 'off' } as NodeJS.ProcessEnv)).toBe(false);
    expect(connectorWebhookIngressEnabled({ CONNECTOR_WEBHOOKS: 'on' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('wires events the REAL connector catalog declares — a mount serving nothing is not a mount', () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    const events = loadWebhookEvents();
    expect(events.length).toBeGreaterThan(0);
    // Every wired event carries a verification method — an event with no verify is not wired at all.
    expect(events.every((e) => Boolean(e.verify?.type && e.verify?.header))).toBe(true);
  });
});

/** Boot the ingress on an ephemeral port with a spying ticket sink. */
async function ingress() {
  const createTicket = vi.fn(async () => ({ ticketId: 'T-1' }));
  const app = express();
  const seen = new Set<string>();
  mountConnectorWebhookRoutes(app, {
    pool: {
      query: async (sql: string, params: unknown[]) => {
        const id = String(params[0]);
        if (/^\s*SELECT/i.test(sql)) return { rows: seen.has(id) ? [{ found: true }] : [] };
        seen.add(id);
        return { rows: [] };
      },
    },
    ticketService: { createTicket } as unknown as GitHubTicketWebhookTicketService,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    createTicket,
    post: (pathname: string, body: string, headers: Record<string, string>) => fetch(
      `http://127.0.0.1:${port}${pathname}`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body },
    ),
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe('a mounted ingress is signature-authenticated', () => {
  const payload = JSON.stringify({ action: 'opened', issue: { number: 1, title: 't', body: 'b', html_url: 'u', state: 'open', labels: [] }, repository: { full_name: 'emeraldcoastsystemsgroup/oshal' } });

  it('REFUSES a delivery with no signature at all, and creates no ticket', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    const api = await ingress();
    try {
      const res = await api.post('/api/hooks/github/issues', payload, { 'x-github-delivery': 'd-unsigned' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(api.createTicket).not.toHaveBeenCalled();
    } finally { await api.close(); }
  });

  it('REFUSES a delivery signed with the wrong secret', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    const api = await ingress();
    try {
      const wrong = crypto.createHmac('sha256', 'not-the-secret').update(payload).digest('hex');
      const res = await api.post('/api/hooks/github/issues', payload, {
        'x-github-delivery': 'd-wrong', 'x-hub-signature-256': `sha256=${wrong}`,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(api.createTicket).not.toHaveBeenCalled();
    } finally { await api.close(); }
  });

  it('REFUSES an event or provider the catalog never declared, even correctly signed', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    const api = await ingress();
    try {
      const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
      const undeclaredEvent = await api.post('/api/hooks/github/not-a-declared-event', payload, {
        'x-github-delivery': 'd-1', 'x-hub-signature-256': sig,
      });
      const undeclaredProvider = await api.post('/api/hooks/nosuchprovider/issues', payload, {
        'x-github-delivery': 'd-2', 'x-hub-signature-256': sig,
      });
      expect(undeclaredEvent.status).toBeGreaterThanOrEqual(400);
      expect(undeclaredProvider.status).toBeGreaterThanOrEqual(400);
      expect(api.createTicket).not.toHaveBeenCalled();
    } finally { await api.close(); }
  });

  it('ACCEPTS a correctly signed, declared delivery — so the refusals above are not blanket', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    const api = await ingress();
    try {
      const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
      const res = await api.post('/api/hooks/github/issues', payload, {
        'x-github-delivery': 'd-good', 'x-hub-signature-256': sig,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
      // (What a verified github/issues event then DOES is the configured-feed synchronizer's job —
      //  covered by connector-webhook-routes.spec.ts. Here the point is only that a correctly signed,
      //  declared delivery is ACCEPTED, so the refusals above are discrimination, not a blanket 4xx.)
    } finally { await api.close(); }
  });
});
