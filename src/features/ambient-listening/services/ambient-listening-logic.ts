/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added pure validation, text-only batch normalization, extractive daily summarization, and conservative reminder/task proposal extraction for ambient listening.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added local-time due-review computation and validation/honoring of daily review and follow-up suggestion controls.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added off-by-default diarization/profile settings, selected-org validation shape, and rejection of client-asserted trusted speaker profile ids.
 */

import { createHash } from 'node:crypto';
import {
  AmbientInputError,
  type AmbientActionSuggestion,
  type AmbientDailyReview,
  type AmbientSegmentInput,
  type AmbientSettings,
} from './ambient-listening-types';

const MAX_SEGMENTS_PER_BATCH = 100;
const MAX_TRANSCRIPT_CHARS = 8_000;
const MAX_WAKE_PHRASES = 10;
const AUDIO_FIELD = /^(audio|audioData|audioBlob|audioBytes|rawAudio|blob|media)$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TIME_ZONES = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);

/** @description Privacy-first defaults: ordinary Jarvis name, wake phrase, 30-day retention, and capture off. */
export const DEFAULT_AMBIENT_SETTINGS: Omit<AmbientSettings, 'updatedAt'> = {
  assistantName: 'Jarvis',
  wakePhrases: ['hey jarvis'],
  ambientEnabled: false,
  transcriptRetentionDays: 30,
  timeZone: 'UTC',
  dailyReviewEnabled: false,
  dailyReviewTime: '21:00',
  suggestFollowUps: true,
  speakerDiarizationEnabled: false,
  rememberSpeakers: false,
  speakerTenantId: null,
};

/**
 * @description Validates and merges a partial settings payload, deriving a new default wake phrase
 * when the assistant name changes and wake phrases were not explicitly supplied.
 * @param current - The owner's current persisted settings.
 * @param input - Untrusted JSON request body.
 * @param now - Timestamp assigned to the normalized settings.
 * @returns A complete validated settings value.
 */
export function normalizeAmbientSettings(
  current: AmbientSettings,
  input: unknown,
  now = new Date(),
): AmbientSettings {
  const patch = requireRecord(input, 'settings must be a JSON object');
  rejectUnknownSettingsFields(patch);
  const assistantName = readAssistantName(patch.assistantName, current.assistantName);
  const wakePhrases = patch.wakePhrases === undefined
    ? deriveWakePhrases(current, assistantName)
    : readWakePhrases(patch.wakePhrases);
  const speakerDiarizationEnabled = readBoolean(
    patch.speakerDiarizationEnabled, current.speakerDiarizationEnabled, 'speakerDiarizationEnabled',
  );
  const rememberSpeakers = speakerDiarizationEnabled
    && readBoolean(patch.rememberSpeakers, current.rememberSpeakers, 'rememberSpeakers');
  return {
    assistantName,
    wakePhrases,
    ambientEnabled: readBoolean(patch.ambientEnabled, current.ambientEnabled, 'ambientEnabled'),
    transcriptRetentionDays: readRetention(patch.transcriptRetentionDays, current.transcriptRetentionDays),
    timeZone: readTimeZone(patch.timeZone, current.timeZone),
    dailyReviewEnabled: readBoolean(patch.dailyReviewEnabled, current.dailyReviewEnabled, 'dailyReviewEnabled'),
    dailyReviewTime: readDailyReviewTime(patch.dailyReviewTime, current.dailyReviewTime),
    suggestFollowUps: readBoolean(patch.suggestFollowUps, current.suggestFollowUps, 'suggestFollowUps'),
    speakerDiarizationEnabled,
    rememberSpeakers,
    speakerTenantId: readOptionalUuid(patch.speakerTenantId, current.speakerTenantId, 'speakerTenantId'),
    updatedAt: now,
  };
}

/**
 * @description Converts a single segment or `{segments: [...]}` batch into safe text-only values.
 * Any raw-audio-shaped field is rejected recursively before text is inspected.
 * @param payload - Untrusted JSON request body.
 * @param now - Fallback capture timestamp.
 * @returns One or more validated text segments.
 */
