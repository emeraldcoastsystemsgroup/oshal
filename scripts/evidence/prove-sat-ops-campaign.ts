/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W4:
 *                     |                             | the scored evidence campaign. N seeded randomized
 *                     |                             | closed-loop scenarios through the FULL ADCS stack
 *                     |                             | (RK4 truth + CFS-noise sensors + MEKF + mode manager
 *                     |                             | + PD + magnetorquer desat): random tumble → DETUMBLE,
 *                     |                             | random slew → SLEW/POINT settle, 60 s fine hold
 *                     |                             | (TRUTH pointing RMS — the estimator is not allowed to
 *                     |                             | grade its own homework), a 30 s ST outage ride-through,
 *                     |                             | and a momentum fault → autonomous DESAT → recovery.
 *                     |                             | Deterministic per seed; emits docs/evidence JSON + MD.
 *                     |                             | Run: npx ts-node -r tsconfig-paths/register
 *                     |                             |   scripts/evidence/prove-sat-ops-campaign.ts [runs]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  AdcsModeManager,
  CFS_SAT_SENSOR_NOISE,
  DEFAULT_DESAT_CONFIG_RK4,
  DEFAULT_MTB_CONFIG,
  DEFAULT_SAT_CONFIG,
  EstimatingSimAdapter,
  MekfAttitudeEstimator,
  MtbDesatController,
  QuaternionPdController,
  Rk4PropagatorSim,
  SatSensorSim,
  attitudeSeparationDeg,
  degPerHrToRadPerS,
  degPerRtHrToRadPerRtS,
  quatFromAxisAngle,
  quatMultiply,
  vNorm,
  type ControlLawCommand,
  type Quat,
  type SatAttitudeState,
  type Vec3,
} from '@/features/sat-ops';

const RUNS = Math.max(10, Math.min(1000, Number(process.argv[2]) || 200));
const DT = 0.2;
const HMAX = DEFAULT_SAT_CONFIG.wheels.maxMomentumNms;
const DEG = Math.PI / 180;

/** Pass/fail criteria — the campaign's published bar. */
const CRITERIA = {
  detumbleMaxS: 300,     // tumble (0.5–3 °/s) damped under 0.5 °/s
  settleMaxS: 300,       // commanded slew settled under 1° (estimated)
  holdRmsMaxDeg: 0.5,    // TRUTH pointing RMS over the 60 s fine hold
  estGapMaxDeg: 0.25,    // |truth − estimate| during the hold (estimator honesty)
  outageDriftMaxDeg: 1.5, // TRUTH error growth while the ST is dark 30 s (dead-reckoning)
  // Momentum-fault recovery is DIPOLE-LIMITED physics, not a controller property: dumping
  // Δh = (0.97−0.4)·0.35 ≈ 0.20 N·m·s at m·|B| = 5 A·m² × 35 µT ≈ 1.75e-4 N·m at ~50–100%
  // field-geometry duty ≈ 1500–3300 sim-s (measured p50 1507 / p95 3110 over 200 seeds),
  // plus the re-slew. 1.5 sim-hours covers the worst-geometry tail honestly.
  recoveryMaxS: 5400,    // momentum fault → autonomous DESAT → back under 1° pointing
  rejectShareMax: 0.10,  // MEKF gate rejections / applied
} as const;

/** Deterministic 32-bit LCG so every run is reproducible from its seed. */
class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s / 2 ** 32; }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  axis(): Vec3 {
    const z = this.range(-1, 1);
    const a = this.range(0, 2 * Math.PI);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return { x: r * Math.cos(a), y: r * Math.sin(a), z };
  }
}

interface RunScore {
  seed: number;
  tumbleDegS: number;
  slewDeg: number;
  detumbleS: number | null;
  settleS: number | null;
  holdRmsDeg: number;
  estGapMaxDeg: number;
  outageDriftDeg: number;
  desatEnteredS: number | null;
  recoveryS: number | null;
  rejectShare: number;
  reinits: number;
  pass: boolean;
  failures: string[];
}

/** One full-stack scenario rig (mirrors the node loop; sim-time only, no wall clock). */
class Rig {
  readonly mgr = new AdcsModeManager();
  readonly sensors: SatSensorSim;
  readonly adapter: EstimatingSimAdapter;
  private readonly pd = new QuaternionPdController({ inertia: DEFAULT_SAT_CONFIG.inertia });
  private readonly desat = new MtbDesatController({ ...DEFAULT_DESAT_CONFIG_RK4, kDesat: 1e-2 });
  state: SatAttitudeState;
  rejectsSeen = 0;

