/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real pure reducer and cost-writer tests with named recording SQL transport; database enforcement has a separate actual PostgreSQL companion, not claimed here.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { CostTrackingService, type CostEvent } from '@/features/operational-intelligence/services/cost-tracking-service';
import { aggregateFeatureTokenEvidence as aggregate, prepareFeatureTokenEvidence as prepare,
  type FeatureTokenEvidence, type FeatureTokenEvidenceRow as Row } from '@/features/operational-intelligence/services/feature-token-evidence';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
const uuid = (n: number) => 'aaaaaaaa-aaaa-aaaa-aaaa-' + String(n).padStart(12, '0');
const scope = { ownerSub: 'fixture-owner', from: '2026-09-01T00:00:00.000Z', until: '2026-09-08T00:00:00.000Z' };
const evidence = (operation = 1, member = 1, total: number | null = 1): FeatureTokenEvidence => ({
  version: 1, producerId: 'fixture-producer', applicationId: 'fixture-package', featureId: 'rank-jobs',
  unit: 'one posting', workloadId: 'fixture-workload', coreSha: 'a'.repeat(40), storeSha: 'b'.repeat(40),
  operationId: uuid(operation), startedAt: '2026-09-02T00:00:00.000Z', memberId: uuid(operation * 100 + member),
  memberIndex: member, tokenProvenance: 'provider-reported',
  completion: total === null ? null : { memberCount: total, completedAt: '2026-09-02T01:00:00.000Z' },
});
function row(id = 1, operation = id, member = 1, total: number | null = 1): Row {
  return { id: String(id), ts: '2026-09-02T01:01:00.000Z', owner_sub: scope.ownerSub, provider_id: 'fixture-provider',
    model_id: 'fixture-model', input_tokens: '10', output_tokens: '2',
    feature_evidence: prepare(evidence(operation, member, total), { inputTokens: 10, outputTokens: 2, requestCount: 1 }) };
}
const payload = (r: Row) => r.feature_evidence as Record<string, any>;
function replace(r: Row, patch: Record<string, unknown>): Row { return { ...r, feature_evidence: { ...payload(r), ...patch } }; }
const event = (): CostEvent => ({ taskId: 'fixture-task', agentId: 'fixture-agent', providerId: 'fixture-provider',
  modelId: 'fixture-model', inputTokens: 10, outputTokens: 2, inputCost: 0.1, outputCost: 0.2, totalCost: 0.3,
  currency: 'USD', ownerSub: scope.ownerSub, requestCount: 3, featureEvidence: evidence() });

type Call = { sql: string; params: unknown[] };
/** Named SQL transport double: records real writer statements, never pretends to enforce RLS or PostgreSQL rollback. */
function recordingSql(onQuery?: (call: Call) => Promise<void> | void) {
  const calls: Call[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    const c = { sql, params }; calls.push(c); await onQuery?.(c);
    return { rows: sql.includes('INSERT INTO remote_task_cost_receipts') ? [{ outbox_id: uuid(90) }] : [], rowCount: 1 };
  };
  const client = { query, release: vi.fn() };
  return { calls, client, pool: { query, connect: async () => client } as unknown as Pool };
}
const ledgerCalls = (calls: Call[]) => calls.filter(c => c.sql.includes('INSERT INTO oshal_cost_events'));
const saved = (c: Call) => JSON.parse(c.params[9] as string);

