/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Camera equipment over the wire: setCamera
 *                     |                             | command case, camera arrival action survives the gotoPoint
 *                     |                             | hop (the 76b01f20 LED lesson applied on day one), and
 *                     |                             | recent capture records ride every heartbeat.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | LINK-LOSS FAILSAFE (decided ON the
 *                     |                             | vehicle): airborne + no successful heartbeat ack for
 *                     |                             | DRONE_LINK_FAILSAFE_S (default 20s, 0 disables) → self-RTL
 *                     |                             | once, re-armed when the link returns. Plus DRONE_VIDEO_URL:
 *                     |                             | a node with camera hardware declares its feed endpoint in
 *                     |                             | the heartbeat; the surface renders it. Never synthesized.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the drone-node runtime
 *                     |                             | (ADR-099): the companion process that turns one vehicle
 *                     |                             | into a swarm node. Embeds a DroneProvider (sim today,
 *                     |                             | MAVLink next — see BACKLOG), pushes authenticated
 *                     |                             | heartbeats (telemetry + events) to the controller, and
 *                     |                             | executes secret-guarded command envelopes. A device node:
 *                     |                             | no LLM, no vendor keys, never originates flight.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Require an exact MAVLink 2 signing key for hardware mode
 *                     |                             | and reuse the shared constant-time service-secret gate for
 *                     |                             | command envelopes instead of a local string comparison.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L6: the node posts its position to the core
 *                     |                             | device ingest under its own LOCATION CREDENTIAL, never the
 *                     |                             | service secret (which the location routes refuse). A group
 *                     |                             | admin issues the credential from Settings, Location and sets
 *                     |                             | OSHAL_LOCATION_DEVICE_ID + OSHAL_LOCATION_TOKEN on the node
 *                     |                             | (both or neither; a half pair refuses to start). Every
 *                     |                             | DRONE_LOCATION_INTERVAL_S (default 10, 0 off) the current
 *                     |                             | telemetry point goes to POST /api/location/devices/<id>/
 *                     |                             | presence as a Bearer, flagged mock for the sim engine so a
 *                     |                             | simulated fix is never evidence. The heartbeat is unchanged.
 *                     |                             | No position is ever logged.
 *
 * Run one per drone (host, Pi, or ground station):
 *   SWARM_SERVICE_SECRET=<secret> DRONE_NODE_ID=drone-1 OSHAL_API_URL=http://localhost:35457 \
 *     npm run drone:node
 * To report position (ADR-169), add the credential a group admin issued in Settings, Location:
 *   OSHAL_LOCATION_DEVICE_ID=<location device id> OSHAL_LOCATION_TOKEN=oshal_pat_...
 * ALWAYS set DRONE_NODE_ENDPOINT to an address the CONTROLLER can dial back:
 *   - controller in Docker, node on the host → http://host.docker.internal:<port>
 *   - same host, both native → http://127.0.0.1:<port>  (use the literal IP — on Windows,
 *     "localhost" can resolve to ::1 and hang the controller's dial; live-proven 2026-07-17)
 *   - node on another box → http://<its-LAN/tailnet-IP>:<port>
 */

import express, { type Request, type Response } from 'express';
import * as os from 'os';
import { createChildLogger } from '@/shared/logger';
import { installProcessCrashGuards } from '@/shared/services/process-crash-guards';
import { requireServiceSecret, serviceSecretHeaders } from '@/shared/middleware/authz';
import {
  SimDroneProvider,
  MavlinkDroneProvider,
  normalizeMissionDraft,
  normalizeCameraAction,
  DroneCommandError,
  type DroneProvider,
  type MissionWaypoint,
} from '@/features/drone';

const logger = createChildLogger({ module: 'drone-node' });

const HEARTBEAT_INTERVAL_MS = 2_000;
/** Default interval between position posts to the location ingest (its server minimum is 5 s). */
const LOCATION_INTERVAL_S_DEFAULT = 10;

/** The location credential a group admin issued for this vehicle (ADR-169 L6). */
interface LocationCredentialConfig {
  deviceId: string;
  token: string;
  intervalMs: number;
}

interface NodeConfig {
  droneId: string;
  port: number;
  endpointUrl: string;
  apiUrl: string;
  home: { lat: number; lon: number };
  engine: 'sim' | 'mavlink';
  mavlinkUrl: string;
  mavlinkSigningKey: Buffer | null;
  mavlinkSigningLinkId: number;
  /** Camera-feed URL this node's hardware serves ('' = none — never fabricated). */
  videoUrl: string;
  /** Airborne link-loss self-RTL threshold, seconds (0 disables). */
  linkFailsafeS: number;
  /** Position reporting under the location credential; null when the node has none. */
  location: LocationCredentialConfig | null;
}

