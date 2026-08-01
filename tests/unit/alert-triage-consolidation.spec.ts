/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 named guards (ADR-119 / BACKLOG "Alert triage & consolidation" P1): identical-flood-one-ticket (10 concurrent identical alerts ⇒ ONE ticket, updateCount=9, ONE createTicket call), refire-updates-not-duplicates (visible updateCount/lastSeen, no new ticket), noise-counter-accuracy (unclaimed alertname ⇒ nothing created, queryable per-alertname counter), severity-never-lowers (higher refire raises priority, lower never lowers), incident-key-hygiene (empty key ⇒ fingerprint fallback), genesis-write-once + recurrence linking (FR-C5/C6), consolidation-TTL-window behavior, refire-never-redispatches (FR-E1), identity-gate drop counting (FR-A2/A3), and fail-closed auth on the stats read. Behavior/call assertions throughout — no substring guards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createAlertmanagerRoutes } from '@/app/routes/alertmanager-routes';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import {
  ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS,
  canonicalizeAlert,
  consolidationTtlSeconds,
  incidentOf,
  isWithinConsolidationTtl,
  renderIncidentKey,
} from '@/features/alert-triage';
import type { InternalTicket } from '@/entities/ticket';

const TOKEN = 'p1-triage-test-token';
const ALERT_ENV_KEYS = [
  'ALERT_WEBHOOK_TOKEN',
  'ALERT_WEBHOOK_HMAC_SECRET',
  'ALERT_APPROVED_NAMES',
  'ALERT_BACKLOG_NAMES',
  'ALERT_DEFAULT_INTAKE',
  'ALERT_TICKET_TYPE',
  'ALERT_CONSOLIDATION_TTL',
];
const savedEnv = new Map<string, string | undefined>();

