/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-096 shadow indicators: each of the six fires on an engineered tape (macd trend, bollinger band-stretch, atr-channel breakout, adx trend-strength, stochastic oversold turn, volume z-surge), a quiet tape fires nothing, and the SHADOW/LIVE separation invariants hold (algoNames unchanged, no shadow name in live votes).
 */
import { describe, it, expect } from 'vitest';
import { algoNames, scoreSymbol, scoreSymbolShadow, shadowAlgoNames } from '../../src/features/trading/services/algorithms';
import type { OhlcvBar } from '../../src/features/trading/services/market-data';

/** Bars from a close series: o=c, h/l = c ± spread, constant-ish volume unless given. */
const mkBars = (closes: number[], spread = 0.5, vols?: number[]): OhlcvBar[] =>
  closes.map((c, i) => ({ o: c, h: c + spread, l: c - spread, c, v: vols ? vols[i] : 1_000_000 + (i % 2 ? 50_000 : -50_000) }));

const flat = (n: number, px = 100): number[] => Array.from({ length: n }, (_, i) => px + (i % 2 ? 0.3 : -0.3));

describe('shadow/live separation invariants', () => {
  it('algoNames (the vote schema) is unchanged and disjoint from shadowAlgoNames', () => {
    expect(algoNames()).toEqual(['momentum', 'gravity', 'donchian', 'meanrev']);
    expect(shadowAlgoNames().sort()).toEqual(['adx', 'atr-channel', 'bollinger', 'macd', 'stochastic', 'volsurge']);
    for (const n of shadowAlgoNames()) expect(algoNames()).not.toContain(n);
  });
  it('live scoreSymbol never emits a shadow algo; scoreSymbolShadow never emits a live algo', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i); // strong trend fires several of each
    const live = scoreSymbol('TEST', closes).map((s) => s.algo);
    for (const a of live) expect(shadowAlgoNames()).not.toContain(a);
    const shadow = scoreSymbolShadow('TEST', mkBars(closes)).map((s) => s.algo);
    for (const a of shadow) expect(algoNames()).not.toContain(a);
  });
  it('a quiet flat tape fires no shadow signals (noise floors hold)', () => {
    expect(scoreSymbolShadow('TEST', mkBars(flat(80), 0.4))).toEqual([]);
  });
  it('short history (<60 bars) fires nothing', () => {
    expect(scoreSymbolShadow('TEST', mkBars(flat(50)))).toEqual([]);
  });
});

describe('each indicator fires on its engineered tape', () => {
  it('macd — accelerating uptrend → positive histogram → up', () => {
    const closes = [...flat(50), ...Array.from({ length: 30 }, (_, i) => 100 * Math.pow(1.01, i + 1))];
    const s = scoreSymbolShadow('TEST', mkBars(closes)).find((x) => x.algo === 'macd');
    expect(s?.dir).toBe('up');
    expect(s!.confidence).toBeGreaterThan(0);
  });
  it('bollinger — close stretched far below the band → mean-reversion up', () => {
    const closes = [...flat(79), 95];
    const s = scoreSymbolShadow('TEST', mkBars(closes)).find((x) => x.algo === 'bollinger');
    expect(s?.dir).toBe('up');
  });
  it('atr-channel — breakout above SMA20 + 2×ATR14 → up', () => {
    const closes = [...flat(79), 110];
    const s = scoreSymbolShadow('TEST', mkBars(closes, 1)).find((x) => x.algo === 'atr-channel');
    expect(s?.dir).toBe('up');
  });
  it('adx — sustained one-way trend → strong ADX with +DI leading → up', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const s = scoreSymbolShadow('TEST', mkBars(closes)).find((x) => x.algo === 'adx');
    expect(s?.dir).toBe('up');
    expect(s!.confidence).toBeGreaterThanOrEqual(0.3);
  });
  it('stochastic — long slide into oversold, then a turn up → up', () => {
    const down = Array.from({ length: 76 }, (_, i) => 150 - i);       // slide to 75
    const closes = [...down, 74.4, 74.6, 74.9, 75.4];                  // basing turn near the lows
    const s = scoreSymbolShadow('TEST', mkBars(closes)).find((x) => x.algo === 'stochastic');
    expect(s?.dir).toBe('up');
  });
  it('volsurge — 2σ+ volume with a real down move → down (volume confirms direction)', () => {
    const closes = [...flat(79), 98];                                  // −2% day
    const vols = closes.map((_, i) => (i === closes.length - 1 ? 3_000_000 : i % 2 ? 1_100_000 : 900_000));
    const s = scoreSymbolShadow('TEST', mkBars(closes, 0.5, vols)).find((x) => x.algo === 'volsurge');
    expect(s?.dir).toBe('down');
  });
  it('volsurge does NOT fire on heavy volume with a flat close (no direction to confirm)', () => {
    const closes = [...flat(78), 100, 100.05]; // last day +0.05% — under the 0.2% direction floor
    const vols = closes.map((_, i) => (i === closes.length - 1 ? 3_000_000 : i % 2 ? 1_100_000 : 900_000));
    const fired = scoreSymbolShadow('TEST', mkBars(closes, 0.5, vols)).find((x) => x.algo === 'volsurge');
    expect(fired).toBeUndefined();
  });
});