/**
 * @description The location credential from the environment: both halves or neither. A half pair
 * is a misconfiguration the operator must see, so the node refuses to start rather than fly
 * silently unreported. DRONE_LOCATION_INTERVAL_S=0 keeps the credential but posts nothing.
 * @returns The credential config, or null when the node does not report position.
 */
function loadLocationConfig(): LocationCredentialConfig | null {
  const deviceId = (process.env.OSHAL_LOCATION_DEVICE_ID || '').trim();
  const token = (process.env.OSHAL_LOCATION_TOKEN || '').trim();
  if (!deviceId && !token) return null;
  if (!deviceId || !token) {
    logger.error('OSHAL_LOCATION_DEVICE_ID and OSHAL_LOCATION_TOKEN go together — set both (from Settings, Location) or neither');
    process.exit(1);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
    logger.error('OSHAL_LOCATION_DEVICE_ID must be the location device id Settings, Location issued the credential for');
    process.exit(1);
  }
  const rawInterval = Number(process.env.DRONE_LOCATION_INTERVAL_S);
  const intervalS = Number.isFinite(rawInterval) ? Math.max(0, rawInterval) : LOCATION_INTERVAL_S_DEFAULT;
  if (intervalS === 0) logger.warn('DRONE_LOCATION_INTERVAL_S=0 — the location credential is set but no position will be posted');
  return { deviceId, token, intervalMs: Math.round(intervalS * 1000) };
}

function loadConfig(): NodeConfig {
  const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
  if (!secret) {
    // Fail closed: an unauthenticated drone node would accept flight commands from anyone
    // who can reach its port. No secret, no node.
    logger.error('SWARM_SERVICE_SECRET is required — refusing to start an unauthenticated drone node');
    process.exit(1);
  }
  const engine = (process.env.DRONE_PROVIDER || 'sim').trim();
  if (engine !== 'sim' && engine !== 'mavlink') {
    logger.error({ engine }, 'DRONE_PROVIDER must be "sim" or "mavlink"');
    process.exit(1);
  }
  const mavlinkUrl = (process.env.DRONE_MAVLINK_URL || '').trim();
  if (engine === 'mavlink' && !mavlinkUrl) {
    logger.error('DRONE_MAVLINK_URL is required for the mavlink engine (e.g. tcp://127.0.0.1:5760)');
    process.exit(1);
  }
  const signingKeyHex = (process.env.DRONE_MAVLINK_SIGNING_KEY || '').trim();
  if (engine === 'mavlink' && !/^[a-fA-F0-9]{64}$/.test(signingKeyHex)) {
    logger.error('DRONE_MAVLINK_SIGNING_KEY must be an exact 64-hex-character MAVLink 2 key');
    process.exit(1);
  }
  const signingLinkId = Number(process.env.DRONE_MAVLINK_SIGNING_LINK_ID || '1');
  if (engine === 'mavlink' && (!Number.isInteger(signingLinkId) || signingLinkId < 0 || signingLinkId > 255)) {
    logger.error('DRONE_MAVLINK_SIGNING_LINK_ID must be an integer from 0 through 255');
    process.exit(1);
  }
  const port = Number(process.env.DRONE_NODE_PORT) || 4100;
  const rawVideo = (process.env.DRONE_VIDEO_URL || '').trim();
  if (rawVideo && !/^https?:\/\/\S{1,300}$/.test(rawVideo)) {
    logger.warn({ rawVideo }, 'DRONE_VIDEO_URL is not a plain http(s) URL — ignoring it');
  }
  const failsafeRaw = Number(process.env.DRONE_LINK_FAILSAFE_S);
  return {
    droneId: (process.env.DRONE_NODE_ID || 'drone-1').trim(),
    port,
    endpointUrl: (process.env.DRONE_NODE_ENDPOINT || `http://${os.hostname()}:${port}`).replace(/\/+$/, ''),
    apiUrl: (process.env.OSHAL_API_URL || 'http://localhost:35457').replace(/\/+$/, ''),
    home: {
      lat: Number(process.env.DRONE_HOME_LAT) || 30.3935,
      lon: Number(process.env.DRONE_HOME_LON) || -86.4958,
    },
    engine: engine as 'sim' | 'mavlink',
    mavlinkUrl,
    mavlinkSigningKey: engine === 'mavlink' ? Buffer.from(signingKeyHex, 'hex') : null,
    mavlinkSigningLinkId: signingLinkId,
    videoUrl: /^https?:\/\/\S{1,300}$/.test(rawVideo) ? rawVideo : '',
    linkFailsafeS: Number.isFinite(failsafeRaw) ? Math.max(0, failsafeRaw) : 20,
    location: loadLocationConfig(),
  };
}

