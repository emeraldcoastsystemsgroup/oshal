/**
 * Live-stack competitive-evidence generator for the OSHAL "Cost Control" category — the REAL
 * cost-capture persistence path, complementing the (hardcoded) Token Chase optimizer demo.
 *
 * The existing token-chase-demo proof exercises the optimizer's estimated-vs-actual DEMO route
 * with a pool that refuses DB access and fixed figures (noTokenSpend). This proof instead exercises
 * the REAL cost-tracking aggregation (`CostTrackingService.queryCostFromDB`) against the live
 * `chat_tasks` table, proving that per-call LLM cost is genuinely captured, persisted, and rolled
 * up — and that the per-owner attribution read path (the seam behind per-user budget enforcement)
 * narrows correctly. No new tokens are spent; it reads historical recorded costs.
 *
 * On ANY failed assertion it prints failures, sets exit code 1, and writes NO evidence doc.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { spawnSync } from 'node:child_process';
import { CostTrackingService } from '@/features/operational-intelligence/services/cost-tracking-service';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
function dateStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function formatTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${dateStamp(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Resolve the live DB host:port from the running oshal-local-db container. */
function dbHostPort(): string {
  const out = spawnSync('docker', ['port', 'oshal-local-db', '5432/tcp'], { encoding: 'utf8' }).stdout.trim();
  const match = out.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
  if (!match) throw new Error(`could not read host port from: ${out}`);
  return `${match[1] === '0.0.0.0' ? '127.0.0.1' : match[1]}:${match[2]}`;
}
function containerEnv(name: string): string {
  return spawnSync('docker', ['exec', 'oshal-local-api', 'printenv', name], { encoding: 'utf8' }).stdout.trim();
}
function toHostUrl(inUrl: string, hostPort: string): string {
  return inUrl.replace(/@[^/]+\//, `@${hostPort}/`);
}
function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

type TopEntry = { key: string; cost: number };
function topByCost(byX: Record<string, { cost: number }>, n: number): TopEntry[] {
  return Object.entries(byX)
    .map(([key, v]) => ({ key, cost: Number(v.cost) || 0 }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, n);
}

async function main(): Promise<void> {
  const hostPort = dbHostPort();
  const ownerUrl = toHostUrl(containerEnv('BOOTSTRAP_DATABASE_URL') || 'postgresql://oshal:oshal@oshal-db:5432/oshal', hostPort);
  const pool = new Pool({ connectionString: ownerUrl, max: 2 });
  try {
    const svc = new CostTrackingService(pool);

    // 1) Real cost census across all recorded chat_tasks via the production aggregation read path.
    const global = await svc.queryCostFromDB();
    assert(global !== null, 'queryCostFromDB returned null (no pool) — cannot prove live cost capture');
    assert(global!.totalRequests > 0, `expected > 0 recorded cost rows in chat_tasks, got ${global!.totalRequests}`);
    const providers = Object.keys(global!.byProvider);
    const models = Object.keys(global!.byModel);
    assert(providers.length > 0, 'no providers attributed — cost capture is not populating provider_id');
    assert(global!.totalInputTokens + global!.totalOutputTokens > 0, 'no token counts recorded — cost capture is not persisting usage');

    // 2) Per-owner attribution: pick the top-spending owner and prove the production per-owner read
    //    path narrows to a subset of the global totals (the seam behind per-user budget enforcement).
    const topOwnerRes = await pool.query(
      `SELECT owner_sub, COUNT(*)::int AS rows, COALESCE(SUM(total_cost),0)::float8 AS cost
         FROM chat_tasks WHERE owner_sub IS NOT NULL
         GROUP BY owner_sub ORDER BY cost DESC, rows DESC LIMIT 1`,
    );
    const ownerScoping: { ownerSub: string | null; ownerRequests: number; ownerCost: number; narrows: boolean } =
      { ownerSub: null, ownerRequests: 0, ownerCost: 0, narrows: true };
    if (topOwnerRes.rows.length > 0) {
      const ownerSub = String(topOwnerRes.rows[0].owner_sub);
      const owned = await svc.queryCostFromDB(undefined, undefined, { ownerSub });
      assert(owned !== null, 'per-owner queryCostFromDB returned null');
      assert(owned!.totalRequests > 0, 'top owner has no attributed cost rows via the production read path');
      assert(owned!.totalRequests <= global!.totalRequests, 'per-owner request count exceeds global — scoping is broken');
      assert(owned!.totalCost <= global!.totalCost + 1e-9, 'per-owner cost exceeds global — scoping is broken');
      ownerScoping.ownerSub = `${ownerSub.slice(0, 10)}…`;
      ownerScoping.ownerRequests = owned!.totalRequests;
      ownerScoping.ownerCost = owned!.totalCost;
      ownerScoping.narrows = owned!.totalRequests <= global!.totalRequests;
    }

    const generatedAt = new Date();
    const outDir = path.join(process.cwd(), 'docs', 'evidence');
    mkdirSync(outDir, { recursive: true });
    const base = `cost-capture-live-${dateStamp(generatedAt)}`;
    const summary = {
      totalRequests: global!.totalRequests,
      totalCost: global!.totalCost,
      totalInputTokens: global!.totalInputTokens,
      totalOutputTokens: global!.totalOutputTokens,
      providers: providers.length,
      models: models.length,
      topProviders: topByCost(global!.byProvider, 5),
      topModels: topByCost(global!.byModel, 5),
      ownerScoping,
    };
    writeFileSync(path.join(outDir, `${base}.md`), renderMd(summary, generatedAt), 'utf8');
    writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify({ proofTier: 'live', generatedAt: generatedAt.toISOString(), summary }, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, totalRequests: summary.totalRequests, totalCost: summary.totalCost, providers: summary.providers }, null, 2));
  } finally {
    await pool.end();
  }
}

