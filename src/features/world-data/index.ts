/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Created the world-data feature barrel (FSD deep-import burn-down): surfaces the world-intelligence service, feed/firehose ingestion, the collectors (market events, political/insider trades, short interest, gov contracts), and the subject/feed catalogs consumers were reaching via deep paths.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export classifyBudgetSnapshot — the pulse dispatch logs the global classify-budget counters each cycle so LLM burn is visible in the run record.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export the series-read gate (bound + counters) — the pulse dispatch takes a snapshot either side of its fan-out so the completion record says how many statements it actually put on the series store.
 */

/**
 * @description Public surface for the world-data feature slice — world-intelligence
 * ingestion, firehose/feed configuration, market collectors, and subject catalogs.
 */

export {
  createWorldIntelligenceService,
  type LatestMetricPoint,
  type WorldIntelligenceService,
} from './world-intelligence-service';
export {
  runSeriesRead,
  seriesReadKey,
  seriesReadConcurrency,
  seriesReadStats,
  resetSeriesReadStats,
  type SeriesReadStats,
} from './world-series-gate';
export { ingestFeeds, speedReadFirehose, deepDiveFirehose, classifyBudgetSnapshot } from './news-fetcher';
export { collectMarketEvents } from './market-events';
export { collectPoliticalTrades } from './political-trades';
export { collectInsiderTrades } from './insider-trades';
export { collectShortInterest } from './short-interest';
export { collectGovContracts } from './gov-contracts';
export { DEFAULT_FEED_IDS, FINANCE_FEED_IDS, PULSE_FEED_IDS } from './feed-sources';
export {
  firehoseEnabled,
  firehoseFeeds,
  firehoseLimit,
  firehoseEveryNPulses,
  deepDiveEnabled,
  deepDiveBudget,
  deepDiveMetered,
  feedBudgetMs,
} from './firehose-feeds';
export { DEFAULT_WORLD_TOPICS, tickerSubject, type WorldSubject } from './world-default-subjects';
export { MARKET_SUBJECTS } from './market-subjects';
