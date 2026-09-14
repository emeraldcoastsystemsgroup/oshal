/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BUG-20 guard: working one landed alert event twice must change the world once. The claim transaction rolls back after the handler's pool writes committed (the claiming connection fails on its decide and fail-event writes, as a lost connection does), the event returns to pending, and the next drain works it again. Real receiver, real disposable migrated PostgreSQL; asserts the incident occurrence, the member occurrence, the dispatch rows, the ticket and the event's decision are those of ONE delivery, and that a genuinely new delivery of the same alert still counts.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => {
  const spies = {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child: vi.fn(),
  };
  spies.child.mockReturnValue(spies);
  return spies;
});
vi.mock('@/shared/logger', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => logSpies,
}));

import { createAlertmanagerRoutes } from '@/app/routes/alertmanager-routes';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';

const database = new DisposableAlertPostgres();
const TOKEN = 'replay-idempotency-spec-token';
const RUN = `rpl-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const ALERTNAME = 'SwarmContainerDown';
const TICKET_TYPE = 'intelligent-processing';

/** The claim's decide-event and fail-event writes: the two statements a lost connection breaks. */
const CLAIM_WRITE = /^\s*UPDATE oshal_alert_event\s+SET\s+(claim_decision|attempts)/;

/** While true, the claiming connection loses its decide and fail-event writes. */
let claimConnectionLost = false;
let realPool: Pool;
let server: Server;
let baseUrl: string;
let ticketService: TicketService;

/**
 * @description A checked-out connection that behaves like one whose socket died after the handler
 * ran: the decide and fail-event writes throw the driver's lost-connection error. ROLLBACK still
 * reaches the server, which is exactly the state a dead backend leaves — the claim is released and
 * the event is pending again, while everything the handler wrote on OTHER connections stays.
 * @param client - A real pooled connection.
 * @returns The connection, with the two claim writes failing while the fault is armed.
 */
function faultableClient(client: PoolClient): PoolClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (sql: unknown, values?: unknown[]) => {
          if (claimConnectionLost && typeof sql === 'string' && CLAIM_WRITE.test(sql)) {
            return Promise.reject(new Error('Connection terminated unexpectedly'));
          }
          return target.query(sql as string, values);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * @description The receiver's pool: the real disposable pool, whose checked-out connections can
 * lose their claim writes. Every statement still executes on the real database.
 * @param real - The disposable pool.
 * @returns A pool the receiver cannot tell apart from the real one.
 */
function faultablePool(real: Pool): Pool {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async () => faultableClient(await target.connect());
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Posts one delivery. An empty `alerts` array is a real, legitimate delivery that only drains. */
async function postDelivery(alerts: unknown[]): Promise<Response> {
  return fetch(`${baseUrl}/api/alerts/alertmanager`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ receiver: 'oshal-incident-intake', status: 'firing', alerts }),
  });
}

/** One firing alert for `target`, in Alertmanager wire shape. */
function firing(target: string): Record<string, unknown> {
  return {
    status: 'firing',
    labels: { alertname: ALERTNAME, container: target, severity: 'critical' },
    annotations: { summary: `${target} is down` },
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    fingerprint: `${target}-fp`,
  };
}

/** Polls until `ready` holds, failing loudly rather than hanging. */
async function waitFor(label: string, ready: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (await ready()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** How many of this target's events the drain has decided. */
async function decidedEvents(target: string): Promise<number> {
  const { rows } = await realPool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM oshal_alert_event WHERE target = $1 AND processed_at IS NOT NULL', [target]);
  return rows[0].n;
}

/** Whether the drain rolled its claim back (logged after the ROLLBACK ran). */
function drainRolledBack(): boolean {
  return logSpies.error.mock.calls.some(([, message]) => /Pending-event drain failed/.test(String(message)));
}

/** Everything one target's deliveries left in the database and the ticket store. */
async function worldFor(target: string) {
  const incidents = await realPool.query(
    'SELECT incident_id, occurrence_count::int AS occurrences, ticket_id FROM oshal_incident WHERE primary_target = $1',
    [target]);
  const members = await realPool.query(
    `SELECT m.occurrence_count::int AS occurrences FROM oshal_incident_member m
       JOIN oshal_incident i ON i.incident_id = m.incident_id WHERE i.primary_target = $1`, [target]);
  const dispatches = await realPool.query(
    `SELECT d.action FROM oshal_alert_dispatch d
       JOIN oshal_incident i ON i.incident_id = d.incident_id WHERE i.primary_target = $1 ORDER BY d.dispatch_id`,
    [target]);
  const events = await realPool.query(
    `SELECT claim_decision, attempts::int AS attempts, incident_id, processed_at
       FROM oshal_alert_event WHERE target = $1 ORDER BY received_at, event_id`, [target]);
  const tickets = (await ticketService.listTickets({ ticketType: TICKET_TYPE, limit: 500 }))
    .filter((ticket) => (ticket.metadata as Record<string, unknown>).target === target);
  return {
    incidents: incidents.rows,
    memberOccurrences: members.rows.map((row) => row.occurrences as number),
    dispatchActions: dispatches.rows.map((row) => row.action as string),
    events: events.rows,
    tickets,
  };
}

beforeAll(async () => {
  vi.stubEnv('ALERT_WEBHOOK_TOKEN', TOKEN);
  vi.stubEnv('ALERT_APPROVED_NAMES', ALERTNAME);
  for (const key of ['ALERT_WEBHOOK_HMAC_SECRET', 'ALERT_CLAIMS_FILE', 'ALERT_BACKLOG_NAMES']) vi.stubEnv(key, '');
  vi.stubEnv('ALERT_DEFAULT_INTAKE', 'backlog');
  vi.stubEnv('ALERT_TICKET_TYPE', TICKET_TYPE);
  realPool = await database.start();
  ticketService = new TicketService(new InMemoryTicketStore());
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', createAlertmanagerRoutes(ticketService, { pool: faultablePool(realPool), startPendingSweep: false }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 90_000);

afterAll(async () => {
  try { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); }
  finally { await database.stop(); vi.unstubAllEnvs(); }
}, 60_000);

beforeEach(() => {
  claimConnectionLost = false;
  logSpies.error.mockClear();
});

describe('a landed alert event worked twice changes the world once (BUG-20)', { timeout: 60_000 }, () => {
  it('re-draining an event whose claim rolled back after the handler wrote leaves one delivery of state', async () => {
    const target = `${RUN}-replayed-container`;
    claimConnectionLost = true;
    expect((await postDelivery([firing(target)])).status).toBe(202);
    await waitFor('the first drain to roll its claim back', drainRolledBack);

    // The precondition the defect needs: the claim is gone, the pool writes are not.
    const afterFault = await worldFor(target);
    expect(afterFault.events).toHaveLength(1);
    expect(afterFault.events[0]).toMatchObject({ claim_decision: 'pending', attempts: 0, processed_at: null });
    expect(afterFault.incidents).toHaveLength(1);
    expect(afterFault.tickets).toHaveLength(1);

    claimConnectionLost = false;
    expect((await postDelivery([])).status).toBe(202);
    await waitFor('the re-drain to decide the event', async () => (await decidedEvents(target)) === 1);

    const world = await worldFor(target);
    expect(world.incidents, 'one incident for one delivery').toHaveLength(1);
    expect(world.incidents[0].occurrences, 'occurrence_count counted the replay as a second delivery').toBe(1);
    expect(world.memberOccurrences, 'the member counted the replay as a second delivery').toEqual([1]);
    expect(world.dispatchActions, 'the replay wrote a second dispatch decision').toEqual(['create']);
    expect(world.tickets, 'the replay opened a second ticket').toHaveLength(1);
    const incident = (world.tickets[0].metadata as { incident?: { updateCount?: number } }).incident;
    expect(incident?.updateCount, 'the replay was applied to the ticket as a refire').toBe(0);
    expect(world.events[0]).toMatchObject({ claim_decision: 'created', incident_id: world.incidents[0].incident_id });
    expect(world.incidents[0].ticket_id).toBe(world.tickets[0].ticketId);
  });

  it('a genuinely new delivery of the same alert still counts, exactly as before', async () => {
    const target = `${RUN}-repeated-container`;
    expect((await postDelivery([firing(target)])).status).toBe(202);
    await waitFor('the first delivery to be decided', async () => (await decidedEvents(target)) === 1);
    const first = await worldFor(target);
    expect(first.incidents[0].occurrences).toBe(1);
    expect(first.memberOccurrences).toEqual([1]);
    expect(first.dispatchActions).toEqual(['create']);

    expect((await postDelivery([firing(target)])).status).toBe(202);
    await waitFor('the repeat delivery to be decided', async () => (await decidedEvents(target)) === 2);
    const world = await worldFor(target);
    expect(world.incidents).toHaveLength(1);
    expect(world.incidents[0].occurrences).toBe(2);
    expect(world.memberOccurrences).toEqual([2]);
    expect(world.dispatchActions).toEqual(['create', 'update']);
    expect(world.tickets).toHaveLength(1);
    expect(world.events.map((event) => event.claim_decision)).toEqual(['created', 'consolidated']);
  });
});
