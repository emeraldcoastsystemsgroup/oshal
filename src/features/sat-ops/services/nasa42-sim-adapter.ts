/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | night 1 round 2: the NASA-42 adapter — TCP client for
 *                     |                             | 42's standalone-AC IPC behind the SatSimAdapter
 *                     |                             | contract. Learns the vehicle (MOI, wheel axes/limits,
 *                     |                             | gyro axes, FSW DT) from 42's table message; verifies
 *                     |                             | every layout length against 42's own BufLens before
 *                     |                             | trusting a single field.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Live-smoke findings folded in: (1) the ST
 *                     |                             | mount is composed out ANALYTICALLY (qbn = q_meas ⊗
 *                     |                             | q_mount*, from 42sensors.c's reversed-order QxQ) using
 *                     |                             | the table's ST.qb — replaces the empirical convention
 *                     |                             | detector; (2) the attitude is gyro-dead-reckoned every
 *                     |                             | cycle and SNAPPED to the star tracker only when valid —
 *                     |                             | on night 1 the stock exclusion logic invalidated the ST
 *                     |                             | and a held attitude froze the control error at 30° while
 *                     |                             | the real body wound up to 0.37°/s. Sensors may lie by
 *                     |                             | omission; the adapter must not.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Convention CALIBRATION from live data: the
 *                     |                             | QxQ order is derivable from 42's source but its
 *                     |                             | vector-rotation semantic leaves a conjugation ambiguity
 *                     |                             | — live run pumped 0.35→0.9 °/s chasing the mirrored
 *                     |                             | reference. Now: majority vote of prediction residuals
 *                     |                             | over 25 consecutive star-fix pairs locks direct vs
 *                     |                             | conjugate; attitudeCalibrated() gates pointing tasks.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | W2: the snap-to-ST becomes a 6-state MEKF,
 *                     |                             | STRICTLY gated behind convention lock (pre-lock path is
 *                     |                             | byte-identical to today, so a mirrored measurement can
 *                     |                             | never poison the bias state). Post-lock: propagate,
 *                     |                             | then update on a FRESH fix (raw-stQn bitwise dedupe for
 *                     |                             | 42's 0.25s ST vs 0.2s FSW). Reported ω becomes
 *                     |                             | bias-corrected; estimatorDiagnostics() feeds telemetry.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Pass current omegaRaw into ST updates so
 *                     |                             | the MEKF's stLagS underweighting can price the ~one
 *                     |                             | FSW-cycle gyro↔ST epoch skew seen live (rej=1149,
 *                     |                             | reinit=44 on the first W2 mission without it).
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | attitudeCalibrated() rides ST outages once
 *                     |                             | the MEKF is initialized — live mission 2: a routine
 *                     |                             | 20 s exclusion tripped ekf-unhealthy → SAFE mid-SLEW
 *                     |                             | and stranded the mission (SAFE is sticky by design).
 *                     |                             | Estimate trust during outage = covariance's job.
 */

import net from 'net';
import { createChildLogger } from '@/shared/logger';
import type { Quat, SatAttitudeState, Vec3 } from '../model/sat-types';
import { quatConjugate, quatFromAxisAngle, quatIdentity, quatMultiply, quatNormalize, vNorm } from './sat-math';
import { MekfAttitudeEstimator, NASA42_MEKF_CONFIG } from './mekf-attitude-estimator';
import type { EstimatorReadout } from './estimating-sim-adapter';
import type { SatSimAdapter } from './sim-adapter';
import {
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
  wheelDistribution,
  writeLayout,
  type AcArraySizes,
  type AcBufLens,
} from './nasa42-codec';

const logger = createChildLogger({ module: 'sat-ops:nasa42' });

/** Connection options for {@link Nasa42SimAdapter.connect}. */
export interface Nasa42ConnectOptions {
  host?: string;
  port?: number;
  id?: string;
  /** Max ms to wait for the TCP connect + each handshake message (default 15000). */
  connectTimeoutMs?: number;
  /** Max ms to wait for each In message during stepping (default 30000). */
  cycleTimeoutMs?: number;
}

/** What the adapter learned about the vehicle from 42's table message. */
export interface Nasa42Vehicle {
  /** FSW sample time — the fixed step this engine advances per cycle, seconds. */
  dtSeconds: number;
  massKg: number;
  /** Diagonal of the body MOI tensor (kg·m²) — feed this to the PD gain derivation. */
  moiDiag: Vec3;
  wheelAxes: Vec3[];
  wheelMaxTorqueNm: number[];
  wheelMaxMomentumNms: number[];
  gyroAxes: Vec3[];
  /** Star-tracker mount quaternion (42's ST.qb) — composed out of every measurement. */
  stMount: Quat;
  /** Magnetometer sensing axes (Tbl magAxis) — for body-field reconstruction. */
  magAxes: Vec3[];
  /** Magnetorquer rod axes (Tbl mtbAxis) — for dipole distribution. */
  mtbAxes: Vec3[];
  /** Per-rod dipole saturation (Tbl mtbMmax), A·m². */
  mtbMaxDipoleAm2: number[];
}

/** Accumulating exact-length reader over a socket. */
class SocketReader {
  private chunks: Buffer = Buffer.alloc(0);

  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;

  private failure: Error | null = null;

  constructor(socket: net.Socket) {
    socket.on('data', (d) => {
      this.chunks = Buffer.concat([this.chunks, d]);
      this.pump();
    });
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('42 closed the connection')));
  }

  private fail(err: Error): void {
    this.failure = err;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(err);
      this.waiter = null;
    }
  }

  private pump(): void {
    if (this.waiter && this.chunks.length >= this.waiter.n) {
      const { n, resolve, timer } = this.waiter;
      clearTimeout(timer);
      this.waiter = null;
      const out = this.chunks.subarray(0, n);
      this.chunks = this.chunks.subarray(n);
      resolve(Buffer.from(out));
    }
  }

  /**
   * @description Resolve with exactly `n` bytes or reject on timeout/socket failure.
   * @param n - Byte count. @param timeoutMs - Max wait.
   * @returns The bytes.
   */
  readExact(n: number, timeoutMs: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${n} bytes from 42 (have ${this.chunks.length})`));
      }, timeoutMs);
      this.waiter = { n, resolve, reject, timer };
      this.pump();
    });
  }
}

/**
 * @description `SatSimAdapter` over NASA 42's standalone-AC socket (ADR-102 §2). The state
 * it reports is the SENSED state — star-tracker attitude (mount composed out, gyro
 * dead-reckoned across ST exclusion outages), gyro-derived rates, tachometer wheel momenta —
 * because that is all 42 gives an external controller; truth stays on 42's side, which is
 * exactly the referee property the campaign wants. `reset` is rejected: restart the
 * container to reset the world.
 */
export class Nasa42SimAdapter implements SatSimAdapter {
  readonly id: string;

  /** The vehicle as learned from the table message (gains/limits derive from this). */
  readonly vehicle: Nasa42Vehicle;

  private readonly socket: net.Socket;

  private readonly reader: SocketReader;

  private readonly sizes: AcArraySizes;

  private readonly distribution: number[][];

  /** Minimum-norm MTB distribution (empty when < 3 rods — no dipole path). */
  private readonly mtbDistribution: number[][];

  private readonly cycleTimeoutMs: number;

  private state: SatAttitudeState;

  private q: Quat;

  private stWasValid = true;

  private lastIn: Record<string, number[]>;

  /** Convention calibration: majority vote over consecutive valid star-fix pairs. */
  private conventionVotes = { conjugate: 0, direct: 0 };

  private conventionLocked = false;

  private convention: 'conjugate' | 'direct' = 'conjugate';

  private prevQbn: Quat | null = null;

  private static readonly CONVENTION_VOTES_NEEDED = 25;

  /** The 6-state MEKF — engaged only AFTER convention lock (pre-lock a mirrored fix would poison bias). */
  private readonly mekf: MekfAttitudeEstimator;

  /** Last ingested raw stQn key — 42 latches its 0.25s ST across 0.2s FSW cycles; dedupe avoids overconfidence. */
  private lastStQnKey = '';

  private constructor(args: {
    id: string; socket: net.Socket; reader: SocketReader; sizes: AcArraySizes; vehicle: Nasa42Vehicle;
    cycleTimeoutMs: number; firstIn: Record<string, number[]>;
  }) {
    this.id = args.id;
    this.socket = args.socket;
    this.reader = args.reader;
    this.sizes = args.sizes;
    this.vehicle = args.vehicle;
    this.cycleTimeoutMs = args.cycleTimeoutMs;
    this.distribution = wheelDistribution(args.vehicle.wheelAxes);
    this.mtbDistribution = args.vehicle.mtbAxes.length >= 3 ? wheelDistribution(args.vehicle.mtbAxes) : [];
    this.lastIn = args.firstIn;
    this.mekf = new MekfAttitudeEstimator({ ...NASA42_MEKF_CONFIG, stMount: args.vehicle.stMount });
    const qbn = this.stQbnBase(args.firstIn);
    this.q = qbn ? quatConjugate(qbn) : quatIdentity();
    if (!qbn) logger.warn({ id: this.id }, 'ST invalid at connect — starting attitude from identity until first star fix');
    this.state = this.buildState(args.firstIn, 0);
  }

  /**
   * @description Connect to a running 42 container and complete the AcApp handshake:
   * sizes → buf-lens → LAYOUT VERIFICATION (computed lengths must equal 42's own, or we
   * refuse to run) → table → first In message.
   * @param opts - Host/port and timeouts.
   * @returns A ready adapter whose `getState` reflects the current sensed state.
   */
  static async connect(opts: Nasa42ConnectOptions = {}): Promise<Nasa42SimAdapter> {
    const host = opts.host ?? '127.0.0.1';
    const port = opts.port ?? 10001;
    const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
    const cycleTimeoutMs = opts.cycleTimeoutMs ?? 30_000;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host, port });
      const timer = setTimeout(() => { s.destroy(); reject(new Error(`connect to 42 at ${host}:${port} timed out`)); }, connectTimeoutMs);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
    const reader = new SocketReader(socket);

    const sizes = parseAcArraySizes(await reader.readExact(96, connectTimeoutMs));
    socket.write(ACK);
    const lens = parseAcBufLens(await reader.readExact(24, connectTimeoutMs));
    socket.write(ACK);
    Nasa42SimAdapter.verifyLayouts(sizes, lens);

    const tbl = readLayout(await reader.readExact(lens.tblLen, connectTimeoutMs), TBL_LAYOUT, sizes);
    socket.write(ACK);
    const vehicle = Nasa42SimAdapter.vehicleFromTable(tbl, sizes);
    logger.info({ host, port, sizes, lens, vehicle }, '42 handshake complete — layouts byte-verified');

    const firstIn = readLayout(await reader.readExact(lens.inLen, cycleTimeoutMs), IN_LAYOUT, sizes);
    socket.write(ACK);

    return new Nasa42SimAdapter({
      id: opts.id ?? `sat42-${port - 10001}`,
      socket, reader, sizes, vehicle, cycleTimeoutMs, firstIn,
    });
  }

  /** Computed layout lengths must equal 42's own BufLens — refuse to run otherwise. */
  private static verifyLayouts(sizes: AcArraySizes, lens: AcBufLens): void {
    const computed = {
      inLen: layoutLength(IN_LAYOUT, sizes),
      outLen: layoutLength(OUT_LAYOUT, sizes),
      tblLen: layoutLength(TBL_LAYOUT, sizes),
    };
    if (computed.inLen !== lens.inLen || computed.outLen !== lens.outLen || computed.tblLen !== lens.tblLen) {
      throw new Error(
        `42 IPC layout mismatch (codec transcribed from a different 42 build?): computed ${JSON.stringify(computed)} vs 42's ${JSON.stringify(lens)}`,
      );
    }
  }

  /** Extract the vehicle model from the parsed table message. */
  private static vehicleFromTable(tbl: Record<string, number[]>, sizes: AcArraySizes): Nasa42Vehicle {
    return {
      dtSeconds: tbl.dt[0],
      massKg: tbl.mass[0],
      moiDiag: { x: tbl.moi[0], y: tbl.moi[4], z: tbl.moi[8] },
      wheelAxes: groupVec3(tbl.whlAxis, sizes.nwhl),
      wheelMaxTorqueNm: tbl.whlTmax.slice(0, sizes.nwhl),
      wheelMaxMomentumNms: tbl.whlHmax.slice(0, sizes.nwhl),
      gyroAxes: groupVec3(tbl.gyroAxis, sizes.ngyro),
      stMount: sizes.nst > 0 ? quatNormalize(scalarLastToQuat(tbl.stQb.slice(0, 4))) : quatIdentity(),
      magAxes: groupVec3(tbl.magAxis, sizes.nmag),
      mtbAxes: groupVec3(tbl.mtbAxis, sizes.nmtb),
      mtbMaxDipoleAm2: tbl.mtbMmax.slice(0, sizes.nmtb),
    };
  }

  /** Out-message field values for one cycle: wheel torques, MTB dipoles + honest report fields. */
  private static outFields(
    sizes: AcArraySizes, lastIn: Record<string, number[]>, wheelTcmd: number[], mtbMcmd: number[], vehicle: Nasa42Vehicle,
  ): Record<string, number[]> {
    const hvb = clusterMomentum(vehicle.wheelAxes, lastIn.whlH ?? new Array(sizes.nwhl).fill(0));
    return {
      whlTcmd: wheelTcmd,
      // MTB dipole commands; absent → zeros, byte-identical to the pre-desat messages.
      mtbMcmd,
      hvb: [hvb.x, hvb.y, hvb.z],
      // Pass 42's own attitude/gimbal command parameters back unchanged — we command
      // wheels/torquers only; inventing these would fight the sim's command state.
      cmdQrl: lastIn.cmdQrl, cmdQrn: lastIn.cmdQrn,
      gCmdQrl: lastIn.gCmdQrl, gCmdQrn: lastIn.gCmdQrn,
    };
  }

  /**
   * @description Mount-composed body-attitude base from a VALID star-tracker reading, or
   * null during an exclusion outage. 42 builds the measurement as qsn = mount ∘ qbn
   * (reversed-order QxQ in 42sensors.c), i.e. Hamilton q_meas = qbn ⊗ q_mount, so
   * qbn = q_meas ⊗ q_mount*. Whether body→inertial is qbn or its conjugate depends on 42's
   * vector-rotation semantic — resolved by {@link calibrateConvention}, never assumed.
   */
  private stQbnBase(rec: Record<string, number[]>): Quat | null {
    if (this.sizes.nst < 1 || rec.stValid[0] === 0) return null;
    const qMeas = scalarLastToQuat(rec.stQn);
    return quatNormalize(quatMultiply(qMeas, quatConjugate(this.vehicle.stMount)));
  }

  /**
   * @description One calibration vote per consecutive valid-fix pair: the gyro says how the
   * attitude MUST have moved over the cycle; the candidate mapping (direct vs conjugate)
   * whose prediction residual is smaller gets the vote. Locks after enough votes. This is
   * deterministic instrument bring-up on live data — the night-1 run that pumped rates from
   * 0.35 to 0.9 °/s chasing a mirrored reference is the failure mode this prevents.
   */
  private calibrateConvention(qbn: Quat, omega: Vec3): void {
    if (this.prevQbn) {
      const winner = detectQuatConvention(this.prevQbn, qbn, omega, this.vehicle.dtSeconds);
      this.conventionVotes[winner]++;
      const { conjugate, direct } = this.conventionVotes;
      if (conjugate + direct >= Nasa42SimAdapter.CONVENTION_VOTES_NEEDED) {
        this.convention = conjugate >= direct ? 'conjugate' : 'direct';
        this.conventionLocked = true;
        logger.info({ id: this.id, votes: this.conventionVotes, convention: this.convention }, '42 quaternion convention LOCKED from live star fixes');
      }
    }
    this.prevQbn = qbn;
  }

  /**
   * @description Map one In record to the sensed state. Two regimes: PRE-LOCK (byte-identical
   * to the W1 dead-reckon + snap; the MEKF is never touched, so a possibly-mirrored fix can't
   * poison the bias state), and POST-LOCK (the MEKF propagates on the raw rate and folds in a
   * FRESH star fix — dedupe on the raw stQn key for 42's 0.25s ST vs 0.2s FSW aliasing —
   * reporting the filtered attitude and the bias-corrected rate).
   */
  private buildState(rec: Record<string, number[]>, t: number): SatAttitudeState {
    const omegaRaw = solveOmegaFromGyros(this.vehicle.gyroAxes, rec.gyroRate);
    const qbn = this.stQbnBase(rec);
    const wheelMomentum = clusterMomentum(this.vehicle.wheelAxes, rec.whlH);
    // Body field from the magnetometer scalars (attitude-independent — valid through ST outages).
    const bFieldBody = this.sizes.nmag >= 3 ? solveFieldFromMags(this.vehicle.magAxes, rec.magField) : undefined;

    if (!this.conventionLocked) {
      // ── legacy pre-lock path ─────────────────────────────────────────────
      if (t > 0) {
        const angle = vNorm(omegaRaw) * this.vehicle.dtSeconds;
        if (angle > 0) this.q = quatNormalize(quatMultiply(this.q, quatFromAxisAngle(omegaRaw, angle)));
      }
      if (qbn) {
        this.calibrateConvention(qbn, omegaRaw);
        this.q = this.convention === 'conjugate' ? quatConjugate(qbn) : qbn;
        if (this.conventionLocked) {
          // seed the filter from this first locked-mapped fix (reinit branch: q̂=this.q, b̂=0)
          this.mekf.updateStarTracker(this.q, omegaRaw);
          this.lastStQnKey = rec.stQn.join(',');
        }
        if (!this.stWasValid) logger.info({ id: this.id, t }, 'star tracker reacquired — snapping attitude');
        this.stWasValid = true;
      } else {
        this.prevQbn = null; // votes need CONSECUTIVE fixes; a gap breaks the pair
        if (this.stWasValid) {
          logger.info({ id: this.id, t }, 'star tracker outage (exclusion) — gyro dead-reckoning');
          this.stWasValid = false;
        }
      }
      return { t, q: { ...this.q }, omega: omegaRaw, wheelMomentum, ...(bFieldBody ? { bFieldBody } : {}) };
    }

    // ── post-lock MEKF path ────────────────────────────────────────────────
    this.mekf.propagate(omegaRaw, this.vehicle.dtSeconds);
    if (qbn) {
      const qMap = this.convention === 'conjugate' ? quatConjugate(qbn) : qbn;
      const key = rec.stQn.join(',');
      if (key !== this.lastStQnKey) {
        this.mekf.updateStarTracker(qMap, omegaRaw);
        this.lastStQnKey = key;
      }
      if (!this.stWasValid) logger.info({ id: this.id, t }, 'star tracker reacquired — MEKF resumes updates');
      this.stWasValid = true;
    } else if (this.stWasValid) {
      logger.info({ id: this.id, t }, 'star tracker outage (exclusion) — MEKF propagate-only');
      this.stWasValid = false;
    }
    this.q = this.mekf.attitude();
    return { t, q: this.mekf.attitude(), omega: this.mekf.rateEstimate(omegaRaw), wheelMomentum, ...(bFieldBody ? { bFieldBody } : {}) };
  }

  /**
   * @description The MEKF readout for node telemetry, or null before convention lock (the
   * filter is not engaged pre-lock).
   * @returns The estimator readout, or null.
   */
  estimatorDiagnostics(): EstimatorReadout | null {
    if (!this.conventionLocked || !this.mekf.initialized()) return null;
    const d = this.mekf.diagnostics();
    return {
      initialized: d.initialized,
      updatesApplied: d.updatesApplied,
      rejected: d.rejected,
      reinits: d.reinits,
      lastResidualRad: d.lastResidualRad,
      biasRadS: this.mekf.biasRadS(),
      attitudeSigmaRad: this.mekf.attitudeSigmaRad(),
    };
  }

  /**
   * @description trace(Pθθ) of the MEKF (rad²), or a large sentinel when the filter is not yet
   * engaged — the uncertainty-based health metric the W2 mode manager gates on.
   * @returns Attitude covariance trace, or Infinity pre-lock.
   */
  attitudeCovTrace(): number {
    return this.conventionLocked && this.mekf.initialized() ? this.mekf.traceAttitudeCov() : Infinity;
  }

  /**
   * @description Raw per-wheel stored momenta (N·m·s) from the last In message — 42 saturates
   * PER WHEEL, so the mode manager's momentum fraction uses max_k |H_k|/Hmax_k, not the cluster
   * norm (which under-reports pyramid saturation).
   * @returns One momentum per wheel.
   */
  wheelMomentaRaw(): number[] {
    return (this.lastIn.whlH ?? new Array(this.sizes.nwhl).fill(0)).slice(0, this.sizes.nwhl);
  }

  /** @returns Per-wheel momentum saturation limits (N·m·s). */
  wheelMaxMomenta(): number[] {
    return this.vehicle.wheelMaxMomentumNms;
  }

  /**
   * @description Whether the LAST cycle carried a valid star-tracker fix. While false, the
   * reported attitude is gyro dead-reckoning from the last fix (or from identity if no fix
   * has ever arrived) — self-consistent for control, but in an arbitrary frame until the
   * first star snap. Callers sequencing a pointing task should wait for this to go true
   * (attitude acquisition), exactly like a real mission does.
   * @returns True when the attitude is star-anchored.
   */
  starTrackerValid(): boolean {
    return this.stWasValid;
  }

  /**
   * @description True once the quaternion convention has been locked from live data
   * ({@link calibrateConvention}) AND the attitude is trustworthy: either the star tracker
   * is delivering fixes right now, or the MEKF has been initialized — after which an ST
   * exclusion outage does NOT de-calibrate the estimate (the filter dead-reckons and its
   * covariance grows honestly; judging whether it has grown too large is the health gate's
   * job, not this flag's). Live 2026-07-18: the W1 semantics (ST-valid required) dropped a
   * mission to SAFE at the first routine 20 s occlusion and stranded it there.
   * @returns Whether the attitude is fully calibrated.
   */
  attitudeCalibrated(): boolean {
    return (this.stWasValid || this.mekf.initialized()) && this.conventionLocked;
  }

  /**
   * @description Engine + fidelity summary.
   * @returns The description sentence.
   */
  describe(): string {
    return `NASA 42 referee (standalone-AC IPC, ${this.sizes.nwhl}-wheel cluster, sensed-state reporting, FSW dt ${this.vehicle.dtSeconds}s)`;
  }

  /**
   * @description Rejected by design: 42's world resets by restarting its container, and
   * pretending otherwise would silently desynchronize scoring runs.
   * @returns Never — always rejects.
   */
  async reset(): Promise<SatAttitudeState> {
    throw new Error('Nasa42SimAdapter cannot reset in place — restart the oshal-sat42 container for a fresh world');
  }

  /**
   * @description Current sensed state (see class JSDoc for what "sensed" means here).
   * @returns A defensive copy.
   */
  async getState(): Promise<SatAttitudeState> {
    const s = this.state;
    const out: SatAttitudeState = { t: s.t, q: { ...s.q }, omega: { ...s.omega }, wheelMomentum: { ...s.wheelMomentum } };
    if (s.bFieldBody) out.bFieldBody = { ...s.bFieldBody };
    return out;
  }

  /**
   * @description Advance one FSW cycle: distribute the body-frame wheel torque across the
   * pyramid and the body dipole across the rods (both minimum-norm, both clamped to 42's own
   * saturation), send the Out message, and block until 42 integrates to the next cycle and
   * reports the new sensed state.
   * @param _dtSeconds - Advisory; 42 advances by its FSW sample time regardless (contract).
   * @param wheelTorqueCmd - Desired wheel-cluster torque in the body frame, N·m.
   * @param mtbDipoleCmd - Optional desat dipole in the body frame, A·m² (ignored when < 3 rods).
   * @returns The sensed state after the cycle.
   */
  async step(_dtSeconds: number, wheelTorqueCmd: Vec3, mtbDipoleCmd?: Vec3): Promise<SatAttitudeState> {
    const per = this.distribution.map((row, k) => {
      const raw = row[0] * wheelTorqueCmd.x + row[1] * wheelTorqueCmd.y + row[2] * wheelTorqueCmd.z;
      const tmax = this.vehicle.wheelMaxTorqueNm[k];
      return Math.max(-tmax, Math.min(tmax, raw));
    });
    const mtbMcmd = this.mtbDistribution.length && mtbDipoleCmd
      ? this.mtbDistribution.map((row, k) => {
          const raw = row[0] * mtbDipoleCmd.x + row[1] * mtbDipoleCmd.y + row[2] * mtbDipoleCmd.z;
          const mmax = this.vehicle.mtbMaxDipoleAm2[k];
          return Math.max(-mmax, Math.min(mmax, raw));
        })
      : new Array(this.sizes.nmtb).fill(0);
    this.socket.write(writeLayout(OUT_LAYOUT, this.sizes, Nasa42SimAdapter.outFields(this.sizes, this.lastIn, per, mtbMcmd, this.vehicle)));
    await this.reader.readExact(ACK.length, this.cycleTimeoutMs);
    const rec = readLayout(await this.reader.readExact(layoutLength(IN_LAYOUT, this.sizes), this.cycleTimeoutMs), IN_LAYOUT, this.sizes);
    this.socket.write(ACK);
    this.lastIn = rec;
    this.state = this.buildState(rec, this.state.t + this.vehicle.dtSeconds);
    return this.getState();
  }

  /**
   * @description Close the socket. 42 will exit its read loop; the container stops.
   */
  close(): void {
    this.socket.destroy();
    logger.info({ id: this.id }, '42 adapter closed');
  }
}
