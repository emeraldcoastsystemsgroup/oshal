/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Haven user model (ADR-079) pure logic: fact merge semantics (confidence/recency/supersede), hot-core rendering for prompt injection, decay, teach parsing, secret filtering, extraction JSON parsing, and proactive-suggestion computation. Pure functions only — the SQL layer stays thin and this stays unit-testable without a DB.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Extended suggestion kinds so ambient daily reviews can reuse the owner-scoped proposal inbox without creating reminders or tasks automatically.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added the 'connector-attention' suggestion kind so a derived connector signal (expiring token, broken connection) reaches the same owner-scoped inbox as every other suggestion. Its messages are computed in connector-signal-facts.ts from the caller's own connection rows, not from fact text, so nothing is inferred from a rendered string.
 */

/** The facets a user-model fact can belong to, in hot-core render priority order. */
export const FACET_ORDER = ['identity', 'rule', 'preference', 'goal', 'entity', 'signal'] as const;
export type UserModelFacet = (typeof FACET_ORDER)[number];

/** A single durable fact about the user. */
export interface UserModelFact {
  factId: string;
  userSub: string;
  facet: UserModelFacet;
  factKey: string;
  factValue: string;
  confidence: number;
  source: 'explicit-teach' | 'extraction' | 'signal';
  evidence?: string | null;
  timesSeen: number;
  active: boolean;
  firstSeen: Date;
  lastSeen: Date;
}

/** An incoming fact candidate (from teach, extraction, or a behavioral signal). */
export interface FactCandidate {
  facet: UserModelFacet;
  factKey: string;
  factValue: string;
  confidence: number;
  source: UserModelFact['source'];
  evidence?: string;
}

const MAX_VALUE_LENGTH = 400;
/** Credential-shaped values must NEVER enter the model, whatever the extractor returns. */
// Word-bounded + realistic-length shapes so ordinary words ("risk-tolerance") never false-positive.
const SECRET_SHAPES = /(\bsk-[a-z0-9]{16,}|\bghp_[a-z0-9]{16,}|\bgho_[a-z0-9]{16,}|\bxox[bap]-[a-z0-9-]{10,}|\bAKIA[A-Z0-9]{12,}|-----BEGIN|password\s*[:=]|api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]{20,})/i;

function clamp01(value: number): number {
  return Math.min(0.99, Math.max(0.05, Number.isFinite(value) ? value : 0.5));
}

/**
 * @description Whether a candidate fact is safe and meaningful to store: non-empty, bounded,
 * a known facet, and not credential-shaped. Fail-closed — reject anything doubtful.
 * @param candidate - The incoming fact candidate.
 * @returns true when the candidate may be merged into the model.
 */
export function isStorableFact(candidate: FactCandidate): boolean {
  if (!candidate.factKey?.trim() || !candidate.factValue?.trim()) return false;
  if (candidate.factValue.length > MAX_VALUE_LENGTH || candidate.factKey.length > 120) return false;
  if (!FACET_ORDER.includes(candidate.facet)) return false;
  if (SECRET_SHAPES.test(candidate.factValue) || SECRET_SHAPES.test(candidate.factKey)) return false;
  return true;
}

/**
 * @description Merge an incoming candidate with the existing fact under the same
 * (userSub, facet, factKey). Same value reinforces (times_seen + confidence bump); a different
 * value supersedes it (value replaced, confidence tempered by the disagreement, times_seen reset).
 * @param existing - The stored fact, or null when this key is new.
 * @param incoming - The incoming candidate (already validated by isStorableFact).
 * @param now - The merge timestamp.
 * @returns The fields to persist for the upsert.
 */
