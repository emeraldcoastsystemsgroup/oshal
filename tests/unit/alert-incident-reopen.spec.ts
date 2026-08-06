/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guards for the consolidation reopen rule, run against the real Postgres so the partial-unique live claim, the ON CONFLICT arms and the transactional recurrence are proven by the database rather than by a mock: arm A refire, arm B in-window reopen of the same row, arm C recurrence after an operator close and after a stale auto-close, upward-only severity escalation, membership-based resolution, optimistic-concurrency retries, and a concurrent burst producing exactly one live incident.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  IncidentStore,
  withRevisionRetry,
  type ConsolidateOptions,
} from '@/features/alert-pipeline/services/incident-store';
import type { AlertEventRow } from '@/features/alert-pipeline/services/alert-pipeline-types';

/**
 * The published Postgres of the local stack (docker-compose.oshal-local.yml maps
 * 127.0.0.1:${OSHAL_PG_PORT:-55433} to the container's 5432, user/password/db all `oshal`).
 * `ALERT_PIPELINE_TEST_DATABASE_URL` overrides it for a box whose `DATABASE_URL` points at the
 * in-network hostname, which is unreachable from the test runner.
 */
const CONNECTION_STRING =
  process.env.ALERT_PIPELINE_TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://oshal:oshal@127.0.0.1:55433/oshal';

/** Every row this run writes carries this prefix, so cleanup can never touch another run's data. */
const RUN_PREFIX = `zz-incident-reopen-${process.pid}-${Date.now()}-`;

const BASE_OPTIONS: ConsolidateOptions = {
  reopenWindowSeconds: 3600,
  claimRuleId: 'rule-reopen-guard',
  intakeStatus: 'backlog',
};

let pool: Pool;
let store: IncidentStore;
let sequence = 0;

