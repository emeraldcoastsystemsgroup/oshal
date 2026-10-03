/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The World sources inventory (operator ask 2026-10-02: a screen that shows where World pulls from, with on/off). Built from the same registries the fetch code reads — FEED_SOURCES and the scheduled feed sets, the firehose list, and each depth collector's endpoint — so it cannot drift from them. Each source carries the schedules that use it, the .env flags that also govern it, and on the screen its switch, its last-24-hour pulls and (collectors) its last run. A URL that came from an operator override is shown as origin + path only, since an override may carry a credential in its query.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes: a firehose feed reads not pulling, with blockedBy naming the pass, while the whole firehose pass is switched off (its own switch can still be on); an override URL that does not parse is logged at ERROR (without the URL, which may carry a credential).
 */

import { FEED_SOURCES, DEFAULT_FEED_IDS, FINANCE_FEED_IDS, PULSE_FEED_IDS } from './feed-sources';
import { firehoseEnabled, firehoseEveryNPulses, firehoseFeeds } from './firehose-feeds';
import { NASDAQ_EARNINGS_URL } from './market-events';
import { congressFeedTarget } from './political-trades';
import { INSIDER_URLS } from './insider-trades';
import { FINRA_SHORT_VOLUME_URL } from './short-interest';
import { USA_URL } from './gov-contracts';
import { createChildLogger } from '@/shared/logger';
import {
  worldSourceSwitchTtlMs,
  type WorldCollectorRun,
  type WorldFeedPullStats,
  type WorldSourceControl,
  type WorldSourceSwitch,
} from './world-source-control';

const logger = createChildLogger({ module: 'world-source-inventory' });

/** The id of the switch that turns the whole publisher firehose pass off. */
export const FIREHOSE_SWITCH_ID = 'firehose';

/** The depth collectors' source ids, in the order the depth refresh runs them. */
export const WORLD_COLLECTOR_IDS = ['market-events', 'congress-trades', 'insider-trades', 'short-interest', 'gov-contracts'] as const;

/** A depth collector's source id. */
export type WorldCollectorId = typeof WORLD_COLLECTOR_IDS[number];

/** One .env flag that also governs a source: its name and whether it currently allows the source. */
export interface WorldSourceGate { name: string; on: boolean }

/** One place World pulls from. */
export interface WorldSourceEntry {
  id: string;
  kind: 'feed' | 'firehose' | 'collector';
  name: string;
  category: string | null;
  /** Where it pulls from: a template (`{query}`, `{SYMBOL}`, `{date}`), or origin + path for an override. */
  urls: string[];
  /** The schedules that pull it, or "on demand" when only an explicit request does. */
  usedBy: string[];
  /** .env flags that must all be on for it to run (the switch can only turn it off beyond them). */
  gates: WorldSourceGate[];
  note: string | null;
}

/** One source as the screen shows it. */
export interface WorldSourceRow extends WorldSourceEntry {
  switchedOn: boolean;
  configuredOn: boolean;
  pulling: boolean;
  /** Why a source whose own switch and flags are on still does not pull (a firehose feed while the pass is off). */
  blockedBy: string | null;
  switch: WorldSourceSwitch | null;
  last24h: Omit<WorldFeedPullStats, 'feedId'> | null;
  lastRun: WorldCollectorRun | null;
}

const QUERY_TOKEN = 'xquerytokenx';
const SYMBOL_TOKEN = 'XSYMBOLTOKENX';

/** @description Origin + path of a URL, dropping a query that may carry a credential. */
function originAndPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch (err) {
    logger.error({ err }, 'An override URL does not parse; the sources screen shows it as not a valid URL');
    return '(not a valid URL)';
  }
}

/** @description The schedules that pull one per-subject feed, from the feed sets the dispatcher uses. */
function feedUsedBy(id: string): string[] {
  const used: string[] = [];
  if (DEFAULT_FEED_IDS.includes(id)) used.push('world-refresh (topics)', 'ticker-pulse (market subjects)');
  if (PULSE_FEED_IDS.includes(id)) used.push('ticker-pulse (every ticker)');
  else if (FINANCE_FEED_IDS.includes(id)) used.push('ticker-pulse (deep slice)');
  return used.length ? [...new Set(used)] : ['on demand'];
}

/** @description The per-subject feeds (Google News, Bing News, Yahoo Finance, Reddit, ...). */
function feedEntries(): WorldSourceEntry[] {
  return FEED_SOURCES.map((src) => ({
    id: src.id, kind: 'feed', name: src.name, category: src.category,
    urls: [src.symbolUrl
      ? src.symbolUrl(SYMBOL_TOKEN).replace(SYMBOL_TOKEN, '{SYMBOL}')
      : src.url(QUERY_TOKEN).replace(QUERY_TOKEN, '{query}')],
    usedBy: feedUsedBy(src.id), gates: [], note: null,
  }));
}

/** @description The publisher firehose: the whole-pass switch, then each feed. */
function firehoseEntries(env: NodeJS.ProcessEnv): WorldSourceEntry[] {
  const overridden = Boolean((env.WORLD_FIREHOSE_FEEDS ?? '').trim());
  const every = firehoseEveryNPulses(env);
  const gates = [{ name: 'WORLD_FIREHOSE_ENABLED', on: firehoseEnabled(env) }];
  const usedBy = [every === 1 ? 'ticker-pulse (every pulse)' : `ticker-pulse (every ${every}th pulse)`];
  return [
    { id: FIREHOSE_SWITCH_ID, kind: 'firehose', name: 'Publisher firehose (whole pass)', category: 'finance', urls: [], usedBy, gates,
      note: overridden ? 'Feed list replaced by WORLD_FIREHOSE_FEEDS.' : 'Curated default feed list.' },
    ...firehoseFeeds(env).map((f) => ({
      id: f.id, kind: 'firehose' as const, name: f.name, category: 'finance',
      urls: [overridden ? originAndPath(f.url) : f.url], usedBy, gates, note: null,
    })),
  ];
}