export function normalizeAmbientSegmentBatch(payload: unknown, now = new Date()): AmbientSegmentInput[] {
  if (containsRawAudio(payload)) {
    throw new AmbientInputError('Raw audio is not accepted; send finalized transcript text only.', 'raw_audio_not_allowed');
  }
  const record = Array.isArray(payload) ? null : requireRecord(payload, 'segment payload must be a JSON object or array');
  const rawSegments = Array.isArray(payload) ? payload : Array.isArray(record?.segments) ? record.segments : [record];
  if (rawSegments.length < 1 || rawSegments.length > MAX_SEGMENTS_PER_BATCH) {
    throw new AmbientInputError(`segments must contain between 1 and ${MAX_SEGMENTS_PER_BATCH} items`);
  }
  return rawSegments.map((item, index) => normalizeSegment(item, index, now));
}

/**
 * @description Validates a YYYY-MM-DD calendar date without permitting rollover dates.
 * @param value - Candidate local date.
 * @returns The validated date string.
 */
export function normalizeLocalDate(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!DATE_PATTERN.test(text)) throw new AmbientInputError('date must use YYYY-MM-DD');
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!valid) throw new AmbientInputError('date is not a valid calendar day');
  return text;
}

/**
 * @description Resolves the local date and 24-hour clock time for a configured IANA zone.
 * @param instant - Absolute instant to render.
 * @param timeZone - Valid IANA time zone.
 * @returns Local YYYY-MM-DD date and HH:mm time.
 */
export function ambientLocalClock(instant: Date, timeZone: string): { localDate: string; localTime: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    localDate: `${value('year')}-${value('month')}-${value('day')}`,
    localTime: `${value('hour')}:${value('minute')}`,
  };
}

/**
 * @description Determines whether an enabled owner has reached their configured local review time.
 * @param settings - Owner's ambient/review settings.
 * @param instant - Sweep instant.
 * @returns Due local date, or null when review is disabled/not yet due.
 */
export function dueAmbientReviewDate(settings: AmbientSettings, instant: Date): string | null {
  if (!settings.ambientEnabled || !settings.dailyReviewEnabled) return null;
  const clock = ambientLocalClock(instant, settings.timeZone);
  return clock.localTime >= settings.dailyReviewTime ? clock.localDate : null;
}

/**
 * @description Builds an honest extractive summary and conservative action proposals from one day.
 * No side effects are performed; every suggestion remains status `proposed` and requires confirmation.
 * @param localDate - Valid local calendar date.
 * @param timeZone - IANA time zone used to select the day.
 * @param segments - Persisted text segments for the owner and day.
 * @param now - Review timestamp.
 * @param suggestFollowUps - Whether reminder/task proposals should be extracted.
 * @returns A daily review ready for persistence.
 */
export function buildAmbientDailyReview(
  localDate: string,
  timeZone: string,
  segments: Array<{ segmentId: string; text: string; speakerLabel: string | null }>,
  now = new Date(),
  suggestFollowUps = true,
): AmbientDailyReview {
  const summary = buildExtractiveSummary(segments);
  const suggestions = suggestFollowUps ? extractAmbientSuggestions(localDate, segments) : [];
  return {
    localDate,
    timeZone,
    summary,
    sourceSegmentCount: segments.length,
    suggestions,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * @description Finds reminder, commitment, and missed-follow-up language without inventing details.
 * @param localDate - Date included in later confirmation prompts and stable suggestion ids.
 * @param segments - Text segments to inspect.
 * @returns Deduplicated proposed actions, capped at ten.
 */
export function extractAmbientSuggestions(
  localDate: string,
  segments: Array<{ segmentId: string; text: string; speakerLabel: string | null }>,
): AmbientActionSuggestion[] {
  const suggestions = new Map<string, AmbientActionSuggestion>();
  for (const segment of segments) {
    for (const sentence of splitSentences(segment.text)) {
      const classified = classifyAction(sentence);
      if (!classified) continue;
      const title = extractActionTitle(sentence, classified.kind);
      const key = `${classified.kind}:${title.toLowerCase()}`;
      const existing = suggestions.get(key);
      if (existing) existing.sourceSegmentIds.push(segment.segmentId);
      else suggestions.set(key, makeSuggestion(localDate, segment, sentence, classified, title));
      if (suggestions.size >= 10) return [...suggestions.values()];
    }
  }
  return [...suggestions.values()];
}

function rejectUnknownSettingsFields(input: Record<string, unknown>): void {
  const allowed = new Set([
    'assistantName', 'wakePhrases', 'ambientEnabled', 'transcriptRetentionDays', 'timeZone',
    'dailyReviewEnabled', 'dailyReviewTime', 'suggestFollowUps',
    'speakerDiarizationEnabled', 'rememberSpeakers', 'speakerTenantId',
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new AmbientInputError(`unknown settings field: ${unknown[0]}`);
}

function readAssistantName(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new AmbientInputError('assistantName must be a string');
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 40 || !/^[\p{L}\p{N}][\p{L}\p{N} '\-.]*$/u.test(name)) {
    throw new AmbientInputError('assistantName must be 1-40 letters, numbers, spaces, apostrophes, dots, or hyphens');
  }
  return name;
}

function readWakePhrases(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_WAKE_PHRASES) {
    throw new AmbientInputError(`wakePhrases must contain between 1 and ${MAX_WAKE_PHRASES} phrases`);
  }
  const phrases = value.map((item) => {
    if (typeof item !== 'string') throw new AmbientInputError('each wake phrase must be a string');
    const phrase = item.trim().replace(/\s+/g, ' ').toLowerCase();
    if (phrase.length < 2 || phrase.length > 80) throw new AmbientInputError('wake phrases must be 2-80 characters');
    return phrase;
  });
  return [...new Set(phrases)];
}

function deriveWakePhrases(current: AmbientSettings, assistantName: string): string[] {
  return assistantName === current.assistantName ? current.wakePhrases : [`hey ${assistantName.toLowerCase()}`];
}

function readBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new AmbientInputError(`${field} must be a boolean`);
  return value;
}

function readRetention(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 365) {
    throw new AmbientInputError('transcriptRetentionDays must be an integer from 1 to 365');
  }
  return Number(value);
}

function readTimeZone(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !TIME_ZONES.has(value)) throw new AmbientInputError('timeZone must be a valid IANA time zone');
  return value;
}

