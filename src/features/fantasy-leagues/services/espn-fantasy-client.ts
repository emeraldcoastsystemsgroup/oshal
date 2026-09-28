/**
 * ESPN Fantasy client — the public projection feed, and a private league read with the caller's
 * brokered cookies. The `fantasy-leagues` kernel skill (ADR-146 D2): every package that reads a
 * fantasy league calls this one client instead of carrying its own copy.
 *
 * TWO HALVES WITH VERY DIFFERENT SECURITY PROPERTIES, and keeping them apart is the point of this
 * module:
 *
 *   - THE PUBLIC HALF needs no credential at all. `fetchProjections` reads ESPN's whole player
 *     universe — 11,617 players, ~39MB — carrying per-week RAW projected stats for every one. It is
 *     the same data for everybody, so a caller fetches it once and caches it, never per request.
 *     `readCurrentScoringPeriod` reads the season's current week, also without a credential.
 *   - THE PRIVATE HALF needs the caller's `SWID` + `espn_s2` cookies. ESPN publishes no OAuth for
 *     fantasy, so these are ACCOUNT SESSION cookies rather than a scoped token. THE CREDENTIAL RULE:
 *     the calling package resolves them per request from the connector broker and hands them here;
 *     this module puts them on exactly the outbound league request and nowhere else. It never logs
 *     them (the log events carry the URL only), never returns them, never stores them, and never
 *     places them anywhere a model can read. A league the caller cannot see answers 401 and is
 *     reported as a refusal rather than guessed at.
 *
 * FIXED HOST. Every URL is built from the one ESPN fantasy origin below; a caller supplies only a
 * season, a week, view names and a league id, and the league id is percent-encoded into a single
 * path segment. No caller-supplied value can choose where a credential is sent.
 *
 * ⚠ THE FILTER HEADER IS REQUIRED, AND ITS `limit` IS IGNORED. Both halves were measured live
 * 2026-09-08, and getting it half-right already cost one bug:
 *     no `x-fantasy-filter` header  ->     50 players (ESPN's default page)
 *     with the header               -> 11,617 players (~39MB), whatever limit is asked for
 * Without it the feed silently returns fifty alphabetically-early players and a roster full of
 * unprojected names, which looks like missing data rather than a truncated request.
 *
 * `appliedTotal` IS NOT USED, deliberately. It is null in the public feed because a fantasy point
 * total requires a league's scoring rules. Points are computed by the caller from the raw stats and
 * the league's own `scoringItems`, which is both correct for a non-standard league and free of any
 * hardcoded guess about what a stat id means.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-146 D2 (operator decision 2026-09-27, Q1): moved from sports-edge's src-routes/sports-fantasy-espn.ts into the fantasy-leagues kernel skill, unchanged in behaviour, so a second fantasy package calls one client instead of copying it (the store has no package-to-package rail, and this client's host already moved once inside a season). It arrives with its history: credential split/normalisation and private league reads (settings, teams, rosters, matchups) with the caller's cookies on exactly one request; the required x-fantasy-filter header on the player feed; the week's schedule and the opponent it resolves; the classified reason a settings or schedule read came back empty; and the completed weeks' actual stat lines kept from the same feed response, filtered by season, source and split. New here: readCurrentScoringPeriod, the season-metadata read sports-edge's routes made with a private copy of the fantasy host, so no package needs that host at all.
 *
 * @module fantasy-leagues/espn-fantasy-client
 */

import {
  getJson, readWithOutcome, type FantasyReadFailure, type FantasyReadOptions,
} from './espn-fantasy-http';
import type { FantasyPlayer, LineupSlot, ScoringItem } from '../types';

const FANTASY_API = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

/**
 * The filter header the season-level player feed requires. Its PRESENCE is what returns the full
 * player universe; the `limit` value is ignored by ESPN today and is set high so that a future ESPN
 * which honours it still returns everything.
 */
export const PLAYER_FEED_FILTER = JSON.stringify({ players: { limit: 20000 } });

/** The caller's ESPN cookies, split from the stored `SWID:espn_s2` secret. */
export interface FantasyCredential {
  /** Braced GUID, e.g. `{ABC-...}`. */
  swid: string;
  espnS2: string;
}

