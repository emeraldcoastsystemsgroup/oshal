/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Created the world-data feature barrel (FSD deep-import burn-down): surfaces the world-intelligence service, feed/firehose ingestion, the collectors (market events, political/insider trades, short interest, gov contracts), and the subject/feed catalogs consumers were reaching via deep paths.
 */

/**
 * @description Public surface for the world-data feature slice — world-intelligence
 * ingestion, firehose/feed configuration, market collectors, and subject catalogs.
 */

export {
  createWorldIntelligenceService,
  type WorldIntelligenceService,
} from './world-intelligence-service';
export { ingestFeeds, speedReadFirehose, deepDiveFirehose } from './news-fetcher';
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
