/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — SHOW TIMELINES:
 *                     |                             | time-synchronized fleet choreography ("at 1:00 be in this
 *                     |                             | formation, at 1:30 move here"). A show is a list of cues,
 *                     |                             | each a formation every drone must occupy AT that second.
 *                     |                             | Pure model + validation here (fence per drone, pairwise
 *                     |                             | separation at every cue AND every transition leg,
 *                     |                             | reachability via per-leg speed solve, launch-window fit);
 *                     |                             | execution lives in FleetShowRunner. Drafts never fly.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | MIXED-PRESENCE timelines: cues no longer
 *                     |                             | require the same drone set — each drone follows its OWN
 *                     |                             | schedule, absent drones hold their last slot. Validation
 *                     |                             | rewritten as an interval sweep with carry-forward positions
 *                     |                             | (movers = 2-pt legs, holders = points, same separation
 *                     |                             | gate; per-drone launch + reachability windows).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Slots may carry a camera arrival action
 *                     |                             | (photo/record/stop/aim at the slot). validateRetask —
 *                     |                             | the LIVE-retask gate: same interval sweep, but carry-
 *                     |                             | forward starts from live positions, cue times are seconds
 *                     |                             | from acceptance, and drones cannot be added mid-show.
 */

import type { CameraAction, GeoPoint, Geofence } from '../model/drone-types';
import { haversineM, validatePoint, isLedColor, normalizeCameraAction, MAX_SPEED_MPS } from './mission-validator';
import { validateFleetSeparation, MAX_FLEET_ASSIGNMENTS, type FleetAssignment } from './fleet-mission';
import { DRONE_ID_RE } from './drone-fleet';

/** Conservative climb rate for launch-window fitting (the sim climbs at 2.5 m/s). */
const LAUNCH_CLIMB_RATE_MPS = 2.0;
const LAUNCH_MARGIN_S = 5;
const MAX_CUES = 32;
const MAX_SHOW_SECONDS = 900;
const M_PER_DEG_LAT = 111320;

/** One drone's slot in a formation: an absolute WGS-84 position it must occupy at the cue.
 * `headingDeg`/`led`/`camera` are arrival actions — face this way / fire the LED / operate
 * the camera when the slot is hit. */
export interface ShowSlot {
  droneId: string;
  lat: number;
  lon: number;
  alt: number;
  headingDeg?: number;
  led?: string;
  camera?: CameraAction;
}

/** One cue: "AT `at` seconds from show start, the fleet is in this formation." */
export interface ShowCue {
  at: number;
  name?: string;
  slots: ShowSlot[];
}

/**
 * @description A validated, executable show timeline. Stored in `drone_missions.plan` with
 * `kind: 'show'` — the branch predicate that separates it from single plans and fleet plans
 * in the shared table/execute endpoint. Slots are absolute; drafts arrive stage-relative and
 * are absolutized once at draft time.
 */
export interface ShowTimeline {
  kind: 'show';
  name: string;
  cues: ShowCue[];
  /** Return every drone to launch after the last cue (default true). */
  rtlAfterShow: boolean;
}

/** The outcome of normalizing an untrusted show draft. */
export interface ShowDraftResult {
  timeline: ShowTimeline | null;
  errors: string[];
}

/** @returns Whether a stored/incoming plan object is a show timeline. */
export function isShowShape(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  return o.kind === 'show' || (Array.isArray(o.cues) && !Array.isArray((o as Record<string, unknown>).assignments));
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** A point at metric east/north offsets from `center`. */
function offsetPoint(center: GeoPoint, eastM: number, northM: number): { lat: number; lon: number } {
  return {
    lat: center.lat + northM / M_PER_DEG_LAT,
    lon: center.lon + eastM / (M_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180)),
  };
}

/**
 * @description Normalize an untrusted show draft into a typed {@link ShowTimeline}.
 * Idempotent by design (yesterday's fleet-mission lesson): slots may be stage-RELATIVE
 * (`e`/`n` meters from the participants' home centroid — how drafts are authored) or
 * ABSOLUTE (`lat`/`lon` — how stored rows come back for execute-time re-validation).
 * Structural coercion only; geofence/separation/reachability live in
 * {@link validateShowTimeline} so every path faces the same gate.
 * @param raw - The candidate object (already JSON-parsed).
 * @param homesById - Home of every drone referenced (for relative→absolute conversion).
 * @returns The typed timeline, or null plus every shape problem found.
 */
export function normalizeShowDraft(raw: unknown, homesById: Record<string, GeoPoint>): ShowDraftResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { timeline: null, errors: ['show draft is not an object'] };
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.cues) || o.cues.length === 0) {
    return { timeline: null, errors: ['show draft has no cues array'] };
  }
  if (o.cues.length > MAX_CUES) {
    return { timeline: null, errors: [`show has ${o.cues.length} cues — the limit is ${MAX_CUES}`] };
  }
  const errors: string[] = [];
  const participants = new Set<string>();
  for (const c of o.cues) {
    const rec = c as Record<string, unknown>;
    if (rec && Array.isArray(rec.slots)) {
      for (const s of rec.slots) {
        const id = s && typeof s === 'object' ? String((s as Record<string, unknown>).droneId ?? '') : '';
        if (id) participants.add(id);
      }
    }
  }
  const homes = [...participants].map((id) => homesById[id]).filter(Boolean);
  const center: GeoPoint = homes.length
    ? { lat: homes.reduce((s, h) => s + h.lat, 0) / homes.length, lon: homes.reduce((s, h) => s + h.lon, 0) / homes.length, alt: 0 }
    : { lat: 0, lon: 0, alt: 0 };

  const cues: ShowCue[] = [];
  o.cues.forEach((c, k) => {
    if (!c || typeof c !== 'object') { errors.push(`cue ${k + 1} is not an object`); return; }
    const rec = c as Record<string, unknown>;
    const at = num(rec.at);
    if (at === null || at <= 0) { errors.push(`cue ${k + 1} needs a positive "at" seconds`); return; }
    if (!Array.isArray(rec.slots) || rec.slots.length === 0) { errors.push(`cue ${k + 1} has no slots`); return; }
    if (rec.slots.length > MAX_FLEET_ASSIGNMENTS) { errors.push(`cue ${k + 1} has ${rec.slots.length} slots — the limit is ${MAX_FLEET_ASSIGNMENTS}`); return; }
    const slots: ShowSlot[] = [];
    const seen = new Set<string>();
    rec.slots.forEach((s, j) => {
      const sr = (s || {}) as Record<string, unknown>;
      const droneId = typeof sr.droneId === 'string' ? sr.droneId.trim() : '';
      if (!DRONE_ID_RE.test(droneId)) { errors.push(`cue ${k + 1} slot ${j + 1} is missing a valid droneId`); return; }
      if (seen.has(droneId)) { errors.push(`cue ${k + 1} lists drone "${droneId}" twice`); return; }
      seen.add(droneId);
      const alt = num(sr.alt);
      if (alt === null) { errors.push(`cue ${k + 1} slot "${droneId}" is missing a numeric alt`); return; }
      const extras: { headingDeg?: number; led?: string; camera?: CameraAction } = {};
      const heading = num(sr.headingDeg);
      if (heading !== null) extras.headingDeg = ((heading % 360) + 360) % 360;
      if (sr.led !== undefined) {
        const led = String(sr.led).toLowerCase();
        if (led !== 'off' && !isLedColor(led)) { errors.push(`cue ${k + 1} slot "${droneId}": invalid LED color "${led}"`); return; }
        extras.led = led;
      }
      if (sr.camera !== undefined) {
        const { action, errors: camErrors } = normalizeCameraAction(sr.camera);
        if (!action) { camErrors.forEach((e) => errors.push(`cue ${k + 1} slot "${droneId}": ${e}`)); return; }
        extras.camera = action;
      }
      const lat = num(sr.lat);
      const lon = num(sr.lon);
      if (lat !== null && lon !== null) {
        slots.push({ droneId, lat, lon, alt, ...extras });
        return;
      }
      const e = num(sr.e);
      const n = num(sr.n);
      if (e === null || n === null) { errors.push(`cue ${k + 1} slot "${droneId}" needs lat/lon or e/n`); return; }
      const abs = offsetPoint(center, e, n);
      slots.push({ droneId, lat: abs.lat, lon: abs.lon, alt, ...extras });
    });
    cues.push({ at, name: typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim().slice(0, 60) : undefined, slots });
  });
  if (errors.length) return { timeline: null, errors };
  return {
    timeline: {
      kind: 'show',
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 120) : 'Fleet show timeline',
      cues,
      rtlAfterShow: o.rtlAfterShow === undefined ? true : Boolean(o.rtlAfterShow),
    },
    errors: [],
  };
}

