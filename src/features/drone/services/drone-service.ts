/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the app-facing drone
 *                     |                             | control service (ADR-098): owns the provider instance and
 *                     |                             | enforces geofence + mission validation BEFORE any command
 *                     |                             | reaches an engine. Phase 1 = one sim drone; the provider is
 *                     |                             | injectable so MAVLink slots in without touching callers.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-099 phase 2: became the FLEET plane.
 *                     |                             | Wraps a DroneFleet (embedded 'alpha' sim + remote drone
 *                     |                             | nodes joining via heartbeat); every command takes a droneId
 *                     |                             | (default 'alpha' — full back-compat); offline nodes reject
 *                     |                             | before validation; non-sim engines additionally require an
 *                     |                             | explicit confirm (the real-hardware rail, ADR-098/099).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fleet missions (ADR-099 decision #2):
 *                     |                             | startFleetMission validates EVERY member (per-drone fence +
 *                     |                             | pairwise separation + confirm rail) BEFORE any drone moves,
 *                     |                             | then fans out all-or-nothing (partial failure = best-effort
 *                     |                             | abort of started members); abortFleet is the confirm-exempt
 *                     |                             | fleet-wide safety sweep; DRONE_EMBEDDED_SIMS spins up extra
 *                     |                             | embedded sim drones for hardware-free fleet demos.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Camera equipment: setCamera (confirm-
 *                     |                             | exempt payload op, shape-validated) + getCaptures; goto
 *                     |                             | validates a camera arrival action the same way it already
 *                     |                             | validates the LED color.
 */

import { createChildLogger } from '@/shared/logger';
import type { CameraAction, CameraCapture, DroneEvent, DroneTelemetry, Geofence, GeoPoint, MissionPlan, MissionWaypoint } from '../model/drone-types';
import type { DroneProvider, DroneProviderKind } from './drone-provider';
import { DroneCommandError } from './drone-provider';
import { SimDroneProvider } from './sim-drone-provider';
import { DroneFleet, DRONE_ID_RE, type FleetSummary } from './drone-fleet';
import type { DroneNodeHeartbeat } from './remote-drone-provider';
import { validateMission, validatePoint, validateSpeed, isLedColor, normalizeCameraAction } from './mission-validator';
import { validateFleetSeparation, type FleetMissionPlan } from './fleet-mission';

const logger = createChildLogger({ module: 'drone-service' });

/** The embedded dev drone every deployment has without running any node. */
export const DEFAULT_DRONE_ID = 'alpha';

/** Default launch point (Destin, FL) — override with DRONE_HOME_LAT / DRONE_HOME_LON. */
const DEFAULT_HOME = { lat: 30.3935, lon: -86.4958 };
/** Default fence: 500m radius, FAA Part 107 ceiling (120m / 400ft), 2m floor. */
const DEFAULT_FENCE: Geofence = { maxRadiusM: 500, maxAltM: 120, minAltM: 2 };
const DEFAULT_SPEED_MPS = 8;
const M_PER_DEG_LAT = 111320;

/**
 * @description Thrown when a command fails geofence/mission validation. Carries every
 * violation so the surface (or the concierge) can show the user the full list at once.
 * Routes map it to HTTP 422.
 */
export class DroneValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`validation failed: ${errors.join('; ')}`);
    this.name = 'DroneValidationError';
  }
}

/** Construction options; everything is optional and falls back to env/defaults. */
export interface DroneServiceOptions {
  /** Registered as the embedded 'alpha' drone (tests inject the sim on a fake clock here). */
  provider?: DroneProvider;
  fence?: Geofence;
  home?: { lat: number; lon: number };
  clock?: () => number;
  /** Extra embedded sim drone ids (falls back to the DRONE_EMBEDDED_SIMS env, comma-separated). */
  extraSimIds?: string[];
}

/** Per-drone outcome of a fleet-wide abort sweep — the sweep itself never throws. */
export interface FleetAbortOutcome {
  droneId: string;
  outcome: 'aborted' | 'no-mission' | 'offline' | 'failed';
  detail?: string;
}

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * @description The fleet control plane (ADR-099). One embedded sim drone ('alpha') exists on
 * every deployment; real vehicles join as remote drone nodes via authenticated heartbeats.
 * Every actuating command validates against the geofence FIRST, then reaches the drone's
 * provider — local or remote, the same gate. Deterministic code, no LLM involvement: the
 * drone-operator concierge only ever DRAFTS missions; execution comes through here on an
 * explicit human-approved call, and non-sim engines require an explicit confirm on top.
 */
