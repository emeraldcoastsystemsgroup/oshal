/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | the ADCS mode manager — a deterministic Mealy machine
 *                     |                             | over SAFE/DETUMBLE/SLEW/POINT/DESAT, ticked once per
 *                     |                             | control step. All timing is sim-time keyed (never wall
 *                     |                             | clock / tick counts) so it is identical at RK4 dt=0.1s
 *                     |                             | and 42 FSW dt=0.2s and trivially replayable. SAFE is the
 *                     |                             | fault floor (zero torque, never auto-exits). Chatter is
 *                     |                             | killed three ways: hysteresis pairs, per-condition
 *                     |                             | confirm timers, and a minimum dwell before any exit. It
 *                     |                             | emits a control-LAW command; the node maps law→torque.
 */

import { createChildLogger } from '@/shared/logger';
import type { Quat, SatAttitudeState, Vec3 } from '../model/sat-types';
import { attitudeSeparationDeg, vNorm } from './sat-math';

const logger = createChildLogger({ module: 'sat-ops:modes' });
const DEG = Math.PI / 180;

/** The five ADCS modes. SAFE is the fault floor. */
export type AdcsMode = 'SAFE' | 'DETUMBLE' | 'SLEW' | 'POINT' | 'DESAT';

/** Thrown when a point command arrives while the attitude estimate is unhealthy. */
export class ModeCommandError extends Error {}

/** The control law the manager selects; the NODE maps it to actual wheel/MTB commands. */
export type ControlLawCommand =
  | { kind: 'zeroTorque' }
  | { kind: 'rateDamp'; timeConstantS: number }
  | { kind: 'quatPd'; target: Quat; regime: 'slew' | 'fine' }
  | { kind: 'desat'; holdTarget: Quat | null };

/** One tick's inputs — sensed state + two engine-computed scalars. */
export interface ModeTickInput {
  state: SatAttitudeState;
  /** Attitude estimate trustworthy for pointing (RK4 truth = true; 42 = calibrated ∧ low-uncertainty). */
  ekfHealthy: boolean;
  /** Wheel momentum as a fraction of saturation (per-axis / per-wheel, computed by the caller). */
  wheelMomentumFrac: number;
}

/** W3 fleet-panel telemetry row. */
export interface AdcsModeTelemetry {
  mode: AdcsMode;
  reason: string;
  sinceT: number;
  timeInModeS: number;
  transitionCount: number;
  momentumFrac: number;
  dumping: boolean;
  hasTarget: boolean;
  pointingErrorDeg: number | null;
}

/** One tick's output: the active mode, the control law, dumping flag, and telemetry. */
export interface ModeTickOutput {
  mode: AdcsMode;
  law: ControlLawCommand;
  dumping: boolean;
  telemetry: AdcsModeTelemetry;
}

/** Tunable thresholds — every autonomous guard is a hysteresis pair + a confirm timer. */
export interface AdcsModeConfig {
  omegaHiRadS: number;
  omegaLoRadS: number;
  rateConfirmS: number;
  detumbleExitConfirmS: number;
  slewEnterDeg: number;
  pointEnterDeg: number;
  pointExitDeg: number;
  pointEnterConfirmS: number;
  dumpStartFrac: number;
  dumpStopFrac: number;
  desatEnterFrac: number;
  desatExitFrac: number;
  momentumConfirmS: number;
  ekfGraceS: number;
  minDwellS: number;
}

/** Default thresholds (see ADR-102 W2 design; deg constants converted to rad here). */
export const DEFAULT_MODE_CONFIG: AdcsModeConfig = {
  omegaHiRadS: 3.0 * DEG,
  omegaLoRadS: 0.5 * DEG,
  rateConfirmS: 1.0,
  detumbleExitConfirmS: 5.0,
  slewEnterDeg: 10.0,
  pointEnterDeg: 3.0,
  pointExitDeg: 10.0,
  pointEnterConfirmS: 2.0,
  dumpStartFrac: 0.7,
  dumpStopFrac: 0.4,
  desatEnterFrac: 0.95,
  desatExitFrac: 0.4,
  momentumConfirmS: 1.0,
  ekfGraceS: 5.0,
  minDwellS: 2.0,
};

