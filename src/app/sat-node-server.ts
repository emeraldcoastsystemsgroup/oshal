/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | W2: the ad-hoc mode string + torqueFor()
 *                     |                             | switch is replaced by the AdcsModeManager (SAFE/DETUMBLE/
 *                     |                             | SLEW/POINT/DESAT). The loop ticks the manager, maps its
 *                     |                             | control law to wheel torque, and its DESAT/dumping to a
 *                     |                             | magnetorquer dipole via MtbDesatController. setMode maps
 *                     |                             | legacy idle→SAFE / rateDamp→DETUMBLE (+ new names). RK4
 *                     |                             | gains an optional magnetic environment so DESAT has
 *                     |                             | physics; ekfHealthy is uncertainty-based (P-trace).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the sat-node runtime
 *                     |                             | (ADR-102 §1): the device-node process that turns one
 *                     |                             | simulated satellite into a swarm node, drone-node style.
 *                     |                             | Embeds a SatSimAdapter (RK4 in-process, or the NASA-42
 *                     |                             | container via SAT_ENGINE=nasa42), runs the ADCS loop
 *                     |                             | LOCALLY (idle / rateDamp / point via quaternion-PD),
 *                     |                             | pushes authenticated heartbeats, executes secret-guarded
 *                     |                             | command envelopes. A device node: no LLM, no vendor keys.
 *                     |                             | Every engine is a simulator — commands cannot leave sim.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review fixes: (1) a dead
 *                     |                             | control loop no longer leaves a ZOMBIE node — loop death
 *                     |                             | stops heartbeats (fleet marks it offline via staleness),
 *                     |                             | /health goes 503, and commands are refused instead of
 *                     |                             | ACKed into a manager that will never tick again;
 *                     |                             | (2) startSatNode decomposed under the 50-line cap
 *                     |                             | (EngineRig + law mappers + telemetry/command/app/beat
 *                     |                             | factories); (3) dead W1 imports removed.
 *
 * Run one per satellite:
 *   SWARM_SERVICE_SECRET=<secret> SAT_NODE_ID=sat-1 OSHAL_API_URL=http://localhost:35457 \
 *     npm run sat:node
 * For the NASA-42 engine, start the referee first (docker run -p 10001:10001 oshal-sat42)
 * and set SAT_ENGINE=nasa42 [SAT42_HOST/SAT42_PORT]. Set SAT_NODE_ENDPOINT to an address
 * the CONTROLLER can dial back (same rules as drone nodes — use a literal IP on Windows).
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'http';
import * as os from 'os';
import { createChildLogger } from '@/shared/logger';
import { installProcessCrashGuards } from '@/shared/services/process-crash-guards';
import { serviceSecretHeaders } from '@/shared/middleware/authz';
import {
  AdcsModeManager,
  CFS_SAT_DESAT_KDESAT,
  CFS_SAT_SENSOR_NOISE,
  DEFAULT_DESAT_CONFIG_RK4,
  DEFAULT_MTB_CONFIG,
  DEFAULT_SAT_CONFIG,
  EstimatingSimAdapter,
  MEMS_TEST_SENSOR_NOISE,
  MekfAttitudeEstimator,
  ModeCommandError,
  MtbDesatController,
  Nasa42SimAdapter,
  QuaternionPdController,
  Rk4PropagatorSim,
  SatSensorSim,
  degPerHrToRadPerS,
  degPerRtHrToRadPerRtS,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  type ControlLawCommand,
  type Quat,
  type Rk4SimEnvironment,
  type SatAttitudeState,
  type SatSimAdapter,
  type SensorNoiseConfig,
  type Vec3,
} from '@/features/sat-ops';
import type { EstimatorReadout, SatControlMode, SatEngineKind, SatNodeTelemetry } from '@/features/sat-ops';

const logger = createChildLogger({ module: 'sat-node' });

const HEARTBEAT_INTERVAL_MS = 2_000;
const RATE_DAMP_TC_S = 50;

