/**
 * The fantasy-leagues kernel skill (ADR-146 D2) against a REAL local HTTP host shaped like ESPN's
 * fantasy API.
 *
 * WHY A LOOPBACK HOST AND NOT A FETCH STUB. The claims this client makes are protocol claims: both
 * cookies reach the league request and nothing else, the player feed carries the filter header, a
 * 4xx is not retried while a 5xx is, a refused league reads differently from an unreachable one,
 * and a caller-supplied league id cannot move the request off ESPN's host. A stub that returns
 * canned objects can assert none of that. Here the client's own `getJson` makes real requests with
 * the platform fetch over a real socket; the only substitution is the ORIGIN — `fetchImpl` rewrites
 * the fixed `https://lm-api-reads.fantasy.espn.com` prefix to `http://127.0.0.1:<port>` and refuses
 * any URL that does not start with it, so a read that built its URL anywhere else fails the test
 * instead of being quietly redirected. The public ESPN service is never contacted.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — settings/teams/schedule/current-week/player-feed reads over loopback HTTP; both cookies on league reads only; the required filter header; no retry on a 4xx and bounded retry on a 5xx; refused vs unavailable vs transport (refused connection and timeout); the fixed host under a hostile league id; the espn_s2 cookie absent from every log event, onError report and returned value, through an injected sink and the default Pino sink; and the Test Lab card that carries this suite.
 */

import { existsSync } from 'node:fs';
import http from 'node:http';
import { resolve as resolvePath } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

import {
  PLAYER_FEED_FILTER, cookieHeader, fetchProjections, findOwnTeam, opponentOutcomeFor, parseCredential,
  readCurrentScoringPeriod, readLeagueSettings, readLeagueSettingsOutcome, readMatchupsOutcome, readTeams,
  type FantasyCredential, type FantasyReadOptions,
} from '@/features/fantasy-leagues';
import { CONNECTOR_OAUTH_SCENARIOS } from '@/app/routes/test-lab-connector-scenarios';

const ORIGIN = 'https://lm-api-reads.fantasy.espn.com';
const SEASON = 2026;
const WEEK = 5;
const LEAGUE = '4321';
const SWID = '{SWID-OWNER-0001}';
const S2 = 's2-session-cookie-value:with:colons';
const CRED = parseCredential(`${SWID}:${S2}`) as FantasyCredential;
const LEAGUE_PATH = `/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues`;

/** What the fake host saw on one request. */
interface Seen { url: string; cookie: string | null; filter: string | null }

const SETTINGS = {
  scoringPeriodId: WEEK,
  settings: {
    name: 'Fixture League',
    scoringSettings: { scoringItems: [{ statId: 53, points: 1 }, { statId: 42, points: 0.1 }, { statId: 'x', points: 2 }] },
    rosterSettings: { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 16: 0, 20: 7, 21: 1, 23: 1 } },
  },
};
const TEAMS = {
  teams: [
    { id: 1, location: 'Razor', nickname: 'Hogs', abbrev: 'RH', owners: ['{swid-owner-0001}'], roster: { entries: [
      { playerId: 11, lineupSlotId: 2, playerPoolEntry: { player: { id: 11, fullName: 'Starter A' } } },
      { playerId: 12, lineupSlotId: 20, playerPoolEntry: { player: { id: 12 } } },
      { playerId: 13, lineupSlotId: 21, player: { id: 13 } },
    ] } },
    { id: 2, name: 'Burnout', abbrev: 'BO', owners: ['{OTHER-0002}'], roster: { entries: [
      { playerId: 21, lineupSlotId: 4, playerPoolEntry: { player: { id: 21 } } },
    ] } },
  ],
};
const SCHEDULE = {
  schedule: [
    { matchupPeriodId: 5, home: { teamId: 1 }, away: { teamId: 2 } },
    { matchupPeriodId: 5, home: { teamId: 3 } },
    { matchupPeriodId: 6, home: {} },
  ],
};
const row = (seasonId: number, scoringPeriodId: number, statSourceId: number, statSplitTypeId: number, stats: object) =>
  ({ seasonId, scoringPeriodId, statSourceId, statSplitTypeId, stats });