/**
 * @description Validate the STAGED OUTRO geometry — the piece the cue/transition sweep does
 * not cover. The conductor returns drones one at a time (lowest final altitude first) while
 * the rest hold their final positions; the runtime RTL guard enforces separation during this,
 * so a timeline that clears the cue sweep but not the outro would validate "executable" and
 * then freeze-fail on the last leg. This models exactly the conductor's staged return: for
 * each returner in lowest-first order, its horizontal return leg (final slot → over its home
 * at cruise altitude) versus every not-yet-returned drone held at its final position.
 * @param finalById - Each roster drone's FINAL position (last slot, or live pos for droppers).
 * @param homesById - Each drone's home (return target).
 * @param roster - Every drone in the show.
 * @param fence - The active geofence (unused for geometry, kept for signature symmetry).
 * @returns Violations; empty means the outro deconflicts.
 */
export function validateOutroSeparation(
  finalById: Record<string, GeoPoint>,
  homesById: Record<string, GeoPoint>,
  roster: string[],
): string[] {
  const errors: string[] = [];
  const ordered = roster.filter((id) => finalById[id] && homesById[id])
    .sort((a, b) => finalById[a].alt - finalById[b].alt);
  for (let i = 0; i < ordered.length; i++) {
    const id = ordered[i];
    const start = finalById[id];
    const home = homesById[id];
    // Horizontal cruise home at the slot altitude (the sim descends only once over home,
    // which is pad-local and exempt). Holders are the not-yet-returned drones.
    const movers = [{ droneId: id, pts: [{ ...start }, { lat: home.lat, lon: home.lon, alt: start.alt }] }];
    const holders = ordered.slice(i + 1).map((h) => ({ droneId: h, pts: [{ ...finalById[h] }] }));
    if (!holders.length) break;
    validateFleetSeparation(pseudo([...movers, ...holders]))
      .forEach((e) => errors.push(`staged outro (return "${id}"): ${e}`));
  }
  return errors;
}

