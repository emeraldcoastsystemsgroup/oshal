/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 1: shared types for ambient person-model recall (parsed intent, receipts, result).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phases 2-4: the person-model intent union (recall | asks | trend | connection) Jarvis answers without a model turn, the "possibly related" semantic receipt that is never folded into the exact count, trend/connection rows, and the heard-people / profile-summary shapes behind the profile surface.
 */

import type { PersonAsk } from './asks-query';
import type { PersonConsentStatus } from './consent-gate';

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
  /** Literal number of matching utterances — never widened by semantic search. */
  count: number;
  /** The matching lines (capped for the response), newest-relevant first. */
  receipts: RecallReceipt[];
  /** Mirror of the terms searched, for the phrasing layer. */
  terms: string;
  /** Mirror of the range searched. */
  range: RecallRange;
}

/**
 * A paraphrase hit from the semantic leg (Phase 3). Reported as "possibly related" beside the exact
 * receipts and NEVER counted — the answer-integrity rule of ADR-100 §4.
 */
export interface RelatedReceipt extends RecallReceipt {
  /** Engine similarity score (higher is closer); informational only. */
  score: number;
}

/** "what has Ella asked me", "what did Sam promise", "any open asks from Ella". */
export interface OpenAsksIntent {
  kind: 'asks';
  /** Person named (case-preserving); empty means every modeled voice. */
  personName: string;
  /** Which inference kinds the ask covers. */
  askKind: 'ask' | 'commitment' | 'any';
}

/** "what has Ella been talking about lately / this week / this month". */
export interface TrendIntent {
  kind: 'trend';
  personName: string;
  /** Window in weeks (1 = this week). */
  weeks: number;
}

/** "what do Ella and Sam talk about", "what connects Ella and Sam". */
export interface ConnectionIntent {
  kind: 'connection';
  personA: string;
  personB: string;
}

/** Every deterministic person-model question shape the Jarvis front door answers pre-model. */
export type PersonModelIntent = ({ kind: 'recall' } & RecallIntent) | OpenAsksIntent | TrendIntent | ConnectionIntent;

/** One week × topic cell of the trend rollup. */
export interface TopicTrendRow {
  /** ISO date of the Monday starting the week. */
  weekStart: string;
  topic: string;
  mentions: number;
  personLabel: string;
}

/** The trend read: resolved label plus rows, newest week first. */
export interface TopicTrendResult {
  personLabel: string | null;
  personResolved: boolean;
  weeks: number;
  rows: TopicTrendRow[];
}

/** A topic two people both mention, with the distinct days each raised it. */
export interface PersonConnection {
  topic: string;
  daysA: number;
  daysB: number;
  lastObservedOn: string;
}

/** One heard voice as listed on the People tab. */
export interface HeardPerson {
  profileId: string;
  label: string;
  isSelf: boolean;
  /** Transcript fact: attributed utterances on record. */
  utterances: number;
  firstHeardAt: string | null;
  lastHeardAt: string | null;
}

/** A rollup topic on a person's profile (OSHAL's read, not transcript fact). */
export interface PersonTopic {
  topic: string;
  mentions: number;
  lastOn: string;
}

/** Utterances per owner-local day (transcript fact). */
export interface PersonPresenceDay {
  localDate: string;
  utterances: number;
}

/** The profile page: identity + presence (facts) and topics/asks (inferences) + consent posture. */
export interface PersonProfileSummary extends HeardPerson {
  timeZone: string;
  topics: PersonTopic[];
  presence: PersonPresenceDay[];
  asks: PersonAsk[];
  consent: PersonConsentStatus | null;
}
