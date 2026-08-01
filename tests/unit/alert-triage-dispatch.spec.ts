/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 named guards (ADR-119 Stage B + E / BACKLOG "Alert triage & consolidation" P3): budget-skip-visible-and-promotable (spec guard 6 — over-budget auto-flow parks in backlog carrying analysis-skipped:budget, a promote dispatches and sticks, reserve-before-act meters a burst), budget-fail-open (unreadable spend NEVER parks), flap-defers-and-surfaces (spec guard 7 — 6 refires in 30m flag flapping + demote the undispatched ticket, quiet restores it, an operator promote mid-episode sticks, an in-flight ticket gets the flag only), resolved-closes-only-backlog (spec guard 8 — ALERT_AUTO_RESOLVE=true closes a fully-resolved backlog ticket as self-resolved, approved never closes, default-off proven, a refire clears a member's resolution), matcher-hygiene (spec guard 9 — time predicates rejected at registry load, proven at load AND behaviorally), key-hygiene-multi-alertname (spec guard 10 deferred half — multi-name rule without {alertname}, placeholder-less and free-text/timestamp templates all rejected), claim-registry-routing (per-rule key templates re-key Stage A, per-rule intake slots under the SRE label, per-rule rootFilter drives FR-D4 end-to-end), unclaimed-policy (drop=counted noise, backlog=parked ticket). Behavior/call assertions throughout — no substring guards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createAlertmanagerRoutes } from '@/app/routes/alertmanager-routes';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import {
  ALERT_FLAP_THRESHOLD_DEFAULT,
  ALERT_RCA_HOURLY_BUDGET_DEFAULT_USD,
  autoResolveEnabled,
  flapThreshold,
  incidentOf,
  rcaHourlyBudgetUsd,
  validateClaimRule,
  type RcaSpendReader,
} from '@/features/alert-triage';
import type { InternalTicket } from '@/entities/ticket';

const TOKEN = 'p3-triage-test-token';
const ALERT_ENV_KEYS = [
  'ALERT_WEBHOOK_TOKEN',
  'ALERT_WEBHOOK_HMAC_SECRET',
  'ALERT_APPROVED_NAMES',
  'ALERT_BACKLOG_NAMES',
  'ALERT_DEFAULT_INTAKE',
  'ALERT_TICKET_TYPE',
  'ALERT_CONSOLIDATION_TTL',
  'ALERT_CORRELATION_WINDOW',
  'ALERT_CORRELATION_DEPTH',
  'ALERT_DEPENDENCY_MAP',
  'ALERT_MAX_MEMBERS',
  'ALERT_CLAIMS_FILE',
  'ALERT_UNCLAIMED_POLICY',
  'ALERT_RCA_HOURLY_BUDGET_USD',
  'ALERT_FLAP_THRESHOLD',
  'ALERT_FLAP_WINDOW',
  'ALERT_FLAP_QUIET',
  'ALERT_AUTO_RESOLVE',
];
const savedEnv = new Map<string, string | undefined>();