interface Harness {
  service: TicketService;
  server: Server;
  port: number;
  post(payload: unknown, token?: string | null): Promise<{ status: number; body: Record<string, unknown> }>;
  getStats(token?: string | null): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** Boot the real router over the real service + in-memory store on an ephemeral port. */
async function makeHarness(): Promise<Harness> {
  const service = new TicketService(new InMemoryTicketStore());
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', createAlertmanagerRoutes(service));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;

  const request = async (method: string, path: string, body: unknown, token: string | null | undefined) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token === null ? {} : { Authorization: `Bearer ${token ?? TOKEN}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { parsed = {}; }
    return { status: res.status, body: parsed };
  };

  return {
    service,
    server,
    port,
    post: (payload, token) => request('POST', '/api/alerts/alertmanager', payload, token),
    getStats: (token) => request('GET', '/api/alerts/intake-stats', undefined, token),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** One firing alert payload (Alertmanager v4 shape). */
function firing(alertname: string, opts: { target?: string; severity?: string; fingerprint?: string; startsAt?: string } = {}): {
  alerts: Array<Record<string, unknown>>;
} {
  const labels: Record<string, string> = {};
  if (alertname) labels.alertname = alertname;
  labels.container = opts.target ?? 'oshal-worker-1';
  labels.severity = opts.severity ?? 'warning';
  return {
    alerts: [{
      status: 'firing',
      labels,
      annotations: { summary: `${alertname || 'unnamed'} test alert` },
      startsAt: opts.startsAt ?? '2026-07-31T10:00:00.000Z',
      fingerprint: opts.fingerprint ?? `fp-${alertname}-${opts.target ?? 'oshal-worker-1'}`,
    }],
  };
}

async function onlyTicket(service: TicketService): Promise<InternalTicket> {
  const tickets = await service.listTickets();
  expect(tickets).toHaveLength(1);
  return tickets[0];
}

beforeEach(() => {
  for (const key of ALERT_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.ALERT_WEBHOOK_TOKEN = TOKEN;
});

afterEach(() => {
  for (const key of ALERT_ENV_KEYS) {
    const prior = savedEnv.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  vi.restoreAllMocks();
});

describe('alert triage P1 consolidation guards (ADR-119 / BACKLOG P1)', () => {
  it('P1 guard identical-flood-one-ticket: 10 identical concurrent firing alerts yield exactly ONE ticket with updateCount=9 and visible first/last-seen', async () => {
    const h = await makeHarness();
    try {
      const createSpy = vi.spyOn(h.service, 'createTicket');
      const updateSpy = vi.spyOn(h.service, 'updateTicket');
      const results = await Promise.all(
        Array.from({ length: 10 }, () => h.post(firing('SwarmContainerDown'))),
      );
      for (const r of results) expect(r.status).toBe(200);
      expect(results.reduce((n, r) => n + Number(r.body.created ?? 0), 0)).toBe(1);
      expect(results.reduce((n, r) => n + Number(r.body.consolidated ?? 0), 0)).toBe(9);

      const ticket = await onlyTicket(h.service);
      const incident = incidentOf(ticket);
      expect(incident).not.toBeNull();
      expect(incident!.updateCount).toBe(9);
      expect(incident!.firstSeen).toBeTruthy();
      expect(incident!.lastSeen).toBeTruthy();
      expect(incident!.members).toHaveLength(1);
      expect(incident!.members[0].count).toBe(10);
      // The atomic-claim shape, asserted as CALLS: one create, nine updates.
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy).toHaveBeenCalledTimes(9);
    } finally {
      await h.close();
    }
  });

  it('P1 guard refire-updates-not-duplicates: a refire UPDATES the open ticket (updateCount + lastSeen advance) instead of minting a new one or silently skipping', async () => {
    const h = await makeHarness();
    try {
      const first = await h.post(firing('SwarmContainerRestartLoop', { startsAt: '2026-07-31T10:00:00.000Z' }));
      expect(first.body.created).toBe(1);
      const refire = await h.post(firing('SwarmContainerRestartLoop', { startsAt: '2026-07-31T10:05:00.000Z' }));
      // The refire is VISIBLE in the response — not a log-line skip.
      expect(refire.body.created).toBe(0);
      expect(refire.body.consolidated).toBe(1);

      const ticket = await onlyTicket(h.service);
      const incident = incidentOf(ticket);
      expect(incident!.updateCount).toBe(1);
      expect(incident!.firstSeen).toBe('2026-07-31T10:00:00.000Z');
      expect(incident!.lastSeen).toBe('2026-07-31T10:05:00.000Z');
      expect((refire.body.consolidatedTicketIds as string[])[0]).toBe(ticket.ticketId);
    } finally {
      await h.close();
    }
  });

  it('P1 guard noise-counter-accuracy: an unclaimed alertname creates NOTHING and increments the queryable per-alertname noise counter', async () => {
    process.env.ALERT_APPROVED_NAMES = 'SwarmContainerDown';
    const h = await makeHarness();
    try {
      await h.post(firing('NoisyAlert'));
      await h.post(firing('NoisyAlert'));
      await h.post(firing('NoisyAlert'));
      await h.post(firing('OtherNoise'));
      await h.post(firing('SwarmContainerDown'));

      const tickets = await h.service.listTickets();
      expect(tickets).toHaveLength(1); // only the claimed alert opened work

      const stats = await h.getStats();
      expect(stats.status).toBe(200);
      const snapshot = stats.body.stats as { counts: Record<string, number>; noiseByAlertname: Record<string, number> };
      expect(snapshot.counts.noise).toBe(4);
      expect(snapshot.counts.created).toBe(1);
      expect(snapshot.noiseByAlertname).toEqual({ NoisyAlert: 3, OtherNoise: 1 });
    } finally {
      await h.close();
    }
  });

  it('P1 guard severity-never-lowers: a higher-severity refire raises ticket priority; a lower-severity refire never lowers it', async () => {
    const h = await makeHarness();
    try {
      await h.post(firing('SwarmContainerUnhealthy', { severity: 'warning' }));
      expect((await onlyTicket(h.service)).priority).toBe('high');

      await h.post(firing('SwarmContainerUnhealthy', { severity: 'critical' }));
      let ticket = await onlyTicket(h.service);
      expect(ticket.priority).toBe('urgent');
      let incident = incidentOf(ticket)!;
      expect(incident.severity).toBe('critical');
      expect(incident.escalations).toHaveLength(1);
      expect(incident.escalations[0]).toMatchObject({ fromPriority: 'high', toPriority: 'urgent', severity: 'critical' });

      await h.post(firing('SwarmContainerUnhealthy', { severity: 'info' }));
      ticket = await onlyTicket(h.service);
      expect(ticket.priority).toBe('urgent'); // never lowered
      incident = incidentOf(ticket)!;
      expect(incident.updateCount).toBe(2);
      expect(incident.escalations).toHaveLength(1); // the info refire recorded no escalation
    } finally {
      await h.close();
    }
  });

  it('P1 guard incident-key-hygiene: an empty-rendering incident key falls back to the alert fingerprint; identity-bearing keys never do', () => {
    const empty = renderIncidentKey('', '', 'fp-abc');
    expect(empty.key).toBe('fp-abc');
    expect(empty.usedFingerprintFallback).toBe(true);

    const normal = renderIncidentKey('SwarmContainerDown', 'oshal-api', 'fp-x');
    expect(normal.key).toBe('SwarmContainerDown::oshal-api');
    expect(normal.usedFingerprintFallback).toBe(false);

    const nameOnly = renderIncidentKey('OnlyName', '', 'fp-y');
    expect(nameOnly.key).toBe('OnlyName::');
    expect(nameOnly.usedFingerprintFallback).toBe(false);
  });

  it('P1 guard identity-gate: an alert with no alertname and no resolvable target is dropped AND counted — never a ticket', async () => {
    const h = await makeHarness();
    try {
      const res = await h.post({ alerts: [{ status: 'firing', labels: { severity: 'critical' } }] });
      expect(res.status).toBe(200);
      expect(res.body.created).toBe(0);
      expect(res.body.dropped).toBe(1);
      expect(await h.service.listTickets()).toHaveLength(0);
      const stats = await h.getStats();
      expect((stats.body.stats as { counts: Record<string, number> }).counts.dropped).toBe(1);
      // And the pure gate agrees: no identity ⇒ null.
      expect(canonicalizeAlert({ status: 'firing', labels: { severity: 'critical' } })).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('P1 guard genesis-write-once + recurrence: firstSeen/createdAt survive refires, and a refire AFTER the incident went terminal opens a NEW ticket linked recurrenceOf', async () => {
    const h = await makeHarness();
    try {
      await h.post(firing('SwarmContainerDown', { startsAt: '2026-07-31T09:00:00.000Z' }));
      const genesis = await onlyTicket(h.service);
      await h.post(firing('SwarmContainerDown', { startsAt: '2026-07-31T09:10:00.000Z' }));
      await h.post(firing('SwarmContainerDown', { startsAt: '2026-07-31T09:20:00.000Z' }));

      let ticket = await onlyTicket(h.service);
      expect(ticket.createdAt).toBe(genesis.createdAt);
      expect(incidentOf(ticket)!.firstSeen).toBe('2026-07-31T09:00:00.000Z'); // genesis is write-once

      // Terminal → a refire starts a FRESH incident carrying the recurrence link (FR-C5).
      await h.service.updateStatus(ticket.ticketId, 'complete');
      const refire = await h.post(firing('SwarmContainerDown', { startsAt: '2026-07-31T11:00:00.000Z' }));
      expect(refire.body.created).toBe(1);

      const tickets = await h.service.listTickets();
      expect(tickets).toHaveLength(2);
      const successor = tickets.find((t) => t.ticketId !== ticket.ticketId)!;
      const successorIncident = incidentOf(successor)!;
      expect(successorIncident.recurrenceOf).toBe(ticket.ticketId);
      expect(successorIncident.recurrenceCount).toBe(1);
      expect(successorIncident.updateCount).toBe(0);
      expect(successor.externalId).not.toBe(ticket.externalId); // distinct DB claim per incident instance

      ticket = (await h.service.getTicket(ticket.ticketId))!;
      expect(ticket.status).toBe('complete'); // the predecessor stays terminal
      expect(incidentOf(ticket)!.updateCount).toBe(2); // and untouched by the recurrence
    } finally {
      await h.close();
    }
  });

  it('P1 guard consolidation-ttl-window: ALERT_CONSOLIDATION_TTL is a real knob — the window math honors it and junk values fall back to the 24h default', () => {
    // Default when unset.
    expect(consolidationTtlSeconds()).toBe(ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS);
    process.env.ALERT_CONSOLIDATION_TTL = '3600';
    expect(consolidationTtlSeconds()).toBe(3600);
    process.env.ALERT_CONSOLIDATION_TTL = 'not-a-number';
    expect(consolidationTtlSeconds()).toBe(ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS);
    process.env.ALERT_CONSOLIDATION_TTL = '-5';
    expect(consolidationTtlSeconds()).toBe(ALERT_CONSOLIDATION_TTL_DEFAULT_SECONDS);

    // Window math (FR-C5): inside links, outside starts fresh, unparseable never links.
    const terminalAt = '2026-07-31T00:00:00.000Z';
    const h23 = Date.parse('2026-07-31T23:00:00.000Z');
    const h25 = Date.parse('2026-08-01T01:00:00.000Z');
    expect(isWithinConsolidationTtl(terminalAt, h23, 86400)).toBe(true);
    expect(isWithinConsolidationTtl(terminalAt, h25, 86400)).toBe(false);
    expect(isWithinConsolidationTtl(terminalAt, Date.parse('2026-07-31T02:00:00.000Z'), 3600)).toBe(false);
    expect(isWithinConsolidationTtl('garbage-timestamp', h23, 86400)).toBe(false);
  });

  it('P1 guard refire-never-redispatches (FR-E1): a refire on a dispatched (in_process_discovery) ticket leaves status untouched and creates nothing', async () => {
    const h = await makeHarness();
    try {
      await h.post(firing('SwarmContainerDown'));
      const ticket = await onlyTicket(h.service);
      expect(ticket.status).toBe('approved');
      await h.service.updateStatus(ticket.ticketId, 'in_process_discovery');

      const statusSpy = vi.spyOn(h.service, 'updateStatus');
      const refire = await h.post(firing('SwarmContainerDown'));
      expect(refire.body.consolidated).toBe(1);
      expect(refire.body.created).toBe(0);

      const after = (await h.service.getTicket(ticket.ticketId))!;
      expect(after.status).toBe('in_process_discovery'); // consolidation never touches status
      expect(incidentOf(after)!.updateCount).toBe(1);
      expect(statusSpy).not.toHaveBeenCalled(); // asserted as CALLS, not just end-state
      expect(await h.service.listTickets()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('the intake-stats read is auth-gated fail-closed: no token ⇒ 401, wrong token ⇒ 401, bearer ⇒ 200', async () => {
    const h = await makeHarness();
    try {
      expect((await h.getStats(null)).status).toBe(401);
      expect((await h.getStats('wrong-token')).status).toBe(401);
      expect((await h.getStats()).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('the webhook itself stays fail-closed: with no ALERT_WEBHOOK_TOKEN configured every POST is rejected', async () => {
    delete process.env.ALERT_WEBHOOK_TOKEN;
    const h = await makeHarness();
    try {
      const res = await h.post(firing('SwarmContainerDown'));
      expect(res.status).toBe(401);
      expect(await h.service.listTickets()).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});
