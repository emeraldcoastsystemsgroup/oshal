/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | night 1: shared domain types for attitude dynamics
 *                     |                             | and reaction-wheel control (state, config, limits).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | W2: MtbClusterConfig (magnetorquer limits,
 *                     |                             | enforced by the propagator per executing-layer doctrine)
 *                     |                             | + optional SatAttitudeState.bFieldBody so the sensed
 *                     |                             | magnetic field flows through getState()/telemetry
 *                     |                             | uniformly from both engines. Both additive — every W1
 *                     |                             | construction site and test stays valid.
 */

/** @description A 3-vector in the satellite body frame unless stated otherwise. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * @description Unit quaternion, scalar-first Hamilton convention. Attitude quaternions map
 * BODY-frame coordinates to INERTIAL (v_I = q ⊗ v_B ⊗ q*), the convention under which the
 * kinematics are q̇ = ½·q⊗[0, ω_body]. All sat-ops code holds this one convention;
 * conversions happen at adapter boundaries, never mid-pipeline.
 */
export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

/**
 * @description Instantaneous truth state of one satellite's attitude channel. `omega` is the
 * body angular rate (rad/s); `wheelMomentum` is the 3-axis reaction-wheel cluster's stored
 * angular momentum (N·m·s) along the body axes. W1 exposes truth state directly; the W2 EKF
 * will layer estimated state beside it, never replacing it (the sim keeps truth for scoring).
 */
export interface SatAttitudeState {
  /** Simulation time, seconds since reset. */
  t: number;
  /** Body attitude, body → inertial. Always unit-norm after every propagator step. */
  q: Quat;
  /** Body angular velocity, rad/s. */
  omega: Vec3;
  /** Reaction-wheel cluster momentum along body axes, N·m·s. */
  wheelMomentum: Vec3;
  /** Sensed magnetic field, body frame, tesla. Undefined when no field model / mag data. */
  bFieldBody?: Vec3;
}

/**
 * @description Actuator limits for the 3-orthogonal-wheel cluster. The PROPAGATOR enforces
 * these (per-axis torque clamp; a wheel at momentum saturation accepts no torque that grows
 * it further) so a controller can never cheat physics by commanding more than the hardware
 * model allows — the same "validation lives at the executing layer" doctrine as drone-ops.
 */
export interface WheelLimits {
  /** Max torque magnitude one wheel axis can exert, N·m. */
  maxTorqueNm: number;
  /** Max momentum magnitude one wheel axis can store before saturating, N·m·s. */
  maxMomentumNms: number;
}

/**
 * @description Physical configuration of one simulated satellite. Inertia is the diagonal of
 * the body-frame inertia tensor (principal axes assumed — honest W1 simplification, stated in
 * ADR-102; NASA 42 is the referee for everything this model omits).
 */
export interface SatBodyConfig {
  /** Principal moments of inertia (Ixx, Iyy, Izz), kg·m². */
  inertia: Vec3;
  wheels: WheelLimits;
}

/**
 * @description Magnetorquer cluster limits, enforced by the propagator (executing-layer
 * doctrine, like {@link WheelLimits}): a controller can command any body dipole, but each rod
 * is clamped to its saturation before the torque τ = m×B is applied.
 */
export interface MtbClusterConfig {
  /** Rod axes in the body frame. */
  axes: Vec3[];
  /** Per-rod dipole saturation (A·m²). */
  maxDipoleAm2: number[];
}
