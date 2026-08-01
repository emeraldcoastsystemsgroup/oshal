/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 data source + completeness validator: mock determinism, clean data reads complete with no interior gaps, dropRate produces gaps + missing bars, convergence test, patch list, and Kibot CSV parsing (intraday + daily).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | parseKibotCsv guards rewritten for the shape-inferred parser: all four real Kibot row formats (comma/semicolon × intraday/daily, incl. the CL compact-datetime), the column-shift regression that fabricated the LTF series, NaN-row rejection, and impossible-date rejection.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Reviewer-driven attack cases: trailing-delimiter column-flip, non-time 7th-column rejection, blank-OHLC-as-$0 rejection, calendar-rollover rejection, BOM/whitespace tolerance; full-object assertions on the semicolon shapes.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Session-calendar era: the mock must emit the real Globex shape (no weekend, no 17:00 halt hour, no Good Friday), the halt/holiday must NOT read as gaps, and — the mutation guard — a genuinely missing mid-session hour still MUST. Clean-data completeness stays exactly 1 because mock and expected count now share one calendar.
 */
import { describe, it, expect } from 'vitest';
import {
  MockFuturesDataSource, assessContractCompleteness, contractsForRange, getFuturesRoot,
  ingestConverged, patchList, parseKibotCsv, type ContractCompleteness, type FuturesBar,
} from '../../src/features/trading';

const es = getFuturesRoot('ES')!;
const esm24 = contractsForRange('ES', new Date('2024-01-01T00:00:00Z'), new Date('2024-12-31T00:00:00Z'))
  .find((c) => c.symbol === 'ESM24')!;

describe('MockFuturesDataSource', () => {
  it('is deterministic — same contract yields identical bars', async () => {
    const src = new MockFuturesDataSource();
    const a = await src.fetchBars(esm24, '1Hour');
    const b = await src.fetchBars(esm24, '1Hour');
    expect(a.length).toBe(b.length);
    expect(a[0]).toEqual(b[0]);
    expect(a[a.length - 1]).toEqual(b[b.length - 1]);
  });
  it('emits the Globex session shape: no Saturday, no 17:00 halt hour, no Good Friday', async () => {
    const bars = await new MockFuturesDataSource().fetchBars(esm24, '1Hour');
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.filter((x) => new Date(x.t).getUTCDay() === 6)).toHaveLength(0);
    expect(bars.filter((x) => new Date(x.t).getUTCHours() === 17)).toHaveLength(0);
    expect(bars.filter((x) => x.t.startsWith('2024-03-29'))).toHaveLength(0); // Good Friday closure
  });

  it('emits the Sunday 18:00 open — the evening segment is IN the session, not weekend-culled', async () => {
    // 2024-04-07 is a plain Sunday inside the ESM24 window; its 18:00–23:00 hours must exist.
    const bars = await new MockFuturesDataSource().fetchBars(esm24, '1Hour');
    const sundayEvening = bars.filter((x) => x.t.startsWith('2024-04-07'));
    expect(sundayEvening.map((x) => new Date(x.t).getUTCHours()).sort((a, b) => a - b)).toEqual([18, 19, 20, 21, 22, 23]);
  });
});

describe('completeness — clean data', () => {
  it('reads complete with no interior gaps (weekends are not gaps)', async () => {
    const bars = await new MockFuturesDataSource({ dropRate: 0 }).fetchBars(esm24, '1Hour');
    const v = assessContractCompleteness(esm24, '1Hour', es, bars);
    expect(v.complete).toBe(true);
    expect(v.completeness).toBe(1);
    expect(v.gaps).toHaveLength(0);
    expect(v.missing).toBe(0);
  });
});

describe('completeness — incomplete data', () => {
  it('a 10% drop rate produces gaps, missing bars, and an incomplete verdict', async () => {
    const bars = await new MockFuturesDataSource({ dropRate: 0.1 }).fetchBars(esm24, '1Hour');
    const v = assessContractCompleteness(esm24, '1Hour', es, bars);
    expect(v.completeness).toBeLessThan(1);
    expect(v.missing).toBeGreaterThan(0);
    expect(v.gaps.length).toBeGreaterThan(0);
    expect(v.complete).toBe(false);
  });
});

