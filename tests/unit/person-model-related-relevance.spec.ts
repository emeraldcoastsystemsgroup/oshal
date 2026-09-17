/**
 * Guard for the ADR-100 "possibly related" relevance floor.
 *
 * The retrieval leg fuses its vector and lexical halves by RECIPROCAL RANK, so a hit's
 * fused score records where it placed, not how close it is — and when the store holds
 * fewer chunks than the fetch bound, every chunk places. The 2026-09-12 live proof
 * published "Can we order pizza tonight" as possibly related to "volleyball" at 1/63,
 * against 1/61 for a real paraphrase: indistinguishable, and the list read as noise.
 *
 * The boundary that failed is the embedding distance itself, so the cases that matter run
 * the REAL relatedRecall against the REAL all-MiniLM-L6-v2 in a child process (the model is
 * an ESM-only dynamic import that cannot resolve under vitest's CJS transform — the same
 * reason tests/unit/onnx-global-rethrow-handlers.spec.ts uses a tsx child). Doubling the
 * embedder here would prove nothing: a stub can be made to rank anything.
 *
 * Two collaborators OUTSIDE that boundary are doubled and recorded in
 * docs/governance/real-boundary-regression-audit.md — the Postgres pool (three scoping
 * reads) and the retrieval leg, replayed at the exact fused scores the live proof observed.
 *
 * The no-fix control is the same recall with the floor disarmed (floor 0). It is
 * load-bearing: if it ever stops containing the pizza line, either the corpus or the model
 * has moved and this guard has become vacuous, which must fail loudly rather than pass.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the real-model child (live-proof corpus floored and unfloored, plus an unrelated control set that was never part of the tuning corpus), and the in-process cases for the floor's configuration reading and cosine arithmetic.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_RELATED_SIMILARITY_FLOOR, cosineSimilarity, relatedSimilarityFloor,
} from '@/features/person-model';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHILD = path.join('tests', 'fixtures', 'ambient-relevance-child.ts');
/** First run pays the model load; a hang is a failure, not a pass. */
const CHILD_TIMEOUT_MS = 300_000;

interface Receipt { segmentId: string; quote: string; score: number; similarity: number }
interface Probes {
  unfloored?: { floor: number; related: Receipt[] };
  floored?: { floor: number; related: Receipt[] };
  control?: { texts: string[]; similarities: number[]; floored: Receipt[] };
  done?: unknown;
  failed?: { error: string };
}

let probes: Probes;
let childStderr: string;

/**
 * @description Runs the child fixture under tsx and parses its JSON probe lines.
 * @returns The probe lines keyed by stage, plus the head of stderr for failure messages.
 */
function runChild(): { probes: Probes; stderrHead: string } {
  const env = { ...process.env };
  // vitest's own NODE_OPTIONS must not leak into a plain tsx child.
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.PERSON_MODEL_RELATED_SIMILARITY_FLOOR;
  const run = spawnSync(process.execPath, [require.resolve('tsx/cli'), CHILD], {
    cwd: REPO_ROOT, env, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
  });
  const parsed: Probes = {};
  for (const line of (run.stdout || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const probe = JSON.parse(line);
      if (probe.probe) (parsed as Record<string, unknown>)[probe.probe] = probe;
    } catch {
      // Non-probe stdout (the pino logger's own output) is not an error.
    }
  }
  return { probes: parsed, stderrHead: (run.stderr || '').slice(0, 800) };
}

const quotes = (rows: Receipt[]): string[] => rows.map((r) => r.quote);
const pizzaLine = (rows: Receipt[]): Receipt | undefined => rows.find((r) => /pizza/.test(r.quote));