/** Pseudo fleet assignments for one geometry group so shows reuse the SAME separation gate. */
function pseudo(slotsA: Array<{ droneId: string; pts: GeoPoint[] }>): FleetAssignment[] {
  return slotsA.map((s) => ({
    droneId: s.droneId,
    plan: { name: s.droneId, waypoints: s.pts.map((p) => ({ ...p })), speedMps: 8, rtlAfterMission: false },
  }));
}

/** @returns Every droneId appearing anywhere in the timeline (drones may skip cues). */
export function showParticipants(t: ShowTimeline): string[] {
  const ids = new Set<string>();
  for (const c of t.cues) for (const s of c.slots) ids.add(s.droneId);
  return [...ids];
}

/** @returns Each participant's FIRST slot — its launch altitude and earliest deadline. */
export function firstAppearances(t: ShowTimeline): Record<string, { at: number; slot: ShowSlot }> {
  const first: Record<string, { at: number; slot: ShowSlot }> = {};
  for (const c of t.cues) for (const s of c.slots) if (!first[s.droneId]) first[s.droneId] = { at: c.at, slot: s };
  return first;
}

/**
 * @description Full safety validation of a show timeline against the LIVE fleet. Cues are
 * MIXED-PRESENCE: each drone may follow its own schedule — a drone absent from a cue simply
 * holds its last position. Validation is an interval sweep with carry-forward positions:
 * monotonic cue times inside the show cap, per-slot fence compliance around each drone's
 * OWN home, per-drone launch-window fit on its FIRST appearance, per-drone reachability
 * (distance from its last position over its own time window ≤ platform max; slower legs
 * arrive early and hold), and pairwise separation per interval through the same
 * {@link validateFleetSeparation} gate — movers as 2-point legs, holders as points.
 * @param t - The normalized timeline.
 * @param fence - The active geofence.
 * @param homesById - Home of every participating drone.
 * @returns Violations; empty means the show is executable.
 */
