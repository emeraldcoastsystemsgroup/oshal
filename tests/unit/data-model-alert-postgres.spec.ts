/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real scratch policy removal through the catalog and drift classifier to durable normalized alert landing; concurrency, restart, rollback, retention and enforcing-role refusal proofs. No live database or provider is contacted.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EnvelopeStore, PIPELINE_OWNER_SUB, type InternalEventInput } from '@/features/alert-pipeline';
import { attributeOwnership, buildDigest, createDriftStore, readCatalog, type SchemaDigest } from '@/features/data-model';
import { schemaDriftEvent } from '@/app/data-model-alert';
import { DisposablePostgres } from '../helpers/disposable-postgres';

const BASELINE_AT = '2026-09-01T00:00:00.000Z';
const SCAN_AT = '2026-09-02T00:00:00.000Z';
const NOW = Date.parse(SCAN_AT);
const MIGRATION = '164-internal-alert-receipts.sql';
const fixture = new DisposablePostgres({
  purpose: 'schema-alert-producer', max: 8,
  migrations: ['104-alert-pipeline-core.sql', '139-schema-digest-history.sql', MIGRATION],
  roles: [
    { name: 'pipeline', max: 8, options: '-c oshal.current_sub=alert:prometheus -c oshal.is_operator=off' },
    { name: 'operator', options: '-c oshal.current_sub=fixture-operator -c oshal.is_operator=on' },
    { name: 'stranger', options: '-c oshal.current_sub=someone-else -c oshal.is_operator=off' },
  ],
});
let baseline: SchemaDigest;
let changed: SchemaDigest;
let value: InternalEventInput;
let store: EnvelopeStore;

async function digest(at: string): Promise<SchemaDigest> {
  const catalog = await readCatalog(fixture.pool, 'scratch');
  return buildDigest({ generatedAt: at, database: 'scratch', ...attributeOwnership([catalog], []), apps: [], integrations: [] }, 164);
}