function readDailyReviewTime(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !CLOCK_PATTERN.test(value)) {
    throw new AmbientInputError('dailyReviewTime must use 24-hour HH:mm format');
  }
  return value;
}

function normalizeSegment(value: unknown, index: number, now: Date): AmbientSegmentInput {
  const item = requireRecord(value, `segments[${index}] must be a JSON object`);
  if (item.speakerProfileId !== undefined || item.trustedSpeakerProfileId !== undefined) {
    throw new AmbientInputError(
      `segments[${index}] cannot assert a trusted speaker profile`, 'trusted_speaker_profile_not_allowed',
    );
  }
  const text = typeof item.text === 'string' ? item.text.trim().replace(/\s+/g, ' ') : '';
  if (!text || text.length > MAX_TRANSCRIPT_CHARS) {
    throw new AmbientInputError(`segments[${index}].text must contain 1-${MAX_TRANSCRIPT_CHARS} characters`);
  }
  const capturedAt = readDate(item.capturedAt, now, `segments[${index}].capturedAt`);
  const endedAt = item.endedAt === undefined || item.endedAt === null
    ? null
    : readDate(item.endedAt, now, `segments[${index}].endedAt`);
  if (endedAt && endedAt.getTime() < capturedAt.getTime()) throw new AmbientInputError(`segments[${index}].endedAt precedes capturedAt`);
  return {
    text,
    capturedAt,
    endedAt,
    speakerLabel: readOptionalText(item.speakerLabel, 80, `segments[${index}].speakerLabel`),
    wakePhraseDetected: readBoolean(item.wakePhraseDetected, false, `segments[${index}].wakePhraseDetected`),
    matchedWakePhrase: readOptionalText(item.matchedWakePhrase, 80, `segments[${index}].matchedWakePhrase`),
    sessionId: readOptionalText(item.sessionId, 128, `segments[${index}].sessionId`),
    clientSegmentId: readOptionalText(item.clientSegmentId ?? item.id, 128, `segments[${index}].clientSegmentId`),
    speakerProfileId: null,
  };
}

function readOptionalUuid(value: unknown, fallback: string | null, field: string): string | null {
  if (value === undefined) return fallback;
  if (value === null || value === '') return null;
  if (typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AmbientInputError(`${field} must be a UUID or null`);
  }
  return value.toLowerCase();
}

function readDate(value: unknown, fallback: Date, field: string): Date {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') throw new AmbientInputError(`${field} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new AmbientInputError(`${field} must be an ISO timestamp`);
  return parsed;
}

