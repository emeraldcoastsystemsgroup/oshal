/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for continuous-series stitching + panama back-adjustment: seam continuity after adjustment, the most-recent contract staying untouched, offset accumulation across multiple rolls, overlap-median vs adjacent seam measurement, intra-contract price-difference invariance, tick snapping, window clamping against a source that ignores windows, and adjust='none' leaving seams live.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Gap-seam guard (reviewer-caught blocker): a missing INTERMEDIATE contract classifies the boundary 'gap', contributes nothing to panama offsets, and leaves the drift discontinuity standing; removed a tautological partition assertion.
 */
import { describe, it, expect } from 'vitest';
import {
  buildContinuousSeries, contractsForRange,
  type FuturesBar, type FuturesContract, type FuturesDataSource, type FetchWindow, type Timeframe,
} from '../../src/features/trading';

/** Hourly bar at an ISO stamp with a flat OHLC around `level` (o=level, c=level+drift). */
function bar(t: string, level: number, drift = 0, v = 1000): FuturesBar {
  const o = level; const c = level + drift;
  return { t, o, h: Math.max(o, c) + 0.25, l: Math.min(o, c) - 0.25, c, v };
}

/** Hour stamps counting back from an anchor. */
function hoursBefore(anchor: Date, n: number): string {
  return new Date(anchor.getTime() - n * 3_600_000).toISOString();
}

/**
 * A scripted source: per-contract bars keyed by symbol. `honourWindow: false` models a source that
 * returns a contract's whole listed life no matter what window the caller asked for.
 */
class ScriptedSource implements FuturesDataSource {
  readonly name = 'scripted';
  constructor(private readonly bySymbol: Record<string, FuturesBar[]>, private readonly honourWindow = true) {}
  configured(): boolean { return true; }
  async fetchBars(contract: FuturesContract, _tf: Timeframe, window?: FetchWindow): Promise<FuturesBar[]> {
    const all = this.bySymbol[contract.symbol] ?? [];
    if (!this.honourWindow || !window) return all;
    return all.filter((b) => {
      const t = Date.parse(b.t);
      return (!window.start || t >= window.start.getTime()) && (!window.end || t < window.end.getTime());
    });
  }
}

// Two consecutive 2025 ES contracts around the September roll. ESU25 trades at ~6400,
// ESZ25 at ~6450 — a constant +50 basis.
const START = new Date('2025-07-01T00:00:00Z');
const END = new Date('2025-11-01T00:00:00Z');
const contracts = contractsForRange('ES', START, END);
const esu25 = contracts.find((c) => c.symbol === 'ESU25')!;
const esz25 = contracts.find((c) => c.symbol === 'ESZ25')!;
const ROLL = esz25.activeStart; // === esu25.activeEnd

function twoContractData(basis = 50): Record<string, FuturesBar[]> {
  const esu: FuturesBar[] = [];
  const esz: FuturesBar[] = [];
  // ESU25: front-month bars up to the roll, plus a few PRE-window bars nobody should stitch.
  for (let i = 60; i >= 1; i--) esu.push(bar(hoursBefore(ROLL, i), 6400));
  // ESZ25: back-month bars BEFORE the roll (overlap material for the probe) then front-month bars.
  for (let i = 60; i >= 1; i--) esz.push(bar(hoursBefore(ROLL, i), 6400 + basis));
  for (let i = 0; i < 60; i++) esz.push(bar(hoursBefore(ROLL, -i - 0), 6400 + basis));
  return { ESU25: esu, ESZ25: esz };
}

describe('buildContinuousSeries — stitching', () => {
  it('stitches only each contract inside its own active window, even against a window-ignoring source', async () => {
    const src = new ScriptedSource(twoContractData(), /* honourWindow */ false);
    const out = await buildContinuousSeries(src, 'ES', '1Hour', START, END, { adjust: 'none' });
    expect(out.contracts.map((c) => c.symbol)).toEqual(['ESU25', 'ESZ25']);
    // No ESZ25 (6450-level) bar may appear before the roll and no ESU25 (6400-level) bar after it.
    const preRoll = out.bars.filter((b) => Date.parse(b.t) < ROLL.getTime());
    const postRoll = out.bars.filter((b) => Date.parse(b.t) >= ROLL.getTime());
    expect(preRoll.every((b) => b.o === 6400)).toBe(true);
    expect(postRoll.every((b) => b.o === 6450)).toBe(true);
  });

  it('throws on an unknown root', async () => {
    await expect(buildContinuousSeries(new ScriptedSource({}), 'NOPE', '1Hour', START, END)).rejects.toThrow(/unknown futures root/);
  });

  it('skips contracts with no bars and still seams across the gap', async () => {
    const data = twoContractData();
    const wide = contractsForRange('ES', new Date('2025-04-01T00:00:00Z'), END);
    expect(wide.some((c) => c.symbol === 'ESM25')).toBe(true); // ESM25 exists but has no data
    const out = await buildContinuousSeries(new ScriptedSource(data), 'ES', '1Hour', new Date('2025-04-01T00:00:00Z'), END, { adjust: 'none' });
    expect(out.contracts.map((c) => c.symbol)).toEqual(['ESU25', 'ESZ25']);
    expect(out.seams).toHaveLength(1);
  });
});