export function validateShowTimeline(t: ShowTimeline, fence: Geofence, homesById: Record<string, GeoPoint>): string[] {
  const errors: string[] = [];
  t.cues.forEach((c, k) => {
    if (k > 0 && c.at <= t.cues[k - 1].at) errors.push(`cue ${k + 1} time ${c.at}s does not increase from cue ${k}`);
  });
  if (t.cues[t.cues.length - 1].at > MAX_SHOW_SECONDS) {
    errors.push(`show runs ${t.cues[t.cues.length - 1].at}s — the limit is ${MAX_SHOW_SECONDS}s`);
  }
  const participants = showParticipants(t);
  for (const id of participants) {
    if (!homesById[id]) errors.push(`drone "${id}" is not in the live fleet`);
  }
  if (errors.length) return errors;

  // Fence per slot, centered on each drone's own home.
  t.cues.forEach((c, k) => {
    for (const s of c.slots) {
      validatePoint({ lat: s.lat, lon: s.lon, alt: s.alt }, fence, homesById[s.droneId])
        .forEach((e) => errors.push(`cue ${k + 1} "${c.name ?? ''}" [${s.droneId}]: ${e}`));
    }
  });

  // Launch-window fit PER DRONE: everyone takes off at show start to their first-appearance
  // altitude, so that first cue must leave room for the climb.
  const first = firstAppearances(t);
  for (const id of participants) {
    const minAt = first[id].slot.alt / LAUNCH_CLIMB_RATE_MPS + LAUNCH_MARGIN_S;
    if (first[id].at < minAt) {
      errors.push(`drone "${id}"'s first cue at ${first[id].at}s is too early — climbing to ${first[id].slot.alt}m needs ≥${Math.ceil(minAt)}s`);
    }
  }

  // Interval sweep with carry-forward: before its first cue a drone holds above its own pad
  // at its launch altitude; after any cue it holds its last slot until re-tasked. Per cue,
  // present drones are 2-point legs from their carried position, everyone else is a point.
  const pos: Record<string, GeoPoint> = {};
  const lastAt: Record<string, number> = {};
  for (const id of participants) {
    pos[id] = { lat: homesById[id].lat, lon: homesById[id].lon, alt: first[id].slot.alt };
    lastAt[id] = 0;
  }
  t.cues.forEach((c, k) => {
    const label = k === 0 ? 'launch→cue 1' : `→cue ${k + 1}`;
    const movers = c.slots.map((s) => ({ droneId: s.droneId, pts: [{ ...pos[s.droneId] }, { lat: s.lat, lon: s.lon, alt: s.alt }] }));
    const holders = participants
      .filter((id) => !c.slots.some((s) => s.droneId === id))
      .map((id) => ({ droneId: id, pts: [{ ...pos[id] }] }));
    validateFleetSeparation(pseudo([...movers, ...holders])).forEach((e) => errors.push(`${label}: ${e}`));
    for (const s of c.slots) {
      const window = c.at - lastAt[s.droneId];
      const dist = haversineM(pos[s.droneId], s);
      if (window > 0 && dist / window > MAX_SPEED_MPS) {
        errors.push(`${label} [${s.droneId}]: needs ${(dist / window).toFixed(1)} m/s for ${Math.round(dist)}m in ${window}s — max is ${MAX_SPEED_MPS}`);
      }
      pos[s.droneId] = { lat: s.lat, lon: s.lon, alt: s.alt };
      lastAt[s.droneId] = c.at;
    }
  });

  // Staged-outro sweep (only when the show returns to launch): every drone's FINAL position
  // is where it holds after its last cue. `pos` now carries exactly that.
  if (t.rtlAfterShow) {
    errors.push(...validateOutroSeparation(pos, homesById, participants));
  }
  return errors;
}