/** Node configuration, environment-derived in {@link loadConfig} or injected by tests. */
export interface SatNodeConfig {
  satId: string;
  port: number;
  endpointUrl: string;
  apiUrl: string;
  engine: SatEngineKind;
  nasa42Host: string;
  nasa42Port: number;
  /** RK4 pacing: simulated-seconds per wall-second (1 = real time). Sim affordance only. */
  timeScale: number;
  /** Control-loop step for the RK4 engine, seconds (nasa42 uses its own FSW dt). */
  dtSeconds: number;
  /**
   * RK4 sensor fidelity: 'truth' reports exact state (W1 behavior — the default so existing
   * specs are unaffected), 'cfs'/'mems' wrap the truth sim in synthetic sensors + the MEKF so
   * the RK4 path is structurally identical to the 42 sensed-state path. Ignored for nasa42.
   */
  sensorModel?: 'truth' | 'cfs' | 'mems';
  /** Deterministic sensor seed (RK4 estimating path). Derived from satId when omitted. */
  sensorSeed?: number;
  /** RK4 magnetic environment (rotating field + magnetorquers) so DESAT has physics. Off = W1 dynamics. */
  magEnv?: boolean;
  /** Optional initial wheel-momentum load (N·m·s) for RK4 desat demos. */
  initialWheelMomentum?: Vec3;
}

/** Deterministic 32-bit string hash for a stable per-node sensor seed. */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Build the RK4 engine, optionally wrapped in synthetic sensors + the MEKF per `sensorModel`. */
function buildRk4Engine(cfg: SatNodeConfig): { engine: SatSimAdapter; calibrated: () => boolean; estimator: () => EstimatorReadout | null } {
  const environment: Rk4SimEnvironment | undefined = cfg.magEnv ? { mag: {}, mtb: DEFAULT_MTB_CONFIG } : undefined;
  const inner = new Rk4PropagatorSim(cfg.satId, DEFAULT_SAT_CONFIG, environment);
  const model = cfg.sensorModel ?? 'truth';
  if (model === 'truth') {
    return { engine: inner, calibrated: () => true, estimator: () => null };
  }
  const noise: SensorNoiseConfig = model === 'mems' ? MEMS_TEST_SENSOR_NOISE : CFS_SAT_SENSOR_NOISE;
  const seed = cfg.sensorSeed ?? hashSeed(cfg.satId);
  const sensors = new SatSensorSim({ ...noise, seed });
  const mekf = new MekfAttitudeEstimator({
    sigmaVRadRtS: degPerRtHrToRadPerRtS(model === 'mems' ? 0.15 : 0.007),
    sigmaURadS15: degPerHrToRadPerS(model === 'mems' ? 2 : 0.01) / 60,
    sigmaTh0Rad: 1.0e-2,
    sigmaB0RadS: model === 'mems' ? degPerHrToRadPerS(20) : 1.5e-7,
    rStDiagRad2: noise.stNoiseDiagRad2,
    stMount: { w: 1, x: 0, y: 0, z: 0 },
    // Price the propagate↔sample discretization at rate (first-order gyro integration vs the
    // truth sampler): without it, fast slews read as 2-arcsec-R outliers and thrash the gate
    // (seen on the W3 surface verify: 44 rej / 6 reinits accumulated during one 30° slew).
    // 3 steps of horizon: the PD's angular-acceleration transient adds ω̇-order error the
    // rate-proportional term must still cover at mid-slew.
    stLagS: 3 * cfg.dtSeconds,
  });
  const wrapped = new EstimatingSimAdapter(inner, sensors, mekf);
  return { engine: wrapped, calibrated: () => wrapped.attitudeCalibrated(), estimator: () => wrapped.estimator() };
}

function loadConfig(): SatNodeConfig {
  const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
  if (!secret) {
    // Fail closed: an unauthenticated sat node would accept attitude commands from anyone
    // who can reach its port. No secret, no node.
    logger.error('SWARM_SERVICE_SECRET is required — refusing to start an unauthenticated sat node');
    process.exit(1);
  }
  const engine = (process.env.SAT_ENGINE || 'rk4').trim();
  if (engine !== 'rk4' && engine !== 'nasa42') {
    logger.error({ engine }, 'SAT_ENGINE must be "rk4" or "nasa42"');
    process.exit(1);
  }
  const port = Number(process.env.SAT_NODE_PORT) || 4200;
  return {
    satId: (process.env.SAT_NODE_ID || 'sat-1').trim(),
    port,
    endpointUrl: (process.env.SAT_NODE_ENDPOINT || `http://${os.hostname()}:${port}`).replace(/\/+$/, ''),
    apiUrl: (process.env.OSHAL_API_URL || 'http://localhost:35457').replace(/\/+$/, ''),
    engine: engine as SatEngineKind,
    nasa42Host: (process.env.SAT42_HOST || '127.0.0.1').trim(),
    nasa42Port: Number(process.env.SAT42_PORT) || 10001,
    timeScale: Math.max(0.1, Number(process.env.SAT_TIME_SCALE) || 1),
    dtSeconds: 0.1,
    // W2: default 'truth' preserves exact W1 behavior; 'cfs'/'mems' engage synthetic sensors + MEKF.
    sensorModel: ((): 'truth' | 'cfs' | 'mems' => {
      const m = (process.env.SAT_SENSOR_MODEL || 'truth').trim();
      return m === 'cfs' || m === 'mems' ? m : 'truth';
    })(),
    // W4 live nodes: RK4 magnetic environment (rotating field + MTB rods) so DESAT has
    // physics on env-launched nodes too, not only programmatic test rigs.
    magEnv: (process.env.SAT_MAG_ENV || '').trim() === 'true',
  };
}