describe('buildContinuousSeries — panama adjustment', () => {
  it("adjust:'none' leaves the seam live and every offset 0", async () => {
    const out = await buildContinuousSeries(new ScriptedSource(twoContractData()), 'ES', '1Hour', START, END, { adjust: 'none' });
    expect(out.adjusted).toBe(false);
    expect(out.contracts.every((c) => c.offset === 0)).toBe(true);
    expect(out.seams).toHaveLength(1);
    expect(out.seams[0].jump).toBeCloseTo(50, 6); // adjacent method still measures the +50 basis
  });

  it('panama removes the seam: the outgoing segment is lifted onto the incoming level', async () => {
    const out = await buildContinuousSeries(new ScriptedSource(twoContractData()), 'ES', '1Hour', START, END);
    expect(out.adjusted).toBe(true);
    const [esuUse, eszUse] = out.contracts;
    expect(esuUse.offset).toBeCloseTo(50, 9);
    expect(eszUse.offset).toBe(0);
    // Continuity: the last pre-roll close now equals the first post-roll level.
    const preRoll = out.bars.filter((b) => Date.parse(b.t) < ROLL.getTime());
    const postRoll = out.bars.filter((b) => Date.parse(b.t) >= ROLL.getTime());
    expect(preRoll[preRoll.length - 1].c).toBeCloseTo(postRoll[0].o, 9);
  });

  it('the MOST RECENT contract keeps its true prices — offsets apply only backwards', async () => {
    const out = await buildContinuousSeries(new ScriptedSource(twoContractData()), 'ES', '1Hour', START, END);
    const postRoll = out.bars.filter((b) => Date.parse(b.t) >= ROLL.getTime());
    expect(postRoll.every((b) => b.o === 6450)).toBe(true);
  });

  it('intra-contract price DIFFERENCES are invariant under adjustment', async () => {
    const raw = await buildContinuousSeries(new ScriptedSource(twoContractData()), 'ES', '1Hour', START, END, { adjust: 'none' });
    const adj = await buildContinuousSeries(new ScriptedSource(twoContractData()), 'ES', '1Hour', START, END);
    const rawPre = raw.bars.filter((b) => Date.parse(b.t) < ROLL.getTime());
    const adjPre = adj.bars.filter((b) => Date.parse(b.t) < ROLL.getTime());
    for (let i = 1; i < rawPre.length; i++) {
      expect(adjPre[i].c - adjPre[i - 1].c).toBeCloseTo(rawPre[i].c - rawPre[i - 1].c, 9);
    }
  });

  it('offsets ACCUMULATE across multiple rolls (earliest contract carries the sum)', async () => {
    // Three contracts: ESM25 @6300, ESU25 @6400 (+100), ESZ25 @6450 (+50).
    const wideStart = new Date('2025-04-01T00:00:00Z');
    const wide = contractsForRange('ES', wideStart, END);
    const esm25 = wide.find((c) => c.symbol === 'ESM25')!;
    const rollMU = esu25.activeStart;
    const data = twoContractData();
    const esm: FuturesBar[] = [];
    for (let i = 60; i >= 1; i--) esm.push(bar(hoursBefore(rollMU, i), 6300));
    data.ESM25 = esm;
    // ESU25 also needs bars just after ITS activeStart so the adjacent seam is measured there.
    const esuEarly: FuturesBar[] = [];
    for (let i = 0; i < 30; i++) esuEarly.push(bar(hoursBefore(rollMU, -i), 6400));
    data.ESU25 = [...esuEarly, ...data.ESU25];
    void esm25;
    const out = await buildContinuousSeries(new ScriptedSource(data), 'ES', '1Hour', wideStart, END);
    const bySym = Object.fromEntries(out.contracts.map((c) => [c.symbol, c.offset]));
    expect(bySym.ESZ25).toBe(0);
    expect(bySym.ESU25).toBeCloseTo(50, 9);
    expect(bySym.ESM25).toBeCloseTo(150, 9); // 100 (M→U) + 50 (U→Z)
  });

  it('snaps the offset and the ADJUSTED bars to the tick grid', async () => {
    // A 49.9-point measured basis is not on the 0.25 grid; the offset must snap (199.6 ticks → 200
    // → 50.00). Unadjusted (most-recent) bars pass through untouched by design, so only the
    // adjusted segment is asserted on-grid.
    const out = await buildContinuousSeries(new ScriptedSource(twoContractData(49.9)), 'ES', '1Hour', START, END);
    const esuUse = out.contracts[0];
    expect((esuUse.offset / 0.25) % 1).toBeCloseTo(0, 9);
    expect(esuUse.offset).toBeCloseTo(50, 9);
    const adjusted = out.bars.filter((b) => Date.parse(b.t) < ROLL.getTime());
    expect(adjusted.length).toBeGreaterThan(0);
    for (const b of adjusted) expect((b.c / 0.25) % 1).toBeCloseTo(0, 9);
  });
});

