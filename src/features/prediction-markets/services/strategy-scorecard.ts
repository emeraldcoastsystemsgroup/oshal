/**
 * Strategy scorecard — the loop that lets EVIDENCE size the bets.
 *
 * Forward-scoring predictions is only half a feedback loop. Without this module, a strategy could
 * be graded as worse-than-the-market forever and still cheerfully suggest stakes — measuring
 * something you never act on is theatre. This is the half that acts.
 *
 * THE RULE (a strategy must EARN the right to stake):
 *
 *     UNPROVEN  — fewer than MIN_GRADED settled predictions.       → stake 0
 *     FAILING   — enough evidence, and its Brier is NOT better
 *                 than the market's on the same markets.           → stake 0  (auto-retired)
 *     PROVEN    — enough evidence, and it BEATS the market's Brier. → stake allowed
 *
 * Brier vs THE MARKET'S Brier is the only bar that means anything. A strategy that is
 * "well calibrated" while the market is better calibrated has no edge and is worth exactly $0 —
 * it would simply pay the spread for the privilege of agreeing.
 *
 * Note the default posture: a brand-new strategy is UNPROVEN, so it stakes NOTHING until reality
 * has spoken. Optimism must be earned, not assumed — which is precisely the discipline the
 * refuted calibration strategy lacked.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-strategy settled-performance rollup and the UNPROVEN/FAILING/PROVEN staking gate, so a strategy that loses to the market is automatically retired instead of quietly kept on.
 *
 * @module prediction-markets/strategy-scorecard
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const log = createChildLogger({ module: 'strategy-scorecard' });

/** Settled predictions required before a strategy's score means anything. */
const MIN_GRADED = Number(process.env.KALSHI_MIN_GRADED) || 30;

/** Whether a strategy is allowed to size a bet, and why. */
export type StrategyStatus = 'unproven' | 'failing' | 'proven';

/** One strategy's forward-test record. */
export interface StrategyScore {
  strategy: string;
  status: StrategyStatus;
  /** Settled (graded) predictions behind the score. */
  graded: number;
  /** Predictions made but not yet settled. */
  pending: number;
  /** Mean Brier score — lower is better. Null before anything settles. */
  brier: number | null;
  /** The market's mean Brier on those SAME markets — the bar. */
  marketBrier: number | null;
  /** Fraction of picks that resolved our way. */
  hitRate: number | null;
  /** Realized $ per contract, had every pick been taken at its ask. */
  pnlPerContract: number | null;
  /** True when the strategy may size a real stake. */
  mayStake: boolean;
  /** Human-readable justification — shown on the surface, never silently applied. */
  reason: string;
}

/**
 * @description Score every strategy that has ever made a prediction, and decide which may stake.
 * @param pool - Postgres pool.
 * @returns One score per strategy.
 */
export async function getScorecard(pool: Pool): Promise<StrategyScore[]> {
  const { rows } = await pool.query(
    `SELECT strategy,
            count(*) FILTER (WHERE settled)                         AS graded,
            count(*) FILTER (WHERE NOT settled)                     AS pending,
            avg(brier)         FILTER (WHERE settled)               AS brier,
            avg(market_brier)  FILTER (WHERE settled)               AS market_brier,
            avg(CASE WHEN (side='yes') = settled_yes THEN 1.0 ELSE 0.0 END) FILTER (WHERE settled) AS hit_rate,
            avg(pnl_per_contract) FILTER (WHERE settled)            AS pnl
     FROM kalshi_predictions GROUP BY strategy ORDER BY strategy`,
  );
  return rows.map((r) => {
    const graded = Number(r.graded);
    const brier = r.brier === null ? null : Number(r.brier);
    const marketBrier = r.market_brier === null ? null : Number(r.market_brier);
    let status: StrategyStatus;
    let reason: string;
    if (graded < MIN_GRADED || brier === null || marketBrier === null) {
      status = 'unproven';
      reason = `UNPROVEN — ${graded}/${MIN_GRADED} settled predictions. Stakes are zero until reality has graded enough of them.`;
    } else if (brier >= marketBrier) {
      status = 'failing';
      reason = `FAILING — over ${graded} settled predictions its Brier (${brier.toFixed(4)}) is no better than the market's (${marketBrier.toFixed(4)}). No edge; stakes forced to zero.`;
    } else {
      status = 'proven';
      reason = `PROVEN — over ${graded} settled predictions it beats the market's Brier (${brier.toFixed(4)} vs ${marketBrier.toFixed(4)}). Staking permitted.`;
    }
    return {
      strategy: r.strategy, status, graded, pending: Number(r.pending),
      brier, marketBrier,
      hitRate: r.hit_rate === null ? null : Number(r.hit_rate),
      pnlPerContract: r.pnl === null ? null : Number(r.pnl),
      mayStake: status === 'proven', reason,
    };
  });
}

/**
 * @description May this strategy size a real stake right now? Defaults to NO for a strategy that
 * has never been scored — a new idea does not get to bet on its own say-so.
 * @param pool - Postgres pool.
 * @param strategy - Strategy name.
 * @returns The gate decision plus its reason.
 */
export async function mayStrategyStake(pool: Pool, strategy: string): Promise<{ mayStake: boolean; reason: string }> {
  const scores = await getScorecard(pool).catch((err) => {
    log.error({ err, strategy }, 'scorecard lookup failed — failing CLOSED (no stake)');
    return [] as StrategyScore[];
  });
  const s = scores.find((x) => x.strategy === strategy);
  if (!s) {
    return { mayStake: false, reason: `UNPROVEN — "${strategy}" has no graded predictions yet. Stakes are zero until it earns them.` };
  }
  return { mayStake: s.mayStake, reason: s.reason };
}
