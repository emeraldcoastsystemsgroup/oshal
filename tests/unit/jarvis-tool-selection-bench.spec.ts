/**
 * Guard for the Jarvis tool-selection harness.
 *
 * WHY THIS EXISTS: the harness is the thing that decides whether a narrower tool block or a wider
 * deterministic fast lane is allowed anywhere near core, so its verdict is the load-bearing part.
 * Two ways it could lie, and both are guarded here:
 *
 *   1. It could grade against a FIXTURE instead of the shipped selector, and then its "savings"
 *      would describe a block Jarvis never sends. So the first test crosses that boundary: the
 *      harness's baseline must be byte-for-byte what the real `buildToolsBlock` emits, off the real
 *      jarvis-tools.yaml and the real mounted scripts directory - no mock, no stub, no fixture.
 *   2. It could average. A candidate that trims twenty turns and drops the needed tool on one is a
 *      candidate that breaks a user's turn, and an average hides that. So the gate is asserted to
 *      be binary on `regressions`, with an otherwise identical zero-regression twin proving the
 *      gate still says `adopt` when a candidate is actually clean.
 *
 * The fast lane is graded on the opposite axis in the same run: firing the wrong deterministic
 * handler bypasses the model entirely, so it is counted as a false match and rejected even though
 * bypassing the model is the largest possible token saving.
 *
 * And nothing here is allowed to invent a number: with no tokenizer the token axis must report
 * not-run and name the reason, never bytes-divided-by-four.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - proves the harness measures the real selector, gates binarily on regressions, counts a widened fast lane's wrong fire as a false match, and reports not-run rather than an estimated token number.
 *
 * @module tests/unit/jarvis-tool-selection-bench
 */

import { describe, it, expect } from 'vitest';
import { buildToolsBlock } from '../../src/app/routes/jarvis-tool-catalog';
import { builtInCorpus, loadCorpus, type CorpusItem } from '../../bench/jarvis-tool-selection/corpus';
import { buildBaseline, candidates, BASELINE_CANDIDATE, type Candidate } from '../../bench/jarvis-tool-selection/selectors';
import { measure, report, resolveTokenizer, type Tokenizer } from '../../bench/jarvis-tool-selection/measure';

const corpus = builtInCorpus();
const item = (id: string): CorpusItem => {
  const found = corpus.find((entry) => entry.id === id);
  if (!found) throw new Error(`corpus item ${id} is missing - the guard is measuring the wrong corpus`);
  return found;
};

/** A candidate whose block is tiny (a real saving) and whose tool set is otherwise the baseline's. */
function trimmed(name: string, drop?: { id: string; script: string }): Candidate {
  return {
    name,
    family: 'tool-cut',
    describe: 'test candidate: a large, real byte saving',
    select: (baseline, graded) => {
      const kept = baseline.tools.filter((tool) => !(drop && graded.id === drop.id && tool.script === drop.script));
      return { block: kept.map((tool) => tool.script).join('\n'), tools: kept.map((tool) => tool.script), intent: baseline.intent };
    },
  };
}

describe('Jarvis tool-selection harness: it measures the real selector', () => {
  it('grades the block the shipped selector really emits, not a fixture', () => {
    const graded = item('tool-nowplaying');
    const baseline = buildBaseline(graded);

    expect(baseline.block).toBe(buildToolsBlock({ message: graded.message, surface: graded.surface }));
    expect(baseline.tools.length).toBeGreaterThanOrEqual(10);
    expect(baseline.tools[0].script).toBe('oshal-spotify.js');
    expect(baseline.tools[0].keywords).toContain('spotify');
    expect(baseline.tools.map((tool) => tool.script)).toContain('oshal-gmail.js');
  });

  it('reproduces the baseline block from its own parsed parts, so a cut is the only difference', () => {
    const graded = item('tool-jazz');
    const baseline = buildBaseline(graded);

    expect(BASELINE_CANDIDATE.select(baseline, graded).block).toBe(baseline.block);
  });
});

