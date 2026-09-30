/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Unit tests for readOwnFeatureTokenEvidence: validation, sentinel row limits, schema fallback, and complete owner ledger reduction.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  readOwnFeatureTokenEvidence,
  FeatureTokenEvidenceInputError,
  FeatureTokenEvidenceOverflowError,
  type FeatureTokenEvidenceQueryable,
} from '@/features/operational-intelligence/services/feature-token-evidence-reader';
import type { FeatureTokenEvidenceRow } from '@/features/operational-intelligence/services/feature-token-evidence';

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

function mockDb(rows: FeatureTokenEvidenceRow[] = [], error?: Error & { code?: string }): FeatureTokenEvidenceQueryable & { calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (error) throw error;
      return { rows };
    }),
  };
}

describe('readOwnFeatureTokenEvidence', () => {
  const validOwner = 'user_abc123';
  const validFrom = '2026-09-01T00:00:00.000Z';
  const validUntil = '2026-09-08T00:00:00.000Z';

  describe('input validation', () => {
    it.each([
      ['empty owner', ''],
      ['whitespace owner', '   '],
      ['system owner', 'system'],
    ])('rejects %s before querying the database', async (_, ownerSub) => {
      const db = mockDb();
      await expect(
        readOwnFeatureTokenEvidence(db, { ownerSub, from: validFrom, until: validUntil }),
      ).rejects.toThrow(FeatureTokenEvidenceInputError);
      expect(db.calls).toHaveLength(0);
    });

    it.each([
      ['invalid from date', 'not-a-date', validUntil],
      ['invalid until date', validFrom, 'not-a-date'],
      ['from after until', '2026-09-10T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    ])('rejects %s before querying the database', async (_, from, until) => {
      const db = mockDb();
      await expect(
        readOwnFeatureTokenEvidence(db, { ownerSub: validOwner, from, until }),
      ).rejects.toThrow(FeatureTokenEvidenceInputError);
      expect(db.calls).toHaveLength(0);
    });
  });

  describe('query execution and sentinel limit', () => {
    it('executes parameterized owner-bound query with 100,001 row sentinel limit in ID order', async () => {
      const db = mockDb();
      const result = await readOwnFeatureTokenEvidence(db, {
        ownerSub: '  user_abc123  ',
        from: validFrom,
        until: validUntil,
      });

      expect(result.status).toBe('success');
      expect(db.calls).toHaveLength(1);
      const call = db.calls[0];
      expect(call.sql).toContain('FROM oshal_cost_events');
      expect(call.sql).toContain('WHERE owner_sub = $1');
      expect(call.sql).toContain('ORDER BY id ASC');
      expect(call.sql).toContain('LIMIT $2');
      expect(call.params).toEqual(['user_abc123', 100001]);
    });

    it('refuses with overflow error when query returns more than 100,000 rows without returning partial profiles', async () => {
      const overflowRows = new Array(100001).fill(null).map((_, i) => ({
        id: String(i + 1),
        ts: '2026-09-02T01:00:00.000Z',
        owner_sub: validOwner,
        provider_id: 'provider-test',
        model_id: 'model-test',
        input_tokens: 10,
        output_tokens: 2,
        feature_evidence: null,
      }));

      const db = mockDb(overflowRows);
      await expect(
        readOwnFeatureTokenEvidence(db, { ownerSub: validOwner, from: validFrom, until: validUntil }),
      ).rejects.toThrow(FeatureTokenEvidenceOverflowError);
    });
  });

  describe('schema fallback and error handling', () => {
    it.each([
      ['42P01', 'undefined_table'],
      ['42703', 'undefined_column'],
    ])('returns unavailable when schema error code %s is encountered', async (code, message) => {
      const err = new Error(message) as Error & { code?: string };
      err.code = code;
      const db = mockDb([], err);

      const result = await readOwnFeatureTokenEvidence(db, {
        ownerSub: validOwner,
        from: validFrom,
        until: validUntil,
      });

      expect(result).toEqual({ status: 'unavailable', reason: 'schema_unavailable' });
    });

    it('rethrows unexpected database errors', async () => {
      const err = new Error('Connection refused') as Error & { code?: string };
      err.code = 'ECONNREFUSED';
      const db = mockDb([], err);

      await expect(
        readOwnFeatureTokenEvidence(db, { ownerSub: validOwner, from: validFrom, until: validUntil }),
      ).rejects.toThrow('Connection refused');
    });
  });

  describe('aggregation delegation', () => {
    it('passes rows to the reducer and returns a structured report', async () => {
      const validRows: FeatureTokenEvidenceRow[] = [
        {
          id: '1',
          ts: '2026-09-02T01:00:00.000Z',
          owner_sub: validOwner,
          provider_id: 'test-provider',
          model_id: 'test-model',
          input_tokens: 100,
          output_tokens: 20,
          feature_evidence: {
            version: 1,
            producerId: 'test-producer',
            applicationId: 'test-app',
            featureId: 'test-feature',
            unit: 'test-unit',
            workloadId: 'workload-1',
            coreSha: 'a'.repeat(40),
            storeSha: 'b'.repeat(40),
            operationId: '11111111-1111-4111-8111-111111111111',
            startedAt: '2026-09-02T00:50:00.000Z',
            memberId: '22222222-2222-4222-8222-222222222222',
            memberIndex: 1,
            tokenProvenance: 'provider-reported',
            requestCount: 1,
            completion: {
              memberCount: 1,
              completedAt: '2026-09-02T01:00:00.000Z',
            },
          },
        },
      ];

      const db = mockDb(validRows);
      const result = await readOwnFeatureTokenEvidence(db, {
        ownerSub: validOwner,
        from: validFrom,
        until: validUntil,
      });

      expect(result.status).toBe('success');
      if (result.status === 'success') {
        expect(result.report).toBeDefined();
        expect(result.report.profiles).toHaveLength(1);
        expect(result.report.profiles[0].featureId).toBe('test-feature');
        expect(result.report.profiles[0].operations).toBe(1);
      }
    });
  });
});
