/**
 * trading feature — provider-agnostic, dual-mode trade execution (ADR-052).
 *
 * Public surface: the `BrokerAdapter` contract + its normalized types, the concrete
 * Alpaca rail, and `getBrokerAdapter(mode)` (BROKER_PROVIDER-selected, live-gated).
 * Import ONLY from this barrel (`@/features/trading`) — no deep imports (FSD).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel — BrokerAdapter contract, AlpacaBrokerAdapter, getBrokerAdapter factory + liveTradingEnabled gate.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the Schwab LIVE rail: SchwabBrokerAdapter, registerSchwabTokenResolver (per-user token injection), and the SchwabTokenResolver/BrokerTokenResolver types.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Export the per-mode market-data source: MarketDataSource, getMarketData(mode, userSub), SchwabMarketData, brokerProviderFor + resolveSchwabToken — the live twin of the Alpaca paper data stream.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Futures extension layer (ADR-116): export the instrument model (futures-contract), the completeness validator (futures-completeness), the data-source connector (mock + Kibot), and the paper futures broker. Additive; the equities surface is unchanged.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Export the ADR-116 optimization objectives (futures-fitness): the nine NT8 OptimizationFitness ports, the FITNESS_FUNCTIONS registry, fitnessNames(), the -1e10 min-trades sentinel and the C# banker's-rounding helper.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Export the Globex session + holiday calendar (futures-session-calendar): session-bucket predicate/counters, trading-day count, and the rule-computed US futures holiday schedule that expectedBarCount, the gap detector, and the mock source now share.
 *
 * @module trading
 */

export type {
  BrokerAdapter, BrokerProviderType, TradingMode, OrderSide, OrderType,
  OrderRequest, OrderResult, OrderStatus, Position, BrokerAccount, BrokerTransaction,
} from './services/broker-adapter';
export { AlpacaBrokerAdapter } from './services/alpaca-broker-adapter';
export { SchwabBrokerAdapter } from './services/schwab-broker-adapter';
export type { SchwabTokenResolver } from './services/schwab-broker-adapter';
export { getBrokerAdapter, getBrokerReader, liveTradingEnabled, registerSchwabTokenResolver } from './services/broker-provider';
export type { BrokerTokenResolver } from './services/broker-provider';

// Deterministic algorithm engine + market data (the algo-driven trade path).
export type { Direction, AlgoSignal, EnsembleDecision, AlgoContext, Mass, StrategyParams } from './services/algorithms';
export { scoreSymbol, ensemble, deriveMasses, displacement, algoNames, gravity2Signal, DEFAULT_STRATEGY_PARAMS } from './services/algorithms';
// Gravity 2 — world-intelligence masses (ADR-054 faithful): configurable mass + CALCULATED proximity.
export type { WorldSnapshot, Gravity2Config, SourceConfig } from './services/gravity-world';
export { deriveWorldMasses, defaultGravity2Config, GRAVITY2_METRICS } from './services/gravity-world';
export type { Timeframe, NewsItem, Session, TradeTick, DatedClose, OhlcvBar, DatedOhlcvBar, SessionBlockReason, TradableSessionResult } from './services/market-data';
export { dailyCloses, latestPrice, latestTrade, isTickStale, maxTickAgeSec, marketDataConfigured, closesForTimeframe, barsBatch, barsBatchSince, barsBatchOhlcv, barsBatchSinceOhlcv, isMarketOpen, recentNews, tradingSession, tradableSession, tradableSessionDetailed } from './services/market-data';
// Rotation entry guards — never re-buy a name the stop is selling this fire; never buy a gap-down.
export type { EntryBlock, EntryBlockReason, EntryGuardInput } from './services/entry-guards';
export { maxGapDownPct, gapPct, priorSessionClose, etSessionDate, entryBlock, selectEntryTargets, DEFAULT_MAX_GAP_DOWN_PCT } from './services/entry-guards';
// Short signals — purpose-built bearish entries + the market-regime gate (classic untuned params).
export { marketBearGate, donchianBreakdown, donchianCover, trendBroken, relativeReturn, shortEntrySignal, sma } from './services/short-signals';
// Per-mode market-data source (Alpaca paper feed | Schwab live feed) — the trade engine's price inputs.
export type { MarketDataSource } from './services/market-data-source';
export { getMarketData } from './services/market-data-source';
export { SchwabMarketData } from './services/schwab-market-data';
export { brokerProviderFor, resolveSchwabToken } from './services/broker-provider';

