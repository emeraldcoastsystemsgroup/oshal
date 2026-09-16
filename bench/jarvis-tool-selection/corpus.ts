/**
 * The corpus the Jarvis tool-selection harness races candidates over, and its provenance.
 *
 * GROUND TRUTH IS NEVER A MODEL'S GUESS. Two kinds of item live here and they are labelled
 * separately, because reading one as the other is how a synthetic number gets quoted as a
 * production one:
 *
 *   - `contract` — the fast-lane items, copied verbatim from the committed behaviour contract in
 *     tests/unit/jarvis-provider-intent-routing.spec.ts. Their expected outcome is what the
 *     deterministic guard is REQUIRED to do, including the negatives that must stay model-owned.
 *   - `synthetic` — the tool-lane items, hand-authored, plus `model-calendar`, which carried the
 *     `contract` label until a review checked every one of the thirteen against that spec and found
 *     no such string in it. It is the only item that makes `fast-lane-calendar` a false match, so
 *     the precision axis rests on an authored judgement rather than on committed ground truth.
 *     Hand-authored items: `expectedTool` is the script the answer
 *     has to reach. Several are deliberately worded so the needed tool's own keywords do NOT
 *     appear, because a selector that only survives keyword-shaped phrasing has proved nothing.
 *
 * A recorded corpus (real traffic, ground truth = the invocation that actually happened) is loaded
 * with JARVIS_BENCH_CORPUS=<file.jsonl>. Until one exists the report says `synthetic`, and the
 * numbers must be read as a harness self-test rather than as production recall.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - labelled corpus for the tool-selection harness, plus a JSONL loader for a recorded corpus that fails loudly instead of silently falling back to the synthetic one.
 *
 * @module bench/jarvis-tool-selection/corpus
 */

import { readFileSync, existsSync } from 'node:fs';

/** Where an item's expected outcome came from. Never mix these inside one headline number. */
export type Provenance = 'contract' | 'synthetic' | 'recorded';

/**
 * One graded message.
 *
 * `expectedIntent` is the deterministic provider-bound intent the fast lane must produce (`null`
 * means the turn belongs to the model). `expectedTool` is the script the answer needs in front of
 * the model (`null` means no catalogued tool is required).
 */
export interface CorpusItem {
  id: string;
  message: string;
  surface?: string;
  expectedIntent: string | null;
  expectedTool: string | null;
  provenance: Provenance;
}

/** Fast-lane ground truth, verbatim from the committed provider-intent contract spec. */
const CONTRACT_ITEMS: ReadonlyArray<Omit<CorpusItem, 'provenance'>> = [
  { id: 'weather-destin', message: 'What is the weather today in Destin, Florida?', expectedIntent: 'weather', expectedTool: null },
  { id: 'weather-rain', message: 'Will it rain tomorrow?', expectedIntent: 'weather', expectedTool: null },
  { id: 'weather-chicago', message: 'Show me the current conditions near Chicago.', expectedIntent: 'weather', expectedTool: null },
  { id: 'inbox-important', message: 'Show me my important emails.', expectedIntent: 'priority-email', expectedTool: null },
  { id: 'inbox-summarize', message: 'Summarize my inbox.', expectedIntent: 'priority-email', expectedTool: null },
  { id: 'walmart-options', message: 'Show me 3 fish food options from Walmart.', expectedIntent: 'walmart-catalog', expectedTool: null },
  { id: 'walmart-search', message: 'Search Walmart for fish food.', expectedIntent: 'walmart-catalog', expectedTool: null },
  { id: 'model-greeting', message: 'Hello Jarvis', expectedIntent: null, expectedTool: null },
  { id: 'model-weather-theory', message: 'What causes weather systems to form?', expectedIntent: null, expectedTool: null },
  { id: 'model-weather-app', message: 'Build a weather app for our cockpit.', expectedIntent: null, expectedTool: null },
  { id: 'model-walmart-order', message: 'Order fish food from Walmart.', expectedIntent: null, expectedTool: null },
  { id: 'model-walmart-compare', message: 'Compare fish food at Walmart and Target.', expectedIntent: null, expectedTool: null },
];

