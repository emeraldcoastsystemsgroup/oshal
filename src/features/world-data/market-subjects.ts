/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — §1 market-context coverage for the trading signal dataset (docs/apps/trading/signal-dataset.md): indices/breadth, sectors, commodities, rates/FX, crypto. Gives per-stock signals their market context (is the sector hot? is VIX spiking?).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Update docs/ paths after docs directory consolidation
 */

/**
 * Market-context subjects for the trading signal dataset (docs/apps/trading/signal-dataset.md §1).
 *
 * The 100 trading names are covered as `world:ticker:*` (world-default-subjects.ts). This file adds the
 * markets AROUND them so a signal has context, not just a single stock: index/breadth, the 11 SPDR
 * sectors (for "is my sector hot?" + rotation), commodities, rates/FX, and crypto. Each is a normal
 * `world:` entity searched by NAME through the same news feeds; the feature-rollup then computes the same
 * metric vector for them as for stocks, so the dataset can join a name against its sector and the tape.
 *
 * These ride the every-5-min ticker pulse (light pull) so they stay as fresh as the names they contextualize.
 */

import type { WorldSubject } from './world-default-subjects';

/** Index / breadth gauges. */
const INDEX: ReadonlyArray<WorldSubject> = [
  { entity: 'world:index:spy', label: 'S&P 500', query: 'S&P 500 index' },
  { entity: 'world:index:qqq', label: 'Nasdaq 100', query: 'Nasdaq 100 index' },
  { entity: 'world:index:iwm', label: 'Russell 2000', query: 'Russell 2000 small caps' },
  { entity: 'world:index:vix', label: 'VIX', query: 'VIX volatility index' },
];

/** The 11 SPDR sectors — for sector rotation + the per-stock "is my sector moving?" feature. */
const SECTOR: ReadonlyArray<WorldSubject> = [
  { entity: 'world:sector:xlk', label: 'Technology Sector', query: 'technology stocks sector' },
  { entity: 'world:sector:xlf', label: 'Financials Sector', query: 'bank financial stocks sector' },
  { entity: 'world:sector:xle', label: 'Energy Sector', query: 'energy stocks sector' },
  { entity: 'world:sector:xlv', label: 'Health Care Sector', query: 'health care stocks sector' },
  { entity: 'world:sector:xly', label: 'Consumer Discretionary Sector', query: 'consumer discretionary stocks' },
  { entity: 'world:sector:xli', label: 'Industrials Sector', query: 'industrial stocks sector' },
  { entity: 'world:sector:xlp', label: 'Consumer Staples Sector', query: 'consumer staples stocks' },
  { entity: 'world:sector:xlu', label: 'Utilities Sector', query: 'utilities stocks sector' },
  { entity: 'world:sector:xlb', label: 'Materials Sector', query: 'materials stocks sector' },
  { entity: 'world:sector:xlre', label: 'Real Estate Sector', query: 'real estate REIT stocks' },
  { entity: 'world:sector:xlc', label: 'Communication Services Sector', query: 'communication services stocks' },
];

/** Commodities (CL/ES have minute data on the trading side). */
const COMMODITY: ReadonlyArray<WorldSubject> = [
  { entity: 'world:commodity:cl', label: 'Crude Oil', query: 'crude oil prices' },
  { entity: 'world:commodity:es', label: 'S&P 500 Futures', query: 'S&P 500 futures' },
  { entity: 'world:commodity:gc', label: 'Gold', query: 'gold prices' },
  { entity: 'world:commodity:ng', label: 'Natural Gas', query: 'natural gas prices' },
  { entity: 'world:commodity:hg', label: 'Copper', query: 'copper prices' },
];

/** Rates + FX (macro) and crypto. */
const MACRO_CRYPTO: ReadonlyArray<WorldSubject> = [
  { entity: 'world:macro:us10y', label: '10Y Treasury Yield', query: '10-year Treasury yield' },
  { entity: 'world:macro:us02y', label: '2Y Treasury Yield', query: '2-year Treasury yield' },
  { entity: 'world:macro:dxy', label: 'US Dollar Index', query: 'US dollar index DXY' },
  { entity: 'world:crypto:btc', label: 'Bitcoin', query: 'Bitcoin price' },
  { entity: 'world:crypto:eth', label: 'Ethereum', query: 'Ethereum price' },
];

/** All market-context subjects (indices + sectors + commodities + rates/FX + crypto). */
export const MARKET_SUBJECTS: ReadonlyArray<WorldSubject> = [...INDEX, ...SECTOR, ...COMMODITY, ...MACRO_CRYPTO];
