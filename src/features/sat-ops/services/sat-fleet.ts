/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — Sat-Ops (ADR-102) W1
 *                     |                             | round 3: the sat fleet plane, mirroring DroneFleet
 *                     |                             | (ADR-099). Sat nodes register by authenticated heartbeat
 *                     |                             | only (no embedded local sat on the api — the node process
 *                     |                             | owns engines); staleness is liveness; commands dial the
 *                     |                             | node's secret-guarded endpoint and never run against a
 *                     |                             | dead link. Commands-never-leave-sim stays structural:
 *                     |                             | every engine a node can embed is a simulator.
 */

import { serviceSecretHeaders } from '@/shared/middleware/authz';
import { createChildLogger } from '@/shared/logger';
import type { SatAttitudeState, Vec3 } from '../model/sat-types';

const logger = createChildLogger({ module: 'sat-ops:fleet' });

/** A node is offline once this long passes without a heartbeat (nodes push every ~2s). */
export const SAT_HEARTBEAT_STALE_MS = 15_000;
const MAX_FLEET_SIZE = 32;
/** The one legal sat-id shape — heartbeat ingest and command routing both enforce it. */
export const SAT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const COMMAND_TIMEOUT_MS = 10_000;

/** Command rejection distinct from transport failure — maps to HTTP 409 at the route. */
export class SatCommandError extends Error {}

/** The engines a sat node can embed. Both are simulators — there is no flight transport. */
export type SatEngineKind = 'rk4' | 'nasa42';

/**
 * @description Control mode the node's local ADCS loop is in — the W2 five-mode machine
 * (SAFE/DETUMBLE/SLEW/POINT/DESAT). The pre-W2 command names (idle/rateDamp/point) still map
 * onto these at the command surface for backward compatibility.
 */
export type SatControlMode = 'SAFE' | 'DETUMBLE' | 'SLEW' | 'POINT' | 'DESAT';

/** MEKF readout for the fleet panel (display units), present once the estimator is engaged. */
export interface SatEstimatorTelemetry {
  initialized: boolean;
  updatesApplied: number;
  rejected: number;
  reinits: number;
  /** Estimated gyro bias, deg/hr per axis. */
  biasDegHr: Vec3;
  /** Attitude uncertainty 1σ, deg per axis. */
  attitudeSigmaDeg: Vec3;
}

/** ADCS mode-manager readout for the fleet panel (mode + why + dwell + momentum). */
export interface SatAdcsTelemetry {
  reason: string;
  timeInModeS: number;
  transitionCount: number;
  momentumFrac: number;
  dumping: boolean;
  hasTarget: boolean;
}

/** Telemetry snapshot a node pushes each heartbeat. */
export interface SatNodeTelemetry {
  state: SatAttitudeState;
  mode: SatControlMode;
  /** Pointing error vs the active target, degrees; null when not pointing. */
  pointingErrorDeg: number | null;
  /** Engine-truth flags (nasa42: star-fix + convention lock; rk4: always true). */
  attitudeCalibrated: boolean;
  /** Mode-manager diagnostics (reason, dwell, momentum fraction, dumping). */
  adcs?: SatAdcsTelemetry;
  /** MEKF diagnostics; absent on the truth-state RK4 path and before the first star fix. */
  estimator?: SatEstimatorTelemetry;
}

/** One heartbeat pushed by a sat node (validated at the route before ingest). */
export interface SatNodeHeartbeat {
  satId: string;
  /** Base URL the controller uses to reach the node (e.g. http://127.0.0.1:4200). */
  endpointUrl: string;
  engine: SatEngineKind;
  telemetry: SatNodeTelemetry;
}

/** One row of the fleet listing consumed by surfaces (and W3's fleet panel). */
export interface SatFleetSummary {
  satId: string;
  engine: SatEngineKind;
  online: boolean;
  lastSeenMs: number | null;
  telemetry: SatNodeTelemetry | null;
}

