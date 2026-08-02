/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard for durable alert landing: a delivery is stored and expanded BEFORE anything interprets it (proven by call ordering against the ticket write, not by inspecting the response text), a landing that throws answers a non-2xx so Alertmanager redelivers and cuts no ticket, a landing that fails mid-write rolls back and still refuses to acknowledge, a committed landing answers 202 carrying the envelope id and the expanded event count, the landed events drive the consolidation to a real ticket and each one is stamped with its durable decision, an event whose intake fails records an attempt instead of vanishing, a body that is not an envelope is parked as an ingest deadletter and answered 400, and a receiver wired without a database keeps the in-memory response contract. The database is a faithful stand-in for the four pipeline tables — statements are dispatched by shape and pending rows are handed out once, the way SKIP LOCKED hands them out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { createAlertmanagerRoutes } from '@/app/routes/alertmanager-routes';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';

const TOKEN = 'landing-durability-token';
const ALERT_ENV_KEYS = [
  'ALERT_WEBHOOK_TOKEN',
  'ALERT_WEBHOOK_HMAC_SECRET',
  'ALERT_APPROVED_NAMES',
  'ALERT_BACKLOG_NAMES',
  'ALERT_DEFAULT_INTAKE',
  'ALERT_TICKET_TYPE',
  'ALERT_CLAIMS_FILE',
  'ALERT_UNCLAIMED_POLICY',
];
const savedEnv = new Map<string, string | undefined>();

/** The statement shapes the pipeline issues. A shape outside this set is a contract change. */
type SqlKind =
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'insert-envelope'
  | 'insert-event'
  | 'update-envelope'
  | 'select-pending'
  | 'decide-event'
  | 'fail-event'
  | 'insert-deadletter'
  | 'other';

/** The `oshal_alert_event` columns in the exact order the insert binds them. */
const EVENT_INSERT_COLUMNS = [
  'envelope_id', 'received_at', 'source', 'fingerprint', 'alertname', 'target', 'target_kind',
  'severity', 'severity_num', 'status', 'started_at', 'ended_at', 'generator_url',
  'labels', 'annotations', 'summary', 'namespace', 'container', 'instance', 'job',
  'envelope_group_key', 'receiver', 'owner_sub',
] as const;

/** Bind positions in the deadletter insert. */
const DEADLETTER_STAGE = 0;

/** Bind positions in the decide-event update. */
const DECIDE_EVENT_ID = 0;
const DECIDE_DECISION = 1;

/**
 * Classifies a statement by its shape. The fake has to answer different statements differently,
 * exactly as the tables do; nothing in the assertions depends on this mapping.
 */
function classify(sql: string): SqlKind {
  const s = sql.replace(/\s+/g, ' ').trim().toUpperCase();
  if (s.startsWith('BEGIN')) return 'begin';
  if (s.startsWith('COMMIT')) return 'commit';
  if (s.startsWith('ROLLBACK')) return 'rollback';
  if (s.startsWith('INSERT INTO OSHAL_ALERT_ENVELOPE')) return 'insert-envelope';
  if (s.startsWith('INSERT INTO OSHAL_ALERT_EVENT')) return 'insert-event';
  if (s.startsWith('INSERT INTO OSHAL_ALERT_DEADLETTER')) return 'insert-deadletter';
  if (s.startsWith('UPDATE OSHAL_ALERT_ENVELOPE')) return 'update-envelope';
  if (s.startsWith('SELECT') && s.includes('OSHAL_ALERT_EVENT')) return 'select-pending';
  if (s.startsWith('UPDATE OSHAL_ALERT_EVENT')) {
    return s.includes('ATTEMPTS = ATTEMPTS + 1') ? 'fail-event' : 'decide-event';
  }
  return 'other';
}

/** Builds the stored event row from the values the insert bound, plus the table's own defaults. */
function storedEventRow(eventId: string, params: unknown[]): Record<string, unknown> {
  const bound: Record<string, unknown> = {};
  EVENT_INSERT_COLUMNS.forEach((column, index) => { bound[column] = params[index] ?? null; });
  return {
    ...bound,
    labels: JSON.parse(String(bound.labels ?? '{}')),
    annotations: JSON.parse(String(bound.annotations ?? '{}')),
    event_id: eventId,
    dedup_key: null,
    identity_source: null,
    used_fingerprint_fallback: false,
    claim_decision: 'pending',
    claimed_by_rule: null,
    unclaimed_reason: null,
    incident_id: null,
    attempts: 0,
    last_error: null,
    processed_at: null,
  };
}

