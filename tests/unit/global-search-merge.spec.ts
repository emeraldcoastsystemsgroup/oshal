/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for global search's pure ranking (escapeIlike / buildSnippet / ilikeRecencyScore / normalizeScores / mergeRankedHits) and the orchestrator's ISOLATION contract with mock adapters: every adapter gets the caller's sub verbatim, sources= filtering, a throwing adapter degrades to empty instead of sinking the search, and the global cap holds.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | SearchHit gained a required `kind`; the fixture builder now stamps one. Kept as 'doc' for every fixture on purpose - these tests are about ranking and fault isolation, and giving each fake source a different kind would imply the merge cares about kind, which it deliberately does not.
 */
import { describe, it, expect } from 'vitest';
import {
  GlobalSearchService,
  buildSnippet,
  escapeIlike,
  ilikeRecencyScore,
  mergeRankedHits,
  normalizeScores,
  type SearchCallerExtras,
  type SearchHit,
  type SearchSource,
} from '@/features/global-search';

/** Shorthand hit builder. */
function hit(source: string, id: string, score: number, ts: string | null = null): SearchHit {
  return { id, title: `${source}-${id}`, snippet: '', kind: 'doc', url: null, score, source, ts };
}

describe('escapeIlike — user text never becomes a wildcard', () => {
  it('escapes %, _ and backslash', () => {
    expect(escapeIlike('100%_done\\x')).toBe('100\\%\\_done\\\\x');
  });
  it('leaves plain text untouched', () => {
    expect(escapeIlike('rotation gap guard')).toBe('rotation gap guard');
  });
});

