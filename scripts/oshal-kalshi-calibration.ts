/**
 * Kalshi calibration study — measure what a price ACTUALLY settles at, on Kalshi's own tape.
 *
 * Pages recently settled markets (public API, no credentials), samples each market's YES price at
 * 24h/6h/1h before close from hourly candlesticks, joins to the settlement result, and aggregates
 * price→outcome calibration buckets per category. Output: config-seed/kalshi-calibration.json
 * (the live evaluator's lookup table) + a docs/evidence pair with the honest numbers, including
 * net-of-fee EV per bucket — the favorite-longshot bias measurement that decides where edge exists.
 *
 * Run: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-kalshi-calibration.ts [maxSettled] [perCategoryCap]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — settled-market pager, stratified per-category sampling, hourly-candle horizon join (24/6/1h), calibration table + evidence writer. Markets shorter-lived than a horizon simply contribute no sample there (15-min crypto churn self-excludes; no special cases).
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import type { CalibrationSample, KalshiMarket } from '../src/features/prediction-markets';
import {
  buildCalibrationTable, effectiveCost, getCandles, listMarkets, listSeries,
} from '../src/features/prediction-markets';

const PER_SERIES_CAP = Number(process.argv[2]) || 60;
const PER_CATEGORY_CAP = Number(process.argv[3]) || 400;
const HORIZONS = [24, 6, 1];

/** Kalshi's category taxonomy — categories with no series just return empty. */
const CATEGORIES = [
  'Politics', 'Sports', 'Economics', 'Crypto', 'Climate and Weather', 'Financials',
  'Companies', 'Entertainment', 'Science and Technology', 'Health', 'World', 'Transportation',
];

function pickPrice(closeD: number | null, bid: number | null, ask: number | null): number | null {
  if (closeD !== null && closeD > 0.005 && closeD < 0.995) return closeD;
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask < 1) {
    const mid = (bid + ask) / 2;
    if (mid > 0.005 && mid < 0.995) return mid;
  }
  return null;
}

async function sampleMarket(m: KalshiMarket, category: string): Promise<CalibrationSample[]> {
  if (!m.closeTime || !m.openTime) return [];
  const closeS = Math.floor(m.closeTime.getTime() / 1000);
  const openS = Math.floor(m.openTime.getTime() / 1000);
  const candles = await getCandles(m.seriesTicker, m.ticker, closeS - 26 * 3600, closeS, 60);
  if (candles.length === 0) return [];
  const out: CalibrationSample[] = [];
  for (const h of HORIZONS) {
    const targetTs = closeS - h * 3600;
    if (targetTs < openS + 1800) continue; // market wasn't meaningfully alive at this horizon
    let best = null as (typeof candles)[number] | null;
    for (const c of candles) if (c.endPeriodTs <= targetTs && (!best || c.endPeriodTs > best.endPeriodTs)) best = c;
    if (!best) continue;
    const price = pickPrice(best.close, best.yesBidClose, best.yesAskClose);
    if (price === null) continue;
    out.push({ ticker: m.ticker, category, horizonHours: h, price, settledYes: m.result === 'yes' });
  }
  return out;
}

function evidenceMarkdown(tableJson: string, samples: CalibrationSample[], settledSeen: number, sampled: number, catCounts: Record<string, number>): string {
  const table = JSON.parse(tableJson) as ReturnType<typeof buildCalibrationTable>;
  const lines: string[] = [];
  lines.push('# Kalshi price→outcome calibration — 2026-07-13');
  lines.push('');
  lines.push('**What this is:** empirical settle-YES rate per price bucket, from Kalshi\'s own settled-market tape');
  lines.push('(public API). This is the ground truth behind the bet evaluator: a bucket whose settle rate beats its');
  lines.push('price **plus the taker fee** is where a mechanical edge exists; everything else is a fold.');
  lines.push('');
  lines.push(`- Settled markets paged: ${settledSeen}; sampled after stratification: ${sampled}; observations: ${samples.length}`);
  lines.push(`- Per-category sample counts: ${JSON.stringify(table.sampleCounts)}`);
  lines.push(`- Markets sampled per category (pre-horizon): ${JSON.stringify(catCounts)}`);
  lines.push('- A market only contributes at horizons it was alive for — 15-minute crypto churn self-excludes.');
  lines.push('- Fee model: quadratic ceil(0.07·C·P·(1−P)) (per-series multiplier applies at scan time; ×1 shown here).');
  lines.push('');
  for (const h of HORIZONS) {
    const pooled = table.horizons[String(h)]?.['*'] || [];
    lines.push(`## ${h}h before close — pooled across categories`);
    lines.push('');
    lines.push('| bucket | n | avg price | settled YES | edge YES (net) | edge NO (net) |');
    lines.push('|---|---|---|---|---|---|');
    for (const b of pooled) {
      if (b.n === 0) continue;
      const feeSeries = { feeType: 'quadratic', feeMultiplier: 1 };
      const evYes = b.yesRate - effectiveCost(b.avgPrice, feeSeries);
      const evNo = 1 - b.yesRate - effectiveCost(1 - b.avgPrice, feeSeries);
      lines.push(`| ${b.lo.toFixed(2)}–${b.hi > 1 ? '1.00' : b.hi.toFixed(2)} | ${b.n} | ${b.avgPrice.toFixed(3)} | ${(b.yesRate * 100).toFixed(1)}% | ${(evYes * 100).toFixed(1)}¢ | ${(evNo * 100).toFixed(1)}¢ |`);
    }
    lines.push('');
  }
  lines.push('Interpretation: positive net-edge cells are candidate mechanical edges; the evaluator additionally');
  lines.push('shrinks by sample size and discounts stakes for spread/liquidity/one-off risk, so a green cell here');
  lines.push('is necessary but not sufficient for a live bet.');
  lines.push('');
  return lines.join('\n');
}