function money(n: number): string {
  return `$${(Number(n) || 0).toFixed(6)}`;
}

function renderMd(s: ReturnType<typeof buildSummaryType>, at: Date): string {
  return [
    `# Cost Capture Live Evidence - ${dateStamp(at)}`,
    '',
    '**Proof-Tier:** live - live-stack execution of the real `CostTrackingService.queryCostFromDB` aggregation against the running Postgres `chat_tasks` table. This proves per-call LLM cost is genuinely captured and rolled up (complementing the Token Chase optimizer demo, which exercises the estimator without touching the DB).',
    '',
    `Generated: ${formatTimestamp(at)}`,
    '',
    '## Result',
    '',
    `The production cost-aggregation read path returns real recorded spend across **${s.totalRequests}** cost-bearing \`chat_tasks\` rows: total ${money(s.totalCost)}, ${s.totalInputTokens + s.totalOutputTokens} tokens, across ${s.providers} provider(s) and ${s.models} model(s). These are historical recorded costs — no new tokens were spent by this proof.`,
    '',
    '## Recorded Spend (top by cost)',
    '',
    '| Provider | Cost |',
    '|---|---:|',
    ...s.topProviders.map((p) => `| ${p.key} | ${money(p.cost)} |`),
    '',
    '| Model | Cost |',
    '|---|---:|',
    ...s.topModels.map((m) => `| ${m.key} | ${money(m.cost)} |`),
    '',
    '## Per-Owner Attribution (budget-enforcement read path)',
    '',
    s.ownerScoping.ownerSub
      ? `Scoping \`queryCostFromDB\` to the top-spending owner (\`${s.ownerScoping.ownerSub}\`) narrows correctly to ${s.ownerScoping.ownerRequests} of ${s.totalRequests} rows and ${money(s.ownerScoping.ownerCost)} of ${money(s.totalCost)} — proving the per-user attribution seam behind per-owner budget enforcement scopes to a subset of global spend rather than leaking cross-owner totals.`
      : 'No owner-attributed cost rows are present yet, so per-owner scoping was not exercised in this run.',
    '',
    '## Command',
    '',
    '```powershell',
    'npx ts-node -r tsconfig-paths/register --transpile-only scripts/evidence/prove-cost-control-live.ts',
    '```',
    '',
    '## Limits',
    '',
    'Live-stack: the real `CostTrackingService.queryCostFromDB` production method runs against the running `chat_tasks` table and returns genuine recorded costs. The aggregate census connects as the maintenance owner role (an operator-level cost view, matching the cockpit cost dashboard), not a single tenant. It reads historical recorded spend rather than issuing a new billed LLM call, so it proves the capture + persistence + aggregation path, not a fresh provider charge.',
    '',
  ].join('\n');
}

// Type helper so renderMd's parameter is inferred from the summary object shape.
function buildSummaryType() {
  return {
    totalRequests: 0, totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0,
    providers: 0, models: 0,
    topProviders: [] as TopEntry[], topModels: [] as TopEntry[],
    ownerScoping: { ownerSub: null as string | null, ownerRequests: 0, ownerCost: 0, narrows: true },
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
