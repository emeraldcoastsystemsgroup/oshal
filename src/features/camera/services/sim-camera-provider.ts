/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the built-in camera engine
 *                     |                             | behind CameraProvider. Deterministic, lazy time integration
 *                     |                             | (no background timer): every read/command advances battery,
 *                     |                             | SD headroom, and recording elapsed by real elapsed time, so
 *                     |                             | the same code is exact under test clocks and live polling. It
 *                     |                             | exists so the whole app — routes, surface, concierge — is
 *                     |                             | exercisable end-to-end with zero hardware; the GoPro adapter
 *                     |                             | later implements the same interface and nothing above changes.
 */

import type {
  CameraCapture,
  CameraEvent,
  CameraMode,
  CameraSettings,
  CameraStatus,
  CameraTelemetry,
} from '../model/camera-types';
import { CameraCommandError, type CameraProvider, type CameraProviderKind } from './camera-provider';

const BATTERY_DRAIN_IDLE_PCT_PER_S = 0.005;
const BATTERY_DRAIN_ACTIVE_PCT_PER_S = 0.03;
/** Longest gap the lazy integrator simulates through (idle beyond this is truncated). */
const MAX_CATCHUP_S = 3_600;
const EVENT_RETENTION = 200;
const CAPTURE_RETENTION = 100;
const DEFAULT_SD_VIDEO_S = 7_200;
const DEFAULT_SD_PHOTOS = 9_999;

/** Construction options for the simulator. `clock` is injectable for deterministic tests. */
export interface SimCameraOptions {
  cameraId?: string;
  model?: string;
  clock?: () => number;
}

/**
 * @description The built-in camera engine: a single simulated action camera with a strict command
 * state machine (idle → recording → idle), a draining battery, and shrinking SD headroom. Every
 * shutter produces a structured {@link CameraCapture} and an event — the audit record. Starts
 * connected so `?app=camera` shows a live camera immediately; a real GoPro adapter is a sibling.
 */
export class SimCameraProvider implements CameraProvider {
  readonly kind: CameraProviderKind = 'sim';
  readonly cameraId: string;
  readonly model: string;

  private readonly clock: () => number;
  private connected = true;
  private recording = false;
  private mode: CameraMode = 'video';
  private batteryPct = 100;
  private sdRemainingVideoS = DEFAULT_SD_VIDEO_S;
  private sdRemainingPhotos = DEFAULT_SD_PHOTOS;
  private previewActive = false;
  private settings: CameraSettings = { resolution: '1080p', fps: 60, fov: 'wide' };
  private recordStartMs = 0;
  private lastTickMs: number;
  private events: CameraEvent[] = [];
  private seq = 0;
  private captures: CameraCapture[] = [];
  private capSeq = 0;

  constructor(opts: SimCameraOptions = {}) {
    this.cameraId = opts.cameraId ?? 'sim-1';
    this.model = opts.model ?? 'OSHAL SimCam';
    this.clock = opts.clock ?? ((): number => Date.now());
    this.lastTickMs = this.clock();
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.tick();
    if (!this.connected) { this.connected = true; this.logEvent('info', 'Connected'); }
  }

  async disconnect(): Promise<void> {
    this.tick();
    if (this.recording) { this.recording = false; this.logEvent('warn', 'Recording stopped by disconnect'); }
    this.previewActive = false;
    if (this.connected) { this.connected = false; this.logEvent('info', 'Disconnected'); }
  }

  async startRecording(): Promise<void> {
    this.tick();
    this.requireConnected('record');
    if (this.recording) throw new CameraCommandError('already recording');
    if (this.sdRemainingVideoS <= 0) throw new CameraCommandError('SD card full — no video headroom');
    if (this.mode !== 'video') { this.mode = 'video'; this.logEvent('info', 'Switched to video mode'); }
    this.recording = true;
    this.recordStartMs = this.clock();
    this.logEvent('info', 'Recording started');
  }

  async stopRecording(): Promise<void> {
    this.tick();
    this.requireConnected('stop recording');
    if (!this.recording) throw new CameraCommandError('not recording');
    const durationS = Math.max(0, Math.round((this.clock() - this.recordStartMs) / 100) / 10);
    this.recording = false;
    this.pushCapture('video', durationS);
    this.logEvent('info', `Recording stopped (${durationS}s clip)`);
  }

  async capturePhoto(): Promise<void> {
    this.tick();
    this.requireConnected('take a photo');
    if (this.recording) throw new CameraCommandError('stop the video recording before taking a photo');
    if (this.sdRemainingPhotos <= 0) throw new CameraCommandError('SD card full — no photo headroom');
    if (this.mode !== 'photo') { this.mode = 'photo'; this.logEvent('info', 'Switched to photo mode'); }
    this.pushCapture('photo');
    this.sdRemainingPhotos = Math.max(0, this.sdRemainingPhotos - 1);
    this.logEvent('info', `Photo captured (#${this.capSeq})`);
  }

  async setMode(mode: CameraMode): Promise<void> {
    this.tick();
    this.requireConnected('change mode');
    if (this.recording) throw new CameraCommandError('cannot change mode while recording');
    this.mode = mode;
    this.logEvent('info', `Mode set to ${mode}`);
  }

