/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Pull->Ingest->Reverberate orchestration service (ADR-066)
 */

/**
 * @module features/personal-graph/graph-ingest-service
 * @description Orchestrates the personal-graph ingestion pipeline (ADR-066): pull normalized items
 * from an ADR-065 connector, run the matching pure mapper over each one, fold the resulting fragments
 * into a `GraphStore` (idempotent upserts), then let the caller run the cross-source reverberation
 * pass that links the same entity across sources.
 *
 * Design intent — decoupled and pure-ish:
 *  - No DB, broker, HTTP, or filesystem imports. The connector call is INJECTED as `fetchItems`
 *    (an `async () => any[]`), so the whole pipeline unit-tests with `InMemoryGraphStore` + plain
 *    arrays, with NO live credentials. In production the caller passes a closure that uses
 *    `buildClientFromSpec(spec, creds).call(resource, inputs)` and extracts the list (provider lists
 *    may already be arrays via the spec's pagination `extract`).
 *  - The per-provider mapper is looked up in `PROVIDER_MAPPERS`. Each registry entry is normalized to
 *    a single `(rawItem) => GraphFragment` signature even though some underlying mappers accept extra
 *    optional args (gmail/gcal `observedAt`, strava `observedAt` + `owner`).
 */

import { applyFragment } from './graph-store';
import { reverberate } from './reverberate';
import type { GraphStore } from './graph-store';
import type { GraphFragment } from './graph-types';
import type { ReverberateResult } from './reverberate';

import { ingestGoogleCalendarEvent } from './ingest/google-calendar-ingest';
import { ingestGmailMessage } from './ingest/gmail-ingest';
import { ingestGitHubRepo } from './ingest/github-ingest';
import { ingestStravaActivity } from './ingest/strava-ingest';

/** A normalized mapper: one raw provider item -> a graph fragment, with no I/O. */
export type ProviderMapper = (rawItem: any) => GraphFragment;

/** The connector providers this service knows how to project into the graph. */
export type SupportedProvider = 'google-calendar' | 'gmail' | 'github' | 'strava';

/**
 * Registry of pure mappers keyed by ADR-065 connector provider id. Each entry presents the uniform
 * `(rawItem) => GraphFragment` shape; the underlying mappers' optional args are bound here when needed.
 */
export const PROVIDER_MAPPERS: Record<SupportedProvider, ProviderMapper> = {
  'google-calendar': (rawItem) => ingestGoogleCalendarEvent(rawItem),
  gmail: (rawItem) => ingestGmailMessage(rawItem),
  github: (rawItem) => ingestGitHubRepo(rawItem),
  strava: (rawItem) => ingestStravaActivity(rawItem),
};

/** Counts produced by an ingest run. */
export interface IngestCounts {
  /** Raw source items processed. */
  items: number;
  /** Total nodes emitted across all fragments (pre-merge; the store dedups). */
  nodes: number;
  /** Total edges emitted across all fragments (pre-merge; the store dedups). */
  edges: number;
}

/** One provider's pull spec for the convenience runner: provider + an injected item fetcher. */
export interface IngestJob {
  provider: SupportedProvider;
  /** Injected pull: `async () => any[]`. In prod, wraps `buildClientFromSpec(...).call(...)`. */
  fetchItems: () => Promise<any[]>;
}

/** Result of the end-to-end convenience run: per-job counts + the single reverberation summary. */
export interface IngestAndReverberateResult {
  jobs: Array<{ provider: SupportedProvider } & IngestCounts>;
  totals: IngestCounts;
  reverberate: ReverberateResult;
}

/** Resolve a provider's mapper or throw a clear error. */
function mapperFor(provider: string): ProviderMapper {
  const mapper = (PROVIDER_MAPPERS as Record<string, ProviderMapper | undefined>)[provider];
  if (!mapper) {
    throw new Error(
      `no ingest mapper for provider '${provider}' (known: ${Object.keys(PROVIDER_MAPPERS).join(', ')})`,
    );
  }
  return mapper;
}

/**
 * Run a provider's mapper over each raw item and fold the fragments into the store.
 * Idempotent: re-running with the same items merges (the store upserts by id), never duplicates.
 */
export async function ingestItems(
  store: GraphStore,
  provider: SupportedProvider,
  items: any[],
): Promise<IngestCounts> {
  const mapper = mapperFor(provider);
  let nodes = 0;
  let edges = 0;
  for (const item of items ?? []) {
    const fragment = mapper(item);
    applyFragment(store, fragment);
    nodes += fragment.nodes.length;
    edges += fragment.edges.length;
  }
  return { items: (items ?? []).length, nodes, edges };
}

/**
 * Pull items via the injected `fetchItems`, then ingest them. Keeping the fetch injected is what makes
 * this testable without live creds; in production the closure performs the connector `.call(...)`.
 */
export async function ingestFromConnector(
  store: GraphStore,
  provider: SupportedProvider,
  fetchItems: () => Promise<any[]>,
): Promise<IngestCounts> {
  const items = await fetchItems();
  return ingestItems(store, provider, items);
}

/**
 * Convenience end-to-end pass: ingest several providers (each via its injected fetcher) into one store,
 * then run the cross-source reverberation ONCE so a person seen in two sources merges into one node.
 */
export async function runIngestAndReverberate(
  store: GraphStore,
  jobs: IngestJob[],
): Promise<IngestAndReverberateResult> {
  const jobResults: Array<{ provider: SupportedProvider } & IngestCounts> = [];
  const totals: IngestCounts = { items: 0, nodes: 0, edges: 0 };

  for (const job of jobs) {
    const counts = await ingestFromConnector(store, job.provider, job.fetchItems);
    jobResults.push({ provider: job.provider, ...counts });
    totals.items += counts.items;
    totals.nodes += counts.nodes;
    totals.edges += counts.edges;
  }

  const reverb = reverberate(store);
  return { jobs: jobResults, totals, reverberate: reverb };
}