// Fundamentals (SEC EDGAR, keyless) for the research brain's analyst.
export type { Fundamentals } from './services/fundamentals';
export { fundamentalsSummary } from './services/fundamentals';

// Multi-timeframe trend engine (the every-5-minutes autopilot's decision core).
export type { TimeframeView, MtfDecision } from './services/multi-timeframe';
export { multiTimeframeScan, multiTimeframeDecision, isShortTermBreakdown, isShortTermPop, DEFAULT_UNIVERSE, decideSymbol } from './services/multi-timeframe';
// Shadow indicators (ADR-096): recorded nightly, never voting until promoted into ALGORITHMS.
export { scoreSymbolShadow, shadowAlgoNames } from './services/algorithms';
// Analyst-action headline classifier (the 07-12 pre-registered event-overlay hypothesis).
export type { AnalystAction, AnalystActionClass } from './services/analyst-actions';
export { classifyAnalystHeadline, isNoiseHeadline, ANALYST_UP_CLASSES, ANALYST_DOWN_CLASSES } from './services/analyst-actions';
// News-materiality reader contract (the event-pop noise filter — sweep-#5 surviving path).
export type { MaterialClass, ReaderVerdict } from './services/news-materiality';
export { prefilterHeadline, buildReaderPrompt, parseReaderVerdicts } from './services/news-materiality';

// Portfolio money-manager (sizing, exposure caps, stop-loss/take-profit/trailing, daily-loss breaker).
export type { RiskPosture, RiskPolicy, PolicyOverride, ExitOrder, SizingResult, NameStrength } from './services/portfolio';
export { RISK_POLICIES, riskPolicy, sectorOf, exitsToRun, trailingExits, nextPeaks, sizeEntry, rotationBenches, rebalanceTrims, drawdownHaltTriggered, dipExits, symbolBlocklist } from './services/portfolio';