/** Minimum seconds of lead time before a retask's first cue — drones need room to react. */
export const MIN_RETASK_LEAD_S = 5;

/**
 * @description Validate a LIVE RETASK against a RUNNING show ("changes on demand"). Cue
 * times are seconds from retask ACCEPTANCE (the conductor restarts its clock), so there is
 * no launch phase to fit — instead: every participant must already be flying in the show
 * (`roster` — adding a drone mid-show is not supported), the first cue must leave
 * {@link MIN_RETASK_LEAD_S} of reaction room, and the interval sweep carries forward from
 * each drone's LIVE position rather than its pad. Roster drones absent from the retask are
 * holders at their live positions in every interval — they keep flying the outro later, so
 * they must stay separated from the new choreography throughout.
 * @param t - The normalized replacement timeline (relative cue times).
 * @param fence - The active geofence.
 * @param homesById - Home of every participating drone (fence frame).
 * @param liveById - LIVE position of every roster drone at validation time.
 * @param roster - Every drone flying in the current show.
 * @returns Violations; empty means the retask is dispatchable.
 */
export function validateRetask(
  t: ShowTimeline,
  fence: Geofence,
  homesById: Record<string, GeoPoint>,
  liveById: Record<string, GeoPoint>,
  roster: string[],
): string[] {
  const errors: string[] = [];
  t.cues.forEach((c, k) => {
    if (k > 0 && c.at <= t.cues[k - 1].at) errors.push(`cue ${k + 1} time ${c.at}s does not increase from cue ${k}`);
  });
  if (t.cues[0].at < MIN_RETASK_LEAD_S) {
    errors.push(`cue 1 at ${t.cues[0].at}s is too soon — a live retask needs ≥${MIN_RETASK_LEAD_S}s of lead time`);
  }
  if (t.cues[t.cues.length - 1].at > MAX_SHOW_SECONDS) {
    errors.push(`retask runs ${t.cues[t.cues.length - 1].at}s — the limit is ${MAX_SHOW_SECONDS}s`);
  }
  const participants = showParticipants(t);
  for (const id of participants) {
    if (!roster.includes(id)) errors.push(`drone "${id}" is not flying in this show — a retask cannot add drones`);
    else if (!liveById[id]) errors.push(`drone "${id}" has no live position`);
    else if (!homesById[id]) errors.push(`drone "${id}" is not in the live fleet`);
  }
  if (errors.length) return errors;

  t.cues.forEach((c, k) => {
    for (const s of c.slots) {
      validatePoint({ lat: s.lat, lon: s.lon, alt: s.alt }, fence, homesById[s.droneId])
        .forEach((e) => errors.push(`retask cue ${k + 1} [${s.droneId}]: ${e}`));
    }
  });

  const pos: Record<string, GeoPoint> = {};
  const lastAt: Record<string, number> = {};
  for (const id of roster) {
    if (liveById[id]) { pos[id] = { ...liveById[id] }; lastAt[id] = 0; }
  }
  t.cues.forEach((c, k) => {
    const label = `retask cue ${k + 1}`;
    const movers = c.slots.map((s) => ({ droneId: s.droneId, pts: [{ ...pos[s.droneId] }, { lat: s.lat, lon: s.lon, alt: s.alt }] }));
    const holders = roster
      .filter((id) => pos[id] && !c.slots.some((s) => s.droneId === id))
      .map((id) => ({ droneId: id, pts: [{ ...pos[id] }] }));
    validateFleetSeparation(pseudo([...movers, ...holders])).forEach((e) => errors.push(`${label}: ${e}`));
    for (const s of c.slots) {
      const window = c.at - lastAt[s.droneId];
      const dist = haversineM(pos[s.droneId], s);
      if (window > 0 && dist / window > MAX_SPEED_MPS) {
        errors.push(`${label} [${s.droneId}]: needs ${(dist / window).toFixed(1)} m/s for ${Math.round(dist)}m in ${window}s — max is ${MAX_SPEED_MPS}`);
      }
      pos[s.droneId] = { lat: s.lat, lon: s.lon, alt: s.alt };
      lastAt[s.droneId] = c.at;
    }
  });

  // Staged-outro sweep across the WHOLE roster (retask participants at their final retask
  // slot, dropped drones still at their live position) — they all fly the outro together.
  if (t.rtlAfterShow) {
    errors.push(...validateOutroSeparation(pos, homesById, roster));
  }
  return errors;
}

