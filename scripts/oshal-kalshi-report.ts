/**
 * Kalshi report — the cross-reference over the prediction ledger, in one command.
 *
 * Operator, 2026-09-05: "how can I monitor Kalshi wins and reports and run cross reference and
 * algorithms". The Scorecard and Alerts tabs answer "am I winning"; this answers "WHERE am I winning
 * or losing, and why": every strategy cut by price band and by our own confidence, each cell scored
 * against its breakeven (price + fee) with P&L before and after fees, the record of the hands Jarvis
 * actually announced, the forward tests still earning their first verdict, real orders, and the
 * what-if of having taken the other side at a given spread. READ-ONLY: it never writes the ledger
 * (tests/unit/kalshi-report.spec.ts pins that).
 *
 * Run: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-kalshi-report.ts
 *      [--strategy <name>] [--flip-spread <cents>] [--json]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — scorecard, alerted-hands record, price-band and confidence cross-tabs (hit vs breakeven, P&L before/after fee), forward tests in progress, order audit, and the flip what-if at a chosen spread. Pure helpers exported for the spec.
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { hostDatabaseUrl } from './kalshi-db-url';
import { getScorecard } from '../src/features/prediction-markets';

/** Kalshi's quadratic taker fee per contract, dollars (7% × P × (1−P)). */
export function quadraticFee(price: number): number {
  return 0.07 * price * (1 - price);
}

/** The hit rate a bet at `price` must reach to break even after the taker fee, as a percent. */
export function breakevenPct(price: number): number {
  return (price + quadraticFee(price)) * 100;
}

/** Five price bands: where on the board the bet sat. */
export function priceBand(price: number): string {
  if (price < 0.2) return '1 longshot <20c';
  if (price < 0.4) return '2 20-40c';
  if (price < 0.6) return '3 even 40-60c';
  if (price < 0.8) return '4 60-80c';
  return '5 favorite 80c+';
}

/** Our own confidence, in deciles ("0.9-1.0" = we were 90%+ sure of the side we took). */
export function probBucket(p: number): string {
  const lo = Math.min(9, Math.max(0, Math.floor(p * 10 + 1e-9)));
  return `${(lo / 10).toFixed(1)}-${((lo + 1) / 10).toFixed(1)}`;
}

/** Signed dollars, two decimals, with the sign always shown. */
export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;
}

/** Fixed-width text table: columns right-aligned when numeric. */
export function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const numeric = header.map((_, i) => rows.every((r) => /^[-+$0-9.%—]*$/.test(r[i] ?? '')));
  const line = (cells: string[]): string => cells
    .map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

interface Args { strategy: string | null; flipSpread: number; json: boolean }

/** Parse the three flags; unknown flags are ignored so a typo cannot silently change a number. */
export function parseArgs(argv: string[]): Args {
  const at = (flag: string): string | null => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] ?? null : null; };
  const rawSpread = at('--flip-spread');
  const spread = rawSpread === null ? 3 : Number(rawSpread);
  return {
    strategy: at('--strategy'),
    flipSpread: Number.isFinite(spread) && spread >= 0 ? spread : 3,
    json: argv.includes('--json'),
  };
}

type Row = Record<string, unknown>;
const won = `((side = 'yes') = settled_yes)`;

async function scorecard(pool: Pool, out: Row): Promise<string> {
  const rows = await getScorecard(pool);
  out.scorecard = rows;
  return '=== SCORECARD (the staking gate; Brier vs THE MARKET is the bar) ===\n' + renderTable(
    ['strategy', 'status', 'graded', 'pending', 'hit', 'our Brier', 'mkt Brier', 'P&L/contract'],
    rows.map((r) => [r.strategy, r.status.toUpperCase(), String(r.graded), String(r.pending),
      r.hitRate === null ? '—' : `${(r.hitRate * 100).toFixed(1)}%`,
      r.brier === null ? '—' : r.brier.toFixed(4), r.marketBrier === null ? '—' : r.marketBrier.toFixed(4),
      r.pnlPerContract === null ? '—' : fmtMoney(r.pnlPerContract)]),
  );
}

async function alertedRecord(pool: Pool, out: Row): Promise<string> {
  const { rows } = await pool.query(
    `SELECT count(*)::int alerted, count(p.id)::int matched, count(*) FILTER (WHERE p.settled)::int settled,
            count(*) FILTER (WHERE p.settled AND ${won})::int wins,
            count(*) FILTER (WHERE p.settled AND NOT ${won})::int losses,
            sum(p.pnl_per_contract) FILTER (WHERE p.settled) pnl
       FROM kalshi_scan_alerts a
       LEFT JOIN kalshi_predictions p ON p.ticker = a.ticker AND p.strategy = 'calibration'`);
  const r = rows[0];
  out.alerted = r;
  const decided = r.wins + r.losses;
  return `=== HANDS JARVIS ANNOUNCED (paper: alerts never order) ===\n` +
    `  announced ${r.alerted}, settled ${r.settled}: ${r.wins} W - ${r.losses} L` +
    ` (${decided ? ((100 * r.wins) / decided).toFixed(1) : '—'}% hit), ${fmtMoney(r.pnl)} had one contract been bought on each`;
}

