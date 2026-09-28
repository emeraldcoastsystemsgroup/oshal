/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-146 D2: barrel for the fantasy-leagues kernel skill — the one ESPN fantasy read client every fantasy package imports (`uses: [fantasy-leagues]`) instead of bundling a copy. Exports the reads, the pure league helpers and the types; the raw bounded GET stays internal, so a package can reach ESPN only through reads whose host is fixed.
 *
 * @module fantasy-leagues
 */

export {
  NON_STARTING_SLOTS,
  PLAYER_FEED_FILTER,
  cookieHeader,
  distilPlayerWeeks,
  distilProjections,
  fetchProjections,
  findOwnTeam,
  opponentOutcomeFor,
  opponentTeamFor,
  parseCredential,
  readCurrentScoringPeriod,
  readLeague,
  readLeagueSettings,
  readLeagueSettingsOutcome,
  readMatchups,
  readMatchupsOutcome,
  readTeams,
} from './services/espn-fantasy-client';
export type {
  DistilledPlayer,
  FantasyCredential,
  FantasyMatchup,
  FantasyTeam,
  LeagueSettings,
  LeagueSettingsRead,
  MatchupsRead,
  NoOpponentReason,
  OpponentOutcome,
  PlayerFeed,
  PlayerWeekActual,
} from './services/espn-fantasy-client';
export { classifyFailure } from './services/espn-fantasy-http';
export type {
  FantasyReadFailure,
  FantasyReadFailureKind,
  FantasyReadOptions,
} from './services/espn-fantasy-http';
export type { FantasyPlayer, LineupSlot, ScoringItem } from './types';
