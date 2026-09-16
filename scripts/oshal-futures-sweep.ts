/**
 * Futures parameter sweep — ADR-116 Phase 1, the in-sample half of the evidence rail.
 *
 * Expands a parameter GRID into its full cartesian product, runs the backtester once per
 * combination over a series built ONCE per market, scores every run with a NAMED objective from the
 * trader's own fitness registry, and writes the whole table to CSV.
 *
 * Three rules this runner exists to enforce, because each has a matching way to produce a number
 * nobody can trust:
 *
 * - **The objective is named, never defaulted.** `--fitness` must resolve in `FITNESS_FUNCTIONS`;
 *   an unknown name exits 2. A sweep that silently fell back to some default objective would rank
 *   its winners by a rule the report does not state.
 * - **An empty axis is an error, not an empty sweep.** A grid axis with no values collapses the
 *   product to zero combinations, which prints as "no winners" rather than "you misconfigured it".
 * - **The series is identical to the reference run's.** Both runners build bars through
 *   `scripts/lib/futures-series.ts`, so a sweep winner is comparable to the canonical numbers.
 *
 * What it is NOT: a walk-forward. Every number this prints is IN-SAMPLE — the whole point of a
 * sweep is that it saw the data. Use `oshal-futures-backtest.ts --walk-forward` for an
 * out-of-sample number, and read the winner of a sweep as a hypothesis, never as a result.
 *
 * Exit codes: 0 = ok · 2 = could not run.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — cartesian grid sweep over dotted config keys with a named fitness (unknown name exits 2), one series build per market, ranked per-market console table and a full CSV artifact; the two grids ADR-116 Phase 1 owed (ensemble entry threshold/confirmation, and stop buffer mode/percent-ATR).
 *
 * @module scripts/oshal-futures-sweep
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  getFuturesRoot, runFuturesBacktest, mergeBacktestConfig, expandGrid, resolveFitness,
  scoreBacktest,
  type Timeframe, type BacktestConfig, type ConfigPatch, type FitnessFunction,
} from '@/features/trading';
import { sourceFor, buildMarketSeries, type SeriesRequest } from './lib/futures-series';

interface Args {
  roots: string[]; tf: Timeframe; ltfTf: Timeframe; months: number;
  source: 'mock' | 'kibot' | 'kibot-file'; dataDir: string; adjust: 'panama' | 'none';
  start: Date | null; end: Date | null; minVolume: number;
  stage1: number; slippageTicks: number; commission: number; equity: number; riskPct: number;
  gridPath: string; configPath: string; fitness: string; outPath: string; top: number;
}

const KNOWN_FLAGS = new Set([
  '--roots', '--tf', '--ltf', '--months', '--source', '--data-dir', '--adjust', '--start', '--end',
  '--min-volume', '--stage1', '--slippage-ticks', '--commission', '--equity', '--risk-pct',
  '--grid', '--config', '--fitness', '--out', '--top',
]);

/** Abort with a message — every bad input here would otherwise become a silently wrong experiment. */
function abort(message: string): never {
  console.error(`[sweep] ${message}`);
  process.exit(2);
}

