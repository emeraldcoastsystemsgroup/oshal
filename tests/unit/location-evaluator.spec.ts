/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L5 done-when, the pure half: scripted fix sequences through the presence stepper and the fire decision. Edge jitter (inside, just outside, inside again) enters once and never flaps; a pending exit is cancelled by any fix that is not confidently outside; exit needs three minutes confidently outside; the first determination from unknown is a baseline that never fires; cooldown, once versus every visit and the rule's direction hold; a fix received more than 120 s before evaluation, observed more than 120 s before receipt, with no accuracy or worse than the floor changes nothing; two inside fixes received under 30 s apart do not enter, however far apart their client-reported times are. Synthetic coordinates only.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_TRACK_STATE, LOCATION_EVALUATION, confidentlyOutside, exitMarginM, fireDecision, fixVerdict, stepPresence,
  type LocationFireCounters, type LocationFireParams, type LocationFixSample, type LocationTrackState,
} from '@/app/location-evaluator';
import { EARTH_RADIUS_M } from '@/shared/utils/geo';

const CENTER = { lat: -12.3464, lon: -31.9884 };
const PLACE = { center: CENTER, radiusM: 100 };
const DEG_PER_M = 180 / (Math.PI * EARTH_RADIUS_M);
const north = (m: number) => ({ lat: CENTER.lat + m * DEG_PER_M, lon: CENTER.lon });
const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);

/** A fix `m` metres north of the centre received at `t`, observed at the same time unless given. */
function fix(m: number, t: number, extra: Partial<LocationFixSample> = {}): LocationFixSample {
  return { point: north(m), accuracyM: 10, receivedAtMs: t, observedAtMs: t, ...extra };
}

/** Run a script of fixes through one rule; report each step's change and whether the rule fired. */
function run(script: Array<[number, number]>, params: LocationFireParams, start: LocationTrackState = { ...EMPTY_TRACK_STATE }) {
  let state = start;
  const counters: LocationFireCounters = { fireCount: 0, lastFireMs: null };
  const events: string[] = [];
  for (const [metres, seconds] of script) {
    const t = T0 + seconds * 1000;
    const step = stepPresence(state, fix(metres, t), PLACE, 50, t);
    const decision = fireDecision(step, params, counters, t);
    if (decision === 'fire') { counters.fireCount += 1; counters.lastFireMs = t; }
    if (step.change) events.push(`${seconds}:${step.change}${step.baseline ? '(baseline)' : ''}${decision === 'fire' ? ':fire' : ''}`);
    state = step.state;
  }
  return { events, state, counters };
}

const ENTER_ONCE: LocationFireParams = { on: 'enter', repeat: 'once', cooldownMs: 900_000 };
const ENTER_EVERY: LocationFireParams = { on: 'enter', repeat: 'every-visit', cooldownMs: 900_000 };

describe('fix qualification (server receipt time decides)', () => {
  it('needs an accuracy within the floor, a fresh receipt, and an observation not back-dated', () => {
    expect(fixVerdict(fix(0, T0), 50, T0)).toBe('qualifies');
    expect(fixVerdict(fix(0, T0, { accuracyM: null }), 50, T0)).toBe('no-accuracy');
    expect(fixVerdict(fix(0, T0, { accuracyM: 51 }), 50, T0)).toBe('inaccurate');
    expect(fixVerdict(fix(0, T0), 50, T0 + 120_001)).toBe('stale');
    expect(fixVerdict(fix(0, T0), 50, T0 + 120_000)).toBe('qualifies');
    expect(fixVerdict(fix(0, T0, { observedAtMs: T0 - 120_001 }), 50, T0)).toBe('back-dated');
  });

  it('a client-reported observation time never makes an old receipt fresh', () => {
    expect(fixVerdict(fix(0, T0, { observedAtMs: T0 + 300_000 }), 50, T0 + 300_000)).toBe('stale');
  });

  it('a non-qualifying fix changes nothing, even deep inside the place', () => {
    const step = stepPresence({ ...EMPTY_TRACK_STATE }, fix(0, T0, { accuracyM: 80 }), PLACE, 50, T0);
    expect(step).toMatchObject({ change: null, verdict: 'inaccurate', state: EMPTY_TRACK_STATE });
  });
});

