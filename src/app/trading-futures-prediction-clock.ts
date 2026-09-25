/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Resolve explicitly configured archive wall time and refuse DST folds and gaps.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
/** @description Encode an actual UTC instant in the archive's wall fields.
 * @param instant - True UTC milliseconds. @param zone - Explicit archive zone. @returns Encoded wall milliseconds.
 */
export function futuresUtcToWall(instant: number, zone: string): number {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second, new Date(instant).getUTCMilliseconds());
}

/** @description Decode the archive's wall-clock-in-UTC-fields convention without silently choosing a DST occurrence.
 * @param stamp - Canonical encoded wall time, not an actual UTC timestamp. @param zone - Operator-confirmed archive zone.
 * @returns The unique true UTC instant in milliseconds, or throws for ambiguous/nonexistent times.
 */
export function futuresWallTimeUtc(stamp: string, zone: string): number {
  const wall = Date.parse(stamp);
  if (!Number.isFinite(wall) || new Date(wall).toISOString() !== stamp) throw new Error('Invalid canonical Futures wall timestamp');
  const offsets = new Set([-86_400_000, 0, 86_400_000].map(delta => futuresUtcToWall(wall + delta, zone) - (wall + delta)));
  const candidates = [...offsets].map(offset => wall - offset).filter(instant => futuresUtcToWall(instant, zone) === wall);
  if (candidates.length !== 1) throw new Error(`Ambiguous or nonexistent archive wall time: ${stamp} (${zone})`);
  return candidates[0];
}
