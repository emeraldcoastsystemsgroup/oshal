/**
 * Kalshi forward test — make pre-registered predictions, then live with them.
 *
 * This is the anti-dredging harness. Every run:
 *   1. Reads the CURRENT ENSO state (NOAA ONI).
 *   2. Pulls the NWS forecast for each Kalshi weather city and LOGS it (forecast, target date) —
 *      the forecast-error model can only be grown forward, so logging is how the moat gets built.
 *   3. Builds each (city, lead, ENSO) error model from the pairs collected SO FAR.
 *   4. Prices every temperature bucket, finds +EV bets, and WRITES THE PREDICTION TO THE DB
 *      BEFORE the outcome is known (unique on (strategy, ticker) — it can never be revised).
 *   5. Optionally paper-trades the pick on the DEMO exchange.
 *
 * The prediction is the commitment. `oshal-kalshi-grade.ts` scores it against reality later, and
 * the model only earns a stake once its σ is MEASURED rather than assumed.
 *
 * Run: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-kalshi-forward.ts [--trade]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ENSO + NWS forecast logging, error-model build from collected pairs, pre-registered prediction writes, optional demo paper-trading.
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { hostDatabaseUrl } from './kalshi-db-url';
import {
  buildErrorModel, evaluateWeatherMarkets, getEnsoState, getForecastHigh, listMarkets,
  parseBucket, parseMarketDate, WEATHER_CITIES, type ForecastErrorSample, type WeatherMarket, type WeatherPick,
} from '../src/features/prediction-markets';

const TRADE = process.argv.includes('--trade');
const STRATEGY = 'weather-enso';

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Target dates we forecast for: today + the next 2 days (the NWS window with usable skill). */
function targetDates(): string[] {
  const out: string[] = [];
  for (let i = 0; i <= 2; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function loadSamples(pool: Pool): Promise<ForecastErrorSample[]> {
  const { rows } = await pool.query(
    `SELECT series_ticker, lead_days, enso_phase, forecast_f, actual_f
     FROM kalshi_forecast_log WHERE actual_f IS NOT NULL`,
  );
  return rows.map((r) => ({
    seriesTicker: r.series_ticker, leadDays: r.lead_days, ensoPhase: r.enso_phase,
    forecastF: Number(r.forecast_f), actualF: Number(r.actual_f),
  }));
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: hostDatabaseUrl() });
  const enso = await getEnsoState();
  console.log(`[forward] ENSO: ${enso.phase.toUpperCase()} (ONI ${enso.oni >= 0 ? '+' : ''}${enso.oni}, ${enso.season} ${enso.year})`);

  const samples = await loadSamples(pool);
  console.log(`[forward] forecast-error samples collected so far: ${samples.length}`);

  const allPicks: WeatherPick[] = [];
  let logged = 0;

  for (const [seriesTicker, city] of Object.entries(WEATHER_CITIES)) {
    for (const date of targetDates()) {
      let fc;
      try {
        fc = await getForecastHigh(seriesTicker, date);
      } catch (err) {
        console.error(`[forward] NWS forecast failed ${seriesTicker} ${date}: ${(err as Error).message}`);
        continue;
      }
      if (!fc) continue;

      // Log the forecast BEFORE the day resolves — this is the error model's raw material.
      await pool.query(
        `INSERT INTO kalshi_forecast_log (series_ticker, target_date, lead_days, enso_phase, oni, forecast_f)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (series_ticker, target_date, lead_days) DO NOTHING`,
        [seriesTicker, date, fc.leadDays, enso.phase, enso.oni, fc.forecastF],
      );
      logged += 1;

      const model = buildErrorModel(samples, seriesTicker, fc.leadDays, enso.phase);
      const raw = await listMarkets({ status: 'open', seriesTicker }, 200).catch(() => []);
      const markets: WeatherMarket[] = [];
      for (const m of raw) {
        const b = parseBucket(m);
        if (!b || !m.closeTime) continue;
        // The market's target date comes from its TICKER, never close_time: a daily temp market
        // closes ~05:00 UTC the NEXT day, so close_time's date is one day late. Matching on it
        // priced Jul-14 markets with the Jul-15 forecast (+55¢ of pure fiction).
        if (parseMarketDate(m.ticker) !== date) continue;
        markets.push({
          ticker: m.ticker, seriesTicker, eventTicker: m.eventTicker, title: m.title,
          loF: b.loF, hiF: b.hiF, yesAsk: m.yesAsk, yesBid: m.yesBid, noAsk: m.noAsk,
          volume: m.volume, closeTime: m.closeTime.toISOString(),
        });
      }
      if (!markets.length) continue;

      const picks = evaluateWeatherMarkets(markets, fc.forecastF, fc.leadDays, model, enso);
      if (picks.length) {
        console.log(`[forward] ${city.city} ${date}: NWS ${fc.forecastF}°F (lead ${fc.leadDays}d, σ=${model.sigma.toFixed(1)}°${model.isPrior ? ' PRIOR' : ` measured n=${model.n}`}) → ${picks.length} picks`);
      }
      allPicks.push(...picks);
    }
  }

  console.log(`\n[forward] logged ${logged} forecasts; ${allPicks.length} +EV picks found\n`);

  // Pre-register every prediction. ON CONFLICT DO NOTHING = a prediction is immutable once made.
  let recorded = 0;
  for (const p of allPicks) {
    const r = await pool.query(
      `INSERT INTO kalshi_predictions
        (strategy, ticker, event_ticker, series_ticker, predicted_prob, market_prob, edge_net,
         stake_fraction, side, rationale, close_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (strategy, ticker) DO NOTHING RETURNING id`,
      [STRATEGY, p.ticker, p.eventTicker, p.seriesTicker, p.modelProb, p.marketProb, p.edgeNet,
        p.stakeFraction, p.side, JSON.stringify(p.rationale), p.closeTime],
    );
    if ((r.rowCount ?? 0) > 0) recorded += 1;
  }
  console.log(`[forward] pre-registered ${recorded} NEW predictions (duplicates left untouched — a prediction is immutable)`);

  const sized = allPicks.filter((p) => p.stakeFraction > 0);
  for (const p of allPicks.slice(0, 12)) {
    const flag = p.stakeFraction > 0 ? `stake ${(p.stakeFraction * 100).toFixed(2)}%` : 'NO STAKE (σ unmeasured)';
    console.log(`  ${p.side.toUpperCase().padEnd(3)} @ ${(p.price * 100).toFixed(0)}¢  model ${(p.modelProb * 100).toFixed(0)}%  edge +${(p.edgeNet * 100).toFixed(1)}¢  ${flag}  ${p.ticker}`);
    console.log(`      ${p.title.slice(0, 78)}`);
  }

  if (TRADE && !sized.length) {
    console.log('\n[forward] --trade requested but NOTHING is sized: the forecast-error model is still the untested prior.');
    console.log('[forward] This is the refusal rule working. Let the forecast log grow, then trade a MEASURED sigma.');
  }
  await pool.end();
}

main().then(() => { process.exitCode = 0; }).catch((err) => { console.error('[forward] FAILED', err); process.exitCode = 1; });
