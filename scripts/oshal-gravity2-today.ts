/**
 * Gravity-2 "today" diagnostic — run the world-mass model on the LIVE world series and show what it's
 * pulling right now, per ticker: the derived masses (polarity, configurable mass, CALCULATED proximity)
 * and the net world displacement. Proves the model works on real data before the forward head-to-head.
 *
 * Reads world_metrics directly (TSDB only — no Alpaca/keys needed). The price masses Gravity 1 already
 * uses add ON TOP of this in the live gravity2 signal; this isolates the NEW world contribution.
 *
 *   TSDB_URL=postgresql://oshal:oshal@localhost:55434/oshal_ts \
 *     npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-gravity2-today.ts [SYMS]
 */
import { Pool } from 'pg';
import { deriveWorldMasses, defaultGravity2Config, GRAVITY2_METRICS, displacement, type WorldSnapshot } from '@/features/trading';

async function main(): Promise<void> {
  const TSDB = process.env.TSDB_URL || 'postgresql://oshal:oshal@localhost:55434/oshal_ts';
  const syms = (process.argv[2] || 'NVDA,AAPL,MSFT,GOOGL,AMZN,META,AMD,INTC,QCOM,PLTR,JPM,XOM,LLY,UNH,WMT,DIS,BA,TSLA,MRNA,PFE')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const cfg = defaultGravity2Config();
  const pool = new Pool({ connectionString: TSDB });
  const ent = (s: string): string => `world:ticker:${s.toLowerCase()}`;

  const r = await pool.query(
    `SELECT entity, metric, avg(value)::float8 AS avg, count(*)::int AS points
       FROM world_metrics
      WHERE entity = ANY($1::text[]) AND metric = ANY($2::text[]) AND ts >= now() - ($3 || ' days')::interval
      GROUP BY entity, metric`,
    [syms.map(ent), GRAVITY2_METRICS, String(cfg.windowDays)]);

  const byEnt = new Map<string, WorldSnapshot>();
  for (const row of r.rows as Array<{ entity: string; metric: string; avg: number; points: number }>) {
    if (!byEnt.has(row.entity)) byEnt.set(row.entity, {});
    byEnt.get(row.entity)![row.metric] = { avg: Number(row.avg), points: Number(row.points) };
  }

  console.log(`\nGravity-2 WORLD pull — window ${cfg.windowDays}d — ${new Date().toISOString().slice(0, 10)}`);
  console.log('(world masses only; price masses add on top in the live gravity2 signal)\n');
  const out = syms.map((s) => {
    const wm = deriveWorldMasses(s, byEnt.get(ent(s)) || {}, cfg);
    return { s, pull: displacement(wm, 0), wm };
  }).sort((a, b) => b.pull - a.pull);

  for (const { s, pull, wm } of out) {
    const dir = pull > 0.01 ? 'UP  ' : pull < -0.01 ? 'DOWN' : '--  ';
    const detail = wm.map((m) => `${m.source.replace('world/', '')} ${m.polarity > 0 ? '+' : '-'}${m.mass.toFixed(2)}@prox${m.proximity.toFixed(2)}`).join('  ');
    console.log(`${s.padEnd(6)} ${(pull * 100).toFixed(2).padStart(7)}%  ${dir}  ${detail || '(no world masses)'}`);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
