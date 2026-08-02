/**
 * Haven push proactivity — the OPT-IN gate and policy (ADR-030 property 3, ADR-079
 * "Deferred: push proactivity").
 *
 * ADR-079 shipped proactivity as PULL: a lazy sweep computes suggestions and the Jarvis page shows
 * a "Haven noticed" strip when the user arrives. This module is the push half — Haven reaching the
 * user when they are NOT looking — and it is the part that has to be gated properly, because it is
 * outward-acting automation (operator directive: per-user opt-in, default OFF).
 *
 * The gate is deliberately NOT "ask the NotificationRouter to route it". `resolveRouting` falls back
 * to the user's `default` topic row and then to *email-if-Gmail-else-none*, which is correct for a
 * digest the user asked for and WRONG here: it would silently switch push on for everyone who has
 * ever connected Gmail, and would let the welcome wizard's one generic "text me" answer opt a user
 * into unsolicited assistant messages they never agreed to. So {@link evaluatePushGate} reads the
 * `haven-proactive` topic row ONLY. No row means OFF. Forever, until the user says otherwise.
 *
 * Everything here is pure policy over a structural preference shape — the notifications slice is a
 * sibling feature, so this slice describes what it needs rather than importing it (FSD: no
 * cross-imports between slices at the same layer). Delivery itself reuses the existing
 * NotificationRouter from the app layer; there is no second notifier.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: HAVEN_PUSH_TOPIC, evaluatePushGate (explicit-topic-row-only, default OFF, honest disabled reasons), PUSHABLE_SUGGESTION_KINDS (a teach nudge is never pushed outward), selectPushableSuggestions (once-per-suggestion + per-day cap) and formatHavenPush.
 *
 * @module features/user-model/services/haven-proactivity
 */

import type { SuggestionCandidate } from './user-model-logic';

/**
 * The notification topic that governs outward Haven pushes. A user opts in by saving an enabled
 * preference row for exactly this topic; nothing else enables it.
 */
export const HAVEN_PUSH_TOPIC = 'haven-proactive';

/** Most outward Haven messages a user can receive in one day, however many suggestions exist. */
export const HAVEN_PUSH_DAILY_CAP = 2;

/**
 * The suggestion kinds worth interrupting someone for. A `teach-nudge` is a UI tip — pushing it to
 * a phone would be the assistant texting you to say it exists. It stays pull-only, permanently.
 */
export const PUSHABLE_SUGGESTION_KINDS: ReadonlySet<SuggestionCandidate['kind']> = new Set([
  'stale-goal',
  'connector-attention',
  'ambient-follow-up',
]);

/**
 * The minimum a saved preference row must look like for the gate to read it. Structurally satisfied
 * by the notifications slice's `UserNotificationPref` — declared here so this slice does not import
 * a sibling feature.
 */
export interface PushPreferenceLike {
  enabled: boolean;
  channel: string;
}

/** Why push is (or is not) on, in words a settings screen can show verbatim. */
export type PushGateReason =
  | 'ready'
  /** No `haven-proactive` preference row at all — the default, and the reason push is off. */
  | 'not-opted-in'
  /** A row exists but the user muted it. */
  | 'disabled'
  /** A row exists and is enabled, but routes to "none". */
  | 'channel-none';

/** The gate's verdict for one user. */
export interface HavenPushGate {
  /** True ONLY when the user explicitly turned push on and left a usable channel. */
  enabled: boolean;
  reason: PushGateReason;
  /** The channel a push would use, or null when it would not go anywhere. */
  channel: string | null;
}

/**
 * @description Decide whether Haven may push to this user, from their explicit `haven-proactive`
 * preference row and NOTHING else. A null row (the state every user starts in, and the state a user
 * with only a generic `default` row is still in) is OFF — this function has no fallback, by design.
 * @param pref - The saved `haven-proactive` preference row, or null when the user has never opted in.
 * @returns Whether push is enabled, the channel it would use, and an honest reason when it is not.
 */
export function evaluatePushGate(pref: PushPreferenceLike | null | undefined): HavenPushGate {
  if (!pref) return { enabled: false, reason: 'not-opted-in', channel: null };
  if (!pref.enabled) return { enabled: false, reason: 'disabled', channel: pref.channel || null };
  if (!pref.channel || pref.channel === 'none') return { enabled: false, reason: 'channel-none', channel: null };
  return { enabled: true, reason: 'ready', channel: pref.channel };
}

/** One pending suggestion, as the store returns it. */
export interface PendingSuggestion {
  suggestionId: string;
  kind: string;
  message: string;
}

/**
 * @description Choose which pending suggestions may be pushed on this run: push-worthy kinds only,
 * never one already pushed, and never more than the day's remaining budget. Pure — the caller
 * records the sends. Oldest-first (the store already orders that way) so a backlog drains fairly.
 * @param pending - The user's pending suggestions, oldest first.
 * @param alreadyPushedIds - Suggestion ids this user has already been pushed (any day).
 * @param remainingToday - How many pushes the user's daily budget still allows.
 * @returns The suggestions to push now (possibly empty).
 */
export function selectPushableSuggestions(
  pending: PendingSuggestion[],
  alreadyPushedIds: Iterable<string>,
  remainingToday: number,
): PendingSuggestion[] {
  const budget = Math.max(0, Math.floor(remainingToday));
  if (budget === 0) return [];
  const seen = new Set(alreadyPushedIds);
  const out: PendingSuggestion[] = [];
  for (const suggestion of pending) {
    if (out.length >= budget) break;
    if (seen.has(suggestion.suggestionId)) continue;
    if (!PUSHABLE_SUGGESTION_KINDS.has(suggestion.kind as SuggestionCandidate['kind'])) continue;
    out.push(suggestion);
  }
  return out;
}

/** A rendered outward push, shaped for the existing NotificationRouter's message contract. */
export interface HavenPushMessage {
  subject: string;
  body: string;
  shortText: string;
}

/**
 * @description Render one suggestion as an outward message. Every push names itself as Haven, says
 * it is opt-in, and carries the off switch — an unsolicited-looking message from an assistant is
 * exactly the failure mode the opt-in directive exists to prevent.
 * @param suggestion - The suggestion being pushed.
 * @returns Subject/body for email-shaped channels plus a short line for SMS-shaped ones.
 */
export function formatHavenPush(suggestion: PendingSuggestion): HavenPushMessage {
  const headline = suggestion.kind === 'connector-attention'
    ? 'One of your connections needs attention'
    : 'Haven noticed something';
  return {
    subject: `oshal — ${headline}`,
    body: [
      suggestion.message,
      '',
      'Open Jarvis to pick it up: /cockpit/?app=jarvis',
      '',
      'You get this because you turned Haven proactive updates ON in Notification preferences.',
      'Turn them off there any time.',
    ].join('\n'),
    shortText: `oshal Haven: ${suggestion.message}`.slice(0, 300),
  };
}
