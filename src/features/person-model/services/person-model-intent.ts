/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 2/3: one deterministic front door for every person-model question Jarvis answers without a model turn — recall (Phase 1 shapes, unchanged), open asks ("what has Ella asked me", "what did Sam promise"), weekly trends ("what has Ella been talking about lately") and connections ("what do Ella and Sam talk about"). The matcher runs BEFORE any model turn; the answerer reads SQL and phrases the literal result, flagging asks/topics as OSHAL's read beside the verbatim quote.
 */

import type { Pool } from 'pg';
import { detectRecallIntent, buildRecallSpokenAnswer } from './recall-guard';
import { recallQuery } from './recall-query';
import { getOpenAsks, type PersonAsk } from './asks-query';
import { weeklyTopicTrends, topicsConnecting } from './trends-query';
import type {
  ConnectionIntent, OpenAsksIntent, PersonModelIntent, TrendIntent, TopicTrendResult,
} from './person-model-types';

const STOP_TOKENS = new Set(['anyone', 'anybody', 'someone', 'somebody', 'everyone', 'people']);
const SELF_NAMES = new Set(['me', 'myself', 'i']);
const MAX_SPOKEN_ASKS = 8;
const MAX_SPOKEN_TOPICS = 6;

/**
 * @description Detects any person-model question shape. Recall shapes win (they are the Phase-1
 * contract), then open asks, connections, and trends. Returns null for ordinary chat so the model
 * path is untouched.
 * @param message - The raw user message.
 * @returns The parsed intent, or null.
 */
export function detectPersonModelIntent(message: string): PersonModelIntent | null {
  const recall = detectRecallIntent(message);
  if (recall) return { kind: 'recall', ...recall };
  return detectOpenAsksIntent(message) ?? detectConnectionIntent(message) ?? detectTrendIntent(message);
}

/**
 * @description Matches "what has Ella asked me (for)", "what did Sam promise", "any open asks from
 * Ella", "what do I owe Ella". The person is captured case-preserving; "anyone" means every voice.
 * @param message - The raw user message.
 * @returns An open-asks intent, or null.
 */
export function detectOpenAsksIntent(message: string): OpenAsksIntent | null {
  const core = clean(message);
  const asked = core.match(
    /^(?:what|which|anything|something)\s+(?:has|have|did|does|do)\s+(.+?)\s+(?:asked|ask|requested|request)(?:\s+(?:me|us))?(?:\s+(?:for|about|to do|to)\b.*)?$/i,
  );
  if (asked) return asksIntent(asked[1], 'ask');
  const promised = core.match(
    /^(?:what|which|anything|something)\s+(?:has|have|did|does|do)\s+(.+?)\s+(?:promised|promise|committed to|commit to|agreed to|agree to|offered to|offer to)(?:\s+.*)?$/i,
  );
  if (promised) return asksIntent(promised[1], 'commitment');
  const listed = core.match(
    /^(?:show|list|any|what are|are there any)\s+(?:me\s+)?(?:the\s+|my\s+)?(?:open\s+)?(?:asks|requests|follow[- ]?ups)(?:\s+from\s+(.+?))?$/i,
  );
  if (listed) return asksIntent(listed[1] ?? '', 'any');
  const owed = core.match(/^(?:what|anything)\s+do\s+i\s+owe\s+(.+)$/i);
  if (owed) return asksIntent(owed[1], 'ask');
  return null;
}

/**
 * @description Matches "what do Ella and Sam talk about", "what connects Ella and Sam".
 * @param message - The raw user message.
 * @returns A connection intent, or null.
 */
