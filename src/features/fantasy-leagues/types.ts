/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-146 D2: the league-shape types the fantasy-leagues kernel skill reads and returns. Moved from sports-edge's sports-fantasy-scoring.ts together with the ESPN read client, so the one client and every package that calls it share a single definition of a scoring rule, a starting slot and a player instead of structurally-compatible copies that could drift apart.
 *
 * @module fantasy-leagues/types
 */

/**
 * @description One scoring rule from a league's settings: how many points one unit of a stat is
 * worth. The stat id's MEANING is deliberately not interpreted anywhere in this skill — the league
 * defines it, which is why a hardcoded stat table can never be the source of a point total.
 */
export interface ScoringItem {
  /** ESPN stat id. Its meaning is the league's, never assumed here. */
  statId: number;
  /** Points per unit of that stat. May be negative (interceptions, fumbles). */
  points: number;
}

/**
 * @description One starting-lineup slot and how many of it a league fields. Bench and IR slots are
 * never part of a starting lineup and are excluded wherever settings are read.
 */
export interface LineupSlot {
  /** ESPN lineup slot id. */
  slotId: number;
  /** How many of this slot the league starts. */
  count: number;
}

/**
 * @description A player as a lineup decision needs them: raw projected stats plus where they may be
 * started. Points are not a field — they only exist once a league's scoring rules are applied.
 */
export interface FantasyPlayer {
  playerId: number;
  name: string;
  /** ESPN lineup slot ids this player may occupy. */
  eligibleSlots: number[];
  /** Raw projected stats for the week, keyed by ESPN stat id as a string. */
  projectedStats: Record<string, number>;
  /** Raw ACTUAL stats for the week once played, same keying. Absent before kickoff. */
  actualStats?: Record<string, number>;
  /** ESPN's injury status string, e.g. 'ACTIVE', 'OUT', 'QUESTIONABLE'. */
  injuryStatus?: string;
  /** Opponent's pro team id for the week, when known. */
  opponentProTeamId?: number;
  /** Team abbreviation the player plays for, for the matchup adjustment. */
  proTeam?: string;
  /** Opponent team abbreviation, for the matchup adjustment. */
  opponent?: string;
}
