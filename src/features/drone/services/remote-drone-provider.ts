/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — ADR-099 phase 2: the
 *                     |                             | controller-side proxy for a REMOTE drone node. Commands go
 *                     |                             | out over the swarm service-secret rail; telemetry/events
 *                     |                             | arrive via node heartbeats and are served from cache (real
 *                     |                             | downlink shape). The node's engine kind (sim|mavlink) is
 *                     |                             | reported, so the hardware confirm rail sees the truth.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Nodes may declare a videoUrl (real
 *                     |                             | camera feed endpoint) in their heartbeat; cached + exposed
 *                     |                             | to the fleet listing for the surface's live-video card.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Camera equipment: setCamera proxies to
 *                     |                             | the node; capture records ride the heartbeat (snapshot of
 *                     |                             | the node's recent captures, merged by seq like events) so
 *                     |                             | the gallery works for remote drones too.
 */

import { serviceSecretHeaders } from '@/shared/middleware/authz';
import type { CameraAction, CameraCapture, DroneEvent, DroneTelemetry, GeoPoint, MissionPlan } from '../model/drone-types';
import { normalizeCameraCapture } from './mission-validator';
import { DroneCommandError, type DroneProvider, type DroneProviderKind } from './drone-provider';

const COMMAND_TIMEOUT_MS = 10_000;
const EVENT_RETENTION = 200;

/** One heartbeat pushed by a drone node (validated at the route before ingest). */
export interface DroneNodeHeartbeat {
  droneId: string;
  /** Base URL the controller uses to reach the node (e.g. http://192.168.1.40:4100). */
  endpointUrl: string;
  /** The engine actually flying at the node. */
  engine: DroneProviderKind;
  telemetry: DroneTelemetry;
  /** Node events newer than the controller's last ack. */
  events: DroneEvent[];
  /** Optional camera-feed URL served by the node's hardware (http/https only). */
  videoUrl?: string;
  /** Recent camera capture records (snapshot; the controller merges by seq). */
  captures?: CameraCapture[];
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string>;
}>;

/**
 * @description Proxy {@link DroneProvider} for a drone that lives on a REMOTE swarm node
 * (ADR-099). Commands POST to the node's secret-guarded endpoint; telemetry, events, and the
 * home point are whatever the node last heartbeat in — reads are cache-fast and never block on
 * the network, exactly like a real telemetry downlink. When heartbeats stop, {@link DroneFleet}
 * marks the drone offline and commands are rejected before any validation runs.
 */
export class RemoteDroneProvider implements DroneProvider {
  readonly droneId: string;
  private endpointUrl = '';
  private engineKind: DroneProviderKind = 'sim';
  private telemetry: DroneTelemetry | null = null;
  private events: DroneEvent[] = [];
  private captures: CameraCapture[] = [];
  private lastSeenMs: number | null = null;
  private videoUrlValue: string | null = null;
  private readonly clock: () => number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: { droneId: string; clock?: () => number; fetchImpl?: FetchLike }) {
    this.droneId = opts.droneId;
    this.clock = opts.clock ?? ((): number => Date.now());
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  /** @returns The node-reported engine kind — 'mavlink' here is what arms the hardware confirm rail. */
  get kind(): DroneProviderKind {
    return this.engineKind;
  }

  /** @returns The launch point as last reported by the node (fence validation centers here). */
  get home(): GeoPoint {
    return this.telemetry?.home ?? { lat: 0, lon: 0, alt: 0 };
  }

  /** @returns Milliseconds timestamp of the last accepted heartbeat (null = never seen). */
  get lastSeen(): number | null {
    return this.lastSeenMs;
  }

  /** @returns The node-declared camera-feed URL, if any. */
  get videoUrl(): string | null {
    return this.videoUrlValue;
  }

  /**
   * @description Absorb one node heartbeat: endpoint, engine kind, telemetry snapshot, and any
   * new events (deduped by seq, retention-capped).
   * @param hb - The validated heartbeat.
   * @returns The highest event seq now held — returned to the node as its ack cursor.
   */
  ingestHeartbeat(hb: DroneNodeHeartbeat): number {
    this.endpointUrl = hb.endpointUrl.replace(/\/+$/, '');
    this.engineKind = hb.engine === 'mavlink' ? 'mavlink' : 'sim';
    this.telemetry = hb.telemetry;
    this.videoUrlValue = typeof hb.videoUrl === 'string' && /^https?:\/\/\S{1,300}$/.test(hb.videoUrl) ? hb.videoUrl : null;
    this.lastSeenMs = this.clock();
    const held = this.events.length ? this.events[this.events.length - 1].seq : 0;
    for (const ev of hb.events ?? []) {
      if (ev.seq > held) this.events.push(ev);
    }
    if (this.events.length > EVENT_RETENTION) this.events.splice(0, this.events.length - EVENT_RETENTION);
    const capHeld = this.captures.length ? this.captures[this.captures.length - 1].seq : 0;
    for (const raw of hb.captures ?? []) {
      // A node is untrusted input: coerce every capture field (the surface renders them).
      const cap = normalizeCameraCapture(raw);
      if (cap && cap.seq > capHeld) this.captures.push(cap);
    }
    if (this.captures.length > EVENT_RETENTION) this.captures.splice(0, this.captures.length - EVENT_RETENTION);
    return this.events.length ? this.events[this.events.length - 1].seq : held;
  }

  // ── DroneProvider commands (proxied to the node) ───────────────────────────

  async arm(): Promise<void> { await this.command('arm'); }
  async disarm(): Promise<void> { await this.command('disarm'); }
  async takeoff(altM: number): Promise<void> { await this.command('takeoff', { altM }); }
  async gotoPoint(pt: GeoPoint, speedMps: number): Promise<void> { await this.command('gotoPoint', { pt, speedMps }); }
  async startMission(plan: MissionPlan): Promise<void> { await this.command('startMission', { plan }); }
  async abortMission(): Promise<void> { await this.command('abortMission'); }
  async land(): Promise<void> { await this.command('land'); }
  async returnToLaunch(): Promise<void> { await this.command('returnToLaunch'); }
  async replaceBattery(): Promise<void> { await this.command('replaceBattery'); }
  async setHeading(deg: number): Promise<void> { await this.command('setHeading', { deg }); }
  async setLed(color: string): Promise<void> { await this.command('setLed', { color }); }
  async setCamera(action: CameraAction): Promise<void> { await this.command('setCamera', { action }); }

  getCaptures(sinceSeq: number): CameraCapture[] {
    return this.captures.filter((c) => c.seq > sinceSeq);
  }

  getTelemetry(): DroneTelemetry {
    if (!this.telemetry) throw new DroneCommandError(`drone "${this.droneId}" has not reported telemetry yet`);
    return this.telemetry;
  }

  getEvents(sinceSeq: number): DroneEvent[] {
    return this.events.filter((e) => e.seq > sinceSeq);
  }

  /**
   * @description Send one command envelope to the node over the service-secret rail. A node-side
   * rejection (409) surfaces as {@link DroneCommandError} with the node's reason; transport
   * failures surface as an offline-style rejection. A success response refreshes the telemetry
   * cache immediately so the surface sees the effect before the next heartbeat.
   */
  private async command(command: string, args: Record<string, unknown> = {}): Promise<void> {
    if (!this.endpointUrl) throw new DroneCommandError(`drone "${this.droneId}" has no known endpoint (no heartbeat yet)`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.endpointUrl}/api/drone-node/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
        body: JSON.stringify({ command, args }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; telemetry?: DroneTelemetry };
      if (!res.ok) throw new DroneCommandError(body.error || `drone node returned HTTP ${res.status}`);
      if (body.telemetry) this.telemetry = body.telemetry;
    } catch (err) {
      if (err instanceof DroneCommandError) throw err;
      throw new DroneCommandError(`drone "${this.droneId}" unreachable: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
