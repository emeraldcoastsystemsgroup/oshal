/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the engine-agnostic drone
 *                     |                             | control interface (ADR-098). The sim provider implements it
 *                     |                             | today; a MAVLink/SITL adapter is a sibling implementation
 *                     |                             | later, exactly like LLM harness adapters — never a rewrite.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Camera equipment v1: setCamera (operate
 *                     |                             | the payload) + getCaptures (structured shot records) join
 *                     |                             | the interface beside the LED — every engine implements or
 *                     |                             | honestly rejects them.
 */

import type { CameraAction, CameraCapture, DroneEvent, DroneTelemetry, GeoPoint, MissionPlan } from '../model/drone-types';

/** @description Which engine is flying: the built-in simulator, or (roadmap) MAVLink. */
export type DroneProviderKind = 'sim' | 'mavlink';

/**
 * @description Thrown when a command doesn't apply to the drone's current state (e.g. takeoff
 * while disarmed) or violates a hard precondition (e.g. arming on a depleted battery). Routes
 * map it to HTTP 409 — it is an expected, user-visible rejection, not an internal error.
 */
export class DroneCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DroneCommandError';
  }
}

/**
 * @description The single control surface for one drone, regardless of engine. All commands are
 * async because real autopilot links are; the simulator resolves immediately. Implementations
 * own their state machine and reject invalid transitions with {@link DroneCommandError} —
 * callers (DroneService) handle geofence/mission validation BEFORE invoking these.
 */
export interface DroneProvider {
  readonly droneId: string;
  readonly kind: DroneProviderKind;
  readonly home: GeoPoint;

  /** Spin up motors on the ground. Rejected mid-air or on a depleted battery. */
  arm(): Promise<void>;
  /** Shut down motors. Only valid on the ground. */
  disarm(): Promise<void>;
  /** Climb vertically to `altM` meters AGL, then position-hold. */
  takeoff(altM: number): Promise<void>;
  /** Fly to a single point at `speedMps`, then position-hold. Not valid during a mission. */
  gotoPoint(pt: GeoPoint, speedMps: number): Promise<void>;
  /** Execute a validated waypoint mission. From the ground it auto-takes-off first. */
  startMission(plan: MissionPlan): Promise<void>;
  /** Stop the current mission and position-hold where the drone is. */
  abortMission(): Promise<void>;
  /** Descend and land at the current position, then disarm. */
  land(): Promise<void>;
  /** Fly home at the current altitude, then land and disarm. */
  returnToLaunch(): Promise<void>;

  /** Rotate in place to face `deg` (0 = north). Rejected while disarmed. */
  setHeading(deg: number): Promise<void>;
  /** Equipment: set the LED payload to a color ('off' clears). Any flight state. */
  setLed(color: string): Promise<void>;
  /** Equipment: operate the camera payload (photo / record / stop / aim). Any flight state. */
  setCamera(action: CameraAction): Promise<void>;
  /** Camera capture records with `seq` greater than `sinceSeq` (0 = all retained). */
  getCaptures(sinceSeq: number): CameraCapture[];

  /** Current state. Reading advances the (lazy) simulation to "now". */
  getTelemetry(): DroneTelemetry;
  /** Event log entries with `seq` greater than `sinceSeq` (0 = all retained). */
  getEvents(sinceSeq: number): DroneEvent[];
  /** Sim-only maintenance hook: swap in a fresh battery while disarmed. */
  replaceBattery(): Promise<void>;
}