const FEED = [
  { player: { id: 11, fullName: 'Starter A', eligibleSlots: [2, 23, 20], proTeamId: 8, defaultPositionId: 3,
    injuryStatus: 'ACTIVE', ownership: { percentOwned: 97.5 }, stats: [
      row(SEASON, WEEK, 1, 1, { 53: 5, 42: 60 }), row(SEASON, 1, 0, 1, { 53: 4, 42: 50 }),
      row(SEASON, 2, 0, 1, { 53: 6 }), row(SEASON, 0, 0, 0, { 53: 10 }), row(SEASON - 1, 1, 0, 1, { 53: 99 }),
      row(SEASON, 1, 1, 1, { 53: 3 }),
    ] } },
  { id: 21, fullName: 'Last Year Only', stats: [row(SEASON - 1, WEEK, 1, 1, { 53: 7 })] },
  { id: 31, fullName: 'Bare Entry', eligibleSlots: [4], stats: [row(SEASON, WEEK, 1, 1, { 42: 30 }), row(SEASON, 2, 0, 1, {})] },
  { player: { id: 'not-a-number' } },
  null,
];

/** Both cookies, or the league refuses — one alone authenticates nothing. */
function authorised(cookie: string | null): boolean {
  return Boolean(cookie && cookie.includes(`SWID=${SWID}`) && cookie.includes(`espn_s2=${S2}`));
}

/**
 * @description Answer one request the way ESPN's fantasy host does for these fixtures.
 * @param url - Path and query as received.
 * @param cookie - The Cookie header, if any.
 * @param filter - The x-fantasy-filter header, if any.
 * @returns Status and JSON body, or null to leave the request hanging (a timeout).
 */
function answer(url: string, cookie: string | null, filter: string | null): { status: number; body: unknown } | null {
  const [path, query = ''] = url.split('?');
  if (path === `/apis/v3/games/ffl/seasons/${SEASON}`) return { status: 200, body: { currentScoringPeriod: { id: WEEK } } };
  if (path === `/apis/v3/games/ffl/seasons/${SEASON}/players`) {
    return { status: 200, body: filter ? FEED : FEED.slice(0, 1) };
  }
  if (path === `${LEAGUE_PATH}/5030`) return { status: 503, body: { error: 'unavailable' } };
  if (path === `${LEAGUE_PATH}/7777`) return null;
  if (path !== `${LEAGUE_PATH}/${LEAGUE}`) return { status: 404, body: { messages: ['not found'] } };
  if (!authorised(cookie)) return { status: 401, body: { messages: ['You are not authorized'] } };
  if (query.includes('view=mRoster')) return { status: 200, body: TEAMS };
  if (query.includes('view=mMatchup')) return { status: 200, body: SCHEDULE };
  return { status: 200, body: SETTINGS };
}

let server: http.Server;
let port = 0;
/** A loopback port nothing listens on: a refused connection, which no credential can fix. */
let deadPort = 0;
const seen: Seen[] = [];
const fetched: string[] = [];

/**
 * @description The platform fetch, pointed at the loopback host. Refuses any URL that does not start
 * with ESPN's fixed fantasy origin, so a read that composed its URL elsewhere fails loudly.
 * @param target - The loopback port to send to.
 * @returns A fetch implementation.
 */
function loopbackFetch(target: number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    if (!url.startsWith(`${ORIGIN}/apis/v3/games/ffl/`)) throw new Error(`left the fixed ESPN host: ${url}`);
    return fetch(`http://127.0.0.1:${target}${url.slice(ORIGIN.length)}`, init);
  }) as typeof fetch;
}

/** Options with a captured log and failure report. */
function captured(extra: Partial<FantasyReadOptions> = {}) {
  const events: Array<[string, Record<string, unknown>]> = [];
  const errors: Array<[string, string]> = [];
  const opts: FantasyReadOptions = {
    fetchImpl: loopbackFetch(port), attempts: 2, timeoutMs: 5000,
    log: (event, fields) => { events.push([event, fields]); },
    onError: (url, reason) => { errors.push([url, reason]); },
    ...extra,
  };
  return { opts, events, errors };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const cookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : null;
    const filter = typeof req.headers['x-fantasy-filter'] === 'string' ? req.headers['x-fantasy-filter'] : null;
    seen.push({ url: String(req.url), cookie, filter });
    const reply = answer(String(req.url), cookie, filter);
    if (!reply) return;
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  port = (server.address() as AddressInfo).port;
  const closed = http.createServer();
  await new Promise<void>((resolve) => { closed.listen(0, '127.0.0.1', () => resolve()); });
  deadPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => { closed.close(() => resolve()); });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
});

beforeEach(() => {
  seen.length = 0;
  fetched.length = 0;
  Object.values(logSpies).forEach((spy) => spy.mockClear());
});

