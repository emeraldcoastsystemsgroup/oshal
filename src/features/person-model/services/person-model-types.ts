/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 1: shared types for ambient person-model recall (parsed intent, receipts, result).
 */

/** How far back a recall reaches. Phase 1 supports the owner's local "today" and the full window. */
export type RecallRange = 'today' | 'all';

/**
 * A deterministic recall intent parsed from a natural-language ask BEFORE any model turn, so counts
 * are never answered from model memory.
 */
export interface RecallIntent {
  /** The person named in the ask, verbatim (e.g. "Ella", "me"); empty means "anyone". */
  personName: string;
  /** Free-text search terms for the topic (e.g. "volleyball"); empty means "any utterance". */
  terms: string;
  /** Owner-local window. */
  range: RecallRange;
  /** Whether the ask requested playback ("play it back", "read it to me"). */
  wantsPlayback: boolean;
}

/** One quoted transcript line backing a recall answer. */
export interface RecallReceipt {
  segmentId: string;
  quote: string;
  capturedAt: string;
}

/** The result of a recall query: a literal count plus its receipts. */
export interface RecallResult {
  /** Resolved display label for the person, or null if the name did not match a known voice. */
  personLabel: string | null;
  /** Whether a matching person profile was found at all. */
  personResolved: boolean;
  /** Literal number of matching utterances — never widened by semantic search in Phase 1. */
  count: number;
  /** The matching lines (capped for the response), newest-relevant first. */
  receipts: RecallReceipt[];
  /** Mirror of the terms searched, for the phrasing layer. */
  terms: string;
  /** Mirror of the range searched. */
  range: RecallRange;
}
