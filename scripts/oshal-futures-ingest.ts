/**
 * Futures ingest + paper-broker demo (ADR-116) — proves the futures extension end-to-end with NO
 * external dependencies: mock data source → contract enumeration → completeness validation → (optional)
 * bar store → paper futures order with real multiplier-scaled P&L.
 *
 * This is the "all the way through with mock data" the operator asked for: replace the friend's
 * Kibot-desktop + NinjaTrader + FlaUI stack with an oshal-native run you can execute on a laptop.
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-futures-ingest.ts [flags]
 *   --root <ES|NQ|YM|RTY|MES|MNQ|...>   root to ingest (default ES)
 *   --tf <5Min|1Hour|1Day>             bar timeframe (default 1Hour)
 *   --months <n>                       months of history back from today (default 6)
 *   --drop <0..1>                      mock drop rate to simulate incomplete downloads (default 0.01)
 *   --passes <n>                       re-fetch passes per contract, the patch loop (default 2)
 *   --store                            also persist to Postgres if DATABASE_URL is set
 *
 * Store is OPTIONAL — without --store (or without DATABASE_URL) the run is fully in-memory. Exit codes:
 * 0 = ok · 2 = could not run.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — mock ingest of a root over a date range with completeness report + a paper futures order demo (buy/partial-close, positions, account P&L). Optional Postgres store behind --store.
 */
import 'dotenv/config';
import {
  activeContractAt, createPaperFuturesBroker, MockFuturesDataSource,
  type FuturesContract, type Timeframe,
} from '@/features/trading';
import { ingestFutures, type IngestReport } from '../src/app/trading-futures-ingest';

interface Args { root: string; tf: Timeframe; months: number; drop: number; passes: number; store: boolean }

/** Parse the CLI flags with defaults. */
function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  return {
    root: get('--root', 'ES').toUpperCase(),
    tf: get('--tf', '1Hour') as Timeframe,
    months: Number(get('--months', '6')),
    drop: Number(get('--drop', '0.01')),
    passes: Number(get('--passes', '2')),
    store: argv.includes('--store'),
  };
}

/** Print the per-contract completeness table + totals. */
function printReport(report: IngestReport): void {
  console.log(`\n=== Ingest report — ${report.root} @ ${report.timeframe} (source: ${report.source}) ===`);
  console.log('contract   received  expected  complete%  missing  gaps  passes  stored');
  for (const c of report.contracts) {
    const v = c.completeness;
    console.log(
      `${c.symbol.padEnd(9)} ${String(v.received).padStart(8)} ${String(v.expected).padStart(9)} ` +
      `${(v.completeness * 100).toFixed(1).padStart(9)} ${String(v.missing).padStart(8)} ` +
      `${String(v.gaps.length).padStart(5)} ${String(c.passes).padStart(7)} ${String(c.stored).padStart(7)}`,
    );
  }
  console.log(`\ntotal bars: ${report.totalBars}   incomplete contracts: ${report.incomplete.join(', ') || 'none'}`);
}

/** Run a paper futures order against the ingested marks and print the resulting book. */
async function paperDemo(root: string, tf: Timeframe, source: MockFuturesDataSource, asOf: Date): Promise<void> {
  const active = activeContractAt(root, asOf);
  if (!active) { console.log(`\n(no active ${root} contract at ${asOf.toISOString()} — skipping paper demo)`); return; }
  const box = { price: await frontMark(active, tf, source) };
  const broker = createPaperFuturesBroker({ startingCash: 100_000, priceResolver: async (s) => (s === active.symbol ? box.price : null) });
  console.log(`\n=== Paper futures demo — front month ${active.symbol}, mark ${box.price} ===`);
  const buy = await broker.placeOrder(order(active.symbol, 'buy', 3, 'a'));
  console.log(`BUY  3 ${active.symbol} → ${buy.status} @ ${buy.filledAvgPrice}`);
  box.price = Math.round(box.price * 1.005 * 100) / 100; // price ticks up 0.5% before the partial close
  const sell = await broker.placeOrder(order(active.symbol, 'sell', 1, 'b'));
  console.log(`SELL 1 ${active.symbol} → ${sell.status} @ ${sell.filledAvgPrice}  (mark moved to ${box.price})`);
  const positions = await broker.getPositions();
  const account = await broker.getAccount();
  for (const p of positions) {
    console.log(`position ${p.symbol}: qty ${p.qty} @ ${p.avgEntryPrice}  mark ${p.currentPrice}  uPnL ${p.unrealizedPl.toFixed(2)}`);
  }
  console.log(`account: cash ${account.cash.toFixed(2)} (realized P&L = cash − 100000)  equity ${account.equity.toFixed(2)}`);
}

/** Fetch the front contract's bars once and return its last close as the mark. */
async function frontMark(active: FuturesContract, tf: Timeframe, source: MockFuturesDataSource): Promise<number> {
  const bars = await source.fetchBars(active, tf);
  const last = bars[bars.length - 1];
  return last ? last.c : 5000;
}

/** Build a normalized market OrderRequest. */
function order(symbol: string, side: 'buy' | 'sell', qty: number, tag: string) {
  return { userSub: 'cli-demo', symbol, side, qty, type: 'market' as const, clientOrderId: `${symbol}:${side}:${tag}` };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const end = new Date();
  const start = new Date(end.getTime() - args.months * 30 * 86_400_000);
  const source = new MockFuturesDataSource({ dropRate: args.drop });
  console.log(`Ingesting ${args.root} ${args.tf} from ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)} (drop=${args.drop}, passes=${args.passes})…`);

  let pool: import('pg').Pool | undefined;
  if (args.store && process.env.DATABASE_URL) {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    console.log('store: persisting to market_bars via DATABASE_URL');
  } else if (args.store) {
    console.log('store: --store given but DATABASE_URL unset — running in-memory');
  }

  const report = await ingestFutures({ root: args.root, start, end, timeframe: args.tf, source, pool, maxPasses: args.passes });
  printReport(report);
  await paperDemo(args.root, args.tf, source, end);
  await pool?.end();
  console.log('\nRESULT ' + JSON.stringify({ root: report.root, totalBars: report.totalBars, incomplete: report.incomplete.length }));
}

main().catch((err) => { console.error('futures-ingest failed:', err); process.exit(2); });