describe('private league reads carry both cookies to the league, and nowhere else', () => {
  it('reads settings under the league\'s own rules, with both cookies on the one request', async () => {
    const { opts } = captured();
    const settings = await readLeagueSettings(SEASON, LEAGUE, CRED, opts);
    expect(settings).toEqual({
      leagueId: LEAGUE, season: SEASON, name: 'Fixture League', scoringPeriodId: WEEK,
      scoring: [{ statId: 53, points: 1 }, { statId: 42, points: 0.1 }],
      slots: [{ slotId: 0, count: 1 }, { slotId: 2, count: 2 }, { slotId: 4, count: 2 }, { slotId: 23, count: 1 }],
    });
    expect(seen).toEqual([{ url: `${LEAGUE_PATH}/${LEAGUE}?view=mSettings`, cookie: `SWID=${SWID}; espn_s2=${S2}`, filter: null }]);
  });

  it('reads every roster and the schedule, and resolves the caller\'s team and opponent', async () => {
    const { opts } = captured();
    const teams = await readTeams(SEASON, LEAGUE, WEEK, CRED, opts);
    const own = findOwnTeam(teams, CRED.swid);
    expect(own?.name).toBe('Razor Hogs');
    expect(own?.startingPlayerIds).toEqual([11]);
    expect(own?.rosterPlayerIds).toEqual([11, 12, 13]);
    expect(seen[0].url).toBe(`${LEAGUE_PATH}/${LEAGUE}?scoringPeriodId=${WEEK}&view=mRoster&view=mTeam`);
    const { matchups, failure } = await readMatchupsOutcome(SEASON, LEAGUE, CRED, opts);
    expect(failure).toBeNull();
    expect(opponentOutcomeFor(matchups, 1, WEEK)).toEqual({ opponentTeamId: 2, reason: 'opponent' });
    expect(opponentOutcomeFor(matchups, 3, WEEK)).toEqual({ opponentTeamId: null, reason: 'bye' });
    expect(opponentOutcomeFor(matchups, 1, 9)).toEqual({ opponentTeamId: null, reason: 'not-scheduled' });
    expect(seen.every((s) => authorised(s.cookie))).toBe(true);
  });

  it('never sends a cookie to the public player feed or the season read', async () => {
    const { opts } = captured();
    const { players, weeks } = await fetchProjections(SEASON, WEEK, opts);
    expect(await readCurrentScoringPeriod(SEASON, opts)).toBe(WEEK);
    expect(seen.map((s) => s.cookie)).toEqual([null, null]);
    expect(seen[0]).toEqual({
      url: `/apis/v3/games/ffl/seasons/${SEASON}/players?scoringPeriodId=${WEEK}&view=kona_player_info`,
      cookie: null, filter: PLAYER_FEED_FILTER,
    });
    expect(Object.keys(players).map(Number).sort()).toEqual([11, 31]);
    expect(players[11]).toMatchObject({ projectedStats: { 53: 5, 42: 60 }, percentOwned: 97.5, proTeamId: 8, defaultPositionId: 3 });
    expect(weeks).toEqual([
      { playerId: 11, week: 1, stats: { 53: 4, 42: 50 } },
      { playerId: 11, week: 2, stats: { 53: 6 } },
    ]);
  });
});

describe('a refusal, an unavailable ESPN and an unreachable one are three different answers', () => {
  it('a league read without the cookies is refused once, not retried', async () => {
    const { opts, errors } = captured({ attempts: 3 });
    const { settings, failure } = await readLeagueSettingsOutcome(SEASON, LEAGUE, null, opts);
    expect(settings).toBeNull();
    expect(failure).toEqual({ kind: 'refused', reason: 'HTTP 401', status: 401 });
    expect(seen).toHaveLength(1);
    expect(seen[0].cookie).toBeNull();
    expect(errors).toEqual([[`${ORIGIN}${LEAGUE_PATH}/${LEAGUE}?view=mSettings`, 'HTTP 401']]);
  });

  it('a 5xx is retried up to the attempt budget and reported as unavailable', async () => {
    const { opts } = captured({ attempts: 2 });
    const { failure } = await readLeagueSettingsOutcome(SEASON, '5030', CRED, opts);
    expect(failure).toEqual({ kind: 'unavailable', reason: 'HTTP 503', status: 503 });
    expect(seen).toHaveLength(2);
  });

  it('a refused connection is transport, with no status', async () => {
    const { opts } = captured({ attempts: 1, fetchImpl: loopbackFetch(deadPort) });
    const { settings, failure } = await readLeagueSettingsOutcome(SEASON, LEAGUE, CRED, opts);
    expect(settings).toBeNull();
    expect(failure?.kind).toBe('transport');
    expect(failure?.status).toBeNull();
  });

  it('a host that never answers times out as transport', async () => {
    const { opts } = captured({ attempts: 1, timeoutMs: 150 });
    const { matchups, failure } = await readMatchupsOutcome(SEASON, '7777', CRED, opts);
    expect(matchups).toEqual([]);
    expect(failure?.kind).toBe('transport');
    expect(seen).toHaveLength(1);
  });

  it('the current week falls back to 1 when the season read fails', async () => {
    const { opts } = captured({ attempts: 1, fetchImpl: loopbackFetch(deadPort) });
    expect(await readCurrentScoringPeriod(SEASON, opts)).toBe(1);
  });
});

