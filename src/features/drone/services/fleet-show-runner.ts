/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the show CONDUCTOR
 *                     |                             | (ADR-098/099: flight is deterministic controller code;
 *                     |                             | drones stay dumb executors, exactly like real drone light
 *                     |                             | shows). At each cue boundary it dispatches simultaneous
 *                     |                             | per-drone gotos with speed solved so every drone arrives
 *                     |                             | AT the cue time; early arrivals hold in formation. Any
 *                     |                             | member failure freezes the whole show in place. One show
 *                     |                             | at a time; starting is gated by the human Execute.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Mixed-presence timelines: participants
 *                     |                             | = union across cues; everyone launches at show start to
 *                     |                             | their FIRST-appearance altitude and holds until called.
 *                     |                             | Dispatch was already position-based, so per-drone schedules
 *                     |                             | need no dispatch change.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | RUNTIME proximity guard: during the
 *                     |                             | cues phase every tick checks LIVE pairwise separation (not
 *                     |                             | just plan-time) and freezes the show on a breach. Launch and
 *                     |                             | RTL are exempt by design — pad-local geometry (drones climb
 *                     |                             | off pads meters apart) would false-alarm there.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | (1) LIVE RETASK ("changes on demand"):
 *                     |                             | retask() replaces the remainder mid-show — cues phase only,
 *                     |                             | clock restarts at acceptance, roster is fixed at start so
 *                     |                             | dropped drones keep holding + flying the outro. (2) The
 *                     |                             | proximity guard now ALSO covers launch/RTL with pad-aware
 *                     |                             | geometry: a pair is exempt only while BOTH drones are
 *                     |                             | within 3m of their OWN pads (3m < half the 8m pad spacing,
 *                     |                             | so there is no blind spot); off-pad drift re-arms the pair.
 *                     |                             | (3) STAGED OUTRO: the guard immediately exposed that the
 *                     |                             | old everyone-RTLs-at-once outro descends landers through
 *                     |                             | cruisers' altitude bands meters apart — real-show doctrine
 *                     |                             | instead: ONE drone returns+lands at a time (lowest first),
 *                     |                             | holders wait in the validated final formation.
 */

import { createChildLogger } from '@/shared/logger';
import { haversineM, MAX_SPEED_MPS } from './mission-validator';
import { MIN_HORIZONTAL_SEPARATION_M, MIN_VERTICAL_SEPARATION_M } from './fleet-mission';
import { DroneCommandError } from './drone-provider';
import type { DroneService } from './drone-service';
import { showParticipants, firstAppearances, type ShowTimeline } from './fleet-show';

const logger = createChildLogger({ module: 'fleet-show-runner' });

const DEFAULT_TICK_MS = 500;
/** Seconds of slack after the final cue before the outro (RTL) begins. */
const SETTLE_S = 3;
/** How close (m) a drone must be to its first-cue altitude to count as launched. */
const LAUNCH_ALT_TOLERANCE_M = 2;
/** Launch overrun allowance past cue 1 before the show fails safe. */
const LAUNCH_OVERRUN_S = 10;
const MIN_DISPATCH_SPEED_MPS = 1;
/** A drone is "over its own pad" within this horizontal radius of its home. MUST stay under
 * half the embedded-sim pad spacing (8m) or two pad-local drones could meet in the blind spot. */
const PAD_LOCAL_RADIUS_M = 3;
/** The pad-local exemption is only safe when the two pads are far enough apart that being
 * pad-local means being physically clear. Below this home spacing the exemption is refused
 * and the real guard runs — so two remote nodes that declare near-identical homes can't hide
 * a genuine collision behind "both over their pads". */
const MIN_EXEMPT_HOME_SPACING_M = 2 * PAD_LOCAL_RADIUS_M;
/** Per-roster-drone budget for the staged outro before the conductor releases control. A
 * grounded-but-not-disarmed MAVLink returner (auto-disarm off) would otherwise stall it forever. */
const RTL_PER_DRONE_S = 200;

export type ShowPhase = 'idle' | 'launch' | 'cues' | 'rtl' | 'complete' | 'stopped' | 'failed';

/** Point-in-time snapshot for the surface's show strip. */
export interface ShowStatus {
  active: boolean;
  phase: ShowPhase;
  name: string | null;
  elapsedS: number;
  /** Index (1-based) of the cue currently being formed, 0 before launch completes. */
  formingCue: number;
  totalCues: number;
  nextCueAt: number | null;
  nextCueName: string | null;
  drones: string[];
  reason: string | null;
}

