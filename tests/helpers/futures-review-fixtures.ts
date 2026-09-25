/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Explicit synthetic forward receipts and reason-only replies for private-database review tests; never a production issuance API.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { fingerprintFuturesEvidence } from '@/app/trading-futures-prediction-evidence';

interface ReceiptOptions {
  owner: string; root?: string; contract?: string; model?: string; study?: string; horizon?: number;
  status?: 'pending' | 'graded' | 'withheld' | 'abstained' | 'unavailable'; ticks?: number;
  issuedAt?: string; closedAt?: string;
}
const issued = '2026-01-01T00:00:00.000Z';
function outcome(ticks: number, closedAt = '2026-01-01T04:00:00.000Z') {
  return { bar: { closedAt, bar: { c: 5000 + ticks / 4 } }, priceChange: ticks / 4, signedTicks: ticks, correct: ticks === 0 ? null : ticks > 0 };
}
/** @description Insert synthetic historical issuance only in DisposablePostgres, not through the production receipt API.
 * @param pool - Privately owned fixture database. @param options - Explicit synthetic facts. @returns Fixture receipt ID.
 */
export async function insertForwardReceipt(pool: Pool, options: ReceiptOptions): Promise<string> {
  const id = randomUUID(), status = options.status ?? 'pending';
  const snapshot = status === 'withheld' ? null : {
    model: options.model ?? 'locked-fixture', studyFingerprint: options.study ?? 'd'.repeat(64), horizonHours: options.horizon ?? 1,
    observation: { bias: status === 'abstained' ? null : 'long' }, reference: { closedAt: '2025-12-31T23:00:00.000Z' },
    dataDir: 'PRIVATE_PATH_SENTINEL', credential: 'PRIVATE_CREDENTIAL_SENTINEL', owner: 'PRIVATE_IDENTITY_SENTINEL',
  };
  await pool.query(`INSERT INTO oshal_trading_futures_predictions
    (prediction_id,owner_sub,schedule_id,run_id,root,contract,fingerprint,status,snapshot,reason,outcome,issued_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12)`,
  [id, options.owner, randomUUID(), randomUUID(), options.root ?? 'ES', options.contract ?? 'ESZ26',
    fingerprintFuturesEvidence({ id }), status, snapshot === null ? null : JSON.stringify(snapshot), 'PRIVATE_ERROR_SENTINEL',
    JSON.stringify(status === 'graded' ? outcome(options.ticks ?? 4, options.closedAt) : null), options.issuedAt ?? issued]);
  return id;
}
/** @description Settle a private fixture through the real immutable-ledger trigger.
 * @param pool - Privately owned fixture database. @param id - Synthetic receipt ID. @param ticks - Directional fixture result. @returns Settlement completion.
 */
export async function settleForwardReceipt(pool: Pool, id: string, ticks: number): Promise<void> {
  await pool.query("UPDATE oshal_trading_futures_predictions SET status='graded',outcome=$2::jsonb,checked_at=clock_timestamp() WHERE prediction_id=$1",
    [id, JSON.stringify(outcome(ticks))]);
}
/** @description Echo only exact supplied citations; inference is a fixture, not a real provider call.
 * @param prompt - Production bounded prompt. @returns Synthetic strict review JSON.
 */
export function replyWithForwardContext(prompt: string): string {
  const facts = JSON.parse(prompt.split('\n').at(-1)!);
  return JSON.stringify({ summary: 'Historical and forward fixture evidence are separate.', limitations: ['Small overlapping cohorts, not a profitability claim.'],
    evidence: facts.markets.map((market: { root: string; evidenceFingerprint: string }) => ({ root: market.root, fingerprint: market.evidenceFingerprint })),
    forwardAssessment: facts.forwardContext?.receipts.length ? { contextFingerprint: facts.forwardContext.fingerprint, summary: 'These supplied fixture outcomes are exploratory.' } : null,
    nextStudy: null });
}
