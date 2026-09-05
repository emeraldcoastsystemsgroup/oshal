/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the pre-registered contrarian weather forward test (operator, 2026-09-04: "bet against ourselves at the extremes"). Pins the rule as fixed that day — the 0.30 disagreement threshold, the flip priced at the OTHER side's own ask (never one-minus-ours), the +0.10 claimed-overpricing probability, zero stake — and that the forward script registers those rows and the daily task runs from THIS checkout, not the stale pre-cutover one it pointed at.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WeatherMarket, WeatherPick } from '../../src/features/prediction-markets';
import {
  CLAIMED_OVERPRICING, CONTRARIAN_WEATHER_STRATEGY, WEATHER_DISAGREEMENT_MIN, contrarianWeatherRow,
} from '../../scripts/kalshi-contrarian';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function market(over: Partial<WeatherMarket> = {}): WeatherMarket {
  return {
    ticker: 'KXHIGHMIA-26SEP05-B93.5', seriesTicker: 'KXHIGHMIA', eventTicker: 'KXHIGHMIA-26SEP05', title: '93° to 94°',
    loF: 93, hiF: 94, yesAsk: 0.62, yesBid: 0.58, noAsk: 0.42, volume: 1200, closeTime: '2026-09-06T05:00:00.000Z',
    ...over,
  };
}

function pick(over: Partial<WeatherPick> = {}): WeatherPick {
  return {
    ticker: 'KXHIGHMIA-26SEP05-B93.5', seriesTicker: 'KXHIGHMIA', eventTicker: 'KXHIGHMIA-26SEP05', title: '93° to 94°',
    side: 'yes', modelProb: 0.95, marketProb: 0.62, price: 0.62, fee: 0.0165, edgeNet: 0.31, stakeFraction: 0,
    rationale: { forecastF: 94, leadDays: 1, sigma: 2.2, bias: 0, ensoPhase: 'el-nino', oni: 1.8, errorModelN: 47, errorModelIsPrior: false },
    closeTime: '2026-09-06T05:00:00.000Z',
    ...over,
  } as WeatherPick;
}

describe('contrarian-weather-disagree: the rule as pre-registered on 2026-09-04', () => {
  it('flips a 30+ point disagreement to the other side at THAT side\'s own ask, stake zero', () => {
    const row = contrarianWeatherRow(pick(), market());
    expect(row).not.toBeNull();
    expect(row!.strategy).toBe(CONTRARIAN_WEATHER_STRATEGY);
    expect(row!.side).toBe('no');
    // The other side's ask from the book (0.42), not 1 − our ask (0.38): the spread is real money.
    expect(row!.marketProb).toBe(0.42);
    expect(row!.predictedProb).toBeCloseTo(0.42 + CLAIMED_OVERPRICING, 10);
    expect(row!.stakeFraction).toBe(0);
    expect(row!.edgeNet).toBeLessThan(CLAIMED_OVERPRICING);   // the fee comes off the claim
    expect(row!.edgeNet).toBeGreaterThan(0.08);
    expect(row!.rationale).toMatchObject({
      flippedFrom: 'weather-enso', ourSide: 'yes', ourProb: 0.95, ourAsk: 0.62, claimedOverpricing: CLAIMED_OVERPRICING,
      forecastF: 94, leadDays: 1,
    });
    expect(row!.rationale.disagreement).toBeCloseTo(0.33, 10);
    expect(row!.closeTime).toBe('2026-09-06T05:00:00.000Z');
  });

  it('flips a NO pick to YES at the yes ask', () => {
    const row = contrarianWeatherRow(pick({ side: 'no', modelProb: 0.80, marketProb: 0.42, price: 0.42 }), market());
    expect(row!.side).toBe('yes');
    expect(row!.marketProb).toBe(0.62);
  });

  it('the threshold is inclusive at 0.30 and nothing below it registers', () => {
    expect(WEATHER_DISAGREEMENT_MIN).toBe(0.30);
    expect(contrarianWeatherRow(pick({ modelProb: 0.92 }), market())).not.toBeNull();        // 0.30 exactly
    expect(contrarianWeatherRow(pick({ modelProb: 0.91 }), market())).toBeNull();            // 0.29
    expect(contrarianWeatherRow(pick({ modelProb: 0.70 }), market())).toBeNull();
  });

  it('refuses when the other side has no usable ask, and never prices above 0.99', () => {
    expect(contrarianWeatherRow(pick(), market({ noAsk: 0 }))).toBeNull();
    expect(contrarianWeatherRow(pick(), market({ noAsk: 0.995 }))).toBeNull();
    expect(contrarianWeatherRow(pick(), market({ noAsk: 0.01 }))).toBeNull();
    const capped = contrarianWeatherRow(pick({ modelProb: 0.35, marketProb: 0.05, price: 0.05 }), market({ yesAsk: 0.05, noAsk: 0.96 }));
    expect(capped!.predictedProb).toBe(0.99);
  });

  it('needs the pick\'s own market: a missing or mismatched market registers nothing', () => {
    expect(contrarianWeatherRow(pick(), undefined)).toBeNull();
    expect(contrarianWeatherRow(pick(), market({ ticker: 'KXHIGHMIA-26SEP05-B95.5' }))).toBeNull();
  });
});

describe('the forward script registers the contrarian rows and the daily task runs from this checkout', () => {
  const forward = read('scripts/oshal-kalshi-forward.ts');
  const daily = read('scripts/kalshi-forward-daily.cmd');

  it('builds a contrarian row for every pick against its own market and pre-registers it immutably', () => {
    expect(forward).toContain("from './kalshi-contrarian'");
    expect(forward).toMatch(/contrarianWeatherRow\(p, byTicker\.get\(p\.ticker\)\)/);
    expect(forward).toMatch(/CONTRARIAN_WEATHER_STRATEGY/);
    // Two INSERTs into the ledger, both ON CONFLICT DO NOTHING — a prediction is immutable once made.
    const inserts = forward.match(/INSERT INTO kalshi_predictions[\s\S]*?ON CONFLICT \(strategy, ticker\) DO NOTHING/g) ?? [];
    expect(inserts).toHaveLength(2);
  });

  it('the scheduled task\'s command file runs its OWN checkout, not a hardcoded stale path', () => {
    // Until 2026-09-04 this cd'd into C:\Projects\open-shal-swarm-harness-agent-llm — the pre-cutover
    // checkout — so every change to the grader/forward script in the trunk was silently never run.
    expect(daily).toMatch(/cd \/d %~dp0\.\./);
    expect(daily).not.toMatch(/open-shal-swarm-harness-agent-llm/);
  });
});
