/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W2:
 *                     |                             | ADCS mode-manager transition-table coverage. Pure
 *                     |                             | sim-time-keyed ticks: SAFE stickiness, rate-emergency
 *                     |                             | preemption, EKF-grace ride-through, momentum
 *                     |                             | escalation, SLEW↔POINT hysteresis, chatter resistance
 *                     |                             | at a boundary, concurrent-dump latch, command gating.
 */

import { describe, expect, it } from 'vitest';
import { AdcsModeManager, ModeCommandError, quatFromAxisAngle, quatIdentity, type Quat, type SatAttitudeState } from '@/features/sat-ops';

const DEG = Math.PI / 180;
const AT_REST = { x: 0, y: 0, z: 0 };

function st(t: number, opts: { omega?: { x: number; y: number; z: number }; q?: Quat } = {}): SatAttitudeState {
  return { t, q: opts.q ?? quatIdentity(), omega: opts.omega ?? AT_REST, wheelMomentum: AT_REST };
}

/** Tick the manager over [t0, t1) at dt with fixed health/frac; returns the final output. */
function run(mgr: AdcsModeManager, t0: number, t1: number, dt: number, health: boolean, frac: number, stateAt: (t: number) => SatAttitudeState): ReturnType<AdcsModeManager['tick']> {
  let out = mgr.tick({ state: stateAt(t0), ekfHealthy: health, wheelMomentumFrac: frac });
  for (let t = t0 + dt; t < t1; t += dt) out = mgr.tick({ state: stateAt(t), ekfHealthy: health, wheelMomentumFrac: frac });
  return out;
}