// ── Futures extension layer (ADR-116) — additive; equities surface above is untouched. ──
// Instrument model: roots, month codes, expiry/roll, contract enumeration, expected-bar count.
export type { FuturesBar, FuturesRoot, FuturesContract } from './services/futures-contract';
export {
  FUTURES_ROOTS, DEFAULT_ROLL_DAYS_BEFORE_EXPIRY, getFuturesRoot, listFuturesRoots, monthCode,
  monthNumFromCode, contractSymbol, parseFuturesSymbol, thirdFriday, expiryDate, rollDate,
  contractsForRange, activeContractAt, barMinutes, weekdaysBetween, expectedBarCount,
} from './services/futures-contract';
// Session + holiday calendar — the real Globex week (17:00 halt, holidays, early closes).
export type { SessionDayKind, ExchangeHoliday } from './services/futures-session-calendar';
export {
  SESSION_CLOSE_MINUTE, SESSION_OPEN_MINUTE, EARLY_CLOSE_MINUTE, easterSunday, usFuturesHolidays,
  sessionDayKind, isSessionBucket, countSessionBuckets, tradingDaysBetween,
} from './services/futures-session-calendar';
// Completeness validator — rollover-aware, session-discounted gap check (the gap-checker reborn).
export type { BarGap, ContractCompleteness } from './services/futures-completeness';
export {
  DEFAULT_COMPLETENESS_THRESHOLD, assessContractCompleteness, patchList, ingestConverged,
  isWeekendUtc, activeWindowDays,
} from './services/futures-completeness';
// Data-source connector — mock (synthetic) + Kibot (real HTTP, credential-gated).
export type { FetchWindow, FuturesDataSource, MockSourceOptions } from './services/futures-data-source';
export { MockFuturesDataSource, KibotFuturesDataSource, parseKibotCsv } from './services/futures-data-source';
// Paper futures broker — in-memory simulator implementing BrokerAdapter (multiplier-scaled P&L, shorting).
export type { FuturesPriceResolver, PaperFuturesOptions } from './services/paper-futures-broker-adapter';
export { PaperFuturesBrokerAdapter, createPaperFuturesBroker } from './services/paper-futures-broker-adapter';
// ADR-116 stop stack — NT8Custom-parity indicator math + trail stops + the per-trade stop engine.
export type { DmiSeries, LaguerreRsiSeries } from './services/futures-indicators';
export { wilderAtr, dmiAdx, laguerreRsi, movingMedian } from './services/futures-indicators';
export type { ChandelierBandsSeries, ChandelierBandsOptions, SuperTrendM11Series, SuperTrendM11Options, ParabolicSarSeries, ParabolicSarOptions } from './services/futures-trail-stops';
export { chandelierBands, superTrendM11, parabolicSar } from './services/futures-trail-stops';
export type { FuturesDirection, StrangleGateMode, StrangleExitMode, TrailMode, StopEngineConfig, InitialStopCandidate, StopEngineBarInput, StopEngineDecision, InitialStopParams, FuturesStopEngine } from './services/futures-stop-engine';
export { createFuturesStopEngine, resolveInitialStop, validateStopPrice, STOP_ENGINE_DEFAULTS } from './services/futures-stop-engine';
// ADR-116 entry side — NT8Custom-parity entry indicators, wave tracking, and the entry evaluator.
export type { LaguerreOscillatorOptions } from './services/futures-entry-indicators';
export { laguerreOscillator, laguerreFilter, mfi, adaptiveLaguerreFilter } from './services/futures-entry-indicators';
export type { WaveSeries, LaguerreWaveStopsSeries, LaguerreWaveStopsOptions } from './services/futures-wave-tracking';
export { WavePattern, macdWave, dmiWave, ehlersInstTrendWave, laguerreWaveStops } from './services/futures-wave-tracking';
export type { EntryGeneration, GradedStates, EntryThresholds, LtfThresholds, EntryEvaluatorConfig, ChartIndicatorSnapshot, LtfSnapshot, EntryBarContext, EntryDecision, FuturesEntryEvaluator } from './services/futures-entry-evaluator';
// The trader's scalar ENSEMBLE entry model — no mandatory indicator, entry on a minimum score.
export type { EnsembleContributor, EnsembleMembership, EnsembleScore, EnsembleConfirmationConfig, EnsembleConfirmationVerdict, EnsembleConfirmation } from './services/futures-entry-ensemble';
export { ENSEMBLE_CONTRIBUTORS, ensembleScore, ensembleEntrySignal, createEnsembleConfirmation, gradeDmiStateEnsemble, gradeLagFilterStateEnsemble } from './services/futures-entry-ensemble';
export { createFuturesEntryEvaluator, isWithinEntryWindow, gradeDmiState, gradeMacdState, gradeMfiState, gradeLagOscState, gradeLagFilterState, gradeEitState, gradeSuperTrendState, gradeLagRsiState, gradeWavePatternState, gradeAdaptiveLagFilterState } from './services/futures-entry-evaluator';
// ADR-116 optimization objectives — the trader's nine NT8 OptimizationFitness classes as pure functions.
export type { FitnessTrade, FitnessAggregates, FitnessFunction } from './services/futures-fitness';
export {
  maxAvgMfeMinAvgMae, entryLogicFitness, stopLossMaeFitness, trailingStopFitness, targetOrderFitness,
  emergencyExitFitness, positionSizingFitness, maxNetProfitMinTrades, bankersRound,
  FITNESS_FUNCTIONS, MIN_TRADES_GATE_SENTINEL, fitnessNames,
} from './services/futures-fitness';
// ADR-116 intraday backtester — bar-walk simulator with NT8 fill semantics + multi-market overlay.
export type { BacktestTrade, EquityPoint, BacktestResult, BacktestInstrument, BacktestCosts, BacktestConfig, IndicatorConfig, OverlayPoint } from './services/futures-backtester';
export { runFuturesBacktest, maxDrawdownOf, overlayEquityCurves } from './services/futures-backtester';
export type { KibotFileOptions } from './services/futures-data-source';
export { KibotFileDataSource, resampleBars } from './services/futures-data-source';
// Continuous futures series — front-month stitching + panama back-adjustment with seam provenance.
export type { RollSeam, ContinuousContractUse, ContinuousSeries, ContinuousSeriesOptions } from './services/futures-continuous';
export { buildContinuousSeries } from './services/futures-continuous';
