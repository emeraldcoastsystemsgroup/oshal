/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The consolidation cutover guard: a delivery that reaches the intake must leave a durable oshal_incident row carrying the identity, pointing at the ticket it opened, and tallying a refire onto that same row instead of a second one. Before the cutover the incident lived only in the ticket's metadata blob, so every assertion here failed by returning nothing at all.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Isolate the intake in disposable migrated PostgreSQL; avoid a deployment queue consumer and close cleanly after failed setup.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAlertmanagerRoutes } from '@/app/routes/alertmanager-routes';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';

const database = new DisposableAlertPostgres();

const TOKEN = 'cutover-spec-token';
/** Unique per run so a parallel run and a leftover row can never be mistaken for this one's. */
const RUN = `cut-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const TARGET = `${RUN}-container`;
const ALERTNAME = 'SwarmContainerDown';

let pool: Pool;
let server: Server;
let baseUrl: string;
let ticketService: TicketService;

interface IncidentRowShape {
  incident_id: string;
  dedup_key: string;
  identity_source: string;
  state: string;
  occurrence_count: string;
  ticket_id: string | null;
  primary_target: string;
}

/** Posts one Alertmanager delivery carrying a single firing alert for this run's target. */
async function postAlert(): Promise<Response> {
  return fetch(`${baseUrl}/api/alerts/alertmanager`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      receiver: 'oshal-incident-intake',
      status: 'firing',
      groupKey: `{}:{alertname="${ALERTNAME}"}`,
      commonLabels: { severity: 'critical' },
      alerts: [
        {
          status: 'firing',
          labels: { alertname: ALERTNAME, container: TARGET, severity: 'critical', tier: 'worker' },
          annotations: { summary: `${TARGET} is down` },
          startsAt: new Date(Date.now() - 60_000).toISOString(),
          fingerprint: `${RUN}fp`,
        },
      ],
    }),
  });
}

/** Reads this run's incident rows. Empty means the cutover did not happen. */
async function incidentsForRun(): Promise<IncidentRowShape[]> {
  const { rows } = await pool.query<IncidentRowShape>(
    `SELECT incident_id, dedup_key, identity_source, state, occurrence_count, ticket_id, primary_target
       FROM oshal_incident WHERE primary_target = $1 ORDER BY instance_seq`,
    [TARGET],
  );
  return rows;
}

/** Wait for the drain transaction to commit, not merely for an intermediate incident write. */
async function settle(expectedEvents: number): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const result = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM oshal_alert_event WHERE target = $1 AND processed_at IS NOT NULL', [TARGET]);
    if (result.rows[0].n === expectedEvents) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Alert request drain did not finish ${expectedEvents} fixture events`);
}

beforeAll(async () => {
  vi.stubEnv('ALERT_WEBHOOK_TOKEN', TOKEN);
  vi.stubEnv('ALERT_APPROVED_NAMES', ALERTNAME);
  for (const key of ['ALERT_WEBHOOK_HMAC_SECRET', 'ALERT_CLAIMS_FILE', 'ALERT_BACKLOG_NAMES']) vi.stubEnv(key, '');
  vi.stubEnv('ALERT_DEFAULT_INTAKE', 'backlog');
  pool = await database.start();

  ticketService = new TicketService(new InMemoryTicketStore());
  const app = express();
  app.use(express.json());
  const interval = vi.spyOn(globalThis, 'setInterval');
  try {
    app.use('/api/alerts', createAlertmanagerRoutes(ticketService, { pool, startPendingSweep: false }));
    expect(interval).not.toHaveBeenCalled();
  } finally { interval.mockRestore(); }
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 90_000);

afterAll(async () => {
  try { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); }
  finally { await database.stop(); vi.unstubAllEnvs(); }
}, 60_000);

describe('consolidation cutover — the incident is a row, not a JSON blob', () => {
  it('writes a durable incident carrying the identity and pointing at the ticket', async () => {
    const res = await postAlert();
    expect(res.status).toBe(202);
    await settle(1);

    const rows = await incidentsForRun();
    // The whole point of the cutover: this is non-empty. Before it, the incident existed only
    // inside tickets.metadata and this query returned nothing.
    expect(rows).toHaveLength(1);

    const incident = rows[0];
    expect(incident.state).toBe('open');
    expect(incident.primary_target).toBe(TARGET);
    // The identity is a namespaced digest, and its pre-image is stored in readable form beside it
    // so a wrong key is diagnosable rather than opaque.
    expect(incident.dedup_key).toMatch(/^[a-z0-9._-]+:[0-9a-f]{32}$/);
    expect(incident.identity_source).toContain(TARGET);
    expect(incident.identity_source).toContain(ALERTNAME.toLowerCase());

    // The ticket stays the operator artifact and is LINKED, not duplicated.
    expect(incident.ticket_id).toBeTruthy();
    const ticket = await ticketService.getTicket(incident.ticket_id as string);
    expect(ticket).toBeTruthy();

    // And the event that produced it carries the same identity plus the back-reference.
    const { rows: events } = await pool.query<{ dedup_key: string | null; incident_id: string | null; claim_decision: string }>(
      'SELECT dedup_key, incident_id, claim_decision FROM oshal_alert_event WHERE target = $1',
      [TARGET],
    );
    expect(events).toHaveLength(1);
    expect(events[0].dedup_key).toBe(incident.dedup_key);
    expect(events[0].incident_id).toBe(incident.incident_id);
  }, 60_000);

  it('tallies a refire onto the SAME incident instead of opening a second one', async () => {
    const before = (await incidentsForRun())[0];
    expect(before).toBeTruthy();

    const res = await postAlert();
    expect(res.status).toBe(202);

    await settle(2);

    const rows = await incidentsForRun();
    // Still exactly one incident — the partial unique index is the guarantee, not a convention.
    expect(rows).toHaveLength(1);
    expect(rows[0].incident_id).toBe(before.incident_id);
    expect(Number(rows[0].occurrence_count)).toBeGreaterThan(Number(before.occurrence_count));
    // A refire never re-points the ticket.
    expect(rows[0].ticket_id).toBe(before.ticket_id);
  }, 60_000);
});
