/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the real GoPro engine
 *                     |                             | behind CameraProvider, driving the official Open GoPro HTTP
 *                     |                             | API (gopro.github.io/OpenGoPro). Three link modes: usb
 *                     |                             | (172.2X.1YZ.51:8080, no Bluetooth), ap (10.5.5.9:8080), and
 *                     |                             | cohn (https + Basic auth, HERO12+). Commands are serialized
 *                     |                             | against the camera's System-Busy/Encoding flags; keepAlive
 *                     |                             | doubles as the state refresh so getTelemetry stays cache-fast.
 *                     |                             | BLE (enable-AP / COHN provisioning) is a node-side follow-up.
 */

import type {
  CameraCapture,
  CameraEvent,
  CameraLink,
  CameraMode,
  CameraSettings,
  CameraStatus,
  CameraTelemetry,
} from '../model/camera-types';
import { CameraCommandError, type CameraProvider, type CameraProviderKind } from './camera-provider';

/** Minimal fetch shape (injectable for tests / a cert-pinned COHN dispatcher). */
export type CameraFetch = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string>;
}>;

/** Well-known Open GoPro status ids read from GET /gopro/camera/state. */
const STATUS_SYSTEM_BUSY = 8;
const STATUS_ENCODING = 10;
const STATUS_REMAINING_PHOTOS = 34;
const STATUS_REMAINING_VIDEO_S = 35;
const STATUS_BATTERY_PCT = 70;
/** Conventional preset-group ids (Open GoPro): Video / Photo / Timelapse. */
const PRESET_GROUP: Record<CameraMode, number> = { video: 1000, photo: 1001, timelapse: 1002 };
const HTTP_TIMEOUT_MS = 8_000;
const EVENT_RETENTION = 200;
const CAPTURE_RETENTION = 100;

/** Construction options for the GoPro adapter. */
export interface GoProCameraOptions {
  cameraId: string;
  /** How the node reaches the camera. Determines the default base URL + auth. */
  link: CameraLink;
  /** Base URL the HTTP API is served at. usb→http://172.2X.1YZ.51:8080, ap→http://10.5.5.9:8080, cohn→https://<lan-ip>. */
  baseUrl: string;
  /** COHN Basic-auth credentials (cohn link only). */
  auth?: { username: string; password: string };
  /** Camera model label, if known ahead of connect (refined from /gopro/camera/info). */
  model?: string;
  clock?: () => number;
  /** Injected fetch (the node wires a cert-pinned dispatcher for cohn). */
  fetchImpl?: CameraFetch;
}

/**
 * @description Derive the USB base URL from a GoPro serial number. Over USB the camera is reachable
 * at `172.2X.1YZ.51:8080`, where X/Y/Z are the last three digits of the serial.
 * @param serial - The camera serial (only the last three digits are used).
 * @returns The USB base URL, e.g. "http://172.27.189.51:8080".
 */
export function goproUsbBaseUrl(serial: string): string {
  const digits = String(serial).replace(/\D/g, '');
  if (digits.length < 3) throw new Error(`serial "${serial}" has too few digits to derive the USB address`);
  const [a, b, c] = digits.slice(-3).split('');
  return `http://172.2${a}.1${b}${c}.51:8080`;
}

/**
 * @description The real GoPro engine. Implements {@link CameraProvider} against the Open GoPro HTTP
 * API. State is cached (last /gopro/camera/state read) so getTelemetry never blocks; the node keeps
 * the cache fresh by calling keepAlive on its heartbeat tick. Every command is a plain GET; the
 * camera rejects overlapping/while-busy commands, which surface as {@link CameraCommandError}.
 */
export class GoProCameraProvider implements CameraProvider {
  readonly kind: CameraProviderKind = 'gopro';
  readonly cameraId: string;

  private readonly link: CameraLink;
  private readonly baseUrl: string;
  private readonly authHeader: string | null;
  private readonly clock: () => number;
  private readonly fetchImpl: CameraFetch;

  private connected = false;
  private modelName: string;
  private firmware: string | undefined;
  private serial: string | undefined;
  private mode: CameraMode = 'video';
  private recording = false;
  private busy = false;
  private encoding = false;
  private batteryPct: number | undefined;
  private sdPhotos: number | undefined;
  private sdVideoS: number | undefined;
  private previewActive = false;
  private settings: CameraSettings = {};
  private recordStartMs = 0;
  private events: CameraEvent[] = [];
  private seq = 0;
  private captures: CameraCapture[] = [];
  private capSeq = 0;