type PendingCommand = { kind: 'safe' | 'detumble' | 'desat' } | { kind: 'point'; target: Quat };

/**
 * @description The deterministic ADCS mode state machine. Pure and synchronous: `tick(input)`
 * advances the machine and returns the control law + telemetry; command methods stage one
 * operator command consumed on the next tick. No wall clock, no async, no LLM.
 */
export class AdcsModeManager {
  private readonly cfg: AdcsModeConfig;

  private modeState: AdcsMode = 'SAFE';

  private modeEnteredT = 0;

  private reason = 'init';

  private transitionCount = 0;

  private latchedTarget: Quat | null = null;

  private dumping = false;

  private pending: PendingCommand | null = null;

  private lastT: number | null = null;

  private lastEkfHealthy = false;

  private held: Record<string, number | null> = {};

  constructor(config: Partial<AdcsModeConfig> = {}) {
    this.cfg = { ...DEFAULT_MODE_CONFIG, ...config };
  }

  /** @returns The current mode. */
  mode(): AdcsMode {
    return this.modeState;
  }

  /** @returns The latest telemetry snapshot (also embedded in each tick output). */
  telemetry(): AdcsModeTelemetry {
    return {
      mode: this.modeState,
      reason: this.reason,
      sinceT: this.modeEnteredT,
      timeInModeS: (this.lastT ?? this.modeEnteredT) - this.modeEnteredT,
      transitionCount: this.transitionCount,
      momentumFrac: 0,
      dumping: this.dumping,
      hasTarget: this.latchedTarget !== null,
      pointingErrorDeg: null,
    };
  }

  /** @description Stage an operator SAFE command (fault floor; clears the latched target). */
  commandSafe(): void {
    this.pending = { kind: 'safe' };
  }

  /** @description Stage an operator DETUMBLE command. */
  commandDetumble(): void {
    this.pending = { kind: 'detumble' };
  }

  /** @description Stage an operator DESAT command. */
  commandDesat(): void {
    this.pending = { kind: 'desat' };
  }

  /**
   * @description Stage an operator POINT command to `target`. Refused when the attitude
   * estimate was unhealthy on the last tick — the same gate as W1's calibrated() check.
   * @param target - Desired body→inertial attitude.
   */
  commandPoint(target: Quat): void {
    if (this.lastT !== null && !this.lastEkfHealthy) {
      throw new ModeCommandError('attitude estimate not healthy — cannot accept a pointing target');
    }
    this.pending = { kind: 'point', target };
  }

  /**
   * @description Advance the machine one control step.
   * @param input - Sensed state + EKF health + momentum fraction.
   * @returns The active mode, control law, dumping flag, and telemetry.
   */
  tick(input: ModeTickInput): ModeTickOutput {
    const { state, ekfHealthy, wheelMomentumFrac: frac } = input;
    const t = state.t;
    if (this.lastT !== null && t < this.lastT) {
      this.held = {};
      this.latchedTarget = null;
      this.dumping = false;
      this.forceMode('SAFE', t, 'time-went-backwards');
    }
    this.lastT = t;
    this.lastEkfHealthy = ekfHealthy;

    const w = vNorm(state.omega);
    const e = this.latchedTarget ? attitudeSeparationDeg(state.q, this.latchedTarget) : null;
    this.updateTimers(w, e, frac, ekfHealthy, t);

    const cmd = this.pending;
    this.pending = null;
    this.evaluate(cmd, state, e, t);
    this.updateDumping(frac, t);
    // Re-derive the reported error against whatever target is now latched.
    const reportedErr = this.latchedTarget ? attitudeSeparationDeg(state.q, this.latchedTarget) : null;
    return this.buildOutput(frac, reportedErr, t);
  }