function readOptionalText(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new AmbientInputError(`${field} must be a string`);
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || text.length > max) throw new AmbientInputError(`${field} must contain 1-${max} characters`);
  return text;
}

function containsRawAudio(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsRawAudio(item, depth + 1));
  return Object.entries(value as Record<string, unknown>)
    .some(([key, child]) => AUDIO_FIELD.test(key) || containsRawAudio(child, depth + 1));
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AmbientInputError(message);
  return value as Record<string, unknown>;
}

function buildExtractiveSummary(segments: Array<{ text: string; speakerLabel: string | null }>): string {
  if (segments.length === 0) return 'No ambient transcript was captured for this day.';
  const speakers = [...new Set(segments.map((item) => item.speakerLabel).filter((item): item is string => Boolean(item)))];
  const excerpts = uniqueExcerpts(segments.flatMap((item) => splitSentences(item.text))).slice(0, 5);
  const speakerText = speakers.length > 0 ? ` Speakers identified: ${speakers.slice(0, 5).join(', ')}.` : '';
  return `Captured ${segments.length} text transcript segment${segments.length === 1 ? '' : 's'}.${speakerText} Key moments: ${excerpts.join(' ')}`.slice(0, 1_500);
}

function uniqueExcerpts(sentences: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const sentence of sentences) {
    const excerpt = sentence.trim().slice(0, 240);
    const key = excerpt.toLowerCase();
    if (excerpt.length < 3 || seen.has(key)) continue;
    seen.add(key);
    result.push(excerpt.endsWith('.') ? excerpt : `${excerpt}.`);
  }
  return result;
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|[\r\n]+/).map((part) => part.trim()).filter(Boolean);
}

type ClassifiedAction = { kind: AmbientActionSuggestion['kind']; target: AmbientActionSuggestion['proposedTarget'] };

function classifyAction(sentence: string): ClassifiedAction | null {
  if (/\b(?:remind(?:er)?|remember to|don't forget(?: to)?|do not forget(?: to)?)\b/i.test(sentence)) {
    return { kind: 'reminder', target: 'calendar' };
  }
  if (/\b(?:i|we)\s+(?:need|have)\s+to\b|\bwe should\b|\b(?:i'll|i will|we'll|we will)\b/i.test(sentence)) {
    return { kind: 'task', target: 'tasks' };
  }
  if (/\b(?:forgot|missed|didn't|did not)\b.*\b(?:send|call|email|submit|schedule|book|pay|reply|follow up)\b/i.test(sentence)) {
    return { kind: 'follow-up', target: 'tasks' };
  }
  return null;
}

function extractActionTitle(sentence: string, kind: AmbientActionSuggestion['kind']): string {
  const clean = sentence.replace(/^[\p{L}\p{N} '-]{1,40},\s*/u, '').trim();
  const patterns = kind === 'reminder'
    ? [/\bremind\s+(?:me|us|him|her)\s+(?:to|about)\s+(.+)/i, /\b(?:remember|don't forget|do not forget)\s+to\s+(.+)/i]
    : [/\b(?:i|we)\s+(?:need|have)\s+to\s+(.+)/i, /\bwe should\s+(.+)/i, /\b(?:i'll|i will|we'll|we will)\s+(.+)/i];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match?.[1]) return trimTitle(match[1]);
  }
  return trimTitle(clean);
}

function trimTitle(value: string): string {
  return value.replace(/[.!?]+$/g, '').trim().slice(0, 180) || 'follow up on this conversation';
}

function makeSuggestion(
  localDate: string,
  segment: { segmentId: string; speakerLabel: string | null },
  sentence: string,
  classified: ClassifiedAction,
  title: string,
): AmbientActionSuggestion {
  const question = classified.kind === 'reminder' ? 'create a calendar reminder' : 'create a task';
  const digest = createHash('sha256').update(`${localDate}:${classified.kind}:${title.toLowerCase()}`).digest('hex').slice(0, 24);
  return {
    suggestionId: `ambient-${digest}`,
    kind: classified.kind,
    title,
    prompt: `From your ${localDate} transcript: would you like me to ${question} for “${title}”?`,
    evidence: `${segment.speakerLabel ? `${segment.speakerLabel}: ` : ''}${sentence}`.slice(0, 300),
    sourceSegmentIds: [segment.segmentId],
    proposedTarget: classified.target,
    requiresConfirmation: true,
    status: 'proposed',
  };
}