export function detectConnectionIntent(message: string): ConnectionIntent | null {
  const core = clean(message);
  const m = core.match(/^what\s+(?:do|did|have)\s+(.+?)\s+and\s+(.+?)\s+(?:talk|talked|both talk)\s+about(?:\s+together)?$/i)
    ?? core.match(/^what\s+(?:topics?\s+)?connects?\s+(.+?)\s+(?:and|with|to)\s+(.+?)$/i);
  if (!m) return null;
  const personA = normalizePerson(m[1]);
  const personB = normalizePerson(m[2]);
  if (!personA || !personB) return null;
  return { kind: 'connection', personA, personB };
}

/**
 * @description Matches "what has Ella been talking about lately / this week / this month" and
 * "what does Ella talk about most". The window is weeks: this week → 1, this month → 4, else 2.
 * @param message - The raw user message.
 * @returns A trend intent, or null.
 */
export function detectTrendIntent(message: string): TrendIntent | null {
  const core = clean(message);
  const m = core.match(
    /^(?:what|which)\s+(?:has|have|is|are|does|do)\s+(.+?)\s+(?:been\s+)?(?:talking|talked|talk|going on)\s+about(?:\s+(?:the\s+)?most)?(?:\s+(lately|recently|this week|this month|these days))?$/i,
  );
  if (!m) return null;
  const personName = normalizePerson(m[1]);
  const window = (m[2] ?? '').toLowerCase();
  const weeks = window === 'this week' ? 1 : window === 'this month' ? 4 : 2;
  return { kind: 'trend', personName, weeks };
}

/**
 * @description Answers a person-model intent deterministically: a SQL read plus literal phrasing,
 * no model turn. Recall keeps its Phase-1 phrasing byte-for-byte.
 * @param pool - GUC-aware Postgres pool.
 * @param ownerSub - Authenticated owner sub.
 * @param intent - The detected intent.
 * @returns The ready-to-send answer.
 */
export async function answerPersonModelIntent(pool: Pool, ownerSub: string, intent: PersonModelIntent): Promise<string> {
  switch (intent.kind) {
    case 'recall': {
      const { kind: _kind, ...recall } = intent;
      return buildRecallSpokenAnswer(recall, await recallQuery(pool, ownerSub, recall));
    }
    case 'asks': {
      const asks = await getOpenAsks(pool, ownerSub, { personName: intent.personName || undefined });
      return buildOpenAsksSpokenAnswer(intent, asks);
    }
    case 'trend':
      return buildTrendSpokenAnswer(intent, await weeklyTopicTrends(pool, ownerSub, { personName: intent.personName, weeks: intent.weeks }));
    case 'connection': {
      const result = await topicsConnecting(pool, ownerSub, intent.personA, intent.personB);
      return buildConnectionSpokenAnswer(intent, result);
    }
    default:
      return 'I could not read that as a question about what someone said.';
  }
}

/**
 * @description Phrases open asks/commitments: each one is OSHAL's read, shown beside the verbatim
 * words it was inferred from, so the user can judge the extraction.
 * @param intent - The asks intent (person + which kinds).
 * @param asks - Open asks as returned by the SQL read.
 * @returns The answer text.
 */
export function buildOpenAsksSpokenAnswer(intent: OpenAsksIntent, asks: PersonAsk[]): string {
  const who = intent.personName || 'anyone';
  const wanted = intent.askKind === 'any' ? asks : asks.filter((a) => a.kind === intent.askKind);
  const noun = intent.askKind === 'commitment' ? 'commitments' : intent.askKind === 'ask' ? 'asks' : 'asks or commitments';
  if (intent.personName && asks.length === 0 && wanted.length === 0) {
    return `Nothing open from ${who} right now — no ${noun} I have recorded, or I don't have a saved voice by that name yet (name them under Manage Voices).`;
  }
  if (wanted.length === 0) return `Nothing open from ${who} right now.`;
  const label = wanted[0].personLabel;
  const lines = wanted.slice(0, MAX_SPOKEN_ASKS).map((a) => {
    const kind = a.kind === 'commitment' ? 'Commitment' : 'Ask';
    return `- ${kind}: ${a.text} — heard as "${a.sourceQuote}" (${a.createdAt.slice(0, 10)})`;
  });
  const more = wanted.length > MAX_SPOKEN_ASKS ? `\n…and ${wanted.length - MAX_SPOKEN_ASKS} more.` : '';
  const subject = intent.personName ? label : 'People';
  return `${subject} ${wanted.length === 1 ? 'has 1 open item' : `has ${wanted.length} open items`} — my read of what was said, each beside the words:\n${lines.join('\n')}${more}`;
}