interface Harness {
  service: TicketService;
  server: Server;
  post(payload: unknown, token?: string | null): Promise<{ status: number; body: Record<string, unknown> }>;
  getStats(token?: string | null): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** Boot the real router over the real service + in-memory store on an ephemeral port. */
async function makeHarness(options: { rcaSpend?: RcaSpendReader | null } = {}): Promise<Harness> {
  const service = new TicketService(new InMemoryTicketStore());
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', createAlertmanagerRoutes(service, options));
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
    post: (payload, token) => request('POST', '/api/alerts/alertmanager', payload, token),
    getStats: (token) => request('GET', '/api/alerts/intake-stats', undefined, token),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** ISO timestamp N seconds before now (event times drive the deterministic gates). */
function agoIso(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

interface AlertOpts {
  target?: string;
  severity?: string;
  fingerprint?: string;
  startsAt?: string;
  endsAt?: string;
  intake?: string;
  extraLabels?: Record<string, string>;
}

/** One alert payload (Alertmanager v4 shape) with a resolvable container target. */
function alertPayload(alertname: string, status: 'firing' | 'resolved', opts: AlertOpts = {}): {
  alerts: Array<Record<string, unknown>>;
} {
  const target = opts.target ?? 'oshal-local-api';
  const labels: Record<string, string> = {
    alertname,
    container: target,
    severity: opts.severity ?? 'warning',
    ...(opts.extraLabels ?? {}),
  };
  if (opts.intake) labels.intake = opts.intake;
  return {
    alerts: [{
      status,
      labels,
      annotations: { summary: `${alertname} test alert` },
      startsAt: opts.startsAt ?? agoIso(30),
      ...(status === 'resolved' ? { endsAt: opts.endsAt ?? agoIso(5) } : {}),
      fingerprint: opts.fingerprint ?? `fp-${alertname}-${target}`,
    }],
  };
}

const firing = (alertname: string, opts: AlertOpts = {}) => alertPayload(alertname, 'firing', opts);
const resolved = (alertname: string, opts: AlertOpts = {}) => alertPayload(alertname, 'resolved', opts);

/** A spend reader whose numbers the test controls. */
function fakeSpendReader(state: { spend: number | null; recentCosts: number[] | null }): RcaSpendReader {
  return {
    hourlyRcaSpendUsd: async () => state.spend,
    recentRcaTicketCostsUsd: async () => state.recentCosts,
  };
}

async function onlyTicket(service: TicketService): Promise<InternalTicket> {
  const tickets = await service.listTickets();
  expect(tickets).toHaveLength(1);
  return tickets[0];
}

/** Write a claims file into a temp dir and point ALERT_CLAIMS_FILE at it. */
function useClaimsFile(rules: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-claims-'));
  const file = join(dir, 'claims.json');
  writeFileSync(file, JSON.stringify({ rules }), 'utf8');
  process.env.ALERT_CLAIMS_FILE = file;
  return file;
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

describe('alert triage P3 dispatch-gate guards (ADR-119 Stage B + E / BACKLOG P3)', () => {
  it('P3 guard budget-skip-visible-and-promotable (spec guard 6): sliding-hour spend >= cap parks the auto-flow ticket in backlog carrying analysis-skipped:budget, and an operator promote dispatches it and sticks', async () => {
    const state = { spend: 12, recentCosts: [0.5] }; // >= the $10 default
    const h = await makeHarness({ rcaSpend: fakeSpendReader(state) });
    try {
      const res = await h.post(firing('SwarmContainerDown', { target: 'oshal-local-email-bot' }));
      expect(res.status).toBe(200);
      expect(res.body.created).toBe(1);
      expect(res.body.backlogged).toBe(1); // the park is visible in the response
      expect(res.body.autoFlowed).toBe(0);

      const ticket = await onlyTicket(h.service);
      expect(ticket.status).toBe('backlog'); // parked, not dispatched
      expect(ticket.labels).toContain('analysis-skipped:budget'); // and it says WHY
      const incident = incidentOf(ticket)!;
      expect(incident.flags).toContain('analysis-skipped:budget');

      // "An operator promote always overrides": the promote succeeds and the intake
      // never re-parks a promoted ticket on a later refire.
      await h.service.updateStatus(ticket.ticketId, 'approved');
      await h.post(firing('SwarmContainerDown', { target: 'oshal-local-email-bot', startsAt: agoIso(10) }));
      const after = (await h.service.getTicket(ticket.ticketId))!;
      expect(after.status).toBe('approved');
      expect(incidentOf(after)!.updateCount).toBe(1);
    } finally {
      await h.close();
    }

    // Knob sanity (one constants module): junk falls back to the $10 default.
    process.env.ALERT_RCA_HOURLY_BUDGET_USD = 'junk';
    expect(rcaHourlyBudgetUsd()).toBe(ALERT_RCA_HOURLY_BUDGET_DEFAULT_USD);
    process.env.ALERT_RCA_HOURLY_BUDGET_USD = '2.5';
    expect(rcaHourlyBudgetUsd()).toBe(2.5);
  });

  it('P3 guard budget-reserve-before-act: an allowed dispatch reserves the p95 estimate, so a burst cannot race two dispatches under one budget read', async () => {
    process.env.ALERT_RCA_HOURLY_BUDGET_USD = '1';
    const state = { spend: 0.5, recentCosts: [0.4, 0.5, 0.6] }; // p95 = 0.6
    const h = await makeHarness({ rcaSpend: fakeSpendReader(state) });
    try {
      // Unrelated targets/names so Stage D cannot bundle them into one incident.
      const first = await h.post(firing('CustomAlertA', { target: 'custom-service-a' }));
      expect(first.body.created).toBe(1);
      const second = await h.post(firing('CustomAlertB', { target: 'custom-service-b' }));
      expect(second.body.created).toBe(1);

      const tickets = await h.service.listTickets();
      const a = tickets.find((t) => t.title.includes('CustomAlertA'))!;
      const b = tickets.find((t) => t.title.includes('CustomAlertB'))!;
      // Actuals alone (0.5) clear the $1 cap, so WITHOUT the reservation both would
      // dispatch. The first dispatch reserved 0.6 → 0.5 + 0.6 >= 1 parks the second.
      expect(a.status).toBe('approved');
      expect(b.status).toBe('backlog');
      expect(b.labels).toContain('analysis-skipped:budget');
    } finally {
      await h.close();
    }
  });

  it('P3 guard budget-fail-open: unreadable spend (or no reader wired) NEVER parks — a DB gap must not blind the swarm to its own outages', async () => {
    const h1 = await makeHarness({ rcaSpend: fakeSpendReader({ spend: null, recentCosts: null }) });
    try {
      await h1.post(firing('SwarmContainerDown', { target: 'oshal-local-email-bot' }));
      expect((await onlyTicket(h1.service)).status).toBe('approved');
    } finally {
      await h1.close();
    }
    const h2 = await makeHarness(); // no reader at all (pool-less deployment)
    try {
      await h2.post(firing('SwarmContainerDown', { target: 'oshal-local-email-bot' }));
      const ticket = await onlyTicket(h2.service);
      expect(ticket.status).toBe('approved');
      expect(ticket.labels).not.toContain('analysis-skipped:budget');
    } finally {
      await h2.close();
    }
  });

  it('P3 guard flap-defers-and-surfaces (spec guard 7): 6 refires in 30m flag the incident flapping and demote the not-yet-dispatched ticket to backlog; a refire after the quiet period restores it', async () => {
    const h = await makeHarness();
    try {
      const base = 25 * 60; // seconds ago
      await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot', startsAt: agoIso(base) }));
      const ticket = await onlyTicket(h.service);
      expect(ticket.status).toBe('approved'); // auto-flow, awaiting dispatch

      const statusSpy = vi.spyOn(h.service, 'updateStatus');
      for (let i = 1; i <= 6; i += 1) {
        await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot', startsAt: agoIso(base - i * 60) }));
      }
      let after = (await h.service.getTicket(ticket.ticketId))!;
      expect(incidentOf(after)!.flags).toContain('flapping'); // surfaced as STATE
      expect(after.status).toBe('backlog'); // dispatch deferred
      // The demote is ONE transition on the trip — continued flapping never re-demotes.
      expect(statusSpy.mock.calls.filter(([, s]) => s === 'backlog')).toHaveLength(1);

      // Quiet for >= ALERT_FLAP_QUIET (10m default) ends the episode: the flap-parked
      // ticket returns to its auto-flow status and the flag clears.
      await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot', startsAt: agoIso(base - 6 * 60 - 11 * 60) }));
      after = (await h.service.getTicket(ticket.ticketId))!;
      expect(after.status).toBe('approved');
      expect(incidentOf(after)!.flags).not.toContain('flapping');
    } finally {
      await h.close();
    }

    // Knob sanity: junk threshold falls back to 5.
    process.env.ALERT_FLAP_THRESHOLD = 'junk';
    expect(flapThreshold()).toBe(ALERT_FLAP_THRESHOLD_DEFAULT);
  });

  it('P3 guard flap-promote-sticks: an operator promote mid-episode is respected — continued refires do not re-park the ticket', async () => {
    const h = await makeHarness();
    try {
      const base = 25 * 60;
      await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot', startsAt: agoIso(base) }));
      const ticket = await onlyTicket(h.service);
      for (let i = 1; i <= 5; i += 1) {
        await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot', startsAt: agoIso(base - i * 60) }));
      }
      expect(((await h.service.getTicket(ticket.ticketId))!).status).toBe('backlog'); // flap-parked

      await h.service.updateStatus(ticket.ticketId, 'approved'); // the operator overrides
      const statusSpy = vi.spyOn(h.service, 'updateStatus');
      await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot', startsAt: agoIso(base - 6 * 60) }));
      const after = (await h.service.getTicket(ticket.ticketId))!;
      expect(after.status).toBe('approved'); // still the operator's call
      expect(statusSpy).not.toHaveBeenCalled(); // asserted as CALLS, not just end-state
    } finally {
      await h.close();
    }
  });

  it('P3 guard flap-in-flight-flag-only: once RCA is running, flapping is surfaced on the record but the ticket status is never touched', async () => {
    const h = await makeHarness();
    try {
      const base = 25 * 60;
      await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot', startsAt: agoIso(base) }));
      const ticket = await onlyTicket(h.service);
      await h.service.updateStatus(ticket.ticketId, 'in_process_discovery'); // dispatcher took it

      const statusSpy = vi.spyOn(h.service, 'updateStatus');
      for (let i = 1; i <= 6; i += 1) {
        await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot', startsAt: agoIso(base - i * 60) }));
      }
      const after = (await h.service.getTicket(ticket.ticketId))!;
      expect(after.status).toBe('in_process_discovery');
      expect(incidentOf(after)!.flags).toContain('flapping');
      expect(statusSpy).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('P3 guard resolved-closes-only-backlog (spec guard 8): with ALERT_AUTO_RESOLVE=true a FULLY-resolved backlog bundle self-closes; a refire un-resolves its member first and blocks the close', async () => {
    process.env.ALERT_AUTO_RESOLVE = 'true';
    const h = await makeHarness();
    try {
      // A two-member bundle parked in backlog (same target ⇒ Stage D attach).
      await h.post(firing('SwarmApiUnreachable', { target: 'oshal-local-api', intake: 'backlog', startsAt: agoIso(120) }));
      const attach = await h.post(firing('SwarmContainerDown', { target: 'oshal-local-api', intake: 'backlog', startsAt: agoIso(90) }));
      expect(attach.body.bundled).toBe(1);
      const ticket = await onlyTicket(h.service);
      expect(ticket.status).toBe('backlog');

      // Resolving the BUNDLED member (whose incident key differs from the ticket's key)
      // marks it via the fingerprint scan; one member still burning ⇒ no close.
      const r1 = await h.post(resolved('SwarmContainerDown', { target: 'oshal-local-api' }));
      expect(r1.body.resolved).toBe(1);
      let incident = incidentOf((await h.service.getTicket(ticket.ticketId))!)!;
      expect(incident.members.find((m) => m.alertname === 'SwarmContainerDown')!.resolvedAt).toBeTruthy();
      expect((await h.service.getTicket(ticket.ticketId))!.status).toBe('backlog');

      // The member refires: its resolution CLEARS (FR-E4 — a burning member is not resolved).
      await h.post(firing('SwarmContainerDown', { target: 'oshal-local-api', intake: 'backlog', startsAt: agoIso(60) }));
      incident = incidentOf((await h.service.getTicket(ticket.ticketId))!)!;
      expect(incident.members.find((m) => m.alertname === 'SwarmContainerDown')!.resolvedAt).toBeUndefined();

      // Now resolve BOTH members ⇒ the backlog ticket completes as self-resolved.
      await h.post(resolved('SwarmContainerDown', { target: 'oshal-local-api' }));
      await h.post(resolved('SwarmApiUnreachable', { target: 'oshal-local-api' }));
      const closed = (await h.service.getTicket(ticket.ticketId))!;
      expect(closed.status).toBe('complete');
      expect(closed.labels).toContain('self-resolved');
      expect(incidentOf(closed)!.flags).toContain('self-resolved');
    } finally {
      await h.close();
    }
  });

  it('P3 guard resolved-never-closes-engaged-or-default-off (spec guard 8): the same events on an approved ticket change member state only, and default-off never closes anything', async () => {
    // Approved (analyst engaged): member marked, status untouched — a human decides.
    process.env.ALERT_AUTO_RESOLVE = 'true';
    let h = await makeHarness();
    try {
      await h.post(firing('SwarmContainerDown', { target: 'oshal-local-email-bot' }));
      const ticket = await onlyTicket(h.service);
      expect(ticket.status).toBe('approved');
      const statusSpy = vi.spyOn(h.service, 'updateStatus');
      await h.post(resolved('SwarmContainerDown', { target: 'oshal-local-email-bot' }));
      const after = (await h.service.getTicket(ticket.ticketId))!;
      expect(after.status).toBe('approved');
      expect(incidentOf(after)!.members[0].resolvedAt).toBeTruthy();
      expect(statusSpy).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }

    // Default OFF (the knob ships honest): a fully-resolved backlog ticket stays open.
    delete process.env.ALERT_AUTO_RESOLVE;
    expect(autoResolveEnabled()).toBe(false);
    h = await makeHarness();
    try {
      await h.post(firing('SwarmContainerDown', { target: 'oshal-local-email-bot', intake: 'backlog' }));
      const ticket = await onlyTicket(h.service);
      await h.post(resolved('SwarmContainerDown', { target: 'oshal-local-email-bot' }));
      const after = (await h.service.getTicket(ticket.ticketId))!;
      expect(after.status).toBe('backlog');
      expect(incidentOf(after)!.members[0].resolvedAt).toBeTruthy(); // marked, honestly, without acting
    } finally {
      await h.close();
    }
  });

  it('P3 guard matcher-hygiene (spec guard 9): a claim rule containing a time predicate is rejected at registry load — proven at load AND behaviorally', async () => {
    // Load-time: the whole class of temporal matchers is rejected.
    expect(validateClaimRule({ match: { labels: { startsAt: '2026-07-31' } } }).ok).toBe(false);
    expect(validateClaimRule({ match: { labels: { last_seen: '5m' } } }).ok).toBe(false);
    expect(validateClaimRule({ match: { since: '-5m', alertname: 'X' } }).ok).toBe(false);
    expect(validateClaimRule({ match: { newerThan: '1h' } }).ok).toBe(false);
    expect(validateClaimRule({ match: { alertname: 'X' } }).ok).toBe(true);
    expect(validateClaimRule({ match: { labels: { team: 'infra' } } }).ok).toBe(true);

    // Behaviorally: the bad rule loads as NOTHING — its alert is counted noise while the
    // good rule keeps claiming.
    useClaimsFile([
      { match: { alertname: 'GoodAlert' } },
      { match: { alertname: 'TemporalAlert', labels: { startsAt: 'now-5m' } } },
    ]);
    const h = await makeHarness();
    try {
      const bad = await h.post(firing('TemporalAlert', { target: 'custom-service-a' }));
      expect(bad.body.noise).toBe(1);
      expect(bad.body.created).toBe(0);
      const good = await h.post(firing('GoodAlert', { target: 'custom-service-a' }));
      expect(good.body.created).toBe(1);
      expect(await h.service.listTickets()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('P3 guard key-hygiene-multi-alertname (spec guard 10, deferred half): a rule that can claim multiple alertnames MUST carry {alertname} in its key template; degenerate templates are rejected', () => {
    // Multi-name shapes without {alertname} → rejected.
    expect(validateClaimRule({ match: { labels: { team: 'infra' } }, incidentKey: '{target}' }).ok).toBe(false);
    expect(validateClaimRule({ match: { alertname: ['A', 'B'] }, incidentKey: '{target}' }).ok).toBe(false);
    // The same rules WITH {alertname} → fine (and the default template always carries it).
    expect(validateClaimRule({ match: { alertname: ['A', 'B'] }, incidentKey: '{alertname}::{target}' }).ok).toBe(true);
    expect(validateClaimRule({ match: { labels: { team: 'infra' } } }).ok).toBe(true);
    // A single-name rule may key on other identity fields.
    expect(validateClaimRule({ match: { alertname: 'DiskFull' }, incidentKey: '{alertname}::{labels.device}' }).ok).toBe(true);
    // Degenerate templates: constant keys, free-text fields, timestamps — all rejected.
    expect(validateClaimRule({ match: { alertname: 'A' }, incidentKey: 'constant-key' }).ok).toBe(false);
    expect(validateClaimRule({ match: { alertname: 'A' }, incidentKey: '{labels.summary}::{target}' }).ok).toBe(false);
    expect(validateClaimRule({ match: { alertname: 'A' }, incidentKey: '{alertname}::{labels.timestamp}' }).ok).toBe(false);
  });

  it('P3 guard claim-registry-routing: a rule\'s key template re-keys Stage A (two devices = two incidents where the default key would merge), its intake declaration applies, and the per-alert label still wins', async () => {
    useClaimsFile([
      { match: { alertname: 'DiskFull' }, incidentKey: '{alertname}::{labels.device}', intake: 'backlog' },
    ]);
    const h = await makeHarness();
    try {
      const first = await h.post(firing('DiskFull', { target: 'oshal-local-db', fingerprint: 'fp-disk-sda', extraLabels: { device: 'sda' } }));
      expect(first.body.created).toBe(1);
      const ticket = await onlyTicket(h.service);
      expect(incidentOf(ticket)!.key).toBe('DiskFull::sda'); // the RULE's template, not the default
      expect(ticket.status).toBe('backlog'); // the rule's intake declaration

      // Same alertname + same target but another device: the default {alertname}::{target}
      // key would CONSOLIDATE this into the first ticket — the per-rule key keeps it a
      // distinct incident (it lands as a same-target bundle member, not a refire).
      const second = await h.post(firing('DiskFull', { target: 'oshal-local-db', fingerprint: 'fp-disk-sdb', extraLabels: { device: 'sdb' } }));
      expect(second.body.consolidated).toBe(0);
      expect(second.body.bundled).toBe(1);

      // A refire of the SAME device consolidates onto its incident.
      const refire = await h.post(firing('DiskFull', { target: 'oshal-local-db', fingerprint: 'fp-disk-sda', extraLabels: { device: 'sda' } }));
      expect(refire.body.consolidated).toBe(1);

      // FR-B1 precedence: the SRE's per-alert intake label outranks the rule.
      const labeled = await h.post(firing('DiskFull', { target: 'custom-service-b', fingerprint: 'fp-disk-sdc', intake: 'auto', extraLabels: { device: 'sdc' } }));
      expect(labeled.body.created).toBe(1);
      const tickets = await h.service.listTickets();
      const sdc = tickets.find((t) => incidentOf(t)?.key === 'DiskFull::sdc')!;
      expect(sdc.status).toBe('approved');
    } finally {
      await h.close();
    }
  });

  it('P3 guard claim-root-filter-feeds-fr-d4: a rule\'s bundleHints.rootFilter overrides the deepest-dependency policy for incidents it opens (the api-down drill roots on the filtered target)', async () => {
    useClaimsFile([
      {
        match: { alertname: ['SwarmApiUnreachable', 'SwarmContainerDown', 'SwarmContainerRestartLoop'] },
        incidentKey: '{alertname}::{target}',
        bundleHints: { rootFilter: ['oshal-local-email-bot'] },
      },
    ]);
    const h = await makeHarness();
    try {
      await h.post(firing('SwarmApiUnreachable', { target: 'oshal-local-api', severity: 'critical' }));
      await h.post(firing('SwarmContainerDown', { target: 'oshal-local-api', severity: 'critical' }));
      await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot' }));
      const incident = incidentOf(await onlyTicket(h.service))!;
      expect(incident.members).toHaveLength(3);
      // Without the per-rule filter the deepest-dependency step picks the api (the P2
      // guard proves that); the rule's ordered root filter must win instead.
      expect(incident.rootCandidate).toEqual({
        target: 'oshal-local-email-bot',
        reason: 'root-filter:oshal-local-email-bot',
      });
    } finally {
      await h.close();
    }
  });

  it('P3 guard unclaimed-policy (FR-B2): drop counts unclaimed alerts as per-alertname noise; backlog parks them as backlog tickets instead', async () => {
    // Default policy: drop → counted noise, no ticket (the P1 behavior, now registry-wide).
    process.env.ALERT_APPROVED_NAMES = 'KnownAlert';
    let h = await makeHarness();
    try {
      const res = await h.post(firing('MysteryAlert', { target: 'custom-service-a' }));
      expect(res.body.noise).toBe(1);
      expect(res.body.created).toBe(0);
      expect(await h.service.listTickets()).toHaveLength(0);
      const stats = await h.getStats();
      expect((stats.body.stats as { noiseByAlertname: Record<string, number> }).noiseByAlertname).toEqual({ MysteryAlert: 1 });
    } finally {
      await h.close();
    }

    // The cautious migration setting: unclaimed parks in backlog — visible work, no noise drop.
    process.env.ALERT_UNCLAIMED_POLICY = 'backlog';
    h = await makeHarness();
    try {
      const res = await h.post(firing('MysteryAlert', { target: 'custom-service-a' }));
      expect(res.body.created).toBe(1);
      expect(res.body.backlogged).toBe(1);
      expect(res.body.noise).toBe(0);
      const ticket = await onlyTicket(h.service);
      expect(ticket.status).toBe('backlog');
    } finally {
      await h.close();
    }
  });
});