  async loadPreset(presetId: number): Promise<void> {
    this.tick();
    this.requireConnected('load a preset');
    if (this.recording) throw new CameraCommandError('cannot load a preset while recording');
    // Sim maps the conventional GoPro preset-group ids to modes; unknown ids just log.
    const byGroup: Record<number, CameraMode> = { 1000: 'video', 1001: 'photo', 1002: 'timelapse' };
    if (byGroup[presetId]) this.mode = byGroup[presetId];
    this.logEvent('info', `Preset ${presetId} loaded`);
  }

  async setSetting(setting: number, option: number): Promise<void> {
    this.tick();
    this.requireConnected('change a setting');
    if (this.recording) throw new CameraCommandError('cannot change settings while recording');
    // Sim reflects a couple of well-known Open GoPro settings so the surface shows an effect.
    if (setting === 2) this.settings.resolution = `option-${option}`;
    else this.settings[`setting-${setting}`] = option;
    this.logEvent('info', `Setting ${setting} → option ${option}`);
  }

  async startPreview(): Promise<void> {
    this.tick();
    this.requireConnected('start preview');
    if (!this.previewActive) { this.previewActive = true; this.logEvent('info', 'Preview stream started'); }
  }

  async stopPreview(): Promise<void> {
    this.tick();
    if (this.previewActive) { this.previewActive = false; this.logEvent('info', 'Preview stream stopped'); }
  }

  async keepAlive(): Promise<void> {
    this.tick(); // holding the link open is a no-op for the sim beyond advancing time
  }

  async deleteAll(): Promise<void> {
    this.tick();
    this.requireConnected('delete media');
    if (this.recording) throw new CameraCommandError('cannot delete media while recording');
    const n = this.captures.length;
    this.captures = [];
    this.sdRemainingVideoS = DEFAULT_SD_VIDEO_S;
    this.sdRemainingPhotos = DEFAULT_SD_PHOTOS;
    this.logEvent('warn', `Deleted all media (${n} item${n === 1 ? '' : 's'})`);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  getTelemetry(): CameraTelemetry {
    this.tick();
    const status: CameraStatus = !this.connected ? 'disconnected' : this.recording ? 'recording' : 'connected';
    return {
      cameraId: this.cameraId,
      status,
      connected: this.connected,
      recording: this.recording,
      mode: this.mode,
      model: this.model,
      firmware: 'sim-1.0',
      batteryPct: Math.round(this.batteryPct * 10) / 10,
      sdRemainingPhotos: Math.round(this.sdRemainingPhotos),
      sdRemainingVideoS: Math.round(this.sdRemainingVideoS),
      recordElapsedS: this.recording ? Math.round((this.clock() - this.recordStartMs) / 100) / 10 : 0,
      previewActive: this.previewActive,
      settings: { ...this.settings },
      lastCaptureSeq: this.capSeq,
    };
  }

  getEvents(sinceSeq: number): CameraEvent[] {
    this.tick();
    return this.events.filter((e) => e.seq > sinceSeq);
  }

  getCaptures(sinceSeq: number): CameraCapture[] {
    this.tick();
    return this.captures.filter((c) => c.seq > sinceSeq);
  }

  // ── Simulation core ────────────────────────────────────────────────────────

  /** Record a capture with a GoPro-style on-camera path. */
  private pushCapture(kind: CameraCapture['kind'], durationS?: number): void {
    this.capSeq += 1;
    const num = String(this.capSeq).padStart(4, '0');
    const path = kind === 'video' ? `100GOPRO/GX01${num}.MP4` : `100GOPRO/GOPR${num}.JPG`;
    this.captures.push({
      seq: this.capSeq,
      ts: this.clock(),
      kind,
      path,
      ...(durationS !== undefined ? { durationS } : {}),
    });
    if (this.captures.length > CAPTURE_RETENTION) {
      this.captures.splice(0, this.captures.length - CAPTURE_RETENTION);
    }
  }

  /** Advance battery drain, SD headroom, and recording consumption to "now" in ≤1s sub-steps. */
  private tick(): void {
    const now = this.clock();
    let dt = (now - this.lastTickMs) / 1000;
    this.lastTickMs = now;
    if (dt <= 0) return;
    dt = Math.min(dt, MAX_CATCHUP_S);
    if (!this.connected) return;
    const active = this.recording || this.previewActive;
    const rate = active ? BATTERY_DRAIN_ACTIVE_PCT_PER_S : BATTERY_DRAIN_IDLE_PCT_PER_S;
    this.batteryPct = Math.max(0, this.batteryPct - rate * dt);
    if (this.recording) {
      this.sdRemainingVideoS = Math.max(0, this.sdRemainingVideoS - dt);
      if (this.sdRemainingVideoS <= 0) {
        // SD exhausted mid-clip: stop and save what we have (mirrors real camera behavior).
        const durationS = Math.max(0, Math.round((now - this.recordStartMs) / 100) / 10);
        this.recording = false;
        this.pushCapture('video', durationS);
        this.logEvent('alert', 'SD card full — recording stopped automatically');
      }
    }
  }

  private requireConnected(verb: string): void {
    if (!this.connected) throw new CameraCommandError(`cannot ${verb} — camera is disconnected`);
  }

  private logEvent(level: CameraEvent['level'], message: string): void {
    this.seq += 1;
    this.events.push({ seq: this.seq, ts: this.clock(), level, message });
    if (this.events.length > EVENT_RETENTION) this.events.splice(0, this.events.length - EVENT_RETENTION);
  }
}
