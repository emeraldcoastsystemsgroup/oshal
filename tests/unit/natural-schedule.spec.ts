/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the natural-language schedule parser. This is the primitive that lets "on Tuesday" become a trigger, so it is pinned hard: the cron field, the one-shot vs recurring decision, and the timezone are each asserted, and every emitted cron is fed to the SAME cron library the runtime uses so a rule that would not parse can never ship. The recurring/one-shot distinction ("on Tuesday" once vs "every Tuesday" recurring) is the load-bearing behavior — a mutation that collapses it turns these red.
 */
import { describe, expect, it } from 'vitest';
import { CronExpressionParser } from 'cron-parser';
import { parseNaturalSchedule } from '../../src/features/scheduling/services/natural-schedule';

// A fixed reference instant so every case is deterministic. 2026-08-09 is a Sunday.
const NOW = new Date('2026-08-09T12:00:00Z');
const TZ = 'America/Chicago';
const parse = (text: string) => parseNaturalSchedule(text, { now: NOW, timezone: TZ });

/** The concrete next fire of a parsed rule, in the parser's own timezone — used to prove intent. */
function nextFire(cron: string, tz: string, from = NOW): Date {
  return CronExpressionParser.parse(cron, { currentDate: from, tz }).next().toDate();
}

describe('natural-schedule: recognizes intent, or honestly returns null', () => {
  it('returns null for text with no time intent', () => {
    expect(parse('order flowers for the anniversary')).toBeNull();
    expect(parse('hello there')).toBeNull();
    expect(parse('')).toBeNull();
  });

  it('every emitted cron parses under the runtime cron library', () => {
    const phrases = [
      'on tuesday', 'every tuesday', 'tuesdays', 'every weekday', 'weekends',
      'every day at 9am', 'daily', 'tomorrow at noon', 'today at 5pm',
      'on the 15th', 'monthly', 'weekly', 'every hour', 'at 9:30pm', 'in 2 hours',
    ];
    for (const p of phrases) {
      const r = parse(p);
      expect(r, `"${p}" should parse`).not.toBeNull();
      expect(() => CronExpressionParser.parse(r!.cron, { tz: r!.timezone }).next(), `"${p}" -> ${r!.cron}`).not.toThrow();
    }
  });
});

describe('natural-schedule: one-shot vs recurring is the load-bearing distinction', () => {
  it('"on Tuesday" is a one-shot on the NEXT Tuesday', () => {
    const r = parse('on tuesday')!;
    expect(r.once).toBe(true);
    const fire = nextFire(r.cron, r.timezone);
    expect(fire.getUTCDay() === 2 || fire.getUTCDay() === 3).toBe(true); // Tue local ~ Tue/early-Wed UTC
    // The next Tuesday after Sunday 2026-08-09 is 2026-08-11.
    expect(r.cron).toContain('* * 2');
  });

  it('"every Tuesday" and the plural "tuesdays" are recurring', () => {
    expect(parse('every tuesday')!.once).toBe(false);
    expect(parse('tuesdays')!.once).toBe(false);
    // Same weekday cron, different one-shot flag — that flag is the whole difference.
    expect(parse('every tuesday')!.cron).toBe(parse('tuesdays')!.cron);
    expect(parse('on tuesday')!.cron).toBe(parse('every tuesday')!.cron);
    expect(parse('on tuesday')!.once).not.toBe(parse('every tuesday')!.once);
  });

  it('"tomorrow" and "in N hours" are one-shot; "every day" and "weekdays" are not', () => {
    expect(parse('tomorrow at 3pm')!.once).toBe(true);
    expect(parse('in 2 hours')!.once).toBe(true);
    expect(parse('every day at 9am')!.once).toBe(false);
    expect(parse('every weekday at 5pm')!.once).toBe(false);
  });
});

describe('natural-schedule: clock time lands where the words say, in the given timezone', () => {
  it('carries the timezone through unchanged', () => {
    expect(parse('every day at 9am')!.timezone).toBe(TZ);
    expect(parseNaturalSchedule('daily', { now: NOW, timezone: 'Europe/London' })!.timezone).toBe('Europe/London');
  });

  it('"every day at 9am" fires at 09:00 Chicago, not 09:00 UTC', () => {
    const r = parse('every day at 9am')!;
    expect(r.cron).toBe('0 9 * * *');
    const fire = nextFire(r.cron, r.timezone);
    // 09:00 America/Chicago in August (CDT, UTC-5) == 14:00 UTC. A timezone-blind parser would
    // have emitted the same cron but fired at 09:00 UTC — this is the assertion that fails then.
    expect(fire.getUTCHours()).toBe(14);
  });

  it('parses am/pm, 24h, noon and midnight', () => {
    expect(parse('daily at 9:30pm')!.cron).toBe('30 21 * * *');
    expect(parse('every day at 17:00')!.cron).toBe('0 17 * * *');
    expect(parse('every day at noon')!.cron).toBe('0 12 * * *');
    expect(parse('every day at midnight')!.cron).toBe('0 0 * * *');
  });

  it('a day-only phrase defaults to 9:00, and the default is overridable', () => {
    expect(parse('on tuesday')!.cron).toBe('0 9 * * 2');
    expect(parseNaturalSchedule('on tuesday', { now: NOW, timezone: TZ, defaultHour: 7 })!.cron).toBe('0 7 * * 2');
  });
});

describe('natural-schedule: the common recurring shapes', () => {
  it('maps the everyday English to the right cron', () => {
    expect(parse('every weekday at 8am')!.cron).toBe('0 8 * * 1-5');
    expect(parse('weekends at 10am')!.cron).toBe('0 10 * * 0,6');
    expect(parse('every day')!.cron).toBe('0 9 * * *');
    expect(parse('on the 15th')!.cron).toBe('0 9 15 * *');
    expect(parse('monthly at 6am')!.cron).toBe('0 6 1 * *');
  });

  it('a bare explicit time with no day means daily', () => {
    const r = parse('at 7am')!;
    expect(r.once).toBe(false);
    expect(r.cron).toBe('0 7 * * *');
  });

  it('is deterministic — same input, same output', () => {
    expect(JSON.stringify(parse('every tuesday at 9am'))).toBe(JSON.stringify(parse('every tuesday at 9am')));
  });

  it('produces a human-readable description naming the time and zone', () => {
    const r = parse('every tuesday at 9am')!;
    expect(r.description).toContain('Tuesday');
    expect(r.description).toContain('9:00 AM');
    expect(r.description).toContain(TZ);
  });
});