describe('sat-ops ADCS mode manager', () => {
  it('starts in SAFE and stays there under a tumble (fault floor never auto-exits)', () => {
    const mgr = new AdcsModeManager();
    const tumble = { x: 5 * DEG, y: 0, z: 0 }; // 5°/s > 3°/s emergency
    const out = run(mgr, 0, 10, 0.2, true, 0, (t) => st(t, { omega: tumble }));
    expect(out.mode).toBe('SAFE'); // SAFE is sticky — even a tumble only awaits an operator
    expect(out.law.kind).toBe('zeroTorque');
  });

  it('operator detumble → DETUMBLE, then auto-completes to SAFE when rates fall', () => {
    const mgr = new AdcsModeManager();
    mgr.commandDetumble();
    let out = run(mgr, 0, 4, 0.2, true, 0, (t) => st(t, { omega: { x: 5 * DEG, y: 0, z: 0 } }));
    expect(out.mode).toBe('DETUMBLE');
    expect(out.law.kind).toBe('rateDamp');
    // rates drop below 0.5°/s and hold 5s (+dwell) → SAFE (no latched target)
    out = run(mgr, 4, 20, 0.2, true, 0, (t) => st(t, { omega: { x: 0.1 * DEG, y: 0, z: 0 } }));
    expect(out.mode).toBe('SAFE');
    expect(out.telemetry.reason).toBe('detumble-complete');
  });

  it('rate emergency preempts POINT → DETUMBLE and latches the target for resume', () => {
    const mgr = new AdcsModeManager();
    const target = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 1 * DEG); // 1° error → POINT directly
    mgr.commandPoint(target);
    let out = run(mgr, 0, 4, 0.2, true, 0, () => st(0, { q: quatIdentity() }));
    expect(out.mode).toBe('POINT');
    // a tumble erupts
    out = run(mgr, 4, 8, 0.2, true, 0, (t) => st(t, { omega: { x: 5 * DEG, y: 0, z: 0 } }));
    expect(out.mode).toBe('DETUMBLE');
    expect(out.telemetry.reason).toBe('rate-emergency');
    expect(out.telemetry.hasTarget).toBe(true); // latched for autonomous resume
  });

  it('rides a 5s EKF outage without leaving POINT, then SAFEs if it persists', () => {
    const mgr = new AdcsModeManager();
    mgr.commandPoint(quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 1 * DEG));
    run(mgr, 0, 4, 0.2, true, 0, () => st(0));
    expect(mgr.mode()).toBe('POINT');
    // 4s of unhealthy (< 5s grace) → still POINT
    let out = run(mgr, 4, 8, 0.2, false, 0, (t) => st(t));
    expect(out.mode).toBe('POINT');
    // past the 5s grace → SAFE
    out = run(mgr, 8, 12, 0.2, false, 0, (t) => st(t));
    expect(out.mode).toBe('SAFE');
    expect(out.telemetry.reason).toBe('ekf-unhealthy');
  });

  it('escalates to DESAT at 95% momentum and returns to the latched target at 40%', () => {
    const mgr = new AdcsModeManager();
    mgr.commandPoint(quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 1 * DEG));
    run(mgr, 0, 4, 0.2, true, 0.5, () => st(0));
    expect(mgr.mode()).toBe('POINT');
    let out = run(mgr, 4, 8, 0.2, true, 0.97, (t) => st(t));
    expect(out.mode).toBe('DESAT');
    expect(out.telemetry.reason).toBe('momentum-emergency');
    out = run(mgr, 8, 14, 0.2, true, 0.3, (t) => st(t));
    expect(out.mode).toBe('POINT'); // 1° target → POINT (re-split on error)
    expect(out.telemetry.reason).toBe('desat-complete');
  });

  it('concurrent-dump latch fires at 70% and clears at 40% inside POINT (no mode change)', () => {
    const mgr = new AdcsModeManager();
    mgr.commandPoint(quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 1 * DEG));
    run(mgr, 0, 4, 0.2, true, 0.3, () => st(0));
    let out = run(mgr, 4, 7, 0.2, true, 0.75, (t) => st(t));
    expect(out.mode).toBe('POINT');
    expect(out.dumping).toBe(true);
    out = run(mgr, 7, 10, 0.2, true, 0.35, (t) => st(t));
    expect(out.mode).toBe('POINT');
    expect(out.dumping).toBe(false);
  });

  it('SLEW hysteresis resists chatter inside the 3°/10° dead band', () => {
    const mgr = new AdcsModeManager();
    const target = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 15 * DEG);
    // Command with the body at identity → 15° error ≥ 10° SLEW-enter threshold → SLEW.
    mgr.commandPoint(target);
    let out = mgr.tick({ state: st(0, { q: quatIdentity() }), ekfHealthy: true, wheelMomentumFrac: 0 });
    expect(out.mode).toBe('SLEW');
    // Now hold the error dithering in [4°, 9°] — inside the dead band, so SLEW→POINT (needs
    // <3° sustained) never fires and it must NOT chatter.
    let flips = 0;
    let prev = out.mode;
    for (let t = 0.2; t < 12; t += 0.2) {
      const errDeg = 6.5 + 2.5 * Math.sin(t * 7); // 4°..9°
      const q = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, (15 - errDeg) * DEG);
      out = mgr.tick({ state: st(t, { q }), ekfHealthy: true, wheelMomentumFrac: 0 });
      if (out.mode !== prev) flips++;
      prev = out.mode;
    }
    expect(out.mode).toBe('SLEW');
    expect(flips).toBe(0); // no chatter — stays SLEW the whole time
  });

  it('operator SAFE preempts anything immediately, bypassing dwell', () => {
    const mgr = new AdcsModeManager();
    mgr.commandDetumble();
    run(mgr, 0, 1, 0.2, true, 0, (t) => st(t, { omega: { x: 5 * DEG, y: 0, z: 0 } }));
    expect(mgr.mode()).toBe('DETUMBLE');
    mgr.commandSafe();
    const out = mgr.tick({ state: st(1.2, { omega: { x: 5 * DEG, y: 0, z: 0 } }), ekfHealthy: true, wheelMomentumFrac: 0 });
    expect(out.mode).toBe('SAFE'); // immediate, even under a tumble and below min-dwell
    expect(out.telemetry.hasTarget).toBe(false);
  });

  it('refuses a point command when the estimate is unhealthy', () => {
    const mgr = new AdcsModeManager();
    mgr.tick({ state: st(0), ekfHealthy: false, wheelMomentumFrac: 0 });
    expect(() => mgr.commandPoint(quatIdentity())).toThrow(ModeCommandError);
  });

  it('a single-tick rate spike in POINT does NOT trip rate-emergency (confirm timer)', () => {
    const mgr = new AdcsModeManager();
    mgr.commandPoint(quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 1 * DEG));
    run(mgr, 0, 4, 0.2, true, 0, () => st(0));
    expect(mgr.mode()).toBe('POINT');
    // one glitchy tick at 5°/s (sensor spike), then back at rest — must NOT preempt
    mgr.tick({ state: st(4.2, { omega: { x: 5 * DEG, y: 0, z: 0 } }), ekfHealthy: true, wheelMomentumFrac: 0 });
    const out = run(mgr, 4.4, 8, 0.2, true, 0, (t) => st(t));
    expect(out.mode).toBe('POINT'); // if the confirm timer is deleted, this flips to DETUMBLE
  });

  it('detumble-complete respects the confirm window — no instant DETUMBLE→SAFE flip', () => {
    const mgr = new AdcsModeManager();
    mgr.commandDetumble();
    // Rates are ALREADY quiescent: completion still needs the condition to HOLD, not one sample.
    let out = run(mgr, 0, 2, 0.2, true, 0, (t) => st(t, { omega: { x: 0.1 * DEG, y: 0, z: 0 } }));
    expect(out.mode).toBe('DETUMBLE'); // 2s < the 5s confirm (+dwell) — a deleted timer flips instantly
    out = run(mgr, 2, 20, 0.2, true, 0, (t) => st(t, { omega: { x: 0.1 * DEG, y: 0, z: 0 } }));
    expect(out.mode).toBe('SAFE'); // and it DOES complete once the window is served
  });

  it('falls to SAFE when sim time goes backwards (engine reset)', () => {
    const mgr = new AdcsModeManager();
    mgr.commandDetumble();
    run(mgr, 0, 4, 0.2, true, 0, (t) => st(t, { omega: { x: 5 * DEG, y: 0, z: 0 } }));
    expect(mgr.mode()).toBe('DETUMBLE');
    const out = mgr.tick({ state: st(0), ekfHealthy: true, wheelMomentumFrac: 0 }); // t reset to 0
    expect(out.mode).toBe('SAFE');
    expect(out.telemetry.reason).toBe('time-went-backwards');
  });
});