describe('session-aware gap detection (the mutation guard for the calendar wiring)', () => {
  /** Hand-built hourly bars over [fromIso, toIso) for every SESSION hour, no library help. */
  function sessionBars(hours: string[]): FuturesBar[] {
    return hours.map((t) => ({ t, o: 5000, h: 5001, l: 4999, c: 5000, v: 100 }));
  }
  // Tuesday 2024-04-09, hand-enumerated Globex hours: 00:00–16:00 day session, 18:00–23:00 evening.
  const tuesdayHours = [
    ...Array.from({ length: 17 }, (_, h) => `2024-04-09T${String(h).padStart(2, '0')}:00:00.000Z`),
    ...Array.from({ length: 6 }, (_, i) => `2024-04-09T${String(18 + i).padStart(2, '0')}:00:00.000Z`),
  ];
  const window = { windowStart: new Date('2024-04-09T00:00:00Z'), windowEnd: new Date('2024-04-10T00:00:00Z') };

  it('a full session day straddling the 17:00 halt has NO gap and completeness exactly 1', () => {
    const v = assessContractCompleteness(esm24, '1Hour', es, sessionBars(tuesdayHours), window);
    expect(v.expected).toBe(23);
    expect(v.received).toBe(23);
    expect(v.completeness).toBe(1);
    expect(v.gaps).toHaveLength(0); // the halt hour is NOT missing data
  });

  it('a genuinely missing mid-session hour still reads as a gap — the guard that can go red', () => {
    // Drop 10:00. If someone widens the session predicate (or gap counting regresses to "any
    // adjacent buckets"), this stops detecting and goes red.
    const holed = tuesdayHours.filter((t) => !t.includes('T10:'));
    const v = assessContractCompleteness(esm24, '1Hour', es, sessionBars(holed), window);
    expect(v.missing).toBe(1);
    expect(v.gaps).toHaveLength(1);
    expect(v.gaps[0].missingBars).toBe(1);
    expect(v.gaps[0].fromIso).toBe('2024-04-09T09:00:00.000Z');
    expect(v.gaps[0].toIso).toBe('2024-04-09T11:00:00.000Z');
  });
});

describe('re-fetch convergence + patch list', () => {
  it('converges when a re-fetch adds no new bars', () => {
    expect(ingestConverged(100, 100)).toBe(true);
    expect(ingestConverged(120, 100)).toBe(true);
    expect(ingestConverged(100, 120)).toBe(false);
  });
  it('patchList returns only the incomplete contracts, worst first', () => {
    const mk = (symbol: string, completeness: number, complete: boolean): ContractCompleteness => ({
      symbol, timeframe: '1Hour', expected: 100, received: Math.round(completeness * 100),
      missing: 100 - Math.round(completeness * 100), completeness, gaps: [], complete,
    });
    const list = patchList([mk('A', 1, true), mk('B', 0.5, false), mk('C', 0.8, false)]);
    expect(list.map((v) => v.symbol)).toEqual(['B', 'C']);
  });
});