/**
 * @description Executes ONE {@link ShowTimeline} against the live fleet. The runner owns
 * timing only — every actuation goes through {@link DroneService}, so the geofence gate and
 * the hardware confirm rail apply to each dispatched command exactly as they do to manual
 * flying. Failure doctrine: any member rejection freezes the whole show (retarget-in-place
 * → every drone holds where it is) rather than letting the formation shear.
 */
export class FleetShowRunner {
  private readonly drone: DroneService;
  private readonly clock: () => number;
  private readonly tickMs: number;
  private readonly autoTick: boolean;

  private timeline: ShowTimeline | null = null;
  private phase: ShowPhase = 'idle';
  private t0 = 0;
  private confirm = false;
  /** Every drone flying in this show — fixed at start(); a retask can NEVER grow it. */
  private roster: string[] = [];
  /** Index of the cue whose legs have been dispatched (drones flying toward it). */
  private flyingToCue = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reason: string | null = null;
  /** When the rtl phase began (wall clock) — bounds the staged outro against a wedged returner. */
  private rtlStartMs = 0;
  /** Serialization chain: ticks and commands (retask/stop) run one-at-a-time. With remote
   * drones every goto/RTL is real network I/O, so a tick suspended mid-dispatch could otherwise
   * interleave with a retask that mutates timeline/t0/flyingToCue out from under it. */
  private lock: Promise<unknown> = Promise.resolve();
  private locked = false;

  constructor(drone: DroneService, opts: { clock?: () => number; tickMs?: number; autoTick?: boolean } = {}) {
    this.drone = drone;
    this.clock = opts.clock ?? ((): number => Date.now());
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.autoTick = opts.autoTick ?? true;
  }

  private get participants(): string[] {
    return this.roster;
  }

  private get active(): boolean {
    return this.phase === 'launch' || this.phase === 'cues' || this.phase === 'rtl';
  }

  /**
   * @description Start a validated timeline — called ONLY from the human-approved execute
   * path. Ground start is required (predictable launch geometry); hardware members need the
   * confirm flag exactly like every other actuation. Launch = arm + takeoff each drone to
   * its first-cue altitude; the cue clock starts NOW, so the timeline's `at` values are
   * seconds from this approval.
   * @param t - The validated timeline.
   * @param opts - The human's hardware confirm.
   */
  async start(t: ShowTimeline, opts: { confirm?: boolean } = {}): Promise<void> {
    if (this.active) throw new DroneCommandError(`a show ("${this.timeline?.name}") is already running — stop it first`);
    const confirm = opts.confirm === true;
    const ids = showParticipants(t);
    const first = firstAppearances(t);
    for (const id of ids) {
      const st = this.drone.getState(id); // throws for unknown/offline
      if (st.provider !== 'sim' && !confirm) {
        throw new DroneCommandError(`drone "${id}" is real hardware (${st.provider}) — the show needs confirm:true`);
      }
      if (st.telemetry.status !== 'disarmed' && st.telemetry.status !== 'armed') {
        throw new DroneCommandError(`drone "${id}" is ${st.telemetry.status} — shows start from the ground`);
      }
    }
    this.timeline = t;
    this.roster = ids;
    this.confirm = confirm;
    this.phase = 'launch';
    this.flyingToCue = -1;
    this.rtlStartMs = 0;
    this.reason = null;
    this.t0 = this.clock();
    try {
      // EVERY participant launches at show start to its first-appearance altitude —
      // drones whose first cue comes later simply hold above their pad until called.
      for (const id of ids) {
        if (this.drone.getState(id).telemetry.status === 'disarmed') await this.drone.arm(id);
        await this.drone.takeoff(first[id].slot.alt, id, this.confirm);
      }
    } catch (err) {
      await this.freeze(`launch failed: ${(err as Error).message}`, 'failed');
      throw err;
    }
    logger.info({ name: t.name, drones: this.participants, cues: t.cues.length }, 'Show started — launching');
    if (this.autoTick) {
      this.timer = setInterval(() => { void this.safeTick(); }, this.tickMs);
    }
  }

