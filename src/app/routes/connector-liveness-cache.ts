/**
 * Connector liveness probe cache — the ≤15-minute memo behind GET /api/connect/liveness.
 *
 * This lives in its OWN module for one reason: the cache must be invalidated by the code that
 * WRITES a connection (connector-tenancy.upsertConnection), and connector-liveness already imports
 * connector-tenancy. Putting the Map here lets both sides import it with no cycle — the same shape
 * `per-user-schedule-reconcile` uses for the other post-write side effect on that path.
 *
 * Why invalidation matters: a probe result is the PROVIDER's answer about a grant, and reconnecting
 * replaces the grant. Without a hook here a successful reconnect kept reading `needs_reconnect` for
 * up to 15 minutes, which is indistinguishable from the reconnect having failed — the operator
 * reconnects, the screen does not change, and the honest conclusion from their seat is that the
 * product is broken.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — extract the probe cache out of connector-liveness so a connection write can invalidate it without an import cycle; adds invalidateConnectorLiveness(provider).
 *
 * @module connector-liveness-cache
 */

/** Probe outcome for one (caller, provider). */
export type LivenessStatus = 'ok' | 'needs_reconnect' | 'unknown';

/** A memoised probe result. */
export interface LivenessCacheEntry {
  status: LivenessStatus;
  detail?: string;
  checkedAt: number;
}

/** Cache TTL: 15 minutes, per the G14 done-when. */
export const CACHE_TTL_MS = 15 * 60 * 1000;

/** (sub|provider) → last probe. Process-local by design; an api restart starts cold. */
const cache = new Map<string, LivenessCacheEntry>();

/**
 * @description Cache key for one caller/provider pair.
 * @param userSub - connection owner / member.
 * @param provider - provider slug.
 * @returns The map key.
 */
function keyOf(userSub: string, provider: string): string {
  return `${userSub}|${provider}`;
}

/**
 * @description Read a still-valid probe result, or undefined when absent or past the TTL.
 * @param userSub - connection owner / member.
 * @param provider - provider slug.
 * @param now - clock override for guards.
 * @returns The live entry, or undefined.
 */
export function getCachedLiveness(
  userSub: string, provider: string, now: number = Date.now(),
): LivenessCacheEntry | undefined {
  const hit = cache.get(keyOf(userSub, provider));
  if (!hit) return undefined;
  return now - hit.checkedAt < CACHE_TTL_MS ? hit : undefined;
}

/**
 * @description Memoise one probe result.
 * @param userSub - connection owner / member.
 * @param provider - provider slug.
 * @param entry - the result to remember.
 * @returns nothing
 */
export function setCachedLiveness(userSub: string, provider: string, entry: LivenessCacheEntry): void {
  cache.set(keyOf(userSub, provider), entry);
}

/**
 * @description Drop every memoised probe for one provider, across all callers.
 *
 * Provider-wide rather than keyed to the writer on purpose: a connection may be TENANT-shared, so
 * the person who reconnects is not necessarily the only one holding a stale `needs_reconnect` for
 * it. Invalidating only the writer would leave every other member of that household stale for the
 * rest of the TTL — the same defect this function exists to close, just harder to reproduce. The
 * cost of over-dropping is bounded and rare: entries are only re-probed on the next Connections
 * load, and a connection write is an operator action, not a hot path.
 * @param provider - provider slug whose grants just changed.
 * @returns How many entries were dropped (guards assert on this).
 */
export function invalidateConnectorLiveness(provider: string): number {
  const suffix = `|${provider}`;
  let dropped = 0;
  for (const key of Array.from(cache.keys())) {
    if (key.endsWith(suffix)) { cache.delete(key); dropped += 1; }
  }
  return dropped;
}

/**
 * @description Clear the whole cache — for unit guards only.
 * @returns nothing
 */
export function resetConnectorLivenessCacheForTesting(): void {
  cache.clear();
}
