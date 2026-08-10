/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the assistant's scheduling detector. Two failure modes are pinned. FALSE POSITIVE: an ordinary sentence that merely mentions a day ("I saw her on Tuesday", "what reminders do I have?") must NOT become a reminder — this is the dangerous direction, because a hijacked chat turn silently schedules something. TRUE POSITIVE: the headline example "On Tuesday, order flowers for the anniversary" and the explicit "remind me ..." forms must resolve to the right cron, the right one-shot/recurring flag, and a clean action with the time scaffolding stripped. The leading-time-vs-mid-sentence distinction is the load-bearing rule and has its own case.
 */
import { describe, expect, it } from 'vitest';
import { detectScheduleIntent } from '../../src/app/routes/jarvis-schedule-intent';

const NOW = new Date('2026-08-09T12:00:00Z'); // a Sunday
const TZ = 'America/Chicago';
const detect = (m: string) => detectScheduleIntent(m, { now: NOW, timezone: TZ });

describe('jarvis schedule intent: does not hijack ordinary chat', () => {
  it('ignores a day mentioned mid-sentence (narrative, not imperative)', () => {
    expect(detect('I saw her on Tuesday')).toBeNull();
    expect(detect('we met last Tuesday at the park')).toBeNull();
    expect(detect('the meeting on Friday went well')).toBeNull();
  });

  it('ignores questions, even when they mention scheduling words', () => {
    expect(detect('what reminders do I have?')).toBeNull();
    expect(detect('when is my next reminder')).toBeNull();
    expect(detect('what time is it in Tokyo')).toBeNull();
    expect(detect('how do I schedule something')).toBeNull();
  });

  it('ignores a message with no time intent at all', () => {
    expect(detect('order flowers for the anniversary')).toBeNull();
    expect(detect('remind me')).toBeNull(); // a cue but no time and no action
  });
});

describe('jarvis schedule intent: catches real reminders', () => {
  it('the headline example: a bare leading day is a one-shot reminder', () => {
    const r = detect('On Tuesday, order flowers for the anniversary')!;
    expect(r).not.toBeNull();
    expect(r.once).toBe(true);
    expect(r.cron).toBe('0 9 * * 2');
    expect(r.action).toBe('order flowers for the anniversary');
  });

  it('"remind me to X every day at 8am" is recurring with a clean action', () => {
    const r = detect('remind me to take my medication every day at 8am')!;
    expect(r.once).toBe(false);
    expect(r.cron).toBe('0 8 * * *');
    expect(r.action).toContain('take my medication');
    expect(r.action).not.toContain('every');
    expect(r.action).not.toContain('8am');
  });

  it('"every Monday at 9 send me the weekly plan" is recurring', () => {
    const r = detect('every Monday at 9am send me the weekly plan')!;
    expect(r.once).toBe(false);
    expect(r.cron).toBe('0 9 * * 1');
    expect(r.action).toContain('send me the weekly plan');
  });

  it('"tomorrow at 3pm call the dentist" is one-shot', () => {
    const r = detect('tomorrow at 3pm call the dentist')!;
    expect(r.once).toBe(true);
    expect(r.action).toContain('call the dentist');
    expect(r.cron.startsWith('0 15 ')).toBe(true);
  });

  it('an explicit "schedule" cue works mid-sentence', () => {
    const r = detect('schedule a daily 7am summary of my inbox')!;
    expect(r.once).toBe(false);
    expect(r.cron).toBe('0 7 * * *');
    expect(r.action).toContain('summary of my inbox');
  });

  it('carries the timezone through to the intent', () => {
    expect(detect('every day at 9am send news')!.timezone).toBe(TZ);
  });
});
