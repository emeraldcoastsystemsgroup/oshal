/**
 * Kalshi structural-arbitrage scan — edges that need no forecasting.
 *
 * Sweeps every open event's nested order book for internal price contradictions (overround /
 * ladder-inclusion / underround; see arbitrage.ts) and prints the baskets, net of the taker fee
 * on every leg. Writes a dated evidence snapshot so a scan can be graded later.
 *
 * Run: npx ts-node -r tsconfig-paths/register --transpile-only scripts/oshal-kalshi-arb.ts [maxEvents]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — live structural-arb sweep + evidence snapshot.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { scanArbitrage } from '../src/features/prediction-markets';

const MAX_EVENTS = Number(process.argv[2]) || 4000;

async function main(): Promise<void> {
  console.log(`[arb] sweeping up to ${MAX_EVENTS} open events for internal price contradictions...`);
  const { opportunities, eventsScanned, marketsScanned } = await scanArbitrage(MAX_EVENTS);
  const locks = opportunities.filter((o) => o.guaranteed);
  const candidates = opportunities.filter((o) => !o.guaranteed);
  console.log(`[arb] scanned ${eventsScanned} events / ${marketsScanned} markets`);
  console.log(`[arb] GUARANTEED locks: ${locks.length} | exhaustiveness-dependent candidates: ${candidates.length}\n`);

  for (const o of locks.slice(0, 20)) {
    console.log(`LOCK  ${o.strategy.toUpperCase()}  +$${o.profitPerBasket.toFixed(3)}/basket  (${(o.returnPct * 100).toFixed(1)}% on $${o.costPerBasket.toFixed(2)} at risk)`);
    console.log(`      ${o.title.slice(0, 90)}  [${o.eventTicker}]`);
    for (const l of o.legs) console.log(`        buy ${l.buy.toUpperCase().padEnd(3)} @ ${(l.price * 100).toFixed(1)}¢ (+${(l.fee * 100).toFixed(1)}¢ fee)  ${l.subtitle.slice(0, 40)}`);
    console.log(`      ${o.rationale}\n`);
  }
  if (candidates.length) {
    console.log(`--- candidates (NOT locks — need the event to be collectively exhaustive) ---`);
    for (const o of candidates.slice(0, 8)) {
      console.log(`CAND  ${o.strategy}  +$${o.profitPerBasket.toFixed(3)} (${(o.returnPct * 100).toFixed(1)}%)  ${o.title.slice(0, 70)} [${o.legs.length} legs]`);
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const out = path.resolve(__dirname, '..', 'docs', 'evidence', `kalshi-arb-${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), eventsScanned, marketsScanned, locks: locks.length, candidates: candidates.length, opportunities }, null, 2));
  console.log(`\n[arb] snapshot -> ${out}`);
}

main().then(() => { process.exitCode = 0; }).catch((err) => { console.error('[arb] FAILED', err); process.exitCode = 1; });
