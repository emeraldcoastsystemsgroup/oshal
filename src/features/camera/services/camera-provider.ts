/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — the engine-agnostic
 *                     |                             | camera control interface (?app=camera). The sim provider
 *                     |                             | implements it today; the real GoPro (Open GoPro HTTP)
 *                     |                             | adapter is a sibling implementation, exactly like the LLM
 *                     |                             | harness adapters and the drone providers — never a rewrite.
 *                     |                             | A second brand (Canon CCAPI, ONVIF, ...) is one more sibling.
 */

import type {
  CameraCapture,
  CameraEvent,
  CameraMode,
  CameraTelemetry,
} from '../model/camera-types';

/** @description Which engine is driving the camera: the built-in simulator, or a real GoPro. */
export type CameraProviderKind = 'sim' | 'gopro';

/**
 * @description Thrown when a command doesn't apply to the camera's current state (e.g. stop while
 * not recording, or any command while the camera is busy encoding) or a hard precondition fails
 * (e.g. no link). Routes map it to HTTP 409 — an expected, user-visible rejection, not an internal
 * error. Adapters reject rather than coerce, exactly like the drone providers.
 */
export class CameraCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CameraCommandError';
  }
}

/**
 * @description The single control surface for one camera, regardless of brand or engine. All
 * commands are async because real device links (USB/WiFi/HTTPS) are; the simulator resolves
 * immediately. Implementations own their state machine and reject invalid transitions with
 * {@link CameraCommandError}; the caller ({@link CameraService}) handles the destructive-op
 * confirmation gate BEFORE invoking these.
 */
export interface CameraProvider {
  readonly cameraId: string;
  readonly kind: CameraProviderKind;
  readonly model: string;

  /** Open the link to the camera (enable control, read model/state). Idempotent. */
  connect(): Promise<void>;
  /** Release the link. Stops any preview/keep-alive. Idempotent. */
  disconnect(): Promise<void>;

  /** Start a video recording (shutter on). Rejected if already recording or busy. */
  startRecording(): Promise<void>;
  /** Stop the current recording (shutter off) and record the resulting clip. Rejected if idle. */
  stopRecording(): Promise<void>;
  /** Capture a still. Switches to photo mode if needed. Rejected while recording video. */
  capturePhoto(): Promise<void>;

  /** Switch capture mode (preset group). Rejected while recording. */
  setMode(mode: CameraMode): Promise<void>;
  /** Load a specific preset by id. Rejected while recording. */
  loadPreset(presetId: number): Promise<void>;
  /** Change one device setting by numeric id/option (Open GoPro settings). Rejected while recording. */
  setSetting(setting: number, option: number): Promise<void>;

  /** Start the low-latency preview/webcam feed. Sets the telemetry `previewActive` flag. */
  startPreview(): Promise<void>;
  /** Stop the preview feed. */
  stopPreview(): Promise<void>;
  /** Hold the link open (GoPro sleeps after ~5s idle; the node pings ~every 3s). No-op if not connected. */
  keepAlive(): Promise<void>;

  /** Destructive: delete ALL media on the camera. Confirmation-gated upstream in {@link CameraService}. */
  deleteAll(): Promise<void>;

  /** Current state. Reading advances the (lazy) simulation to "now". */
  getTelemetry(): CameraTelemetry;
  /** Event-log entries with `seq` greater than `sinceSeq` (0 = all retained). */
  getEvents(sinceSeq: number): CameraEvent[];
  /** Capture/media records with `seq` greater than `sinceSeq` (0 = all retained). */
  getCaptures(sinceSeq: number): CameraCapture[];
}
