/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Drone Ops app (ADR-098)
 *                     |                             | phase 1: shared domain types for single-drone automation
 *                     |                             | control (telemetry, missions, geofence, events).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Telemetry depth: optional odometerM /
 *                     |                             | flightTimeS / rotorRpm — sim models them; engines that
 *                     |                             | don't report them (mavlink today) simply omit them.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Camera equipment v1 (second payload on
 *                     |                             | the arrival-action rail): CameraAction (photo/record/stop/
 *                     |                             | aim + gimbal pan/tilt) on waypoints and telemetry, and
 *                     |                             | CameraCapture — the structured record of every shot.
 */

/**
 * @description Flight state machine for a single drone. Transitions are enforced by the
 * provider — commands that don't apply to the current status are rejected, never coerced.
 * `disarmed` doubles as "landed": touching down always disarms (matches real autopilot RTL/LAND).
 */
export type DroneFlightStatus =
  | 'disarmed'   // on the ground, motors off
  | 'armed'      // on the ground, motors live, awaiting takeoff
  | 'takeoff'    // climbing to the commanded altitude
  | 'hold'       // airborne, position-holding
  | 'enroute'    // flying to a single commanded point
  | 'mission'    // executing a waypoint mission
  | 'returning'  // return-to-launch in progress
  | 'landing';   // descending in place

/** @description A WGS-84 position. `alt` is meters above ground level (AGL), not MSL. */
export interface GeoPoint {
  lat: number;
  lon: number;
  alt: number;
}

/**
 * @description One camera-equipment operation. `photo` captures a still, `record`/`stop`
 * bound a video clip, `aim` only moves the gimbal. `panDeg` is gimbal azimuth relative to
 * the airframe nose (-180..180); `tiltDeg` is degrees from level (-90 = straight down,
 * +30 = max up). Pan/tilt, when present, are applied before the op fires.
 */
export interface CameraAction {
  op: 'photo' | 'record' | 'stop' | 'aim';
  panDeg?: number;
  tiltDeg?: number;
}

/**
 * @description One record produced by the camera equipment. The sim stores the PARAMETERS
 * of the shot (where the camera was and how it was aimed) — the surface renders a labeled
 * SYNTHETIC frame from them; real image/video ingestion is a MAVLink follow-up (BACKLOG).
 */
export interface CameraCapture {
  seq: number;
  ts: number;
  kind: 'photo' | 'video';
  position: GeoPoint;
  headingDeg: number;
  panDeg: number;
  tiltDeg: number;
  /** Video only: clip length in seconds. */
  durationS?: number;
}

/** @description One mission waypoint; `holdSeconds` loiters at the point before continuing.
 * `headingDeg`/`led`/`camera` are ARRIVAL actions: face this compass heading, fire the LED
 * equipment to this color ('off' clears), and/or operate the camera when the point is reached. */
export interface MissionWaypoint extends GeoPoint {
  holdSeconds?: number;
  headingDeg?: number;
  led?: string;
  camera?: CameraAction;
}

/**
 * @description A validated, executable waypoint mission. Drafts (from the drone-operator
 * concierge or the surface's map editor) are normalized into this exact shape before any
 * execution — there is no partially-specified mission at the provider layer.
 */
export interface MissionPlan {
  name: string;
  waypoints: MissionWaypoint[];
  /** Cruise ground speed, m/s. Clamped to [MIN_SPEED_MPS, MAX_SPEED_MPS] at validation. */
  speedMps: number;
  /** Return to launch and land automatically after the last waypoint (default true). */
  rtlAfterMission: boolean;
}

/**
 * @description The safety envelope every flight command is validated against. A cylinder
 * centered on the launch point: nothing flies farther than `maxRadiusM` from home or outside
 * [minAltM, maxAltM]. Defaults follow FAA Part 107 (120 m / 400 ft ceiling).
 */
export interface Geofence {
  maxRadiusM: number;
  maxAltM: number;
  minAltM: number;
}

/** @description Mission progress while `status === 'mission'`. `index` is the waypoint being flown. */
export interface MissionProgress {
  index: number;
  total: number;
  name: string;
}

/** @description One entry in the drone's event log (arm, waypoint reached, failsafe, ...). */
export interface DroneEvent {
  seq: number;
  ts: number;
  level: 'info' | 'warn' | 'alert';
  message: string;
}

/**
 * @description A point-in-time telemetry snapshot. Reading telemetry is side-effect-free for
 * callers but advances the simulation clock internally (lazy integration), so two reads a
 * minute apart show a minute of flight.
 */
export interface DroneTelemetry {
  droneId: string;
  status: DroneFlightStatus;
  position: GeoPoint;
  home: GeoPoint;
  headingDeg: number;
  groundSpeedMps: number;
  batteryPct: number;
  distanceFromHomeM: number;
  mission: MissionProgress | null;
  /** Active failsafe, if any ('low-battery-rtl' | 'critical-battery-land'). */
  failsafe: string | null;
  /** Cumulative distance flown this session, meters. Sim-modeled; absent when unreported. */
  odometerM?: number;
  /** Seconds spent airborne this session. Sim-modeled; absent when unreported. */
  flightTimeS?: number;
  /** Modeled rotor RPM (sim). Real ESC telemetry is a MAVLink follow-up; absent until then. */
  rotorRpm?: number;
  /** Current LED equipment color (sim payload), null/absent when off or unequipped. */
  led?: string | null;
  /** Camera equipment state (sim payload); absent when unequipped. */
  camera?: { recording: boolean; panDeg: number; tiltDeg: number; captures: number } | null;
}