  /** @description One conductor step. Public so tests drive it on a fake clock. */
  async tick(): Promise<void> {
    if (!this.timeline || !this.active) return;
    const t = this.timeline;
    const now = (this.clock() - this.t0) / 1000;
    try {
      if (this.phase === 'launch') {
        const padBreach = this.checkProximity(true);
        if (padBreach) { await this.freeze(padBreach, 'failed'); return; }
        // Ready == every drone has finished its climb and is HOLDING. It is NOT enough to be
        // within altitude tolerance: dispatchCue issues a goto, and a provider rejects a goto
        // while the drone is still in 'takeoff' ("cannot fly to a point while takeoff"). The
        // status flip to 'hold' IS the takeoff-complete signal — gate on exactly that.
        const first = firstAppearances(t);
        const ready = this.participants.every((id) => {
          const tel = this.drone.getState(id).telemetry;
          return tel.status === 'hold' && Math.abs(tel.position.alt - first[id].slot.alt) <= LAUNCH_ALT_TOLERANCE_M;
        });
        if (ready) {
          await this.dispatchCue(0);
          this.phase = 'cues';
        } else if (now > t.cues[0].at + LAUNCH_OVERRUN_S) {
          await this.freeze('launch overran the first cue window', 'failed');
        }
        return;
      }
      if (this.phase === 'cues') {
        const breach = this.checkProximity(false);
        if (breach) { await this.freeze(breach, 'failed'); return; }
        const reachedAll = this.flyingToCue >= t.cues.length - 1;
        if (!reachedAll && now >= t.cues[this.flyingToCue].at) {
          await this.dispatchCue(this.flyingToCue + 1);
          return;
        }
        if (reachedAll && now >= t.cues[t.cues.length - 1].at + SETTLE_S) {
          if (t.rtlAfterShow) {
            this.phase = 'rtl';
          } else {
            this.finish('complete');
          }
        }
        return;
      }
      if (this.phase === 'rtl') {
        if (!this.rtlStartMs) this.rtlStartMs = this.clock();
        const rtlBreach = this.checkProximity(true);
        if (rtlBreach) { await this.freeze(rtlBreach, 'failed'); return; }
        // STAGED OUTRO: one drone returns and lands at a time (lowest altitude first —
        // it lands fastest), everyone else holds the validated final formation. An
        // all-at-once RTL descends landers straight through cruisers' altitude bands
        // over pads meters apart — the guard above catches exactly that, so the
        // conductor must never create it.
        const flying = this.participants.filter((id) => this.drone.getState(id).telemetry.status !== 'disarmed');
        if (!flying.length) { this.finish('complete'); return; }
        // Overrun guard: a MAVLink drone can sit on the ground reporting 'returning' (auto-disarm
        // off) and stall the outro forever. Release control after a generous per-drone budget.
        if ((this.clock() - this.rtlStartMs) / 1000 > this.roster.length * RTL_PER_DRONE_S) {
          logger.warn({ name: t.name, stillFlying: flying }, 'Show outro overran — releasing conductor (vehicle failsafes remain)');
          this.finish('complete');
          return;
        }
        const returning = flying.some((id) => {
          const s = this.drone.getState(id).telemetry.status;
          return s === 'returning' || s === 'landing';
        });
        if (!returning) {
          const next = [...flying].sort((a, b) =>
            this.drone.getState(a).telemetry.position.alt - this.drone.getState(b).telemetry.position.alt)[0];
          await this.drone.returnToLaunch(next);
          logger.info({ name: t.name, droneId: next, waiting: flying.length - 1 }, 'Show outro — staged RTL dispatched');
        }
      }
    } catch (err) {
      await this.freeze(`show failed at t+${Math.round(now)}s: ${(err as Error).message}`, 'failed');
    }
  }

  /**
   * @description Freeze-the-show: stop the timeline and retarget every airborne member to
   * its CURRENT position (an in-place goto = hold now). Safety action — never throws.
   * @param reason - Human-readable cause, surfaced in status.
   */
  async stop(reason: string): Promise<void> {
    await this.exclusive(async () => {
      if (!this.active) return;
      await this.freeze(reason, 'stopped');
    });
  }