function usableSettled(markets: KalshiMarket[]): KalshiMarket[] {
  return markets.filter((m) =>
    !m.isMultivariate && (m.result === 'yes' || m.result === 'no') && m.closeTime && m.openTime && m.volume > 0);
}

/**
 * Collect settled markets per category by walking each category's REAL series (the flat settled
 * feed is >99% auto-generated multivariate parlay legs — paging it blind yields almost nothing).
 * Fifteen-minute churn series are skipped outright: they can't contribute at any horizon.
 */
async function collectSettled(): Promise<{ selected: { m: KalshiMarket; category: string }[]; catCounts: Record<string, number>; settledSeen: number }> {
  const selected: { m: KalshiMarket; category: string }[] = [];
  const catCounts: Record<string, number> = {};
  let settledSeen = 0;
  for (const category of CATEGORIES) {
    const series = (await listSeries(category)).filter((s) => s.frequency !== 'fifteen_min');
    let taken = 0;
    for (const s of series) {
      if (taken >= PER_CATEGORY_CAP) break;
      let markets: KalshiMarket[] = [];
      try {
        markets = await listMarkets({ status: 'settled', seriesTicker: s.ticker }, 300);
      } catch (err) {
        console.error(`[calibration] settled page failed for ${s.ticker}: ${(err as Error).message}`);
        continue;
      }
      settledSeen += markets.length;
      for (const m of usableSettled(markets).slice(0, PER_SERIES_CAP)) {
        if (taken >= PER_CATEGORY_CAP) break;
        selected.push({ m, category });
        taken += 1;
      }
    }
    catCounts[category] = taken;
    console.log(`[calibration] ${category}: ${series.length} series -> ${taken} settled markets`);
  }
  return { selected, catCounts, settledSeen };
}

async function main(): Promise<void> {
  console.log(`[calibration] discovering series per category (perSeriesCap=${PER_SERIES_CAP}, perCategoryCap=${PER_CATEGORY_CAP})...`);
  const { selected, catCounts, settledSeen } = await collectSettled();
  console.log(`[calibration] sampling ${selected.length} markets across ${Object.keys(catCounts).length} categories: ${JSON.stringify(catCounts)}`);

  const samples: CalibrationSample[] = [];
  let done = 0;
  for (const { m, category } of selected) {
    try {
      samples.push(...await sampleMarket(m, category));
    } catch (err) {
      console.error(`[calibration] candle fetch failed for ${m.ticker}: ${(err as Error).message}`);
    }
    done += 1;
    if (done % 100 === 0) console.log(`[calibration] ${done}/${selected.length} markets sampled, ${samples.length} observations`);
  }

  const table = buildCalibrationTable(samples);
  const json = JSON.stringify(table, null, 2);
  const outSeed = path.resolve(__dirname, '..', 'config-seed', 'kalshi-calibration.json');
  fs.writeFileSync(outSeed, json);
  const stamp = new Date().toISOString().slice(0, 10);
  const evJson = path.resolve(__dirname, '..', 'docs', 'evidence', `kalshi-calibration-${stamp}.json`);
  const evMd = path.resolve(__dirname, '..', 'docs', 'evidence', `kalshi-calibration-${stamp}.md`);
  fs.writeFileSync(evJson, json);
  fs.writeFileSync(evMd, evidenceMarkdown(json, samples, settledSeen, selected.length, catCounts));
  console.log(`[calibration] wrote ${outSeed}`);
  console.log(`[calibration] wrote ${evMd}`);
}

main().then(() => { process.exitCode = 0; }).catch((err) => { console.error('[calibration] FAILED', err); process.exitCode = 1; });