/** Parse CLI flags. Same conventions as the backtest runner: unknown flag or empty value aborts. */
function parseArgs(argv: string[]): Args {
  const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
  if (unknown.length) abort(`unknown flag(s): ${unknown.join(' ')}. Known: ${[...KNOWN_FLAGS].join(' ')}`);
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (i >= 0 && (v === undefined || v.startsWith('--'))) abort(`flag ${flag} has no value.`);
    return v ?? def;
  };
  const num = (flag: string, def: string): number => {
    const n = Number(get(flag, def));
    if (!Number.isFinite(n)) abort(`${flag} must be a number.`);
    return n;
  };
  const date = (flag: string): Date | null => {
    const v = get(flag, '');
    if (!v) return null;
    const d = new Date(v.includes('T') ? v : `${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) abort(`${flag} must be an ISO date (YYYY-MM-DD).`);
    return d;
  };
  return {
    roots: get('--roots', 'ES').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean),
    tf: get('--tf', '1Hour') as Timeframe,
    ltfTf: get('--ltf', '1Day') as Timeframe,
    months: num('--months', '12'),
    source: get('--source', 'mock') as Args['source'],
    dataDir: get('--data-dir', process.env.KIBOT_DATA_DIR || 'C:\\MarketData\\kibot'),
    adjust: get('--adjust', 'panama') === 'none' ? 'none' : 'panama',
    start: date('--start'),
    end: date('--end'),
    minVolume: num('--min-volume', '1'),
    stage1: num('--stage1', '0'),
    slippageTicks: num('--slippage-ticks', '1'),
    commission: num('--commission', '2.5'),
    equity: num('--equity', '100000'),
    riskPct: num('--risk-pct', '2'),
    gridPath: get('--grid', ''),
    configPath: get('--config', ''),
    fitness: get('--fitness', 'max-net-profit-min-trades-50'),
    outPath: get('--out', ''),
    top: num('--top', '10'),
  };
}

/** Read a JSON object from disk, aborting on anything that is not one. */
function readJsonObject(path: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return abort(`${what} ${path}: ${err instanceof Error ? err.message : err}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return abort(`${what} ${path} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** Load and validate the grid: every value must be a non-empty array. */
function loadGrid(path: string): Record<string, unknown[]> {
  if (!path) abort('--grid <file.json> is required — a sweep with no grid is a single backtest.');
  const raw = readJsonObject(path, '--grid');
  const grid: Record<string, unknown[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) abort(`--grid axis '${key}' must be an array of values.`);
    grid[key] = value;
  }
  if (!Object.keys(grid).length) abort(`--grid ${path} declares no axes.`);
  return grid;
}

/** One finished combination. */
interface SweepRow {
  root: string; combo: number; params: Record<string, unknown>;
  trades: number; winRate: number; net: number; maxDD: number; fitness: number;
}

/** The frozen literal every combination starts from; `--config` then the grid merge over it. */
function baseConfig(args: Args, root: string, multiplier: number, tickSize: number): BacktestConfig {
  return {
    instrument: { symbol: root, multiplier, tickSize },
    entry: { generation: 'dynstops', riskPerTradePercent: args.riskPct },
    stops: { useStrangleTrail: true },
    costs: { slippageTicks: args.slippageTicks, commissionPerContract: args.commission },
    startingEquity: args.equity,
    timedBarsToExit: args.stage1,
  };
}

/** Flatten a nested patch back to dotted key → value, for the CSV and the console table. */
function flattenPatch(patch: ConfigPatch, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const here = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(out, flattenPatch(value as ConfigPatch, here));
      continue;
    }
    out[here] = value;
  }
  return out;
}

/** Fixed-width console row so a long sweep stays readable while it runs. */
function printRow(r: SweepRow, axes: string[]): void {
  const params = axes.map((a) => `${a.split('.').pop()}=${String(r.params[a])}`).join(' ');
  console.log(
    `  ${String(r.combo).padStart(4)} | ${String(r.trades).padStart(6)} | ${(r.winRate * 100).toFixed(1).padStart(5)}%`
    + ` | ${r.net.toFixed(0).padStart(9)} | ${r.maxDD.toFixed(0).padStart(9)} | ${r.fitness.toFixed(4).padStart(14)} | ${params}`,
  );
}

/** CSV escape: quote everything, double internal quotes. Keeps a parameter list safe in one cell. */
function csvCell(v: unknown): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

/** Write the full table — every combination, not just the ranked head. */
function writeCsv(path: string, rows: SweepRow[], axes: string[], fitnessName: string): void {
  const header = ['root', 'combo', ...axes, 'trades', 'winRate', 'netProfit', 'maxDrawdown', `fitness:${fitnessName}`];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push([
      r.root, r.combo, ...axes.map((a) => r.params[a]),
      r.trades, r.winRate, r.net, r.maxDD, r.fitness,
    ].map(csvCell).join(','));
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  console.log(`[sweep] wrote ${path} (${rows.length} rows)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const grid = loadGrid(args.gridPath);
  const axes = Object.keys(grid);
  let combos: ConfigPatch[];
  let fitness: FitnessFunction;
  try {
    combos = expandGrid(grid);
    fitness = resolveFitness(args.fitness);
  } catch (err) {
    return abort(err instanceof Error ? err.message : String(err));
  }
  const overlay = args.configPath ? readJsonObject(args.configPath, '--config') : {};
  const end = args.end ?? new Date();
  const start = args.start ?? (() => { const d = new Date(end); d.setMonth(d.getMonth() - args.months); return d; })();
  if (start.getTime() >= end.getTime()) abort('--start must be before --end.');
  const req: SeriesRequest = {
    source: args.source, dataDir: args.dataDir, adjust: args.adjust, minVolume: args.minVolume,
    tf: args.tf, ltfTf: args.ltfTf, start, end,
  };
  const chartSrc = sourceFor(req, args.tf);
  const ltfSrc = sourceFor(req, args.ltfTf);
  if (!chartSrc.src.configured()) abort(`source '${chartSrc.src.name}' is not configured (missing credentials or data dir).`);
  if (args.source === 'mock') {
    console.log('\n*** MOCK DATA — this sweep proves the machinery, NOT the strategy. ***');
  }
  console.log(`\n[sweep] ${args.roots.join(',')} ${args.tf} (LTF ${args.ltfTf}) — ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}, source=${chartSrc.src.name}`);
  console.log(`[sweep] ${combos.length} combination(s) over ${axes.length} axis/axes, objective '${args.fitness}'. ALL NUMBERS ARE IN-SAMPLE.`);

  const rows: SweepRow[] = [];
  for (const root of args.roots) {
    const meta = getFuturesRoot(root);
    if (!meta) { console.error(`[sweep] unknown root '${root}' — skipping.`); continue; }
    const { chart, ltf, ltfResampledFromMinute } = await buildMarketSeries(req, root, chartSrc, ltfSrc);
    if (ltfResampledFromMinute) console.log(`  LTF: daily/ had no ${root} files — resampled from minute/ instead.`);
    if (chart.bars.length < 100) { console.error(`[sweep] ${root}: only ${chart.bars.length} bars — skipping.`); continue; }
    if (!ltf.bars.length) { console.error(`[sweep] ${root}: LTF series is empty — skipping (the evaluator would gate every entry).`); continue; }
    const daily = args.ltfTf === '1Day' ? ltf.bars : [];
    console.log(`\n=== ${root} (${chart.bars.length} chart bars, ${ltf.bars.length} LTF bars) ===`);
    console.log('  combo |  trades |  win% |       net |     maxDD |        fitness | params');
    const marketRows: SweepRow[] = [];
    for (let i = 0; i < combos.length; i++) {
      let cfg: BacktestConfig;
      try {
        const withOverlay = mergeBacktestConfig(baseConfig(args, root, meta.multiplier, meta.tickSize), overlay);
        cfg = mergeBacktestConfig(withOverlay, combos[i]);
      } catch (err) {
        return abort(err instanceof Error ? err.message : String(err));
      }
      const result = runFuturesBacktest(chart.bars, ltf.bars, cfg, daily);
      const row: SweepRow = {
        root, combo: i, params: flattenPatch(combos[i]),
        trades: result.trades.length, winRate: result.winRate,
        net: result.netProfit, maxDD: result.maxDrawdown,
        fitness: scoreBacktest(result, fitness),
      };
      marketRows.push(row);
      rows.push(row);
      printRow(row, axes);
    }
    const ranked = [...marketRows].sort((a, b) => b.fitness - a.fitness).slice(0, Math.max(1, args.top));
    console.log(`\n  --- ${root} top ${ranked.length} by '${args.fitness}' (IN-SAMPLE, un-walk-forwarded) ---`);
    for (const r of ranked) printRow(r, axes);
  }
  if (!rows.length) abort('no market produced a run.');
  if (args.outPath) writeCsv(args.outPath, rows, axes, args.fitness);
  console.log('\n[sweep] Reminder: these are in-sample rankings. Re-run the winner through');
  console.log('        `oshal-futures-backtest.ts --walk-forward --config <winner.json>` before quoting it.\n');
}

main().catch((err) => {
  console.error('[sweep] failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