  constructor(opts: GoProCameraOptions) {
    this.cameraId = opts.cameraId;
    this.link = opts.link;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.authHeader = opts.auth
      ? `Basic ${Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString('base64')}`
      : null;
    this.modelName = opts.model ?? 'GoPro';
    this.clock = opts.clock ?? ((): number => Date.now());
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as CameraFetch);
  }

  get model(): string { return this.modelName; }

  // ── Commands ───────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // USB requires enabling wired control before the HTTP API answers on the USB interface.
    if (this.link === 'usb') await this.get('/gopro/camera/control/wired_usb?p=1').catch(() => null);
    // Claim control so the phone app doesn't fight us (best practice; non-fatal if unsupported).
    await this.get('/gopro/camera/control/set_ui_controller?p=2').catch(() => null);
    await this.readInfo();
    await this.refreshState();
    this.connected = true;
    this.logEvent('info', `Connected to ${this.modelName} over ${this.link}`);
  }

  async disconnect(): Promise<void> {
    if (this.previewActive) { await this.get('/gopro/camera/stream/stop').catch(() => null); this.previewActive = false; }
    this.connected = false;
    this.logEvent('info', 'Disconnected');
  }

  async startRecording(): Promise<void> {
    this.requireReady('record');
    if (this.recording) throw new CameraCommandError('already recording');
    if (this.mode !== 'video') await this.setMode('video');
    await this.get('/gopro/camera/shutter/start');
    this.recording = true;
    this.recordStartMs = this.clock();
    this.logEvent('info', 'Recording started');
  }

  async stopRecording(): Promise<void> {
    this.requireConnected('stop recording');
    if (!this.recording) throw new CameraCommandError('not recording');
    await this.get('/gopro/camera/shutter/stop');
    const durationS = Math.max(0, Math.round((this.clock() - this.recordStartMs) / 100) / 10);
    this.recording = false;
    await this.recordLastCapture('video', durationS);
    this.logEvent('info', `Recording stopped (${durationS}s clip)`);
  }

  async capturePhoto(): Promise<void> {
    this.requireReady('take a photo');
    if (this.recording) throw new CameraCommandError('stop the video recording before taking a photo');
    if (this.mode !== 'photo') await this.setMode('photo');
    await this.get('/gopro/camera/shutter/start');
    await this.recordLastCapture('photo');
    this.logEvent('info', `Photo captured (#${this.capSeq})`);
  }

  async setMode(mode: CameraMode): Promise<void> {
    this.requireReady('change mode');
    await this.get(`/gopro/camera/presets/set_group?id=${PRESET_GROUP[mode]}`);
    this.mode = mode;
    this.logEvent('info', `Mode set to ${mode}`);
  }

  async loadPreset(presetId: number): Promise<void> {
    this.requireReady('load a preset');
    await this.get(`/gopro/camera/presets/load?id=${encodeURIComponent(String(presetId))}`);
    this.logEvent('info', `Preset ${presetId} loaded`);
  }

  async setSetting(setting: number, option: number): Promise<void> {
    this.requireReady('change a setting');
    await this.get(`/gopro/camera/setting?setting=${setting}&option=${option}`);
    this.settings[`setting-${setting}`] = option;
    this.logEvent('info', `Setting ${setting} → option ${option}`);
  }

  async startPreview(): Promise<void> {
    this.requireReady('start preview');
    await this.get('/gopro/camera/stream/start');
    this.previewActive = true;
    this.logEvent('info', 'Preview stream started (UDP :8554 at the node)');
  }

  async stopPreview(): Promise<void> {
    this.requireConnected('stop preview');
    await this.get('/gopro/camera/stream/stop');
    this.previewActive = false;
    this.logEvent('info', 'Preview stream stopped');
  }

  async keepAlive(): Promise<void> {
    if (!this.connected) return;
    await this.get('/gopro/camera/keep_alive').catch(() => null);
    await this.refreshState();
  }

  async deleteAll(): Promise<void> {
    this.requireReady('delete media');
    await this.get('/gp/gpControl/command/storage/delete/all');
    this.captures = [];
    this.logEvent('warn', 'Deleted all media on the camera');
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  getTelemetry(): CameraTelemetry {
    const status: CameraStatus = !this.connected
      ? 'disconnected'
      : this.recording || this.encoding ? 'recording' : this.busy ? 'busy' : 'connected';
    return {
      cameraId: this.cameraId,
      status,
      connected: this.connected,
      recording: this.recording || this.encoding,
      mode: this.mode,
      link: this.link,
      model: this.modelName,
      firmware: this.firmware,
      serial: this.serial,
      batteryPct: this.batteryPct,
      sdRemainingPhotos: this.sdPhotos,
      sdRemainingVideoS: this.sdVideoS,
      recordElapsedS: this.recording ? Math.round((this.clock() - this.recordStartMs) / 100) / 10 : 0,
      previewActive: this.previewActive,
      settings: { ...this.settings },
      lastCaptureSeq: this.capSeq,
      systemBusy: this.busy,
      encoding: this.encoding,
    };
  }

  getEvents(sinceSeq: number): CameraEvent[] { return this.events.filter((e) => e.seq > sinceSeq); }
  getCaptures(sinceSeq: number): CameraCapture[] { return this.captures.filter((c) => c.seq > sinceSeq); }

  // ── HTTP + state ─────────────────────────────────────────────────────────────

  /** Read model/firmware/serial from GET /gopro/camera/info (best-effort; leaves defaults on failure).
   * Newer firmware returns the fields at the top level; older nests them under an "info" object. */
  private async readInfo(): Promise<void> {
    const raw = (await this.get('/gopro/camera/info').catch(() => null)) as Record<string, unknown> | null;
    if (!raw) return;
    const nested = (raw.info && typeof raw.info === 'object' ? raw.info : raw) as Record<string, unknown>;
    if (typeof nested.model_name === 'string') this.modelName = nested.model_name;
    if (typeof nested.firmware_version === 'string') this.firmware = nested.firmware_version;
    if (typeof nested.serial_number === 'string') this.serial = nested.serial_number;
  }

  /** Refresh the cached state from GET /gopro/camera/state (statuses + settings). */
  private async refreshState(): Promise<void> {
    const state = (await this.get('/gopro/camera/state').catch(() => null)) as
      { status?: Record<string, unknown>; settings?: Record<string, unknown> } | null;
    if (!state?.status) return;
    const s = state.status;
    this.busy = Boolean(Number(s[STATUS_SYSTEM_BUSY]));
    this.encoding = Boolean(Number(s[STATUS_ENCODING]));
    if (s[STATUS_BATTERY_PCT] !== undefined) this.batteryPct = Number(s[STATUS_BATTERY_PCT]);
    if (s[STATUS_REMAINING_PHOTOS] !== undefined) this.sdPhotos = Number(s[STATUS_REMAINING_PHOTOS]);
    if (s[STATUS_REMAINING_VIDEO_S] !== undefined) this.sdVideoS = Number(s[STATUS_REMAINING_VIDEO_S]);
  }

  /** Read the just-captured media path and record it as a capture. */
  private async recordLastCapture(kind: CameraCapture['kind'], durationS?: number): Promise<void> {
    const last = (await this.get('/gopro/media/last_captured').catch(() => null)) as
      { file?: string; folder?: string } | null;
    const path = last?.folder && last?.file ? `${last.folder}/${last.file}` : `100GOPRO/${kind}-${this.capSeq + 1}`;
    this.capSeq += 1;
    this.captures.push({ seq: this.capSeq, ts: this.clock(), kind, path, ...(durationS !== undefined ? { durationS } : {}) });
    if (this.captures.length > CAPTURE_RETENTION) this.captures.splice(0, this.captures.length - CAPTURE_RETENTION);
  }

  /**
   * @description Issue one GET against the camera. Non-2xx → {@link CameraCommandError} with the
   * body (the camera returns a 403 listing valid options, a 409/5xx while busy, etc.); a transport
   * failure → an offline-style rejection. Best-effort reads (info/state/keep-alive) `.catch` the
   * throw at the call site so a transient blip doesn't kill a heartbeat.
   * @param path - API path beginning with '/'.
   * @returns The parsed JSON body (or `{}` when the body is empty/non-JSON).
   */
  private async get(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: this.authHeader ? { Authorization: this.authHeader } : {},
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new CameraCommandError(`camera returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      return await res.json().catch(() => ({}));
    } catch (err) {
      if (err instanceof CameraCommandError) throw err;
      const reason = (err as Error).name === 'AbortError' ? `timed out after ${HTTP_TIMEOUT_MS}ms` : (err as Error).message;
      throw new CameraCommandError(`camera "${this.cameraId}" unreachable (${this.link}): ${reason}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireConnected(verb: string): void {
    if (!this.connected) throw new CameraCommandError(`cannot ${verb} — camera is not connected`);
  }

  /** Connected AND not mid-encode/busy — the guard for any command that changes camera state. */
  private requireReady(verb: string): void {
    this.requireConnected(verb);
    if (this.busy) throw new CameraCommandError(`cannot ${verb} — camera is busy (loading/encoding); try again in a moment`);
  }

  private logEvent(level: CameraEvent['level'], message: string): void {
    this.seq += 1;
    this.events.push({ seq: this.seq, ts: this.clock(), level, message });
    if (this.events.length > EVENT_RETENTION) this.events.splice(0, this.events.length - EVENT_RETENTION);
  }
}
