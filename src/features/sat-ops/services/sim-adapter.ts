/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | night 1: the SatSimAdapter contract every attitude
 *                     |                             | simulator implements (in-house RK4 today, NASA 42
 *                     |                             | container adapter next). Commands never leave the sim.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Contract goes ASYNC (night 1 round 2): the
 *                     |                             | NASA-42 adapter is a TCP client in lockstep with the
 *                     |                             | sim process, so step/reset/getState return Promises.
 *                     |                             | Engines MAY reject reset (42 resets by restarting the
 *                     |                             | container); the RK4 sim supports it fully.
 */

import type { SatAttitudeState, Vec3 } from '../model/sat-types';

/**
 * @description The single seam between control code and attitude physics (ADR-102 §2). All
 * controllers, mode logic, and (later) the sat-node runtime talk ONLY to this interface, so
 * the in-house RK4 gyrostat propagator and the NASA-42 socket adapter are interchangeable —
 * the same pattern as `DroneProvider` (sim / MAVLink) in drone-ops. There is deliberately no
 * "send to vehicle" member: commands-never-leave-sim is structural, not a flag.
 *
 * All members are async because a real engine may live across a socket (NASA 42 in its
 * container) — the in-process RK4 sim simply resolves immediately.
 */
export interface SatSimAdapter {
  /** Stable identifier for this simulated vehicle (becomes the sat-node agent identity). */
  readonly id: string;

  /**
   * @description Human sentence naming the engine and its fidelity, for surfaces and logs
   * (e.g. "in-house RK4 gyrostat propagator, rigid body + 3 wheels").
   * @returns The description.
   */
  describe(): string;

  /**
   * @description Reset the simulation to `initial`, filling any omitted fields with the
   * engine's defaults (identity attitude, zero rates, zero wheel momentum, t = 0). Engines
   * that cannot reset in place (NASA 42 — restart its container instead) MUST reject with a
   * clear error rather than silently ignoring the request.
   * @param initial - Partial initial state to apply.
   * @returns The full state actually in effect after the reset.
   */
  reset(initial?: Partial<SatAttitudeState>): Promise<SatAttitudeState>;

  /**
   * @description Read the current state as the engine best knows it. The RK4 sim returns
   * truth; the 42 adapter returns the SENSED state (star-tracker attitude, gyro rates,
   * wheel tachometer momenta) — 42 keeps truth on its side of the socket, which is exactly
   * the honesty boundary an independent referee should have.
   * @returns A defensive copy of the current state.
   */
  getState(): Promise<SatAttitudeState>;

  /**
   * @description Advance the simulation by one step with the given wheel torque command
   * held constant (zero-order hold). The ENGINE enforces actuator limits — torque clamp and
   * momentum saturation — so callers get the physics they asked the hardware model for, not
   * the physics they wished for.
   * @param dtSeconds - Requested step size, seconds. Engines with a fixed control cadence
   *   (42's FSW sample time) advance by THEIR step and the caller reads the actual elapsed
   *   time from the returned state's `t` — passing a mismatched dt is not an error, it is
   *   simply not what happens.
   * @param wheelTorqueCmd - Commanded wheel torque along body axes, N·m.
   * @param mtbDipoleCmd - Optional magnetorquer dipole command along body axes, A·m². The
   *   engine clamps it per rod (executing-layer doctrine); engines with no field model accept
   *   and IGNORE it — commanding torquers in zero field is a physical no-op, not an error.
   * @returns The state after the step.
   */
  step(dtSeconds: number, wheelTorqueCmd: Vec3, mtbDipoleCmd?: Vec3): Promise<SatAttitudeState>;
}
