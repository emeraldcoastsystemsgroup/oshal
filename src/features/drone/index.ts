/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Drone Ops feature barrel
 *                     |                             | (ADR-098). All imports go through here (FSD: no deep imports).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fleet missions (ADR-099 decision #2):
 *                     |                             | export the fleet-mission normalizer/validators + the
 *                     |                             | DroneService fleet execution surface.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fleet Show patterns: export the
 *                     |                             | deterministic choreography generators.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Show timelines: export the timeline
 *                     |                             | model/validators + the FleetShowRunner conductor.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Camera equipment (CameraAction/Capture +
 *                     |                             | normalizeCameraAction) + live retask (validateRetask).
 */

export type {
  CameraAction,
  CameraCapture,
  DroneFlightStatus,
  GeoPoint,
  MissionWaypoint,
  MissionPlan,
  Geofence,
  MissionProgress,
  DroneEvent,
  DroneTelemetry,
} from './model/drone-types';
export { DroneCommandError, type DroneProvider, type DroneProviderKind } from './services/drone-provider';
export { SimDroneProvider, type SimDroneOptions } from './services/sim-drone-provider';
export {
  haversineM,
  validatePoint,
  validateSpeed,
  validateMission,
  isLedColor,
  normalizeCameraAction,
  normalizeCameraCapture,
  CAMERA_PAN_LIMIT_DEG,
  CAMERA_TILT_MIN_DEG,
  CAMERA_TILT_MAX_DEG,
  MIN_SPEED_MPS,
  MAX_SPEED_MPS,
  MAX_WAYPOINTS,
  MAX_HOLD_SECONDS,
} from './services/mission-validator';
export { normalizeMissionDraft, type MissionDraftResult } from './services/mission-draft';
export { RemoteDroneProvider, type DroneNodeHeartbeat } from './services/remote-drone-provider';
export { MavlinkDroneProvider, type MavlinkDroneOptions } from './services/mavlink-drone-provider';
export { DroneFleet, HEARTBEAT_STALE_MS, DRONE_ID_RE, type FleetSummary } from './services/drone-fleet';
export {
  isFleetMissionShape,
  normalizeFleetMissionDraft,
  validateFleetSeparation,
  minPolylineDistanceM,
  MIN_VERTICAL_SEPARATION_M,
  MIN_HORIZONTAL_SEPARATION_M,
  MAX_FLEET_ASSIGNMENTS,
  type FleetAssignment,
  type FleetMissionPlan,
  type FleetMissionDraftResult,
} from './services/fleet-mission';
export {
  FLEET_PATTERNS,
  generateFleetPattern,
  type FleetPatternSpec,
  type FleetPatternOptions,
  type FleetPatternResult,
} from './services/fleet-patterns';
export {
  isShowShape,
  normalizeShowDraft,
  validateShowTimeline,
  validateRetask,
  validateOutroSeparation,
  MIN_RETASK_LEAD_S,
  generateBalletShow,
  showParticipants,
  firstAppearances,
  type ShowSlot,
  type ShowCue,
  type ShowTimeline,
  type ShowDraftResult,
} from './services/fleet-show';
export { FleetShowRunner, type ShowPhase, type ShowStatus } from './services/fleet-show-runner';
export {
  DroneService,
  DroneValidationError,
  DEFAULT_DRONE_ID,
  type DroneServiceOptions,
  type FleetAbortOutcome,
} from './services/drone-service';
