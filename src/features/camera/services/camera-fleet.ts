/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the camera fleet plane.
 *                     |                             | Cameras register two ways: LOCAL (the embedded dev sim, always
 *                     |                             | online) or REMOTE (camera nodes joining via authenticated
 *                     |                             | heartbeats). Staleness is the liveness signal — a node that
 *                     |                             | stops heartbeating goes offline and commands are rejected.
 *                     |                             | Mirrors DroneFleet (ADR-099).
 */

import type { CameraTelemetry } from '../model/camera-types';
import { CameraCommandError, type CameraProvider, type CameraProviderKind } from './camera-provider';
import { RemoteCameraProvider, type CameraNodeHeartbeat } from './remote-camera-provider';
import { CAMERA_ID_RE } from './camera-validator';

/** A node is offline once this long passes without a heartbeat (nodes push every ~2s). */
export const CAMERA_HEARTBEAT_STALE_MS = 15_000;
const MAX_FLEET_SIZE = 32;

/** One row of the fleet listing consumed by the surface and the concierge prompt. */
export interface CameraFleetSummary {
  cameraId: string;
  kind: CameraProviderKind;
  remote: boolean;
  online: boolean;
  lastSeenMs: number | null;
  telemetry: CameraTelemetry | null;
  /** Browser-playable feed URL the node declared, if any. */
  videoUrl: string | null;
}

interface FleetEntry {
  provider: CameraProvider;
  remote: RemoteCameraProvider | null;
}

/**
 * @description The dynamic camera registry: id → provider, where a provider is either the embedded
 * local sim or a {@link RemoteCameraProvider} minted on first heartbeat. Deliberately NOT the bot
 * registry — cameras are device nodes that come and go at runtime; liveness is heartbeat-derived,
 * and an unknown or offline camera is a command-time rejection, not a boot error.
 */
export class CameraFleet {
  private readonly entries = new Map<string, FleetEntry>();
  private readonly clock: () => number;

  constructor(opts: { clock?: () => number } = {}) {
    this.clock = opts.clock ?? ((): number => Date.now());
  }

  /**
   * @description Register an in-process provider (the embedded dev sim). Local providers are
   * always online.
   * @param cameraId - Fleet id.
   * @param provider - The provider instance.
   */
  registerLocal(cameraId: string, provider: CameraProvider): void {
    this.entries.set(cameraId, { provider, remote: null });
  }

  /**
   * @description Absorb one authenticated node heartbeat: mint the remote provider on first
   * contact, refresh its cache after. Fleet size and id shape are bounded.
   * @param hb - The heartbeat (route-validated shape; id/shape re-checked here fail-closed).
   * @returns The event ack cursor for the node.
   */
  ingestHeartbeat(hb: CameraNodeHeartbeat): number {
    if (!CAMERA_ID_RE.test(hb.cameraId)) throw new CameraCommandError(`invalid cameraId "${hb.cameraId}"`);
    let entry = this.entries.get(hb.cameraId);
    if (!entry) {
      if (this.entries.size >= MAX_FLEET_SIZE) throw new CameraCommandError(`fleet is at its ${MAX_FLEET_SIZE}-camera limit`);
      const remote = new RemoteCameraProvider({ cameraId: hb.cameraId, clock: this.clock });
      entry = { provider: remote, remote };
      this.entries.set(hb.cameraId, entry);
    }
    if (!entry.remote) throw new CameraCommandError(`cameraId "${hb.cameraId}" is a local camera — a node may not claim it`);
    return entry.remote.ingestHeartbeat(hb);
  }

  /**
   * @description Resolve a camera or reject. Offline remotes reject HERE so no command runs against
   * a dead link.
   * @param cameraId - Fleet id.
   * @returns The provider.
   */
  get(cameraId: string): CameraProvider {
    const entry = this.entries.get(cameraId);
    if (!entry) throw new CameraCommandError(`unknown camera "${cameraId}"`);
    if (entry.remote && !this.isOnline(cameraId)) {
      const last = entry.remote.lastSeen;
      const ago = last === null ? 'never heartbeat' : `no heartbeat for ${Math.round((this.clock() - last) / 1000)}s`;
      throw new CameraCommandError(`camera "${cameraId}" is offline (${ago})`);
    }
    return entry.provider;
  }

  /** @returns Whether the camera currently counts as reachable. Local cameras always are. */
  isOnline(cameraId: string): boolean {
    const entry = this.entries.get(cameraId);
    if (!entry) return false;
    if (!entry.remote) return true;
    const last = entry.remote.lastSeen;
    return last !== null && this.clock() - last < CAMERA_HEARTBEAT_STALE_MS;
  }

  /** @returns Every known camera, online or not, for the surface's fleet panel. */
  list(): CameraFleetSummary[] {
    const out: CameraFleetSummary[] = [];
    for (const [cameraId, entry] of this.entries) {
      let telemetry: CameraTelemetry | null = null;
      try { telemetry = entry.provider.getTelemetry(); } catch { telemetry = null; }
      out.push({
        cameraId,
        kind: entry.provider.kind,
        remote: !!entry.remote,
        online: this.isOnline(cameraId),
        lastSeenMs: entry.remote ? entry.remote.lastSeen : null,
        telemetry,
        videoUrl: entry.remote ? entry.remote.videoUrl : null,
      });
    }
    return out.sort((a, b) => a.cameraId.localeCompare(b.cameraId));
  }
}