/** @description The depth collectors, each with the endpoint it reads and the flags that govern it. */
function collectorEntries(env: NodeJS.ProcessEnv): WorldSourceEntry[] {
  const flow = { name: 'WORLD_FLOW_ENABLED', on: env.WORLD_FLOW_ENABLED !== 'false' };
  const congress = congressFeedTarget(env);
  const insiderOverridden = Boolean((env.WORLD_INSIDER_URLS ?? '').trim());
  const usedBy = ['world-refresh'];
  const congressNote = {
    free: 'Free community mirror of the STOCK Act filings (no WORLD_POLITICAL_TOKEN set). It names the member in filer_name, which is not read yet, so rows are stored with representative "Unknown".',
    quiver: 'Quiver live feed (WORLD_POLITICAL_TOKEN set, sent as a Bearer credential).',
    custom: 'WORLD_POLITICAL_URL override.',
  }[congress.mode];
  return [
    { id: 'market-events', kind: 'collector', name: 'Nasdaq earnings calendar', category: 'events', usedBy,
      urls: [`${NASDAQ_EARNINGS_URL}?date={date}`], gates: [{ name: 'WORLD_EVENTS_ENABLED', on: env.WORLD_EVENTS_ENABLED !== 'false' }],
      note: 'FOMC and jobs-report dates come from configuration and fetch nothing.' },
    { id: 'congress-trades', kind: 'collector', name: 'Congressional trades (STOCK Act)', category: 'flow', usedBy,
      urls: [congress.mode === 'custom' ? originAndPath(congress.url) : congress.url], gates: [flow], note: congressNote },
    { id: 'insider-trades', kind: 'collector', name: 'Insider trades (Form 4, openinsider)', category: 'flow', usedBy,
      urls: INSIDER_URLS.map((u) => (insiderOverridden ? originAndPath(u) : u)), gates: [flow], note: null },
    { id: 'short-interest', kind: 'collector', name: 'FINRA daily short volume', category: 'flow', usedBy,
      urls: [FINRA_SHORT_VOLUME_URL], gates: [flow], note: null },
    { id: 'gov-contracts', kind: 'collector', name: 'Federal contract awards (USAspending)', category: 'flow', usedBy,
      urls: [USA_URL], gates: [flow, { name: 'WORLD_GOV_ENABLED', on: env.WORLD_GOV_ENABLED !== 'false' }],
      note: 'One POST per universe ticker.' },
  ];
}

/**
 * @description Every place World pulls from, built from the registries the fetch code reads.
 * @param env - Environment (feed overrides and the .env flags that govern each source).
 * @returns The inventory: per-subject feeds, then the firehose, then the depth collectors.
 */
export function worldSourceInventory(env: NodeJS.ProcessEnv = process.env): WorldSourceEntry[] {
  return [...feedEntries(), ...firehoseEntries(env), ...collectorEntries(env)];
}

/**
 * @description Whether an id names a source the operator may switch.
 * @param id - The candidate id.
 * @param env - Environment (the firehose list may be overridden).
 * @returns True when the id is in the inventory.
 */
export function isWorldSourceId(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return worldSourceInventory(env).some((s) => s.id === id);
}

/**
 * @description The inventory with each source's switch, its last-24-hour pulls (feeds and firehose)
 * and its last run (collectors) — what the World sources screen renders.
 * @param control - The series-store source control.
 * @param env - Environment.
 * @returns The rows, the switch cache TTL and the firehose cadence.
 */
export async function describeWorldSources(
  control: WorldSourceControl,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ sources: WorldSourceRow[]; switchTtlMs: number; firehoseEveryNPulses: number }> {
  const [switches, stats, runs] = await Promise.all([control.listSwitches(), control.feedPullStats(24), control.collectorRuns()]);
  const switchById = new Map(switches.map((s) => [s.sourceId, s]));
  const statsById = new Map(stats.map((s) => [s.feedId, s]));
  const runById = new Map(runs.map((r) => [r.collector, r]));
  const passOff = switchById.get(FIREHOSE_SWITCH_ID)?.enabled === false;
  const sources = worldSourceInventory(env).map((entry): WorldSourceRow => {
    const sw = switchById.get(entry.id) ?? null;
    const switchedOn = sw ? sw.enabled : true;
    const configuredOn = entry.gates.every((g) => g.on);
    const blockedBy = entry.kind === 'firehose' && entry.id !== FIREHOSE_SWITCH_ID && passOff ? 'the firehose pass is switched off' : null;
    const stat = statsById.get(entry.id);
    return {
      ...entry, switchedOn, configuredOn, pulling: switchedOn && configuredOn && !blockedBy, blockedBy, switch: sw,
      last24h: stat ? { pulls: stat.pulls, fetched: stat.fetched, newItems: stat.newItems, lastPull: stat.lastPull } : null,
      lastRun: runById.get(entry.id) ?? null,
    };
  });
  return { sources, switchTtlMs: worldSourceSwitchTtlMs(env), firehoseEveryNPulses: firehoseEveryNPulses(env) };
}