/** Reject any request not presenting the swarm service secret. */
function requireSecret(req: Request, res: Response, next: NextFunction): void {
  const provided = String(req.headers['x-service-secret'] || '').trim();
  if (provided && provided === (process.env.SWARM_SERVICE_SECRET || '').trim()) { next(); return; }
  res.status(401).json({ error: 'valid X-Service-Secret required' });
}

/** Command rejection (bad args, uncalibrated attitude) — maps to 409 at the endpoint. */
class SatNodeCommandError extends Error {}

/** A running sat node, returned by {@link startSatNode} so tests can stop it cleanly. */
export interface RunningSatNode {
  telemetry(): SatNodeTelemetry;
  stop(): Promise<void>;
}

/** Engine plus the engine-specific closures the (engine-blind) mode manager needs. */
interface EngineRig {
  engine: SatSimAdapter;
  inertia: Vec3;
  calibrated: () => boolean;
  estimator: () => EstimatorReadout | null;
  /** Wheel momentum as a saturation fraction (per-WHEEL for 42, per-axis for RK4). */
  momentumFrac: (state: SatAttitudeState) => number;
  ekfHealthy: () => boolean;
  desatController: MtbDesatController;
}

/**
 * @description Construct the engine and its health/momentum closures for the configured
 * backend — the NASA-42 referee over its AC socket, or the in-process RK4 sim (optionally
 * sensor-wrapped). All engine-specific knowledge lives here; the control loop is engine-blind.
 * @param cfg - Node configuration.
 * @returns The rig the control loop runs against.
 */
async function buildEngineRig(cfg: SatNodeConfig): Promise<EngineRig> {
  if (cfg.engine === 'nasa42') {
    const sat42 = await Nasa42SimAdapter.connect({ host: cfg.nasa42Host, port: cfg.nasa42Port, id: cfg.satId });
    logger.info({ vehicle: sat42.vehicle }, 'sat node flying the NASA-42 referee');
    return {
      engine: sat42,
      inertia: sat42.vehicle.moiDiag,
      calibrated: (): boolean => sat42.attitudeCalibrated(),
      estimator: (): EstimatorReadout | null => sat42.estimatorDiagnostics(),
      // 42 saturates PER WHEEL — the fraction is max_k |H_k|/Hmax_k, not the cluster norm.
      momentumFrac: (): number => {
        const h = sat42.wheelMomentaRaw();
        const max = sat42.wheelMaxMomenta();
        return h.reduce((acc, hk, k) => Math.max(acc, Math.abs(hk) / (max[k] || 1)), 0);
      },
      // Uncertainty-based health: calibrated AND the MEKF's attitude 1σ under ~1.15° (0.02 rad).
      ekfHealthy: (): boolean => sat42.attitudeCalibrated() && Math.sqrt(sat42.attitudeCovTrace()) < 0.02,
      desatController: new MtbDesatController({ kDesat: CFS_SAT_DESAT_KDESAT, mtbAxes: sat42.vehicle.mtbAxes, maxDipoleAm2: sat42.vehicle.mtbMaxDipoleAm2 }),
    };
  }
  const built = buildRk4Engine(cfg);
  await built.engine.reset({ omega: { x: 0.02, y: -0.03, z: 0.015 }, ...(cfg.initialWheelMomentum ? { wheelMomentum: cfg.initialWheelMomentum } : {}) });
  const hMax = DEFAULT_SAT_CONFIG.wheels.maxMomentumNms;
  return {
    engine: built.engine,
    inertia: DEFAULT_SAT_CONFIG.inertia,
    calibrated: built.calibrated,
    estimator: built.estimator,
    momentumFrac: (state: SatAttitudeState): number =>
      Math.max(Math.abs(state.wheelMomentum.x), Math.abs(state.wheelMomentum.y), Math.abs(state.wheelMomentum.z)) / hMax,
    ekfHealthy: (): boolean => {
      const est = built.estimator();
      if (est === null) return built.calibrated(); // truth model → true
      return Math.sqrt(est.attitudeSigmaRad.x ** 2 + est.attitudeSigmaRad.y ** 2 + est.attitudeSigmaRad.z ** 2) < 0.02;
    },
    desatController: new MtbDesatController(DEFAULT_DESAT_CONFIG_RK4),
  };
}