/** Tool-lane ground truth: the script the answer needs. Several avoid that tool's own keywords. */
const SYNTHETIC_ITEMS: ReadonlyArray<Omit<CorpusItem, 'provenance'>> = [
  // NOT from the contract spec. The closest committed string is 'What is on my calendar?' in a
  // different assertion about a different function, so this one is authored - and it is the only
  // item that makes fast-lane-calendar a false match, which is the whole precision axis.
  { id: 'model-calendar', message: 'What is on my calendar tomorrow?', expectedIntent: null, expectedTool: null },
  { id: 'tool-jazz', message: 'Put on some jazz while I work.', expectedIntent: null, expectedTool: 'oshal-spotify.js' },
  { id: 'tool-nowplaying', message: 'What is playing on my Spotify right now?', expectedIntent: null, expectedTool: 'oshal-spotify.js' },
  { id: 'tool-flight', message: 'Book me a seat to Denver next Friday.', expectedIntent: null, expectedTool: 'oshal-duffel.js' },
  { id: 'tool-airfare', message: 'Find the cheapest airfare to Denver.', expectedIntent: null, expectedTool: 'oshal-duffel.js' },
  { id: 'tool-gmail-from', message: 'What is in my Gmail from Alice?', expectedIntent: null, expectedTool: 'oshal-gmail.js' },
  { id: 'tool-gmail-draft', message: 'Draft a Gmail reply to Alice about the invoice.', expectedIntent: null, expectedTool: 'oshal-gmail.js' },
  { id: 'tool-outlook', message: 'Check my Outlook for the contract from legal.', expectedIntent: null, expectedTool: 'oshal-outlook.js' },
  { id: 'tool-lights', message: 'Turn the living room lights down.', expectedIntent: null, expectedTool: 'oshal-smartthings.js' },
  { id: 'tool-thermostat', message: 'Set the thermostat to 70.', expectedIntent: null, expectedTool: 'oshal-smartthings.js' },
  { id: 'tool-spend', message: 'How much did I spend on groceries last month?', expectedIntent: null, expectedTool: 'oshal-plaid.js' },
  { id: 'tool-balance', message: 'What is my checking account balance?', expectedIntent: null, expectedTool: 'oshal-plaid.js' },
  { id: 'tool-positions', message: 'Show my open trading positions.', expectedIntent: null, expectedTool: 'oshal-trading.js' },
  { id: 'tool-movies', message: 'What movies are streaming tonight?', expectedIntent: null, expectedTool: 'oshal-tmdb.js' },
  { id: 'tool-ride', message: 'Get me a ride to the airport.', expectedIntent: null, expectedTool: 'oshal-uber-rides.js' },
  { id: 'tool-dinner', message: 'Order dinner from a nearby restaurant.', expectedIntent: null, expectedTool: 'oshal-uber.js' },
  { id: 'tool-headlines', message: 'What are the top headlines today?', expectedIntent: null, expectedTool: 'oshal-feeds.js' },
  { id: 'tool-research', message: 'Research the history of the Panama Canal with sources.', expectedIntent: null, expectedTool: 'oshal-research.js' },
  { id: 'tool-linkedin', message: 'Publish this update to my LinkedIn profile.', expectedIntent: null, expectedTool: 'oshal-linkedin.js' },
  { id: 'tool-x-post', message: 'Post that thought to X for me.', expectedIntent: null, expectedTool: 'oshal-x.js' },
  { id: 'tool-x-read', message: 'Who mentioned me on Twitter this morning?', expectedIntent: null, expectedTool: 'oshal-x-read.js' },
  { id: 'tool-gcp', message: 'List the projects in my GCP cloud inventory.', expectedIntent: null, expectedTool: 'oshal-gcp.js' },
];

/**
 * @description The built-in corpus: fast-lane contract items plus hand-authored tool-lane items.
 * @returns Every item, each carrying the provenance the report is required to print.
 */
export function builtInCorpus(): CorpusItem[] {
  return [
    ...CONTRACT_ITEMS.map((item) => ({ ...item, provenance: 'contract' as const })),
    ...SYNTHETIC_ITEMS.map((item) => ({ ...item, provenance: 'synthetic' as const })),
  ];
}

/** Reads one JSONL field, rejecting anything that is neither an explicit null nor a real string. */
function field(row: Record<string, unknown>, key: string, line: number): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`recorded corpus line ${line}: ${key} must be a non-empty string or null`);
}

/** Parses one JSONL row into a graded item; every failure names the line. */
function parseItem(text: string, index: number): CorpusItem {
  const line = index + 1;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`recorded corpus line ${line} is not JSON`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`recorded corpus line ${line} is not an object`);
  const row = value as Record<string, unknown>;
  const message = field(row, 'message', line);
  if (!message) throw new Error(`recorded corpus line ${line}: message is required`);
  return {
    id: field(row, 'id', line) ?? `recorded-${line}`,
    message,
    surface: field(row, 'surface', line) ?? undefined,
    expectedIntent: field(row, 'expectedIntent', line),
    expectedTool: field(row, 'expectedTool', line),
    provenance: 'recorded',
  };
}

/**
 * @description Load a recorded corpus from JSONL, or the built-in one when no path is given.
 * A path that is absent, empty or unparseable THROWS, so the caller reports `not-run` with the
 * reason instead of quietly measuring the synthetic corpus and labelling the result recorded.
 * @param path - Optional JSONL file; defaults to the JARVIS_BENCH_CORPUS environment variable.
 * @returns The corpus items to grade.
 */
export function loadCorpus(path = process.env.JARVIS_BENCH_CORPUS): CorpusItem[] {
  if (!path) return builtInCorpus();
  if (!existsSync(path)) throw new Error(`recorded corpus not found: ${path}`);
  const items = readFileSync(path, 'utf8').split('\n').map((row) => row.trim()).filter(Boolean).map(parseItem);
  if (!items.length) throw new Error(`recorded corpus is empty: ${path}`);
  return items;
}