describe('producer evidence snapshot / real validation', () => {
  it('deeply snapshots completion and preserves exact requests, including unknown and marker counts', () => {
    const e = evidence(); const p = prepare(e, { inputTokens: 1, outputTokens: 2, requestCount: 7 })!;
    e.completion!.memberCount = 99; e.featureId = 'changed';
    expect(p.featureId).toBe('rank-jobs'); expect(p.completion!.memberCount).toBe(1); expect(p.requestCount).toBe(7);
    expect(Object.isFrozen(p)).toBe(true); expect(Object.isFrozen(p.completion)).toBe(true);
    expect(prepare(evidence(), { inputTokens: 1, outputTokens: 2 })!.requestCount).toBeNull();
    expect(prepare(evidence(), { inputTokens: 1, outputTokens: 2, requestCount: 0 })!.requestCount).toBe(0);
  });
  it.each([undefined, null, {}, { ...evidence(), modelsVerified: ['invented'] }, { ...evidence(), operationId: 'task-guessed' },
    { ...evidence(), memberIndex: 0 }, { ...evidence(), completion: { memberCount: 2, completedAt: scope.until } },
    { ...evidence(), tokenProvenance: 'measured-maybe' }])('refuses malformed binding %# without inventing attribution', bad => {
    expect(prepare(bad, { inputTokens: 1, outputTokens: 2 })).toBeNull();
  });
  it.each([NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('invalid token count %s loses measured provenance', inputTokens => {
    expect(prepare(evidence(), { inputTokens, outputTokens: 2 })!.tokenProvenance).toBe('unknown');
  });
  it('estimated metrics override a provider-reported declaration', () => {
    expect(prepare(evidence(), { inputTokens: 1, outputTokens: 2, estimated: true })!.tokenProvenance).toBe('estimated');
  });
});

describe('read-only complete operation aggregation / real reducer, synthetic recorded rows', () => {
  it('sums members before nearest-rank percentiles; requests are exact counts, not rows', () => {
    const a = { ...replace(row(1, 1, 1, null), { requestCount: 2 }), input_tokens: '10', output_tokens: '3' };
    const b = { ...replace(row(2, 1, 2, 2), { requestCount: 3 }), input_tokens: '20', output_tokens: '7' };
    const c = { ...row(3, 2), input_tokens: '100', output_tokens: '20' };
    const before = JSON.stringify([a, b, c]); const report = aggregate([c, b, a], scope);
    expect(report.profiles).toHaveLength(1);
    expect(report.profiles[0]).toMatchObject({ operations: 2, tokensPerOperation: { p50: 40, p95: 120 },
      outputTokensPerOperation: { p50: 10, p95: 20 }, requestsPerOperation: { p50: 1, p95: 5, mean: 3 } });
    expect(report.coverage).toBe('recorded-samples-only'); expect(report.window).toEqual({ from: scope.from, until: scope.until });
    expect(JSON.stringify([a, b, c])).toBe(before); expect(report).toEqual(aggregate([a, b, c], scope));
    expect(JSON.stringify(report)).not.toContain(uuid(1)); expect(JSON.stringify(report)).not.toContain('fixture-owner');
    expect(report).not.toHaveProperty('modelsVerified'); expect(report).not.toHaveProperty('uptimeDays');
  });
  it('legacy null evidence stays unattributed, not a zero-token measurement', () => {
    const report = aggregate([{ ...row(), feature_evidence: null }], scope);
    expect(report.profiles).toEqual([]); expect(report.unattributedRows).toBe(1);
  });
  it('keeps large request means bounded and independent of input order', () => {
    const largest = Number.MAX_SAFE_INTEGER;
    for (const counts of [[largest, largest, largest], [largest, largest, 1]]) {
      const rows = counts.map((requestCount, i) => replace(row(i + 1), { requestCount }));
      const expected = counts[2] === largest ? largest : 6004799503160661;
      expect(aggregate(rows, scope).profiles[0].requestsPerOperation.mean).toBe(expected);
      expect(aggregate(rows, scope)).toEqual(aggregate([...rows].reverse(), scope));
    }
  });
  it.each(['model_id', 'provider_id'] as const)('stratifies different %s rather than implying compatibility', field => {
    const report = aggregate([row(1), { ...row(2), [field]: 'other-fixture' }], scope);
    expect(report.profiles).toHaveLength(2); expect(report.profiles.every(p => p.operations === 1)).toBe(true);
  });
  it('preserves mixed-model operation membership as an explicit model set', () => {
    const report = aggregate([row(1, 1, 1, null), { ...row(2, 1, 2, 2), model_id: 'second-model' }], scope);
    expect(report.profiles[0].models).toHaveLength(2); expect(report.profiles[0].operations).toBe(1);
  });
  it.each(['workloadId', 'coreSha', 'storeSha'] as const)('separates different %s across completed operations', field => {
    const report = aggregate([row(1), replace(row(2), { [field]: field === 'workloadId' ? 'other-workload' : 'c'.repeat(40) })], scope);
    expect(report.profiles).toHaveLength(2);
  });
});

describe('ambiguous and incomplete evidence / real reducer refusals', () => {
  it.each([
    ['missing final', [row(1, 1, 1, null)]],
    ['missing first member', [row(2, 1, 2, 2)]],
    ['two completions', [row(1, 1), row(2, 1, 2, 2)]],
    ['completion later than its persisted final member', [replace(row(), { completion: { memberCount: 1, completedAt: '2026-09-02T02:00:00.000Z' } })]],
    ['final member persisted before operation start', [{ ...row(), ts: '2026-09-01T12:00:00.000Z' }]],
  ] as const)('excludes %s', (_name, rows) => {
    const report = aggregate(rows, scope); expect(report.profiles).toEqual([]); expect(report.excludedOperations.incomplete).toBe(1);
  });
  it.each(['producerId', 'applicationId', 'featureId', 'unit', 'workloadId', 'coreSha', 'storeSha', 'startedAt'] as const)
    ('refuses operation binding change: %s', field => {
      const value = field.includes('Sha') ? 'c'.repeat(40) : field === 'startedAt' ? '2026-09-02T00:30:00.000Z' : 'changed';
      const report = aggregate([row(1, 1, 1, null), replace(row(2, 1, 2, 2), { [field]: value })], scope);
      expect(report.profiles).toEqual([]); expect(report.excludedOperations.binding_conflict).toBe(1);
    });
  it.each([
    ['same row', [row(), row()]],
    ['same member', [row(1, 1, 1, null), replace(row(2, 1, 2, 2), { memberId: payload(row()).memberId })]],
    ['same index', [row(1, 1, 1, null), replace(row(2, 1, 1, null), { memberId: uuid(999) })]],
    ['member reused across operations', [row(), replace(row(2), { memberId: payload(row()).memberId })]],
    ['row reused across operations', [row(), { ...row(2), id: '1' }]],
  ] as const)('refuses duplicate %s', (_name, rows) => {
    const report = aggregate(rows, scope); expect(report.profiles).toEqual([]); expect(report.excludedOperations.duplicate).toBeGreaterThan(0);
  });
  it('does not blend foreign-owner evidence, including unattributed rows', () => {
    for (const feature_evidence of [null, row().feature_evidence]) {
      expect(() => aggregate([{ ...row(), owner_sub: 'other-owner', feature_evidence }], scope)).toThrow('feature_token_scope_mismatch');
    }
  });
  it('requires explicit scope; a null-owner system scope does not accept owned rows', () => {
    expect(() => aggregate([row()], { ...scope, ownerSub: null })).toThrow('feature_token_scope_mismatch');
    expect(() => aggregate([], { ...scope, from: scope.until })).toThrow('invalid_feature_token_evidence');
    expect(() => aggregate([{ ...row(), feature_evidence: { version: 2 } }], scope)).toThrow('invalid_feature_token_evidence');
  });
});

describe('measurement/window admission / real reducer', () => {
  it.each([{ requestCount: null }, { requestCount: 0 }, { tokenProvenance: 'estimated' }, { tokenProvenance: 'unknown' }])
    ('keeps unknown, estimated or marker usage out of measurements %#', patch => {
      const report = aggregate([replace(row(), patch)], scope);
      expect(report.profiles).toEqual([]); expect(report.excludedOperations.unknown_usage).toBe(1);
    });
  it.each([null, -1, 1.5, '9007199254740992'])('refuses unmeasured/unsafe stored tokens %s', input_tokens => {
    expect(aggregate([{ ...row(), input_tokens }], scope).excludedOperations.unknown_usage).toBe(1);
  });
  it.each(['provider_id', 'model_id'] as const)('refuses unknown %s rather than inventing a measured model', field => {
    for (const value of [null, '', 'unknown', 'n/a']) {
      expect(aggregate([{ ...row(), [field]: value }], scope).excludedOperations.unknown_usage).toBe(1);
    }
  });
  it('does not overflow safe integer arithmetic into a measurement', () => {
    const report = aggregate([{ ...row(), input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }], scope);
    expect(report.profiles).toEqual([]); expect(report.excludedOperations.overflow).toBe(1);
  });
  it.each([
    { ...row(), ts: scope.until },
    replace({ ...row(), ts: '2026-08-31T23:59:59.999Z' }, { startedAt: '2026-08-31T00:00:00.000Z',
      completion: { memberCount: 1, completedAt: '2026-08-31T23:59:59.999Z' } }),
    replace(row(), { startedAt: '2026-08-31T23:59:59.999Z' }),
    replace({ ...row(), ts: scope.until }, { completion: { memberCount: 1, completedAt: scope.until } }),
  ])('excludes partial/out-of-window operation %#', data => {
    expect(aggregate([data], scope).excludedOperations.out_of_window).toBe(1);
  });
  it('accepts the inclusive start and last millisecond before exclusive end with explicit completion', () => {
    for (const timestamp of [scope.from, '2026-09-07T23:59:59.999Z']) {
      const data = replace({ ...row(), ts: timestamp }, { startedAt: scope.from,
        completion: { memberCount: 1, completedAt: timestamp } });
      expect(aggregate([data], scope).profiles).toHaveLength(1);
    }
  });
});

describe('cost writer with named recording SQL only / PostgreSQL companion required', () => {
  it('writes exactly one rollup and ledger event with explicit count and evidence', async () => {
    const db = recordingSql(); await new CostTrackingService(db.pool).recordCost(event());
    expect(db.calls.filter(c => c.sql.includes('INSERT INTO chat_tasks'))).toHaveLength(1);
    const writes = ledgerCalls(db.calls); expect(writes).toHaveLength(1);
    expect(saved(writes[0])).toMatchObject({ featureId: 'rank-jobs', requestCount: 3, tokenProvenance: 'provider-reported' });
    expect(writes[0].params.slice(5, 8)).toEqual([0.3, 10, 2]);
  });
  it.each([null, undefined, { ...evidence(), unexpected: 'ignored-sentinel' }])('retains accounting without malformed/legacy evidence %#', featureEvidence => {
    const db = recordingSql(); return new CostTrackingService(db.pool).recordLedgerEvent({ ...event(), featureEvidence } as CostEvent)
      .then(() => { expect(ledgerCalls(db.calls)).toHaveLength(1); expect(ledgerCalls(db.calls)[0].params).toHaveLength(9); });
  });
  it('uses ledger-only path without adding a chat_tasks rollup', async () => {
    const db = recordingSql(); await new CostTrackingService(db.pool).recordLedgerEvent(event());
    expect(db.calls.some(c => c.sql.includes('chat_tasks'))).toBe(false); expect(ledgerCalls(db.calls)).toHaveLength(1);
  });
  it('missing 182 stores one ordinary cost row with no measured evidence', async () => {
    const db = recordingSql(c => { if (c.sql.includes('feature_evidence')) throw Object.assign(new Error('missing fixture column'), { code: '42703' }); });
    await new CostTrackingService(db.pool).recordCost(event());
    expect(ledgerCalls(db.calls)).toHaveLength(2); expect(ledgerCalls(db.calls)[1].params).toHaveLength(9);
    expect(db.calls.filter(c => c.sql.includes('INSERT INTO chat_tasks'))).toHaveLength(1);
  });
});

describe('snapshot before each asynchronous boundary / actual cost writer with SQL transport double', () => {
  it.each(['recordCost', 'recordCostOnce'] as const)('freezes original producer, owner, model, metrics and nested completion before %s awaits', async method => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let paused = false;
    const db = recordingSql(async c => { if (!paused && c.sql.includes('FROM chat_tasks')) { paused = true; await gate; } });
    if (method === 'recordCostOnce') (db.pool as any).connect = async () => { paused = true; await gate; return db.client; };
    const data = event(); const service = new CostTrackingService(db.pool);
    const pending = method === 'recordCost' ? service.recordCost(data) : service.recordCostOnce(uuid(90), data);
    await Promise.resolve(); data.ownerSub = 'other-owner'; data.inputTokens = 999; data.requestCount = 99;
    data.modelId = 'other-model'; data.featureEvidence!.featureId = 'other-feature'; data.featureEvidence!.completion!.memberCount = 99;
    release(); await pending;
    const inserted = ledgerCalls(db.calls)[0];
    expect(inserted.params[1]).toBe('fixture-owner'); expect(inserted.params[4]).toBe('fixture-model');
    expect(inserted.params[6]).toBe(10); expect(saved(inserted)).toMatchObject({ featureId: 'rank-jobs', requestCount: 3, completion: { memberCount: 1 } });
  });
  it('savepoint recovers absent 182 inside recordCostOnce before committing the existing receipt/rollup', async () => {
    let aborted = false;
    const db = recordingSql(c => {
      if (c.sql.startsWith('ROLLBACK TO')) { aborted = false; return; }
      if (aborted) throw Object.assign(new Error('fixture transaction aborted'), { code: '25P02' });
      if (c.sql.includes('INSERT INTO oshal_cost_events') && c.sql.includes('feature_evidence')) {
        aborted = true; throw Object.assign(new Error('missing fixture column'), { code: '42703' });
      }
    });
    await expect(new CostTrackingService(db.pool).recordCostOnce(uuid(90), event())).resolves.toBe(true);
    expect(db.calls.some(c => c.sql === 'ROLLBACK TO SAVEPOINT feature_token_evidence')).toBe(true);
    expect(db.calls.at(-1)?.sql).toBe('COMMIT'); expect(ledgerCalls(db.calls).at(-1)?.params).toHaveLength(9);
  });
  it('non-schema evidence insertion failure rolls back settlement and never downgrades', async () => {
    const db = recordingSql(c => {
      if (c.sql.includes('INSERT INTO oshal_cost_events')) throw Object.assign(new Error('fixture RLS refusal'), { code: '42501' });
    });
    const service = new CostTrackingService(db.pool);
    await expect(service.recordCostOnce(uuid(90), event())).rejects.toMatchObject({ code: '42501' });
    expect(db.calls.at(-1)?.sql).toBe('ROLLBACK'); expect(db.calls.some(c => c.sql === 'COMMIT')).toBe(false);
    expect(ledgerCalls(db.calls)).toHaveLength(1); expect(service.getSummary().totalCost).toBe(0);
  });
});
