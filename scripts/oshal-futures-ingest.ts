/**
 * Futures archive preview/import and isolated mock paper-broker demo (ADR-116).
 * Real files use bounded UTC conversion, completeness evidence and an explicitly confirmed
 * atomic database import. The separate mock path never writes shared reference data.
 *
 * Usage: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-futures-ingest.ts [flags]
 *   --root <ES|NQ|YM|RTY|MES|MNQ|...>   root to ingest (default ES)
 *   --tf <5Min|1Hour|1Day>             bar timeframe (default 1Hour)
 *   --months <n>                       months of history back from today (default 6)
 *   --drop <0..1>                      mock drop rate to simulate incomplete downloads (default 0.01)
 *   --passes <n>                       re-fetch passes per contract, the patch loop (default 2)
 *   --source <mock|kibot-file>          default mock; real files preview without writes
 *   --data-dir <absolute-path>          server archive root containing daily/ and minute/
 *   --source-time-zone <zone>           UTC, America/New_York or America/Chicago; required for files
 *   --start/--end <YYYY-MM-DD>           UTC date window; required for files
 *   --store --owner <operator-sub>      confirm a real-file preview into DATABASE_URL
 *   --fingerprint <preview-sha>         exact fingerprint from the prior read-only preview
 *   --confirmation "IMPORT SHARED FUTURES BARS"  acknowledge shared reference writes
 *
 * Mock data never enters the shared store. Real imports fail without an explicit owner, confirmation,
 * preview fingerprint and DATABASE_URL. The paper demo is mock-only. Exit codes:
 * 0 = ok · 2 = could not run.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — mock ingest of a root over a date range with completeness report + a paper futures order demo (buy/partial-close, positions, account P&L). Optional Postgres store behind --store.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Wire real archive previews and exact confirmed imports through the console's durable boundary; forbid mock writes and silent in-memory fallback.
 */
import 'dotenv/config';
import {
  activeContractAt, createPaperFuturesBroker, MockFuturesDataSource,
  type FuturesContract, type Timeframe,
} from '@/features/trading';
import { ingestFutures, type IngestReport } from '../src/app/trading-futures-ingest';
import { normalizeFuturesArchiveConfig, FUTURES_ARCHIVE_CONFIRM } from '../src/app/trading-futures-archive-config';
import { executeFuturesArchiveOffLoop } from '../src/app/trading-futures-archive-worker';
import { previewFuturesArchive, confirmFuturesArchive, listFuturesArchiveImports, type FuturesArchiveImport } from '../src/app/trading-futures-archive-import';
import type { Pool } from 'pg';

interface Args {
  root: string; tf: Timeframe; months: number; drop: number; passes: number; store: boolean; source: string;
  dataDir: string; sourceTimeZone: string; start: string; end: string; owner: string; fingerprint: string; confirmation: string;
}

/** Parse the CLI flags with defaults. */
function parseArgs(argv: string[]): Args {
  const known = new Set(['--root','--tf','--months','--drop','--passes','--store','--source','--data-dir','--source-time-zone','--start','--end','--owner','--fingerprint','--confirmation']);
  for (let i = 0; i < argv.length; i++) {
    if (!known.has(argv[i])) throw new Error('Unknown ingest flag');
    if (argv[i] !== '--store' && (!argv[++i] || argv[i].startsWith('--'))) throw new Error('Missing ingest flag value');
  }
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const args = {
    root: get('--root', 'ES').toUpperCase(),
    tf: get('--tf', '1Hour') as Timeframe,
    months: Number(get('--months', '6')),
    drop: Number(get('--drop', '0.01')),
    passes: Number(get('--passes', '2')),
    store: argv.includes('--store'),
    source: get('--source', 'mock'), dataDir: get('--data-dir', ''), sourceTimeZone: get('--source-time-zone', ''),
    start: get('--start', ''), end: get('--end', ''), owner: get('--owner', ''), fingerprint: get('--fingerprint', ''), confirmation: get('--confirmation', ''),
  };
  if (!['mock','kibot-file'].includes(args.source) || !['5Min','1Hour','1Day'].includes(args.tf)
    || !Number.isInteger(args.months) || args.months < 1 || args.months > 120 || !Number.isInteger(args.passes) || args.passes < 1 || args.passes > 3
    || !Number.isFinite(args.drop) || args.drop < 0 || args.drop > 1) throw new Error('Invalid bounded ingest arguments');
  if (args.source === 'mock' && args.store) throw new Error('Mock data cannot be stored in shared market_bars');
  return args;
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
  if (args.source === 'kibot-file') { await realArchive(args); return; }
  const end = new Date();
  const start = new Date(end.getTime() - args.months * 30 * 86_400_000);
  const source = new MockFuturesDataSource({ dropRate: args.drop });
  console.log(`Ingesting ${args.root} ${args.tf} from ${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)} (drop=${args.drop}, passes=${args.passes})…`);

  const report = await ingestFutures({ root: args.root, start, end, timeframe: args.tf, source, maxPasses: args.passes });
  printReport(report);
  await paperDemo(args.root, args.tf, source, end);
  console.log('\nRESULT ' + JSON.stringify({ root: report.root, totalBars: report.totalBars, incomplete: report.incomplete.length }));
}

async function waitForArchive(pool: Pool, owner: string, id: string): Promise<FuturesArchiveImport> {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    const job = (await listFuturesArchiveImports(pool, owner)).find(row => row.importId === id);
    if (job?.status === 'failed') throw new Error(job.error ?? 'Archive job failed');
    if (job && ['ready','completed'].includes(job.status)) return job;
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error('Archive job still active; inspect its durable console receipt before retrying');
}

async function realArchive(args: Args): Promise<void> {
  const config = normalizeFuturesArchiveConfig({ roots: [args.root], timeframes: [args.tf], dataDir: args.dataDir,
    sourceTimeZone: args.sourceTimeZone, start: args.start, end: args.end });
  if (!args.store) {
    const { plan } = await executeFuturesArchiveOffLoop(config, false);
    console.log('READ-ONLY PREVIEW: UTC bar opens, unadjusted front-month windows, no paper demo or database writes.');
    console.log('RESULT ' + JSON.stringify(plan)); return;
  }
  if (!process.env.DATABASE_URL || !args.owner || args.confirmation !== FUTURES_ARCHIVE_CONFIRM || !/^[a-f0-9]{64}$/.test(args.fingerprint)) {
    throw new Error('Real imports require DATABASE_URL, --owner, exact --confirmation and the prior --fingerprint; no fallback');
  }
  const { Pool: DatabasePool } = await import('pg');
  const pool = new DatabasePool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    const preview = await waitForArchive(pool, args.owner, (await previewFuturesArchive(pool, args.owner, config)).importId);
    await confirmFuturesArchive(pool, args.owner, preview.importId, { confirmation: args.confirmation, fingerprint: args.fingerprint });
    const imported = await waitForArchive(pool, args.owner, preview.importId);
    console.log('RESULT ' + JSON.stringify(imported));
  } finally { await pool.end(); }
}

main().catch((err) => { console.error('futures-ingest failed:', err); process.exit(2); });