export class DroneService {
  readonly fence: Geofence;
  private readonly fleet: DroneFleet;

  constructor(opts: DroneServiceOptions = {}) {
    this.fence = opts.fence ?? {
      maxRadiusM: envNum('DRONE_FENCE_RADIUS_M', DEFAULT_FENCE.maxRadiusM),
      maxAltM: envNum('DRONE_FENCE_MAX_ALT_M', DEFAULT_FENCE.maxAltM),
      minAltM: envNum('DRONE_FENCE_MIN_ALT_M', DEFAULT_FENCE.minAltM),
    };
    const home = opts.home ?? {
      lat: envNum('DRONE_HOME_LAT', DEFAULT_HOME.lat),
      lon: envNum('DRONE_HOME_LON', DEFAULT_HOME.lon),
    };
    this.fleet = new DroneFleet({ clock: opts.clock });
    this.fleet.registerLocal(DEFAULT_DRONE_ID, opts.provider ?? new SimDroneProvider({ home }));
    // Extra embedded sims: hardware-free fleet demos with zero node processes. Launch pads are
    // offset ~8m apart eastward so the surface map shows distinct pads, not a stack.
    const extraIds = opts.extraSimIds ??
      String(process.env.DRONE_EMBEDDED_SIMS || '').split(',').map((s) => s.trim()).filter(Boolean);
    extraIds.forEach((id, i) => {
      if (id === DEFAULT_DRONE_ID) return;
      if (!DRONE_ID_RE.test(id)) {
        logger.warn({ id }, 'DRONE_EMBEDDED_SIMS entry rejected — invalid drone id shape');
        return;
      }
      const lonOffset = ((i + 1) * 8) / (M_PER_DEG_LAT * Math.cos((home.lat * Math.PI) / 180));
      this.fleet.registerLocal(id, new SimDroneProvider({
        droneId: id, home: { lat: home.lat, lon: home.lon + lonOffset }, clock: opts.clock,
      }));
    });
    logger.info({ home, fence: this.fence, embeddedSims: [DEFAULT_DRONE_ID, ...extraIds] },
      'Drone service ready (fleet plane, embedded sims registered)');
  }

  /** @returns The embedded drone's engine kind (kept for phase-1 callers/back-compat). */
  get providerKind(): DroneProviderKind {
    return this.fleet.get(DEFAULT_DRONE_ID).kind;
  }

  /** @returns All known drones (embedded + heartbeating nodes), online or not. */
  listFleet(): FleetSummary[] {
    return this.fleet.list();
  }

  /**
   * @description Absorb one authenticated drone-node heartbeat (route enforces the secret).
   * @param hb - The heartbeat.
   * @returns The event ack cursor the node should resume from.
   */
  ingestHeartbeat(hb: DroneNodeHeartbeat): number {
    return this.fleet.ingestHeartbeat(hb);
  }

  /** @returns Live telemetry plus the fence and engine kind for one drone. */
  getState(droneId: string = DEFAULT_DRONE_ID): {
    droneId: string; telemetry: DroneTelemetry; fence: Geofence; provider: DroneProviderKind; online: boolean;
  } {
    const p = this.fleet.get(droneId);
    return { droneId, telemetry: p.getTelemetry(), fence: this.fence, provider: p.kind, online: this.fleet.isOnline(droneId) };
  }

  /** @returns Event-log entries after `sinceSeq` for one drone. */
  getEvents(sinceSeq: number, droneId: string = DEFAULT_DRONE_ID): DroneEvent[] {
    return this.fleet.get(droneId).getEvents(sinceSeq);
  }

  /** @description Arm the motors (ground only; battery-gated by the provider). */
  async arm(droneId: string = DEFAULT_DRONE_ID): Promise<void> {
    await this.fleet.get(droneId).arm();
  }

  /** @description Disarm the motors (ground only). */
  async disarm(droneId: string = DEFAULT_DRONE_ID): Promise<void> {
    await this.fleet.get(droneId).disarm();
  }

  /**
   * @description Climb vertically to `altM` and hold. Altitude is fence-validated; non-sim
   * engines require `confirm`.
   */
  async takeoff(altM: number, droneId: string = DEFAULT_DRONE_ID, confirm = false): Promise<void> {
    const p = this.resolveForActuation(droneId, confirm);
    const errors = validatePoint({ lat: p.home.lat, lon: p.home.lon, alt: altM }, this.fence, p.home);
    if (errors.length) throw new DroneValidationError(errors);
    await p.takeoff(altM);
  }