  constructor(seed: number, tumble: Vec3) {
    const sim = new Rk4PropagatorSim(`ev-${seed}`, DEFAULT_SAT_CONFIG, { mag: {}, mtb: DEFAULT_MTB_CONFIG });
    this.sensors = new SatSensorSim({ ...CFS_SAT_SENSOR_NOISE, seed });
    const mekf = new MekfAttitudeEstimator({
      sigmaVRadRtS: degPerRtHrToRadPerRtS(0.007),
      sigmaURadS15: degPerHrToRadPerS(0.01) / 60,
      sigmaTh0Rad: 1.0e-2,
      sigmaB0RadS: 1.5e-7,
      rStDiagRad2: CFS_SAT_SENSOR_NOISE.stNoiseDiagRad2,
      stMount: { w: 1, x: 0, y: 0, z: 0 },
      stLagS: 3 * DT,
    });
    this.adapter = new EstimatingSimAdapter(sim, this.sensors, mekf);
    this.state = { t: 0, q: { w: 1, x: 0, y: 0, z: 0 }, omega: tumble, wheelMomentum: { x: 0, y: 0, z: 0 } };
  }

  async init(tumble: Vec3): Promise<void> {
    this.state = await this.adapter.reset({ omega: tumble });
  }

  private frac(): number {
    const h = this.state.wheelMomentum;
    return Math.max(Math.abs(h.x), Math.abs(h.y), Math.abs(h.z)) / HMAX;
  }

  private torque(law: ControlLawCommand): Vec3 {
    if (law.kind === 'quatPd') return this.pd.computeWheelTorque(this.state, law.target);
    if (law.kind === 'rateDamp' || law.kind === 'desat') {
      const i = DEFAULT_SAT_CONFIG.inertia;
      return { x: (i.x / 50) * this.state.omega.x, y: (i.y / 50) * this.state.omega.y, z: (i.z / 50) * this.state.omega.z };
    }
    return { x: 0, y: 0, z: 0 };
  }

  /** One control tick; returns the manager output. */
  async step(): Promise<ReturnType<AdcsModeManager['tick']>> {
    const est = this.adapter.estimator();
    const healthy = est
      ? Math.hypot(est.attitudeSigmaRad.x, est.attitudeSigmaRad.y, est.attitudeSigmaRad.z) < 0.02
      : this.adapter.attitudeCalibrated();
    const out = this.mgr.tick({ state: this.state, ekfHealthy: healthy, wheelMomentumFrac: this.frac() });
    const wantsDump = out.law.kind === 'desat' || out.dumping;
    const dipole = wantsDump && this.state.bFieldBody
      ? this.desat.computeDipole(this.state.wheelMomentum, this.state.bFieldBody).bodyDipoleAm2
      : undefined;
    this.state = await this.adapter.step(DT, this.torque(out.law), dipole);
    return out;
  }

  async until(pred: () => boolean, maxSimS: number): Promise<number | null> {
    const t0 = this.state.t;
    while (this.state.t - t0 < maxSimS) {
      await this.step();
      if (pred()) return this.state.t - t0;
    }
    return null;
  }
}

