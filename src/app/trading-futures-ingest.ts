/**
 * Futures ingest orchestrator (ADR-116) — the pipeline that replaces the friend's Kibot-download →
 * NinjaTrader-import → gap-check → patch-loop stack, collapsed into one pass with the store.
 *
 * For a root + date range it enumerates the dated contracts (instrument model), fetches each from a
 * FuturesDataSource, grades completeness on arrival (rollover-aware, weekend-discounted), persists to
 * the bar store when one is supplied, and — like his re-download loop — re-fetches contracts that came
 * up short, up to a pass cap, stopping the moment a re-fetch adds no new bars (convergence = "all the
 * vendor has"). Source-agnostic: mock today, Kibot once credentialed, another vendor later.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ingestFutures(): enumerate contracts, fetch→assess→store per contract with a bounded convergence-terminated re-fetch loop, aggregate report (per-contract completeness + incomplete list). Optional Postgres store; runs sequentially to stay gentle on the source.
 *
 * @module trading-futures-ingest
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  assessContractCompleteness, contractsForRange, getFuturesRoot, ingestConverged,
  type ContractCompleteness, type FuturesContract, type FuturesDataSource, type FuturesRoot, type Timeframe,
} from '@/features/trading';
import { upsertBars } from './trading-bar-store';

const logger = createChildLogger({ module: 'trading-futures-ingest' });

/** Inputs for a futures ingest run. */
export interface IngestOptions {
  /** Root ticker, e.g. 'ES'. */
  root: string;
  /** Range start (inclusive), UTC. */
  start: Date;
  /** Range end (inclusive), UTC. */
  end: Date;
  /** Bar timeframe. */
  timeframe: Timeframe;
  /** The data source to fetch from. */
  source: FuturesDataSource;
  /** Optional Postgres pool — when present, bars are persisted to market_bars. */
  pool?: Pool;
  /** Roll convention (days before expiry; default 8). */
  rollDaysBeforeExpiry?: number;
  /** Completeness threshold (default from the validator). */
  threshold?: number;
  /** Max fetch passes per contract before giving up (the patch loop; default 1). */
  maxPasses?: number;
}

/** Per-contract outcome. */
export interface ContractIngestResult {
  symbol: string;
  received: number;
  stored: number;
  passes: number;
  completeness: ContractCompleteness;
}

/** The whole-run report. */
export interface IngestReport {
  root: string;
  timeframe: Timeframe;
  source: string;
  contracts: ContractIngestResult[];
  totalBars: number;
  /** Symbols still below threshold after all passes — genuinely-absent data, not a broken fetch. */
  incomplete: string[];
}

/**
 * @description Run the futures ingest for a root over a date range.
 * @param opts - The ingest inputs (root, range, timeframe, source, optional store + loop knobs).
 * @returns The aggregated ingest report.
 * @throws If the root is unknown or the source is not configured.
 */
export async function ingestFutures(opts: IngestOptions): Promise<IngestReport> {
  const root = getFuturesRoot(opts.root);
  if (!root) throw new Error(`unknown futures root: ${opts.root}`);
  if (!opts.source.configured()) throw new Error(`data source '${opts.source.name}' is not configured`);
  const contracts = contractsForRange(root.root, opts.start, opts.end, opts.rollDaysBeforeExpiry);
  logger.info({ root: root.root, contracts: contracts.length, source: opts.source.name }, 'futures ingest start');

  const results: ContractIngestResult[] = [];
  for (const contract of contracts) {
    results.push(await ingestContract(contract, root, opts));
  }
  const totalBars = results.reduce((s, r) => s + r.received, 0);
  const incomplete = results.filter((r) => !r.completeness.complete).map((r) => r.symbol);
  logger.info({ root: root.root, totalBars, incomplete: incomplete.length }, 'futures ingest done');
  return { root: root.root, timeframe: opts.timeframe, source: opts.source.name, contracts: results, totalBars, incomplete };
}

/** Fetch + grade + store one contract, with the bounded convergence-terminated re-fetch loop. */
async function ingestContract(contract: FuturesContract, root: FuturesRoot, opts: IngestOptions): Promise<ContractIngestResult> {
  const maxPasses = Math.max(1, opts.maxPasses ?? 1);
  const window = { start: opts.start, end: opts.end };
  // Grade completeness against the SAME window we fetched, so a contract only partially inside the
  // requested range (the front/back months at the edges) is measured on the slice we asked for — not
  // against its full active window, which would read as a false gap.
  const assessOpts = { windowStart: opts.start, windowEnd: opts.end, threshold: opts.threshold };
  let verdict: ContractCompleteness | null = null;
  let received = 0;
  let stored = 0;
  let passes = 0;
  for (let pass = 1; pass <= maxPasses; pass++) {
    passes = pass;
    const bars = await opts.source.fetchBars(contract, opts.timeframe, window);
    verdict = assessContractCompleteness(contract, opts.timeframe, root, bars, assessOpts);
    if (opts.pool && bars.length) stored += await upsertBars(opts.pool, contract.symbol, opts.timeframe, opts.source.name, bars);
    if (verdict.complete || ingestConverged(received, verdict.received)) { received = verdict.received; break; }
    received = verdict.received;
  }
  return { symbol: contract.symbol, received, stored, passes, completeness: verdict! };
}
