/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BUG-20: IncidentStore.consolidateLanded - the one path both drains (the Alertmanager receiver and the replay claim stage) fold a landed event through - applies each effect once per event, on a real disposable PostgreSQL with migration 141: a replay returns the recorded arm without counting, a genuinely new event still counts, a crash between the consolidation and the member write leaves the member to be applied exactly once, and the transactional recurrence arm records its effect inside its own transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { EnvelopeStore, IncidentStore, readAppliedEffects, type AlertEventRow } from '@/features/alert-pipeline';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';

const database = new DisposableAlertPostgres();
let pool: Pool;
let envelopes: EnvelopeStore;
let incidents: IncidentStore;
const OPTIONS = { reopenWindowSeconds: 60, claimRuleId: null, intakeStatus: 'backlog' };

/** Land one real event through the envelope store and return it shaped for consolidation. */
async function landed(target: string, dedupKey: string): Promise<AlertEventRow> {
  const { eventIds } = await envelopes.landEnvelope({
    source: 'alertmanager', signatureVerified: true,
    body: { receiver: 'spec', status: 'firing', alerts: [{
      status: 'firing', labels: { alertname: 'SwarmContainerDown', container: target, severity: 'critical' },
      annotations: {}, startsAt: new Date().toISOString(), fingerprint: `${target}-fp`,
    }] } as never,
  });
  return {
    eventId: eventIds[0], alertname: 'SwarmContainerDown', target, severity: 'critical', severityNum: 1,
    fingerprint: `${target}-fp`, receivedAt: new Date(), startedAt: new Date(), dedupKey, identitySource: `container=${target}`,
  } as unknown as AlertEventRow;
}

const member = (event: AlertEventRow) => ({
  memberKey: String(event.dedupKey), alertname: event.alertname, target: event.target,
  severity: event.severity, severityNum: event.severityNum, fingerprint: event.fingerprint,
});

/** The incident and member occurrence counts for one identity. */
async function counts(dedupKey: string) {
  const incident = await pool.query(
    `SELECT incident_id, occurrence_count::int AS n FROM oshal_incident WHERE dedup_key = $1 AND state <> 'archived'`, [dedupKey]);
  const members = await pool.query(
    `SELECT m.occurrence_count::int AS n FROM oshal_incident_member m JOIN oshal_incident i ON i.incident_id = m.incident_id
      WHERE i.dedup_key = $1 AND i.state <> 'archived'`, [dedupKey]);
  return { incident: incident.rows[0]?.n ?? 0, member: members.rows[0]?.n ?? 0, incidentId: incident.rows[0]?.incident_id };
}

beforeAll(async () => {
  pool = await database.start();
  envelopes = new EnvelopeStore(pool);
  incidents = new IncidentStore(pool);
}, 120_000);

afterAll(async () => { await database.stop(); });

describe('consolidateLanded applies each effect of a landed event once (BUG-20)', () => {
  it('a replay returns the recorded arm on the current row and counts nothing again', async () => {
    const event = await landed('replay-ctr', 'k-replay');
    const first = await incidents.consolidateLanded(event, { ...OPTIONS, eventId: event.eventId }, member(event));
    expect(first).toMatchObject({ replayed: false, wasCreated: true });
    const again = await incidents.consolidateLanded(event, { ...OPTIONS, eventId: event.eventId }, member(event));
    expect(again).toMatchObject({ replayed: true, wasCreated: true, wasReopened: false, wasRecurrence: false });
    expect(again.incident.incidentId).toBe(first.incident.incidentId);
    expect(await counts('k-replay')).toMatchObject({ incident: 1, member: 1 });
    expect([...(await readAppliedEffects(pool as never, event.eventId)).keys()].sort()).toEqual(['consolidate', 'member']);
  });

  it('a genuinely new event of the same identity still counts', async () => {
    const one = await landed('count-ctr', 'k-count');
    const two = await landed('count-ctr', 'k-count');
    await incidents.consolidateLanded(one, { ...OPTIONS, eventId: one.eventId }, member(one));
    const second = await incidents.consolidateLanded(two, { ...OPTIONS, eventId: two.eventId }, member(two));
    expect(second).toMatchObject({ replayed: false, wasCreated: false });
    expect(await counts('k-count')).toMatchObject({ incident: 2, member: 2 });
  });

  it('a crash after the consolidation but before the member write leaves the member to be applied exactly once', async () => {
    const event = await landed('crash-ctr', 'k-crash');
    await incidents.consolidate(event, { ...OPTIONS, eventId: event.eventId }); // records `consolidate` only
    expect(await counts('k-crash')).toMatchObject({ incident: 1, member: 0 });
    const resumed = await incidents.consolidateLanded(event, { ...OPTIONS, eventId: event.eventId }, member(event));
    expect(resumed).toMatchObject({ replayed: true, wasCreated: true });
    await incidents.consolidateLanded(event, { ...OPTIONS, eventId: event.eventId }, member(event));
    expect(await counts('k-crash')).toMatchObject({ incident: 1, member: 1 });
  });

  it('the transactional recurrence arm records its effect inside its own transaction, and replays as a recurrence', async () => {
    const opening = await landed('recur-ctr', 'k-recur');
    const opened = await incidents.consolidateLanded(opening, { ...OPTIONS, eventId: opening.eventId }, member(opening));
    await incidents.updateIncident(opened.incident.incidentId, opened.incident.revision,
      { state: 'closed', closedAt: new Date(), closedBy: 'operator' } as never);
    const refire = await landed('recur-ctr', 'k-recur');
    const recurred = await incidents.consolidateLanded(refire, { ...OPTIONS, eventId: refire.eventId }, member(refire));
    expect(recurred).toMatchObject({ replayed: false, wasCreated: true, wasRecurrence: true });
    expect(recurred.incident.incidentId).not.toBe(opened.incident.incidentId);
    const replay = await incidents.consolidateLanded(refire, { ...OPTIONS, eventId: refire.eventId }, member(refire));
    expect(replay).toMatchObject({ replayed: true, wasRecurrence: true });
    expect(replay.incident.incidentId).toBe(recurred.incident.incidentId);
    expect(await counts('k-recur')).toMatchObject({ incident: 1, member: 1, incidentId: recurred.incident.incidentId });
  });

  it('a second record of the same effect is refused by the primary key, never counted', async () => {
    const event = await landed('pk-ctr', 'k-pk');
    await incidents.consolidateLanded(event, { ...OPTIONS, eventId: event.eventId }, member(event));
    await expect(incidents.consolidate(event, { ...OPTIONS, eventId: event.eventId })).rejects.toThrow();
    expect(await counts('k-pk')).toMatchObject({ incident: 1, member: 1 });
  });
});