describe('enter: two qualifying inside fixes at least 30 s apart by receipt', () => {
  it('does not enter on two fixes received 29 s apart, whatever their observed times say', () => {
    const first = stepPresence({ ...EMPTY_TRACK_STATE, presence: 'outside' }, fix(0, T0, { observedAtMs: T0 - 60_000 }), PLACE, 50, T0);
    const second = stepPresence(first.state, fix(10, T0 + 29_000, { observedAtMs: T0 + 29_000 }), PLACE, 50, T0 + 29_000);
    expect(second.change).toBeNull();
    const third = stepPresence(second.state, fix(5, T0 + 30_000), PLACE, 50, T0 + 30_000);
    expect(third.change).toBe('enter');
  });

  it('the first determination from unknown is a baseline and never fires', () => {
    expect(run([[0, 0], [0, 30]], ENTER_ONCE).events).toEqual(['30:enter(baseline)']);
    expect(run([[1000, 0]], ENTER_ONCE).events).toEqual(['0:exit(baseline)']);
  });
});

describe('a scripted visit: approach, edge jitter, dwell, leave, return', () => {
  const visit: Array<[number, number]> = [
    [2000, 0],                // far away: outside baseline
    [95, 60], [105, 75], [98, 95], [99, 125], // edge jitter while arriving: candidate resets on the outside fix, then enters once
    [110, 160], [99, 200], [140, 230], [60, 260], // jitter at the edge while inside: no exit, no second enter
    [400, 300], [400, 360], [80, 400],   // confidently out for 100 s, then back: the exit is cancelled
    [400, 500], [400, 600], [400, 680],  // out for 180 s: exit
    [0, 700], [0, 730],                  // back 30 s later: enter, but inside the 15 min cooldown
  ];

  it('enters once through edge jitter, holds through a short absence, exits after 3 min, and cooldown blocks the quick return', () => {
    const { events } = run(visit, ENTER_EVERY);
    expect(events).toEqual(['0:exit(baseline)', '125:enter:fire', '680:exit', '730:enter']);
  });

  it('every visit fires again once the cooldown has passed', () => {
    const later: Array<[number, number]> = [...visit, [400, 800], [400, 900], [400, 1000], [0, 1700], [0, 1730]];
    expect(run(later, ENTER_EVERY).events).toEqual(['0:exit(baseline)', '125:enter:fire', '680:exit', '730:enter', '1000:exit', '1730:enter:fire']);
  });

  it('a once rule fires on the first real arrival only', () => {
    const later: Array<[number, number]> = [...visit, [400, 800], [400, 900], [400, 1000], [0, 1700], [0, 1730]];
    const { events, counters } = run(later, ENTER_ONCE);
    expect(events.filter((e) => e.endsWith(':fire'))).toEqual(['125:enter:fire']);
    expect(counters.fireCount).toBe(1);
  });

  it('an exit rule fires on leaving, never on arriving', () => {
    const { events } = run(visit, { on: 'exit', repeat: 'every-visit', cooldownMs: 0 });
    expect(events).toEqual(['0:exit(baseline)', '125:enter', '680:exit:fire', '730:enter']);
  });
});

describe('exit hysteresis geometry', () => {
  it('uses max(50 m, 25 % of the radius) as the margin, net of the fix accuracy', () => {
    expect(exitMarginM(100)).toBe(50);
    expect(exitMarginM(400)).toBe(100);
    expect(confidentlyOutside(PLACE, north(161), 10)).toBe(true);
    expect(confidentlyOutside(PLACE, north(159), 10)).toBe(false);
    expect(confidentlyOutside(PLACE, north(200), 45)).toBe(true);
    expect(confidentlyOutside(PLACE, north(190), 45)).toBe(false);
  });

  it('the D4 constants are the ones the ADR names', () => {
    expect(LOCATION_EVALUATION).toMatchObject({ maxFixAgeMs: 120_000, enterSpacingMs: 30_000, exitDwellMs: 180_000, defaultAccuracyFloorM: 50, defaultCooldownSec: 900 });
  });
});