/**
 * @description Execute one controller command envelope against the local provider. The
 * controller already ran geofence validation (ADR-099 keeps the gate controller-side);
 * the node still normalizes mission payloads defensively before the engine sees them.
 */
async function runCommand(provider: DroneProvider, command: string, args: Record<string, unknown>): Promise<void> {
  switch (command) {
    case 'arm': return provider.arm();
    case 'disarm': return provider.disarm();
    case 'takeoff': return provider.takeoff(Number(args.altM));
    case 'gotoPoint': {
      const pt = (args.pt || {}) as Record<string, unknown>;
      // Arrival actions (headingDeg/led/camera) MUST survive this hop — stripping them here
      // made remote drones silently ignore cue equipment triggers (caught live 2026-07-18).
      const target: MissionWaypoint = { lat: Number(pt.lat), lon: Number(pt.lon), alt: Number(pt.alt) };
      if (pt.headingDeg !== undefined) target.headingDeg = Number(pt.headingDeg);
      if (typeof pt.led === 'string') target.led = pt.led;
      if (pt.camera !== undefined) {
        const { action } = normalizeCameraAction(pt.camera);
        if (action) target.camera = action;
      }
      return provider.gotoPoint(target, Number(args.speedMps) || 8);
    }
    case 'startMission': {
      const { plan, errors } = normalizeMissionDraft(args.plan);
      if (!plan) throw new DroneCommandError(`malformed mission payload: ${errors.join('; ')}`);
      return provider.startMission(plan);
    }
    case 'abortMission': return provider.abortMission();
    case 'land': return provider.land();
    case 'returnToLaunch': return provider.returnToLaunch();
    case 'replaceBattery': return provider.replaceBattery();
    case 'setHeading': return provider.setHeading(Number(args.deg));
    case 'setLed': return provider.setLed(String(args.color || ''));
    case 'setCamera': {
      const { action, errors } = normalizeCameraAction(args.action);
      if (!action) throw new DroneCommandError(`malformed camera action: ${errors.join('; ')}`);
      return provider.setCamera(action);
    }
    default: throw new DroneCommandError(`unknown command "${command}"`);
  }
}

/** Link health shared between the heartbeat loop and the link-loss failsafe watchdog. */
interface LinkState {
  lastOkMs: number;
  failsafeFired: boolean;
}

