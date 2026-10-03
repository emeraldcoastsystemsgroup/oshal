/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-170 P0: Authorize and read own feature token evidence rows under owner RLS, projecting complete operation members with overflow protection.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  aggregateFeatureTokenEvidence,
  type FeatureTokenEvidenceRow,
  type FeatureTokenReport,
} from './feature-token-evidence';

const logger = createChildLogger({ module: 'feature-token-evidence-reader' });

export const MAX_FEATURE_TOKEN_EVIDENCE_ROWS = 100_000;

export interface ReadFeatureTokenEvidenceInput {
  ownerSub: string;
  from: string;
  until: string;
}

export type FeatureTokenEvidenceReadResult =
  | { status: 'success'; report: FeatureTokenReport }
  | { status: 'unavailable'; reason: 'schema_unavailable' };

export class FeatureTokenEvidenceOverflowError extends Error {
  readonly code = 'FEATURE_TOKEN_EVIDENCE_OVERFLOW';
  constructor(rowCount: number) {
    super(`Evidence exceeds maximum ${MAX_FEATURE_TOKEN_EVIDENCE_ROWS} row capacity (${rowCount} rows); refused without partial profiles.`);
    this.name = 'FeatureTokenEvidenceOverflowError';
  }
}

export class FeatureTokenEvidenceInputError extends Error {
  readonly code = 'FEATURE_TOKEN_EVIDENCE_INPUT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'FeatureTokenEvidenceInputError';
  }
}

import type { QueryResult, QueryResultRow } from 'pg';

export interface FeatureTokenEvidenceQueryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * @description Reads and reduces feature token evidence rows for one authenticated non-system owner.
 * Preserves the full owner ledger snapshot before passing to the reducer so outside-window operation
 * members, duplicate UUIDs, or conflicting bindings cannot be concealed.
 * @param database - Application database pool or queryable client.
 * @param input - Validated authenticated owner and time window.
 * @returns Aggregated feature token report or an unavailable status when schema is unmigrated.
 * @throws FeatureTokenEvidenceInputError when input is invalid or owner is system.
 * @throws FeatureTokenEvidenceOverflowError when rows exceed 100,000.
 */
export async function readOwnFeatureTokenEvidence(
  database: FeatureTokenEvidenceQueryable,
  input: ReadFeatureTokenEvidenceInput,
): Promise<FeatureTokenEvidenceReadResult> {
  // Synchronous snapshot and validation before any await
  if (!input || typeof input !== 'object') {
    throw new FeatureTokenEvidenceInputError('Input must be a valid object');
  }

  const ownerSub = typeof input.ownerSub === 'string' ? input.ownerSub.trim() : '';
  if (!ownerSub || ownerSub === 'system') {
    throw new FeatureTokenEvidenceInputError('Authenticated non-system owner is required to read feature token evidence');
  }

  if (typeof input.from !== 'string' || typeof input.until !== 'string') {
    throw new FeatureTokenEvidenceInputError('from and until must be ISO date strings');
  }

  const fromDate = new Date(input.from);
  const untilDate = new Date(input.until);
  if (isNaN(fromDate.getTime()) || isNaN(untilDate.getTime()) || fromDate.getTime() > untilDate.getTime()) {
    throw new FeatureTokenEvidenceInputError('Valid [from, until] UTC window is required (from <= until)');
  }

  const fromIso = fromDate.toISOString();
  const untilIso = untilDate.toISOString();

  let result: { rows: FeatureTokenEvidenceRow[] };
  try {
    result = await database.query<FeatureTokenEvidenceRow>(
      `SELECT
         id::text AS id,
         ts,
         owner_sub,
         provider_id,
         model_id,
         input_tokens,
         output_tokens,
         feature_evidence
       FROM oshal_cost_events
       WHERE owner_sub = $1
       ORDER BY id ASC
       LIMIT $2`,
      [ownerSub, MAX_FEATURE_TOKEN_EVIDENCE_ROWS + 1],
    );
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === '42P01' || code === '42703') {
      logger.warn({ code, ownerSub }, 'Feature token evidence unavailable: schema predates migration 182');
      return { status: 'unavailable', reason: 'schema_unavailable' };
    }
    logger.error({ err, ownerSub }, 'Failed to query feature token evidence');
    throw err;
  }

  if (result.rows.length > MAX_FEATURE_TOKEN_EVIDENCE_ROWS) {
    throw new FeatureTokenEvidenceOverflowError(result.rows.length);
  }

  const report = aggregateFeatureTokenEvidence(result.rows, {
    ownerSub,
    from: fromIso,
    until: untilIso,
  });

  return { status: 'success', report };
}
