/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Redis key-family grouping for the data-model explorer. The explorer shows key FAMILIES (the first two `:` segments) with counts and value types - never a value, never a full key. Any segment that looks like an email, UUID/hex id or long number is masked to `*` so a family label cannot carry a user identifier.
 */

/**
 * @description Mask a key segment that could identify a person or a record.
 * @param seg - one `:`-separated segment
 * @returns the segment, or `*` when it looks like an email, id or long number
 */
export function maskSegment(seg: string): string {
  if (seg.includes('@')) return '*';
  if (/^[0-9a-f-]{8,}$/i.test(seg)) return '*';
  if (/\d{4,}/.test(seg)) return '*';
  return seg;
}

/**
 * @description The family a key belongs to: its first two segments (masked), or its first segment
 * plus `:*` when it has only two.
 * @param key - a Redis key
 * @returns the family label
 */
export function keyFamily(key: string): string {
  const parts = key.split(':');
  if (parts.length === 1) return maskSegment(parts[0]);
  if (parts.length === 2) return `${maskSegment(parts[0])}:*`;
  return `${maskSegment(parts[0])}:${maskSegment(parts[1])}`;
}

/** A family with its key count and a sample of keys whose TYPE will be read. */
export interface FamilyTally {
  prefix: string;
  keys: number;
  sample: string[];
}

/**
 * @description Tally scanned keys into families, keeping a bounded sample per family for TYPE reads.
 * @param keys - scanned keys
 * @param sampleSize - keys to keep per family
 * @returns families, largest first
 */
export function tallyFamilies(keys: string[], sampleSize: number): FamilyTally[] {
  const byPrefix = new Map<string, FamilyTally>();
  for (const key of keys) {
    const prefix = keyFamily(key);
    const tally = byPrefix.get(prefix) ?? { prefix, keys: 0, sample: [] };
    tally.keys += 1;
    if (tally.sample.length < sampleSize) tally.sample.push(key);
    byPrefix.set(prefix, tally);
  }
  return [...byPrefix.values()].sort((a, b) => b.keys - a.keys || a.prefix.localeCompare(b.prefix));
}