describe('the host is fixed and the session cookie never escapes the request', () => {
  it('a hostile league id stays one encoded path segment on ESPN\'s host', async () => {
    const { opts } = captured({ attempts: 1 });
    const { failure } = await readLeagueSettingsOutcome(SEASON, '../../evil?x=1#', CRED, opts);
    expect(failure?.kind).toBe('refused');
    expect(fetched).toEqual([`${ORIGIN}${LEAGUE_PATH}/..%2F..%2Fevil%3Fx%3D1%23?view=mSettings`]);
    expect(seen[0].url).toBe(`${LEAGUE_PATH}/..%2F..%2Fevil%3Fx%3D1%23?view=mSettings`);
  });

  it('espn_s2 appears in no log event, failure report or returned value', async () => {
    const { opts, events, errors } = captured({ attempts: 1 });
    const results = [
      await readLeagueSettingsOutcome(SEASON, LEAGUE, CRED, opts),
      await readTeams(SEASON, LEAGUE, WEEK, CRED, opts),
      await readMatchupsOutcome(SEASON, LEAGUE, CRED, opts),
      await readLeagueSettingsOutcome(SEASON, '5030', CRED, opts),
    ];
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(errors.length).toBe(1);
    const escaped = JSON.stringify({ events, errors, results });
    expect(escaped).not.toContain(S2);
    expect(escaped).not.toContain('espn_s2');
    expect(seen.filter((s) => authorised(s.cookie))).toHaveLength(4);
  });

  it('with no injected sink, the default logger records outcomes by severity and never the cookie', async () => {
    const opts: FantasyReadOptions = { fetchImpl: loopbackFetch(port), attempts: 1 };
    await readLeagueSettings(SEASON, LEAGUE, CRED, opts);
    await readLeagueSettings(SEASON, LEAGUE, null, opts);
    await readLeagueSettings(SEASON, LEAGUE, CRED, { ...opts, fetchImpl: loopbackFetch(deadPort) });
    expect(logSpies.debug).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1 }), 'espn.request.ok');
    expect(logSpies.warn).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }), 'espn.request.failed');
    expect(logSpies.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }), 'espn.request.error');
    const logged = JSON.stringify([logSpies.debug.mock.calls, logSpies.warn.mock.calls, logSpies.error.mock.calls]);
    expect(logged).not.toContain(S2);
    expect(logged).not.toContain(SWID);
  });
});

describe('credential parsing', () => {
  it('splits SWID:espn_s2 at the first colon and braces a bare SWID', () => {
    expect(parseCredential('SWID-RAW:abc')).toEqual({ swid: '{SWID-RAW}', espnS2: 'abc' });
    expect(parseCredential(`${SWID}:${S2}`)).toEqual({ swid: SWID, espnS2: S2 });
    expect(cookieHeader(CRED)).toEqual({ Cookie: `SWID=${SWID}; espn_s2=${S2}`, Accept: 'application/json' });
  });

  it.each([null, undefined, '', 'nocolon', ':only-s2', 'only-swid:', ' : '])('treats %j as not connected', (secret) => {
    expect(parseCredential(secret as string | null | undefined)).toBeNull();
  });
});

describe('the Test Lab card', () => {
  it('registers the ESPN Fantasy scenario with suites that exist', () => {
    const scenario = CONNECTOR_OAUTH_SCENARIOS.find((s) => s.id === 'espn-fantasy-league-reads');
    expect(scenario?.steps.map((step) => step.id)).toEqual(['private-token']);
    const paths = scenario?.regressionTests?.map((t) => t.path) ?? [];
    expect(paths).toEqual(['tests/unit/fantasy-leagues-espn-client.spec.ts', 'tests/unit/kernel-skills.spec.ts']);
    for (const suite of paths) expect(existsSync(resolvePath(__dirname, '../..', suite)), suite).toBe(true);
  });
});