export function mergeFactUpdate(
  existing: Pick<UserModelFact, 'factValue' | 'confidence' | 'timesSeen'> | null,
  incoming: FactCandidate,
  now: Date,
): { factValue: string; confidence: number; timesSeen: number; lastSeen: Date; active: true } {
  const incomingConfidence = clamp01(incoming.source === 'explicit-teach' ? Math.max(incoming.confidence, 0.95) : incoming.confidence);
  if (!existing) {
    return { factValue: incoming.factValue.trim(), confidence: incomingConfidence, timesSeen: 1, lastSeen: now, active: true };
  }
  const sameValue = existing.factValue.trim().toLowerCase() === incoming.factValue.trim().toLowerCase();
  if (sameValue) {
    return {
      factValue: existing.factValue,
      confidence: clamp01(Math.max(existing.confidence, incomingConfidence) + 0.05),
      timesSeen: existing.timesSeen + 1,
      lastSeen: now,
      active: true,
    };
  }
  // Contradiction: the new value wins (it is fresher), but the disagreement tempers confidence.
  return {
    factValue: incoming.factValue.trim(),
    confidence: clamp01(Math.max(incomingConfidence, existing.confidence * 0.5)),
    timesSeen: 1,
    lastSeen: now,
    active: true,
  };
}

/**
 * @description Time-decay a fact's confidence: untouched facts fade so the model stays current.
 * Facts idle <= 30 days keep their confidence; beyond that it decays ~3%/idle-day. Below 0.25
 * the fact deactivates (kept for history, no longer injected).
 * @param fact - The stored fact.
 * @param now - The sweep timestamp.
 * @returns The decayed confidence and whether the fact stays active.
 */
export function decayFact(fact: Pick<UserModelFact, 'confidence' | 'lastSeen'>, now: Date): { confidence: number; active: boolean } {
  const idleDays = Math.max(0, (now.getTime() - fact.lastSeen.getTime()) / 86_400_000);
  if (idleDays <= 30) return { confidence: fact.confidence, active: fact.confidence >= 0.25 };
  const decayed = fact.confidence * Math.pow(0.97, idleDays - 30);
  return { confidence: Math.max(0.01, decayed), active: decayed >= 0.25 };
}

/**
 * @description Render the "hot core" — the compact block injected into every Jarvis/Haven turn.
 * Groups by facet priority, orders by confidence then recency, and caps size so prompt overhead
 * stays bounded (the ADR-030 "persona wraps every call" cost concern).
 * @param facts - The user's active facts.
 * @param maxFacts - Maximum facts to include (default 12).
 * @param maxChars - Hard character budget for the rendered block (default 900).
 * @returns The injection block, or '' when the model is empty.
 */
