/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the camera-node runtime:
 *                     |                             | the companion process that turns one physical camera into a
 *                     |                             | swarm node. Embeds a CameraProvider (sim, or the real GoPro
 *                     |                             | Open GoPro HTTP adapter), pushes authenticated heartbeats
 *                     |                             | (telemetry + events + captures + an optional browser-playable
 *                     |                             | videoUrl) to the controller, and executes secret-guarded
 *                     |                             | command envelopes. A device node: no LLM, no vendor keys.
 *                     |                             | Runs ON the host that shares the camera's WiFi/USB link (a
 *                     |                             | container can't reach a GoPro); bundles into the remote-node
 *                     |                             | package. BLE (enable-AP / COHN provisioning) is a follow-up.
 *
 * Run one per camera (host, Pi, or laptop on the camera's network):
 *   SWARM_SERVICE_SECRET=<secret> CAMERA_NODE_ID=gopro-1 OSHAL_API_URL=http://localhost:35457 \
 *     CAMERA_PROVIDER=gopro CAMERA_GOPRO_LINK=usb CAMERA_GOPRO_SERIAL=<serial> npm run camera:node
 * ALWAYS set CAMERA_NODE_ENDPOINT to an address the CONTROLLER can dial back:
 *   - controller in Docker, node on the host → http://host.docker.internal:<port>
 *   - same host, both native → http://127.0.0.1:<port>  (use the literal IP — on Windows,
 *     "localhost" can resolve to ::1 and hang the controller's dial; live-proven 2026-07-17)
 *   - node on another box → http://<its-LAN/tailnet-IP>:<port>
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import * as os from 'os';
import { createChildLogger } from '@/shared/logger';
import { installProcessCrashGuards } from '@/shared/services/process-crash-guards';
import { serviceSecretHeaders } from '@/shared/middleware/authz';
import {
  SimCameraProvider,
  GoProCameraProvider,
  goproUsbBaseUrl,
  normalizeCameraCommand,
  CameraCommandError,
  type CameraProvider,
  type CameraLink,
} from '@/features/camera';

const logger = createChildLogger({ module: 'camera-node' });

const HEARTBEAT_INTERVAL_MS = 2_000;

interface NodeConfig {
  cameraId: string;
  port: number;
  endpointUrl: string;
  apiUrl: string;
  engine: 'sim' | 'gopro';
  /** Browser-playable feed URL this node serves (e.g. transcoded HLS/MJPEG); '' = none. */
  videoUrl: string;
  gopro: { link: CameraLink; baseUrl: string; auth?: { username: string; password: string }; model?: string };
}

/** Resolve the GoPro base URL from the link mode + env (explicit URL, or derived from the serial). */
function resolveGoproBaseUrl(link: CameraLink): string {
  const explicit = (process.env.CAMERA_GOPRO_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  if (link === 'ap' || link === 'ble') return 'http://10.5.5.9:8080';
  if (link === 'usb') {
    const serial = (process.env.CAMERA_GOPRO_SERIAL || '').trim();
    if (!serial) {
      logger.error('CAMERA_GOPRO_LINK=usb needs CAMERA_GOPRO_SERIAL (to derive 172.2X.1YZ.51) or an explicit CAMERA_GOPRO_BASE_URL');
      process.exit(1);
    }
    return goproUsbBaseUrl(serial);
  }
  logger.error('CAMERA_GOPRO_LINK=cohn needs an explicit CAMERA_GOPRO_BASE_URL (https://<lan-ip>)');
  process.exit(1);
}

function loadConfig(): NodeConfig {
  if (!(process.env.SWARM_SERVICE_SECRET || '').trim()) {
    // Fail closed: an unauthenticated camera node would accept commands from anyone reaching its port.
    logger.error('SWARM_SERVICE_SECRET is required — refusing to start an unauthenticated camera node');
    process.exit(1);
  }
  const engine = (process.env.CAMERA_PROVIDER || 'sim').trim();
  if (engine !== 'sim' && engine !== 'gopro') {
    logger.error({ engine }, 'CAMERA_PROVIDER must be "sim" or "gopro"');
    process.exit(1);
  }
  const port = Number(process.env.CAMERA_NODE_PORT) || 4200;
  const rawVideo = (process.env.CAMERA_VIDEO_URL || '').trim();
  if (rawVideo && !/^https?:\/\/\S{1,300}$/.test(rawVideo)) logger.warn({ rawVideo }, 'CAMERA_VIDEO_URL is not a plain http(s) URL — ignoring it');
  const link = ((process.env.CAMERA_GOPRO_LINK || 'usb').trim() as CameraLink);
  const user = (process.env.CAMERA_GOPRO_USER || '').trim();
  const pass = (process.env.CAMERA_GOPRO_PASS || '').trim();
  return {
    cameraId: (process.env.CAMERA_NODE_ID || 'gopro-1').trim(),
    port,
    endpointUrl: (process.env.CAMERA_NODE_ENDPOINT || `http://${os.hostname()}:${port}`).replace(/\/+$/, ''),
    apiUrl: (process.env.OSHAL_API_URL || 'http://localhost:35457').replace(/\/+$/, ''),
    engine: engine as 'sim' | 'gopro',
    videoUrl: /^https?:\/\/\S{1,300}$/.test(rawVideo) ? rawVideo : '',
    gopro: {
      link,
      baseUrl: engine === 'gopro' ? resolveGoproBaseUrl(link) : '',
      ...(link === 'cohn' && user && pass ? { auth: { username: user, password: pass } } : {}),
      model: (process.env.CAMERA_GOPRO_MODEL || '').trim() || undefined,
    },
  };
}

/** Reject any request not presenting the swarm service secret (constant config at boot). */
function requireSecret(req: Request, res: Response, next: NextFunction): void {
  const provided = String(req.headers['x-service-secret'] || '').trim();
  if (provided && provided === (process.env.SWARM_SERVICE_SECRET || '').trim()) { next(); return; }
  res.status(401).json({ error: 'valid X-Service-Secret required' });
}

/** Execute one controller command envelope against the local provider (normalized defensively). */
async function runCommand(provider: CameraProvider, command: string, args: Record<string, unknown>): Promise<void> {
  const { command: c, errors } = normalizeCameraCommand({ op: command, ...args });
  if (!c) throw new CameraCommandError(`bad command: ${errors.join('; ')}`);
  switch (c.op) {
    case 'connect': return provider.connect();
    case 'disconnect': return provider.disconnect();
    case 'record': return provider.startRecording();
    case 'stop': return provider.stopRecording();
    case 'photo': return provider.capturePhoto();
    case 'setMode': return provider.setMode(c.mode!);
    case 'loadPreset': return provider.loadPreset(c.presetId!);
    case 'setSetting': return provider.setSetting(c.setting!, c.option!);
    case 'startPreview': return provider.startPreview();
    case 'stopPreview': return provider.stopPreview();
    case 'keepAlive': return provider.keepAlive();
    case 'deleteAll': return provider.deleteAll();
    default: throw new CameraCommandError(`unknown command "${command}"`);
  }
}

/** One heartbeat: keep the link alive + refresh state, then push telemetry/events/captures. */
async function sendHeartbeat(cfg: NodeConfig, provider: CameraProvider, lastAck: { seq: number }): Promise<void> {
  try {
    await provider.keepAlive().catch(() => undefined); // gopro: pings + refreshes the state cache
    const res = await fetch(`${cfg.apiUrl}/api/camera/nodes/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
      body: JSON.stringify({
        cameraId: cfg.cameraId,
        endpointUrl: cfg.endpointUrl,
        engine: cfg.engine,
        telemetry: provider.getTelemetry(),
        events: provider.getEvents(lastAck.seq),
        captures: provider.getCaptures(0).slice(-25),
        ...(cfg.videoUrl ? { videoUrl: cfg.videoUrl } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { ack?: number; error?: string };
    if (!res.ok) { logger.warn({ status: res.status, error: body.error }, 'Heartbeat rejected by controller'); return; }
    if (typeof body.ack === 'number') lastAck.seq = body.ack;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Heartbeat failed (controller unreachable) — retrying next tick');
  }
}

async function main(): Promise<void> {
  installProcessCrashGuards('camera-node');
  const cfg = loadConfig();
  let provider: CameraProvider;
  if (cfg.engine === 'gopro') {
    const gp = new GoProCameraProvider({ cameraId: cfg.cameraId, link: cfg.gopro.link, baseUrl: cfg.gopro.baseUrl, auth: cfg.gopro.auth, model: cfg.gopro.model });
    logger.info({ link: cfg.gopro.link, baseUrl: cfg.gopro.baseUrl }, 'Connecting to GoPro…');
    await gp.connect();
    provider = gp;
  } else {
    provider = new SimCameraProvider({ cameraId: cfg.cameraId });
  }
  const lastAck = { seq: 0 };

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req: Request, res: Response) => { res.json({ ok: true, cameraId: cfg.cameraId, engine: cfg.engine }); });
  app.post('/api/camera-node/command', requireSecret, async (req: Request, res: Response) => {
    const command = String(req.body?.command || '');
    const args = (req.body?.args || {}) as Record<string, unknown>;
    const started = Date.now();
    try {
      await runCommand(provider, command, args);
      logger.info({ command, durationMs: Date.now() - started }, 'Command executed');
      res.json({ ok: true, telemetry: provider.getTelemetry() });
    } catch (err: any) {
      if (err instanceof CameraCommandError) { logger.warn({ command, error: err.message }, 'Command rejected'); res.status(409).json({ error: err.message }); return; }
      logger.error({ err, command }, 'Command failed');
      res.status(500).json({ error: err.message || 'internal error' });
    }
  });

  app.listen(cfg.port, () => {
    logger.info({ cameraId: cfg.cameraId, port: cfg.port, endpointUrl: cfg.endpointUrl, apiUrl: cfg.apiUrl, engine: cfg.engine, videoUrl: cfg.videoUrl || null }, 'Camera node up — heartbeating into the swarm');
  });
  setInterval(() => { void sendHeartbeat(cfg, provider, lastAck); }, HEARTBEAT_INTERVAL_MS);
  void sendHeartbeat(cfg, provider, lastAck);
}

main().catch((err) => {
  logger.error({ err }, 'Camera node failed to start');
  process.exit(1);
});