  /**
   * @description LIVE RETASK ("changes on demand"): replace the REMAINDER of the running
   * show with a validated new cue list — no stop → edit → re-execute round trip. Only legal
   * during the cues phase: launch geometry is unstable and RTL means the show is already
   * over. The show clock RESTARTS at acceptance — the new timeline's `at` values are seconds
   * from NOW — and cue 1 dispatches immediately with arrival solved for its timestamp.
   * Roster drones absent from the new timeline hold where they are and still fly the outro;
   * the caller validated separation for exactly that geometry (validateRetask).
   *
   * Runs under the conductor's serialization lock so a suspended tick can't interleave with
   * the timeline swap, and the phase is re-checked INSIDE the lock (a tick could have moved
   * the show to rtl/failed while this call queued). A real-hardware roster requires a fresh
   * confirm — a retask is a NEW actuation, exactly like every other command on the rail.
   * @param t - The validated replacement timeline (relative cue times).
   * @param opts - The human's hardware confirm (required when any roster drone is non-sim).
   */
  async retask(t: ShowTimeline, opts: { confirm?: boolean } = {}): Promise<void> {
    await this.exclusive(async () => {
      if (this.phase !== 'cues') {
        throw new DroneCommandError(`a retask needs a show in the cues phase — this one is ${this.phase}`);
      }
      const confirm = opts.confirm === true;
      for (const id of showParticipants(t)) {
        if (!this.roster.includes(id)) {
          throw new DroneCommandError(`drone "${id}" is not flying in this show — a retask cannot add drones`);
        }
      }
      // A retask actuates the roster afresh — hardware members need the confirm rail again.
      for (const id of this.roster) {
        if (this.drone.getState(id).provider !== 'sim' && !confirm) {
          throw new DroneCommandError(`drone "${id}" is real hardware — a live retask needs confirm:true`);
        }
      }
      this.confirm = confirm;
      // From here we mutate flight state; any dispatch failure must freeze the show, never
      // leave it half-retasked with flyingToCue=-1 (which the next tick would crash on).
      try {
        // Any roster drone still flying toward an OLD cue but not in the new cue 1 must hold
        // NOW — validateRetask modeled exactly that geometry (holders at live positions), and a
        // stale goto would fly it somewhere the new choreography never accounted for.
        const inCueOne = new Set(t.cues[0].slots.map((s) => s.droneId));
        for (const id of this.roster) {
          if (inCueOne.has(id)) continue;
          const tel = this.drone.getState(id).telemetry;
          if (tel.status === 'enroute') await this.drone.goto({ ...tel.position }, MIN_DISPATCH_SPEED_MPS + 1, id, this.confirm);
        }
        this.timeline = t;
        this.t0 = this.clock();
        this.flyingToCue = -1;
        await this.dispatchCue(0);
      } catch (err) {
        await this.freeze(`retask failed: ${(err as Error).message}`, 'failed');
        throw err;
      }
      logger.info({ name: t.name, cues: t.cues.length, drones: showParticipants(t) }, 'Show retasked live — remainder replaced');
    });
  }

  /** @returns The live snapshot for the surface. */
  status(): ShowStatus {
    const t = this.timeline;
    const forming = this.flyingToCue >= 0 ? Math.min(this.flyingToCue + 1, t?.cues.length ?? 0) : 0;
    const next = t && this.flyingToCue >= 0 && this.flyingToCue < t.cues.length ? t.cues[this.flyingToCue] : null;
    return {
      active: this.active,
      phase: this.phase,
      name: t?.name ?? null,
      elapsedS: this.active || this.phase === 'complete' ? Math.max(0, Math.round((this.clock() - this.t0) / 100) / 10) : 0,
      formingCue: forming,
      totalCues: t?.cues.length ?? 0,
      nextCueAt: next ? next.at : null,
      nextCueName: next ? next.name ?? null : null,
      drones: this.participants,
      reason: this.reason,
    };
  }