  /** @description Fly to a single point and hold. Point + speed are fence-validated; the
   * point may carry arrival actions (headingDeg / led / camera — each shape-validated here). */
  async goto(pt: MissionWaypoint, speedMps: number = DEFAULT_SPEED_MPS, droneId: string = DEFAULT_DRONE_ID, confirm = false): Promise<void> {
    const p = this.resolveForActuation(droneId, confirm);
    const errors = [...validatePoint(pt, this.fence, p.home), ...validateSpeed(speedMps)];
    if (pt.led !== undefined && pt.led !== 'off' && !isLedColor(pt.led)) errors.push(`invalid LED color "${pt.led}"`);
    let target = pt;
    if (pt.camera !== undefined) {
      const { action, errors: camErrors } = normalizeCameraAction(pt.camera);
      if (!action) errors.push(...camErrors);
      else target = { ...pt, camera: action };
    }
    if (errors.length) throw new DroneValidationError(errors);
    await p.gotoPoint(target, speedMps);
  }

  /**
   * @description Execute a waypoint mission. The FULL plan is validated against the fence
   * (centered on THAT drone's home) before the provider sees it.
   */
  async startMission(plan: MissionPlan, droneId: string = DEFAULT_DRONE_ID, confirm = false): Promise<void> {
    const p = this.resolveForActuation(droneId, confirm);
    const errors = validateMission(plan, this.fence, p.home);
    if (errors.length) throw new DroneValidationError(errors);
    await p.startMission(plan);
  }

  /**
   * @description Execute a coordinated FLEET mission (ADR-099 decision #2) — all-or-nothing.
   * Phase 1 validates EVERY member before ANY drone moves: fleet lookup (offline/unknown
   * rejects), the hardware confirm rail per member (one confirm covers the whole order),
   * per-drone fence validation centered on each drone's OWN home, member flight-state
   * (ground or holding only), and pairwise separation across the fleet. Phase 2 fans out:
   * ground members are armed as part of the approved order (execute IS the approval —
   * ADR-098), then each plan starts. A runtime failure mid-fanout (e.g. a provider's own
   * arm gate) triggers a best-effort abort of every already-started member before rethrowing.
   * @param fleetPlan - The normalized fleet mission.
   * @param confirm - The human's hardware confirm; required when any member is non-sim.
   */
  async startFleetMission(fleetPlan: FleetMissionPlan, confirm = false): Promise<void> {
    const errors: string[] = [];
    const members: Array<{ droneId: string; provider: DroneProvider; plan: MissionPlan; mustArm: boolean }> = [];
    for (const a of fleetPlan.assignments) {
      let p: DroneProvider;
      try { p = this.fleet.get(a.droneId); }
      catch (err) { errors.push((err as Error).message); continue; }
      if (p.kind !== 'sim' && !confirm) {
        errors.push(`drone "${a.droneId}" is real hardware (${p.kind}) — the fleet order needs confirm:true`);
        continue;
      }
      validateMission(a.plan, this.fence, p.home).forEach((e) => errors.push(`[${a.droneId}] ${e}`));
      let mustArm = false;
      try {
        const status = p.getTelemetry().status;
        mustArm = status === 'disarmed';
        if (status !== 'disarmed' && status !== 'armed' && status !== 'hold') {
          errors.push(`drone "${a.droneId}" is ${status} — fleet members must be on the ground or holding`);
        }
      } catch (err) { errors.push(`[${a.droneId}] ${(err as Error).message}`); }
      members.push({ droneId: a.droneId, provider: p, plan: a.plan, mustArm });
    }
    errors.push(...validateFleetSeparation(fleetPlan.assignments));
    if (errors.length) throw new DroneValidationError(errors);

    const started: string[] = [];
    for (const m of members) {
      try {
        if (m.mustArm) await m.provider.arm();
        await m.provider.startMission(m.plan);
        started.push(m.droneId);
      } catch (err) {
        for (const id of started) {
          try { await this.fleet.get(id).abortMission(); }
          catch (unwindErr) { logger.error({ err: unwindErr, droneId: id }, 'fleet unwind abort failed — drone may still be flying its member plan'); }
        }
        const suffix = started.length
          ? `; already-started members [${started.join(', ')}] were sent abort and are holding`
          : '; no drone was flying';
        throw new DroneCommandError(`fleet mission "${fleetPlan.name}" failed at drone "${m.droneId}" (${(err as Error).message})${suffix}`);
      }
    }
    logger.info({ name: fleetPlan.name, drones: started }, 'Fleet mission started');
  }