describe('parseKibotCsv', () => {
  it('parses a comma intraday row (MM/DD/YYYY,HH:MM,O,H,L,C,V)', () => {
    const bars = parseKibotCsv('03/14/2025,09:30,5000,5010,4990,5005,1234');
    expect(bars).toHaveLength(1);
    expect(bars[0].t).toBe('2025-03-14T09:30:00.000Z');
    expect(bars[0].o).toBe(5000);
    expect(bars[0].c).toBe(5005);
    expect(bars[0].v).toBe(1234);
  });
  it('parses a comma daily row (MM/DD/YYYY,O,H,L,C,V)', () => {
    const bars = parseKibotCsv('03/14/2025,5000,5010,4990,5005,999999');
    expect(bars).toHaveLength(1);
    expect(bars[0].t).toBe('2025-03-14T00:00:00.000Z');
    expect(bars[0].v).toBe(999999);
  });
  it('parses a semicolon daily row (YYYYMMDD;O;H;L;C;V — the ES/CL daily bulk format)', () => {
    const bars = parseKibotCsv('20251001;6725.5;6769.5;6680;6761.5;1312743');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toEqual({ t: '2025-10-01T00:00:00.000Z', o: 6725.5, h: 6769.5, l: 6680, c: 6761.5, v: 1312743 });
  });
  it('parses a semicolon compact-datetime row (YYYYMMDD HHMMSS;… — the CL minute bulk format)', () => {
    const bars = parseKibotCsv('20251120 142800;59.2;59.23;59.13;59.21;221');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toEqual({ t: '2025-11-20T14:28:00.000Z', o: 59.2, h: 59.23, l: 59.13, c: 59.21, v: 221 });
  });
  it('a TRAILING delimiter does not flip a daily row into the intraday column map', () => {
    // Reviewer-caught: with `>=` column counts, this row parsed as intraday — h<l and the VOLUME
    // became the closing price. Trailing empties are stripped; the count must then match exactly.
    const bars = parseKibotCsv('20251001;6725.5;6769.5;6680;6761.5;1312743;');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toEqual({ t: '2025-10-01T00:00:00.000Z', o: 6725.5, h: 6769.5, l: 6680, c: 6761.5, v: 1312743 });
  });
  it('a 7-column row whose second field is NOT time-shaped is rejected, not guessed at', () => {
    expect(parseKibotCsv('20251001;6725.5;6769.5;6680;6761.5;1312743;99')).toHaveLength(0);
  });
  it('a BLANK OHLC field drops the row — Number("") is 0 and a $0 price is a fabrication', () => {
    expect(parseKibotCsv('20251001;6725.5;6769.5;6680;;1312743')).toHaveLength(0);
    expect(parseKibotCsv('03/14/2025,09:30,5000, ,4990,5005,1234')).toHaveLength(0);
  });
  it('an impossible CALENDAR date drops the row instead of Date.UTC rolling it forward', () => {
    expect(parseKibotCsv('02/30/2025,09:30,5000,5010,4990,5005,1234')).toHaveLength(0); // would roll to Mar 2
    expect(parseKibotCsv('20250431;100;101;99;100;5')).toHaveLength(0); // Apr 31 → would roll to May 1
  });
  it('tolerates a UTF-8 BOM and leading whitespace on data rows', () => {
    const bars = parseKibotCsv('﻿03/14/2025,09:30,5000,5010,4990,5005,1234\n  03/15/2025,09:30,5001,5011,4991,5006,999');
    expect(bars).toHaveLength(2);
    expect(bars[0].o).toBe(5000);
  });
  it('NEVER column-shifts a minute row into a fabricated daily bar — the shape comes from the row', () => {
    // The old parser, told '1Day', read this 7-column minute row with base 0: open ← '09:30' (NaN),
    // close ← the low, volume ← the close. Shape inference makes the timeframe irrelevant.
    const bars = parseKibotCsv('01/18/2024,09:30,5025,5030,5020,5028,17');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toEqual({ t: '2024-01-18T09:30:00.000Z', o: 5025, h: 5030, l: 5020, c: 5028, v: 17 });
  });
  it('drops rows whose OHLC is not finite instead of emitting NaN bars', () => {
    expect(parseKibotCsv('03/14/2025,09:30,abc,5010,4990,5005,1234')).toHaveLength(0);
  });
  it('skips header/blank/garbage lines and impossible dates', () => {
    expect(parseKibotCsv('Date,Time,Open,High,Low,Close,Volume\n\n')).toHaveLength(0);
    expect(parseKibotCsv('20251301;1;1;1;1;0')).toHaveLength(0); // month 13
  });
});
