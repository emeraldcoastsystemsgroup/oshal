/**
 * Gravity 1 vs Gravity 2 — day-by-day backtest over the world history we HAVE.
 *
 * For each recent trading-day transition D→D+1 and each symbol: compute the gravity signal (price-only)
 * and the gravity2 signal (price + world masses as-of D), then score both against the ACTUAL next-day
 * move. Reports hit-rate + expectancy (avg signed return per call) for each, and where they disagreed.
 *
 * Honest limits: insider/congress data starts ~today, sentiment is dense only from June — so this mostly
 * exercises NEWS masses over a few weeks of one (rising) regime. It is a wiring/sanity check, not proof.
 *
 *   ALPACA_KEY=... ALPACA_SECRET=... TSDB_URL=postgresql://oshal:oshal@localhost:55434/oshal_ts \
 *     npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-gravity2-backtest.ts [SYMS] [DAYS]
 */
import { Pool } from 'pg';
import { deriveMasses, displacement, deriveWorldMasses, defaultGravity2Config, GRAVITY2_METRICS, type WorldSnapshot } from '@/features/trading';

const DATA = 'https://data.alpaca.markets/v2';
function keys(): { id: string; secret: string } {
  const id = process.env.ALPACA_KEY_ID || process.env.ALPACA_KEY || process.env.ALPAKA_KEY || '';
  const secret = process.env.ALPACA_SECRET_KEY || process.env.ALPACA_SECRET || process.env.ALPAKA_SECRET || '';
  return { id, secret };
}
async function datedBars(sym: string, lookbackDays = 45): Promise<Array<{ t: string; c: number }>> {
  const k = keys();
  const start = new Date(Date.now() - lookbackDays * 864e5).toISOString().slice(0, 10);
  const r = await fetch(`${DATA}/stocks/${encodeURIComponent(sym)}/bars?timeframe=1Day&start=${start}&limit=1000&adjustment=all&feed=iex`,
    { headers: { 'APCA-API-KEY-ID': k.id, 'APCA-API-SECRET-KEY': k.secret } });
  const j = (await r.json().catch(() => ({}))) as { bars?: Array<{ t: string; c: number }> };
  return (j.bars || []).map((b) => ({ t: String(b.t).slice(0, 10), c: Number(b.c) }));
}
const dir = (d: number): -1 | 0 | 1 => (Math.abs(d) < 0.01 ? 0 : d > 0 ? 1 : -1);

async function worldAsOf(pool: Pool, syms: string[], dayISO: string, windowDays: number): Promise<Map<string, WorldSnapshot>> {
  const ent = (s: string): string => `world:ticker:${s.toLowerCase()}`;
  const r = await pool.query(
    `SELECT entity, metric, avg(value)::float8 AS avg, count(*)::int AS points FROM world_metrics
      WHERE entity = ANY($1::text[]) AND metric = ANY($2::text[])
        AND ts > ($3::timestamptz - ($4 || ' days')::interval) AND ts <= $3::timestamptz
      GROUP BY entity, metric`,
    [syms.map(ent), GRAVITY2_METRICS, dayISO + 'T23:59:59Z', String(windowDays)]);
  const m = new Map<string, WorldSnapshot>();
  for (const row of r.rows as Array<{ entity: string; metric: string; avg: number; points: number }>) {
    if (!m.has(row.entity)) m.set(row.entity, {});
    m.get(row.entity)![row.metric] = { avg: Number(row.avg), points: Number(row.points) };
  }
  return m;
}

interface Tally { n: number; hits: number; ret: number; }
const blank = (): Tally => ({ n: 0, hits: 0, ret: 0 });
function add(t: Tally, predDir: number, moveRet: number): void {
  if (predDir === 0) return;
  t.n += 1;
  const hit = (predDir > 0 && moveRet > 0) || (predDir < 0 && moveRet < 0);
  if (hit) t.hits += 1;
  t.ret += predDir > 0 ? moveRet : -moveRet; // signed return earned by the call
}
const pct = (t: Tally): string => (t.n ? `${(t.hits / t.n * 100).toFixed(1)}% hit, ${(t.ret / t.n >= 0 ? '+' : '')}${(t.ret / t.n).toFixed(3)}% exp (n=${t.n})` : 'no calls');

async function main(): Promise<void> {
  const syms = (process.argv[2] || 'NVDA,AAPL,MSFT,GOOGL,AMZN,META,AMD,INTC,QCOM,PLTR,JPM,XOM,LLY,UNH,WMT,DIS,BA,TSLA,MRNA,PFE')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const evalDays = Number(process.argv[3] || 12);
  const cfg = defaultGravity2Config();
  const pool = new Pool({ connectionString: process.env.TSDB_URL || 'postgresql://oshal:oshal@localhost:55434/oshal_ts' });

  // Fetch dated bars for all symbols.
  const bars = new Map<string, Array<{ t: string; c: number }>>();
  for (const s of syms) { const b = await datedBars(s); if (b.length > 30) bars.set(s, b); }
  if (!bars.size) { console.error('No bars — Alpaca keys set?'); process.exit(1); }

  const grav = blank(), grav2 = blank();
  let disagreements = 0, g2WinsOnDisagree = 0, worldDays = 0;

  // Walk each symbol's own bars; for each of the last evalDays transitions, score both models.
  const dateCache = new Map<string, Map<string, WorldSnapshot>>();
  for (const [sym, b] of bars) {
    const startI = Math.max(30, b.length - 1 - evalDays);
    for (let i = startI; i < b.length - 1; i++) {
      const through = b.slice(0, i + 1).map((x) => x.c);     // data through day i (= D)
      const moveRet = (b[i + 1].c - b[i].c) / b[i].c * 100;  // actual D→D+1 %
      const day = b[i].t;
      if (!dateCache.has(day)) dateCache.set(day, await worldAsOf(pool, syms, day, cfg.windowDays));
      const snap = dateCache.get(day)!.get(`world:ticker:${sym.toLowerCase()}`) || {};
      const wm = deriveWorldMasses(sym, snap, cfg);
      const gDir = dir(displacement(deriveMasses(sym, through), 0));
      const g2Dir = dir(displacement(deriveMasses(sym, through).concat(wm), 0));
      add(grav, gDir, moveRet);
      add(grav2, g2Dir, moveRet);
      if (wm.length) worldDays++;
      if (gDir !== g2Dir && (gDir !== 0 || g2Dir !== 0)) {
        disagreements++;
        const gHit = (gDir > 0 && moveRet > 0) || (gDir < 0 && moveRet < 0);
        const g2Hit = (g2Dir > 0 && moveRet > 0) || (g2Dir < 0 && moveRet < 0);
        if (g2Hit && !gHit) g2WinsOnDisagree++;
        else if (gHit && !g2Hit) g2WinsOnDisagree--;
      }
    }
  }

  console.log(`\nGravity 1 vs Gravity 2 backtest — last ${evalDays} transitions, ${bars.size} symbols, window ${cfg.windowDays}d`);
  console.log(`(world masses present on ${worldDays} symbol-days; insider/congress are ~empty before today)\n`);
  console.log(`  Gravity 1 (price):        ${pct(grav)}`);
  console.log(`  Gravity 2 (price+world):  ${pct(grav2)}`);
  console.log(`\n  Disagreements: ${disagreements}  ·  net gravity2 edge on those: ${g2WinsOnDisagree >= 0 ? '+' : ''}${g2WinsOnDisagree} (positive = world helped)`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
