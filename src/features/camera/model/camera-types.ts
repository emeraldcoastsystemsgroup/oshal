/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — remote camera control app
 *                     |                             | (?app=camera). Shared domain types for controlling a
 *                     |                             | camera device (GoPro-first, pluggable): lifecycle state,
 *                     |                             | control commands, capture/media records, and a telemetry
 *                     |                             | snapshot. Mirrors the drone device model (ADR-098/099) but
 *                     |                             | for a capture device — no flight state, geofence, or missions.
 */

/** @description Which engine is driving the camera: the built-in simulator, or a real GoPro. */
export type CameraProviderKind = 'sim' | 'gopro';

/**
 * @description How the real adapter physically reaches the camera.
 * `usb` — camera as a USB-ethernet device (no Bluetooth needed); `ap` — the host has joined the
 * camera's own WiFi access point; `cohn` — camera is on the home LAN, controlled over HTTPS
 * (HERO12+ only); `ble` — Bluetooth control (bootstrap / no-WiFi basic control).
 */
export type CameraLink = 'usb' | 'ap' | 'cohn' | 'ble';

/** @description Capture mode. Maps to a GoPro preset group (1000=Video, 1001=Photo, 1002=Timelapse). */
export type CameraMode = 'video' | 'photo' | 'timelapse';

/**
 * @description Camera lifecycle state. `busy` means the camera is encoding or loading a preset and
 * is rejecting new commands (GoPro's System-Busy / Encoding-Active flags) — only status queries are
 * safe until it clears. `disconnected` means the link is down (nothing reachable).
 */
export type CameraStatus =
  | 'disconnected'
  | 'connected'   // reachable and idle
  | 'recording'   // a video capture is in progress
  | 'busy';       // encoding / loading a preset — reject non-query commands until clear

/**
 * @description One camera-control operation. Non-destructive ops actuate immediately; `deleteAll`
 * is destructive and requires an explicit write confirmation upstream (mirrors the home-bot gate).
 * `setMode` needs `mode`; `loadPreset` needs `presetId`; `setSetting` needs `setting`+`option`.
 */
export interface CameraCommand {
  op:
    | 'connect'
    | 'disconnect'
    | 'record'
    | 'stop'
    | 'photo'
    | 'setMode'
    | 'loadPreset'
    | 'setSetting'
    | 'startPreview'
    | 'stopPreview'
    | 'keepAlive'
    | 'deleteAll';
  mode?: CameraMode;
  presetId?: number;
  /** Open GoPro numeric setting id (e.g. 2 = Video Resolution). */
  setting?: number;
  /** Open GoPro numeric option id for the setting. */
  option?: number;
}

/**
 * @description One media record produced by the camera. Real captures carry an on-camera `path`
 * (the sim synthesizes plausible paths); the surface renders these, so every field is treated as
 * untrusted and coerced at ingest ({@link CameraCapture} normalization).
 */
export interface CameraCapture {
  seq: number;
  ts: number;
  kind: 'photo' | 'video';
  /** On-camera path, e.g. "100GOPRO/GX010007.MP4". */
  path: string;
  /** Video only: clip length in seconds, when known. */
  durationS?: number;
  /** File size in bytes, when the camera reports it. */
  sizeBytes?: number;
  /** A node-served thumbnail URL (http/https only), when available. */
  thumbUrl?: string;
}

/**
 * @description A small, surface-friendly summary of the camera's current settings. Known fields are
 * typed; adapters may add extra string/number entries (e.g. a raw preset title) without a schema change.
 */
export interface CameraSettings {
  resolution?: string;
  fps?: number;
  fov?: string;
  [key: string]: string | number | undefined;
}

/**
 * @description A point-in-time camera state snapshot. Reading is side-effect-free for callers; the
 * sim advances its internal clock lazily on read (a recording started a minute ago shows a minute
 * of elapsed time). `previewActive` is true while a preview/webcam feed is being served.
 */
export interface CameraTelemetry {
  cameraId: string;
  status: CameraStatus;
  connected: boolean;
  recording: boolean;
  mode: CameraMode;
  /** The physical link in use (gopro only); absent for the sim. */
  link?: CameraLink;
  model: string;
  firmware?: string;
  serial?: string;
  batteryPct?: number;
  /** SD-card headroom, when the camera reports it. */
  sdRemainingPhotos?: number;
  sdRemainingVideoS?: number;
  /** Elapsed seconds of the current recording (0 when not recording). */
  recordElapsedS: number;
  previewActive: boolean;
  settings: CameraSettings;
  /** Highest capture seq the provider currently holds. */
  lastCaptureSeq: number;
  /** Raw busy sub-flags mirrored from the camera (gopro); absent for the sim. */
  systemBusy?: boolean;
  encoding?: boolean;
}

/** @description One entry in the camera's event log (connect, record start/stop, capture, error, ...). */
export interface CameraEvent {
  seq: number;
  ts: number;
  level: 'info' | 'warn' | 'alert';
  message: string;
}