async function count(table: 'oshal_alert_event' | 'oshal_alert_producer_receipt' | 'oshal_alert_envelope'): Promise<number> {
  return Number((await fixture.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
}

beforeAll(async () => {
  await fixture.start();
  await fixture.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON oshal_alert_event,
    oshal_alert_producer_receipt, oshal_alert_envelope, oshal_schema_digest TO pipeline, operator, stranger;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO operator;
    CREATE TABLE scratch_policy (id uuid PRIMARY KEY, owner_sub text);
    ALTER TABLE scratch_policy ENABLE ROW LEVEL SECURITY;
    ALTER TABLE scratch_policy FORCE ROW LEVEL SECURITY;`);
}, 120_000);
afterAll(async () => { await fixture.stop(); }, 60_000);

beforeEach(async () => {
  await fixture.pool.query(`TRUNCATE oshal_alert_producer_receipt, oshal_alert_event, oshal_schema_digest;
    DROP POLICY IF EXISTS scratch_owner ON scratch_policy;
    CREATE POLICY scratch_owner ON scratch_policy USING (owner_sub = 'policy-expression-must-not-leak');`);
  baseline = await digest(BASELINE_AT);
  await fixture.pool.query('DROP POLICY scratch_owner ON scratch_policy');
  changed = await digest(SCAN_AT);
  value = schemaDriftEvent(baseline, changed, NOW)!;
  store = new EnvelopeStore(fixture.rolePool('pipeline'));
});

describe('schema drift -> normalized internal landing (not ticket or browser acceptance)', () => {
  it('lands one real policy removal with previous state and no fabricated webhook facts', async () => {
    const baselines = createDriftStore(fixture.rolePool('operator'));
    await baselines.record(baseline);
    expect(schemaDriftEvent(baseline, baseline, NOW)).toBeNull();
    expect(await count('oshal_alert_event')).toBe(0);
    const result = await store.landInternalEvent(value);
    expect(result.created).toBe(true);
    const row = (await fixture.pool.query('SELECT * FROM oshal_alert_event')).rows[0];
    expect(row).toMatchObject({ event_id: result.eventId, envelope_id: null, source: 'schema-drift',
      target: 'scratch', alertname: 'SchemaDrift', claim_decision: 'pending',
      owner_sub: PIPELINE_OWNER_SUB, receiver: null, envelope_group_key: null, started_at: null });
    expect(JSON.parse(row.annotations.changes)).toEqual([
      { kind: 'policies-changed', relation: 'scratch.scratch_policy', before: 'scratch_owner', after: 'none' },
    ]);
    expect(row.annotations.description).toContain('scratch.scratch_policy: policies-changed; before: scratch_owner; after: none');
    expect(JSON.stringify(row)).not.toContain('policy-expression-must-not-leak');
    expect(await count('oshal_alert_envelope')).toBe(0);
    expect((await baselines.latest('scratch'))!.fingerprint).toBe(baseline.fingerprint);
    await store.withPendingEvents(5, async (events) => {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventId: result.eventId, source: 'schema-drift', target: 'scratch' });
    });
  });

  it('commits exactly one occurrence across eight concurrent producers', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.landInternalEvent(value)));
    expect(results.filter((row) => row.created)).toHaveLength(1);
    expect(new Set(results.map((row) => row.eventId)).size).toBe(1);
    expect(await count('oshal_alert_event')).toBe(1);
    expect(await count('oshal_alert_producer_receipt')).toBe(1);
  });

  it('deduplicates a new scan and store instance, independent of map insertion order', async () => {
    const first = await store.landInternalEvent(value);
    const repeated = schemaDriftEvent(baseline, { ...changed, capturedAt: '2026-09-03T00:00:00.000Z' }, NOW)!;
    expect(repeated).toEqual(value);
    repeated.event.labels = Object.fromEntries(Object.entries(repeated.event.labels).reverse());
    const restarted = new EnvelopeStore(fixture.rolePool('pipeline'));
    expect(await restarted.landInternalEvent(repeated)).toEqual({ created: false, eventId: first.eventId });
    expect(await count('oshal_alert_event')).toBe(1);
  });

  it('rejects conflicting content under an existing occurrence key', async () => {
    await store.landInternalEvent(value);
    const conflicting = structuredClone(value);
    conflicting.event.annotations.description = 'different evidence';
    await expect(store.landInternalEvent(conflicting)).rejects.toMatchObject({ code: 'ALERT_PRODUCER_CONFLICT' });
    expect(await count('oshal_alert_event')).toBe(1);
  });

  it('allows a genuinely different producer occurrence without suppressing it', async () => {
    await store.landInternalEvent(value);
    const next = { ...value, producerKey: `${value.producerKey}:next` };
    expect((await store.landInternalEvent(next)).created).toBe(true);
    expect(await count('oshal_alert_event')).toBe(2);
  });

  it('rolls back the receipt when the event insert fails, permitting a real retry', async () => {
    await fixture.pool.query(`CREATE FUNCTION reject_fixture_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture write failure'; END $$;
      CREATE TRIGGER reject_fixture_event BEFORE INSERT ON oshal_alert_event
        FOR EACH ROW EXECUTE FUNCTION reject_fixture_event();`);
    try {
      await expect(store.landInternalEvent(value)).rejects.toThrow('fixture write failure');
      expect(await count('oshal_alert_event')).toBe(0);
      expect(await count('oshal_alert_producer_receipt')).toBe(0);
    } finally {
      await fixture.pool.query('DROP TRIGGER reject_fixture_event ON oshal_alert_event; DROP FUNCTION reject_fixture_event()');
    }
    expect((await store.landInternalEvent(value)).created).toBe(true);
  });

  it('retains duplicate protection after the original event ages out', async () => {
    const first = await store.landInternalEvent(value);
    await fixture.rolePool('operator').query('DELETE FROM oshal_alert_event WHERE event_id = $1', [first.eventId]);
    expect(await store.landInternalEvent(value)).toEqual({ created: false, eventId: null });
    expect(await count('oshal_alert_event')).toBe(0);
    expect(await count('oshal_alert_producer_receipt')).toBe(1);
  });

  it('enforces receipt RLS for real non-bypass roles and permits the operator', async () => {
    const roles = await fixture.pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('pipeline','operator','stranger')");
    expect(roles.rows).toEqual(Array.from({ length: 3 }, () => ({ rolsuper: false, rolbypassrls: false })));
    const stranger = new EnvelopeStore(fixture.rolePool('stranger'));
    await expect(stranger.landInternalEvent(value)).rejects.toMatchObject({ code: '42501' });
    await store.landInternalEvent(value);
    expect((await fixture.rolePool('stranger').query('SELECT * FROM oshal_alert_producer_receipt')).rows).toEqual([]);
    expect((await fixture.rolePool('operator').query('SELECT * FROM oshal_alert_producer_receipt')).rows).toHaveLength(1);
  });

  it('does not reset receipts when the migration is reapplied', async () => {
    const first = await store.landInternalEvent(value);
    await fixture.pool.query(readFileSync(`scripts/migrations/${MIGRATION}`, 'utf8'));
    expect(await store.landInternalEvent(value)).toEqual({ created: false, eventId: first.eventId });
  });

  it('fails closed when the producer migration has not been applied', async () => {
    await fixture.pool.query('ALTER TABLE oshal_alert_producer_receipt RENAME TO saved_fixture_receipt');
    try {
      await expect(store.landInternalEvent(value)).rejects.toMatchObject({ code: '42P01' });
      expect(await count('oshal_alert_event')).toBe(0);
    } finally {
      await fixture.pool.query('ALTER TABLE saved_fixture_receipt RENAME TO oshal_alert_producer_receipt');
    }
  });
});

describe('schema producer preserves classifier and acknowledgement boundaries', () => {
  it('does not publish first-run, unchanged, migrated or settling reads', () => {
    expect(schemaDriftEvent(null, changed, NOW)).toBeNull();
    expect(schemaDriftEvent(changed, changed, NOW)).toBeNull();
    expect(schemaDriftEvent(baseline, { ...changed, migrationCount: 165 }, NOW)).toBeNull();
    expect(schemaDriftEvent({ ...baseline, capturedAt: SCAN_AT }, changed, NOW)).toBeNull();
  });

  it('does not swallow partial or invalid digest refusals', () => {
    expect(() => schemaDriftEvent(baseline, { ...changed, relations: [] }, NOW)).toThrow();
    expect(() => schemaDriftEvent({ ...baseline, digestVersion: 999 }, changed, NOW)).toThrow();
  });

  it('gives a later acknowledged baseline its own occurrence identity', () => {
    const recaptured = { ...baseline, capturedAt: '2026-09-01T06:00:00.000Z' };
    expect(schemaDriftEvent(recaptured, changed, NOW)!.producerKey).not.toBe(value.producerKey);
  });
});
