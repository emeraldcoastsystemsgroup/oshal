/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Actual PostgreSQL companion for feature evidence persistence, migration immutability/RLS and atomic cost settlement. Fixture metrics are not provider or seven-day production evidence.
 */
/** Source prepared separately; requires an explicitly scheduled owned database runtime, never deployment DSNs. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { buildOwnerRlsPolicyStatements } from '@/shared/services/database/owner-rls-policy';
import { CostTrackingService, type CostEvent } from '@/features/operational-intelligence/services/cost-tracking-service';
import { aggregateFeatureTokenEvidence as aggregate, type FeatureTokenEvidenceRow as Row,
  type FeatureTokenEvidence } from '@/features/operational-intelligence/services/feature-token-evidence';

const ROLE = 'feature_evidence_runtime';
const OWNER = 'fixture-feature-owner';
const OTHER = 'fixture-other-owner';
const NOW = Date.now();
const START = new Date(NOW - 60_000).toISOString();
const END = new Date(NOW - 1_000).toISOString();
const scope = { ownerSub: OWNER, from: new Date(NOW - 86_400_000).toISOString(), until: new Date(NOW + 86_400_000).toISOString() };
const migration = readFileSync(resolve(__dirname, '../../scripts/migrations/182-feature-token-evidence.sql'), 'utf8');
const fixture = new DisposablePostgres({ purpose: 'feature-token-evidence', memory: '256m', max: 2,
  roles: [{ name: ROLE, max: 2 }], migrations: ['005-conversation-history-and-usage.sql', '055-chat-tasks-owner-sub.sql',
    '078-cost-governance.sql', '090-cost-event-tokens-duration.sql', '112-owner-column-rls.sql', '115-durable-remote-task-journal.sql'] });
let admin: Pool;
let runtime: Pool;
let service: CostTrackingService;
const as = <T>(sub: string, fn: () => Promise<T>) => runWithRequestIdentity({ sub, isOperator: false }, fn);

function evidence(operationId = randomUUID(), memberIndex = 1, memberCount: number | null = 1): FeatureTokenEvidence {
  return { version: 1, producerId: 'fixture-producer', applicationId: 'fixture-package', featureId: 'rank-jobs',
    unit: 'one posting', workloadId: 'fixture-workload', coreSha: 'a'.repeat(40), storeSha: 'b'.repeat(40),
    operationId, memberId: randomUUID(), memberIndex, startedAt: START, tokenProvenance: 'provider-reported',
    completion: memberCount === null ? null : { memberCount, completedAt: END } };
}
function event(over: Partial<CostEvent> = {}): CostEvent {
  return { taskId: randomUUID(), agentId: 'fixture-agent', providerId: 'fixture-provider', modelId: 'fixture-model',
    inputTokens: 10, outputTokens: 2, inputCost: 0.1, outputCost: 0.2, totalCost: 0.3,
    requestCount: 3, currency: 'USD', ownerSub: OWNER, featureEvidence: evidence(), ...over };
}
async function read(taskIds: string[], sub = OWNER): Promise<Row[]> {
  const result = await as(sub, () => runtime.query<Row>(
    'SELECT id::text, ts, owner_sub, provider_id, model_id, input_tokens, output_tokens, feature_evidence FROM oshal_cost_events WHERE task_id = ANY($1::text[]) ORDER BY id',
    [taskIds]));
  return result.rows;
}

beforeAll(async () => {
  admin = await fixture.start();
  for (const sql of buildOwnerRlsPolicyStatements('chat_tasks', 'owner_sub')) await admin.query(sql);
  for (const table of ['chat_tasks', 'oshal_cost_events', 'remote_task_cost_receipts']) {
    await admin.query('ALTER TABLE ' + table + ' OWNER TO ' + ROLE);
  }
  await admin.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ' + ROLE);
  await admin.query("INSERT INTO oshal_cost_events (task_id, owner_sub, cost_usd) VALUES ('fixture-legacy', $1, 0.5)", [OWNER]);
  await admin.query(migration); await admin.query(migration); // Actual idempotent replay, not a schema-text assertion.
  runtime = wrapPoolWithGuc(fixture.rolePool(ROLE)); service = new CostTrackingService(runtime);
}, 120_000);
afterAll(async () => { await fixture.stop(); }, 60_000);

describe('feature evidence / actual enforcing PostgreSQL + writer + reducer; no provider invoked', () => {
  it('self-validates FORCE RLS as the non-bypass table owner; foreign rows stay inaccessible', async () => {
    const flags = await admin.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [ROLE]);
    expect(flags.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const tables = await admin.query("SELECT relforcerowsecurity, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname IN ('chat_tasks','oshal_cost_events','remote_task_cost_receipts')");
    expect(tables.rows).toHaveLength(3);
    expect(tables.rows.every(r => r.relforcerowsecurity && r.owner === ROLE)).toBe(true);
    expect(await read(['fixture-legacy'], OTHER)).toEqual([]);
    await expect(as(OTHER, () => runtime.query(
      "INSERT INTO oshal_cost_events (task_id, owner_sub, cost_usd) VALUES ('fixture-forged', $1, 1)", [OWNER]))).rejects.toMatchObject({ code: '42501' });
  });
  it('legacy nullable token/evidence fields remain unknown after migration replay', async () => {
    const rows = await read(['fixture-legacy']);
    expect(rows[0].input_tokens).toBeNull(); expect(rows[0].feature_evidence).toBeNull();
    expect(aggregate(rows, scope)).toMatchObject({ unattributedRows: 1, profiles: [] });
  });
  it('persists real members and exact request counts; sums before percentiles and preserves ordinary costs once', async () => {
    const operation = randomUUID(); const task = randomUUID();
    const a = event({ taskId: task, featureEvidence: evidence(operation, 1, null), requestCount: 2, inputTokens: 10, outputTokens: 3 });
    const b = event({ taskId: task, featureEvidence: evidence(operation, 2, 2), requestCount: 3, inputTokens: 20, outputTokens: 7 });
    const c = event({ inputTokens: 100, outputTokens: 20, requestCount: 1 });
    await as(OWNER, async () => { await service.recordCost(a); await service.recordCost(b); await service.recordCost(c); });
    const rows = await read([task, c.taskId]); expect(rows).toHaveLength(3);
    expect(aggregate(rows, scope).profiles[0]).toMatchObject({ operations: 2,
      tokensPerOperation: { p50: 40, p95: 120 }, requestsPerOperation: { p50: 1, p95: 5, mean: 3 } });
    const rollup = await as(OWNER, () => runtime.query('SELECT total_input_tokens, total_output_tokens, total_requests, total_cost FROM chat_tasks WHERE task_id=$1', [task]));
    expect(rollup.rows[0]).toMatchObject({ total_input_tokens: '30', total_output_tokens: '10', total_requests: 5, total_cost: 0.6 });
  });
  it('rejects measured-evidence adoption and token/binding rewrites even by the enforcing owner', async () => {
    const data = event(); await as(OWNER, () => service.recordLedgerEvent(data));
    const [stored] = await read([data.taskId]);
    for (const statement of [
      'UPDATE oshal_cost_events SET input_tokens = input_tokens + 1 WHERE id=$1',
      "UPDATE oshal_cost_events SET feature_evidence=jsonb_set(feature_evidence, '{featureId}', '\"other-feature\"') WHERE id=$1",
      'UPDATE oshal_cost_events SET feature_evidence=NULL WHERE id=$1',
    ]) await expect(as(OWNER, () => runtime.query(statement, [stored.id]))).rejects.toMatchObject({ code: '23514' });
    await expect(as(OWNER, () => runtime.query(
      "UPDATE oshal_cost_events SET feature_evidence=$1::jsonb WHERE task_id='fixture-legacy'", [JSON.stringify(stored.feature_evidence)]))).rejects.toMatchObject({ code: '23514' });
  });
});

describe('operation refusals and atomic settlement / actual PostgreSQL', () => {
  it('keeps duplicate, incomplete and estimated operations out of measured profiles', async () => {
    const duplicate = event(); const incomplete = event({ featureEvidence: evidence(randomUUID(), 1, null) });
    const estimated = event({ estimated: true });
    await as(OWNER, async () => {
      await service.recordLedgerEvent(duplicate); await service.recordLedgerEvent(duplicate);
      await service.recordLedgerEvent(incomplete); await service.recordLedgerEvent(estimated);
    });
    const report = aggregate(await read([duplicate.taskId, incomplete.taskId, estimated.taskId]), scope);
    expect(report.profiles).toEqual([]);
    expect(report.excludedOperations).toMatchObject({ duplicate: 1, incomplete: 1, unknown_usage: 1 });
  });
  it('stratifies models and refuses an evidence window that truncates operation start', async () => {
    const a = event(); const b = event({ modelId: 'second-fixture-model' });
    await as(OWNER, async () => { await service.recordLedgerEvent(a); await service.recordLedgerEvent(b); });
    const rows = await read([a.taskId, b.taskId]);
    expect(aggregate(rows, scope).profiles).toHaveLength(2);
    expect(aggregate(rows, { ...scope, from: END }).excludedOperations.out_of_window).toBe(2);
  });
  it('persists unknown requests and provider-estimated tokens without promoting either to measured usage', async () => {
    const unknown = event({ requestCount: undefined });
    const marker = event({ requestCount: 0 });
    const estimated = event({ featureEvidence: { ...evidence(), tokenProvenance: 'estimated' } });
    await as(OWNER, async () => {
      for (const data of [unknown, marker, estimated]) await service.recordLedgerEvent(data);
    });
    const rows = await read([unknown.taskId, marker.taskId, estimated.taskId]);
    expect(rows).toHaveLength(3);
    const report = aggregate(rows, scope);
    expect(report.profiles).toEqual([]); expect(report.excludedOperations.unknown_usage).toBe(3);
  });
  it('recordCostOnce replay leaves exactly one receipt, rollup and evidence row', async () => {
    const data = event(); const outbox = randomUUID();
    expect(await as(OWNER, () => service.recordCostOnce(outbox, data))).toBe(true);
    expect(await as(OWNER, () => service.recordCostOnce(outbox, data))).toBe(false);
    expect(await read([data.taskId])).toHaveLength(1);
    const counted = await as(OWNER, () => runtime.query('SELECT total_requests,total_cost FROM chat_tasks WHERE task_id=$1', [data.taskId]));
    expect(counted.rows[0]).toMatchObject({ total_requests: 3, total_cost: 0.3 });
    const receipts = await as(OWNER, () => runtime.query('SELECT outbox_id FROM remote_task_cost_receipts WHERE outbox_id=$1', [outbox]));
    expect(receipts.rows).toHaveLength(1);
  });
  it('a real ledger refusal rolls back both receipt and rollup, then the same outbox can retry', async () => {
    const data = event(); const outbox = randomUUID();
    // Fixture constraint is the named rejection seam; PostgreSQL rollback itself is real.
    await admin.query("ALTER TABLE oshal_cost_events ADD CONSTRAINT fixture_cost_refusal CHECK (task_id <> '" + data.taskId + "')");
    try {
      await expect(as(OWNER, () => service.recordCostOnce(outbox, data))).rejects.toMatchObject({ code: '23514' });
      expect(await read([data.taskId])).toEqual([]);
      expect((await admin.query('SELECT 1 FROM chat_tasks WHERE task_id=$1', [data.taskId])).rows).toEqual([]);
      expect((await admin.query('SELECT 1 FROM remote_task_cost_receipts WHERE outbox_id=$1', [outbox])).rows).toEqual([]);
    } finally { await admin.query('ALTER TABLE oshal_cost_events DROP CONSTRAINT fixture_cost_refusal'); }
    expect(await as(OWNER, () => service.recordCostOnce(outbox, data))).toBe(true);
  });
  it('an actual pre-182 column failure recovers its savepoint and retains one unmeasured cost effect', async () => {
    const data = event(); const outbox = randomUUID();
    // This owned disposable database alone is reverted to its pre-182 column shape.
    await admin.query('ALTER TABLE oshal_cost_events DROP COLUMN feature_evidence CASCADE');
    try {
      expect(await as(OWNER, () => service.recordCostOnce(outbox, data))).toBe(true);
      expect(await as(OWNER, () => service.recordCostOnce(outbox, data))).toBe(false);
    } finally { await admin.query(migration); }
    const rows = await read([data.taskId]); expect(rows).toHaveLength(1); expect(rows[0].feature_evidence).toBeNull();
    const counted = await as(OWNER, () => runtime.query('SELECT total_requests,total_cost FROM chat_tasks WHERE task_id=$1', [data.taskId]));
    expect(counted.rows[0]).toMatchObject({ total_requests: 3, total_cost: 0.3 });
    expect(aggregate(rows, scope).profiles).toEqual([]);
  });
});
