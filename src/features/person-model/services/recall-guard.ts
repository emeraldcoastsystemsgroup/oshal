/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 1: deterministic recall-intent matcher + receipts block. Matches "how many times has X mentioned Y today", "what did X say about Y", "play it back" BEFORE any model turn so counts are literal, and formats receipts for the Jarvis phrasing layer.
 */

import type { RecallIntent, RecallResult } from './person-model-types';

const SELF_NAMES = new Set(['me', 'myself', 'i']);

/** Filler words a person-name capture should never swallow. */
const STOP_TOKENS = new Set(['anyone', 'anybody', 'someone', 'somebody', 'everyone', 'people']);

/**
 * @description Deterministically detects an ambient-recall ask and extracts the person, topic terms,
 * range, and whether playback was requested. Returns null when the message is not a recall shape, so
 * ordinary chat falls through to the model untouched.
 * @param message - The raw user message.
 * @returns The parsed recall intent, or null.
 */
export function detectRecallIntent(message: string): RecallIntent | null {
  const text = String(message || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const wantsPlayback = /\b(play\s*(it|that)?\s*back|read\s*(it|them)\s*(back|to me)?|let me hear)\b/.test(lower);
  const range: RecallIntent['range'] = /\b(today|so far today|this morning|tonight|this evening)\b/.test(lower)
    ? 'today' : 'all';

  // Strip playback phrases, range words, and punctuation BEFORE matching so they never leak into the
  // captured topic. Matching runs on the case-preserving text so a name keeps its capitalization.
  const core = text
    .replace(/\b(and\s+)?(please\s+)?(play\s*(it|that)?\s*back|read\s*(it|them)\s*(back|to me)?|let me hear(\s+(it|them))?)\b/gi, ' ')
    .replace(/\b(so far today|this morning|this evening|tonight|today|so far)\b/gi, ' ')
    .replace(/[?.!,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Shape A: "how many times has|did <person> mention|say|talk about <topic>"
  const countMatch = core.match(
    /how many times (?:has|have|did)\s+(.+?)\s+(?:mentioned|mention|said|say|brought up|bring up|talked about|talk about)\s+(.+)$/i,
  );
  if (countMatch) return finalize(countMatch[1], countMatch[2], range, wantsPlayback);

  // Shape B: "what did|has <person> say|mention about <topic>"
  const whatMatch = core.match(
    /what (?:did|has|have)\s+(.+?)\s+(?:said|say|mentioned|mention|talked|talk)\s+about\s+(.+)$/i,
  );
  if (whatMatch) return finalize(whatMatch[1], whatMatch[2], range, wantsPlayback);

  return null;
}

/**
 * @description Normalizes a captured person + topic into a RecallIntent, mapping self-referential
 * names and stripping possessives/articles from the topic.
 */
function finalize(rawPerson: string, rawTopic: string, range: RecallIntent['range'], wantsPlayback: boolean): RecallIntent | null {
  const personName = normalizePerson(rawPerson);
  const terms = normalizeTopic(rawTopic);
  if (!personName && !terms) return null;
  return { personName, terms, range, wantsPlayback };
}

/** Trims a captured person phrase; blanks out "anyone"-style tokens (matches every voice). */
function normalizePerson(raw: string): string {
  const cleaned = raw.replace(/[^\p{L}\p{N}\s'-]/gu, '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';
  if (SELF_NAMES.has(cleaned.toLowerCase())) return 'me';
  if (STOP_TOKENS.has(cleaned.toLowerCase())) return '';
  return cleaned;
}

/** Strips leading articles and trailing punctuation from the topic phrase. */
function normalizeTopic(raw: string): string {
  return raw
    .replace(/^\s*(the|a|an|about|any|our|my|his|her|their)\s+/i, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * @description Formats a recall result into a receipts block for the Jarvis phrasing layer. Presents
 * the LITERAL count and quoted lines with timestamps — the model phrases around these facts, it does
 * not invent the number.
 * @param intent - The parsed intent (for the person label fallback and playback flag).
 * @param result - The literal recall result.
 * @returns A prepend block Jarvis renders into a natural answer.
 */
export function buildRecallReceiptsBlock(intent: RecallIntent, result: RecallResult): string {
  const who = result.personLabel || (intent.personName || 'anyone');
  const when = result.range === 'today' ? 'today' : 'on record';
  if (!result.personResolved) {
    return `AMBIENT RECALL (verified facts — do not invent):\n`
      + `No enrolled or named voice matches "${intent.personName}". Ask the user to name that person in Manage Voices first. `
      + `Do not guess a count.`;
  }
  const topic = result.terms ? ` about "${result.terms}"` : '';
  const lines = result.receipts
    .map((r) => `  - [${r.capturedAt}] "${r.quote}"`)
    .join('\n');
  const body = result.count === 0
    ? `${who} has not been heard${topic} ${when}.`
    : `${who} was heard${topic} ${result.count} time${result.count === 1 ? '' : 's'} ${when}:\n${lines}`;
  const playback = intent.wantsPlayback && result.count > 0
    ? `\nThe user asked to hear it — re-speak the quoted line(s) aloud in your own voice (no other person's voice is synthesized).`
    : '';
  return `AMBIENT RECALL (verified facts — state the count exactly, quote the lines, do not invent):\n${body}${playback}`;
}

/**
 * @description Formats a recall result into the FINAL user-facing answer, phrased directly (no model
 * turn). This is the deterministic path used by the Jarvis chat dispatch: the literal count and the
 * verbatim quotes, in Jarvis's plain voice, so the number is never a model estimate. The surface's
 * browser TTS reads this text back when playback was requested.
 * @param intent - The parsed recall intent (person + terms + range).
 * @param result - The literal recall result.
 * @returns A ready-to-send answer string.
 */
export function buildRecallSpokenAnswer(intent: RecallIntent, result: RecallResult): string {
  const who = result.personLabel || (intent.personName || 'anyone');
  const when = result.range === 'today' ? 'today' : 'on record';
  if (!result.personResolved) {
    return `I don't have a saved voice matching "${intent.personName}" yet. `
      + `Name that person under Manage Voices in the Jarvis panel and I'll be able to recall what they said.`;
  }
  const topic = result.terms ? ` about "${result.terms}"` : '';
  if (result.count === 0) {
    return `I haven't heard ${who}${topic} ${when}.`;
  }
  const lines = result.receipts.map((r) => `- "${r.quote}"`).join('\n');
  const header = `${who} was heard${topic} ${result.count} time${result.count === 1 ? '' : 's'} ${when}:`;
  return `${header}\n${lines}`;
}
