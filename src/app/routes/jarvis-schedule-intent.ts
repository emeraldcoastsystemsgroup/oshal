/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Wires the assistant to the scheduler: a deterministic pre-check on the /ask path that turns "remind me on Tuesday to order flowers" into a real schedule the runner fires, then confirms. It sits in the same family as detectRecallIntent / detectProviderBoundHandoff — a bounded matcher that short-circuits BEFORE the model turn, never an LLM, so a scheduling sentence produces a predictable rule rather than a hallucinated one. Detection is deliberately conservative (an explicit scheduling cue AND a parseable time AND a residual action) so an ordinary question is never hijacked into a reminder. The service handle is injected by schedule-runtime via a setter, mirroring setHomeScheduleService, to avoid a composition-root circular import.
 */

import { parseNaturalSchedule, type ScheduleService } from '@/features/scheduling';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'jarvis-schedule-intent' });

/** taskType for an assistant-authored personal reminder. Its own dispatch + gate-bypass branch. */
export const JARVIS_REMINDER_TASK_TYPE = 'jarvis-reminder';

/** The scheduler service, injected at boot. Null until schedule-runtime wires it (or if disabled). */
let scheduleService: ScheduleService | null = null;

/**
 * @description Injects the live scheduler service so the /ask path can create reminders. Called once
 * from schedule-runtime, the same pattern the home and trading branches use.
 */
export function setJarvisScheduleService(service: ScheduleService | null): void {
  scheduleService = service;
}

/** True when the assistant can actually create a reminder that will fire (service present). */
export function jarvisSchedulingAvailable(): boolean {
  return scheduleService !== null;
}

/** The deployment timezone reminders are interpreted in when the user's own zone is unknown. */
export function schedulingTimezone(): string {
  return process.env.SCHEDULE_DEFAULT_TZ
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';
}

export interface ScheduleIntent {
  action: string;
  cron: string;
  once: boolean;
  timezone: string;
  description: string;
}