/** The mode-manager tick output the actuator mappers consume. */
type ModeTick = ReturnType<AdcsModeManager['tick']>;

/**
 * @description Build the actuator mappers: manager control law → wheel torque, and
 * DESAT/dumping → magnetorquer dipole.
 * @param rig - Engine rig (inertia + desat controller).
 * @param controller - Quaternion-PD pointing controller.
 * @param getState - Live state accessor.
 * @returns The two mapping functions the control loop applies each tick.
 */
function makeLawMappers(rig: EngineRig, controller: QuaternionPdController, getState: () => SatAttitudeState): {
  wheelTorqueFor: (law: ControlLawCommand) => Vec3;
  dipoleFor: (out: ModeTick) => Vec3 | undefined;
} {
  const wheelTorqueFor = (law: ControlLawCommand): Vec3 => {
    const state = getState();
    switch (law.kind) {
      case 'quatPd': return controller.computeWheelTorque(state, law.target);
      case 'rateDamp':
      case 'desat': // DESAT holds the body quiescent with rateDamp while the rods bleed momentum
        return {
          x: (rig.inertia.x / RATE_DAMP_TC_S) * state.omega.x,
          y: (rig.inertia.y / RATE_DAMP_TC_S) * state.omega.y,
          z: (rig.inertia.z / RATE_DAMP_TC_S) * state.omega.z,
        };
      default: return { x: 0, y: 0, z: 0 };
    }
  };
  const dipoleFor = (out: ModeTick): Vec3 | undefined => {
    const state = getState();
    const wantsDump = out.law.kind === 'desat' || out.dumping;
    if (!wantsDump || !state.bFieldBody) return undefined;
    return rig.desatController.computeDipole(state.wheelMomentum, state.bFieldBody).bodyDipoleAm2;
  };
  return { wheelTorqueFor, dipoleFor };
}

/**
 * @description Build the telemetry snapshot function heartbeats and command replies share.
 * @param rig - Engine rig (estimator + calibration accessors).
 * @param getState - Live state accessor.
 * @param getLastTick - Last mode-manager tick accessor.
 * @returns Telemetry builder.
 */
function makeTelemetry(rig: EngineRig, getState: () => SatAttitudeState, getLastTick: () => ModeTick): () => SatNodeTelemetry {
  const RAD_TO_DEG_HR = 180 / Math.PI * 3600;
  const RAD_TO_DEG = 180 / Math.PI;
  return (): SatNodeTelemetry => {
    const est = rig.estimator();
    const tm = getLastTick().telemetry;
    return {
      state: getState(),
      mode: tm.mode as SatControlMode,
      pointingErrorDeg: tm.pointingErrorDeg,
      attitudeCalibrated: rig.calibrated(),
      adcs: {
        reason: tm.reason,
        timeInModeS: tm.timeInModeS,
        transitionCount: tm.transitionCount,
        momentumFrac: tm.momentumFrac,
        dumping: tm.dumping,
        hasTarget: tm.hasTarget,
      },
      ...(est
        ? {
            estimator: {
              initialized: est.initialized,
              updatesApplied: est.updatesApplied,
              rejected: est.rejected,
              reinits: est.reinits,
              biasDegHr: { x: est.biasRadS.x * RAD_TO_DEG_HR, y: est.biasRadS.y * RAD_TO_DEG_HR, z: est.biasRadS.z * RAD_TO_DEG_HR },
              attitudeSigmaDeg: { x: est.attitudeSigmaRad.x * RAD_TO_DEG, y: est.attitudeSigmaRad.y * RAD_TO_DEG, z: est.attitudeSigmaRad.z * RAD_TO_DEG },
            },
          }
        : {}),
    };
  };
}