/**
 * @description Phrases the weekly topic trend as literal counts per week.
 * @param intent - The trend intent.
 * @param result - The SQL trend rows.
 * @returns The answer text.
 */
export function buildTrendSpokenAnswer(intent: TrendIntent, result: TopicTrendResult): string {
  if (!result.personResolved) {
    return `I don't have a saved voice matching "${intent.personName}" yet. Name that person under Manage Voices and I'll be able to track what they talk about.`;
  }
  const who = result.personLabel || intent.personName || 'anyone';
  if (result.rows.length === 0) {
    return `I have no modeled topics for ${who} in the last ${result.weeks} week${result.weeks === 1 ? '' : 's'}.`;
  }
  const byWeek = new Map<string, string[]>();
  for (const row of result.rows) {
    const list = byWeek.get(row.weekStart) ?? [];
    if (list.length < MAX_SPOKEN_TOPICS) list.push(`${row.topic} (${row.mentions})`);
    byWeek.set(row.weekStart, list);
  }
  const lines = [...byWeek.entries()].map(([week, topics]) => `- week of ${week}: ${topics.join(', ')}`);
  return `${who} — topics by week over the last ${result.weeks} week${result.weeks === 1 ? '' : 's'} (my read, mention counts in parentheses):\n${lines.join('\n')}`;
}

/**
 * @description Phrases the topics two people share, with the distinct days each mentioned them.
 * @param intent - The connection intent.
 * @param result - The SQL self-join result.
 * @returns The answer text.
 */
export function buildConnectionSpokenAnswer(
  intent: ConnectionIntent,
  result: { labelA: string | null; labelB: string | null; resolved: boolean; topics: Array<{ topic: string; daysA: number; daysB: number; lastObservedOn: string }> },
): string {
  if (!result.resolved) {
    const missing = !result.labelA ? intent.personA : intent.personB;
    return `I don't have a saved voice matching "${missing}" yet. Name that person under Manage Voices first.`;
  }
  const a = result.labelA ?? intent.personA;
  const b = result.labelB ?? intent.personB;
  if (result.topics.length === 0) return `I have not heard ${a} and ${b} bring up the same topics yet.`;
  const lines = result.topics.slice(0, MAX_SPOKEN_TOPICS)
    .map((t) => `- ${t.topic}: ${a} on ${t.daysA} day${t.daysA === 1 ? '' : 's'}, ${b} on ${t.daysB} day${t.daysB === 1 ? '' : 's'} (last ${t.lastObservedOn})`);
  return `Topics ${a} and ${b} both talk about (my read of the transcripts):\n${lines.join('\n')}`;
}

function asksIntent(rawPerson: string, askKind: OpenAsksIntent['askKind']): OpenAsksIntent {
  return { kind: 'asks', personName: normalizePerson(rawPerson), askKind };
}

/** Strips punctuation and collapses whitespace before matching, keeping the original case for names. */
function clean(message: string): string {
  return String(message || '').replace(/[?.!,]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Mirrors the recall guard: self names → "me", "anyone"-style tokens → '' (every voice). */
function normalizePerson(raw: string): string {
  const cleaned = String(raw || '').replace(/[^\p{L}\p{N}\s'-]/gu, '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';
  if (SELF_NAMES.has(cleaned.toLowerCase())) return 'me';
  if (STOP_TOKENS.has(cleaned.toLowerCase())) return '';
  return cleaned;
}