  /** Refresh every condition's held-since timestamp against its predicate. */
  private updateTimers(w: number, e: number | null, frac: number, ekfHealthy: boolean, t: number): void {
    this.setHeld('rateEmergency', w > this.cfg.omegaHiRadS, t);
    this.setHeld('detumbleComplete', w < this.cfg.omegaLoRadS, t);
    this.setHeld('slewConverged', e !== null && e < this.cfg.pointEnterDeg, t);
    this.setHeld('pointDiverged', e !== null && e > this.cfg.pointExitDeg, t);
    this.setHeld('desatComplete', frac <= this.cfg.desatExitFrac, t);
    this.setHeld('momentumEmergency', frac >= this.cfg.desatEnterFrac, t);
    this.setHeld('dumpStart', frac >= this.cfg.dumpStartFrac, t);
    this.setHeld('ekfFault', !ekfHealthy, t);
  }

  /** Priority-ordered transition evaluation; the first firing rule wins. */
  private evaluate(cmd: PendingCommand | null, state: SatAttitudeState, e: number | null, t: number): void {
    if (cmd?.kind === 'safe') {
      this.latchedTarget = null;
      this.forceMode('SAFE', t, 'operator-safe');
      return;
    }
    // P1 rate emergency → DETUMBLE, ONLY from the quiescent modes (POINT/DESAT) where a high
    // rate is anomalous. SLEW is a commanded high-rate maneuver — its natural slew rate can
    // legitimately exceed OMEGA_HI, so a rate spike there is nominal, not a tumble; SLEW
    // converges to POINT (rates fall near the target) or the operator intervenes. SAFE is
    // sticky and DETUMBLE is already damping.
    if ((this.modeState === 'POINT' || this.modeState === 'DESAT') && this.fired('rateEmergency', this.cfg.rateConfirmS, t, false)) {
      this.forceMode('DETUMBLE', t, 'rate-emergency');
      return;
    }
    // P2 EKF fault (SLEW|POINT only — DETUMBLE/DESAT need no attitude)
    if ((this.modeState === 'SLEW' || this.modeState === 'POINT') && this.fired('ekfFault', this.cfg.ekfGraceS, t, false)) {
      this.latchedTarget = null;
      this.forceMode('SAFE', t, 'ekf-unhealthy');
      return;
    }
    // P3 momentum emergency (SLEW|POINT|DETUMBLE → DESAT)
    if (['SLEW', 'POINT', 'DETUMBLE'].includes(this.modeState) && this.fired('momentumEmergency', this.cfg.momentumConfirmS, t, false)) {
      this.forceMode('DESAT', t, 'momentum-emergency');
      return;
    }
    // P4 operator commands
    if (cmd && this.applyOperator(cmd, state, t)) return;
    // P5 nominal autonomous transitions
    this.evaluateNominal(e, t);
  }

  /** Apply an operator detumble/desat/point command; returns whether one fired. */
  private applyOperator(cmd: PendingCommand, state: SatAttitudeState, t: number): boolean {
    if (cmd.kind === 'detumble') { this.forceMode('DETUMBLE', t, 'operator-detumble'); return true; }
    if (cmd.kind === 'desat') { this.forceMode('DESAT', t, 'operator-desat'); return true; }
    if (cmd.kind === 'point') {
      this.latchedTarget = cmd.target;
      if (this.modeState === 'DESAT') { this.reason = 'target-latched-during-desat'; return true; }
      // Error against the NEW target from the live state: a far target enters SLEW, a near one POINT.
      const liveErr = attitudeSeparationDeg(state.q, cmd.target);
      this.forceMode(liveErr >= this.cfg.slewEnterDeg ? 'SLEW' : 'POINT', t, 'operator-point');
      return true;
    }
    return false;
  }

