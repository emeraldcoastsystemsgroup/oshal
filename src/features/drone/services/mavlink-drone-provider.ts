/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the MAVLink sibling of
 *                     |                             | SimDroneProvider (ADR-099 "generic adapter"): drives any
 *                     |                             | ArduPilot/PX4-style flight controller over MAVLink v2
 *                     |                             | (TCP; SITL's 5760 or a companion-link bridge). GUIDED-mode
 *                     |                             | control: arm/takeoff/goto via COMMAND_LONG + position
 *                     |                             | setpoints; missions run as a node-side setpoint loop with
 *                     |                             | arrival detection from live telemetry (no vendor mission
 *                     |                             | upload protocol needed); RTL/LAND are flight-mode switches.
 *                     |                             | Telemetry is cache-served from the stream. Live-proven
 *                     |                             | against ArduPilot SITL (see ADR-099 evidence).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | setHeading is real: MAV_CMD_CONDITION_YAW
 *                     |                             | (115) through the ACK-awaited commandLong rail — rotation
 *                     |                             | now works on real airframes. Camera equipment still
 *                     |                             | honestly rejects (DO_DIGICAM/gimbal manager = BACKLOG).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Require MAVLink 2 signing in both directions, pin the
 *                     |                             | first authenticated autopilot system, reject unsigned,
 *                     |                             | invalid, cross-system, and replayed packets, and emit
 *                     |                             | monotonically signed commands over the real TCP link.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Bound malformed TCP ingress, compare packet signatures
 *                     |                             | in constant time, rate-limit rejection logs, and cleanly
 *                     |                             | reset failed/reconnected links and pending commands.
 */

import * as net from 'net';
import { timingSafeEqual } from 'node:crypto';
import type { TransformCallback } from 'node:stream';
import {
  MavLinkPacketSplitter,
  MavLinkPacketParser,
  sendSigned as mavSendSigned,
  minimal,
  common,
  ardupilotmega,
  type MavLinkPacket,
  type MavLinkData,
} from 'node-mavlink';
import { createChildLogger } from '@/shared/logger';
import type { CameraAction, CameraCapture, DroneEvent, DroneFlightStatus, DroneTelemetry, GeoPoint, MissionPlan } from '../model/drone-types';
import { haversineM } from './mission-validator';
import { DroneCommandError, type DroneProvider, type DroneProviderKind } from './drone-provider';

const logger = createChildLogger({ module: 'mavlink-drone-provider' });

// ArduPilot Copter custom_mode numbers.
const MODE_GUIDED = 4;
const MODE_RTL = 6;
const MODE_LAND = 9;

const CMD_SET_MODE = 176;        // MAV_CMD_DO_SET_MODE
const CMD_ARM_DISARM = 400;      // MAV_CMD_COMPONENT_ARM_DISARM
const CMD_NAV_TAKEOFF = 22;      // MAV_CMD_NAV_TAKEOFF
const CMD_CONDITION_YAW = 115;   // MAV_CMD_CONDITION_YAW
/** Yaw slew rate for CONDITION_YAW, deg/s — gentle enough for a camera payload. */
const YAW_RATE_DPS = 30;
const MODE_FLAG_CUSTOM = 1;      // MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
const MODE_FLAG_ARMED = 128;     // MAV_MODE_FLAG_SAFETY_ARMED
/** SET_POSITION_TARGET type_mask: use position only (ignore vel/accel/yaw). */
const POSITION_ONLY_MASK = 0x0df8;
const FRAME_GLOBAL_RELATIVE_ALT_INT = 6;

const ACK_TIMEOUT_MS = 8_000;
const TICK_MS = 500;
const ARRIVAL_RADIUS_M = 2;
const ARRIVAL_ALT_M = 1.5;
const EVENT_RETENTION = 200;
const MAX_PENDING_MAVLINK_BYTES = 4_096;
const AUTH_REJECTION_LOG_INTERVAL_MS = 1_000;

/** Stop a peer from making node-mavlink retain an unbounded stream with no valid frame start. */
class BoundedMavLinkPacketSplitter extends MavLinkPacketSplitter {
  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    super._transform(chunk, encoding, (error?: Error | null) => {
      if (error) { callback(error); return; }
      const pending = (this as unknown as { buffer: Buffer }).buffer;
      callback(pending.length > MAX_PENDING_MAVLINK_BYTES
        ? new Error('MAVLink ingress exceeded the pending-frame limit')
        : null);
    });
  }
}