async function crossTab(pool: Pool, out: Row, strategy: string | null, by: 'price' | 'prob'): Promise<string> {
  const { rows } = await pool.query(
    `SELECT strategy, ${by === 'price' ? 'market_prob' : 'predicted_prob'}::float AS key, market_prob::float AS price,
            ${won} AS won, pnl_per_contract::float AS pnl
       FROM kalshi_predictions WHERE settled AND NOT strategy LIKE 'contrarian%' ${strategy ? 'AND strategy = $1' : ''}`,
    strategy ? [strategy] : []);
  const cells = new Map<string, { n: number; wins: number; price: number; before: number; fees: number; after: number }>();
  for (const r of rows as Array<{ strategy: string; key: number; price: number; won: boolean; pnl: number }>) {
    const k = `${r.strategy}|${by === 'price' ? priceBand(r.key) : probBucket(r.key)}`;
    const c = cells.get(k) ?? { n: 0, wins: 0, price: 0, before: 0, fees: 0, after: 0 };
    c.n += 1; c.wins += r.won ? 1 : 0; c.price += r.price;
    c.before += r.won ? 1 - r.price : -r.price; c.fees += quadraticFee(r.price); c.after += r.pnl;
    cells.set(k, c);
  }
  const table = [...cells.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, c]) => {
    const [strat, band] = k.split('|');
    const avgPrice = c.price / c.n;
    return [strat, band, String(c.n), `${((100 * c.wins) / c.n).toFixed(1)}%`, `${(avgPrice * 100).toFixed(1)}%`,
      `${breakevenPct(avgPrice).toFixed(1)}%`, fmtMoney(c.before), fmtMoney(-c.fees), fmtMoney(c.after)];
  });
  out[by === 'price' ? 'byPriceBand' : 'byConfidence'] = table;
  const title = by === 'price' ? 'BY PRICE PAID (where on the board)' : 'BY OUR CONFIDENCE (how sure we were)';
  return `=== ${title} — hit must beat breakeven ===\n` + renderTable(
    ['strategy', by === 'price' ? 'band' : 'our P', 'n', 'hit', 'avg price', 'breakeven', 'before fee', 'fees', 'after fee'], table);
}

async function forwardTests(pool: Pool, out: Row): Promise<string> {
  const { rows } = await pool.query(
    `SELECT strategy, count(*)::int total, count(*) FILTER (WHERE settled)::int graded,
            min(created_at)::date::text AS since, avg(brier) FILTER (WHERE settled)::float AS brier,
            avg(market_brier) FILTER (WHERE settled)::float AS mkt, sum(pnl_per_contract) FILTER (WHERE settled)::float AS pnl
       FROM kalshi_predictions GROUP BY strategy HAVING count(*) FILTER (WHERE settled) < 30 ORDER BY strategy`);
  out.forwardTests = rows;
  if (!rows.length) return '=== FORWARD TESTS IN PROGRESS ===\n  none — every strategy has 30+ graded rows';
  return '=== FORWARD TESTS IN PROGRESS (need 30 graded before the Scorecard rules) ===\n' + renderTable(
    ['strategy', 'since', 'registered', 'graded/30', 'our Brier', 'mkt Brier', 'P&L so far'],
    rows.map((r) => [r.strategy, String(r.since).slice(0, 10), String(r.total), `${r.graded}/30`,
      r.brier === null ? '—' : r.brier.toFixed(4), r.mkt === null ? '—' : r.mkt.toFixed(4), fmtMoney(r.pnl)]));
}

async function orders(pool: Pool, out: Row): Promise<string> {
  let rows: Row[];
  try {
    rows = (await pool.query(
      `SELECT env, kalshi_status AS status, count(*)::int n, sum(count * limit_price_cents)::float / 100 AS dollars
         FROM kalshi_orders GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
  } catch (err) {
    // A report that hides its own failure would read as "no orders" — say what broke instead.
    out.orders = { error: (err as Error).message };
    return `=== REAL ORDERS (kalshi_orders) ===
  unavailable: ${(err as Error).message}`;
  }
  out.orders = rows;
  if (!rows.length) return '=== REAL ORDERS (kalshi_orders) ===\n  none';
  return '=== REAL ORDERS (kalshi_orders, every attempt incl. refusals) ===\n' + renderTable(
    ['exchange', 'status', 'n', 'notional'],
    rows.map((r) => [String(r.env), String(r.status), String(r.n), fmtMoney(Number(r.dollars))]));
}

async function flipWhatIf(pool: Pool, out: Row, spreadCents: number): Promise<string> {
  const s = spreadCents / 100;
  const { rows } = await pool.query(
    `SELECT strategy, count(*)::int n, sum(pnl_per_contract)::float AS as_bet,
            sum(CASE WHEN ${won} THEN -((1 - market_prob) + $1) ELSE 1 - ((1 - market_prob) + $1) END
                - 0.07 * market_prob * (1 - market_prob))::float AS flipped
       FROM kalshi_predictions WHERE settled AND NOT strategy LIKE 'contrarian%' GROUP BY strategy ORDER BY strategy`, [s]);
  out.flip = { spreadCents, rows };
  return `=== WHAT IF WE HAD TAKEN THE OTHER SIDE (at 1 - our bid, ${spreadCents}c spread, fees) ===\n` + renderTable(
    ['strategy', 'n', 'as bet', 'flipped'], rows.map((r) => [r.strategy, String(r.n), fmtMoney(r.as_bet), fmtMoney(r.flipped)]));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: hostDatabaseUrl() });
  const out: Row = { generatedAt: new Date().toISOString(), strategyFilter: args.strategy };
  try {
    const sections = [
      await scorecard(pool, out), await forwardTests(pool, out), await alertedRecord(pool, out),
      await crossTab(pool, out, args.strategy, 'price'), await crossTab(pool, out, args.strategy, 'prob'),
      await flipWhatIf(pool, out, args.flipSpread), await orders(pool, out),
    ];
    if (args.json) console.log(JSON.stringify(out, null, 2));
    else console.log(`KALSHI REPORT ${out.generatedAt}${args.strategy ? `  (strategy: ${args.strategy})` : ''}\n\n${sections.join('\n\n')}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('[kalshi-report] FAILED', err); process.exitCode = 1; });
}