/** Strip credentials before a connection string reaches an error message or a log line. */
function redact(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

/** A dedup identity unique to this run and this case. */
function nextKey(name: string): string {
  sequence += 1;
  return `${RUN_PREFIX}${name}-${sequence}`;
}

/** A normalized alert carrying the given identity; overrides shape the case under test. */
function makeEvent(dedupKey: string, overrides: Partial<AlertEventRow> = {}): AlertEventRow {
  const now = new Date();
  return {
    eventId: '00000000-0000-0000-0000-000000000000',
    envelopeId: null,
    receivedAt: now,
    source: 'alertmanager',
    fingerprint: 'fp-reopen-guard',
    alertname: 'ReopenGuardProbe',
    target: 'probe-target',
    targetKind: 'container',
    severity: 'warning',
    severityNum: 3,
    status: 'firing',
    startedAt: now,
    endedAt: null,
    generatorUrl: null,
    labels: {},
    annotations: {},
    summary: null,
    namespace: null,
    container: null,
    instance: null,
    job: null,
    envelopeGroupKey: null,
    receiver: null,
    dedupKey,
    identitySource: 'target+alertname',
    usedFingerprintFallback: false,
    claimDecision: 'pending',
    claimedByRule: 'rule-reopen-guard',
    unclaimedReason: null,
    incidentId: null,
    attempts: 0,
    lastError: null,
    processedAt: null,
    ...overrides,
  };
}

/** Drive an incident into a terminal state the way the close path would, at a chosen age. */
async function closeOut(
  incidentId: string,
  state: 'resolved' | 'closed',
  closedBy: 'auto' | 'operator' | 'ticket',
  ageSeconds = 0,
): Promise<void> {
  await pool.query(
    `UPDATE oshal_incident
        SET state = $2,
            closed_by = $3,
            closed_at = now() - make_interval(secs => $4::double precision),
            resolved_at = now() - make_interval(secs => $4::double precision)
      WHERE incident_id = $1`,
    [incidentId, state, closedBy, ageSeconds],
  );
}

/** The raw state of a row, read past the store so the assertion is about the database. */
async function readState(incidentId: string): Promise<string | null> {
  const result = await pool.query('SELECT state FROM oshal_incident WHERE incident_id = $1', [incidentId]);
  return result.rows.length > 0 ? (result.rows[0].state as string) : null;
}

/** How many rows exist for an identity, and how many of them hold the live slot. */
async function countRows(dedupKey: string): Promise<{ total: number; live: number }> {
  const result = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE state IN ('open', 'resolved'))::int AS live
       FROM oshal_incident WHERE dedup_key = $1`,
    [dedupKey],
  );
  return { total: result.rows[0].total as number, live: result.rows[0].live as number };
}

beforeAll(async () => {
  // `options` sets row_security on the startup packet, so every pooled connection carries it and
  // no per-connection hook can be missed.
  pool = new Pool({
    connectionString: CONNECTION_STRING,
    options: '-c row_security=off',
    max: 12,
    connectionTimeoutMillis: 5000,
  });
  try {
    const probe = await pool.query(
      `SELECT to_regclass('public.oshal_incident') AS incident,
              to_regclass('public.oshal_incident_member') AS member`,
    );
    if (!probe.rows[0].incident || !probe.rows[0].member) {
      throw new Error('oshal_incident / oshal_incident_member are absent — apply scripts/migrations/104-108');
    }
  } catch (error) {
    throw new Error(
      `alert-incident-reopen requires the live Postgres at ${redact(CONNECTION_STRING)}. `
        + 'Bring the stack up with scripts/oshal-up.sh, or point ALERT_PIPELINE_TEST_DATABASE_URL at a '
        + `database with migrations 104-108 applied. Underlying failure: ${(error as Error).message}`,
    );
  }
  store = new IncidentStore(pool);
});

afterAll(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM oshal_incident WHERE dedup_key LIKE $1', [`${RUN_PREFIX}%`]);
  await pool.end();
});

// Drives a REAL Postgres through the three-arm reopen rule; connection acquisition under
// full-suite contention can exceed Vitest's five-second default. Bounded budget, no assertion relaxed.
describe('IncidentStore.consolidate — the three-arm reopen rule', { timeout: 45_000 }, () => {
  it('arm A: a refire of a live incident advances the counters and touches neither state nor ticket', async () => {
    const key = nextKey('arm-a');
    const first = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    expect(first.wasCreated).toBe(true);
    expect(first.wasReopened).toBe(false);
    expect(first.wasRecurrence).toBe(false);
    expect(first.incident.occurrenceCount).toBe(1);
    expect(first.incident.instanceSeq).toBe(1);

    const ticketed = await store.updateIncident(first.incident.incidentId, first.incident.revision, {
      ticketId: 'TCK-ARM-A',
      intakeStatus: 'auto',
    });
    expect(ticketed?.ticketId).toBe('TCK-ARM-A');

    const refire = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    expect(refire.incident.incidentId).toBe(first.incident.incidentId);
    expect(refire.wasCreated).toBe(false);
    expect(refire.wasReopened).toBe(false);
    expect(refire.wasRecurrence).toBe(false);
    expect(refire.incident.occurrenceCount).toBe(2);
    expect(refire.incident.state).toBe('open');
    expect(refire.incident.ticketId).toBe('TCK-ARM-A');
    expect(refire.incident.intakeStatus).toBe('auto');
    expect(refire.incident.reopenCount).toBe(0);
    expect(await countRows(key)).toEqual({ total: 1, live: 1 });
  });

  it('arm B: a refire inside the reopen window reopens the SAME row and clears the close', async () => {
    const key = nextKey('arm-b');
    const first = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    await closeOut(first.incident.incidentId, 'resolved', 'auto');

    const reopened = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    expect(reopened.incident.incidentId).toBe(first.incident.incidentId);
    expect(reopened.wasReopened).toBe(true);
    expect(reopened.wasCreated).toBe(false);
    expect(reopened.wasRecurrence).toBe(false);
    expect(reopened.incident.state).toBe('open');
    expect(reopened.incident.reopenCount).toBe(1);
    expect(reopened.incident.closedAt).toBeNull();
    expect(reopened.incident.closedBy).toBeNull();
    expect(reopened.incident.resolvedAt).toBeNull();
    expect(reopened.incident.reopenedAt).not.toBeNull();
    expect(reopened.incident.occurrenceCount).toBe(2);
    expect(await countRows(key)).toEqual({ total: 1, live: 1 });

    // The reopen is counted once. A further refire is arm A again.
    const refire = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    expect(refire.wasReopened).toBe(false);
    expect(refire.incident.reopenCount).toBe(1);
    expect(refire.incident.occurrenceCount).toBe(3);
  });

  it('arm B: a closed incident inside the window reopens in place rather than recurring', async () => {
    const key = nextKey('arm-b-closed');
    const first = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    await closeOut(first.incident.incidentId, 'closed', 'auto', 30);

    const reopened = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    expect(reopened.incident.incidentId).toBe(first.incident.incidentId);
    expect(reopened.wasReopened).toBe(true);
    expect(reopened.wasCreated).toBe(false);
    expect(reopened.incident.state).toBe('open');
    expect(reopened.incident.reopenCount).toBe(1);
    expect(reopened.incident.closedAt).toBeNull();
    expect(reopened.incident.instanceSeq).toBe(1);
    expect(await countRows(key)).toEqual({ total: 1, live: 1 });
  });

  it('arm C: an operator close is never undone — the old row archives and a new instance opens', async () => {
    const key = nextKey('arm-c-operator');
    const first = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    await closeOut(first.incident.incidentId, 'closed', 'operator');

    const recurrence = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    expect(recurrence.wasCreated).toBe(true);
    expect(recurrence.wasRecurrence).toBe(true);
    expect(recurrence.wasReopened).toBe(false);
    expect(recurrence.incident.incidentId).not.toBe(first.incident.incidentId);
    expect(recurrence.incident.instanceSeq).toBe(2);
    expect(recurrence.incident.recurrenceOf).toBe(first.incident.incidentId);
    expect(recurrence.incident.reopenCount).toBe(0);
    expect(recurrence.incident.occurrenceCount).toBe(1);
    expect(await readState(first.incident.incidentId)).toBe('archived');
    expect(await countRows(key)).toEqual({ total: 2, live: 1 });
  });

  it('arm C: an auto close older than the reopen window recurs instead of reopening', async () => {
    const key = nextKey('arm-c-stale');
    const first = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    await closeOut(first.incident.incidentId, 'closed', 'auto', 7200);

    const recurrence = await store.consolidate(makeEvent(key), { ...BASE_OPTIONS, reopenWindowSeconds: 60 });
    expect(recurrence.wasCreated).toBe(true);
    expect(recurrence.wasRecurrence).toBe(true);
    expect(recurrence.incident.incidentId).not.toBe(first.incident.incidentId);
    expect(recurrence.incident.instanceSeq).toBe(2);
    expect(recurrence.incident.recurrenceOf).toBe(first.incident.incidentId);
    expect(await readState(first.incident.incidentId)).toBe('archived');
    expect(await countRows(key)).toEqual({ total: 2, live: 1 });
  });

  it('arm C: a STILL-LIVE resolved row outside the window is refused by the upsert gate and recurs', async () => {
    const key = nextKey('arm-c-live-stale');
    const first = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    // state stays 'resolved', so the row still holds the live slot the upsert would conflict with.
    await closeOut(first.incident.incidentId, 'resolved', 'auto', 7200);

    const recurrence = await store.consolidate(makeEvent(key), { ...BASE_OPTIONS, reopenWindowSeconds: 60 });
    expect(recurrence.wasRecurrence).toBe(true);
    expect(recurrence.incident.instanceSeq).toBe(2);
    expect(recurrence.incident.recurrenceOf).toBe(first.incident.incidentId);
    expect(await readState(first.incident.incidentId)).toBe('archived');
    expect(await countRows(key)).toEqual({ total: 2, live: 1 });
  });

  it('severity escalates upward only — a lower-severity refire never de-escalates the incident', async () => {
    const key = nextKey('severity');
    const opened = await store.consolidate(makeEvent(key, { severity: 'warning', severityNum: 3 }), BASE_OPTIONS);
    expect(opened.incident.severity).toBe('warning');
    expect(opened.incident.severityNum).toBe(3);

    const escalated = await store.consolidate(makeEvent(key, { severity: 'critical', severityNum: 1 }), BASE_OPTIONS);
    expect(escalated.incident.severity).toBe('critical');
    expect(escalated.incident.severityNum).toBe(1);

    const quiet = await store.consolidate(makeEvent(key, { severity: 'info', severityNum: 4 }), BASE_OPTIONS);
    expect(quiet.incident.severity).toBe('critical');
    expect(quiet.incident.severityNum).toBe(1);
    expect(quiet.incident.occurrenceCount).toBe(3);
  });

  it('a concurrent burst on one identity produces exactly ONE live incident', async () => {
    const key = nextKey('burst');
    const burst = 8;
    const outcomes = await Promise.all(
      Array.from({ length: burst }, () => store.consolidate(makeEvent(key), BASE_OPTIONS)),
    );

    expect(await countRows(key)).toEqual({ total: 1, live: 1 });
    expect(outcomes.filter((outcome) => outcome.wasCreated)).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.incident.incidentId)).size).toBe(1);

    const settled = await store.findLive(key);
    expect(settled?.state).toBe('open');
    expect(settled?.occurrenceCount).toBe(burst);
  });
});

describe('IncidentStore — membership, listing and optimistic concurrency', { timeout: 45_000 }, () => {
  it('resolution is provable only from recorded members with no overflow', async () => {
    const key = nextKey('members');
    const { incident } = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    const id = incident.incidentId;

    // Nothing recorded yet: there is no evidence to resolve on.
    expect(await store.allMembersResolved(id)).toBe(false);

    await store.upsertMember(id, { memberKey: 'probe-target', attachReason: 'genesis' });
    await store.upsertMember(id, { memberKey: 'sidecar-target', attachReason: 'same-target' });
    expect(await store.allMembersResolved(id)).toBe(false);

    await store.markMemberResolved(id, 'probe-target', new Date());
    expect(await store.allMembersResolved(id)).toBe(false);
    await store.markMemberResolved(id, 'sidecar-target', new Date());
    expect(await store.allMembersResolved(id)).toBe(true);

    // A refire un-resolves the member it refires.
    await store.upsertMember(id, { memberKey: 'sidecar-target', attachReason: 'same-target' });
    expect(await store.allMembersResolved(id)).toBe(false);
    const member = await pool.query(
      'SELECT occurrence_count, resolved_at FROM oshal_incident_member WHERE incident_id = $1 AND member_key = $2',
      [id, 'sidecar-target'],
    );
    expect(Number(member.rows[0].occurrence_count)).toBe(2);
    expect(member.rows[0].resolved_at).toBeNull();

    // Members counted but never written down make full resolution unprovable.
    await store.markMemberResolved(id, 'sidecar-target', new Date());
    expect(await store.allMembersResolved(id)).toBe(true);
    await pool.query('UPDATE oshal_incident SET members_overflow = 3 WHERE incident_id = $1', [id]);
    expect(await store.allMembersResolved(id)).toBe(false);
  });

  it('listOpen returns recent open incidents and excludes archived instances', async () => {
    const key = nextKey('list-open');
    const first = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    await closeOut(first.incident.incidentId, 'closed', 'operator');
    const recurrence = await store.consolidate(makeEvent(key), BASE_OPTIONS);

    const listed = await store.listOpen(3600, 500);
    const ids = listed.map((row) => row.incidentId);
    expect(ids).toContain(recurrence.incident.incidentId);
    expect(ids).not.toContain(first.incident.incidentId);
  });

  it('updateIncident refuses a stale revision, and withRevisionRetry lands the write', async () => {
    const key = nextKey('revision');
    const { incident } = await store.consolidate(makeEvent(key), BASE_OPTIONS);
    const staleRevision = incident.revision;

    const applied = await store.updateIncident(incident.incidentId, staleRevision, { intakeStatus: 'auto' });
    expect(applied?.intakeStatus).toBe('auto');
    expect(applied?.revision).toBe(staleRevision + 1);

    const blocked = await store.updateIncident(incident.incidentId, staleRevision, { intakeStatus: 'backlog' });
    expect(blocked).toBeNull();

    const settled = await withRevisionRetry(async () => {
      const current = await store.findLive(key);
      if (!current) throw new Error('incident vanished mid-retry');
      return store.updateIncident(current.incidentId, current.revision, { intakeStatus: 'backlog', flags: ['bundled'] });
    });
    expect(settled.intakeStatus).toBe('backlog');
    expect(settled.flags).toEqual(['bundled']);

    await expect(
      withRevisionRetry(
        async () => store.updateIncident(incident.incidentId, -1, { intakeStatus: 'auto' }),
        { maxAttempts: 2, label: 'never-lands' },
      ),
    ).rejects.toThrow(/never-lands: revision contention unresolved after 2 attempts/);
  });
});