describe('buildContinuousSeries — seam measurement', () => {
  it('uses the overlap-median method when a basis probe is provided', async () => {
    const data = twoContractData();
    const src = new ScriptedSource(data);
    const probe = new ScriptedSource(data); // unclamped: serves ESZ25's pre-roll (back-month) bars
    const out = await buildContinuousSeries(src, 'ES', '1Hour', START, END, { basisProbe: probe, adjust: 'none' });
    expect(out.seams[0].method).toBe('overlap');
    expect(out.seams[0].jump).toBeCloseTo(50, 6);
  });

  it('the overlap MEDIAN shrugs off a wild adjacent bar that poisons the fallback method', async () => {
    const data = twoContractData();
    // Corrupt the outgoing contract's very last close (a thin final print far off market).
    const esu = data.ESU25;
    const last = esu[esu.length - 1];
    esu[esu.length - 1] = { ...last, c: last.c - 30, l: last.l - 30 };
    const probe = new ScriptedSource(data);
    const adjacent = await buildContinuousSeries(new ScriptedSource(data), 'ES', '1Hour', START, END, { adjust: 'none' });
    const overlap = await buildContinuousSeries(new ScriptedSource(data), 'ES', '1Hour', START, END, { adjust: 'none', basisProbe: probe });
    expect(Math.abs(adjacent.seams[0].jump - 50)).toBeGreaterThan(20); // fallback is poisoned
    expect(overlap.seams[0].jump).toBeCloseTo(50, 6);                  // median is not
  });

  it('falls back to adjacent measurement when the probe has no overlapping stamps', async () => {
    const data = twoContractData();
    // A probe whose ESZ25 has no pre-roll bars: nothing overlaps.
    const probeData = { ...data, ESZ25: data.ESZ25.filter((b) => Date.parse(b.t) >= ROLL.getTime()) };
    const out = await buildContinuousSeries(new ScriptedSource(data), 'ES', '1Hour', START, END, { adjust: 'none', basisProbe: new ScriptedSource(probeData) });
    expect(out.seams[0].method).toBe('adjacent');
    expect(out.seams[0].jump).toBeCloseTo(50, 6);
  });

  it('a MISSING INTERMEDIATE contract makes the boundary a GAP seam — reported, never adjusted', async () => {
    // ESH25 @5900 and ESU25 @6400 have data; ESM25 (between them) has NONE. The 500-point
    // difference is three months of market drift, not a roll basis — panama folding it in would
    // relocate all earlier history by 500 points (the reviewer-caught blocker).
    const wideStart = new Date('2025-01-01T00:00:00Z');
    const wide = contractsForRange('ES', wideStart, END);
    const esh25 = wide.find((c) => c.symbol === 'ESH25')!;
    const esu25w = wide.find((c) => c.symbol === 'ESU25')!;
    const data = twoContractData();
    delete (data as Record<string, FuturesBar[]>).ESM25;
    const esh: FuturesBar[] = [];
    for (let i = 60; i >= 1; i--) esh.push(bar(hoursBefore(esh25.activeEnd, i), 5900));
    data.ESH25 = esh;
    const out = await buildContinuousSeries(new ScriptedSource(data), 'ES', '1Hour', wideStart, END);
    expect(out.contracts.map((c) => c.symbol)).toEqual(['ESH25', 'ESU25', 'ESZ25']);
    const gapSeam = out.seams.find((s) => s.fromSymbol === 'ESH25')!;
    expect(gapSeam.method).toBe('gap');
    expect(esh25.activeEnd.getTime()).not.toBe(esu25w.activeStart.getTime()); // fixture sanity: truly non-adjacent
    // The gap contributes NOTHING to offsets: ESH25 carries only the measured ESU25→ESZ25 roll.
    const bySym = Object.fromEntries(out.contracts.map((c) => [c.symbol, c.offset]));
    expect(bySym.ESZ25).toBe(0);
    expect(bySym.ESU25).toBeCloseTo(50, 9);
    expect(bySym.ESH25).toBeCloseTo(50, 9); // NOT 550 — the 500-point drift is left standing
    // And the discontinuity is still visible in the bars (ESH25 level stays ~5950 after its +50).
    const eshBars = out.bars.filter((b) => Date.parse(b.t) < esh25.activeEnd.getTime());
    expect(eshBars.every((b) => b.o === 5950)).toBe(true);
  });
});
