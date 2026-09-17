/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. Child process for the ADR-100 related-hit relevance-floor guard. It runs the REAL relatedRecall against the REAL MiniLM on the ADR-100 live-proof corpus, because the defect lives in the embedding distances themselves — a doubled embedder can be made to rank anything and proves nothing about whether "Can we order pizza tonight" is far enough from "volleyball". Only the two collaborators OUTSIDE that boundary are doubled: the Postgres pool (three reads, all scoping) and the retrieval leg, which is replayed at the exact reciprocal-rank scores the 2026-09-12 live proof observed. Runs the same recall twice — once with the floor disarmed (PERSON_MODEL_RELATED_SIMILARITY_FLOOR=0, reproducing the unfloored list) and once with the configured floor — so the spec compares the defect and the fix from one model load.
 */

import { RagService, type RagSearchResult } from '@/features/rag';
import { pgvectorRagEngine } from '@/features/rag';
import { relatedRecall, relatedSimilarityFloor, scoreAgainstQuery, type RecallIntent, type RelatedReceipt } from '@/features/person-model';

const OWNER = 'relevance-guard-owner';
const PROFILE = '11111111-2222-3333-4444-555555555555';
const CAPTURED = '2026-09-12T18:00:00.000Z';

/**
 * The ADR-100 live-proof corpus, in the order and at the fused scores the deployed engine
 * returned on 2026-09-12: reciprocal-rank fusion over a four-chunk store, where every chunk
 * places because the store holds fewer chunks than the fetch bound. 1/60 down to 1/63 — the
 * "flat score" the backlog entry describes. The first line is the exact-leg receipt and is
 * excluded by the caller, exactly as the route does.
 */
const CORPUS: ReadonlyArray<{ segmentId: string; text: string; score: number }> = [
  { segmentId: 'live-0', text: 'Volleyball practice got moved to Thursday this week', score: 1 / 60 },
  { segmentId: 'live-1', text: 'Coach says the net sport tournament is on Saturday morning', score: 1 / 61 },
  { segmentId: 'live-2', text: 'I need new knee pads before the next match', score: 1 / 62 },
  { segmentId: 'live-3', text: 'Can we order pizza tonight', score: 1 / 63 },
];

/** Emits one JSON line on fd 1 that the spec parses. */
function report(stage: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ probe: stage, ...extra })}\n`);
}

/**
 * @description The three reads relatedRecall makes before it reaches the relevance decision:
 * the rag_chunks presence probe, the spoken-name resolution, and the owner's time zone. None
 * is the boundary under test, so each answers from the fixture rather than from a database.
 * @returns A pool-shaped object with just the `query` method relatedRecall calls.
 */
function fixturePool(): { query: (sql: string) => Promise<{ rows: unknown[] }> } {
  return {
    query: async (sql: string) => {
      if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
      if (sql.includes('FROM ambient_speaker_profiles')) return { rows: [{ profile_id: PROFILE, label: 'Ella' }] };
      if (sql.includes('FROM ambient_user_settings')) return { rows: [{ time_zone: 'UTC' }] };
      throw new Error(`fixturePool: unexpected query ${sql.slice(0, 60)}`);
    },
  };
}

/** Replays the deployed retrieval leg's hits — rank order, fused scores, owner-stamped metadata. */
function installRetrievalDouble(): void {
  const hits: RagSearchResult[] = CORPUS.map((row) => ({
    id: `pm:${row.segmentId}`,
    text: row.text,
    metadata: { owner_sub: OWNER, profile_id: PROFILE, segment_id: row.segmentId, captured_at: CAPTURED, doc_id: `pm:${row.segmentId}` },
    score: row.score,
    collection: 'ambient-recall',
  }));
  RagService.prototype.search = async (): Promise<RagSearchResult[]> => hits.map((hit) => ({ ...hit }));
  pgvectorRagEngine.isAvailable = async (): Promise<boolean> => true;
}

/** @returns The related list for one floor setting, as the route would publish it. */
async function recallWithFloor(floor: string): Promise<RelatedReceipt[]> {
  process.env.PERSON_MODEL_RELATED_SIMILARITY_FLOOR = floor;
  const intent: RecallIntent = { personName: 'Ella', terms: 'volleyball', range: 'all', wantsPlayback: false };
  return relatedRecall(fixturePool() as never, OWNER, intent, new Set(['live-0']));
}

/** Strips a receipt to what the spec asserts on. */
const shape = (r: RelatedReceipt): Record<string, unknown> => ({
  segmentId: r.segmentId, quote: r.quote, score: r.score, similarity: r.similarity,
});

async function main(): Promise<void> {
  process.env.RAG_ENGINE = 'pgvector';
  installRetrievalDouble();

  // The floor disarmed: the unfloored list the live proof published, with its real distances.
  const unfloored = await recallWithFloor('0');
  report('unfloored', { floor: 0, related: unfloored.map(shape) });

  // The configured floor, read through the same code the api runs.
  process.env.PERSON_MODEL_RELATED_SIMILARITY_FLOOR = '';
  const floor = relatedSimilarityFloor();
  const floored = await recallWithFloor('');
  report('floored', { floor, related: floored.map(shape) });

  // A floor is only meaningful if it also rejects lines with no relationship at all, so the
  // same model scores a control set that was never part of the tuning corpus. Their raw
  // distances are reported alongside, because several are NEGATIVE and a floor of 0 would
  // already have dropped them — the spec must see the numbers, not an emptied list.
  const controlTexts = [
    'The car needs an oil change',
    'I have a dentist appointment on Tuesday',
    'We should book the flight soon',
    'Remind me to renew the passport',
  ];
  RagService.prototype.search = async (): Promise<RagSearchResult[]> => controlTexts.map((text, i) => ({
    id: `pm:ctl-${i}`, text,
    metadata: { owner_sub: OWNER, profile_id: PROFILE, segment_id: `ctl-${i}`, captured_at: CAPTURED, doc_id: `pm:ctl-${i}` },
    score: 1 / (60 + i), collection: 'ambient-recall',
  }));
  process.env.PERSON_MODEL_RELATED_SIMILARITY_FLOOR = '';
  const controlFloored = await recallWithFloor('');
  report('control', {
    texts: controlTexts,
    similarities: await scoreAgainstQuery('volleyball', controlTexts),
    floored: controlFloored.map(shape),
  });

  report('done');
}

main().catch((err) => {
  report('failed', { error: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