/**
 * @description Split the stored connector secret into its two cookies and normalise the SWID to its
 * braced form. The stored shape is `SWID:espn_s2`; a braced GUID contains no colon, so the FIRST
 * colon is the separator and an `espn_s2` containing colons survives intact.
 * @param secret - The brokered secret, or null when the caller has not connected.
 * @returns The credential, or null when absent or malformed. Never throws — a malformed secret is
 * "not connected", not an error to surface.
 */
export function parseCredential(secret: string | null | undefined): FantasyCredential | null {
  if (!secret) return null;
  const i = secret.indexOf(':');
  if (i < 1 || i >= secret.length - 1) return null;
  const raw = secret.slice(0, i).trim();
  const espnS2 = secret.slice(i + 1).trim();
  if (!raw || !espnS2) return null;
  return { swid: raw.startsWith('{') ? raw : `{${raw}}`, espnS2 };
}

/**
 * @description The cookie header for a private league read. Kept as its own function so there is
 * exactly one place the credential is turned into a header, and so a test can assert both cookies
 * are present — one alone authenticates nothing.
 * @param cred - The caller's credential.
 * @returns Headers for the request.
 */
export function cookieHeader(cred: FantasyCredential): Record<string, string> {
  return { Cookie: `SWID=${cred.swid}; espn_s2=${cred.espnS2}`, Accept: 'application/json' };
}

/**
 * @description Read a league with the given views. Adding `?view=` more than once is how ESPN
 * composes a response, so views are appended individually rather than comma-joined.
 * @param season - Season year.
 * @param leagueId - The league's numeric id.
 * @param views - ESPN view names, e.g. `mSettings`, `mTeam`, `mRoster`, `mMatchup`.
 * @param cred - The caller's cookies, or null for a public league.
 * @param opts - HTTP options (retry, logging, failure reporting).
 * @returns The league payload, or null when unreachable or not permitted.
 */
export async function readLeague(
  season: number, leagueId: string, views: string[], cred: FantasyCredential | null, opts: FantasyReadOptions = {},
): Promise<any | null> {
  const qs = views.map((v) => `view=${encodeURIComponent(v)}`).join('&');
  const url = `${FANTASY_API}/seasons/${season}/segments/0/leagues/${encodeURIComponent(leagueId)}${qs ? `?${qs}` : ''}`;
  return getJson(url, opts, cred ? cookieHeader(cred) : undefined);
}

/** A league's identity and the two rule sets every lineup decision depends on. */
export interface LeagueSettings {
  leagueId: string;
  season: number;
  name: string;
  /** Current week. */
  scoringPeriodId: number;
  /** statId → points, straight from the league. No stat meaning is assumed anywhere. */
  scoring: ScoringItem[];
  /** The starting lineup's slots and how many of each. Bench and IR slots are excluded. */
  slots: LineupSlot[];
}

/** ESPN lineup slot ids that are not part of the STARTING lineup. 20 = bench, 21 = IR. */
export const NON_STARTING_SLOTS = new Set([20, 21]);

/**
 * @description Read a league's name, current week, scoring rules and starting-lineup slots.
 * @param season - Season year.
 * @param leagueId - League id.
 * @param cred - The caller's cookies, or null for a public league.
 * @param opts - HTTP options.
 * @returns The settings, or null when the league is unreachable or not permitted.
 */
export async function readLeagueSettings(
  season: number, leagueId: string, cred: FantasyCredential | null, opts: FantasyReadOptions = {},
): Promise<LeagueSettings | null> {
  const body = await readLeague(season, leagueId, ['mSettings'], cred, opts);
  if (!body) return null;
  const settings = body.settings || {};
  const scoringItems = settings.scoringSettings?.scoringItems || [];
  const lineup = settings.rosterSettings?.lineupSlotCounts || {};
  const slots: LineupSlot[] = Object.entries(lineup)
    .map(([slotId, count]) => ({ slotId: Number(slotId), count: Number(count) }))
    .filter((s) => s.count > 0 && !NON_STARTING_SLOTS.has(s.slotId));
  return {
    leagueId: String(leagueId),
    season,
    name: String(settings.name || body.name || `League ${leagueId}`),
    scoringPeriodId: Number(body.scoringPeriodId) || 1,
    scoring: scoringItems
      .map((it: any) => ({ statId: Number(it.statId), points: Number(it.points) }))
      .filter((it: ScoringItem) => Number.isFinite(it.statId) && Number.isFinite(it.points)),
    slots,
  };
}

