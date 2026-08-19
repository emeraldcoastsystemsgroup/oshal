/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add one bounded parser for every Postgres pool ceiling so managed deployments can enforce a connection budget without changing local defaults.
 */

/**
 * Resolve a positive integer pool ceiling from an environment value.
 * Invalid, fractional, zero, and negative values fall back instead of silently
 * creating an unbounded or unusable pool. Valid values are clamped to the
 * caller's explicit safety range.
 *
 * @param value - Raw environment value.
 * @param fallback - Existing local/default pool ceiling.
 * @param min - Smallest permitted ceiling.
 * @param max - Largest permitted ceiling.
 * @returns A bounded integer pool ceiling.
 */
export function resolvePoolMax(
  value: string | undefined,
  fallback: number,
  min = 1,
  max = 100,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * Produce a bounded Postgres application_name suitable for pg_stat_activity.
 *
 * @param value - Deployment/service label.
 * @param fallback - Stable label used when the input is blank.
 * @returns Printable, bounded application name.
 */
export function postgresApplicationName(value: string | undefined, fallback: string): string {
  const normalized = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
    .slice(0, 63);
  return normalized || fallback;
}