export function renderHotCore(facts: UserModelFact[], maxFacts = 12, maxChars = 900): string {
  const active = facts.filter((f) => f.active);
  if (active.length === 0) return '';
  const ranked = [...active].sort((a, b) => {
    const facetDelta = FACET_ORDER.indexOf(a.facet) - FACET_ORDER.indexOf(b.facet);
    if (facetDelta !== 0) return facetDelta;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.lastSeen.getTime() - a.lastSeen.getTime();
  }).slice(0, maxFacts);
  const lines: string[] = ['[What you know about this user — apply silently; never recite this list back]'];
  for (const fact of ranked) {
    const line = `- (${fact.facet}) ${fact.factKey}: ${fact.factValue}`;
    if (lines.join('\n').length + line.length + 1 > maxChars) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * @description Turn an explicit teach message into a high-confidence fact. "always/never ..."
 * becomes a rule; "call me X" identity; "i prefer/like ..." a preference; anything else a rule
 * verbatim — the user said "remember this", so we keep their words.
 * @param text - The user's teach text.
 * @returns The candidate, or null when the text is empty/unsafe.
 */
export function parseTeach(text: string): FactCandidate | null {
  const trimmed = (text || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  let candidate: FactCandidate;
  const callMe = lower.match(/^call me (.{1,80})$/);
  if (callMe) {
    candidate = { facet: 'identity', factKey: 'preferred-name', factValue: trimmed.slice(8).trim(), confidence: 0.95, source: 'explicit-teach' };
  } else if (/^(always|never)\b/.test(lower)) {
    candidate = { facet: 'rule', factKey: keyFrom(trimmed), factValue: trimmed, confidence: 0.95, source: 'explicit-teach' };
  } else if (/^i (prefer|like|want|hate|don'?t like)\b/.test(lower)) {
    candidate = { facet: 'preference', factKey: keyFrom(trimmed), factValue: trimmed, confidence: 0.95, source: 'explicit-teach' };
  } else {
    candidate = { facet: 'rule', factKey: keyFrom(trimmed), factValue: trimmed, confidence: 0.95, source: 'explicit-teach' };
  }
  return isStorableFact(candidate) ? candidate : null;
}

/** Stable slug key from a phrase so re-teaching the same thing upserts instead of duplicating. */
function keyFrom(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'note';
}

/**
 * @description Defensively parse the extraction step's raw LLM text into fact candidates.
 * Accepts a JSON array (possibly fenced); anything malformed yields []. Caps at 4 candidates
 * per exchange and drops unstorable ones — the learner must never throw or flood the model.
 * @param raw - The raw model output from the extraction prompt.
 * @returns Valid, storable candidates (possibly empty).
 */
export function parseExtraction(raw: string): FactCandidate[] {
  const start = (raw || '').indexOf('[');
  const end = (raw || '').lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: FactCandidate[] = [];
  for (const item of parsed.slice(0, 4)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const candidate: FactCandidate = {
      facet: String(rec.facet || '') as UserModelFacet,
      factKey: keyFrom(String(rec.key ?? rec.factKey ?? '')),
      factValue: String(rec.value ?? rec.factValue ?? '').trim(),
      confidence: clamp01(Number(rec.confidence ?? 0.6)),
      source: 'extraction',
      evidence: typeof rec.evidence === 'string' ? rec.evidence.slice(0, 200) : undefined,
    };
    if (isStorableFact(candidate)) out.push(candidate);
  }
  return out;
}

/**
 * A proactive suggestion Haven surfaces when the user arrives — and, for the subset listed in
 * PUSHABLE_SUGGESTION_KINDS, may push outward once the user has explicitly opted in.
 */
export interface SuggestionCandidate {
  kind:
    | 'stale-goal'
    | 'teach-nudge'
    | 'ambient-reminder'
    | 'ambient-task'
    | 'ambient-follow-up'
    /** A connected account expiring or broken (derived from the owner's own connection rows). */
    | 'connector-attention';
  message: string;
}

/**
 * @description Compute proactive suggestions from the model (pure; the sweep persists + dedupes).
 * v1 signals: goals untouched > 7 days ("still working on X?") and a one-time teach nudge when
 * the user has facts but no explicit rules yet. Pull-based proactivity — surfaced when the user
 * opens Jarvis, never pushed outward (no unapproved outbound sends).
 * @param facts - The user's active facts.
 * @param now - The sweep timestamp.
 * @returns Suggestion candidates (possibly empty).
 */
export function computeSuggestions(facts: UserModelFact[], now: Date): SuggestionCandidate[] {
  const active = facts.filter((f) => f.active);
  const out: SuggestionCandidate[] = [];
  for (const goal of active.filter((f) => f.facet === 'goal')) {
    const idleDays = (now.getTime() - goal.lastSeen.getTime()) / 86_400_000;
    if (idleDays > 7) {
      out.push({ kind: 'stale-goal', message: `You mentioned "${goal.factValue}" a while back — still working on it? Tell me and I'll pick it back up.` });
    }
  }
  if (active.length >= 3 && !active.some((f) => f.facet === 'rule' && f.source === 'explicit-teach')) {
    out.push({ kind: 'teach-nudge', message: 'You can teach me standing rules — say something like "always keep answers short" and I\'ll apply it everywhere.' });
  }
  return out.slice(0, 3);
}

/**
 * @description Build the strict-JSON extraction prompt for the learn step.
 * @param userMessage - The user's message this exchange.
 * @param answer - The assistant's final answer.
 * @returns The extraction prompt.
 */
export function buildExtractionPrompt(userMessage: string, answer: string): string {
  return [
    'You maintain a durable user model. From this exchange, extract ONLY lasting facts about the USER',
    '(identity, preferences, goals, entities they care about, standing rules). NOT session trivia, NOT',
    'facts about the world, NEVER credentials/tokens/keys. Return a JSON array (max 4), each item:',
    '{"facet":"identity|preference|goal|entity|rule","key":"short-slug","value":"the fact","confidence":0.0-1.0,"evidence":"short quote"}.',
    'Return [] if nothing durable was revealed. JSON only — no prose.',
    '',
    `USER: ${userMessage.slice(0, 2000)}`,
    `ASSISTANT: ${answer.slice(0, 2000)}`,
  ].join('\n');
}