/** A settings read, with the reason it came back empty when it did. */
export interface LeagueSettingsRead {
  settings: LeagueSettings | null;
  /** Null when the settings came back; otherwise the classified reason they did not. */
  failure: FantasyReadFailure | null;
}

/**
 * @description Read a league's settings and say WHY when nothing comes back. A caller that cannot
 * tell "we never reached ESPN" from "ESPN refused this league" can only guess from whether a
 * credential is stored, which is how a dead resolver came to be reported as "connect your ESPN
 * account" to someone whose account was already connected.
 * @param season - Season year.
 * @param leagueId - League id.
 * @param cred - The caller's cookies, or null for a public league.
 * @param opts - HTTP options.
 * @returns The settings, and the classified failure when there are none.
 */
export async function readLeagueSettingsOutcome(
  season: number, leagueId: string, cred: FantasyCredential | null, opts: FantasyReadOptions = {},
): Promise<LeagueSettingsRead> {
  const { value, failure } = await readWithOutcome(opts, (o) => readLeagueSettings(season, leagueId, cred, o));
  return { settings: value, failure };
}

/** One fantasy team in the league. */
export interface FantasyTeam {
  teamId: number;
  name: string;
  abbrev: string;
  /** Owner SWIDs, so the caller's own team can be identified without asking them. */
  owners: string[];
  /** Player ids currently in the STARTING lineup, and everyone on the roster. */
  startingPlayerIds: number[];
  rosterPlayerIds: number[];
  /** Raw roster entries, carrying each player's slot and ESPN's own player record. */
  entries: Array<{ playerId: number; lineupSlotId: number; player: any }>;
}

/**
 * @description Read every team in the league with its current roster and starting lineup.
 * @param season - Season year.
 * @param leagueId - League id.
 * @param week - Scoring period whose lineup to read.
 * @param cred - The caller's cookies, or null for a public league.
 * @param opts - HTTP options.
 * @returns Teams, or an empty array when unreachable.
 */
