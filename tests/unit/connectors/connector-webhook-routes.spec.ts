/**
 * Connector webhook ingress wiring (ADR-065): event loading from specs + ticket-sink adapter.
 * No HTTP/DB — loads the real connector.yaml webhooks and exercises the adapter with a fake service.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pointed the GitHub connector webhook contract at issue lifecycle events
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Proved GitHub issue events take the specialized sync path without duplicate generic tickets
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Proved exact-byte HMAC verification, GitHub delivery identifiers, and trusted system dispatch
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Guarded production middleware order so global JSON parsing cannot consume signed webhook bytes
 *
 * @module tests/unit/connectors/connector-webhook-routes
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createConnectorWebhookHandler,
  loadWebhookEvents,
  makeTicketSink,
  mountConnectorWebhookRoutes,
} from '@/app/routes/connector-webhook-routes';
import type { GitHubTicketWebhookTicketService } from '@/app/routes/github-ticket-webhook-sync';
import { getRequestIdentity } from '@/shared/services/database/request-identity';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadWebhookEvents', () => {
  it('flattens declared webhooks from the connector catalog with resolved secrets', () => {
    process.env.GITHUB_WEBHOOK_SECRET = 'whsec_abc';
    const events = loadWebhookEvents();
    const gh = events.find((e) => e.provider === 'github' && e.event === 'issues');
    expect(gh).toBeTruthy();
    expect(gh!.verify).toMatchObject({ type: 'hmac', header: 'X-Hub-Signature-256', secret: 'whsec_abc' });
  });
});

describe('makeTicketSink', () => {
  it('adapts the narrow handler input to a full ticket with sane defaults', async () => {
    const created: Record<string, unknown>[] = [];
    const sink = makeTicketSink({ createTicket: async (i) => { created.push(i); return { ticketId: 't1' }; } });
    const res = await sink.createTicket({
      title: 'T', ticketType: 'intelligent-processing', description: 'd',
      externalProvider: 'github', externalId: 'dlv1', labels: ['webhook'], metadata: { a: 1 },
    });
    expect(res).toEqual({ ticketId: 't1' });
    expect(created[0]).toMatchObject({
      title: 'T', externalProvider: 'github', externalId: 'dlv1',
      status: 'backlog', priority: 'medium', workspaceId: null, parentTicketId: null,
    });
  });
});

describe('createConnectorWebhookHandler', () => {
  it('sends configured GitHub issue events only through the idempotent issue synchronizer', async () => {
    vi.stubEnv('GITHUB_TICKET_FEEDS', JSON.stringify([configuredFeed()]));
    const ticketService = buildTicketService();
    let systemIdentity = false;
    ticketService.getTicketByExternalId.mockImplementation(async () => {
      systemIdentity = getRequestIdentity()?.system === true;
      return null;
    });
    const handler = createConnectorWebhookHandler(ticketService as unknown as GitHubTicketWebhookTicketService);

    await handler({
      provider: 'github',
      event: 'issues',
      deliveryId: 'delivery-1',
      headers: {},
      payload: issuePayload(),
    });

    expect(ticketService.getTicketByExternalId).toHaveBeenCalledWith(
      'github',
      'emeraldcoastsystemsgroup/oshal#42',
    );
    expect(ticketService.createTicket).toHaveBeenCalledTimes(1);
    expect(systemIdentity).toBe(true);
    expect(ticketService.createTicket).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Mobile cockpit request',
      externalId: 'emeraldcoastsystemsgroup/oshal#42',
      status: 'backlog',
    }));
  });

  it('preserves the generic ticket mapper for every other connector event', async () => {
    vi.stubEnv('GITHUB_TICKET_FEEDS', JSON.stringify([configuredFeed()]));
    const ticketService = buildTicketService();
    const handler = createConnectorWebhookHandler(ticketService as unknown as GitHubTicketWebhookTicketService);

    await handler({
      provider: 'example',
      event: 'changed',
      deliveryId: 'delivery-2',
      headers: {},
      payload: { value: 1 },
    });

    expect(ticketService.getTicketByExternalId).not.toHaveBeenCalled();
    expect(ticketService.createTicket).toHaveBeenCalledTimes(1);
    expect(ticketService.createTicket).toHaveBeenCalledWith(expect.objectContaining({
      title: '[example] changed',
      externalId: 'delivery-2',
      status: 'backlog',
    }));
  });
});

describe('mountConnectorWebhookRoutes', () => {
  it('reserves /api/hooks from the production global JSON parser', () => {
    const source = readFileSync('src/app/server.ts', 'utf8');
    const parserStart = source.indexOf("req.path.startsWith('/api/remote-clients')");
    const parserEnd = source.indexOf('// CSP violation collector', parserStart);
    const productionParser = source.slice(parserStart, parserEnd);

    expect(parserStart).toBeGreaterThan(-1);
    expect(parserEnd).toBeGreaterThan(parserStart);
    expect(productionParser).toContain("req.path.startsWith('/api/hooks')");
    expect(productionParser.indexOf("req.path.startsWith('/api/hooks')"))
      .toBeLessThan(productionParser.indexOf('express.json()'));
  });

  it('verifies exact GitHub bytes and deduplicates by X-GitHub-Delivery', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'webhook-secret');
    vi.stubEnv('GITHUB_TICKET_FEEDS', JSON.stringify([configuredFeed()]));
    const ticketService = buildTicketService();
    const seen = new Set<string>();
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      const deliveryId = String(params[0]);
      if (sql.startsWith('SELECT')) {
        return { rows: seen.has(deliveryId) ? [{ found: true }] : [] };
      }
      seen.add(deliveryId);
      return { rows: [] };
    });
    const app = express();
    mountConnectorWebhookRoutes(app, {
      pool: { query },
      ticketService: ticketService as unknown as GitHubTicketWebhookTicketService,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify(issuePayload(), null, 2);
    const signature = crypto.createHmac('sha256', 'webhook-secret').update(body).digest('hex');
    const send = () => fetch(`http://127.0.0.1:${port}/api/hooks/github/issues`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'github-delivery-1',
        'x-hub-signature-256': `sha256=${signature}`,
      },
      body,
    });

    try {
      const response = await send();
      const replay = await send();

      expect(response.status).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, deduped: true });
      expect(ticketService.createTicket).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT 1'), ['github-delivery-1']);
      expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO'), ['github-delivery-1']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
  });
});

function configuredFeed() {
  return {
    id: 'core',
    issueRepository: 'emeraldcoastsystemsgroup/oshal',
    workRepository: 'emeraldcoastsystemsgroup/open-shal',
    releaseRepository: 'emeraldcoastsystemsgroup/oshal',
    ticketType: 'oshal-dev',
    queueId: 'github-core-requests',
    queueName: 'GitHub Core Requests',
    labels: [],
    requestMode: 'request-only',
    closePolicy: 'release-proof',
    bootstrap: { mode: 'since', at: '2026-07-20T02:00:00.000Z' },
  };
}

function issuePayload() {
  return {
    action: 'opened',
    repository: { full_name: 'emeraldcoastsystemsgroup/oshal' },
    issue: {
      number: 42,
      title: 'Mobile cockpit request',
      body: 'Fix narrow-screen overflow.',
      state: 'open',
      html_url: 'https://github.com/emeraldcoastsystemsgroup/oshal/issues/42',
      labels: [],
      created_at: '2026-07-20T02:30:00.000Z',
      updated_at: '2026-07-20T02:30:00.000Z',
    },
  };
}

function buildTicketService() {
  return {
    getTicketByExternalId: vi.fn(async () => null),
    createTicket: vi.fn(async () => ({ ticketId: 'ticket-1', status: 'backlog' })),
    updateTicket: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
  };
}