/** Run one seeded scenario end-to-end and score it. */
async function runScenario(seed: number): Promise<RunScore> {
  const rng = new Rng(seed);
  const tumbleDegS = rng.range(0.5, 3.0);
  const tumbleAxis = rng.axis();
  const slewDeg = rng.range(10, 60);
  const slewAxis = rng.axis();
  const tumble: Vec3 = { x: tumbleAxis.x * tumbleDegS * DEG, y: tumbleAxis.y * tumbleDegS * DEG, z: tumbleAxis.z * tumbleDegS * DEG };
  const rig = new Rig(seed, tumble);
  await rig.init(tumble);
  const failures: string[] = [];

  // Phase 1 — detumble the random tumble.
  rig.mgr.commandDetumble();
  const detumbleS = await rig.until(() => vNorm(rig.state.omega) < 0.5 * DEG, CRITERIA.detumbleMaxS + 60);
  if (detumbleS === null || detumbleS > CRITERIA.detumbleMaxS) failures.push('detumble');

  // Phase 2 — random slew; settle under 1° (estimated), then a 60 s fine hold scored on TRUTH.
  const target: Quat = quatMultiply(rig.state.q, quatFromAxisAngle(slewAxis, slewDeg * DEG));
  rig.mgr.commandPoint(target);
  const settleS = await rig.until(
    () => rig.mgr.mode() === 'POINT' && attitudeSeparationDeg(rig.state.q, target) < 1,
    CRITERIA.settleMaxS + 120,
  );
  if (settleS === null || settleS > CRITERIA.settleMaxS) failures.push('settle');
  let holdRms = 0;
  let estGapMax = 0;
  let holdN = 0;
  {
    const tEnd = rig.state.t + 60;
    while (rig.state.t < tEnd) {
      await rig.step();
      const truth = await rig.adapter.truthState();
      const truthErr = attitudeSeparationDeg(truth.q, target);
      holdRms += truthErr * truthErr;
      estGapMax = Math.max(estGapMax, attitudeSeparationDeg(truth.q, rig.state.q));
      holdN++;
    }
    holdRms = Math.sqrt(holdRms / Math.max(1, holdN));
  }
  if (holdRms > CRITERIA.holdRmsMaxDeg) failures.push('hold-rms');
  if (estGapMax > CRITERIA.estGapMaxDeg) failures.push('est-gap');

  // Phase 3 — 30 s ST outage mid-hold: the estimator dead-reckons, the mode must survive.
  rig.sensors.setOutage(rig.state.t, rig.state.t + 30);
  let outageDrift = 0;
  {
    const tEnd = rig.state.t + 30;
    while (rig.state.t < tEnd) {
      await rig.step();
      const truth = await rig.adapter.truthState();
      outageDrift = Math.max(outageDrift, attitudeSeparationDeg(truth.q, target));
    }
  }
  if (rig.mgr.mode() !== 'POINT') failures.push('outage-mode-drop');
  if (outageDrift > CRITERIA.outageDriftMaxDeg) failures.push('outage-drift');

  // Phase 4 — momentum fault: preload near saturation, expect autonomous DESAT + recovery.
  const truthNow = await rig.adapter.truthState();
  rig.state = await rig.adapter.reset({ t: truthNow.t, q: truthNow.q, omega: { x: 0, y: 0, z: 0 }, wheelMomentum: { x: 0.97 * HMAX, y: 0, z: 0 } });
  const desatEnteredS = await rig.until(() => rig.mgr.mode() === 'DESAT', 120);
  if (desatEnteredS === null) failures.push('desat-escalation');
  const recoveryS = await rig.until(
    () => rig.mgr.mode() === 'POINT' && attitudeSeparationDeg(rig.state.q, target) < 1,
    CRITERIA.recoveryMaxS,
  );
  if (recoveryS === null) failures.push('fault-recovery');

  const est = rig.adapter.estimator();
  const rejectShare = est && est.updatesApplied > 0 ? est.rejected / (est.rejected + est.updatesApplied) : 0;
  if (rejectShare > CRITERIA.rejectShareMax) failures.push('reject-share');

  return {
    seed,
    tumbleDegS: +tumbleDegS.toFixed(2),
    slewDeg: +slewDeg.toFixed(1),
    detumbleS: detumbleS === null ? null : +detumbleS.toFixed(1),
    settleS: settleS === null ? null : +settleS.toFixed(1),
    holdRmsDeg: +holdRms.toFixed(4),
    estGapMaxDeg: +estGapMax.toFixed(4),
    outageDriftDeg: +outageDrift.toFixed(4),
    desatEnteredS: desatEnteredS === null ? null : +desatEnteredS.toFixed(1),
    recoveryS: recoveryS === null ? null : +recoveryS.toFixed(1),
    rejectShare: +rejectShare.toFixed(4),
    reinits: est ? est.reinits : 0,
    pass: failures.length === 0,
    failures,
  };
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`sat-ops evidence campaign: ${RUNS} seeded scenarios through the full ADCS stack...`);
  const scores: RunScore[] = [];
  for (let i = 0; i < RUNS; i++) {
    scores.push(await runScenario(1000 + i));
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${RUNS} (${scores.filter((s) => s.pass).length} pass)`);
  }
  const passRate = scores.filter((s) => s.pass).length / scores.length;
  const num = (k: (s: RunScore) => number | null): number[] =>
    scores.map(k).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const detumble = num((s) => s.detumbleS);
  const settle = num((s) => s.settleS);
  const rms = num((s) => s.holdRmsDeg);
  const gap = num((s) => s.estGapMaxDeg);
  const drift = num((s) => s.outageDriftDeg);
  const recovery = num((s) => s.recoveryS);
  const failCounts: Record<string, number> = {};
  for (const s of scores) for (const f of s.failures) failCounts[f] = (failCounts[f] || 0) + 1;

  const summary = {
    generated: new Date().toISOString(),
    runs: RUNS,
    engine: 'rk4 + CFS-noise sensors + MEKF + AdcsModeManager + quaternion-PD + MTB desat',
    dtSeconds: DT,
    criteria: CRITERIA,
    passRate: +passRate.toFixed(4),
    percentiles: {
      detumbleS: { p50: pct(detumble, 50), p95: pct(detumble, 95) },
      settleS: { p50: pct(settle, 50), p95: pct(settle, 95) },
      holdRmsDeg: { p50: pct(rms, 50), p95: pct(rms, 95) },
      estGapMaxDeg: { p50: pct(gap, 50), p95: pct(gap, 95) },
      outageDriftDeg: { p50: pct(drift, 50), p95: pct(drift, 95) },
      recoveryS: { p50: pct(recovery, 50), p95: pct(recovery, 95) },
    },
    failureCounts: failCounts,
    wallSeconds: +((Date.now() - t0) / 1000).toFixed(1),
    runsDetail: scores,
  };

  const day = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(process.cwd(), 'docs/evidence');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `sat-ops-adcs-campaign-${day}.json`), JSON.stringify(summary, null, 2));
  const md = [
    `# Sat-Ops ADCS evidence campaign — ${day}`,
    '',
    `**${RUNS} seeded randomized closed-loop scenarios** through the full ADCS stack (RK4 truth`,
    '+ CFS-noise sensors + 6-state MEKF + SAFE/DETUMBLE/SLEW/POINT/DESAT mode manager +',
    'quaternion-PD + magnetorquer desat). Every run: random tumble (0.5–3 °/s) → DETUMBLE,',
    'random slew (10–60°) → SLEW/POINT settle, 60 s fine hold scored on **TRUTH** attitude',
    '(the estimator does not grade its own homework), a 30 s star-tracker outage ride-through,',
    'and a near-saturation momentum fault → autonomous DESAT → pointing recovery.',
    'Deterministic per seed. SIM fleet — ADR-102 doctrine: commands cannot leave simulation.',
    '',
    `## Result: **${(passRate * 100).toFixed(1)}% pass** (${scores.filter((s) => s.pass).length}/${RUNS})`,
    '',
    '| metric | p50 | p95 | criterion |',
    '|---|---|---|---|',
    `| detumble time (s) | ${pct(detumble, 50).toFixed(1)} | ${pct(detumble, 95).toFixed(1)} | ≤ ${CRITERIA.detumbleMaxS} |`,
    `| slew settle (s) | ${pct(settle, 50).toFixed(1)} | ${pct(settle, 95).toFixed(1)} | ≤ ${CRITERIA.settleMaxS} |`,
    `| hold RMS, truth (°) | ${pct(rms, 50).toFixed(4)} | ${pct(rms, 95).toFixed(4)} | ≤ ${CRITERIA.holdRmsMaxDeg} |`,
    `| est−truth gap max (°) | ${pct(gap, 50).toFixed(4)} | ${pct(gap, 95).toFixed(4)} | ≤ ${CRITERIA.estGapMaxDeg} |`,
    `| 30 s ST-outage drift (°) | ${pct(drift, 50).toFixed(4)} | ${pct(drift, 95).toFixed(4)} | ≤ ${CRITERIA.outageDriftMaxDeg} |`,
    `| momentum-fault recovery (s) | ${pct(recovery, 50).toFixed(1)} | ${pct(recovery, 95).toFixed(1)} | ≤ ${CRITERIA.recoveryMaxS} |`,
    '',
    Object.keys(failCounts).length
      ? `Failures by criterion: ${Object.entries(failCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`
      : 'No criterion failures.',
    '',
    `Generated by \`scripts/evidence/prove-sat-ops-campaign.ts\` in ${summary.wallSeconds}s; raw per-run scores in the sibling JSON.`,
    '',
  ].join('\n');
  writeFileSync(path.join(outDir, `sat-ops-adcs-campaign-${day}.md`), md);
  console.log(`PASS RATE ${(passRate * 100).toFixed(1)}% — evidence written to docs/evidence/sat-ops-adcs-campaign-${day}.{json,md} (${summary.wallSeconds}s)`);
  process.exitCode = passRate >= 0.95 ? 0 : 1;
}

main().catch((err) => {
  console.error('campaign FAILED with error:', err);
  process.exitCode = 1;
});
