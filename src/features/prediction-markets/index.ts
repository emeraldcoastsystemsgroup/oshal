/**
 * Prediction-markets feature barrel — Kalshi public data, fee math, calibration, bet evaluation.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel — public client + fees + calibration + evaluator + types.
 *
 * @module prediction-markets
 */

export * from './types';
export {
  kalshiApiBase, kalshiGet, normalizeMarket, listMarkets, listMarketsFiltered, listSeries, getSeriesMeta, getCandles, exchangeTradingActive,
} from './services/kalshi-public-client';
export { takerFee, feePerContract, effectiveCost } from './services/kalshi-fees';
export { buildCalibrationTable, calibratedProb, BUCKET_EDGES } from './services/calibration';
export type { CalibratedProb } from './services/calibration';
export { evaluateMarket, rankHands, CALIBRATION_HORIZONS } from './services/bet-evaluator';
export {
  normalizePem, signKalshiRequest, kalshiAuthHeaders, parseKalshiSecret, kalshiAuthedGet, kalshiAuthedRequest,
  probeKalshiAccount, kalshiKeyEnv, KALSHI_DEMO_BASE,
} from './services/kalshi-auth';
export {
  getKalshiPortfolio, validateOrderRequest, kalshiLiveOrdersEnabled, placeKalshiOrder, cancelKalshiOrder,
} from './services/kalshi-portfolio';
export { scanArbitrage, findOverround, findLadderViolations, findUnderround } from './services/arbitrage';
export type { ArbOpportunity, ArbLeg } from './services/arbitrage';
export { getEnsoState, classifyOni } from './services/enso';
export type { EnsoPhase, EnsoState } from './services/enso';
export {
  WEATHER_CITIES, buildErrorModel, bucketProbability, getForecastHigh, getObservedHigh, resolveGrid,
} from './services/weather-model';
export type { ErrorModel, ForecastErrorSample } from './services/weather-model';
export { evaluateWeatherMarkets, parseBucket, parseMarketDate, sanityCheck } from './services/weather-strategy';
export type { WeatherMarket, WeatherPick } from './services/weather-strategy';
export type { KalshiPortfolioSnapshot, KalshiPosition, KalshiOrder, KalshiOrderRequest } from './services/kalshi-portfolio';
export type { KalshiCreds } from './services/kalshi-auth';
export { getScorecard, mayStrategyStake } from './services/strategy-scorecard';
export type { StrategyScore, StrategyStatus } from './services/strategy-scorecard';
