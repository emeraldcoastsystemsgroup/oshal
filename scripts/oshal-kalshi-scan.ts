/**
 * Kalshi live scan — deal every open contract as a poker hand and print the playable ones.
 *
 * Loads the calibration table (config-seed/kalshi-calibration.json — run the calibration study
 * first), pages open markets from the public API, evaluates both sides of each book net of fees,
 * and prints hands ranked by strength then risk-adjusted edge. Also writes a JSON snapshot to
 * docs/evidence so a scan's picks can be graded after settlement.
 *
 * Run: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-kalshi-scan.ts [maxMarkets] [topN]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — open-market pager + series meta join + ranked hand printout (strength, side, price, true prob, net edge, quarter-Kelly stake, risk flags) + evidence snapshot for post-settlement grading.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import type { BetHand, CalibrationTable, KalshiMarket, KalshiSeriesMeta } from '../src/features/prediction-markets';
import { exchangeTradingActive, getSeriesMeta, listMarketsFiltered, rankHands } from '../src/features/prediction-markets';

const MAX_KEEP = Number(process.argv[2]) || 1500;
const TOP_N = Number(process.argv[3]) || 25;

/** Evaluable = real single market with a two-sided book and at least one trade printed. */
function evaluable(m: KalshiMarket): boolean {
  return !m.isMultivariate && m.yesAsk > 0 && m.noAsk > 0 && m.volume > 0;
}

function fmtHand(h: BetHand): string {
  const flags = h.riskFlags.length ? ` [${h.riskFlags.join(',')}]` : '';
  return `${h.strength.toUpperCase().padEnd(8)} ${h.side.toUpperCase().padEnd(3)} @ ${(h.price * 100).toFixed(1)}¢` +
    ` true=${(h.trueProb * 100).toFixed(1)}% edge=${(h.edgeNet * 100).toFixed(1)}¢ stake=${(h.stakeFraction * 100).toFixed(2)}%` +
    ` n=${h.calibrationN} ${h.ticker}${flags}\n         ${h.title.slice(0, 110)}`;
}

async function main(): Promise<void> {
  const tablePath = path.resolve(__dirname, '..', 'config-seed', 'kalshi-calibration.json');
  if (!fs.existsSync(tablePath)) throw new Error(`missing ${tablePath} — run oshal-kalshi-calibration.ts first`);
  const table = JSON.parse(fs.readFileSync(tablePath, 'utf8')) as CalibrationTable;

  const active = await exchangeTradingActive();
  console.log(`[scan] exchange trading_active=${active}; walking the open feed for ${MAX_KEEP} evaluable markets (>99% of the feed is parlay legs)...`);
  const { markets, paged } = await listMarketsFiltered({ status: 'open' }, evaluable, { maxKeep: MAX_KEEP });
  console.log(`[scan] paged=${paged} evaluable(book+volume)=${markets.length}`);

  const seriesByTicker = new Map<string, KalshiSeriesMeta>();
  for (const m of markets) {
    if (!seriesByTicker.has(m.seriesTicker)) seriesByTicker.set(m.seriesTicker, await getSeriesMeta(m.seriesTicker));
  }

  const hands = rankHands(markets, seriesByTicker, table);
  console.log(`[scan] playable hands: ${hands.length} (of ${markets.length} evaluated)\n`);
  for (const h of hands.slice(0, TOP_N)) console.log(fmtHand(h));

  const stamp = new Date().toISOString().slice(0, 10);
  const out = path.resolve(__dirname, '..', 'docs', 'evidence', `kalshi-scan-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), exchangeActive: active, openPaged: paged, evaluable: markets.length, hands }, null, 2));
  console.log(`\n[scan] snapshot -> ${out}`);
}

main().then(() => { process.exitCode = 0; }).catch((err) => { console.error('[scan] FAILED', err); process.exitCode = 1; });