describe('buildSnippet', () => {
  const text = `${'a'.repeat(300)} NEEDLE ${'b'.repeat(300)}`;
  it('centers on the match with ellipses on both sides', () => {
    const s = buildSnippet(text, 'needle');
    expect(s).toContain('NEEDLE');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThan(200);
  });
  it('falls back to the head when the query does not literally occur', () => {
    const s = buildSnippet(text, 'zzz-not-there');
    expect(s.startsWith('aaa')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });
  it('collapses whitespace and handles empty text', () => {
    expect(buildSnippet('a\n\n  b\tc', 'b')).toBe('a b c');
    expect(buildSnippet('', 'x')).toBe('');
  });
});

describe('ilikeRecencyScore — the ILIKE+recency fallback', () => {
  const now = Date.parse('2026-07-15T12:00:00Z');
  it('a fresh title match scores ~1 and beats a fresh body match', () => {
    const title = ilikeRecencyScore(true, '2026-07-15T11:00:00Z', now);
    const body = ilikeRecencyScore(false, '2026-07-15T11:00:00Z', now);
    expect(title).toBeGreaterThan(0.99);
    expect(title).toBeGreaterThan(body);
  });
  it('halves after the 30-day half-life', () => {
    const s = ilikeRecencyScore(true, '2026-06-15T12:00:00Z', now);
    expect(s).toBeCloseTo(0.5, 2);
  });
  it('a recent body match outranks a stale title match', () => {
    const recentBody = ilikeRecencyScore(false, '2026-07-14T12:00:00Z', now);
    const staleTitle = ilikeRecencyScore(true, '2026-01-01T00:00:00Z', now);
    expect(recentBody).toBeGreaterThan(staleTitle);
  });
  it('null / unparseable timestamps are penalized but never zero', () => {
    expect(ilikeRecencyScore(true, null, now)).toBeCloseTo(0.25, 5);
    expect(ilikeRecencyScore(true, 'not-a-date', now)).toBe(1.0);
  });
});

describe('normalizeScores — per-source scale independence', () => {
  it('scales the best hit to 1', () => {
    const out = normalizeScores([hit('a', '1', 4), hit('a', '2', 2)]);
    expect(out.map((h) => h.score)).toEqual([1, 0.5]);
  });
  it('an all-zero group stays zero instead of dividing by zero', () => {
    const out = normalizeScores([hit('a', '1', 0)]);
    expect(out[0].score).toBe(0);
  });
});

describe('mergeRankedHits — interleave, cap, dedupe', () => {
  it('rank-interleaves so one chatty source cannot monopolize the cap', () => {
    const chatty = Array.from({ length: 10 }, (_, i) => hit('chatty', String(i), 10 - i));
    const quiet = [hit('quiet', 'a', 0.9), hit('quiet', 'b', 0.5)];
    const merged = mergeRankedHits([chatty, quiet], 4);
    expect(merged).toHaveLength(4);
    // Rounds 0 and 1 each contain one hit from each source.
    expect(merged.slice(0, 2).map((h) => h.source).sort()).toEqual(['chatty', 'quiet']);
    expect(merged.slice(2, 4).map((h) => h.source).sort()).toEqual(['chatty', 'quiet']);
  });
  it('orders within a round by normalized score', () => {
    // quiet's best normalizes to 1 like chatty's best; second round: chatty 0.9 vs quiet 0.55.
    const chatty = [hit('chatty', '1', 100), hit('chatty', '2', 90)];
    const quiet = [hit('quiet', 'a', 20), hit('quiet', 'b', 11)];
    const merged = mergeRankedHits([chatty, quiet], 4);
    expect(merged[2].source).toBe('chatty'); // 0.9 beats 0.55 in round 1
    expect(merged[3].source).toBe('quiet');
  });
  it('dedupes identical source:id pairs, first occurrence wins', () => {
    const a = [hit('a', 'same', 1), hit('a', 'same', 0.4)];
    const merged = mergeRankedHits([a], 10);
    expect(merged).toHaveLength(1);
  });
  it('caps at limit and tolerates empty groups', () => {
    expect(mergeRankedHits([[], [hit('a', '1', 1)], []], 5)).toHaveLength(1);
    expect(mergeRankedHits([], 5)).toEqual([]);
  });
});

/** A mock adapter that records exactly what scope it was called with. */
class RecordingSource implements SearchSource {
  public calls: Array<{ userSub: string; query: string; limit: number; extras?: SearchCallerExtras }> = [];
  constructor(public readonly name: string, private readonly rows: SearchHit[] = []) {}
  async search(userSub: string, query: string, limit: number, extras?: SearchCallerExtras): Promise<SearchHit[]> {
    this.calls.push({ userSub, query, limit, extras });
    return this.rows;
  }
}

class ThrowingSource implements SearchSource {
  public readonly name = 'broken';
  async search(): Promise<SearchHit[]> { throw new Error('store down'); }
}

describe('GlobalSearchService — the isolation + fan-out contract', () => {
  const SUB = 'auth0|caller-123';

  it('hands EVERY adapter the caller sub verbatim (the scope handle)', async () => {
    const a = new RecordingSource('tickets');
    const b = new RecordingSource('chat');
    const svc = new GlobalSearchService([a, b]);
    await svc.search(SUB, 'hello', 10);
    expect(a.calls[0].userSub).toBe(SUB);
    expect(b.calls[0].userSub).toBe(SUB);
  });

  it('threads caller extras through to permission-aware adapters', async () => {
    const a = new RecordingSource('rag');
    const svc = new GlobalSearchService([a]);
    const extras: SearchCallerExtras = { email: 'x@y.z', isOperator: false, groups: ['tenant:t1'] };
    await svc.search(SUB, 'q', 5, undefined, extras);
    expect(a.calls[0].extras).toEqual(extras);
  });

  it('sources= filter runs ONLY the named adapters and reports unknown names', async () => {
    const a = new RecordingSource('tickets');
    const b = new RecordingSource('chat');
    const svc = new GlobalSearchService([a, b]);
    const res = await svc.search(SUB, 'q', 5, ['chat', 'NOPE ']);
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
    expect(res.unknownSources).toEqual(['nope']);
  });

  it('a throwing adapter degrades to empty; the others still answer', async () => {
    const good = new RecordingSource('tickets', [hit('tickets', 't1', 1)]);
    const svc = new GlobalSearchService([new ThrowingSource(), good]);
    const res = await svc.search(SUB, 'q', 5);
    expect(res.hits.map((h) => h.id)).toEqual(['t1']);
    expect(res.sourceCounts).toEqual({ broken: 0, tickets: 1 });
  });

  it('caps merged results at the requested limit and counts per source pre-cap', async () => {
    const a = new RecordingSource('a', [hit('a', '1', 3), hit('a', '2', 2), hit('a', '3', 1)]);
    const b = new RecordingSource('b', [hit('b', '1', 5), hit('b', '2', 4)]);
    const svc = new GlobalSearchService([a, b]);
    const res = await svc.search(SUB, 'q', 3);
    expect(res.hits).toHaveLength(3);
    expect(res.sourceCounts).toEqual({ a: 3, b: 2 });
  });
});
