/**
 * Gravity 2 world-snapshot reader — fetches the per-ticker world-metric set Gravity 2 needs, in ONE
 * batched query, and shapes it into the pure `WorldSnapshot` the mass model consumes.
 *
 * Keeps the DB read in the app layer so `deriveWorldMasses` (gravity-world.ts) stays pure + testable.
 * Uses the shared `metricsBatch` (the indexed GROUP BY) so a 100-name universe costs one round-trip.
 *
 * @module trading-world-masses
 */

import type { WorldIntelligenceService } from '@/features/world-data';
import { GRAVITY2_METRICS, type WorldSnapshot } from '@/features/trading';

const entityOf = (symbol: string): string => `world:ticker:${symbol.toLowerCase()}`;

/**
 * @description Read the Gravity-2 world snapshot for many tickers in one batched query.
 * @param svc - The world-intelligence service (TSDB-backed).
 * @param symbols - Tickers.
 * @param days - Recency window for each metric average (Gravity-2 config windowDays).
 * @returns Map of UPPERCASE symbol → its WorldSnapshot (symbols with no data are absent).
 */
export async function readGravityWorldSnapshots(svc: WorldIntelligenceService, symbols: string[], days: number): Promise<Map<string, WorldSnapshot>> {
  const out = new Map<string, WorldSnapshot>();
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
  if (!uniq.length) return out;
  let batch: Map<string, Map<string, { avg: number; points: number }>>;
  try { batch = await svc.metricsBatch(uniq.map(entityOf), GRAVITY2_METRICS, days); }
  catch { return out; }
  for (const sym of uniq) {
    const byMetric = batch.get(entityOf(sym));
    if (!byMetric || !byMetric.size) continue;
    const snap: WorldSnapshot = {};
    for (const [m, v] of byMetric) snap[m] = { avg: v.avg, points: v.points };
    out.set(sym, snap);
  }
  return out;
}
