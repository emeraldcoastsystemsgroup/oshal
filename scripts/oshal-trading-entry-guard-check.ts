/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — operator check for the rotation entry guards against the LIVE tape. Prints, per symbol, the prior-session close the guard actually resolved, the current price, the gap, and the verdict. Exists because the guard's real risk is not its logic (unit-tested) but its DATA: if priorSessionClose ever picked up today's own forming bar instead of yesterday's close, the gap would compute as ~0 and the guard would silently no-op on exactly the day it matters. This script proves the resolved close is yesterday's.
 *
 * Usage:  npx tsx scripts/oshal-trading-entry-guard-check.ts [SYM,SYM,...]
 */
import 'dotenv/config';
import {
  barsBatchSince, latestPrice, priorSessionClose, etSessionDate, gapPct, entryBlock, maxGapDownPct,
  type EntryGuardInput,
} from '@/features/trading';

async function main(): Promise<void> {
  const syms = (process.argv[2] || 'IBM,EOG,SPY,AMAT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const today = etSessionDate();
  const bar = maxGapDownPct();
  const since = new Date(Date.now() - 20 * 86400000).toISOString();
  const dated = await barsBatchSince(syms, since);

  console.log(`ET session date: ${today}    gap bar: ${bar > 0 ? `-${bar}%` : 'OFF'}\n`);
  const priorCloses = new Map<string, number>();
  const currentPrices = new Map<string, number>();

  for (const s of syms) {
    const series = dated.get(s) ?? [];
    const tail = series.slice(-3).map((b) => `${b.d}=${b.c.toFixed(2)}`).join('  ');
    const prior = priorSessionClose(series, today);
    const px = await latestPrice(s).catch(() => null);
    if (prior != null) priorCloses.set(s, prior);
    if (px && px > 0) currentPrices.set(s, px);
    const gap = prior != null && px ? gapPct(px, prior) : null;
    console.log(`${s.padEnd(5)} bars[ ${tail} ]`);
    console.log(`${''.padEnd(5)} resolved priorClose=${prior?.toFixed(2) ?? 'n/a'}  now=${px?.toFixed(2) ?? 'n/a'}  gap=${gap != null ? `${gap.toFixed(2)}%` : 'n/a'}`);
  }

  const input: EntryGuardInput = { exiting: new Set<string>(), priorCloses, currentPrices, maxGapDownPct: bar };
  console.log('\nVERDICTS (no protective exits pending):');
  for (const s of syms) {
    const b = entryBlock(s, input);
    console.log(`  ${s.padEnd(5)} ${b ? `REFUSED — ${b.reason}${b.gapPct != null ? ` (${b.gapPct.toFixed(2)}%)` : ''}` : 'allowed'}`);
  }

  console.log('\nVERDICTS (protective leg selling the first symbol this fire):');
  const withExit: EntryGuardInput = { ...input, exiting: new Set([syms[0]]) };
  const b = entryBlock(syms[0], withExit);
  console.log(`  ${syms[0].padEnd(5)} ${b ? `REFUSED — ${b.reason}` : 'allowed  <-- REGRESSION: this is the stop-then-rebuy round-trip'}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
