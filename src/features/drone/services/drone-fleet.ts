/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — ADR-099 phase 2: the
 *                     |                             | fleet plane. Drones register two ways: LOCAL (the embedded
 *                     |                             | dev sim) or REMOTE (drone nodes joining via authenticated
 *                     |                             | heartbeats). Staleness is the liveness signal — a node that
 *                     |                             | stops heartbeating goes offline and commands are rejected.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export DRONE_ID_RE so fleet-mission
 *                     |                             | normalization enforces the same id shape as heartbeat ingest.
 */

import type { DroneTelemetry } from '../model/drone-types';
import { DroneCommandError, type DroneProvider, type DroneProviderKind } from './drone-provider';
import { RemoteDroneProvider, type DroneNodeHeartbeat } from './remote-drone-provider';

/** A node is offline once this long passes without a heartbeat (nodes push every ~2s). */
export const HEARTBEAT_STALE_MS = 15_000;
const MAX_FLEET_SIZE = 32;
/** The one legal drone-id shape — shared by heartbeat ingest and fleet-mission normalization. */
export const DRONE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** One row of the fleet listing consumed by the surface and the concierge prompt. */
export interface FleetSummary {
  droneId: string;
  kind: DroneProviderKind;
  remote: boolean;
  online: boolean;
  lastSeenMs: number | null;
  telemetry: DroneTelemetry | null;
  /** Camera-feed URL the node declared, if any (surface shows the live-video card). */
  videoUrl: string | null;
}

interface FleetEntry {
  provider: DroneProvider;
  remote: RemoteDroneProvider | null;
}

/**
 * @description The dynamic drone registry (ADR-099): id → provider, where a provider is either
 * the embedded local sim or a {@link RemoteDroneProvider} minted on first heartbeat. Deliberately
 * NOT the bot registry — drones are device nodes that come and go at runtime; liveness is
 * heartbeat-derived, and an unknown or offline drone is a command-time rejection, not a boot error.
 */
export class DroneFleet {
  private readonly entries = new Map<string, FleetEntry>();
  private readonly clock: () => number;

  constructor(opts: { clock?: () => number } = {}) {
    this.clock = opts.clock ?? ((): number => Date.now());
  }

  /**
   * @description Register an in-process provider (the embedded dev sim). Local providers are
   * always online.
   * @param droneId - Fleet id.
   * @param provider - The provider instance.
   */
  registerLocal(droneId: string, provider: DroneProvider): void {
    this.entries.set(droneId, { provider, remote: null });
  }

  /**
   * @description Absorb one authenticated node heartbeat: mint the remote provider on first
   * contact, refresh its cache after. Fleet size and id shape are bounded — a misbehaving
   * client cannot grow the map without limit or inject path-hostile ids.
   * @param hb - The heartbeat (route-validated shape; id/shape re-checked here fail-closed).
   * @returns The event ack cursor for the node.
   */
  ingestHeartbeat(hb: DroneNodeHeartbeat): number {
    if (!DRONE_ID_RE.test(hb.droneId)) throw new DroneCommandError(`invalid droneId "${hb.droneId}"`);
    let entry = this.entries.get(hb.droneId);
    if (!entry) {
      if (this.entries.size >= MAX_FLEET_SIZE) throw new DroneCommandError(`fleet is at its ${MAX_FLEET_SIZE}-drone limit`);
      const remote = new RemoteDroneProvider({ droneId: hb.droneId, clock: this.clock });
      entry = { provider: remote, remote };
      this.entries.set(hb.droneId, entry);
    }
    if (!entry.remote) throw new DroneCommandError(`droneId "${hb.droneId}" is a local drone — a node may not claim it`);
    return entry.remote.ingestHeartbeat(hb);
  }

  /**
   * @description Resolve a drone or reject. Offline remotes reject HERE so no command (or fence
   * validation against stale home data) runs against a dead link.
   * @param droneId - Fleet id.
   * @returns The provider.
   */
  get(droneId: string): DroneProvider {
    const entry = this.entries.get(droneId);
    if (!entry) throw new DroneCommandError(`unknown drone "${droneId}"`);
    if (entry.remote && !this.isOnline(droneId)) {
      const last = entry.remote.lastSeen;
      const ago = last === null ? 'never heartbeat' : `no heartbeat for ${Math.round((this.clock() - last) / 1000)}s`;
      throw new DroneCommandError(`drone "${droneId}" is offline (${ago})`);
    }
    return entry.provider;
  }

  /** @returns Whether the drone currently counts as reachable. Local drones always are. */
  isOnline(droneId: string): boolean {
    const entry = this.entries.get(droneId);
    if (!entry) return false;
    if (!entry.remote) return true;
    const last = entry.remote.lastSeen;
    return last !== null && this.clock() - last < HEARTBEAT_STALE_MS;
  }

  /** @returns Every known drone, online or not, for the surface's fleet panel. */
  list(): FleetSummary[] {
    const out: FleetSummary[] = [];
    for (const [droneId, entry] of this.entries) {
      let telemetry: DroneTelemetry | null = null;
      try { telemetry = entry.provider.getTelemetry(); } catch { telemetry = null; }
      out.push({
        droneId,
        kind: entry.provider.kind,
        remote: !!entry.remote,
        online: this.isOnline(droneId),
        lastSeenMs: entry.remote ? entry.remote.lastSeen : null,
        telemetry,
        videoUrl: entry.remote ? entry.remote.videoUrl : null,
      });
    }
    return out.sort((a, b) => a.droneId.localeCompare(b.droneId));
  }
}