type Op =
  | { kind: 'none' }
  | { kind: 'takeoff'; altM: number }
  | { kind: 'goto'; target: GeoPoint }
  | { kind: 'mission'; plan: MissionPlan; index: number; holdUntilMs: number | null; setpointSent: boolean };

/** Construction options for the MAVLink adapter. */
export interface MavlinkDroneOptions {
  droneId?: string;
  /** e.g. tcp://127.0.0.1:5760 (SITL) or tcp://<companion-bridge>:<port>. */
  url: string;
  /** Raw 32-byte MAVLink 2 packet-signing key shared only with this flight controller. */
  signingKey: Buffer;
  /** MAVLink signing link id for this companion/GCS connection (0-255). */
  signingLinkId?: number;
}

/**
 * @description The "generic hardware adapter": a {@link DroneProvider} speaking MAVLink v2 —
 * the open protocol ArduPilot and PX4 flight controllers share — so one adapter covers the
 * broad class of non-proprietary drones and SITL identically. Control model is deliberately
 * minimal and vendor-neutral: GUIDED-mode position setpoints driven by this node with arrival
 * detection from the live telemetry stream (the same loop shape as the sim), never the
 * autopilot's vendor mission-upload protocol. All geofence validation stays controller-side
 * (ADR-099); this class only ever executes already-validated envelopes.
 */
export class MavlinkDroneProvider implements DroneProvider {
  readonly kind: DroneProviderKind = 'mavlink';
  readonly droneId: string;

  private readonly url: string;
  private readonly signingKey: Buffer;
  private readonly signingLinkId: number;
  private socket: net.Socket | null = null;
  private targetSystem = 1;
  private targetComponent = 1;
  private targetSystemLocked = false;
  private connected = false;
  private streamsRequested = false;
  private readonly inboundSigningTimestamps = new Map<string, number>();
  private lastOutboundSigningTimestamp = 0;
  private lastAuthRejectionLogMs = 0;
  private suppressedAuthRejections = 0;

  private armed = false;
  private customMode = 0;
  private pos: GeoPoint = { lat: 0, lon: 0, alt: 0 };
  private headingDeg = 0;
  private groundSpeedMps = 0;
  private batteryPct = 100;
  private homePos: GeoPoint | null = null;
  private haveFix = false;
  private op: Op = { kind: 'none' };

  private events: DroneEvent[] = [];
  private seq = 0;
  private pendingAcks = new Map<number, { resolve: (result: number) => void; timer: NodeJS.Timeout }>();
  private ticker: NodeJS.Timeout | null = null;

  constructor(opts: MavlinkDroneOptions) {
    if (!Buffer.isBuffer(opts.signingKey) || opts.signingKey.length !== 32) {
      throw new DroneCommandError('MAVLink signing requires an exact 32-byte key');
    }
    const linkId = opts.signingLinkId ?? 1;
    if (!Number.isInteger(linkId) || linkId < 0 || linkId > 255) {
      throw new DroneCommandError('MAVLink signing link id must be an integer from 0 through 255');
    }
    this.droneId = opts.droneId ?? 'drone-1';
    this.url = opts.url;
    this.signingKey = Buffer.from(opts.signingKey);
    this.signingLinkId = linkId;
  }

  get home(): GeoPoint {
    return this.homePos ?? { lat: this.pos.lat, lon: this.pos.lon, alt: 0 };
  }

  // ── Link lifecycle ─────────────────────────────────────────────────────────

