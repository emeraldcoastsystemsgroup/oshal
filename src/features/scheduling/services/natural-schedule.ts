/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Deterministic natural-language -> schedule parser. Before this, nothing in the tree turned "on Tuesday" / "every day at 9am" / "tomorrow at noon" into a schedule rule — a schedule's field had to already be a valid cron expression, so the assistant could not create a trigger from a sentence (the exact gap the /build/ guide had to disclose). This is intentionally NOT an LLM: a scheduling primitive must be predictable and unit-pinnable, so it is a bounded rule matcher that emits a 5-field cron plus the two things a bare cron cannot carry — whether the intent is one-shot, and which timezone the clock time is meant in.
 */

/**
 * @description Options that anchor a parse. `now` is the reference instant (injected, never read
 * from the clock inside the parser, so a test is deterministic); `timezone` is the IANA zone the
 * emitted clock time is meant in; `defaultHour` is the hour used when a phrase names a day but no
 * time ("on Tuesday" -> Tuesday at 09:00).
 */
export interface NaturalScheduleOptions {
  now: Date;
  timezone: string;
  defaultHour?: number;
}

/**
 * @description A parsed schedule. `cron` is a 5-field expression interpreted in `timezone`; `once`
 * marks a one-shot intent (fire the next matching occurrence, then stop) versus a recurring rule;
 * `description` is a plain-language echo for a confirmation message.
 */
export interface ParsedSchedule {
  cron: string;
  once: boolean;
  timezone: string;
  description: string;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const DOW_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Words that flip an otherwise one-shot day reference into a recurring rule. */
const RECURRING_RE = /\b(every|each|weekly|daily|monthly|recurring|always)\b/;

/** A time-of-day found in the phrase: 24h hour + minute, and whether the phrase stated it at all. */
interface TimeOfDay { hour: number; minute: number; explicit: boolean; }

/**
 * @description Extracts a time of day from a phrase. Handles "9am", "9:30 pm", "17:00", "at 5",
 * "noon", "midnight". Returns the default hour (unset minute) when the phrase names no time, so a
 * day-only phrase still resolves to a concrete clock time.
 */
function parseTimeOfDay(text: string, defaultHour: number): TimeOfDay {
  if (/\bnoon\b/.test(text)) return { hour: 12, minute: 0, explicit: true };
  if (/\bmidnight\b/.test(text)) return { hour: 0, minute: 0, explicit: true };

  // "9am", "9:30pm", "9.30 pm", "at 9", "17:00". The am/pm and the colon minutes are optional.
  const m = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(text);
  if (m) {
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const mer = m[3];
    if (mer === 'pm' && hour < 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
    // A bare "at 5" with no meridiem and an hour that could be either is left as written; a
    // 24h value (>=13 or an explicit :mm) is taken literally. Reject impossible clock values.
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && (mer || m[2] || /\bat\b/.test(text))) {
      return { hour, minute, explicit: true };
    }
  }
  return { hour: defaultHour, minute: 0, explicit: false };
}

/** Calendar parts of an instant AS SEEN in a timezone, so cron day/month fields match local intent. */
function partsInZone(instant: Date, timezone: string): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, mo, d] = fmt.format(instant).split('-').map(Number);
  return { year: y, month: mo, day: d };
}

/** cron for a fixed calendar day (used by one-shot phrases): minute hour day-of-month month *. */
function dayOfMonthCron(t: TimeOfDay, day: number, month: number): string {
  return `${t.minute} ${t.hour} ${day} ${month} *`;
}

const clockLabel = (t: TimeOfDay): string => {
  const h12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  const mer = t.hour < 12 ? 'AM' : 'PM';
  return `${h12}:${String(t.minute).padStart(2, '0')} ${mer}`;
};

/**
 * @description Turns a natural-language time phrase into a schedule rule, or returns null when the
 * text carries no recognizable time intent. Deterministic: identical inputs always yield identical
 * output, and nothing is read from the ambient clock.
 *
 * @param input - The raw phrase, e.g. "on Tuesday" or "every weekday at 5pm".
 * @param opts - Reference instant, timezone, and the fallback hour for day-only phrases.
 * @returns A ParsedSchedule, or null when no schedule could be derived.
 */