  /** The P5 nominal transitions (dwell-gated). */
  private evaluateNominal(e: number | null, t: number): void {
    if (this.modeState === 'DETUMBLE' && this.fired('detumbleComplete', this.cfg.detumbleExitConfirmS, t)) {
      this.resumeOrSafe(e, t, 'detumble-complete');
    } else if (this.modeState === 'SLEW' && this.fired('slewConverged', this.cfg.pointEnterConfirmS, t)) {
      this.forceMode('POINT', t, 'slew-converged');
    } else if (this.modeState === 'POINT' && this.fired('pointDiverged', this.cfg.rateConfirmS, t)) {
      this.forceMode('SLEW', t, 'pointing-diverged');
    } else if (this.modeState === 'DESAT' && this.fired('desatComplete', this.cfg.momentumConfirmS, t)) {
      if (this.latchedTarget && this.lastEkfHealthy) this.resumeOrSafe(e, t, 'desat-complete');
      else this.forceMode('SAFE', t, 'desat-complete');
    }
  }

  /** Resume the latched target (re-splitting SLEW/POINT on error) or fall to SAFE. */
  private resumeOrSafe(e: number | null, t: number, reason: string): void {
    if (!this.latchedTarget) { this.forceMode('SAFE', t, reason); return; }
    const err = e ?? this.cfg.slewEnterDeg + 1;
    this.forceMode(err >= this.cfg.slewEnterDeg ? 'SLEW' : 'POINT', t, reason);
  }

  /** Concurrent-dumping hysteresis latch — active only in SLEW|POINT. */
  private updateDumping(frac: number, t: number): void {
    if (this.modeState !== 'SLEW' && this.modeState !== 'POINT') { this.dumping = false; return; }
    if (this.dumping && frac <= this.cfg.dumpStopFrac) this.dumping = false;
    else if (!this.dumping && this.fired('dumpStart', this.cfg.momentumConfirmS, t, false)) this.dumping = true;
  }

  /** Assemble the control law + telemetry for the current mode. */
  private buildOutput(frac: number, e: number | null, t: number): ModeTickOutput {
    let law: ControlLawCommand;
    switch (this.modeState) {
      case 'DETUMBLE': law = { kind: 'rateDamp', timeConstantS: 50 }; break;
      case 'SLEW': law = { kind: 'quatPd', target: this.latchedTarget ?? { w: 1, x: 0, y: 0, z: 0 }, regime: 'slew' }; break;
      case 'POINT': law = { kind: 'quatPd', target: this.latchedTarget ?? { w: 1, x: 0, y: 0, z: 0 }, regime: 'fine' }; break;
      case 'DESAT': law = { kind: 'desat', holdTarget: this.latchedTarget }; break;
      default: law = { kind: 'zeroTorque' };
    }
    const telemetry: AdcsModeTelemetry = {
      mode: this.modeState,
      reason: this.reason,
      sinceT: this.modeEnteredT,
      timeInModeS: t - this.modeEnteredT,
      transitionCount: this.transitionCount,
      momentumFrac: frac,
      dumping: this.dumping,
      hasTarget: this.latchedTarget !== null,
      pointingErrorDeg: e,
    };
    return { mode: this.modeState, law, dumping: this.dumping, telemetry };
  }

  /** Set held-since for a condition from its current predicate value. */
  private setHeld(key: string, predicate: boolean, t: number): void {
    if (predicate) { if (this.held[key] == null) this.held[key] = t; }
    else this.held[key] = null;
  }

  /** Whether a condition has held long enough (and dwell is satisfied, unless bypassed). */
  private fired(key: string, confirmS: number, t: number, requireDwell = true): boolean {
    const since = this.held[key];
    if (since == null || t - since < confirmS) return false;
    return !requireDwell || t - this.modeEnteredT >= this.cfg.minDwellS;
  }

  /** Commit a mode change (or just update the reason when the mode is unchanged). */
  private forceMode(mode: AdcsMode, t: number, reason: string): void {
    if (mode !== this.modeState) {
      logger.info({ from: this.modeState, to: mode, reason, t }, 'ADCS mode transition');
      this.modeState = mode;
      this.modeEnteredT = t;
      this.transitionCount++;
    }
    this.reason = reason;
  }
}
