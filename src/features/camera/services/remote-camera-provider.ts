/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the controller-side proxy
 *                     |                             | for a REMOTE camera node (the camera-node host process).
 *                     |                             | Commands go out over the swarm service-secret rail; telemetry,
 *                     |                             | events, captures, and a browser-playable videoUrl arrive via
 *                     |                             | node heartbeats and are served from cache (real downlink
 *                     |                             | shape). Mirrors RemoteDroneProvider (ADR-099 phase 2).
 */

import { serviceSecretHeaders } from '@/shared/middleware/authz';
import type {
  CameraCapture,
  CameraEvent,
  CameraMode,
  CameraTelemetry,
} from '../model/camera-types';
import { normalizeCameraCapture } from './camera-validator';
import { CameraCommandError, type CameraProvider, type CameraProviderKind } from './camera-provider';

const COMMAND_TIMEOUT_MS = 10_000;
const EVENT_RETENTION = 200;
const CAPTURE_RETENTION = 100;
const HTTP_URL_RE = /^https?:\/\/\S{1,300}$/;

/** One heartbeat pushed by a camera node (validated at the route before ingest). */
export interface CameraNodeHeartbeat {
  cameraId: string;
  /** Base URL the controller uses to reach the node (e.g. http://host.docker.internal:4200). */
  endpointUrl: string;
  /** The engine actually running at the node. */
  engine: CameraProviderKind;
  telemetry: CameraTelemetry;
  /** Node events newer than the controller's last ack. */
  events: CameraEvent[];
  /** A browser-playable feed URL the node serves (e.g. transcoded HLS/MJPEG); http/https only. */
  videoUrl?: string;
  /** Recent capture records (snapshot; the controller merges by seq). */
  captures?: CameraCapture[];
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string>;
}>;

/**
 * @description Proxy {@link CameraProvider} for a camera that lives on a REMOTE camera node.
 * Commands POST to the node's secret-guarded endpoint; telemetry, events, captures, and the model
 * name are whatever the node last heartbeat in — reads are cache-fast and never block on the
 * network. When heartbeats stop, {@link CameraFleet} marks the camera offline and commands are
 * rejected before any work runs.
 */
export class RemoteCameraProvider implements CameraProvider {
  readonly kind: CameraProviderKind = 'gopro';
  readonly cameraId: string;

  private endpointUrl = '';
  private telemetry: CameraTelemetry | null = null;
  private events: CameraEvent[] = [];
  private captures: CameraCapture[] = [];
  private lastSeenMs: number | null = null;
  private videoUrlValue: string | null = null;
  private readonly clock: () => number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: { cameraId: string; clock?: () => number; fetchImpl?: FetchLike }) {
    this.cameraId = opts.cameraId;
    this.clock = opts.clock ?? ((): number => Date.now());
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  get model(): string { return this.telemetry?.model ?? 'GoPro'; }
  /** @returns Milliseconds timestamp of the last accepted heartbeat (null = never seen). */
  get lastSeen(): number | null { return this.lastSeenMs; }
  /** @returns The node-declared browser-playable feed URL, if any. */
  get videoUrl(): string | null { return this.videoUrlValue; }

  /**
   * @description Absorb one node heartbeat: endpoint, telemetry snapshot, new events, and any new
   * captures (deduped by seq, retention-capped, and coerced — a node is untrusted input).
   * @param hb - The validated heartbeat.
   * @returns The highest event seq now held — returned to the node as its ack cursor.
   */
  ingestHeartbeat(hb: CameraNodeHeartbeat): number {
    this.endpointUrl = hb.endpointUrl.replace(/\/+$/, '');
    this.telemetry = hb.telemetry;
    this.videoUrlValue = typeof hb.videoUrl === 'string' && HTTP_URL_RE.test(hb.videoUrl) ? hb.videoUrl : null;
    this.lastSeenMs = this.clock();
    const held = this.events.length ? this.events[this.events.length - 1].seq : 0;
    for (const ev of hb.events ?? []) {
      if (ev.seq > held) this.events.push(ev);
    }
    if (this.events.length > EVENT_RETENTION) this.events.splice(0, this.events.length - EVENT_RETENTION);
    const capHeld = this.captures.length ? this.captures[this.captures.length - 1].seq : 0;
    for (const raw of hb.captures ?? []) {
      const cap = normalizeCameraCapture(raw);
      if (cap && cap.seq > capHeld) this.captures.push(cap);
    }
    if (this.captures.length > CAPTURE_RETENTION) this.captures.splice(0, this.captures.length - CAPTURE_RETENTION);
    return this.events.length ? this.events[this.events.length - 1].seq : held;
  }

  // ── CameraProvider commands (proxied to the node) ──────────────────────────

  async connect(): Promise<void> { await this.command('connect'); }
  async disconnect(): Promise<void> { await this.command('disconnect'); }
  async startRecording(): Promise<void> { await this.command('record'); }
  async stopRecording(): Promise<void> { await this.command('stop'); }
  async capturePhoto(): Promise<void> { await this.command('photo'); }
  async setMode(mode: CameraMode): Promise<void> { await this.command('setMode', { mode }); }
  async loadPreset(presetId: number): Promise<void> { await this.command('loadPreset', { presetId }); }
  async setSetting(setting: number, option: number): Promise<void> { await this.command('setSetting', { setting, option }); }
  async startPreview(): Promise<void> { await this.command('startPreview'); }
  async stopPreview(): Promise<void> { await this.command('stopPreview'); }
  async keepAlive(): Promise<void> { await this.command('keepAlive'); }
  async deleteAll(): Promise<void> { await this.command('deleteAll'); }

  getTelemetry(): CameraTelemetry {
    if (!this.telemetry) throw new CameraCommandError(`camera "${this.cameraId}" has not reported telemetry yet`);
    return this.telemetry;
  }

  getEvents(sinceSeq: number): CameraEvent[] { return this.events.filter((e) => e.seq > sinceSeq); }
  getCaptures(sinceSeq: number): CameraCapture[] { return this.captures.filter((c) => c.seq > sinceSeq); }

  /**
   * @description Send one command envelope to the node over the service-secret rail. A node-side
   * rejection (409) surfaces as {@link CameraCommandError} with the node's reason; transport
   * failures surface as an offline-style rejection. A success response refreshes the telemetry
   * cache immediately so the surface sees the effect before the next heartbeat.
   */
  private async command(command: string, args: Record<string, unknown> = {}): Promise<void> {
    if (!this.endpointUrl) throw new CameraCommandError(`camera "${this.cameraId}" has no known endpoint (no heartbeat yet)`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.endpointUrl}/api/camera-node/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
        body: JSON.stringify({ command, args }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; telemetry?: CameraTelemetry };
      if (!res.ok) throw new CameraCommandError(body.error || `camera node returned HTTP ${res.status}`);
      if (body.telemetry) this.telemetry = body.telemetry;
    } catch (err) {
      if (err instanceof CameraCommandError) throw err;
      throw new CameraCommandError(`camera "${this.cameraId}" unreachable: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