/**
 * @description Build the operator-command dispatcher (point / setMode with legacy names).
 * @param manager - The ADCS mode manager commands are staged into.
 * @param getState - Live state accessor (relative point targets compose off the current q).
 * @returns Command executor; throws {@link SatNodeCommandError} on rejection (→ 409).
 */
function makeRunCommand(manager: AdcsModeManager, getState: () => SatAttitudeState): (command: string, args: Record<string, unknown>) => void {
  return (command: string, args: Record<string, unknown>): void => {
    switch (command) {
      case 'point': {
        try {
          manager.commandPoint(resolveTarget(args, getState().q));
        } catch (err) {
          if (err instanceof ModeCommandError) throw new SatNodeCommandError(err.message);
          throw err;
        }
        return;
      }
      case 'setMode': {
        // Backward-compatible: legacy idle→SAFE, rateDamp→DETUMBLE; new names accepted too.
        const m = String(args.mode || '').toLowerCase();
        if (m === 'idle' || m === 'safe') manager.commandSafe();
        else if (m === 'ratedamp' || m === 'detumble') manager.commandDetumble();
        else if (m === 'desat') manager.commandDesat();
        else throw new SatNodeCommandError(`unknown mode "${m}"`);
        return;
      }
      case 'status': return;
      default: throw new SatNodeCommandError(`unknown command "${command}"`);
    }
  };
}

/**
 * @description Build the node's HTTP surface. A dead control loop (crashed, not stopping)
 * flips /health to 503 and refuses commands — a command ACKed into a manager that will never
 * tick again is a lie to the operator.
 * @param cfg - Node configuration (identity fields for /health).
 * @param runCommand - Command dispatcher.
 * @param telemetry - Telemetry builder.
 * @param modeFn - Current-mode accessor for the command log line.
 * @param isDead - True once the control loop has crashed.
 * @returns The express app, not yet listening.
 */
