/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Actual PostgreSQL companion for readOwnFeatureTokenEvidence: verifies FORCE RLS owner isolation, real ledger projection, schema fallback, and complete operation profile generation.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisposablePostgres } from '../helpers/disposable-postgres';
import { wrapPoolWithGuc } from '@/shared/services/database/guc-pool';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { buildOwnerRlsPolicyStatements } from '@/shared/services/database/owner-rls-policy';
import {
  readOwnFeatureTokenEvidence,
  type ReadFeatureTokenEvidenceInput,
} from '@/features/operational-intelligence/services/feature-token-evidence-reader';
import type { FeatureTokenEvidence } from '@/features/operational-intelligence/services/feature-token-evidence';

const ROLE = 'feature_evidence_reader_runtime';
const OWNER = 'fixture-reader-owner';
const OTHER = 'fixture-other-reader-owner';
const NOW = Date.now();
const START = new Date(NOW - 60_000).toISOString();
const END = new Date(NOW - 1_000).toISOString();
const FROM = new Date(NOW - 86_400_000).toISOString();
const UNTIL = new Date(NOW + 86_400_000).toISOString();

const migration = readFileSync(
  resolve(__dirname, '../../scripts/migrations/182-feature-token-evidence.sql'),
  'utf8',
);

const fixture = new DisposablePostgres({
  purpose: 'feature-token-evidence-reader',
  memory: '256m',
  max: 2,
  roles: [{ name: ROLE, max: 2 }],
  migrations: [
    '005-conversation-history-and-usage.sql',
    '055-chat-tasks-owner-sub.sql',
    '078-cost-governance.sql',
    '090-cost-event-tokens-duration.sql',
    '112-owner-column-rls.sql',
    '115-durable-remote-task-journal.sql',
  ],
});

let admin: Pool;
let runtime: Pool;

const as = <T>(sub: string, fn: () => Promise<T>) =>
  runWithRequestIdentity({ sub, isOperator: false }, fn);

function createEvidence(operationId = randomUUID()): FeatureTokenEvidence {
  return {
    version: 1,
    producerId: 'fixture-producer',
    applicationId: 'fixture-package',
    featureId: 'rank-jobs',
    unit: 'one posting',
    workloadId: 'fixture-workload',
    coreSha: 'a'.repeat(40),
    storeSha: 'b'.repeat(40),
    operationId,
    memberId: randomUUID(),
    memberIndex: 1,
    startedAt: START,
    tokenProvenance: 'provider-reported',
    requestCount: 2,
    completion: { memberCount: 1, completedAt: END },
  };
}

beforeAll(async () => {
  admin = await fixture.start();
  for (const sql of buildOwnerRlsPolicyStatements('chat_tasks', 'owner_sub')) {
    await admin.query(sql);
  }
  for (const table of ['chat_tasks', 'oshal_cost_events', 'remote_task_cost_receipts']) {
    await admin.query(`ALTER TABLE ${table} OWNER TO ${ROLE}`);
  }
  await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);
  await admin.query(migration);
  runtime = wrapPoolWithGuc(fixture.rolePool(ROLE));
}, 120_000);

afterAll(async () => {
  await fixture.stop();
}, 60_000);

describe('readOwnFeatureTokenEvidence / real PostgreSQL companion', () => {
  it('reads and reduces real owner rows into measured profiles under FORCE RLS', async () => {
    const operationId = randomUUID();
    const taskId = randomUUID();
    const ev = createEvidence(operationId);

    // Insert as OWNER
    await as(OWNER, () =>
      runtime.query(
        `INSERT INTO oshal_cost_events (
           task_id, owner_sub, provider_id, model_id,
           input_tokens, output_tokens, cost_usd, feature_evidence
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          taskId,
          OWNER,
          'provider-test',
          'model-test',
          100,
          25,
          0.05,
          JSON.stringify(ev),
        ],
      ),
    );

    const input: ReadFeatureTokenEvidenceInput = {
      ownerSub: OWNER,
      from: FROM,
      until: UNTIL,
    };

    const result = await as(OWNER, () =>
      readOwnFeatureTokenEvidence(runtime, input),
    );

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.report.profiles).toHaveLength(1);
      const profile = result.report.profiles[0];
      expect(profile.featureId).toBe('rank-jobs');
      expect(profile.operations).toBe(1);
      expect(profile.tokensPerOperation.p50).toBe(125);
    }
  });

  it('enforces owner isolation: other owner cannot read or reduce rows under FORCE RLS', async () => {
    const input: ReadFeatureTokenEvidenceInput = {
      ownerSub: OTHER,
      from: FROM,
      until: UNTIL,
    };

    const result = await as(OTHER, () =>
      readOwnFeatureTokenEvidence(runtime, input),
    );

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.report.profiles).toHaveLength(0);
      expect(result.report.unattributedRows).toBe(0);
    }
  });

  it('recovers schema unavailable gracefully when migration 182 is dropped', async () => {
    // Drop feature_evidence column on disposable fixture
    await admin.query('ALTER TABLE oshal_cost_events DROP COLUMN feature_evidence CASCADE');

    try {
      const input: ReadFeatureTokenEvidenceInput = {
        ownerSub: OWNER,
        from: FROM,
        until: UNTIL,
      };

      const result = await as(OWNER, () =>
        readOwnFeatureTokenEvidence(runtime, input),
      );

      expect(result).toEqual({
        status: 'unavailable',
        reason: 'schema_unavailable',
      });
    } finally {
      // Restore migration 182
      await admin.query(migration);
    }
  });
});
