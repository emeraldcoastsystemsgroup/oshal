/**
 * Kalshi grader — reality scores the predictions.
 *
 * Two jobs, both essential to the forward test:
 *   1. GRADE PREDICTIONS: for every pre-registered prediction whose market has settled, record the
 *      outcome, our Brier score, THE MARKET'S Brier score on the same market, and the realized P&L
 *      per contract. Beating the market's Brier is the ONLY thing that counts as an edge — being
 *      "well calibrated" while the market is better calibrated is worth exactly $0.
 *   2. CLOSE THE FORECAST LOOP: fill in the observed high for every logged NWS forecast whose day
 *      has passed. Those (forecast, actual) pairs ARE the error model — this is the step that
 *      turns an assumed sigma into a measured one, and therefore the step that lets the weather
 *      strategy ever size a real bet.
 *
 * Run: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-kalshi-grade.ts
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — settlement grading (Brier vs the market's Brier, realized P&L) + observed-high backfill that grows the forecast-error model.
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { hostDatabaseUrl } from './kalshi-db-url';
import { feePerContract, getObservedHigh, kalshiGet } from '../src/features/prediction-markets';

interface RawMarket { ticker?: string; status?: string; result?: string }

/** Settlement result for one ticker: true = YES, false = NO, null = not settled yet. */
async function settlementOf(ticker: string): Promise<boolean | null> {
  try {
    const body = await kalshiGet<{ market?: RawMarket }>(`/markets/${encodeURIComponent(ticker)}`);
    const m = body.market || {};
    if (m.result === 'yes') return true;
    if (m.result === 'no') return false;
    return null;
  } catch {
    return null;
  }
}

async function gradePredictions(pool: Pool): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, ticker, side, predicted_prob, market_prob, stake_fraction
     FROM kalshi_predictions
     WHERE settled = false AND close_time < now()
     ORDER BY close_time ASC LIMIT 500`,
  );
  console.log(`[grade] ${rows.length} predictions past close and awaiting settlement`);
  let graded = 0;
  for (const r of rows) {
    const settledYes = await settlementOf(r.ticker);
    if (settledYes === null) continue; // closed but not yet settled — try again next run

    // Our side won iff (side=yes AND settled yes) or (side=no AND settled no).
    const sideWon = r.side === 'yes' ? settledYes : !settledYes;
    const outcome = sideWon ? 1 : 0;
    const p = Number(r.predicted_prob);         // our P(our side wins)
    const mkt = Number(r.market_prob);           // market's implied P(our side wins) = its ask
    const brier = (p - outcome) ** 2;
    const marketBrier = (mkt - outcome) ** 2;
    // P&L of buying our side at the ask: win → $1 − price − fee; lose → −(price + fee).
    const fee = feePerContract(mkt, { feeType: 'quadratic', feeMultiplier: 1 });
    const pnl = sideWon ? 1 - mkt - fee : -(mkt + fee);

    await pool.query(
      `UPDATE kalshi_predictions
       SET settled = true, settled_yes = $1, brier = $2, market_brier = $3,
           pnl_per_contract = $4, graded_at = now()
       WHERE id = $5`,
      [settledYes, brier, marketBrier, pnl, r.id],
    );
    graded += 1;
  }
  console.log(`[grade] graded ${graded} predictions`);
}

async function backfillObservations(pool: Pool): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, series_ticker, target_date FROM kalshi_forecast_log
     WHERE actual_f IS NULL AND target_date < CURRENT_DATE
     ORDER BY target_date ASC LIMIT 300`,
  );
  console.log(`[grade] ${rows.length} logged forecasts awaiting their observed high`);
  let filled = 0;
  for (const r of rows) {
    const dateIso = new Date(r.target_date).toISOString().slice(0, 10);
    const actual = await getObservedHigh(r.series_ticker, dateIso).catch(() => null);
    if (actual === null) continue;
    await pool.query(`UPDATE kalshi_forecast_log SET actual_f = $1 WHERE id = $2`, [actual.toFixed(1), r.id]);
    filled += 1;
  }
  console.log(`[grade] filled ${filled} observed highs — the error model just got that much sharper`);
}

async function report(pool: Pool): Promise<void> {
  const { rows } = await pool.query(
    `SELECT strategy,
            count(*)                    AS n,
            avg(brier)                  AS model_brier,
            avg(market_brier)           AS market_brier,
            avg(pnl_per_contract)       AS avg_pnl,
            sum(pnl_per_contract)       AS total_pnl,
            avg(CASE WHEN (side='yes') = settled_yes THEN 1.0 ELSE 0.0 END) AS hit_rate
     FROM kalshi_predictions WHERE settled = true GROUP BY strategy`,
  );
  console.log('\n=== FORWARD-TEST SCORECARD (settled predictions only) ===');
  if (!rows.length) {
    console.log('  no settled predictions yet — the loop needs a day to produce its first score.');
  }
  for (const r of rows) {
    const mb = Number(r.model_brier), kb = Number(r.market_brier);
    const beat = mb < kb;
    console.log(`\n  strategy: ${r.strategy}   (n=${r.n})`);
    console.log(`    hit rate ........ ${(Number(r.hit_rate) * 100).toFixed(1)}%`);
    console.log(`    our Brier ....... ${mb.toFixed(4)}   (lower is better)`);
    console.log(`    market Brier .... ${kb.toFixed(4)}   ← THE BAR`);
    console.log(`    verdict ......... ${beat ? '✅ beating the market' : '❌ NOT beating the market'}`);
    console.log(`    P&L/contract .... $${Number(r.avg_pnl).toFixed(4)}  (total $${Number(r.total_pnl).toFixed(2)})`);
  }

  const { rows: cells } = await pool.query(
    `SELECT series_ticker, lead_days, enso_phase, count(*) AS n,
            avg(actual_f - forecast_f) AS bias, stddev_samp(actual_f - forecast_f) AS sigma
     FROM kalshi_forecast_log WHERE actual_f IS NOT NULL
     GROUP BY series_ticker, lead_days, enso_phase HAVING count(*) >= 5
     ORDER BY count(*) DESC LIMIT 10`,
  );
  if (cells.length) {
    console.log('\n=== FORECAST-ERROR MODEL (measured, per city/lead/ENSO) ===');
    for (const c of cells) {
      console.log(`  ${c.series_ticker} lead ${c.lead_days}d ${c.enso_phase}: n=${c.n} bias ${Number(c.bias).toFixed(2)}°F σ ${Number(c.sigma || 0).toFixed(2)}°F`);
    }
    console.log('  (30+ samples in a cell unlocks a MEASURED sigma → the strategy may then size a bet)');
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: hostDatabaseUrl() });
  await backfillObservations(pool);
  await gradePredictions(pool);
  await report(pool);
  await pool.end();
}

main().then(() => { process.exitCode = 0; }).catch((err) => { console.error('[grade] FAILED', err); process.exitCode = 1; });