/** One heartbeat: telemetry + events since the controller's ack, over the secret rail. */
async function sendHeartbeat(cfg: NodeConfig, provider: DroneProvider, lastAck: { seq: number }, link: LinkState): Promise<void> {
  try {
    const res = await fetch(`${cfg.apiUrl}/api/drone/nodes/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
      body: JSON.stringify({
        droneId: cfg.droneId,
        endpointUrl: cfg.endpointUrl,
        engine: cfg.engine,
        telemetry: provider.getTelemetry(),
        events: provider.getEvents(lastAck.seq),
        captures: provider.getCaptures(0).slice(-25),
        ...(cfg.videoUrl ? { videoUrl: cfg.videoUrl } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { ack?: number; error?: string };
    if (!res.ok) {
      logger.warn({ status: res.status, error: body.error }, 'Heartbeat rejected by controller');
      return;
    }
    if (typeof body.ack === 'number') lastAck.seq = body.ack;
    link.lastOkMs = Date.now();
    if (link.failsafeFired) {
      link.failsafeFired = false;
      logger.info('Controller link restored — link-loss failsafe re-armed');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Heartbeat failed (controller unreachable) — retrying next tick');
  }
}

/**
 * @description One position post to the core device ingest (ADR-169 L6), as a Bearer under the
 * node's own location credential and never with the service secret. The body carries the
 * current telemetry point, the observation time and, for the sim engine, the mock flag; the
 * device is named by the path only, because the ingest derives the identity from the credential.
 * A refusal is logged by status and code, never with the position.
 * @param cfg - Node config with a location credential.
 * @param provider - The engine whose telemetry is reported.
 * @returns Resolves after the attempt; never rejects.
 */
async function sendLocationFix(cfg: NodeConfig, provider: DroneProvider): Promise<void> {
  const loc = cfg.location;
  if (!loc) return;
  let point: { lat: number; lon: number; alt: number };
  try {
    point = provider.getTelemetry().position;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Location fix skipped — no telemetry from the engine');
    return;
  }
  try {
    const res = await fetch(`${cfg.apiUrl}/api/location/devices/${encodeURIComponent(loc.deviceId)}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loc.token}` },
      body: JSON.stringify({
        lat: point.lat, lon: point.lon, altM: point.alt,
        observedAt: new Date().toISOString(),
        mock: cfg.engine === 'sim',
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      logger.warn({ status: res.status, error: body.error }, 'Location fix rejected by the controller');
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Location fix failed (controller unreachable) — retrying next interval');
  }
}

/**
 * @description The vehicle-side link-loss failsafe: airborne with no successful heartbeat
 * for the configured window → return to launch, decided HERE so a dead controller (or dead
 * network) can never strand a flying drone. Fires once per outage; re-arms on link restore.
 * Skipped while already returning/landing/on the ground.
 */
function checkLinkFailsafe(cfg: NodeConfig, provider: DroneProvider, link: LinkState): void {
  const silentS = (Date.now() - link.lastOkMs) / 1000;
  if (silentS < cfg.linkFailsafeS || link.failsafeFired) return;
  let status: string;
  try { status = provider.getTelemetry().status; } catch { return; }
  if (!['takeoff', 'hold', 'enroute', 'mission'].includes(status)) return;
  link.failsafeFired = true;
  logger.error({ silentS: Math.round(silentS), status }, 'LINK-LOSS FAILSAFE — controller unreachable while airborne; returning to launch');
  provider.returnToLaunch().catch((err) => logger.error({ err }, 'link-loss RTL rejected by the engine'));
}

async function main(): Promise<void> {
  installProcessCrashGuards('drone-node');
  const cfg = loadConfig();
  let provider: DroneProvider;
  if (cfg.engine === 'mavlink') {
    if (!cfg.mavlinkSigningKey) throw new DroneCommandError('MAVLink signing key unavailable after configuration validation');
    const mav = new MavlinkDroneProvider({
      droneId: cfg.droneId,
      url: cfg.mavlinkUrl,
      signingKey: cfg.mavlinkSigningKey,
      signingLinkId: cfg.mavlinkSigningLinkId,
    });
    logger.info({ url: cfg.mavlinkUrl }, 'Connecting to flight controller (waiting for heartbeat + position fix)…');
    await mav.connect();
    provider = mav;
  } else {
    provider = new SimDroneProvider({ droneId: cfg.droneId, home: cfg.home });
  }
  const lastAck = { seq: 0 };

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, droneId: cfg.droneId, engine: cfg.engine });
  });

  app.post('/api/drone-node/command', requireServiceSecret, async (req: Request, res: Response) => {
    const command = String(req.body?.command || '');
    const args = (req.body?.args || {}) as Record<string, unknown>;
    const started = Date.now();
    try {
      await runCommand(provider, command, args);
      logger.info({ command, durationMs: Date.now() - started }, 'Command executed');
      res.json({ ok: true, telemetry: provider.getTelemetry() });
    } catch (err: any) {
      if (err instanceof DroneCommandError) {
        logger.warn({ command, error: err.message }, 'Command rejected');
        res.status(409).json({ error: err.message });
        return;
      }
      logger.error({ err, command }, 'Command failed');
      res.status(500).json({ error: err.message || 'internal error' });
    }
  });

  app.listen(cfg.port, () => {
    logger.info(
      { droneId: cfg.droneId, port: cfg.port, endpointUrl: cfg.endpointUrl, apiUrl: cfg.apiUrl, engine: cfg.engine,
        linkFailsafeS: cfg.linkFailsafeS, videoUrl: cfg.videoUrl || null,
        locationDeviceId: cfg.location?.deviceId ?? null, locationIntervalMs: cfg.location?.intervalMs ?? null },
      'Drone node up — heartbeating into the swarm',
    );
  });
  const link: LinkState = { lastOkMs: Date.now(), failsafeFired: false };
  setInterval(() => { void sendHeartbeat(cfg, provider, lastAck, link); }, HEARTBEAT_INTERVAL_MS);
  if (cfg.linkFailsafeS > 0) setInterval(() => checkLinkFailsafe(cfg, provider, link), 5_000);
  if (cfg.location && cfg.location.intervalMs > 0) {
    setInterval(() => { void sendLocationFix(cfg, provider); }, cfg.location.intervalMs);
    void sendLocationFix(cfg, provider);
  }
  void sendHeartbeat(cfg, provider, lastAck, link);
}

main().catch((err) => {
  logger.error({ err }, 'Drone node failed to start');
  process.exit(1);
});