/**
 * A stand-in for the pipeline tables. Records every statement it is asked to run, hands each
 * pending row out exactly once (the property SKIP LOCKED gives the real queue), and can be told
 * to fail on connect or on the envelope write.
 */
class FakeAlertDatabase {
  readonly statements: Array<{ kind: SqlKind; params: unknown[] }> = [];
  connectError: Error | null = null;
  envelopeWriteError: Error | null = null;
  onEnvelopeCommitted: (() => void) | null = null;

  private envelopeCount = 0;
  private eventCount = 0;
  private readonly pending: Array<Record<string, unknown>> = [];

  readonly pool: Pool;

  constructor() {
    const run = (sql: string, params?: unknown[]) => this.run(sql, params ?? []);
    this.pool = {
      connect: async () => {
        if (this.connectError) throw this.connectError;
        return { query: run, release: () => undefined };
      },
      query: run,
    } as unknown as Pool;
  }

  /** Every statement of one shape, in the order it was issued. */
  paramsFor(kind: SqlKind): unknown[][] {
    return this.statements.filter((s) => s.kind === kind).map((s) => s.params);
  }

  /** How many statements of one shape were issued. */
  countOf(kind: SqlKind): number {
    return this.statements.filter((s) => s.kind === kind).length;
  }

  private async run(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    const kind = classify(sql);
    this.statements.push({ kind, params });
    switch (kind) {
      case 'insert-envelope': {
        if (this.envelopeWriteError) throw this.envelopeWriteError;
        this.envelopeCount += 1;
        return rows([{ envelope_id: `env-${this.envelopeCount}`, received_at: new Date('2026-08-01T10:00:00.000Z') }]);
      }
      case 'insert-event': {
        this.eventCount += 1;
        const eventId = `evt-${this.eventCount}`;
        this.pending.push(storedEventRow(eventId, params));
        return rows([{ event_id: eventId }]);
      }
      case 'commit': {
        this.onEnvelopeCommitted?.();
        return rows([]);
      }
      case 'select-pending': {
        const limit = Number(params[0] ?? 1);
        return rows(this.pending.splice(0, Number.isFinite(limit) ? limit : 1));
      }
      case 'fail-event':
        return rows([{ attempts: 1, claim_decision: 'pending', source: 'alertmanager', alertname: '', target: '', fingerprint: '' }]);
      default:
        return rows([]);
    }
  }
}

/** Wraps rows in the pg result shape. */
function rows(list: unknown[]): { rows: unknown[]; rowCount: number } {
  return { rows: list, rowCount: list.length };
}