  /**
   * @description Live pairwise separation check across the participants — the runtime
   * complement to plan-time validation (drift, wind, or an out-of-band command can breach a
   * plan that validated clean). Breach = closer than 75% of BOTH separation minimums at once.
   * With `exemptPadLocal` (the launch/RTL phases) a pair is skipped ONLY while both drones
   * are within {@link PAD_LOCAL_RADIUS_M} of their OWN pads — vertical climb/descent over
   * neighboring pads is legitimate close geometry; any off-pad drift re-arms the pair.
   * @param exemptPadLocal - Skip pairs where both members are over their own pads.
   * @returns A human-readable breach description, or null when the sky is clean.
   */
  private checkProximity(exemptPadLocal: boolean): string | null {
    const ids = this.participants;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = this.drone.getState(ids[i]).telemetry;
        const b = this.drone.getState(ids[j]).telemetry;
        // The pad-local exemption is only sound when the two pads are far enough apart that
        // being over each drone's OWN pad guarantees physical clearance. Embedded sims sit 8m
        // apart, but a REMOTE node reports its own home in its heartbeat — nothing constrains
        // two nodes from declaring near-identical pads, so only exempt when the homes clear
        // the spacing floor. Otherwise the real guard runs (and freezes on a genuine breach).
        if (exemptPadLocal &&
            haversineM(a.home, b.home) >= MIN_EXEMPT_HOME_SPACING_M &&
            haversineM(a.position, a.home) < PAD_LOCAL_RADIUS_M &&
            haversineM(b.position, b.home) < PAD_LOCAL_RADIUS_M) {
          continue;
        }
        const h = haversineM(a.position, b.position);
        const v = Math.abs(a.position.alt - b.position.alt);
        if (h < MIN_HORIZONTAL_SEPARATION_M * 0.75 && v < MIN_VERTICAL_SEPARATION_M * 0.75) {
          return `proximity breach: "${ids[i]}" and "${ids[j]}" are ${Math.round(h)}m apart with only ${v.toFixed(1)}m vertical separation`;
        }
      }
    }
    return null;
  }

  /** Dispatch every drone toward cue k with arrival solved for the cue's timestamp. */
  private async dispatchCue(k: number): Promise<void> {
    const t = this.timeline!;
    const cue = t.cues[k];
    const now = (this.clock() - this.t0) / 1000;
    const window = Math.max(cue.at - now, 1);
    for (const s of cue.slots) {
      const pos = this.drone.getState(s.droneId).telemetry.position;
      const dist = haversineM(pos, s);
      const speed = Math.min(Math.max(dist / window, MIN_DISPATCH_SPEED_MPS), MAX_SPEED_MPS);
      // Arrival actions (heading/LED/camera) ride the goto target — the engine fires them on arrival.
      await this.drone.goto({
        lat: s.lat, lon: s.lon, alt: s.alt,
        ...(s.headingDeg !== undefined ? { headingDeg: s.headingDeg } : {}),
        ...(s.led !== undefined ? { led: s.led } : {}),
        ...(s.camera !== undefined ? { camera: s.camera } : {}),
      }, speed, s.droneId, this.confirm);
    }
    this.flyingToCue = k;
    logger.info({ cue: k + 1, name: cue.name, at: cue.at, windowS: Math.round(window) }, 'Cue dispatched');
  }

  private async freeze(reason: string, phase: 'stopped' | 'failed'): Promise<void> {
    this.reason = reason;
    for (const id of this.participants) {
      try {
        const tel = this.drone.getState(id).telemetry;
        if (tel.status === 'hold' || tel.status === 'enroute') {
          await this.drone.goto({ ...tel.position }, MIN_DISPATCH_SPEED_MPS + 1, id, this.confirm);
        } else if (tel.status === 'returning') {
          // A returner can't hold-goto; landing in place halts its horizontal convergence.
          await this.drone.land(id);
        }
      } catch (err) {
        logger.error({ err, droneId: id }, 'show freeze — drone did not accept hold-in-place');
      }
    }
    logger.warn({ name: this.timeline?.name, reason, phase }, 'Show frozen');
    this.finish(phase);
  }

  private finish(phase: ShowPhase): void {
    this.phase = phase;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (phase === 'complete') logger.info({ name: this.timeline?.name }, 'Show complete');
  }

  /**
   * @description Run a critical section serialized against ticks and other commands. Every
   * tick and every operator command (retask/stop) passes through here so exactly one holds
   * the conductor at a time — the guarantee that makes the timeline swap in retask() atomic
   * with respect to a tick suspended mid-dispatch on a remote drone's network round-trip.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(() => undefined, () => undefined); // keep the chain alive past a rejection
    return run;
  }

  private async safeTick(): Promise<void> {
    if (this.locked) return; // a command or prior tick holds the conductor — skip this beat
    this.locked = true;
    try { await this.exclusive(() => this.tick()); }
    finally { this.locked = false; }
  }
}
