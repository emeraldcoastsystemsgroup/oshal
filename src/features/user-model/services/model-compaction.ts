/**
 * Haven cross-session model compaction (ADR-079 "Deferred: cross-session model summarization
 * compaction").
 *
 * The learning loop only ever ADDS. Decay fades an untouched fact ~3%/idle-day past 30 days, which
 * bounds a fact's *confidence* but not the model's *size*: a heavy user accumulates hundreds of
 * still-active low-value facts, every one of them competing for the 12-slot / 900-char hot core.
 * The symptom is not a crash — it is the model quietly getting worse, because a stale entity fact
 * from two months ago outranks a preference stated last week.
 *
 * Compaction is the size bound. It is **deterministic and LLM-free** (the controller never calls a
 * model — CLAUDE.md), and it **deactivates, never deletes**: a compacted fact still appears in
 * `GET /api/user-model` (which reads `activeOnly=false`), its evidence still lives in the owner-ACL'd
 * `user-model` RAG collection that `buildHavenPreamble` searches, and re-mentioning it reactivates it
 * through the ordinary merge path. Nothing the user taught is ever compacted away: explicit teaches
 * and identity facts are protected outright.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: factRetentionScore (confidence × recency half-life × reinforcement), protection rules for explicit-teach/identity facts, and planModelCompaction — a deterministic, stable-ordered retire list that bounds the active model without deleting anything.
 *
 * @module features/user-model/services/model-compaction
 */

import type { UserModelFact } from './user-model-logic';

/** Active-fact ceiling before compaction retires the weakest tail. */
export const DEFAULT_MAX_ACTIVE_FACTS = 60;

/** Days after which an untouched fact's retention score has halved. */
const RECENCY_HALF_LIFE_DAYS = 45;

/** What compaction decided, so the caller can apply it and log honestly. */
export interface CompactionPlan {
  /** Fact ids to deactivate, weakest first. Empty when the model is already inside its bound. */
  retire: string[];
  /** How many facts stay active after applying the plan. */
  keptActive: number;
  /** How many active facts were protected from compaction outright. */
  protectedCount: number;
}

/**
 * @description Whether a fact is exempt from compaction. Two exemptions, both deliberate: anything
 * the user EXPLICITLY taught (they said "remember this" — losing it is a broken promise), and
 * identity facts (a preferred name is small, permanent, and the most visible thing Haven can get
 * wrong). Everything else is compactable.
 * @param fact - The stored fact.
 * @returns true when compaction must leave this fact active.
 */
export function isCompactionProtected(fact: Pick<UserModelFact, 'source' | 'facet'>): boolean {
  return fact.source === 'explicit-teach' || fact.facet === 'identity';
}

/**
 * @description Score a fact's worth keeping hot: confidence, halved every
 * {@link RECENCY_HALF_LIFE_DAYS} of idleness, lifted by how often it has been reinforced. Pure and
 * deterministic so the same model always compacts the same way.
 * @param fact - The stored fact.
 * @param now - The evaluation instant.
 * @returns A non-negative score; higher survives.
 */
export function factRetentionScore(
  fact: Pick<UserModelFact, 'confidence' | 'lastSeen' | 'timesSeen'>,
  now: Date,
): number {
  const idleDays = Math.max(0, (now.getTime() - fact.lastSeen.getTime()) / 86_400_000);
  const recency = Math.pow(0.5, idleDays / RECENCY_HALF_LIFE_DAYS);
  const reinforcement = 1 + Math.log1p(Math.max(0, fact.timesSeen - 1));
  return Math.max(0, fact.confidence) * recency * reinforcement;
}

/**
 * @description Plan a compaction: keep every protected fact, then keep the highest-scoring
 * compactable facts up to the ceiling and retire the rest. Stable — ties break on fact id, so two
 * runs over the same model produce the same plan. Returns an empty retire list when the model
 * already fits, so a small model costs nothing.
 * @param facts - The user's facts (inactive ones are ignored; they are already compacted).
 * @param now - The evaluation instant.
 * @param maxActive - The active-fact ceiling (default {@link DEFAULT_MAX_ACTIVE_FACTS}).
 * @returns The retire list plus the resulting counts.
 */
export function planModelCompaction(
  facts: UserModelFact[],
  now: Date,
  maxActive: number = DEFAULT_MAX_ACTIVE_FACTS,
): CompactionPlan {
  const ceiling = Math.max(1, Math.floor(maxActive));
  const active = facts.filter((fact) => fact.active);
  const protectedFacts = active.filter(isCompactionProtected);
  const compactable = active.filter((fact) => !isCompactionProtected(fact));

  // Protected facts consume the budget first — they cannot be retired, so the compactable tail is
  // measured against whatever room is left (never negative).
  const room = Math.max(0, ceiling - protectedFacts.length);
  if (compactable.length <= room) {
    return { retire: [], keptActive: active.length, protectedCount: protectedFacts.length };
  }

  const ranked = [...compactable].sort((a, b) => {
    const delta = factRetentionScore(b, now) - factRetentionScore(a, now);
    if (delta !== 0) return delta;
    return a.factId.localeCompare(b.factId);
  });
  // Weakest first so the caller's log and any bounded per-run cap retire the least valuable first.
  const retire = ranked.slice(room).reverse().map((fact) => fact.factId);
  return {
    retire,
    keptActive: protectedFacts.length + room,
    protectedCount: protectedFacts.length,
  };
}