export async function readTeams(
  season: number, leagueId: string, week: number, cred: FantasyCredential | null, opts: FantasyReadOptions = {},
): Promise<FantasyTeam[]> {
  const qs = `?scoringPeriodId=${week}&view=mRoster&view=mTeam`;
  const url = `${FANTASY_API}/seasons/${season}/segments/0/leagues/${encodeURIComponent(leagueId)}${qs}`;
  const body = await getJson(url, opts, cred ? cookieHeader(cred) : undefined);
  const out: FantasyTeam[] = [];
  for (const t of body?.teams || []) {
    const entries = (t.roster?.entries || []).map((e: any) => ({
      playerId: Number(e.playerId),
      lineupSlotId: Number(e.lineupSlotId),
      player: e.playerPoolEntry?.player || e.player || {},
    }));
    out.push({
      teamId: Number(t.id),
      name: String(t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${t.id}`).trim(),
      abbrev: String(t.abbrev || ''),
      owners: (t.owners || []).map((o: any) => String(o)),
      entries,
      rosterPlayerIds: entries.map((e: { playerId: number }) => e.playerId),
      startingPlayerIds: entries
        .filter((e: { lineupSlotId: number }) => !NON_STARTING_SLOTS.has(e.lineupSlotId))
        .map((e: { playerId: number }) => e.playerId),
    });
  }
  return out;
}

/**
 * @description Find the caller's own team by matching their SWID against the league's owner ids, so
 * they never have to look up a team id by hand.
 * @param teams - Teams in the league.
 * @param swid - The caller's braced SWID.
 * @returns Their team, or null when the SWID owns none (a league they were removed from).
 */
export function findOwnTeam(teams: FantasyTeam[], swid: string): FantasyTeam | null {
  const want = swid.toUpperCase();
  return teams.find((t) => t.owners.some((o) => o.toUpperCase() === want)) || null;
}

/** A player distilled from the public feed to just what a lineup decision needs. */
export interface DistilledPlayer extends FantasyPlayer {
  proTeamId: number;
  defaultPositionId: number;
  percentOwned: number;
}

/**
 * @description Reduce ESPN's ~39MB player universe to the fields a lineup decision needs, for one
 * week. Everything else — historical splits, ownership trend series, draft ranks — is dropped
 * before anything is stored, because storing 39MB per week to read six fields is how a cache
 * becomes the problem it was meant to solve.
 * @param feed - The raw array from the players endpoint.
 * @param season - Season whose projections to keep.
 * @param week - Scoring period whose projections to keep.
 * @returns Players keyed by player id.
 */
export function distilProjections(feed: any[], season: number, week: number): Record<number, DistilledPlayer> {
  const out: Record<number, DistilledPlayer> = {};
  for (const entry of feed || []) {
    const p = (entry && typeof entry === 'object' && 'player' in entry) ? entry.player : entry;
    if (!p || typeof p !== 'object' || !Number.isFinite(Number(p.id))) continue;
    const rows = p.stats || [];
    const proj = rows.find((s: any) => s.seasonId === season && s.scoringPeriodId === week
      && s.statSourceId === 1 && s.statSplitTypeId === 1);
    const actual = rows.find((s: any) => s.seasonId === season && s.scoringPeriodId === week
      && s.statSourceId === 0 && s.statSplitTypeId === 1);
    if (!proj && !actual) continue;
    out[Number(p.id)] = {
      playerId: Number(p.id),
      name: String(p.fullName || ''),
      eligibleSlots: (p.eligibleSlots || []).map((n: any) => Number(n)),
      projectedStats: (proj?.stats || {}) as Record<string, number>,
      actualStats: actual?.stats as Record<string, number> | undefined,
      injuryStatus: p.injuryStatus ? String(p.injuryStatus) : undefined,
      proTeamId: Number(p.proTeamId) || 0,
      defaultPositionId: Number(p.defaultPositionId) || 0,
      percentOwned: Number(p.ownership?.percentOwned) || 0,
    };
  }
  return out;
}

/** One COMPLETED week's actual stat line for one player, exactly as the feed carries it. */
export interface PlayerWeekActual {
  playerId: number;
  /** Scoring period the line was scored in. Never 0 — that row is the season total, not a week. */
  week: number;
  /** Raw actual stats, keyed by ESPN stat id. Points are NOT computed here: they do not exist
   *  until a league's scoring rules are applied, exactly as for projections. */
  stats: Record<string, number>;
}

/**
 * @description Keep every completed week's ACTUAL stat line the same response already carries.
 *
 * This is the half of the feed `distilProjections` throws away. That function is asked for one
 * week and keeps one week, which is right for a lineup decision and wrong for everything that needs
 * a player's history — and the history is the only thing that can make one player's spread differ
 * from another's at the same position and projection. Without it every candidate gets the positional
 * prior times his projection, two similar players get nearly identical spreads, and the
 * win-probability objective has nothing to trade.
 *
 * Measured live 2026-09-16, one credential-free request for `scoringPeriodId=3`: 11,617 players,
 * 1,740 rows with `statSourceId:0, statSplitTypeId:1, scoringPeriodId:1` (1,348 of them carrying
 * stats), and zero extra calls needed to get them.
 *
 * THREE FILTERS, AND EACH ONE IS LOAD-BEARING:
 *   - `seasonId` — the same response carried 69,653 rows from the PRIOR season on that run. Without
 *     this filter last year's weeks would be mixed into this year's history, which is worse than no
 *     history at all: it would look like evidence.
 *   - `statSourceId === 0` — source 1 is ESPN's projection. A projection has no dispersion to
 *     measure; feeding it back in would produce a spread estimated from a model's own smoothness.
 *   - `statSplitTypeId === 1` and `scoringPeriodId >= 1` — split 0 / period 0 is the SEASON total,
 *     which would enter the history as one enormous week.
 * @param feed - The raw array from the players endpoint.
 * @param season - Season whose weeks to keep.
 * @returns One row per player per completed week that produced stats.
 */
export function distilPlayerWeeks(feed: any[], season: number): PlayerWeekActual[] {
  const out: PlayerWeekActual[] = [];
  for (const entry of feed || []) {
    const p = (entry && typeof entry === 'object' && 'player' in entry) ? entry.player : entry;
    if (!p || typeof p !== 'object' || !Number.isFinite(Number(p.id))) continue;
    for (const row of p.stats || []) {
      if (row?.seasonId !== season || row?.statSourceId !== 0 || row?.statSplitTypeId !== 1) continue;
      const week = Number(row.scoringPeriodId);
      if (!Number.isFinite(week) || week < 1) continue;
      const stats = row.stats;
      if (!stats || typeof stats !== 'object' || !Object.keys(stats).length) continue;
      out.push({ playerId: Number(p.id), week, stats: stats as Record<string, number> });
    }
  }
  return out;
}

/** The whole player universe, reduced: this week's projections and every completed week's actuals. */
export interface PlayerFeed {
  /** Distilled players for the requested week, keyed by id. */
  players: Record<number, DistilledPlayer>;
  /** Every completed week's actual stat line, for the scoring history. */
  weeks: PlayerWeekActual[];
}

/**
 * @description Fetch and distil the public player projections for one week. No credential is used
 * or needed. The response is large and the season-level filter header is ignored by ESPN, so this
 * belongs in a cached daily job and never on a request path.
 *
 * ONE REQUEST, BOTH HALVES. The response carries the completed weeks' actual lines as well as the
 * projections, so the scoring history costs nothing extra here and would cost a second ~40MB fetch
 * per week if it were asked for separately.
 * @param season - Season year.
 * @param week - Scoring period.
 * @param opts - HTTP options; give this a long timeout.
 * @returns The distilled players for the week and every completed week's actual lines; both empty
 *          when the feed is unreachable.
 */
export async function fetchProjections(
  season: number, week: number, opts: FantasyReadOptions = {},
): Promise<PlayerFeed> {
  const url = `${FANTASY_API}/seasons/${season}/players?scoringPeriodId=${week}&view=kona_player_info`;
  const feed = await getJson(url, { timeoutMs: 90_000, ...opts }, {
    Accept: 'application/json',
    // REQUIRED. Without this header ESPN returns its default page of 50 players; with it, the
    // whole universe. The limit value itself is ignored — it is set high so a future ESPN that
    // honours it still returns everything rather than truncating us to a page.
    'x-fantasy-filter': PLAYER_FEED_FILTER,
  });
  if (!Array.isArray(feed)) return { players: {}, weeks: [] };
  return { players: distilProjections(feed, season, week), weeks: distilPlayerWeeks(feed, season) };
}

/** One week's fixture: the two fantasy teams whose scores are compared. */
export interface FantasyMatchup {
  matchupPeriodId: number;
  homeTeamId: number;
  /** Absent in a league with an odd number of teams, where one team has a bye. */
  awayTeamId: number | null;
}

/**
 * @description Read the league's schedule so a lineup can be optimised against the one team whose
 * score has to be beaten.
 *
 * ESPN keys the schedule by `matchupPeriodId`, which is NOT the same field as the `scoringPeriodId`
 * a lineup is set for. They coincide in a standard weekly football league and diverge in the
 * multi-week playoff formats some leagues use, so the caller's week is matched against the matchup
 * period and a miss returns nothing rather than the wrong fixture.
 * @param season - Season year.
 * @param leagueId - League id.
 * @param cred - The caller's cookies, or null for a public league.
 * @param opts - HTTP options.
 * @returns Every fixture in the season, or an empty array when the schedule is unreadable.
 */
export async function readMatchups(
  season: number, leagueId: string, cred: FantasyCredential | null, opts: FantasyReadOptions = {},
): Promise<FantasyMatchup[]> {
  const body = await readLeague(season, leagueId, ['mMatchup'], cred, opts);
  const out: FantasyMatchup[] = [];
  for (const m of body?.schedule || []) {
    const home = Number(m?.home?.teamId);
    if (!Number.isFinite(home)) continue;
    const away = Number(m?.away?.teamId);
    out.push({
      matchupPeriodId: Number(m?.matchupPeriodId) || 0,
      homeTeamId: home,
      awayTeamId: Number.isFinite(away) ? away : null,
    });
  }
  return out;
}

/**
 * @description The team a given team plays in a given week.
 * @param matchups - The season's fixtures.
 * @param teamId - The team whose opponent is wanted.
 * @param week - Matchup period.
 * @returns The opponent's team id, or null on a bye, an unplayed week, or an unreadable schedule —
 *          all of which mean the same thing to the OPTIMISER: play against nobody. They do not mean
 *          the same thing to the person reading the screen; use `opponentOutcomeFor` for that.
 */
export function opponentTeamFor(matchups: FantasyMatchup[], teamId: number, week: number): number | null {
  for (const m of matchups) {
    if (m.matchupPeriodId !== week) continue;
    if (m.homeTeamId === teamId) return m.awayTeamId;
    if (m.awayTeamId === teamId) return m.homeTeamId;
  }
  return null;
}

/** A schedule read, with the reason it came back empty when it did. */
export interface MatchupsRead {
  matchups: FantasyMatchup[];
  /** Null when the schedule came back; otherwise the classified reason it did not. */
  failure: FantasyReadFailure | null;
}

/**
 * @description Read the season's fixtures and say WHY when none come back. An empty schedule and an
 * unreadable one are the same array, and telling a manager he has a bye when ESPN simply could not
 * be read is a wrong reason attached to a right lineup.
 * @param season - Season year.
 * @param leagueId - League id.
 * @param cred - The caller's cookies, or null for a public league.
 * @param opts - HTTP options.
 * @returns The fixtures, and the classified failure when the read produced none.
 */
export async function readMatchupsOutcome(
  season: number, leagueId: string, cred: FantasyCredential | null, opts: FantasyReadOptions = {},
): Promise<MatchupsRead> {
  const { value, failure } = await readWithOutcome(opts, (o) => readMatchups(season, leagueId, cred, o));
  return { matchups: value, failure };
}

/** Why a week has no opponent. Only `bye` means there is genuinely nobody to play. */
export type NoOpponentReason = 'bye' | 'not-scheduled';

/** A week's opponent, or which kind of "none" it is. */
export interface OpponentOutcome {
  opponentTeamId: number | null;
  reason: 'opponent' | NoOpponentReason;
}

/**
 * @description Resolve a week's opponent and, when there is none, which kind of none. A fixture
 * that exists with only one side is a bye; no fixture at all for that matchup period is a schedule
 * that does not cover the week. Both are legitimate and neither is a failure — but they are also
 * not the same sentence, and neither is a schedule the caller could not read at all.
 * @param matchups - The season's fixtures.
 * @param teamId - The team whose opponent is wanted.
 * @param week - Matchup period.
 * @returns The opponent id and the reason there is or is not one.
 */
export function opponentOutcomeFor(
  matchups: FantasyMatchup[], teamId: number, week: number,
): OpponentOutcome {
  for (const m of matchups) {
    if (m.matchupPeriodId !== week) continue;
    if (m.homeTeamId === teamId) {
      return m.awayTeamId === null
        ? { opponentTeamId: null, reason: 'bye' }
        : { opponentTeamId: m.awayTeamId, reason: 'opponent' };
    }
    if (m.awayTeamId === teamId) return { opponentTeamId: m.homeTeamId, reason: 'opponent' };
  }
  return { opponentTeamId: null, reason: 'not-scheduled' };
}

/**
 * @description ESPN's current scoring period for a season, read from the season metadata endpoint,
 * which needs no credential and is never sent one.
 * @param season - Season year.
 * @param opts - HTTP options.
 * @returns The current week, defaulting to 1 when the metadata is unavailable.
 */
export async function readCurrentScoringPeriod(season: number, opts: FantasyReadOptions = {}): Promise<number> {
  const body = await getJson(`${FANTASY_API}/seasons/${season}`, opts);
  return Number(body?.currentScoringPeriod?.id) || 1;
}
