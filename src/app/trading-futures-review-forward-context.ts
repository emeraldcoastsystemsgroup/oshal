/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Freeze bounded owner-qualified forward evidence separately from historical research, with reproducible citations and honest cohort denominators.
 */
import { z } from 'zod';
import type { Pool } from 'pg';
import type { FuturesResearchRun } from './trading-futures-research-dispatch';
import { fingerprintFuturesEvidence } from './trading-futures-prediction-evidence';

const iso = z.string().datetime({ offset: true });
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const receiptSchema = z.object({
  predictionId: z.string().uuid(), root: z.string().regex(/^[A-Z0-9]{1,8}$/), contract: z.string().regex(/^[A-Z0-9]+[FGHJKMNQUVXZ]\d{2}$/),
  fingerprint: sha, issuedAt: iso,
  status: z.enum(['pending','unavailable','withheld','abstained','graded']),
  model: z.string().max(64).nullable(), studyFingerprint: sha.nullable(), horizonHours: z.number().int().min(1).max(168).nullable(),
  direction: z.enum(['long','short']).nullable(),
  outcome: z.object({ closedAt: iso, close: finite, priceChange: finite, signedTicks: finite, correct: z.boolean().nullable() }).strict().nullable(),
}).strict();

/** @description Safe provider facts, not source paths, identity claims, raw errors or editable prediction inputs. */
export type FuturesForwardReviewReceipt = z.infer<typeof receiptSchema>;
/** @description Counts for the bounded visible sample only; never extrapolated to all owner history. */
export interface FuturesForwardCounts {
  graded: number; matched: number; missed: number; flat: number;
  pending: number; unavailable: number; withheld: number; abstained: number;
}
/** @description Do not pool unrelated contract, model, study or horizon cohorts into a claimed strategy accuracy. */
export interface FuturesForwardCohort {
  root: string; contract: string; model: string | null; studyFingerprint: string | null; horizonHours: number | null;
  counts: FuturesForwardCounts;
}
/** @description An attempt-bound immutable context; capturedAt is not part of the stable evidence fingerprint. */
export interface FuturesForwardReviewContext {
  version: 1; capturedAt: string; availability: 'available' | 'schema_missing';
  roots: string[]; limitPerStateGroup: 25;
  available: { graded: number; other: number }; counts: FuturesForwardCounts;
  cohorts: FuturesForwardCohort[]; receipts: FuturesForwardReviewReceipt[];
  fingerprint: string; settledFingerprint: string;
}

function emptyCounts(): FuturesForwardCounts {
  return { graded: 0, matched: 0, missed: 0, flat: 0, pending: 0, unavailable: 0, withheld: 0, abstained: 0 };
}
function countInto(counts: FuturesForwardCounts, row: FuturesForwardReviewReceipt): void {
  counts[row.status]++;
  if (row.status === 'graded') counts[row.outcome!.correct === null ? 'flat' : row.outcome!.correct ? 'matched' : 'missed']++;
}
function cohortsFor(receipts: FuturesForwardReviewReceipt[]): FuturesForwardCohort[] {
  const cohorts = new Map<string, FuturesForwardCohort>();
  for (const receipt of receipts) {
    const { root, contract, model, studyFingerprint, horizonHours } = receipt;
    const key = JSON.stringify([root, contract, model, studyFingerprint, horizonHours]);
    let cohort = cohorts.get(key);
    if (!cohort) { cohort = { root, contract, model, studyFingerprint, horizonHours, counts: emptyCounts() }; cohorts.set(key, cohort); }
    countInto(cohort.counts, receipt);
  }
  return [...cohorts.values()];
}
function parseReceipt(row: Record<string, any>): FuturesForwardReviewReceipt {
  const receipt = receiptSchema.parse({ predictionId: row.prediction_id, root: row.root, contract: row.contract,
    fingerprint: row.fingerprint, issuedAt: new Date(row.issued_at).toISOString(), status: row.status,
    model: row.model ?? null, studyFingerprint: row.study_fingerprint ?? null, horizonHours: row.horizon_hours ?? null,
    direction: row.direction ?? null, outcome: row.status === 'graded' ? {
      closedAt: row.closed_at, close: row.close, priceChange: row.price_change, signedTicks: row.signed_ticks, correct: row.correct,
    } : null });
  if (receipt.status === 'graded') {
    const result = receipt.outcome!;
    const target = Date.parse(receipt.issuedAt) + Number(receipt.horizonHours) * 3_600_000;
    if (!receipt.direction || !receipt.model || !receipt.studyFingerprint || !receipt.horizonHours
      || Date.parse(result.closedAt) < target || Date.parse(result.closedAt) > Date.now()
      || result.correct !== (result.signedTicks === 0 ? null : result.signedTicks > 0)) {
      throw new Error('Forward ledger has inconsistent graded evidence; do not send it as performance');
    }
  }
  return receipt;
}

