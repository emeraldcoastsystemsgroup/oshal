/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — deterministic kinematic
 *                     |                             | flight simulator behind DroneProvider (ADR-098). Lazy time
 *                     |                             | integration (no background timer): every read/command first
 *                     |                             | advances the model by real elapsed time in ≤1s sub-steps, so
 *                     |                             | the same code is exact under test clocks and live polling.
 *                     |                             | Battery failsafes mirror real autopilot doctrine (low → RTL,
 *                     |                             | critical → land in place).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Telemetry depth: odometer (horizontal +
 *                     |                             | vertical distance actually flown), airborne flight time,
 *                     |                             | and a deterministic rotor-RPM model for the HUD.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Camera equipment v1: gimbal pan/tilt +
 *                     |                             | photo/record/stop as manual commands AND arrival actions;
 *                     |                             | every shot becomes a structured CameraCapture (position/
 *                     |                             | heading/aim/clip length) and an EQUIP event — the trigger
 *                     |                             | record, exactly like the LED.
 */

import type {
  CameraAction,
  CameraCapture,
  DroneEvent,
  DroneFlightStatus,
  DroneTelemetry,
  GeoPoint,
  MissionPlan,
} from '../model/drone-types';
import { haversineM } from './mission-validator';
import { DroneCommandError, type DroneProvider, type DroneProviderKind } from './drone-provider';

const CLIMB_RATE_MPS = 2.5;
const DESCENT_RATE_MPS = 1.5;
/** RTL cruise speed — real autopilots use a dedicated RTL_SPEED param, NOT the last
 * commanded goto speed (a 1 m/s cue leg must not turn the return home into a crawl). */
const RTL_SPEED_MPS = 8;
const ARRIVAL_RADIUS_M = 1;
const DRAIN_IDLE_PCT_PER_S = 0.02;
const DRAIN_FLIGHT_PCT_PER_S = 0.06;
const MIN_ARM_BATTERY_PCT = 30;
const LOW_BATTERY_RTL_PCT = 20;
const CRITICAL_BATTERY_LAND_PCT = 8;
/** Longest gap the lazy integrator will simulate through (idle beyond this is truncated). */
const MAX_CATCHUP_S = 900;
const EVENT_RETENTION = 200;
const CAPTURE_RETENTION = 100;
const DEFAULT_CAM_TILT_DEG = -20;
const M_PER_DEG_LAT = 111320;

const AIRBORNE: DroneFlightStatus[] = ['takeoff', 'hold', 'enroute', 'mission', 'returning', 'landing'];

/** Construction options for the simulator. `clock` is injectable for deterministic tests. */
export interface SimDroneOptions {
  droneId?: string;
  home: { lat: number; lon: number };
  clock?: () => number;
}

/**
 * @description The built-in flight engine: a single simulated quadcopter with realistic-enough
 * kinematics (straight-line cruise, fixed climb/descent rates, per-state battery drain) and a
 * strict flight state machine. It exists so the whole Drone Ops app — routes, surface, mission
 * planning, concierge drafting — is exercisable end-to-end with zero hardware; a MAVLink
 * adapter later implements the same {@link DroneProvider} and everything above it is unchanged.
 */
export class SimDroneProvider implements DroneProvider {
  readonly kind: DroneProviderKind = 'sim';
  readonly droneId: string;
  readonly home: GeoPoint;

  private readonly clock: () => number;
  private status: DroneFlightStatus = 'disarmed';
  private pos: GeoPoint;
  private headingDeg = 0;
  private batteryPct = 100;
  private target: GeoPoint | null = null;
  private speedMps = 8;
  private plan: MissionPlan | null = null;
  private missionIndex = 0;
  private missionPending = false;
  private holdRemainingS = 0;
  private failsafe: string | null = null;
  private lastTickMs: number;
  private events: DroneEvent[] = [];
  private seq = 0;
  private odometerM = 0;
  private flightTimeS = 0;
  private led: string | null = null;
  private camPanDeg = 0;
  private camTiltDeg = DEFAULT_CAM_TILT_DEG;
  private recording = false;
  private recordStartMs = 0;
  private captures: CameraCapture[] = [];
  private capSeq = 0;
  /** Arrival actions riding the current goto (heading / LED / camera to fire on arrival). */
  private pendingArrival: { headingDeg?: number; led?: string; camera?: CameraAction } | null = null;