describe('the related leg on the real embedding model (live-proof corpus)', () => {
  beforeAll(() => {
    const run = runChild();
    probes = run.probes;
    childStderr = run.stderrHead;
  }, CHILD_TIMEOUT_MS);

  it('ran the real model to completion', () => {
    expect(probes.failed?.error, childStderr).toBeUndefined();
    expect(probes.done, `child produced no probes; stderr: ${childStderr}`).toBeDefined();
  });

  it('WITHOUT the floor: the off-topic line is published, at a score indistinguishable from a real paraphrase', () => {
    const rows = probes.unfloored!.related;
    expect(quotes(rows)).toHaveLength(3);
    const noise = pizzaLine(rows);
    expect(noise, 'the unfloored list no longer reproduces the defect — this guard is now vacuous and must be re-derived').toBeDefined();
    // The fused scores carry no distance: 1/61 .. 1/63 across a real paraphrase and pure noise.
    const fused = rows.map((r) => r.score);
    expect(Math.max(...fused) - Math.min(...fused)).toBeLessThan(0.001);
    // The distances do carry it, which is the whole point of measuring them.
    const paraphrase = rows.find((r) => /net sport/.test(r.quote))!;
    expect(noise!.similarity).toBeLessThan(paraphrase.similarity);
  });

  it('WITH the floor: both volleyball paraphrases survive and the off-topic line is dropped', () => {
    const { floor, related } = probes.floored!;
    expect(floor).toBe(DEFAULT_RELATED_SIMILARITY_FLOOR);
    expect(pizzaLine(related), 'the off-topic line must not be published as possibly related').toBeUndefined();
    expect(related.some((r) => /net sport/.test(r.quote)), 'the "net sport" paraphrase must survive').toBe(true);
    expect(related.some((r) => /knee pads/.test(r.quote)), 'the "knee pads" paraphrase must survive').toBe(true);
    expect(related).toHaveLength(2);
    // Every survivor cleared the floor, and the noise did not — stated as measurements so a
    // model or corpus change fails with the numbers rather than with "expected 2, got 3".
    for (const row of related) expect(row.similarity).toBeGreaterThanOrEqual(floor);
    expect(pizzaLine(probes.unfloored!.related)!.similarity).toBeLessThan(floor);
  });

  it('orders survivors by measured similarity, not by the fused rank', () => {
    const related = probes.floored!.related;
    // Every published hit carries its measured distance — without it "ordered by similarity"
    // is a claim about undefined, and the sort below would pass on any list at all.
    for (const row of related) expect(Number.isFinite(row.similarity), `${row.quote} has no similarity`).toBe(true);
    const bySimilarity = [...related].sort((a, b) => b.similarity - a.similarity).map((r) => r.segmentId);
    expect(related.map((r) => r.segmentId)).toEqual(bySimilarity);
    // The fused rank agreed here by coincidence; the ordering key must be the distance.
    expect(related[0].similarity).toBeGreaterThan(related[related.length - 1].similarity);
  });

  it('rejects lines with no relationship to the query at all (control set, not part of the tuning corpus)', () => {
    const { texts, similarities, floored } = probes.control!;
    // All four are retrievable and rank-ordered exactly like the real hits...
    expect(texts).toHaveLength(4);
    expect(similarities).toHaveLength(4);
    // ...every one of them measures below the floor on the real model...
    similarities.forEach((similarity, i) => {
      expect(similarity, texts[i]).toBeLessThan(DEFAULT_RELATED_SIMILARITY_FLOOR);
    });
    // ...so nothing at all is published as possibly related.
    expect(floored).toEqual([]);
  });
});

describe('relatedSimilarityFloor', () => {
  const withEnv = (value: string | undefined, run: () => void): void => {
    const previous = process.env.PERSON_MODEL_RELATED_SIMILARITY_FLOOR;
    if (value === undefined) delete process.env.PERSON_MODEL_RELATED_SIMILARITY_FLOOR;
    else process.env.PERSON_MODEL_RELATED_SIMILARITY_FLOOR = value;
    try { run(); } finally {
      if (previous === undefined) delete process.env.PERSON_MODEL_RELATED_SIMILARITY_FLOOR;
      else process.env.PERSON_MODEL_RELATED_SIMILARITY_FLOOR = previous;
    }
  };

  it('defaults when unset or blank', () => {
    withEnv(undefined, () => expect(relatedSimilarityFloor()).toBe(DEFAULT_RELATED_SIMILARITY_FLOOR));
    withEnv('   ', () => expect(relatedSimilarityFloor()).toBe(DEFAULT_RELATED_SIMILARITY_FLOOR));
  });

  it('honours a configured value in 0..1', () => {
    withEnv('0', () => expect(relatedSimilarityFloor()).toBe(0));
    withEnv('0.45', () => expect(relatedSimilarityFloor()).toBe(0.45));
    withEnv('1', () => expect(relatedSimilarityFloor()).toBe(1));
  });

  it('keeps the default for a value that would silently empty or silently unfloor the list', () => {
    // Above 1: no cosine can clear it, so every related list would go empty with no error.
    withEnv('1.5', () => expect(relatedSimilarityFloor()).toBe(DEFAULT_RELATED_SIMILARITY_FLOOR));
    // Below 0: the noise this floor removes would come straight back.
    withEnv('-1', () => expect(relatedSimilarityFloor()).toBe(DEFAULT_RELATED_SIMILARITY_FLOOR));
    withEnv('high', () => expect(relatedSimilarityFloor()).toBe(DEFAULT_RELATED_SIMILARITY_FLOOR));
    withEnv('NaN', () => expect(relatedSimilarityFloor()).toBe(DEFAULT_RELATED_SIMILARITY_FLOOR));
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 10);
  });

  it('divides out magnitude, so an un-normalised embedder cannot change what the floor means', () => {
    expect(cosineSimilarity([3, 4], [30, 40])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([0.6, 0.8], [3, 4])).toBeCloseTo(1, 10);
  });

  it('returns 0 rather than NaN for degenerate or mismatched input', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