describe('Jarvis tool-selection harness: the gate is binary on regressions', () => {
  it('rejects a candidate that saves a lot on average and regresses exactly once', () => {
    const [clean, broken] = measure(corpus, [
      trimmed('clean-trim'),
      trimmed('trim-that-breaks-one', { id: 'tool-jazz', script: 'oshal-spotify.js' }),
    ]);

    expect(clean.inputBytesDelta).toBeLessThan(0);
    expect(clean.regressions).toBe(0);
    expect(clean.gate).toBe('pass');
    expect(clean.verdict).toBe('adopt');

    // Same saving, one broken turn. An average would promote it; the gate must not.
    expect(broken.inputBytesDelta).toBeLessThan(0);
    expect(broken.inputBytesDelta).toBeLessThan(clean.inputBytesDelta! / 2);
    expect(broken.regressions).toBe(1);
    expect(broken.regressedItems).toEqual(['tool-jazz']);
    expect(broken.gate).toBe('fail');
    expect(broken.verdict).toBe('reject');
    expect(broken.recall).toBeLessThan(clean.recall!);
  });

  it('never blames the candidate for a fault the baseline already had', () => {
    const [control] = measure(corpus, [BASELINE_CANDIDATE]);

    expect(control.regressions).toBe(0);
    expect(control.inputBytesDelta).toBe(0);
    expect(control.falseMatches).toBe(0);
  });
});

describe('Jarvis tool-selection harness: a widened fast lane is judged on precision', () => {
  it('counts a deterministic fire on a model-owned turn as a false match and rejects it', () => {
    const widened = candidates().find((candidate) => candidate.family === 'fast-lane');
    expect(widened).toBeDefined();
    const [graded] = measure(corpus, [widened!]);

    expect(item('model-calendar').expectedIntent).toBeNull();
    expect(graded.falseMatches).toBeGreaterThanOrEqual(1);
    expect(graded.regressedItems).toContain('model-calendar');
    expect(graded.gate).toBe('fail');
    expect(graded.verdict).toBe('reject');
    // Bypassing the model is the biggest possible saving; it must not buy a pass.
    expect(graded.inputBytesDelta).toBeLessThan(0);
  });

  it('keeps the shipped fast lane answering every recorded provider-bound turn', () => {
    const [control] = measure(corpus, [BASELINE_CANDIDATE]);

    expect(control.missedIntents).toBe(0);
  });
});

describe('Jarvis tool-selection harness: it reports not-run instead of a number', () => {
  it('leaves the token axis unmeasured, with a reason, when no tokenizer resolves', async () => {
    const { tokenizer, status } = await resolveTokenizer('');
    expect(tokenizer).toBeUndefined();
    expect(status.status).toBe('not-run');
    expect(status.reason).toContain('JARVIS_BENCH_TOKENIZER');

    const result = report(corpus, [BASELINE_CANDIDATE, trimmed('clean-trim')], tokenizer, status);
    expect(result.tokenizer.status).toBe('not-run');
    for (const candidate of result.candidates) {
      expect(candidate.inputTokens).toBeNull();
      expect(candidate.inputTokensDelta).toBeNull();
      expect(typeof candidate.inputBytesDelta).toBe('number');
    }
  });

  it('names the module it could not load rather than silently skipping the token axis', async () => {
    const { tokenizer, status } = await resolveTokenizer('./no-such-tokenizer-module-here');
    expect(tokenizer).toBeUndefined();
    expect(status.status).toBe('not-run');
    expect(status.reason).toContain('no-such-tokenizer-module-here');
  });

  it('counts tokens with a supplied encoder and reports the delta against the baseline', () => {
    const encoder: Tokenizer = { module: 'test-encoder', count: (text) => text.split(/\s+/).filter(Boolean).length };
    const [control, trim] = measure(corpus, [BASELINE_CANDIDATE, trimmed('clean-trim')], encoder);

    expect(control.inputTokens).toBeGreaterThan(0);
    expect(control.inputTokensDelta).toBe(0);
    expect(trim.inputTokens).toBeLessThan(control.inputTokens!);
    expect(trim.inputTokensDelta).toBe(trim.inputTokens! - control.inputTokens!);
  });

  it('reports a candidate that throws as not-run, with every number left null', () => {
    const exploding: Candidate = {
      name: 'explodes', family: 'tool-cut', describe: 'test candidate: throws',
      select: () => { throw new Error('selector blew up'); },
    };
    const [graded] = measure(corpus, [exploding]);

    expect(graded.status).toBe('not-run');
    expect(graded.reason).toContain('selector blew up');
    expect(graded.gate).toBe('not-run');
    expect(graded.verdict).toBe('not-run');
    expect(graded.recall).toBeNull();
    expect(graded.inputBytes).toBeNull();
    expect(graded.regressions).toBeNull();
  });

  it('refuses a recorded corpus it cannot read instead of grading the synthetic one', () => {
    expect(() => loadCorpus('C:/no/such/recorded-corpus.jsonl')).toThrow(/recorded corpus not found/);
    expect(builtInCorpus().every((entry) => entry.provenance !== 'recorded')).toBe(true);
  });
});