/** @description Freeze latest 25 graded and latest 25 other receipts in one database snapshot, under exact caller ownership.
 * @param pool - Application pool. @param run - Owned study; only its configured roots enter the context.
 * @returns Bounded safe facts and canonical citations. Missing schema is explicit, not a zero-success sample.
 */
export async function captureFuturesForwardContext(pool: Pick<Pool, 'query'>, run: FuturesResearchRun): Promise<FuturesForwardReviewContext> {
  const present = (await pool.query("SELECT to_regclass('public.oshal_trading_futures_predictions') IS NOT NULL AS present")).rows[0]?.present;
  const roots = [...run.config.roots].sort();
  const rows = present ? (await pool.query(`WITH candidates AS (
    SELECT prediction_id,root,contract,fingerprint,status,issued_at,
      snapshot->>'model' AS model, snapshot->>'studyFingerprint' AS study_fingerprint,
      snapshot->'horizonHours' AS horizon_hours, snapshot#>>'{observation,bias}' AS direction,
      outcome#>>'{bar,closedAt}' AS closed_at, outcome#>'{bar,bar,c}' AS close,
      outcome->'priceChange' AS price_change, outcome->'signedTicks' AS signed_ticks, outcome->'correct' AS correct,
      count(*) OVER (PARTITION BY status='graded') AS available_count,
      row_number() OVER (PARTITION BY status='graded' ORDER BY issued_at DESC,prediction_id) AS rank
    FROM oshal_trading_futures_predictions WHERE owner_sub=$1 AND root=ANY($2::text[])
  ) SELECT * FROM candidates WHERE rank<=25 ORDER BY (status='graded') DESC,issued_at DESC,prediction_id`, [run.ownerSub, roots])).rows : [];
  const receipts = rows.map(parseReceipt), counts = emptyCounts();
  for (const row of receipts) countInto(counts, row);
  const available = { graded: Number(rows.find(row => row.status === 'graded')?.available_count ?? 0), other: Number(rows.find(row => row.status !== 'graded')?.available_count ?? 0) };
  const body = { version: 1 as const, availability: present ? 'available' as const : 'schema_missing' as const, roots,
    limitPerStateGroup: 25 as const, available, counts, cohorts: cohortsFor(receipts), receipts };
  return { ...body, capturedAt: new Date().toISOString(), fingerprint: fingerprintFuturesEvidence(body),
    settledFingerprint: fingerprintFuturesEvidence({ availability: body.availability, roots, availableGraded: available.graded, receipts: receipts.filter(row => row.status === 'graded') }) };
}

/** @description Bind review spending to changed historical or settled forward evidence, not clock ticks or fresh pending calls.
 * @param run - Owned completed study. @param forward - Frozen forward context. @returns Stable comparison key for nightly admission.
 */
export function futuresReviewEvidenceKey(run: FuturesResearchRun, forward: FuturesForwardReviewContext): string {
  return fingerprintFuturesEvidence({ markets: run.markets.map(market => [market.root, market.evidenceFingerprint]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), forward: forward.settledFingerprint });
}