function buildNodeApp(cfg: SatNodeConfig, runCommand: (c: string, a: Record<string, unknown>) => void, telemetry: () => SatNodeTelemetry, modeFn: () => string, isDead: () => boolean): express.Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req: Request, res: Response) => {
    res.status(isDead() ? 503 : 200).json({ ok: !isDead(), satId: cfg.satId, engine: cfg.engine });
  });
  app.post('/api/sat-node/command', requireSecret, (req: Request, res: Response) => {
    if (isDead()) { res.status(503).json({ error: 'control loop dead — node requires restart' }); return; }
    const command = String(req.body?.command || '');
    try {
      runCommand(command, (req.body?.args || {}) as Record<string, unknown>);
      logger.info({ command, mode: modeFn() }, 'sat command executed');
      res.json({ ok: true, telemetry: telemetry() });
    } catch (err) {
      if (err instanceof SatNodeCommandError) { res.status(409).json({ error: err.message }); return; }
      logger.error({ err, command, stack: (err as Error).stack }, 'sat command failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });
  return app;
}

/**
 * @description Start the heartbeat interval. A dead control loop stops the beats entirely so
 * the fleet's staleness window marks the node offline — frozen telemetry must not keep a
 * zombie looking alive.
 * @param cfg - Node configuration (controller URL + identity).
 * @param telemetry - Telemetry builder.
 * @param isDead - True once the control loop has crashed.
 * @returns The interval handle (cleared by stop()).
 */
function startHeartbeat(cfg: SatNodeConfig, telemetry: () => SatNodeTelemetry, isDead: () => boolean): NodeJS.Timeout {
  const sendHeartbeat = async (): Promise<void> => {
    if (isDead()) return; // zombie guard — silence lets the fleet mark us offline
    try {
      const res = await fetch(`${cfg.apiUrl}/api/sat/nodes/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
        body: JSON.stringify({ satId: cfg.satId, endpointUrl: cfg.endpointUrl, engine: cfg.engine, telemetry: telemetry() }),
      });
      if (!res.ok) logger.warn({ status: res.status }, 'Heartbeat rejected by controller');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Heartbeat failed (controller unreachable) — retrying next tick');
    }
  };
  const beat = setInterval(() => { void sendHeartbeat(); }, HEARTBEAT_INTERVAL_MS);
  void sendHeartbeat();
  return beat;
}

/**
 * @description Start one sat node: engine, local ADCS loop, command endpoint, heartbeats.
 * Exported for the in-process end-to-end spec; `main()` is the CLI entry.
 * @param cfg - Node configuration.
 * @returns Handle with `telemetry()` and `stop()`.
 */
export async function startSatNode(cfg: SatNodeConfig): Promise<RunningSatNode> {
  const rig = await buildEngineRig(cfg);
  const controller = new QuaternionPdController({ inertia: rig.inertia });
  const manager = new AdcsModeManager();
  let state = await rig.engine.getState();
  let lastTick = manager.tick({ state, ekfHealthy: rig.ekfHealthy(), wheelMomentumFrac: 0 });
  let running = true;
  let dead = false; // crashed (≠ stopping): the HTTP surface + heartbeats must stop claiming liveness

  const { wheelTorqueFor, dipoleFor } = makeLawMappers(rig, controller, () => state);
  const controlTick = async (dt: number): Promise<void> => {
    lastTick = manager.tick({ state, ekfHealthy: rig.ekfHealthy(), wheelMomentumFrac: rig.momentumFrac(state) });
    state = await rig.engine.step(dt, wheelTorqueFor(lastTick.law), dipoleFor(lastTick));
  };

  const dt = cfg.engine === 'nasa42' ? 0.2 : cfg.dtSeconds;
  // RK4 pacing batches steps per wall tick: timer resolution is ~15ms on some platforms,
  // so sleeping per-step silently under-delivers high time scales. nasa42 needs no pacing —
  // its socket lockstep is the clock.
  const TICK_MS = 20;
  const stepsPerTick = Math.max(1, Math.round((cfg.timeScale * TICK_MS) / 1000 / dt));
  const loop = (async (): Promise<void> => {
    while (running) {
      if (cfg.engine === 'rk4') {
        for (let i = 0; i < stepsPerTick && running; i++) await controlTick(dt);
        await new Promise((r) => setTimeout(r, TICK_MS));
      } else {
        await controlTick(dt);
      }
    }
  })().catch((err) => {
    logger.error({ err, stack: (err as Error).stack }, 'sat node control loop died — node is now dead (503, no heartbeats)');
    running = false;
    dead = true;
  });

  const telemetry = makeTelemetry(rig, () => state, () => lastTick);
  const runCommand = makeRunCommand(manager, () => state);
  const app = buildNodeApp(cfg, runCommand, telemetry, () => manager.mode(), () => dead);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(cfg.port, () => resolve(s));
  });
  logger.info({ satId: cfg.satId, port: cfg.port, endpointUrl: cfg.endpointUrl, apiUrl: cfg.apiUrl, engine: cfg.engine }, 'Sat node up — heartbeating into the swarm');
  const beat = startHeartbeat(cfg, telemetry, () => dead);

  return {
    telemetry,
    stop: async (): Promise<void> => {
      running = false;
      clearInterval(beat);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (rig.engine instanceof Nasa42SimAdapter) rig.engine.close();
      await loop;
    },
  };
}

/** Resolve a point-command target: absolute {q} or relative {axis, angleDeg} slew. */
function resolveTarget(args: Record<string, unknown>, current: Quat): Quat {
  const q = args.q as Partial<Quat> | undefined;
  if (q && [q.w, q.x, q.y, q.z].every((v) => typeof v === 'number')) {
    return quatNormalize({ w: q.w as number, x: q.x as number, y: q.y as number, z: q.z as number });
  }
  const axis = args.axis as Partial<Vec3> | undefined;
  const angleDeg = Number(args.angleDeg);
  if (axis && Number.isFinite(angleDeg) && [axis.x, axis.y, axis.z].some((v) => typeof v === 'number' && v !== 0)) {
    const a: Vec3 = { x: Number(axis.x) || 0, y: Number(axis.y) || 0, z: Number(axis.z) || 0 };
    return quatMultiply(current, quatFromAxisAngle(a, (angleDeg * Math.PI) / 180));
  }
  throw new SatNodeCommandError('point requires {q} or {axis, angleDeg}');
}

async function main(): Promise<void> {
  installProcessCrashGuards('sat-node');
  const cfg = loadConfig();
  await startSatNode(cfg);
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'Sat node failed to start');
    process.exit(1);
  });
}
