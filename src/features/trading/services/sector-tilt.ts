/**
 * Sector tilt — the dial for "lean harder on <sector>".
 *
 * A sector lean used to be expressed by hand-writing percentages into TRADING_CORE_SYMBOLS
 * (`XLE:8,XLB:6,...`), which pinned real capital into named ETFs. That shape has two problems the
 * operator hit directly: the lean cannot be dialed back down without rewriting the symbol list, and
 * the pinned ETFs sit OUTSIDE the ranked universe, so they neither compete on signal nor rotate out
 * when the trend they were bought for ends. A lean expressed there is a position, not a preference.
 *
 * This module makes the lean a knob over the RANKING instead. TRADING_SECTOR_TILT multiplies each
 * candidate's rotation score by its sector's tilt, so a leaned sector wins more of the top-N slots
 * while every name still earns its place on signal. Absent or empty → every multiplier is 1.0 and
 * the ranking is byte-identical to no-tilt.
 *
 * SAFETY PROPERTY (relied on by the caller and pinned by the unit spec): a tilt is a POSITIVE
 * multiplier, so it can never change a score's sign. rotateSleeve admits candidates on `score > 0`,
 * which means a tilt re-orders the eligible set but can NEVER promote a name the ranker scored
 * negative into a buy, nor demote a positive name out of contention. A lean cannot override the
 * signal — it only breaks ties in the leaned sector's favor. The one exception is deliberate: a tilt
 * of exactly 0 zeroes the score, which drops the sector out of `score > 0` entirely and is the
 * supported way to mute a sector without editing the universe.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — TRADING_SECTOR_TILT: sector lean as a rank multiplier, replacing a lean baked into TRADING_CORE_SYMBOLS percentages so it can be dialed up and back down without moving capital into pinned ETFs.
 *
 * @module sector-tilt
 */

import { sectorOf } from './portfolio';

/** The widest multiplier the knob accepts. Beyond this a "lean" is really a single-sector book. */
export const MAX_SECTOR_TILT = 5;

/** A ranked rotation candidate — the shape rankUniverse emits. */
export interface RankedName { sym: string; score: number; }

/**
 * @description Parse a TRADING_SECTOR_TILT string into a sector → multiplier map. Format is
 * `materials:1.5,energy:1.2` — a sector name (as bucketed by `sectorOf`) and a non-negative
 * multiplier, where 1.0 is neutral. Entries that name no sector, carry a non-finite multiplier, or
 * are otherwise malformed are SKIPPED rather than defaulted, so a typo degrades to neutral for that
 * sector instead of silently re-weighting the book. Multipliers are clamped to [0, MAX_SECTOR_TILT].
 * @param raw - The raw env value (undefined/empty → no tilt).
 * @returns Sector → multiplier for every well-formed entry; empty when there is nothing to apply.
 */
export function parseSectorTilt(raw: string | undefined | null): Map<string, number> {
  const tilt = new Map<string, number>();
  for (const entry of String(raw || '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.lastIndexOf(':');
    if (idx <= 0) continue; // no separator, or a leading ':' with no sector name
    const sector = trimmed.slice(0, idx).trim().toLowerCase();
    const mult = Number(trimmed.slice(idx + 1).trim());
    if (!sector || !Number.isFinite(mult) || mult < 0) continue;
    tilt.set(sector, Math.min(MAX_SECTOR_TILT, mult));
  }
  return tilt;
}

/**
 * @description Read the operator's configured sector tilt from the environment.
 * @returns Sector → multiplier; empty (neutral) when TRADING_SECTOR_TILT is unset or empty.
 */
export function sectorTiltConfig(): Map<string, number> {
  return parseSectorTilt(process.env.TRADING_SECTOR_TILT);
}

/**
 * @description Apply a sector tilt to ranked rotation candidates. Each score is multiplied by its
 * sector's tilt (default 1.0 — untilted sectors are untouched), which re-orders the leaderboard in
 * favour of leaned sectors without changing any score's sign. Returns a NEW array; the input is not
 * mutated, so the untilted ranking stays available to the caller for logging or comparison.
 * @param ranked - Candidates from rankUniverse ({sym, score}).
 * @param tilt - Sector → multiplier, as built by {@link sectorTiltConfig}.
 * @returns A new ranked array with tilted scores, in input order (the caller sorts).
 */
export function applySectorTilt(ranked: RankedName[], tilt: Map<string, number>): RankedName[] {
  if (!tilt.size) return ranked.map((r) => ({ ...r }));
  return ranked.map((r) => {
    const mult = tilt.get(sectorOf(r.sym));
    return { sym: r.sym, score: mult === undefined ? r.score : r.score * mult };
  });
}