// An EXPLICIT instruction to schedule — present anywhere in the message.
const EXPLICIT_CUE = /\b(remind me|set (a|up a)? ?reminder|schedule (a|this|me|it)?)\b/;
// A LEADING time phrase reads as an imperative reminder ("On Tuesday, order flowers", "every day at
// 9am email me", "tomorrow at 3 call the dentist"). The SAME phrase mid-sentence is narrative ("I
// saw her on Tuesday") and must NOT match — which is why this is anchored to the start.
const LEADING_TIME = /^\s*(on\s+(mon|tue|wed|thu|fri|sat|sun)|every\b|each\b|daily\b|weekly\b|monthly\b|tomorrow\b|tonight\b|weekdays?\b|weekends?\b|at\s+\d|in\s+\d)/i;
// A question with no explicit cue is never a reminder ("what should I do on Tuesday?").
const PURE_QUESTION = /^\s*(what|whats|what's|when|how|why|who|where|is|are|do|does|did|can|could|will|should)\b/;

/**
 * @description Strips the scheduling scaffolding from a phrase to leave the action to run. Best-effort
 * and non-load-bearing: even if a stray "on tuesday" survives, the fired prompt runs through the
 * orchestrator (not back through this detector), so it cannot re-trigger scheduling.
 */
function extractAction(text: string): string {
  // Strip the request scaffolding first ("remind me to", "schedule a", "please").
  let action = text
    .replace(/^\s*please\s+/i, '')
    .replace(/\b(can you|could you)\s+/gi, ' ')
    .replace(/\bremind me\s+(to\s+|that\s+|about\s+)?/i, ' ')
    .replace(/\bset (a|up a)? ?reminder (to|for)?\b/gi, ' ')
    .replace(/\bschedule (a|this|me|it)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // A time phrase in a reminder sits at the FRONT ("every Monday at 9am ...") or the TAIL
  // ("... every day at 9am") — never buried in the action. So strip only from the two ends, which
  // leaves adjectives like "weekly plan" or "daily report" that happen to sit inside the action alone.
  const TIME_TOKEN = new RegExp(
    '(?:'
    + 'every\\s+\\w+|each\\s+\\w+|on\\s+the\\s+\\d{1,2}(?:st|nd|rd|th)|'
    + 'on\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?|'
    + '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?|'
    + 'tomorrow|tonight|today|daily|weekly|monthly|weekdays?|weekends?|'
    + 'at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|at\\s+(?:noon|midnight)|'
    + 'in\\s+\\d{1,3}\\s+(?:minutes?|mins?|hours?|hrs?|days?)'
    + ')', 'i',
  );
  const trimEnds = (s: string): string => {
    let out = s.trim().replace(/^[\s,:-]+|[\s,:-]+$/g, '');
    // Peel leading time tokens.
    for (;;) {
      const lead = new RegExp(`^(?:${TIME_TOKEN.source})[\\s,]*`, 'i').exec(out);
      if (!lead || lead[0].length === 0) break;
      out = out.slice(lead[0].length).trim();
    }
    // Peel trailing time tokens.
    for (;;) {
      const tail = new RegExp(`[\\s,]*(?:${TIME_TOKEN.source})$`, 'i').exec(out);
      if (!tail || tail[0].length === 0) break;
      out = out.slice(0, out.length - tail[0].length).trim();
    }
    return out.replace(/^to\s+/i, '').replace(/^[\s,:-]+|[\s,:-]+$/g, '').trim();
  };
  return trimEnds(action);
}

/**
 * @description Detects an explicit scheduling request and resolves it to a concrete rule + action,
 * or returns null when the message is not a reminder. Deterministic; nothing is read from the clock
 * except the injected `now`.
 *
 * @param message - The raw user message.
 * @param opts - Reference instant and the timezone reminders are interpreted in.
 * @returns A ScheduleIntent, or null.
 */
export function detectScheduleIntent(message: string, opts: { now: Date; timezone: string }): ScheduleIntent | null {
  const text = String(message || '').trim();
  if (!text || text.length > 400) return null;
  const lower = text.toLowerCase();
  const explicit = EXPLICIT_CUE.test(lower);
  const leadingTime = LEADING_TIME.test(text);
  // Need an explicit "remind me/schedule" anywhere, OR a time phrase at the very start (imperative).
  if (!explicit && !leadingTime) return null;
  // A leading question word (and not a leading time phrase) means the user is ASKING, not
  // instructing — even if "schedule"/"remind" appears ("what reminders do I have?"). A message that
  // starts with a time phrase is an instruction, so leadingTime is exempt from this guard.
  if (!leadingTime && PURE_QUESTION.test(lower)) return null;

  const parsed = parseNaturalSchedule(text, { now: opts.now, timezone: opts.timezone });
  if (!parsed) return null;

  const action = extractAction(text);
  // A reminder with no residual action is not actionable ("remind me tomorrow" alone) — decline so
  // the model turn can ask what to be reminded about, rather than scheduling an empty prompt.
  if (action.length < 3) return null;

  return { action, cron: parsed.cron, once: parsed.once, timezone: parsed.timezone, description: parsed.description };
}

/**
 * @description Creates a personal reminder schedule for a signed-in user. The fired prompt runs back
 * through the orchestrator with autoApprove:false, so any outward action the reminder performs still
 * hits the interactive approval gates — the reminder schedules the intent, it does not pre-authorize
 * the act.
 *
 * @param intent - The resolved scheduling intent.
 * @param ownerSub - OIDC sub of the requesting user.
 * @param targetAgentId - Agent the fired prompt should route through (the assistant/chat agent).
 * @returns A confirmation sentence, or null when scheduling is unavailable or the create failed.
 */
export async function createJarvisReminder(
  intent: ScheduleIntent,
  ownerSub: string,
  targetAgentId: string,
): Promise<string | null> {
  if (!scheduleService) return null;
  try {
    const created = await scheduleService.createSchedule({
      taskType: JARVIS_REMINDER_TASK_TYPE,
      schedule: intent.cron,
      timezone: intent.timezone,
      once: intent.once,
      ownerSub,
      taskData: { prompt: intent.action, targetAgent: targetAgentId },
    });
    logger.info({ scheduleId: created.id, ownerSub, cron: intent.cron, once: intent.once }, 'Created Jarvis reminder');
    const tail = intent.once ? 'just this once' : 'every time from now on';
    return `Done — I'll ${intent.action} ${intent.description}, ${tail}. You can view or cancel it any time.`;
  } catch (error) {
    logger.error({ err: error, ownerSub }, 'Failed to create Jarvis reminder');
    return null;
  }
}
