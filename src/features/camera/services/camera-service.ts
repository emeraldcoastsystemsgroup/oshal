/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the camera control service:
 *                     |                             | owns the fleet, registers the embedded sim(s) so ?app=camera
 *                     |                             | works with zero hardware, dispatches validated commands to the
 *                     |                             | right provider, and gates destructive ops (deleteAll) behind an
 *                     |                             | explicit confirmation (HTTP 428), mirroring the home-bot write
 *                     |                             | gate. The provider owns the device state machine; this owns policy.
 */

import { createChildLogger } from '@/shared/logger';
import type { CameraCapture, CameraCommand, CameraEvent, CameraTelemetry } from '../model/camera-types';
import { CameraCommandError, type CameraProvider } from './camera-provider';
import { CameraFleet, type CameraFleetSummary } from './camera-fleet';
import type { CameraNodeHeartbeat } from './remote-camera-provider';
import { SimCameraProvider } from './sim-camera-provider';
import { CAMERA_ID_RE, DESTRUCTIVE_CAMERA_OPS } from './camera-validator';

const logger = createChildLogger({ module: 'camera-service' });

/** The always-present embedded sim camera id (like the drone's `alpha`). */
export const DEFAULT_CAMERA_ID = 'sim-1';

/**
 * @description Thrown when a destructive command (delete-all) arrives without explicit confirmation.
 * Routes map it to HTTP 428 (Precondition Required) — the surface then re-issues with `confirmed`.
 */
export class CameraConfirmationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CameraConfirmationRequiredError';
  }
}

/** Per-call policy inputs (currently just the destructive-op confirmation). */
export interface CameraCommandContext {
  confirmed?: boolean;
}

/** Parse the CAMERA_EMBEDDED_SIMS env (comma-separated ids) into a validated list. */
function parseEmbeddedSims(raw: string | undefined): string[] {
  const ids = (raw ?? DEFAULT_CAMERA_ID)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && CAMERA_ID_RE.test(s));
  return ids.length ? Array.from(new Set(ids)) : [DEFAULT_CAMERA_ID];
}

/**
 * @description The camera control service. One per controller process; holds the {@link CameraFleet},
 * seeds it with the embedded sim(s), and is the single entry point routes call. All command
 * dispatch and the destructive-op gate live here so the transport (interactive route or a scheduled
 * ticket) is thin.
 */
export class CameraService {
  private readonly fleet: CameraFleet;

  constructor(opts: { fleet?: CameraFleet; embeddedSims?: string[]; clock?: () => number } = {}) {
    this.fleet = opts.fleet ?? new CameraFleet({ clock: opts.clock });
    const sims = opts.embeddedSims ?? parseEmbeddedSims(process.env.CAMERA_EMBEDDED_SIMS);
    for (const id of sims) {
      this.fleet.registerLocal(id, new SimCameraProvider({ cameraId: id, clock: opts.clock }));
    }
    logger.info({ embeddedSims: sims }, 'Camera service ready');
  }

  /** @returns The underlying fleet (heartbeat ingest, membership). */
  getFleet(): CameraFleet { return this.fleet; }

  /** @returns The fleet listing for the surface. */
  list(): CameraFleetSummary[] { return this.fleet.list(); }

  /** @description Absorb one authenticated camera-node heartbeat. @returns The node's ack cursor. */
  ingestHeartbeat(hb: CameraNodeHeartbeat): number { return this.fleet.ingestHeartbeat(hb); }

  /** @returns Live telemetry for one camera (throws if unknown/offline). */
  getTelemetry(cameraId: string): CameraTelemetry { return this.fleet.get(cameraId).getTelemetry(); }

  /** @returns Event-log entries newer than `sinceSeq`. */
  getEvents(cameraId: string, sinceSeq: number): CameraEvent[] { return this.fleet.get(cameraId).getEvents(sinceSeq); }

  /** @returns Capture/media records newer than `sinceSeq`. */
  getCaptures(cameraId: string, sinceSeq: number): CameraCapture[] { return this.fleet.get(cameraId).getCaptures(sinceSeq); }

  /**
   * @description Execute one validated command against a camera. Destructive ops require
   * `ctx.confirmed`. The command must already be normalized ({@link CameraCommand}) — this method
   * trusts its shape but still guards required fields defensively.
   * @param cameraId - Target camera.
   * @param command - A normalized command.
   * @param ctx - Per-call policy (confirmation).
   * @returns The camera's telemetry after the command.
   */
  async execute(cameraId: string, command: CameraCommand, ctx: CameraCommandContext = {}): Promise<CameraTelemetry> {
    if (DESTRUCTIVE_CAMERA_OPS.has(command.op) && !ctx.confirmed) {
      throw new CameraConfirmationRequiredError(`"${command.op}" permanently deletes media — confirm to proceed`);
    }
    const provider = this.fleet.get(cameraId);
    await this.dispatch(provider, command);
    logger.info({ cameraId, op: command.op }, 'Camera command executed');
    return provider.getTelemetry();
  }

  /** Route a normalized command to the matching provider method, guarding op-specific fields. */
  private async dispatch(p: CameraProvider, c: CameraCommand): Promise<void> {
    switch (c.op) {
      case 'connect': return p.connect();
      case 'disconnect': return p.disconnect();
      case 'record': return p.startRecording();
      case 'stop': return p.stopRecording();
      case 'photo': return p.capturePhoto();
      case 'setMode':
        if (!c.mode) throw new CameraCommandError('setMode requires a mode');
        return p.setMode(c.mode);
      case 'loadPreset':
        if (c.presetId === undefined) throw new CameraCommandError('loadPreset requires a presetId');
        return p.loadPreset(c.presetId);
      case 'setSetting':
        if (c.setting === undefined || c.option === undefined) throw new CameraCommandError('setSetting requires setting + option');
        return p.setSetting(c.setting, c.option);
      case 'startPreview': return p.startPreview();
      case 'stopPreview': return p.stopPreview();
      case 'keepAlive': return p.keepAlive();
      case 'deleteAll': return p.deleteAll();
      default: throw new CameraCommandError(`unhandled op "${(c as CameraCommand).op}"`);
    }
  }
}