interface Harness {
  service: TicketService;
  db: FakeAlertDatabase;
  /** Ordered log of the two things whose sequence is the durability claim. */
  order: string[];
  post(payload: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** Boots the real router over the real consolidation service, with or without a landing database. */
async function makeHarness(options: { withDatabase: boolean } = { withDatabase: true }): Promise<Harness> {
  const service = new TicketService(new InMemoryTicketStore());
  const db = new FakeAlertDatabase();
  const order: string[] = [];

  db.onEnvelopeCommitted = () => { if (!order.includes('landed')) order.push('landed'); };
  const createTicket = service.createTicket.bind(service);
  vi.spyOn(service, 'createTicket').mockImplementation(async (input) => {
    order.push('ticket');
    return createTicket(input);
  });

  const app = express();
  app.use(express.json());
  app.use('/api/alerts', createAlertmanagerRoutes(service, options.withDatabase ? { pool: db.pool } : {}));
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    service,
    db,
    order,
    post: async (payload: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/alerts/alertmanager`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(payload),
      });
      const raw = await res.text();
      let parsed: Record<string, unknown> = {};
      try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { parsed = {}; }
      return { status: res.status, body: parsed };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** One firing alert in Alertmanager v4 wire shape. */
function firing(alertname: string, target = 'oshal-local-api'): Record<string, unknown> {
  return {
    status: 'firing',
    labels: { alertname, container: target, severity: 'critical' },
    annotations: { summary: `${alertname} on ${target}` },
    startsAt: '2026-08-01T09:59:00.000Z',
    fingerprint: `fp-${alertname}-${target}`,
  };
}

/** Waits for a condition the drain reaches asynchronously, failing loudly instead of hanging. */
async function waitFor(label: string, ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
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

describe('durable alert landing', () => {
  it('answers a non-2xx and cuts no ticket when the landing throws, so the sender redelivers', async () => {
    const h = await makeHarness();
    try {
      h.db.connectError = new Error('landing database unreachable');

      const res = await h.post({ alerts: [firing('SwarmContainerDown')] });

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(h.order).toEqual([]);
      expect(h.service.createTicket).not.toHaveBeenCalled();
      expect(await h.service.listTickets()).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('rolls back and still refuses to acknowledge when the delivery fails mid-write', async () => {
    const h = await makeHarness();
    try {
      h.db.envelopeWriteError = new Error('envelope write rejected');

      const res = await h.post({ alerts: [firing('SwarmContainerDown')] });

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(h.db.countOf('rollback')).toBe(1);
      expect(h.db.countOf('commit')).toBe(0);
      expect(h.db.countOf('insert-event')).toBe(0);
      expect(h.service.createTicket).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('answers 202 with the envelope it stored and the number of events it expanded', async () => {
    const h = await makeHarness();
    try {
      const res = await h.post({
        alerts: [firing('SwarmContainerDown'), firing('SwarmContainerUnhealthy', 'oshal-local-db')],
      });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.envelopeId).toBe('env-1');
      expect(res.body.events).toBe(2);
      expect(h.db.countOf('insert-event')).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('stores the delivery before anything interprets it: the envelope commits ahead of the first ticket write', async () => {
    const h = await makeHarness();
    try {
      await h.post({ alerts: [firing('SwarmContainerDown')] });
      await waitFor('the ticket write', () => h.order.includes('ticket'));

      expect(h.order[0]).toBe('landed');
      expect(h.order.indexOf('landed')).toBeLessThan(h.order.indexOf('ticket'));
    } finally {
      await h.close();
    }
  });

  it('works the landed events through the consolidation and stamps each one with its decision', async () => {
    const h = await makeHarness();
    try {
      await h.post({
        alerts: [firing('SwarmContainerDown'), firing('SwarmContainerUnhealthy', 'oshal-local-db')],
      });
      await waitFor('both events to be decided', () => h.db.countOf('decide-event') === 2);

      expect(await h.service.listTickets()).toHaveLength(2);
      const decisions = h.db.paramsFor('decide-event');
      expect(decisions.map((p) => p[DECIDE_DECISION])).toEqual(['created', 'created']);
      expect(decisions.map((p) => p[DECIDE_EVENT_ID])).toEqual(['evt-1', 'evt-2']);
      expect(h.db.countOf('fail-event')).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('records an attempt instead of losing the event when the intake fails, and still acknowledges the delivery', async () => {
    const h = await makeHarness();
    try {
      vi.spyOn(h.service, 'createTicket').mockRejectedValue(new Error('ticket queue unavailable'));

      const res = await h.post({ alerts: [firing('SwarmContainerDown')] });
      await waitFor('the failed attempt to be recorded', () => h.db.countOf('fail-event') === 1);

      expect(res.status).toBe(202);
      expect(h.db.countOf('decide-event')).toBe(0);
      expect(h.db.countOf('insert-event')).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('parks a body that is not an envelope as an ingest deadletter and answers 400', async () => {
    const h = await makeHarness();
    try {
      const res = await h.post({ notAnEnvelope: true });

      expect(res.status).toBe(400);
      expect(h.db.countOf('insert-envelope')).toBe(0);
      expect(h.db.countOf('insert-deadletter')).toBe(1);
      expect(h.db.paramsFor('insert-deadletter')[0][DEADLETTER_STAGE]).toBe('ingest');
      expect(h.service.createTicket).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it('keeps the in-memory response contract when no landing database is wired', async () => {
    const h = await makeHarness({ withDatabase: false });
    try {
      const res = await h.post({ alerts: [firing('SwarmContainerDown')] });

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(1);
      expect(res.body.envelopeId).toBeUndefined();
      expect(h.db.statements).toEqual([]);
      expect(await h.service.listTickets()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

describe('background sweep identity', () => {
  // The 5s straggler sweep is background work with no request in scope. Under
  // OSHAL_DB_GUC_STRICT=deny an unidentified connection is REFUSED, so an unwrapped sweep
  // claims nothing while the timer keeps firing and the logs stay busy — "retried on the next
  // tick" silently becomes "never retried". Observed on a live deploy; this pins the wrapper.
  it('claims pending events under a declared system identity', async () => {
    const identity = await import('@/shared/services/database/request-identity');
    const sysSpy = vi.spyOn(identity, 'runWithSystemIdentity');

    vi.useFakeTimers();
    let harness: Harness | undefined;
    try {
      harness = await makeHarness({ withDatabase: true });
      sysSpy.mockClear();
      const before = harness.db.countOf('select-pending');

      await vi.advanceTimersByTimeAsync(6000);

      // The sweep ran...
      expect(harness.db.countOf('select-pending')).toBeGreaterThan(before);
      // ...and it declared an identity rather than reaching the pool unidentified.
      expect(sysSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await harness?.close();
      sysSpy.mockRestore();
    }
  });
});
