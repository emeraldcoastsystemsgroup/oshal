/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards two defects in the cockpit calendar's create path, both found in the 2026-08-09 fact-check. (1) DEAD BUTTON: _hasEnabledSchedulerTool compared `toolId`/`id` (UUIDs) against the string "agent-scheduler", so it never matched and schedulerReadyAgents was permanently empty — the create button was disabled forever. It must match the tool NAME and require AUTO (the mode the runtime dispatch gate requires). (2) OFF-BY-ONE: the date input value was parsed with `new Date("YYYY-MM-DD")` (UTC midnight) and then read with getDate/getDay (local), so in any negative-UTC-offset zone the day shifted back one and "Tuesday" compiled to Monday. The methods are pure, so this calls them straight off the prototype — no DOM, no stack — and asserts CALLS, not source substrings.
 */
import { describe, expect, it } from 'vitest';
// The real cockpit view module. The two methods under test use neither `this` nor the DOM, so they
// are invoked directly off the prototype — this exercises the shipped code, not a copy of it.
import { CalendarView } from '../../src/pages/cockpit/js/views/CalendarView.js';

const proto = CalendarView.prototype as unknown as {
  _hasEnabledSchedulerTool(payload: unknown): boolean;
  _localDate(value: string): Date;
};
const hasScheduler = (payload: unknown) => proto._hasEnabledSchedulerTool.call(null, payload);
const localDate = (value: string) => proto._localDate.call(null, value);

describe('calendar create-button enablement', () => {
  it('enables only when the agent-scheduler tool is present AND set to AUTO', () => {
    expect(hasScheduler({ tools: [{ name: 'agent-scheduler', authMode: 'auto' }] })).toBe(true);
    // ASK is not sufficient — the runtime dispatch gate requires AUTO, so offering an ASK bot as
    // ready would let the user create a schedule the runner then refuses to fire.
    expect(hasScheduler({ tools: [{ name: 'agent-scheduler', authMode: 'ask' }] })).toBe(false);
    expect(hasScheduler({ tools: [{ name: 'agent-scheduler', authMode: 'off' }] })).toBe(false);
    expect(hasScheduler({ tools: [{ name: 'some-other-tool', authMode: 'auto' }] })).toBe(false);
  });

  it('matches the tool NAME, not the UUID id — the exact shape of the dead-button bug', () => {
    // The response carries `id`/`toolId` as UUIDs and the name on `name`. Matching the id against
    // the literal "agent-scheduler" (the original bug) can never be true, so this must be false...
    expect(hasScheduler({ tools: [{ id: 'a-uuid', toolId: 'a-uuid', authMode: 'auto' }] })).toBe(false);
    // ...and the same tool identified by name must be true.
    expect(hasScheduler({ tools: [{ id: 'a-uuid', name: 'agent-scheduler', authMode: 'auto' }] })).toBe(true);
  });

  it('reads the nested tool shape too', () => {
    expect(hasScheduler({ tools: [{ tool: { name: 'agent-scheduler', authMode: 'auto' }, authMode: 'auto' }] })).toBe(true);
  });
});

describe('calendar date-to-cron is off-by-one-proof', () => {
  it('reads the calendar day the user picked, in local time', () => {
    // 2026-08-11 is a Tuesday. Building from parts always yields that day and that weekday,
    // regardless of the host timezone.
    const d = localDate('2026-08-11');
    expect(d.getDate()).toBe(11);
    expect(d.getMonth()).toBe(7); // August (0-indexed)
    expect(d.getDay()).toBe(2);   // Tuesday
  });

  it('does not drift the way a naive UTC parse would on this host', () => {
    // The bug: `new Date("YYYY-MM-DD")` parses UTC midnight, then getDate() reads local. On any
    // negative-UTC-offset host that day is the PREVIOUS calendar day. _localDate must not drift.
    for (const iso of ['2026-08-11', '2026-01-01', '2026-12-31', '2026-03-01']) {
      const [y, m, day] = iso.split('-').map(Number);
      const local = localDate(iso);
      expect(local.getFullYear(), iso).toBe(y);
      expect(local.getMonth() + 1, iso).toBe(m);
      expect(local.getDate(), iso).toBe(day);
    }
  });
});