  /**
   * @description Open the MAVLink link and start the control tick. Resolves once the vehicle's
   * heartbeat + a position fix have been seen (SITL needs some seconds after boot).
   * @param readyTimeoutMs - How long to wait for heartbeat + fix before failing.
   */
  async connect(readyTimeoutMs = 60_000): Promise<void> {
    const m = /^tcp:\/\/([^:]+):(\d+)$/.exec(this.url.trim());
    if (!m) throw new DroneCommandError(`DRONE_MAVLINK_URL must look like tcp://host:port (got "${this.url}")`);
    const [, host, port] = m;
    this.disconnect();
    this.inboundSigningTimestamps.clear();
    this.targetSystemLocked = false;
    this.streamsRequested = false;
    this.haveFix = false;
    this.lastAuthRejectionLogMs = 0;
    this.suppressedAuthRejections = 0;
    const socket = net.connect({ host, port: Number(port) });
    this.socket = socket;
    const splitter = new BoundedMavLinkPacketSplitter();
    const reader = socket.pipe(splitter).pipe(new MavLinkPacketParser());
    reader.on('data', (packet: MavLinkPacket) => this.onPacket(packet));
    const rejectMalformedStream = (err: Error) => {
      logger.warn({ error: err.message }, 'Rejected malformed MAVLink stream');
      socket.destroy();
    };
    splitter.on('error', rejectMalformedStream);
    reader.on('error', rejectMalformedStream);
    socket.on('error', (err) => {
      if (this.socket === socket) this.connected = false;
      logger.error({ err: err.message }, 'MAVLink socket error');
    });
    socket.on('close', () => this.onSocketClosed(socket));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', (err) => reject(new DroneCommandError(`cannot reach flight controller at ${this.url}: ${err.message}`)));
    });
    this.ticker = setInterval(() => { void this.tick(); }, TICK_MS);
    const deadline = Date.now() + readyTimeoutMs;
    while (!(this.connected && this.haveFix)) {
      if (Date.now() > deadline) {
        this.disconnect();
        throw new DroneCommandError('flight controller link up but no authenticated heartbeat/position fix arrived in time');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.logEvent('info', `MAVLink link established (${this.url}, sys ${this.targetSystem})`);
  }

  /** @description Stop the tick loop and close the link. */
  disconnect(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.rejectPendingCommands();
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  private onSocketClosed(socket: net.Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.connected = false;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.rejectPendingCommands();
    logger.warn('MAVLink socket closed');
  }

  private rejectPendingCommands(): void {
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.resolve(-1);
    }
    this.pendingAcks.clear();
  }

  private onPacket(packet: MavLinkPacket): void {
    const rejection = this.packetAuthenticationRejection(packet);
    if (rejection) {
      this.logPacketAuthenticationRejection(packet, rejection);
      return;
    }
    const registry = {
      ...minimal.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY,
    } as Record<number, Parameters<MavLinkPacket['protocol']['data']>[1] | undefined>;
    const clazz = registry[packet.header.msgid];
    if (!clazz) return;
    const data = packet.protocol.data(packet.payload, clazz) as never;
    switch (packet.header.msgid) {
      case minimal.Heartbeat.MSG_ID: this.onHeartbeat(packet, data); break;
      case common.GlobalPositionInt.MSG_ID: this.onPosition(data); break;
      case common.SysStatus.MSG_ID: this.onSysStatus(data); break;
      case common.HomePosition.MSG_ID: this.onHomePosition(data); break;
      case common.CommandAck.MSG_ID: this.onCommandAck(data); break;
      case common.StatusText.MSG_ID: this.onStatusText(data); break;
      default: break;
    }
  }

  private onHeartbeat(packet: MavLinkPacket, hb: InstanceType<typeof minimal.Heartbeat>): void {
    if (packet.header.compid !== 1) return; // autopilot component only
    if (!this.targetSystemLocked) this.targetSystemLocked = true;
    this.targetSystem = packet.header.sysid;
    this.targetComponent = packet.header.compid;
    this.connected = true;
    const wasArmed = this.armed;
    this.armed = (Number(hb.baseMode) & MODE_FLAG_ARMED) !== 0;
    this.customMode = Number(hb.customMode);
    if (wasArmed && !this.armed) {
      this.op = { kind: 'none' };
      this.logEvent('info', 'Vehicle disarmed');
    }
  }

  private onPosition(p: { lat: number; lon: number; relativeAlt: number; hdg: number; vx: number; vy: number }): void {
    this.pos = { lat: p.lat / 1e7, lon: p.lon / 1e7, alt: p.relativeAlt / 1000 };
    if (p.hdg !== 65535) this.headingDeg = p.hdg / 100;
    this.groundSpeedMps = Math.hypot(p.vx, p.vy) / 100;
    if (!this.haveFix && (p.lat !== 0 || p.lon !== 0)) {
      this.haveFix = true;
      if (!this.homePos) this.homePos = { lat: this.pos.lat, lon: this.pos.lon, alt: 0 };
    }
  }

  private onSysStatus(s: { batteryRemaining: number }): void {
    if (s.batteryRemaining >= 0) this.batteryPct = s.batteryRemaining;
  }

  private onHomePosition(h: { latitude: number; longitude: number }): void {
    this.homePos = { lat: h.latitude / 1e7, lon: h.longitude / 1e7, alt: 0 };
  }

  private onCommandAck(ack: { command: number; result: number }): void {
    const pending = this.pendingAcks.get(Number(ack.command));
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingAcks.delete(Number(ack.command));
      pending.resolve(Number(ack.result));
    }
  }

  private onStatusText(st: { severity: number; text: string }): void {
    const sev = Number(st.severity);
    const level = sev <= 3 ? 'alert' : sev === 4 ? 'warn' : 'info';
    if (sev <= 5) this.logEvent(level, `FC: ${String(st.text).replace(/\0+$/, '')}`);
  }

  private packetAuthenticationRejection(packet: MavLinkPacket): string | null {
    const signature = packet.signature;
    if (!signature) return 'unsigned';
    const expected = Buffer.from(signature.calculate(this.signingKey), 'hex');
    const supplied = Buffer.from(signature.signature, 'hex');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return 'invalid-signature';
    if (packet.header.compid !== 1) return 'non-autopilot-component';
    if (!this.targetSystemLocked && packet.header.msgid !== minimal.Heartbeat.MSG_ID) {
      return 'heartbeat-required-before-telemetry';
    }
    if (this.targetSystemLocked && packet.header.sysid !== this.targetSystem) return 'cross-system';
    const replayKey = `${packet.header.sysid}:${packet.header.compid}:${signature.linkId}`;
    const prior = this.inboundSigningTimestamps.get(replayKey);
    if (prior !== undefined && signature.timestamp <= prior) return 'replayed-timestamp';
    this.inboundSigningTimestamps.set(replayKey, signature.timestamp);
    return null;
  }

  private logPacketAuthenticationRejection(packet: MavLinkPacket, reason: string): void {
    const now = Date.now();
    if (now - this.lastAuthRejectionLogMs < AUTH_REJECTION_LOG_INTERVAL_MS) {
      this.suppressedAuthRejections += 1;
      return;
    }
    logger.warn({
      droneId: this.droneId,
      reason,
      sysid: packet.header.sysid,
      compid: packet.header.compid,
      msgid: packet.header.msgid,
      suppressed: this.suppressedAuthRejections,
    }, 'Rejected unauthenticated MAVLink packet');
    this.lastAuthRejectionLogMs = now;
    this.suppressedAuthRejections = 0;
  }

  // ── Control tick (GCS heartbeat, stream request, mission loop) ─────────────

  private async tick(): Promise<void> {
    try {
      await this.sendGcsHeartbeat();
      if (this.connected && !this.streamsRequested) await this.requestStreams();
      if (this.op.kind === 'takeoff' && this.pos.alt >= this.op.altM - ARRIVAL_ALT_M) {
        this.op = { kind: 'none' };
        this.logEvent('info', `Takeoff complete — holding at ${Math.round(this.pos.alt)}m`);
      } else if (this.op.kind === 'goto' && this.arrived(this.op.target)) {
        this.op = { kind: 'none' };
        this.logEvent('info', 'Arrived — holding position');
      } else if (this.op.kind === 'mission') {
        await this.tickMission(this.op);
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'MAVLink tick failed');
    }
  }

  private async tickMission(op: Extract<Op, { kind: 'mission' }>): Promise<void> {
    const wp = op.plan.waypoints[op.index];
    if (!wp) { await this.finishMission(op.plan); return; }
    if (op.holdUntilMs !== null) {
      if (Date.now() < op.holdUntilMs) return;
      op.holdUntilMs = null;
      op.index += 1;
      op.setpointSent = false;
      if (op.index >= op.plan.waypoints.length) { await this.finishMission(op.plan); return; }
      return;
    }
    if (!op.setpointSent) {
      await this.sendSetpoint(op.plan.waypoints[op.index]);
      op.setpointSent = true;
      return;
    }
    if (this.arrived(op.plan.waypoints[op.index])) {
      this.logEvent('info', `Reached waypoint ${op.index + 1}/${op.plan.waypoints.length}`);
      const hold = op.plan.waypoints[op.index].holdSeconds;
      if (hold && hold > 0) { op.holdUntilMs = Date.now() + hold * 1000; return; }
      op.index += 1;
      op.setpointSent = false;
      if (op.index >= op.plan.waypoints.length) await this.finishMission(op.plan);
    }
  }

  private async finishMission(plan: MissionPlan): Promise<void> {
    this.logEvent('info', `Mission "${plan.name}" complete`);
    if (plan.rtlAfterMission) {
      this.op = { kind: 'none' };
      await this.setMode(MODE_RTL, 'Mission complete — returning to launch');
    } else {
      this.op = { kind: 'none' };
      this.logEvent('info', 'Holding at final waypoint');
    }
  }

  private arrived(target: GeoPoint): boolean {
    return haversineM(this.pos, target) <= ARRIVAL_RADIUS_M && Math.abs(this.pos.alt - target.alt) <= ARRIVAL_ALT_M;
  }

  // ── DroneProvider commands ─────────────────────────────────────────────────

  async arm(): Promise<void> {
    this.requireLink();
    if (this.armed) throw new DroneCommandError('already armed');
    await this.setMode(MODE_GUIDED, null);
    await this.commandLong(CMD_ARM_DISARM, [1], 'arm rejected by flight controller');
    this.logEvent('info', 'Armed — motors live');
  }

  async disarm(): Promise<void> {
    this.requireLink();
    if (!this.armed) throw new DroneCommandError('not armed');
    if (this.pos.alt > 1) throw new DroneCommandError('cannot disarm mid-air — land first');
    await this.commandLong(CMD_ARM_DISARM, [0], 'disarm rejected by flight controller');
    this.logEvent('info', 'Disarmed');
  }

  async takeoff(altM: number): Promise<void> {
    this.requireLink();
    if (!this.armed) throw new DroneCommandError('cannot take off — arm first');
    await this.setMode(MODE_GUIDED, null);
    await this.commandLong(CMD_NAV_TAKEOFF, [0, 0, 0, 0, 0, 0, altM], 'takeoff rejected by flight controller');
    this.op = { kind: 'takeoff', altM };
    this.logEvent('info', `Taking off to ${altM}m`);
  }

  async gotoPoint(pt: GeoPoint, _speedMps: number): Promise<void> {
    this.requireLink();
    if (!this.armed || this.pos.alt < 1) throw new DroneCommandError('cannot fly to a point — take off first');
    await this.setMode(MODE_GUIDED, null);
    await this.sendSetpoint(pt);
    this.op = { kind: 'goto', target: pt };
    this.logEvent('info', `Enroute to ${pt.lat.toFixed(6)}, ${pt.lon.toFixed(6)} at ${pt.alt}m`);
  }

  async startMission(plan: MissionPlan): Promise<void> {
    this.requireLink();
    if (!this.armed) throw new DroneCommandError('cannot start a mission — arm first');
    const copy: MissionPlan = { ...plan, waypoints: plan.waypoints.map((w) => ({ ...w })) };
    await this.setMode(MODE_GUIDED, null);
    if (this.pos.alt < 1) {
      await this.commandLong(CMD_NAV_TAKEOFF, [0, 0, 0, 0, 0, 0, copy.waypoints[0].alt], 'takeoff rejected by flight controller');
      this.logEvent('info', `Mission "${copy.name}" accepted — taking off to ${copy.waypoints[0].alt}m`);
    } else {
      this.logEvent('info', `Mission "${copy.name}" started (${copy.waypoints.length} waypoints)`);
    }
    this.op = { kind: 'mission', plan: copy, index: 0, holdUntilMs: null, setpointSent: false };
  }

  async abortMission(): Promise<void> {
    this.requireLink();
    if (this.op.kind !== 'mission') throw new DroneCommandError('no mission is running');
    const name = this.op.plan.name;
    this.op = { kind: 'none' };
    await this.sendSetpoint({ ...this.pos }); // hold where we are, still GUIDED
    this.logEvent('warn', `Mission "${name}" aborted — holding position`);
  }

  async land(): Promise<void> {
    this.requireLink();
    this.op = { kind: 'none' };
    await this.setMode(MODE_LAND, 'Landing at current position');
  }

  async returnToLaunch(): Promise<void> {
    this.requireLink();
    this.op = { kind: 'none' };
    await this.setMode(MODE_RTL, 'Returning to launch');
  }

  async replaceBattery(): Promise<void> {
    throw new DroneCommandError('battery swap is a physical action on a real vehicle');
  }

  async setHeading(deg: number): Promise<void> {
    this.requireLink();
    if (!this.armed) throw new DroneCommandError('cannot rotate while disarmed');
    const target = ((deg % 360) + 360) % 360;
    // param2 = slew rate (deg/s), param3 = 0 (shortest turn direction), param4 = 0 (absolute angle).
    await this.commandLong(CMD_CONDITION_YAW, [target, YAW_RATE_DPS, 0, 0], `yaw to ${Math.round(target)}° rejected`);
    this.logEvent('info', `Rotated to ${Math.round(target)}° (CONDITION_YAW)`);
  }

  async setLed(_color: string): Promise<void> {
    throw new DroneCommandError('LED payload control needs a device driver at the node — not built for MAVLink yet');
  }

  async setCamera(_action: CameraAction): Promise<void> {
    throw new DroneCommandError('camera control over MAVLink (DO_DIGICAM_CONTROL / gimbal manager) is not built yet — see BACKLOG');
  }

  getCaptures(_sinceSeq: number): CameraCapture[] {
    return [];
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  getTelemetry(): DroneTelemetry {
    return {
      droneId: this.droneId,
      status: this.deriveStatus(),
      position: { lat: this.pos.lat, lon: this.pos.lon, alt: Math.round(this.pos.alt * 10) / 10 },
      home: { ...this.home },
      headingDeg: Math.round(this.headingDeg),
      groundSpeedMps: Math.round(this.groundSpeedMps * 10) / 10,
      batteryPct: this.batteryPct,
      distanceFromHomeM: Math.round(haversineM(this.pos, this.home) * 10) / 10,
      mission: this.op.kind === 'mission'
        ? { index: this.op.index, total: this.op.plan.waypoints.length, name: this.op.plan.name }
        : null,
      failsafe: null, // the autopilot owns hardware failsafes; its STATUSTEXTs land in events
    };
  }

  getEvents(sinceSeq: number): DroneEvent[] {
    return this.events.filter((e) => e.seq > sinceSeq);
  }

  private deriveStatus(): DroneFlightStatus {
    if (!this.armed) return 'disarmed';
    if (this.customMode === MODE_RTL) return 'returning';
    if (this.customMode === MODE_LAND) return 'landing';
    if (this.op.kind === 'takeoff') return 'takeoff';
    if (this.op.kind === 'mission') return 'mission';
    if (this.op.kind === 'goto') return 'enroute';
    return this.pos.alt < 0.5 ? 'armed' : 'hold';
  }

  // ── MAVLink send helpers ───────────────────────────────────────────────────

  private requireLink(): void {
    if (!this.socket || !this.connected) throw new DroneCommandError('no MAVLink link to the flight controller');
  }

  private async sendMsg(msg: MavLinkData): Promise<void> {
    if (!this.socket) throw new DroneCommandError('MAVLink socket not open');
    const timestamp = Math.max(Date.now(), this.lastOutboundSigningTimestamp + 1);
    this.lastOutboundSigningTimestamp = timestamp;
    await mavSendSigned(this.socket, msg as never, this.signingKey, this.signingLinkId, 255, 190, timestamp);
  }

  private async sendGcsHeartbeat(): Promise<void> {
    const hb = new minimal.Heartbeat();
    hb.type = 6;       // MAV_TYPE_GCS
    hb.autopilot = 8;  // MAV_AUTOPILOT_INVALID (we are not an autopilot)
    hb.systemStatus = 4;
    hb.mavlinkVersion = 3;
    await this.sendMsg(hb);
  }

  private async requestStreams(): Promise<void> {
    const req = new common.RequestDataStream();
    req.targetSystem = this.targetSystem;
    req.targetComponent = this.targetComponent;
    req.reqStreamId = 0; // MAV_DATA_STREAM_ALL
    req.reqMessageRate = 4;
    req.startStop = 1;
    await this.sendMsg(req);
    this.streamsRequested = true;
  }

  /** Send COMMAND_LONG and await the matching COMMAND_ACK; non-zero results reject. */
  private async commandLong(command: number, params: number[], rejectionMessage: string): Promise<void> {
    if (this.pendingAcks.has(command)) {
      throw new DroneCommandError(`MAVLink command ${command} is already awaiting acknowledgement`);
    }
    const msg = new common.CommandLong();
    msg.targetSystem = this.targetSystem;
    msg.targetComponent = this.targetComponent;
    msg.command = command as never;
    msg.confirmation = 0;
    // The mapping classes expose params as _param1.._param7 (getter aliases vary by codegen
    // version) — write the underscore fields directly, which always exist.
    const m = msg as unknown as Record<string, number>;
    for (let i = 0; i < 7; i += 1) m[`_param${i + 1}`] = params[i] ?? 0;
    const ack = new Promise<number>((resolve) => {
      const timer = setTimeout(() => { this.pendingAcks.delete(command); resolve(-1); }, ACK_TIMEOUT_MS);
      this.pendingAcks.set(command, { resolve, timer });
    });
    try {
      await this.sendMsg(msg);
    } catch (error) {
      const pending = this.pendingAcks.get(command);
      if (pending) clearTimeout(pending.timer);
      this.pendingAcks.delete(command);
      throw error;
    }
    const result = await ack;
    if (result !== 0) {
      throw new DroneCommandError(`${rejectionMessage} (MAV_RESULT ${result === -1 ? 'timeout' : result})`);
    }
  }

  private async setMode(customMode: number, eventMessage: string | null): Promise<void> {
    if (this.customMode !== customMode) {
      await this.commandLong(CMD_SET_MODE, [MODE_FLAG_CUSTOM, customMode], `mode change to ${customMode} rejected`);
    }
    if (eventMessage) this.logEvent('info', eventMessage);
  }

  private async sendSetpoint(pt: GeoPoint): Promise<void> {
    const sp = new common.SetPositionTargetGlobalInt();
    sp.timeBootMs = 0;
    sp.targetSystem = this.targetSystem;
    sp.targetComponent = this.targetComponent;
    sp.coordinateFrame = FRAME_GLOBAL_RELATIVE_ALT_INT as never;
    sp.typeMask = POSITION_ONLY_MASK as never;
    sp.latInt = Math.round(pt.lat * 1e7);
    sp.lonInt = Math.round(pt.lon * 1e7);
    sp.alt = pt.alt;
    sp.vx = 0; sp.vy = 0; sp.vz = 0; sp.afx = 0; sp.afy = 0; sp.afz = 0; sp.yaw = 0; sp.yawRate = 0;
    await this.sendMsg(sp);
  }

  private logEvent(level: DroneEvent['level'], message: string): void {
    this.seq += 1;
    this.events.push({ seq: this.seq, ts: Date.now(), level, message });
    if (this.events.length > EVENT_RETENTION) this.events.splice(0, this.events.length - EVENT_RETENTION);
    logger.info({ droneId: this.droneId, level, message }, 'drone event');
  }
}