  constructor(opts: SimDroneOptions) {
    this.droneId = opts.droneId ?? 'alpha';
    this.clock = opts.clock ?? ((): number => Date.now());
    this.home = { lat: opts.home.lat, lon: opts.home.lon, alt: 0 };
    this.pos = { ...this.home };
    this.lastTickMs = this.clock();
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  async arm(): Promise<void> {
    this.tick();
    if (this.status !== 'disarmed') throw new DroneCommandError(`cannot arm while ${this.status}`);
    if (this.batteryPct < MIN_ARM_BATTERY_PCT) {
      throw new DroneCommandError(`battery at ${this.batteryPct.toFixed(0)}% — below the ${MIN_ARM_BATTERY_PCT}% arming minimum; replace the battery`);
    }
    this.failsafe = null;
    this.status = 'armed';
    this.logEvent('info', 'Armed — motors live');
  }

  async disarm(): Promise<void> {
    this.tick();
    if (this.status !== 'armed') throw new DroneCommandError(`cannot disarm while ${this.status} — land first`);
    this.status = 'disarmed';
    this.logEvent('info', 'Disarmed');
  }

  async takeoff(altM: number): Promise<void> {
    this.tick();
    if (this.status !== 'armed') throw new DroneCommandError(`cannot take off while ${this.status} — arm first`);
    this.target = { lat: this.pos.lat, lon: this.pos.lon, alt: altM };
    this.status = 'takeoff';
    this.logEvent('info', `Taking off to ${altM}m`);
  }

  async gotoPoint(pt: GeoPoint, speedMps: number): Promise<void> {
    this.tick();
    if (this.status !== 'hold' && this.status !== 'enroute') {
      throw new DroneCommandError(`cannot fly to a point while ${this.status}${this.status === 'mission' ? ' — abort the mission first' : ''}`);
    }
    // Retarget race: cue-timed gotos arrive EXACTLY on the boundary, so the next cue's
    // dispatch can land in the same instant as the arrival. If we're within tolerance of
    // the old target, the point WAS reached — fire its arrival actions before replacing them.
    if (this.status === 'enroute' && this.target && this.pendingArrival &&
        haversineM(this.pos, this.target) <= ARRIVAL_RADIUS_M * 2 &&
        Math.abs(this.pos.alt - this.target.alt) <= 1) {
      this.applyArrival(this.pendingArrival);
    }
    this.target = { lat: pt.lat, lon: pt.lon, alt: pt.alt };
    const extra = pt as { headingDeg?: number; led?: string; camera?: CameraAction };
    this.pendingArrival = extra.headingDeg !== undefined || extra.led !== undefined || extra.camera !== undefined
      ? { headingDeg: extra.headingDeg, led: extra.led, camera: extra.camera }
      : null;
    this.speedMps = speedMps;
    this.status = 'enroute';
    this.logEvent('info', `Enroute to ${pt.lat.toFixed(6)}, ${pt.lon.toFixed(6)} at ${pt.alt}m`);
  }

  async startMission(plan: MissionPlan): Promise<void> {
    this.tick();
    if (this.status !== 'armed' && this.status !== 'hold') {
      throw new DroneCommandError(`cannot start a mission while ${this.status}`);
    }
    this.plan = { ...plan, waypoints: plan.waypoints.map((w) => ({ ...w })) };
    this.missionIndex = 0;
    this.holdRemainingS = 0;
    this.speedMps = plan.speedMps;
    if (this.status === 'armed') {
      // Ground start: climb to the first waypoint's altitude, then the mission engages.
      this.missionPending = true;
      this.target = { lat: this.pos.lat, lon: this.pos.lon, alt: plan.waypoints[0].alt };
      this.status = 'takeoff';
      this.logEvent('info', `Mission "${plan.name}" accepted — taking off to ${plan.waypoints[0].alt}m`);
    } else {
      this.status = 'mission';
      this.logEvent('info', `Mission "${plan.name}" started (${plan.waypoints.length} waypoints)`);
    }
  }

  async abortMission(): Promise<void> {
    this.tick();
    if (!this.plan || (this.status !== 'mission' && !this.missionPending)) {
      throw new DroneCommandError('no mission is running');
    }
    const name = this.plan.name;
    this.clearMission();
    if (this.status === 'mission') this.status = 'hold';
    this.logEvent('warn', `Mission "${name}" aborted — holding position`);
  }

  async land(): Promise<void> {
    this.tick();
    this.requireAirborne('land');
    this.clearMission();
    this.target = null;
    this.status = 'landing';
    this.logEvent('info', 'Landing at current position');
  }

  async returnToLaunch(): Promise<void> {
    this.tick();
    this.requireAirborne('return to launch');
    this.startRtl('Returning to launch');
  }

  async replaceBattery(): Promise<void> {
    this.tick();
    if (this.status !== 'disarmed') throw new DroneCommandError('battery swap requires the drone to be disarmed on the ground');
    this.batteryPct = 100;
    this.logEvent('info', 'Battery replaced — 100%');
  }

  async setHeading(deg: number): Promise<void> {
    this.tick();
    if (this.status === 'disarmed') throw new DroneCommandError('cannot rotate while disarmed');
    this.headingDeg = ((deg % 360) + 360) % 360;
    this.logEvent('info', `Rotated to ${Math.round(this.headingDeg)}°`);
  }

  async setLed(color: string): Promise<void> {
    this.tick();
    this.applyLed(color);
  }

  async setCamera(action: CameraAction): Promise<void> {
    this.tick();
    this.applyCamera(action);
  }

  /**
   * Operate the camera equipment. Aim first (pan/tilt when given), then the op. Each shot
   * pushes a structured capture record AND an EQUIP event — the event log line is the
   * trigger record the operator audits, exactly like the LED.
   */
  private applyCamera(a: CameraAction): void {
    if (a.panDeg !== undefined && Number.isFinite(a.panDeg)) this.camPanDeg = a.panDeg;
    if (a.tiltDeg !== undefined && Number.isFinite(a.tiltDeg)) this.camTiltDeg = a.tiltDeg;
    const aim = `pan ${Math.round(this.camPanDeg)}°, tilt ${Math.round(this.camTiltDeg)}°`;
    if (a.op === 'aim') {
      this.logEvent('info', `EQUIP camera → aimed (${aim})`);
      return;
    }
    if (a.op === 'photo') {
      this.pushCapture('photo');
      this.logEvent('info', `EQUIP camera → photo #${this.capSeq} (${aim})`);
      return;
    }
    if (a.op === 'record') {
      if (this.recording) return; // already rolling — idempotent
      this.recording = true;
      this.recordStartMs = this.clock();
      this.logEvent('info', `EQUIP camera → recording (${aim})`);
      return;
    }
    // 'stop'
    if (!this.recording) return;
    const durationS = Math.round((this.clock() - this.recordStartMs) / 100) / 10;
    this.recording = false;
    this.pushCapture('video', durationS);
    this.logEvent('info', `EQUIP camera → recording stopped (${durationS}s clip)`);
  }

  private pushCapture(kind: CameraCapture['kind'], durationS?: number): void {
    this.capSeq += 1;
    this.captures.push({
      seq: this.capSeq,
      ts: this.clock(),
      kind,
      position: { lat: this.pos.lat, lon: this.pos.lon, alt: Math.round(this.pos.alt * 10) / 10 },
      headingDeg: Math.round(this.headingDeg),
      panDeg: Math.round(this.camPanDeg),
      tiltDeg: Math.round(this.camTiltDeg),
      ...(durationS !== undefined ? { durationS } : {}),
    });
    if (this.captures.length > CAPTURE_RETENTION) {
      this.captures.splice(0, this.captures.length - CAPTURE_RETENTION);
    }
  }

  /** Fire the LED equipment — the event log line IS the equipment trigger record. */
  private applyLed(color: string): void {
    if (color === 'off') {
      if (this.led !== null) { this.led = null; this.logEvent('info', 'EQUIP led → off'); }
      return;
    }
    this.led = color.toLowerCase();
    this.logEvent('info', `EQUIP led → ${this.led}`);
  }

  /** Apply the arrival actions attached to the point just reached. */
  private applyArrival(a: { headingDeg?: number; led?: string; camera?: CameraAction } | null | undefined): void {
    if (!a) return;
    if (a.headingDeg !== undefined && Number.isFinite(a.headingDeg)) {
      this.headingDeg = ((a.headingDeg % 360) + 360) % 360;
      this.logEvent('info', `Rotated to ${Math.round(this.headingDeg)}°`);
    }
    if (a.led !== undefined) this.applyLed(a.led);
    if (a.camera !== undefined) this.applyCamera(a.camera);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  getTelemetry(): DroneTelemetry {
    this.tick();
    return {
      droneId: this.droneId,
      status: this.status,
      position: { lat: this.pos.lat, lon: this.pos.lon, alt: Math.round(this.pos.alt * 10) / 10 },
      home: { ...this.home },
      headingDeg: Math.round(this.headingDeg),
      groundSpeedMps: this.currentSpeed(),
      batteryPct: Math.round(this.batteryPct * 10) / 10,
      distanceFromHomeM: Math.round(haversineM(this.pos, this.home) * 10) / 10,
      mission: this.plan && (this.status === 'mission' || this.missionPending)
        ? { index: this.missionIndex, total: this.plan.waypoints.length, name: this.plan.name }
        : null,
      failsafe: this.failsafe,
      odometerM: Math.round(this.odometerM),
      flightTimeS: Math.round(this.flightTimeS),
      rotorRpm: this.currentRpm(),
      led: this.led,
      camera: {
        recording: this.recording,
        panDeg: Math.round(this.camPanDeg),
        tiltDeg: Math.round(this.camTiltDeg),
        captures: this.captures.length,
      },
    };
  }

  getCaptures(sinceSeq: number): CameraCapture[] {
    this.tick();
    return this.captures.filter((c) => c.seq > sinceSeq);
  }

  /** Deterministic rotor-RPM model: off on the ground, idle when armed, load-scaled in flight. */
  private currentRpm(): number {
    if (this.status === 'disarmed') return 0;
    if (this.status === 'armed') return 1400;
    const climbing = this.status === 'takeoff' ? 400 : 0;
    return Math.round(2800 + this.currentSpeed() * 120 + climbing);
  }

  getEvents(sinceSeq: number): DroneEvent[] {
    this.tick();
    return this.events.filter((e) => e.seq > sinceSeq);
  }

  // ── Simulation core ────────────────────────────────────────────────────────

  /** Advance the model from the last observation to "now" in ≤1s sub-steps. */
  private tick(): void {
    const now = this.clock();
    let dt = (now - this.lastTickMs) / 1000;
    this.lastTickMs = now;
    if (dt <= 0) return;
    dt = Math.min(dt, MAX_CATCHUP_S);
    while (dt > 0) {
      const step = Math.min(dt, 1);
      this.stepOnce(step);
      dt -= step;
    }
  }

  private stepOnce(dt: number): void {
    if (AIRBORNE.includes(this.status)) this.flightTimeS += dt;
    this.drainBattery(dt);
    this.applyFailsafes();
    switch (this.status) {
      case 'takeoff': this.stepTakeoff(dt); break;
      case 'enroute': this.stepEnroute(dt); break;
      case 'mission': this.stepMission(dt); break;
      case 'returning': this.stepReturning(dt); break;
      case 'landing': this.stepLanding(dt); break;
      default: break; // disarmed / armed / hold: no motion
    }
  }

  private drainBattery(dt: number): void {
    if (this.status === 'disarmed') return;
    const rate = this.status === 'armed' ? DRAIN_IDLE_PCT_PER_S : DRAIN_FLIGHT_PCT_PER_S;
    this.batteryPct = Math.max(0, this.batteryPct - rate * dt);
  }

  private applyFailsafes(): void {
    if (!AIRBORNE.includes(this.status) || this.status === 'landing') return;
    if (this.batteryPct <= CRITICAL_BATTERY_LAND_PCT && this.failsafe !== 'critical-battery-land') {
      this.failsafe = 'critical-battery-land';
      this.clearMission();
      this.target = null;
      this.status = 'landing';
      this.logEvent('alert', `FAILSAFE: battery critical (${this.batteryPct.toFixed(0)}%) — landing in place`);
    } else if (this.batteryPct <= LOW_BATTERY_RTL_PCT && !this.failsafe) {
      this.failsafe = 'low-battery-rtl';
      this.startRtl(`FAILSAFE: battery low (${this.batteryPct.toFixed(0)}%) — returning to launch`, 'alert');
    }
  }

  private stepTakeoff(dt: number): void {
    if (!this.target) { this.status = 'hold'; return; }
    if (!this.moveVertical(dt, this.target.alt)) return;
    if (this.missionPending && this.plan) {
      this.missionPending = false;
      this.status = 'mission';
      this.logEvent('info', `Mission "${this.plan.name}" started (${this.plan.waypoints.length} waypoints)`);
    } else {
      this.status = 'hold';
      this.logEvent('info', `Takeoff complete — holding at ${Math.round(this.pos.alt)}m`);
    }
  }

  private stepEnroute(dt: number): void {
    if (!this.target) { this.status = 'hold'; return; }
    const h = this.moveHorizontal(dt, this.target);
    const v = this.moveVertical(dt, this.target.alt);
    if (h && v) {
      this.status = 'hold';
      this.logEvent('info', 'Arrived — holding position');
      this.applyArrival(this.pendingArrival);
      this.pendingArrival = null;
    }
  }

  private stepMission(dt: number): void {
    if (!this.plan) { this.status = 'hold'; return; }
    if (this.holdRemainingS > 0) {
      this.holdRemainingS -= dt;
      if (this.holdRemainingS <= 0) this.advanceWaypoint();
      return;
    }
    const wp = this.plan.waypoints[this.missionIndex];
    const h = this.moveHorizontal(dt, wp);
    const v = this.moveVertical(dt, wp.alt);
    if (h && v) {
      this.logEvent('info', `Reached waypoint ${this.missionIndex + 1}/${this.plan.waypoints.length}`);
      this.applyArrival(wp);
      if (wp.holdSeconds && wp.holdSeconds > 0) this.holdRemainingS = wp.holdSeconds;
      else this.advanceWaypoint();
    }
  }

  private advanceWaypoint(): void {
    if (!this.plan) return;
    this.missionIndex += 1;
    if (this.missionIndex < this.plan.waypoints.length) return;
    const rtl = this.plan.rtlAfterMission;
    this.logEvent('info', `Mission "${this.plan.name}" complete`);
    this.clearMission();
    if (rtl) this.startRtl('Mission complete — returning to launch');
    else { this.status = 'hold'; this.logEvent('info', 'Holding at final waypoint'); }
  }

  private stepReturning(dt: number): void {
    const overHome = { lat: this.home.lat, lon: this.home.lon, alt: this.pos.alt };
    if (this.moveHorizontal(dt, overHome)) {
      this.target = null;
      this.status = 'landing';
      this.logEvent('info', 'Above home — landing');
    }
  }

  private stepLanding(dt: number): void {
    this.odometerM += Math.min(DESCENT_RATE_MPS * dt, this.pos.alt);
    this.pos.alt = Math.max(0, this.pos.alt - DESCENT_RATE_MPS * dt);
    if (this.pos.alt <= 0) {
      this.pos.alt = 0;
      this.status = 'disarmed';
      this.logEvent('info', 'Landed and disarmed');
    }
  }

  // ── Motion helpers ─────────────────────────────────────────────────────────

  /** Move horizontally toward `to` at the commanded speed. Returns true when within arrival radius. */
  private moveHorizontal(dt: number, to: { lat: number; lon: number }): boolean {
    const mPerDegLon = M_PER_DEG_LAT * Math.cos((this.pos.lat * Math.PI) / 180);
    const dNorth = (to.lat - this.pos.lat) * M_PER_DEG_LAT;
    const dEast = (to.lon - this.pos.lon) * mPerDegLon;
    const dist = Math.hypot(dNorth, dEast);
    if (dist <= ARRIVAL_RADIUS_M) return true;
    this.headingDeg = ((Math.atan2(dEast, dNorth) * 180) / Math.PI + 360) % 360;
    const travel = this.speedMps * dt;
    this.odometerM += Math.min(travel, dist);
    if (travel >= dist) {
      this.pos.lat = to.lat;
      this.pos.lon = to.lon;
      return true;
    }
    this.pos.lat += ((dNorth / dist) * travel) / M_PER_DEG_LAT;
    this.pos.lon += ((dEast / dist) * travel) / mPerDegLon;
    return false;
  }

  /** Climb/descend toward `targetAlt` at the fixed rates. Returns true when within 0.5m. */
  private moveVertical(dt: number, targetAlt: number): boolean {
    const diff = targetAlt - this.pos.alt;
    if (Math.abs(diff) <= 0.5) { this.pos.alt = targetAlt; return true; }
    const rate = diff > 0 ? CLIMB_RATE_MPS : -DESCENT_RATE_MPS;
    this.odometerM += Math.min(Math.abs(rate) * dt, Math.abs(diff));
    this.pos.alt += rate * dt;
    if ((rate > 0 && this.pos.alt >= targetAlt) || (rate < 0 && this.pos.alt <= targetAlt)) {
      this.pos.alt = targetAlt;
      return true;
    }
    return false;
  }

  private currentSpeed(): number {
    if (this.status === 'enroute' || this.status === 'mission' || this.status === 'returning') return this.speedMps;
    if (this.status === 'takeoff') return CLIMB_RATE_MPS;
    if (this.status === 'landing') return DESCENT_RATE_MPS;
    return 0;
  }

  private startRtl(message: string, level: 'info' | 'alert' = 'info'): void {
    this.clearMission();
    this.target = { lat: this.home.lat, lon: this.home.lon, alt: this.pos.alt };
    this.speedMps = RTL_SPEED_MPS;
    this.status = 'returning';
    this.logEvent(level, message);
  }

  private clearMission(): void {
    this.plan = null;
    this.missionIndex = 0;
    this.missionPending = false;
    this.holdRemainingS = 0;
  }

  private requireAirborne(verb: string): void {
    if (!AIRBORNE.includes(this.status) || this.status === 'landing') {
      throw new DroneCommandError(`cannot ${verb} while ${this.status}`);
    }
  }

  private logEvent(level: DroneEvent['level'], message: string): void {
    this.seq += 1;
    this.events.push({ seq: this.seq, ts: this.clock(), level, message });
    if (this.events.length > EVENT_RETENTION) this.events.splice(0, this.events.length - EVENT_RETENTION);
  }
}