  /**
   * @description Fleet-wide abort — the confirm-exempt safety sweep (stopping a mission only
   * makes vehicles safer, ADR-098/099). Best-effort per drone: the sweep NEVER throws, it
   * reports one outcome per known drone so the surface can show exactly what happened.
   * @returns One outcome per fleet drone.
   */
  async abortFleet(): Promise<FleetAbortOutcome[]> {
    const out: FleetAbortOutcome[] = [];
    for (const f of this.fleet.list()) {
      if (!f.online) { out.push({ droneId: f.droneId, outcome: 'offline' }); continue; }
      try {
        await this.fleet.get(f.droneId).abortMission();
        out.push({ droneId: f.droneId, outcome: 'aborted' });
      } catch (err) {
        const detail = (err as Error).message;
        if (err instanceof DroneCommandError && /no mission is running/i.test(detail)) {
          out.push({ droneId: f.droneId, outcome: 'no-mission' });
        } else {
          logger.error({ err, droneId: f.droneId }, 'fleet abort failed for drone');
          out.push({ droneId: f.droneId, outcome: 'failed', detail });
        }
      }
    }
    return out;
  }

  /** @description Stop the running mission and hold position. */
  async abortMission(droneId: string = DEFAULT_DRONE_ID): Promise<void> {
    await this.fleet.get(droneId).abortMission();
  }

  /** @description Land at the current position and disarm. */
  async land(droneId: string = DEFAULT_DRONE_ID): Promise<void> {
    await this.fleet.get(droneId).land();
  }

  /** @description Fly home at the current altitude, land, and disarm. */
  async returnToLaunch(droneId: string = DEFAULT_DRONE_ID): Promise<void> {
    await this.fleet.get(droneId).returnToLaunch();
  }

  /** @description Sim-only maintenance: swap in a fresh battery while disarmed. */
  async replaceBattery(droneId: string = DEFAULT_DRONE_ID): Promise<void> {
    await this.fleet.get(droneId).replaceBattery();
  }

  /** @description Rotate in place to a compass heading. Actuation → the hardware confirm rail applies. */
  async setHeading(deg: number, droneId: string = DEFAULT_DRONE_ID, confirm = false): Promise<void> {
    if (!Number.isFinite(deg)) throw new DroneValidationError(['headingDeg must be a number']);
    const p = this.resolveForActuation(droneId, confirm);
    await p.setHeading(deg);
  }

  /**
   * @description Fire the LED equipment ('off' clears). A payload operation, not flight —
   * confirm-exempt by design; the color is validated so no markup-capable string is stored.
   */
  async setLed(color: string, droneId: string = DEFAULT_DRONE_ID): Promise<void> {
    if (color !== 'off' && !isLedColor(color)) throw new DroneValidationError([`invalid LED color "${color}"`]);
    await this.fleet.get(droneId).setLed(color);
  }

  /**
   * @description Operate the camera equipment (photo / record / stop / aim). A payload
   * operation like the LED — confirm-exempt; the action is shape-validated here so no
   * unknown op or out-of-range gimbal angle reaches an engine.
   * @returns The normalized action that was applied.
   */
  async setCamera(raw: unknown, droneId: string = DEFAULT_DRONE_ID): Promise<CameraAction> {
    const { action, errors } = normalizeCameraAction(raw);
    if (!action) throw new DroneValidationError(errors);
    await this.fleet.get(droneId).setCamera(action);
    return action;
  }

  /** @returns Camera capture records after `sinceSeq` for one drone. */
  getCaptures(sinceSeq: number, droneId: string = DEFAULT_DRONE_ID): CameraCapture[] {
    return this.fleet.get(droneId).getCaptures(sinceSeq);
  }

  /**
   * @description Resolve a drone for a flight-initiating command. Offline nodes reject in the
   * fleet lookup; a non-sim engine (real hardware) additionally requires the caller to have
   * passed an explicit confirm — the ADR-098/099 hardware rail. Abort/land/RTL deliberately
   * skip the confirm (they make the vehicle SAFER and must never be blocked).
   */
  private resolveForActuation(droneId: string, confirm: boolean): DroneProvider {
    const p = this.fleet.get(droneId);
    if (p.kind !== 'sim' && !confirm) {
      throw new DroneCommandError(
        `drone "${droneId}" is real hardware (${p.kind}) — pass confirm:true to actuate`,
      );
    }
    return p;
  }
}
