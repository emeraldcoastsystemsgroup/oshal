/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 2: pure enrichment prompt builder + taxonomy-validated JSON parser for the ambient-analyst bot. No LLM/DB — testable in isolation; the runtime supplies the brain and persistence.
 */

/** Closed tone taxonomy (ADR-100 §3 v1) — CHECK-constrained in the DB too. */
export const TONE_VALUES = ['neutral', 'warm', 'excited', 'frustrated', 'upset', 'urgent', 'humorous', 'tired'] as const;
/** Closed intent taxonomy (ADR-100 §3 v1). */
export const INTENT_VALUES = ['inform', 'question', 'ask_request', 'commit', 'plan', 'recall', 'vent', 'banter'] as const;
/** Taxonomy generation — bump when the closed sets change so a rebuild re-enriches. */
export const TAXONOMY_VERSION = 1;

export type Tone = (typeof TONE_VALUES)[number];
export type Intent = (typeof INTENT_VALUES)[number];

/** One utterance handed to the analyst. */
export interface EnrichmentInput {
  segmentId: string;
  text: string;
  speakerLabel?: string | null;
}

/** One validated per-utterance inference. */
export interface EnrichmentResult {
  segmentId: string;
  tone: Tone;
  intent: Intent;
  topics: string[];
  ask: string | null;
  commitment: string | null;
}

const MAX_TOPICS = 3;

/**
 * @description Builds the analyst prompt for a batch of utterances. The persona owns the output
 * contract; this only supplies the numbered lines to enrich.
 * @param batch - Utterances to enrich (bounded by the runtime).
 * @returns The prompt text.
 */
export function buildEnrichmentPrompt(batch: EnrichmentInput[]): string {
  const lines = batch.map((u) => JSON.stringify({ segmentId: u.segmentId, speaker: u.speakerLabel ?? 'unknown', text: u.text }));
  return [
    'Enrich each transcript line below into the JSON contract from your instructions.',
    'Return ONLY the JSON object { "enrichments": [ ... ] } with exactly one entry per line, keyed by segmentId.',
    '',
    'LINES:',
    ...lines,
  ].join('\n');
}

/**
 * @description Parses + validates the analyst reply against the closed taxonomy, keeping only
 * entries whose segmentId was actually requested. Invalid tone/intent or unknown ids are dropped,
 * never coerced — a partial-but-clean result beats a plausible-but-wrong one.
 * @param raw - The model reply text (may contain fences/prose around the JSON).
 * @param requested - The batch that was sent, for id validation.
 * @returns Validated results (subset of the batch).
 */
export function parseEnrichmentJson(raw: string, requested: EnrichmentInput[]): EnrichmentResult[] {
  const ids = new Set(requested.map((u) => u.segmentId));
  const obj = extractJsonObject(raw);
  const entries = Array.isArray((obj as { enrichments?: unknown })?.enrichments)
    ? (obj as { enrichments: unknown[] }).enrichments : [];
  const out: EnrichmentResult[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const result = validateEntry(e, ids, seen);
    if (result) { out.push(result); seen.add(result.segmentId); }
  }
  return out;
}

/** Validates a single raw entry into an EnrichmentResult, or null if malformed. */
function validateEntry(entry: unknown, ids: Set<string>, seen: Set<string>): EnrichmentResult | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const segmentId = typeof e.segmentId === 'string' ? e.segmentId : '';
  if (!ids.has(segmentId) || seen.has(segmentId)) return null;
  const tone = e.tone as Tone;
  const intent = e.intent as Intent;
  if (!TONE_VALUES.includes(tone) || !INTENT_VALUES.includes(intent)) return null;
  const topics = Array.isArray(e.topics)
    ? e.topics.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim().toLowerCase()).slice(0, MAX_TOPICS)
    : [];
  return {
    segmentId, tone, intent, topics,
    ask: intent === 'ask_request' ? cleanText(e.ask) : null,
    commitment: intent === 'commit' ? cleanText(e.commitment) : null,
  };
}

/** Coerces a possibly-present string field to a trimmed value or null. */
function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null;
}

/** Extracts the first balanced JSON object from a reply that may carry fences or prose. */
function extractJsonObject(raw: string): unknown {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
