/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — stage-1 prefilter keep/drop on the measured noise classes vs the operator's real-insight examples, and the fenced-JSON verdict parser (validation, id reconciliation, junk resilience).
 */
import { describe, it, expect } from 'vitest';
import { buildReaderPrompt, parseReaderVerdicts, prefilterHeadline } from '../../src/features/trading/services/news-materiality';

describe('prefilterHeadline — stage-1 keep/drop', () => {
  it('KEEPS the real-insight shapes (the operator\'s examples + the recall-test leads)', () => {
    for (const h of [
      'Nvidia Announces Strategic Partnership With Toyota On Autonomous Platform',
      'Strait Of Hormuz Closed To Tanker Traffic After Overnight Strikes',
      'US Economy Unexpectedly Sheds 120,000 Jobs In June',
      'Fed Cuts Rates 50 Basis Points, More Than Markets Expected',
      'Moderna Receives FDA Approval For Updated Covid Vaccine',
      'B of A Securities Maintains Buy on Rocket Lab USA, Raises Price Target to $55',
      'Palantir Wins $795 Million Army Software Contract Expansion',
    ]) expect(prefilterHeadline(h), h).toBe(true);
  });
  it('DROPS the measured noise classes (sweep-#5 + structural)', () => {
    for (const h of [
      'Top 10 Stocks To Watch This Week: Nvidia, Tesla And Other Big Movers',
      "What's Going On With AMD Stock Monday?",
      'Tesla Shares Rise 3% In Premarket Trading',
      'Nvidia Stock Hits New 52-Week High',
      'If You Had Invested $1,000 In Apple 10 Years Ago',
      'Unusual Options Activity Detected In Palantir',
      'Micron Q4 Earnings Preview: What Analyst Estimates Say',
      'Is Apple A Buy After The Upgrade?',
    ]) expect(prefilterHeadline(h), h).toBe(false);
  });
});

describe('parseReaderVerdicts — strict contract', () => {
  const ids = new Set([1, 2, 3]);
  it('parses a fenced json array and validates fields', () => {
    const raw = 'Here you go:\n```json\n[{"id":1,"material":true,"cls":"partnership","dir":"up","conf":0.9,"sym":"NVDA"},' +
      '{"id":2,"material":false,"cls":"other","dir":"unclear","conf":0.2,"sym":null}]\n```';
    const v = parseReaderVerdicts(raw, ids);
    expect(v.get(1)).toMatchObject({ material: true, cls: 'partnership', dir: 'up', sym: 'NVDA' });
    expect(v.get(2)?.material).toBe(false);
  });
  it('drops unknown ids, junk classes become other, conf clamps, bad syms null', () => {
    const raw = '```json\n[{"id":9,"material":true,"cls":"partnership","dir":"up","conf":1,"sym":"NVDA"},' +
      '{"id":3,"material":true,"cls":"weird","dir":"sideways","conf":7,"sym":"not-a-ticker"}]\n```';
    const v = parseReaderVerdicts(raw, ids);
    expect(v.has(9)).toBe(false);
    expect(v.get(3)).toMatchObject({ cls: 'other', dir: 'unclear', conf: 1, sym: null });
  });
  it('survives unfenced arrays and garbage', () => {
    expect(parseReaderVerdicts('[{"id":1,"material":true,"cls":"ma","dir":"up","conf":0.7,"sym":"MU"}]', ids).get(1)?.cls).toBe('ma');
    expect(parseReaderVerdicts('no json here', ids).size).toBe(0);
    expect(parseReaderVerdicts('', ids).size).toBe(0);
  });
  it('prompt carries every id and the contract line', () => {
    const p = buildReaderPrompt([{ id: 1, headline: 'A', symbols: ['X'] }, { id: 2, headline: 'B', symbols: [] }]);
    expect(p).toContain('1. [X] A');
    expect(p).toContain('2. [—] B');
    expect(p).toContain('fenced json');
  });
});