interface FleetEntry {
  endpointUrl: string;
  engine: SatEngineKind;
  telemetry: SatNodeTelemetry | null;
  lastSeen: number | null;
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string>;
}>;

/**
 * @description The dynamic sat registry (ADR-102 §1 via ADR-099): id → node, minted on first
 * authenticated heartbeat. Deliberately NOT the bot registry — sat nodes are device nodes
 * that come and go at runtime; liveness is heartbeat-derived, and an unknown or offline sat
 * is a command-time rejection, not a boot error.
 */
export class SatFleet {
  private readonly entries = new Map<string, FleetEntry>();

  private readonly clock: () => number;

  private readonly fetchImpl: FetchLike;

  constructor(opts: { clock?: () => number; fetchImpl?: FetchLike } = {}) {
    this.clock = opts.clock ?? ((): number => Date.now());
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  /**
   * @description Absorb one authenticated node heartbeat: mint the entry on first contact,
   * refresh after. Fleet size and id shape are bounded — a misbehaving client cannot grow
   * the map without limit or inject path-hostile ids.
   * @param hb - The heartbeat (route-validated shape; re-checked here fail-closed).
   */
  ingestHeartbeat(hb: SatNodeHeartbeat): void {
    if (!SAT_ID_RE.test(hb.satId)) throw new SatCommandError(`invalid satId "${hb.satId}"`);
    let entry = this.entries.get(hb.satId);
    if (!entry) {
      if (this.entries.size >= MAX_FLEET_SIZE) throw new SatCommandError(`fleet is at its ${MAX_FLEET_SIZE}-sat limit`);
      entry = { endpointUrl: '', engine: 'rk4', telemetry: null, lastSeen: null };
      this.entries.set(hb.satId, entry);
      logger.info({ satId: hb.satId, engine: hb.engine }, 'sat node joined the fleet');
    }
    entry.endpointUrl = hb.endpointUrl.replace(/\/+$/, '');
    entry.engine = hb.engine === 'nasa42' ? 'nasa42' : 'rk4';
    entry.telemetry = hb.telemetry;
    entry.lastSeen = this.clock();
  }

  /** @returns Whether the sat currently counts as reachable. */
  isOnline(satId: string): boolean {
    const entry = this.entries.get(satId);
    return !!entry && entry.lastSeen !== null && this.clock() - entry.lastSeen < SAT_HEARTBEAT_STALE_MS;
  }

  /** @returns Every known sat, online or not, for the fleet listing. */
  list(): SatFleetSummary[] {
    const out: SatFleetSummary[] = [];
    for (const [satId, entry] of this.entries) {
      out.push({
        satId,
        engine: entry.engine,
        online: this.isOnline(satId),
        lastSeenMs: entry.lastSeen,
        telemetry: entry.telemetry,
      });
    }
    return out;
  }

  /**
   * @description Dial one command to a node over the service-secret rail. Offline nodes
   * reject HERE, before any network I/O — no command runs against a dead link.
   * @param satId - Fleet id.
   * @param command - Node command name (point | setMode | status).
   * @param args - Command arguments, forwarded verbatim.
   * @returns The node's response body.
   */
  async command(satId: string, command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const entry = this.entries.get(satId);
    if (!entry) throw new SatCommandError(`unknown sat "${satId}"`);
    if (!this.isOnline(satId)) {
      const ago = entry.lastSeen === null ? 'never heartbeat' : `no heartbeat for ${Math.round((this.clock() - entry.lastSeen) / 1000)}s`;
      throw new SatCommandError(`sat "${satId}" is offline (${ago})`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${entry.endpointUrl}/api/sat-node/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
        body: JSON.stringify({ command, args }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 409) throw new SatCommandError(String(body.error ?? 'command rejected by node'));
      if (!res.ok) throw new Error(`node returned ${res.status}: ${String(body.error ?? 'unknown error')}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}
