/**
 * Strategy Lab regression suite runner (ADR-092) — re-runs every baselined strategy over its
 * PINNED window via the running api and fails loudly on drift, so "the engine changed behavior"
 * (the resample-bug class) is a red exit code instead of a discovery weeks later. The nightly
 * `trading-lab:<sub>` leg does the same in-process; this CLI is the on-demand / CI entry.
 *
 * Auth: a swarm-cli PAT via OSHAL_CLI_TOKEN (Bearer — the human lane), falling back to
 * OSHAL_SERVICE_SECRET + OSHAL_USER_SUB (the internal service lane).
 *
 * Usage: npx ts-node --transpile-only scripts/trading-regression-suite.ts [--base http://localhost:35457] [--forward]
 *   --forward   also advance every strategy's out-of-sample forward walk first
 *
 * Prints one machine-readable `RESULT {json}` final line (the harness convention). Exit codes:
 * 0 = all ok · 1 = drift or failures · 2 = could not run.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — PAT/service-secret call to /api/trading/lab/{forward-run,regression-run}, drift table, RESULT line, CI exit codes.
 */
import 'dotenv/config';

const BASE = argValue('--base') || process.env.OSHAL_BASE_URL || 'http://localhost:35457';
const RUN_FORWARD = process.argv.includes('--forward');

function argValue(flag: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

/** Auth headers: PAT first (human lane), service secret second (bot lane). The secret falls back
 *  to SWARM_SERVICE_SECRET and the sub to the first OSHAL_OPERATOR_SUBS entry so a plain
 *  `.env`-equipped repo checkout can run the suite with zero extra setup. */
function authHeaders(): Record<string, string> {
  const pat = (process.env.OSHAL_CLI_TOKEN || '').trim();
  if (pat) return { Authorization: `Bearer ${pat}` };
  const secret = (process.env.OSHAL_SERVICE_SECRET || process.env.SWARM_SERVICE_SECRET || '').trim();
  const sub = (process.env.OSHAL_USER_SUB || (process.env.OSHAL_OPERATOR_SUBS || '').split(',')[0] || '').trim();
  if (secret && sub) return { 'X-Service-Secret': secret, 'X-OSHAL-User-Sub': sub };
  throw new Error('no auth: set OSHAL_CLI_TOKEN (swarm-cli login) or SWARM_SERVICE_SECRET + OSHAL_USER_SUB/OSHAL_OPERATOR_SUBS');
}

async function post(path: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: '{}' });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function main(): Promise<void> {
  if (RUN_FORWARD) {
    const f = await post('/api/trading/lab/forward-run');
    const results = (f.results ?? []) as Array<{ name: string; applied: number; error?: string }>;
    const applied = results.reduce((s, r) => s + (r.applied || 0), 0);
    console.log(`Forward: ${applied} session(s) applied across ${results.length} strategies.`);
    for (const r of results.filter((x) => x.error)) console.log(`  ! ${r.name}: ${r.error}`);
  }

  const j = await post('/api/trading/lab/regression-run');
  const verdicts = (j.verdicts ?? []) as Array<{ strategyName: string; status: string; deltas?: { totalReturnPct: number; maxDrawdownPct: number; trades: number }; error?: string }>;
  if (!verdicts.length) {
    console.log('No baselined strategies to regress — save a strategy and run its first backtest to pin a baseline.');
    console.log(`RESULT ${JSON.stringify({ regressions: 0, drifted: 0, failed: 0 })}`);
    return;
  }
  console.log(`\nRegression verdicts (${verdicts.length}):`);
  for (const v of verdicts) {
    const d = v.deltas ? ` Δret=${v.deltas.totalReturnPct} Δdd=${v.deltas.maxDrawdownPct} Δtrades=${v.deltas.trades}` : '';
    console.log(`  ${v.status === 'ok' ? '✓' : '✗'} ${v.strategyName}: ${v.status}${d}${v.error ? ` — ${v.error}` : ''}`);
  }
  const drifted = verdicts.filter((v) => v.status === 'drifted').length;
  const failed = verdicts.filter((v) => v.status === 'failed').length;
  console.log(`RESULT ${JSON.stringify({ regressions: verdicts.length, drifted, failed })}`);
  if (drifted || failed) {
    console.error(`\n${drifted} drifted / ${failed} failed — a pinned-window rerun no longer reproduces its baseline. Investigate before trusting ANY current backtest numbers.`);
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error(`FAIL: ${(err as Error).message}`); process.exitCode = 2; });
