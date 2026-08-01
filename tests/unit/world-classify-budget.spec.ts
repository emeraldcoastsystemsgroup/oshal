/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the world classify re-enable (2026-06-29 burn class): the pure budget's window arithmetic, its fail-closed cap handling, AND the analyzeBatch wiring — a counting fake provider proves a capped budget stops real provider CALLS (not source substrings) while every denied item still gets a lexicon-shaped result.
 */

import { describe, it, expect } from 'vitest';
import { createClassifyBudget } from '../../src/features/world-data/classify-budget';
import { analyzeBatch, type ClassifyProvider } from '../../src/features/world-data/news-fetcher';
import type { FeedItem } from '../../src/features/world-data/news-fetcher';

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('classify-budget window arithmetic', () => {
  it('grants up to the hour cap, then denies until the hour window rolls', () => {
    let t = 10 * DAY; // deterministic epoch, aligned to a window edge
    const b = createClassifyBudget({ perHour: 2, perDay: 100, now: () => t });
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false); // third call this hour → denied
    expect(b.snapshot()).toMatchObject({ hourUsed: 2, dayUsed: 2, denied: 1 });
    t += HOUR; // top of the next hour → hour counter resets, day counter keeps counting
    expect(b.tryTake()).toBe(true);
    expect(b.snapshot()).toMatchObject({ hourUsed: 1, dayUsed: 3, denied: 0 });
  });

  it('the day cap holds across hour rolls and releases on the next day', () => {
    let t = 20 * DAY;
    const b = createClassifyBudget({ perHour: 100, perDay: 3, now: () => t });
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    t += HOUR; // fresh hour budget — but the day is spent
    expect(b.tryTake()).toBe(false);
    expect(b.snapshot()).toMatchObject({ hourUsed: 0, dayUsed: 3, denied: 1 });
    t += DAY; // next day → everything resets
    expect(b.tryTake()).toBe(true);
  });

  it('fails CLOSED on bad caps: explicit zero, negatives, and NaN all mean no LLM', () => {
    for (const bad of [0, -5, Number.NaN]) {
      const b = createClassifyBudget({ perHour: bad, perDay: 100, now: () => 0 });
      expect(b.tryTake()).toBe(false);
    }
  });
});

// ── analyzeBatch wiring — the part a source-grep guard cannot prove ─────────────────────────────

/** Enough items for three chunks at the default chunk size of 10. */
const items = (n: number): FeedItem[] => Array.from({ length: n }, (_, i) => ({
  title: `Item ${i}`, description: 'A test description.', outlet: 'Test Wire', link: '', pubDate: '',
}));

/** A provider whose only job is to count how many LLM calls actually happen. */
function countingProvider(): { provider: ClassifyProvider; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    provider: {
      name: 'fake',
      complete: async () => {
        n += 1;
        return { text: JSON.stringify([{ i: 0, s: 0.5, e: [{ n: 'NVIDIA', t: 'org' }], ev: { t: 'earnings', i: 0.9 } }]) };
      },
    },
  };
}

describe('analyzeBatch consumes the global budget per chunk', () => {
  it('a capped budget stops provider calls; denied chunks still return lexicon-shaped results', async () => {
    const { provider, calls } = countingProvider();
    const budget = createClassifyBudget({ perHour: 2, perDay: 100, now: () => 0 });
    const out = await analyzeBatch(items(25), 'NVIDIA', { providers: [provider], budget });
    expect(calls()).toBe(2);            // 3 chunks, budget 2 → exactly two real LLM calls
    expect(out).toHaveLength(25);       // every item answered — the denied chunk fell back
    expect(out[0].s).toBe(0.5);         // first chunk carried the classified row
    expect(out[24]).toEqual({ s: null, entities: [], event: null }); // denied tail = lexicon shape
  });

  it('an exhausted budget means ZERO provider calls — including the single-chunk fast path', async () => {
    const { provider, calls } = countingProvider();
    const budget = createClassifyBudget({ perHour: 0, perDay: 0, now: () => 0 });
    const out = await analyzeBatch(items(5), 'NVIDIA', { providers: [provider], budget });
    expect(calls()).toBe(0);
    expect(out).toHaveLength(5);
    expect(out.every((r) => r.s === null && r.entities.length === 0 && r.event === null)).toBe(true);
  });
});
