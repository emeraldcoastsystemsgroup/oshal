/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | night 1: slice barrel — types, quaternion math, the
 *                     |                             | SatSimAdapter contract, RK4 propagator, PD controller.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Night 1 round 2: export the NASA-42 codec
 *                     |                             | + socket adapter (async contract).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | W3: orbit-track sampler, conjunction
 *                     |                             | screening, TLE catalog + orbit types for the fleet
 *                     |                             | plane.
 */

export type { MtbClusterConfig, Quat, SatAttitudeState, SatBodyConfig, Vec3, WheelLimits } from './model/sat-types';
export type { SatSimAdapter } from './services/sim-adapter';
export {
  attitudeSeparationDeg,
  quatConjugate,
  quatDerivative,
  quatFromAxisAngle,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  rotateByQuat,
  v3,
  vAdd,
  vCross,
  vNorm,
  vScale,
  vSub,
} from './services/sat-math';
export { DEFAULT_MTB_CONFIG, DEFAULT_SAT_CONFIG, Rk4PropagatorSim, type Rk4SimEnvironment } from './services/rk4-propagator-sim';
export { QuaternionPdController, type AdcsPdConfig } from './services/adcs-controller';
export { DEFAULT_MAG_ENV, MagEnvironment, type MagEnvironmentConfig } from './services/mag-environment';
export {
  CFS_SAT_DESAT_KDESAT,
  DEFAULT_DESAT_CONFIG_RK4,
  MtbDesatController,
  type MtbDesatCommand,
  type MtbDesatConfig,
} from './services/mtb-desat-controller';
export {
  ACK,
  IN_LAYOUT,
  OUT_LAYOUT,
  TBL_LAYOUT,
  clusterMomentum,
  detectQuatConvention,
  groupVec3,
  layoutLength,
  parseAcArraySizes,
  parseAcBufLens,
  readLayout,
  scalarLastToQuat,
  solveFieldFromMags,
  solveOmegaFromGyros,
  solveVectorFromAxisScalars,
  wheelDistribution,
  writeLayout,
  type AcArraySizes,
  type AcBufLens,
  type LayoutField,
} from './services/nasa42-codec';
export { Nasa42SimAdapter, type Nasa42ConnectOptions, type Nasa42Vehicle } from './services/nasa42-sim-adapter';
export {
  SAT_HEARTBEAT_STALE_MS,
  SAT_ID_RE,
  SatCommandError,
  SatFleet,
  type SatControlMode,
  type SatEngineKind,
  type SatFleetSummary,
  type SatNodeHeartbeat,
  type SatNodeTelemetry,
} from './services/sat-fleet';
export type { GroundStation, PassPrediction, PassPredictionOptions, PassWindow } from './model/pass-types';
export { TLE_MAX_CHARS, TleParseError, parseTle, tleChecksum, type ParsedTle } from './services/tle-parse';
export { PASS_DEFAULTS, PASS_LIMITS, PropagationError, computePassWindows } from './services/pass-windows';
export {
  m3add,
  m3diag,
  m3diagOf,
  m3fromQuat,
  m3identity,
  m3inverse,
  m3mul,
  m3mulVec,
  m3scale,
  m3skew,
  m3sub,
  m3symmetrize,
  m3transpose,
  rotateDiagCovariance,
  type Mat3,
} from './services/mat3';
export {
  MekfAttitudeEstimator,
  NASA42_MEKF_CONFIG,
  arcsecToRad,
  degPerHrToRadPerS,
  degPerRtHrToRadPerRtS,
  type MekfConfig,
  type MekfDiagnostics,
  type MekfUpdateResult,
} from './services/mekf-attitude-estimator';
export {
  CFS_SAT_SENSOR_NOISE,
  MEMS_TEST_SENSOR_NOISE,
  SatSensorSim,
  type SensorNoiseConfig,
} from './services/sat-sensor-sim';
export { EstimatingSimAdapter, type EstimatorReadout } from './services/estimating-sim-adapter';
export type { SatAdcsTelemetry, SatEstimatorTelemetry } from './services/sat-fleet';
export {
  AdcsModeManager,
  DEFAULT_MODE_CONFIG,
  ModeCommandError,
  type AdcsMode,
  type AdcsModeConfig,
  type AdcsModeTelemetry,
  type ControlLawCommand,
  type ModeTickInput,
  type ModeTickOutput,
} from './services/adcs-mode-manager';
export type {
  ConjunctionEvent,
  ConjunctionOptions,
  ConjunctionReport,
  OrbitTrack,
  OrbitTrackOptions,
  OrbitTrackPoint,
  TleCatalogEntry,
} from './model/orbit-types';
export { TRACK_DEFAULTS, TRACK_LIMITS, computeOrbitTrack } from './services/orbit-track';
export { SCREEN_DEFAULTS, SCREEN_LIMITS, screenConjunctions, type ScreenEntry } from './services/conjunction-screen';
export { CatalogError, TleCatalog } from './services/tle-catalog';
