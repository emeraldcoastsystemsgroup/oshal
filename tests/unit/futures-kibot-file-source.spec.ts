/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the file-backed Kibot source and bar resampling: the front-month clamp that keeps illiquid back-month bars out of a stitched series (proven necessary on real ESZ25 data, 1-3 contracts/bar before it went front vs ~1200 after), the volume floor, missing-file tolerance, and OHLCV aggregation semantics.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Granularity guards: a minute file fetched at 1Day must resample (regression for the column-shift misparse that fabricated a backtest's LTF series), and a daily file asked for intraday must refuse with zero bars.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Volume floor moved to AGGREGATED bars (reviewer-caught: pre-resample filtering shifted a bucket's true open/low when a zero-volume print opened it) — guard pins boundary-print OHLC surviving and a zero-total bucket dropping.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KibotFileDataSource, resampleBars, contractsForRange } from '../../src/features/trading';
import type { FuturesBar } from '../../src/features/trading';

let dir: string;

/** Kibot intraday rows: MM/DD/YYYY,HH:MM,O,H,L,C,V (exchange-local time in UTC fields). */
function row(date: string, time: string, o: number, h: number, l: number, c: number, v: number): string {
  return `${date},${time},${o},${h},${l},${c},${v}`;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kibot-'));
  // ESZ25 is front-month roughly Sep–Dec 2025. Write one bar deep in its back-month life
  // (thin, volume 1 — the contamination that made a naive real-data run meaningless) and
  // several inside its front window.
  writeFileSync(join(dir, 'ESZ25.txt'), [
    row('01/18/2024', '03:24', 5025, 5025, 5025, 5025, 1),      // back month: 20 months early
    row('06/02/2025', '10:00', 5900, 5901, 5899, 5900, 2),      // still back month
    row('10/01/2025', '10:00', 6700, 6710, 6690, 6705, 900),    // front month
    row('10/01/2025', '10:01', 6705, 6715, 6700, 6712, 800),
    row('10/01/2025', '11:30', 6712, 6720, 6708, 6718, 750),
  ].join('\n'));
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('KibotFileDataSource — the front-month clamp', () => {
  const esz25 = () => {
    const cs = contractsForRange('ES', new Date('2025-01-01T00:00:00Z'), new Date('2025-12-31T00:00:00Z'));
    const c = cs.find((x) => x.symbol === 'ESZ25');
    expect(c).toBeDefined();
    return c!;
  };

  it('reports configured only for a real directory', () => {
    expect(new KibotFileDataSource({ dir }).configured()).toBe(true);
    expect(new KibotFileDataSource({ dir: join(dir, 'nope') }).configured()).toBe(false);
  });

  it('DROPS back-month bars by default — the defect that made a real-data run meaningless', async () => {
    const src = new KibotFileDataSource({ dir });
    const bars = await src.fetchBars(esz25(), '5Min');
    // Every surviving bar must sit inside the contract's own front-month window.
    const c = esz25();
    for (const b of bars) {
      expect(Date.parse(b.t)).toBeGreaterThanOrEqual(c.activeStart.getTime());
      expect(Date.parse(b.t)).toBeLessThan(c.activeEnd.getTime());
    }
    // The 2024 and mid-2025 thin bars are gone.
    expect(bars.some((b) => b.t.startsWith('2024'))).toBe(false);
    expect(bars.some((b) => b.t.startsWith('2025-06'))).toBe(false);
    expect(bars.length).toBeGreaterThan(0);
  });

  it('frontMonthOnly:false keeps the whole listed life (opt-in, and it is a trap)', async () => {
    const all = await new KibotFileDataSource({ dir, frontMonthOnly: false }).fetchBars(esz25(), '5Min');
    expect(all.some((b) => b.t.startsWith('2024'))).toBe(true);
  });

  it('the volume floor is a second liquidity guard', async () => {
    const src = new KibotFileDataSource({ dir, frontMonthOnly: false, minVolume: 500 });
    const bars = await src.fetchBars(esz25(), '5Min');
    expect(bars.every((b) => b.v >= 500)).toBe(true);
    expect(bars.some((b) => b.v === 1)).toBe(false);
  });

  it('a missing contract file yields no bars rather than throwing', async () => {
    const cs = contractsForRange('ES', new Date('2019-01-01T00:00:00Z'), new Date('2019-06-01T00:00:00Z'));
    expect(await new KibotFileDataSource({ dir }).fetchBars(cs[0], '5Min')).toEqual([]);
  });

  it('a MINUTE file fetched at 1Day yields RESAMPLED daily bars, never column-shifted rows', async () => {
    // Regression: the old parser, told 1Day, treated 7-column minute rows as daily rows — open
    // became NaN, close became the low, volume became the close price — and returned them at
    // minute cadence. That fabricated series was fed to a real 5-year backtest as its LTF filter.
    const src = new KibotFileDataSource({ dir });
    const daily = await src.fetchBars(esz25(), '1Day');
    expect(daily).toHaveLength(1); // all three front-month minute bars fall on 2025-10-01
    expect(daily[0].t).toBe('2025-10-01T00:00:00.000Z');
    expect(daily[0].o).toBe(6700);   // first minute bar's open — NOT NaN
    expect(daily[0].h).toBe(6720);
    expect(daily[0].l).toBe(6690);
    expect(daily[0].c).toBe(6718);   // last minute bar's close — NOT its low
    expect(daily[0].v).toBe(2450);   // summed volume — NOT a price
  });

  it('the volume floor applies to AGGREGATED bars — a zero-volume boundary print still shapes OHLC', async () => {
    // Reviewer-caught: filtering raw minute rows BEFORE resampling removed a zero-volume quote
    // print at a bucket boundary and silently shifted the bucket's true open/low.
    const vdir = mkdtempSync(join(tmpdir(), 'kibot-vol-'));
    try {
      writeFileSync(join(vdir, 'ESZ25.txt'), [
        row('10/01/2025', '10:00', 6700, 6700, 6698, 6699, 0),   // zero-volume print opens the bucket
        row('10/01/2025', '10:01', 6705, 6715, 6700, 6712, 800),
        row('10/01/2025', '11:00', 6712, 6713, 6711, 6712, 0),   // a bucket whose TOTAL volume is 0
      ].join('\n'));
      const src = new KibotFileDataSource({ dir: vdir, minVolume: 1 });
      const bars = await src.fetchBars(esz25(), '1Hour');
      expect(bars).toHaveLength(1);            // the 11:00 bucket (total v=0) is dropped
      expect(bars[0].o).toBe(6700);            // the zero-volume print's open anchors the bucket
      expect(bars[0].l).toBe(6698);            // and its low survives
      expect(bars[0].v).toBe(800);
    } finally { rmSync(vdir, { recursive: true, force: true }); }
  });

  it('a DAILY file asked for intraday bars refuses loudly with zero bars (no upsampling)', async () => {
    const ddir = mkdtempSync(join(tmpdir(), 'kibot-daily-'));
    try {
      writeFileSync(join(ddir, 'ESZ25.txt'), '20251001;6725.5;6769.5;6680;6761.5;1312743\n20251002;6757;6782.25;6741.5;6766.75;1182875');
      const src = new KibotFileDataSource({ dir: ddir });
      expect(await src.fetchBars(esz25(), '1Hour')).toEqual([]);        // refuse
      expect(await src.fetchBars(esz25(), '1Day')).toHaveLength(2);      // but serve daily fine
    } finally { rmSync(ddir, { recursive: true, force: true }); }
  });
});

describe('resampleBars', () => {
  const min = (t: string, o: number, h: number, l: number, c: number, v: number): FuturesBar => ({ t, o, h, l, c, v });

  it('aggregates OHLCV correctly: first open, extremes, last close, summed volume', () => {
    const bars = [
      min('2025-10-01T10:00:00.000Z', 100, 105, 99, 104, 10),
      min('2025-10-01T10:01:00.000Z', 104, 110, 103, 108, 20),
      min('2025-10-01T10:02:00.000Z', 108, 109, 95, 96, 30),
    ];
    const out = resampleBars(bars, '1Hour');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ t: '2025-10-01T10:00:00.000Z', o: 100, h: 110, l: 95, c: 96, v: 60 });
  });

  it('buckets on wall-clock boundaries, not on bar counts', () => {
    const bars = [
      min('2025-10-01T10:59:00.000Z', 100, 101, 99, 100, 5),
      min('2025-10-01T11:00:00.000Z', 100, 102, 100, 101, 5),
    ];
    const out = resampleBars(bars, '1Hour');
    expect(out).toHaveLength(2); // the hour boundary splits them
    expect(out[0].t).toBe('2025-10-01T10:00:00.000Z');
    expect(out[1].t).toBe('2025-10-01T11:00:00.000Z');
  });

  it('handles empty input', () => {
    expect(resampleBars([], '1Hour')).toEqual([]);
  });
});