export function parseNaturalSchedule(input: string, opts: NaturalScheduleOptions): ParsedSchedule | null {
  const text = String(input || '').toLowerCase().trim();
  if (!text) return null;
  const timezone = opts.timezone;
  const defaultHour = opts.defaultHour ?? 9;
  const recurring = RECURRING_RE.test(text);
  const time = parseTimeOfDay(text, defaultHour);
  const withTz = (cron: string, once: boolean, phrase: string): ParsedSchedule => ({
    cron, once, timezone, description: `${phrase} at ${clockLabel(time)} (${timezone})`,
  });

  // Relative offsets ("in 20 minutes", "in 2 hours") are always one-shot at a concrete instant.
  const rel = /\bin\s+(\d{1,3})\s+(minute|min|hour|hr|day)s?\b/.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs = /^h/.test(rel[2]) ? 3600000 : /^d/.test(rel[2]) ? 86400000 : 60000;
    const at = new Date(opts.now.getTime() + n * unitMs);
    const p = partsInZone(at, timezone);
    // Minute+hour taken from the target instant AS SEEN in the zone.
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
    const [h, mi] = local.split(':').map(Number);
    return { cron: `${mi} ${h} ${p.day} ${p.month} *`, once: true, timezone, description: `in ${n} ${rel[2]}${n === 1 ? '' : 's'} (${timezone})` };
  }

  // "weekdays" / "every weekday" — Monday through Friday, recurring by nature.
  if (/\bweekday|mon(day)?\s*(-|to|through|–)\s*fri(day)?\b/.test(text)) {
    return withTz(`${time.minute} ${time.hour} * * 1-5`, false, 'every weekday');
  }
  if (/\bweekends?\b/.test(text)) {
    return withTz(`${time.minute} ${time.hour} * * 0,6`, false, 'every weekend');
  }

  // A named weekday: "on Tuesday", "every tuesday", "tuesdays", "next tue".
  for (const [word, dow] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${word}s?\\b`).test(text)) {
      const isRecurring = recurring || new RegExp(`\\b${word}s\\b`).test(text);
      if (isRecurring) {
        return withTz(`${time.minute} ${time.hour} * * ${dow}`, false, `every ${DOW_LABEL[dow]}`);
      }
      // Bare "on Tuesday" — the NEXT Tuesday, once. Day-of-week cron resolves the next occurrence;
      // the schedule pauses after it fires (once=true), so it never repeats.
      return withTz(`${time.minute} ${time.hour} * * ${dow}`, true, `this coming ${DOW_LABEL[dow]}`);
    }
  }

  if (/\btomorrow\b/.test(text)) {
    const p = partsInZone(new Date(opts.now.getTime() + 86400000), timezone);
    return { cron: dayOfMonthCron(time, p.day, p.month), once: true, timezone, description: `tomorrow at ${clockLabel(time)} (${timezone})` };
  }
  if (/\btoday\b/.test(text)) {
    const p = partsInZone(opts.now, timezone);
    return { cron: dayOfMonthCron(time, p.day, p.month), once: true, timezone, description: `today at ${clockLabel(time)} (${timezone})` };
  }

  // "every day" / "daily" / "each morning".
  if (/\b(every\s*day|daily|each\s*day|each\s*morning|each\s*evening|every\s*morning|every\s*evening)\b/.test(text)) {
    return withTz(`${time.minute} ${time.hour} * * *`, false, 'every day');
  }

  // "on the 15th" (of every month) or "monthly".
  const dom = /\b(?:on\s+the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/.exec(text);
  if (dom && (recurring || /\bmonth/.test(text) || /\bon the\b/.test(text))) {
    const day = Number(dom[1]);
    if (day >= 1 && day <= 31) return withTz(`${time.minute} ${time.hour} ${day} * *`, false, `every month on the ${day}`);
  }
  if (/\bmonthly\b/.test(text)) {
    return withTz(`${time.minute} ${time.hour} 1 * *`, false, 'every month on the 1st');
  }
  if (/\bweekly\b/.test(text)) {
    return withTz(`${time.minute} ${time.hour} * * 1`, false, 'every Monday');
  }
  if (/\bhourly|every\s*hour\b/.test(text)) {
    return { cron: `${time.explicit ? time.minute : 0} * * * *`, once: false, timezone, description: `every hour (${timezone})` };
  }

  // A bare explicit time with no day context ("at 9am") means daily at that time.
  if (time.explicit) {
    return withTz(`${time.minute} ${time.hour} * * *`, false, 'every day');
  }

  return null;
}