/**
 * @description Preset show generator — "Aerial ballet": Launch line → Crescent → Cascade
 * (altitude wave) → V → Bow. Crossing-free by construction: every drone keeps a fixed
 * east-offset lane ≥25m from its neighbors, so horizontal separation holds through every
 * formation and transition; the launch legs (pads sit meters apart) are protected by
 * per-drone altitude layering instead. Cue times auto-fit the climb window. The result
 * still passes {@link validateShowTimeline} like any hand-built timeline — the preset is
 * a convenience, not a bypass.
 * @param drones - Participating drones (id + home), 2–8.
 * @returns A draft-shaped object (relative slots) ready for normalizeShowDraft.
 */
export function generateBalletShow(drones: Array<{ droneId: string; home: GeoPoint }>): { name: string; cues: Array<{ at: number; name: string; slots: Array<{ droneId: string; e: number; n: number; alt: number }> }>; rtlAfterShow: boolean } {
  const n = drones.length;
  const mid = (n - 1) / 2;
  const SPACING = 25;
  const ALT_BASE = 30;
  const ALT_STEP = 11;
  const lane = (i: number): number => (i - mid) * SPACING;
  const layer = (i: number): number => ALT_BASE + i * ALT_STEP;
  const firstAt = Math.ceil(Math.max(...drones.map((_, i) => layer(i))) / LAUNCH_CLIMB_RATE_MPS + 15);
  const at = (k: number): number => firstAt + k * 20;
  const slot = (i: number, e: number, no: number, alt: number): { droneId: string; e: number; n: number; alt: number } =>
    ({ droneId: drones[i].droneId, e, n: no, alt });
  const all = (fn: (i: number) => { droneId: string; e: number; n: number; alt: number }): Array<{ droneId: string; e: number; n: number; alt: number }> =>
    drones.map((_, i) => fn(i));
  return {
    name: `Aerial ballet (${n} drones)`,
    cues: [
      { at: at(0), name: 'Launch line', slots: all((i) => slot(i, lane(i), 0, layer(i))) },
      { at: at(1), name: 'Crescent', slots: all((i) => slot(i, lane(i), 40 - 4 * (i - mid) * (i - mid), layer(i))) },
      { at: at(2), name: 'Cascade', slots: all((i) => slot(i, lane(i), 40 - 4 * (i - mid) * (i - mid), layer((i + 1) % n))) },
      { at: at(3), name: 'V formation', slots: all((i) => slot(i, lane(i), -Math.abs(i - mid) * 20, 45)) },
      // The Bow sits 25m north of the pad line AND keeps each drone on its own altitude layer,
      // so the staged outro (lowest-first, one at a time) returns each drone with ≥ a full
      // layer of vertical clearance from every holder — the outro deconflicts by construction
      // (validateOutroSeparation passes), not just by the runtime guard catching it.
      { at: at(4), name: 'Bow', slots: all((i) => slot(i, lane(i), 25, layer(i))) },
    ],
    rtlAfterShow: true,
  };
}
