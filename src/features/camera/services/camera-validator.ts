/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — defensive normalization
 *                     |                             | for camera control. Three untrusted sources feed the
 *                     |                             | provider: the surface, the natural-language concierge, and
 *                     |                             | remote node heartbeats. Coerce EVERY field before it reaches
 *                     |                             | the provider or the surface (the drone camera-capture
 *                     |                             | stored-XSS lesson, 2026-07-18, applied on day one).
 */

import type {
  CameraCapture,
  CameraCommand,
  CameraMode,
  CameraSettings,
} from '../model/camera-types';

/** The one legal camera-id shape — shared by heartbeat ingest and fleet registration. */
export const CAMERA_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** Destructive ops that require an explicit write confirmation upstream. */
export const DESTRUCTIVE_CAMERA_OPS: ReadonlySet<CameraCommand['op']> = new Set(['deleteAll']);

const VALID_MODES: ReadonlySet<string> = new Set<CameraMode>(['video', 'photo', 'timelapse']);
const VALID_OPS: ReadonlySet<string> = new Set<CameraCommand['op']>([
  'connect', 'disconnect', 'record', 'stop', 'photo', 'setMode', 'loadPreset',
  'setSetting', 'startPreview', 'stopPreview', 'keepAlive', 'deleteAll',
]);
/** On-camera media paths are conservative: DCIM-style dir/file, no traversal or markup. */
const CAPTURE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const HTTP_URL_RE = /^https?:\/\/\S{1,300}$/;

/** @description Clamp to a finite number in [min,max], or return `fallback` when not finite. */
function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * @description Normalize an untrusted camera-command payload (from the surface or the concierge)
 * into a validated {@link CameraCommand}, or return the reasons it was rejected. Op-specific fields
 * are required and range-checked; anything extra is dropped.
 * @param raw - The candidate object.
 * @returns `{ command }` on success or `{ command: null, errors }` on failure.
 */
export function normalizeCameraCommand(raw: unknown): { command: CameraCommand | null; errors: string[] } {
  const errors: string[] = [];
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const op = String(obj.op || '');
  if (!VALID_OPS.has(op)) {
    return { command: null, errors: [`unknown camera op "${op}"`] };
  }
  const command: CameraCommand = { op: op as CameraCommand['op'] };

  if (op === 'setMode') {
    const mode = String(obj.mode || '');
    if (!VALID_MODES.has(mode)) errors.push(`setMode requires mode in {video,photo,timelapse}, got "${mode}"`);
    else command.mode = mode as CameraMode;
  }
  if (op === 'loadPreset') {
    const id = Number(obj.presetId);
    if (!Number.isInteger(id) || id < 0 || id > 1_000_000) errors.push(`loadPreset requires a non-negative integer presetId, got "${String(obj.presetId)}"`);
    else command.presetId = id;
  }
  if (op === 'setSetting') {
    const setting = Number(obj.setting);
    const option = Number(obj.option);
    if (!Number.isInteger(setting) || setting < 0 || setting > 1000) errors.push(`setSetting requires an integer setting id, got "${String(obj.setting)}"`);
    if (!Number.isInteger(option) || option < 0 || option > 100000) errors.push(`setSetting requires an integer option id, got "${String(obj.option)}"`);
    if (!errors.length) { command.setting = setting; command.option = option; }
  }

  return errors.length ? { command: null, errors } : { command, errors };
}

/**
 * @description Coerce one untrusted capture record (from a node heartbeat) into a safe
 * {@link CameraCapture}, or null if it is unusable. `path` and `thumbUrl` are rendered by the
 * surface, so both are pattern-validated; numeric fields are clamped; `kind` is whitelisted.
 * @param raw - The candidate object.
 * @returns A safe capture, or null.
 */
export function normalizeCameraCapture(raw: unknown): CameraCapture | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const seq = Number(obj.seq);
  if (!Number.isFinite(seq) || seq < 0) return null;
  const kind = obj.kind === 'video' ? 'video' : obj.kind === 'photo' ? 'photo' : null;
  if (!kind) return null;
  const path = String(obj.path || '');
  if (!CAPTURE_PATH_RE.test(path)) return null;

  const cap: CameraCapture = {
    seq: Math.floor(seq),
    ts: clampNum(obj.ts, 0, Number.MAX_SAFE_INTEGER, 0),
    kind,
    path,
  };
  if (obj.durationS !== undefined) cap.durationS = clampNum(obj.durationS, 0, 86_400, 0);
  if (obj.sizeBytes !== undefined) cap.sizeBytes = clampNum(obj.sizeBytes, 0, Number.MAX_SAFE_INTEGER, 0);
  if (typeof obj.thumbUrl === 'string' && HTTP_URL_RE.test(obj.thumbUrl)) cap.thumbUrl = obj.thumbUrl;
  return cap;
}

/**
 * @description Coerce an untrusted settings map into a {@link CameraSettings} of primitives only
 * (string/number), dropping objects/arrays and capping key/value length so a hostile node can't
 * bloat or inject markup into the surface's settings panel.
 * @param raw - The candidate object.
 * @returns A safe settings map (possibly empty).
 */
export function normalizeCameraSettings(raw: unknown): CameraSettings {
  const out: CameraSettings = {};
  if (!raw || typeof raw !== 'object') return out;
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 40) break;
    if (!/^[A-Za-z0-9 _.-]{1,40}$/.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) { out[k] = v; count++; }
    else if (typeof v === 'string') { out[k] = v.slice(0, 80); count++; }
  }
  return out;
}
