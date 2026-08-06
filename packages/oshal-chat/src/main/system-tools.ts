/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | System-control tools for the worker: screenshot (Electron desktopCapturer), shell (PowerShell), and mouse/keyboard/app control. Input uses nut.js when it loads, else falls back to zero-dep PowerShell P/Invoke so a flaky native build never blocks control. Gated by config.allowSystemControl (off by default).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Click-coordinate scaling fix: captureScreen captured PHYSICAL pixels but returned DOWNSCALED width/height with no scale info, while controlInput sent raw action x/y to nut-js — so swarm clicks derived from the screenshot landed short of their target on any scaled/downscaled display. captureScreen now also returns physicalWidth/physicalHeight/scaleFactor and caches the capture metrics; InputAction gains coordinateSpace ('screenshot' default — what swarm callers send — or 'physical'), and controlInput rescales screenshot-space coordinates to physical pixels (resolveInputAction, pure/unit-tested) before any setPosition/SetCursorPos.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed the vulnerable native nut.js dependency and made the existing zero-dependency PowerShell P/Invoke implementation the single input path, eliminating its unpatched image-parser chain and Electron ABI variability while retaining coordinate scaling and desktop control behavior.
 */

import { spawn } from 'child_process';
import { createRequire } from 'module';

const requireFn = createRequire(__filename);

/** Result of a screen capture. */
export interface ScreenShot {
  success: boolean;
  /** data:image/png;base64,... — directly renderable / forwardable. */
  dataUrl?: string;
  /** Width of the RETURNED (possibly downscaled) image — the screenshot coordinate space. */
  width?: number;
  /** Height of the RETURNED (possibly downscaled) image — the screenshot coordinate space. */
  height?: number;
  /** Full physical capture width in device pixels (before any downscale). */
  physicalWidth?: number;
  /** Full physical capture height in device pixels (before any downscale). */
  physicalHeight?: number;
  /** Display scale factor (DIP → physical) reported by Electron for the primary display. */
  scaleFactor?: number;
  error?: string;
}

/**
 * @description Coordinate metrics of the most recent successful capture. Maps the
 * screenshot coordinate space (what a swarm caller reads click targets from) back
 * to physical device pixels (what the OS cursor APIs expect).
 */
export interface CaptureMetrics {
  /** Returned screenshot width (possibly downscaled). */
  width: number;
  /** Returned screenshot height (possibly downscaled). */
  height: number;
  /** Physical capture width in device pixels. */
  physicalWidth: number;
  /** Physical capture height in device pixels. */
  physicalHeight: number;
  /** Display scale factor (DIP → physical). */
  scaleFactor: number;
}

/** Result of a shell command. */
export interface ShellResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** A desktop input action the swarm can request. */
export interface InputAction {
  kind: 'move' | 'click' | 'doubleclick' | 'rightclick' | 'type' | 'launch';
  x?: number;
  y?: number;
  text?: string;
  app?: string;
  /**
   * Which space x/y are expressed in. 'screenshot' (default — what swarm callers
   * send, having read the coordinates off the possibly-downscaled screen.capture
   * image) is rescaled to physical device pixels before the cursor moves;
   * 'physical' passes x/y through untouched.
   */
  coordinateSpace?: 'screenshot' | 'physical';
}

/* ───────────────────────── Screenshot ───────────────────────── */

// Metrics of the most recent successful capture — controlInput uses these to map
// screenshot-space click coordinates back to physical pixels (capture → look → click).
let lastCaptureMetrics: CaptureMetrics | null = null;

/** @description Returns the metrics of the most recent successful capture (null before any capture). */
export function getLastCaptureMetrics(): CaptureMetrics | null {
  return lastCaptureMetrics;
}

/**
 * @description Captures the primary display as a PNG data URL via Electron's
 * desktopCapturer (no native dep). Downscaled to `maxWidth` to keep the payload sane.
 * The result carries BOTH spaces: width/height describe the returned (possibly
 * downscaled) image, physicalWidth/physicalHeight/scaleFactor describe the real
 * display — so a caller can express clicks in either coordinate space.
 */
export async function captureScreen(maxWidth = 1600): Promise<ScreenShot> {
  try {
    // Lazy import so this module also loads in a plain-node context (tests).
    const { desktopCapturer, screen } = requireFn('electron') as typeof import('electron');
    const primary = screen.getPrimaryDisplay();
    const sf = primary.scaleFactor || 1;
    const fullW = Math.round(primary.size.width * sf);
    const fullH = Math.round(primary.size.height * sf);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: fullW, height: fullH } });
    if (!sources.length) return { success: false, error: 'No screen source available' };
    const captured = sources[0].thumbnail;
    const capturedSize = captured.getSize(); // physical-space capture (pre-downscale)
    let img = captured;
    if (capturedSize.width > maxWidth) img = img.resize({ width: maxWidth });
    const size = img.getSize();
    lastCaptureMetrics = {
      width: size.width,
      height: size.height,
      physicalWidth: capturedSize.width,
      physicalHeight: capturedSize.height,
      scaleFactor: sf,
    };
    return {
      success: true,
      dataUrl: img.toDataURL(),
      width: size.width,
      height: size.height,
      physicalWidth: capturedSize.width,
      physicalHeight: capturedSize.height,
      scaleFactor: sf,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ───────────────────────── Shell ───────────────────────── */

/**
 * @description Runs a command through PowerShell and returns stdout/stderr.
 * (Covers "search My Documents for PDFs", launching apps, etc.)
 */
export function runShell(command: string, timeoutMs = 120_000, cwd?: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, cwd: cwd || undefined });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ success: code === 0, stdout: stdout.slice(0, 20_000), stderr: stderr.slice(-2_000), exitCode: code }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ success: false, stdout, stderr: String((err as Error)?.message || err), exitCode: -1 }); });
  });
}

/* ───────────────────────── Input control ───────────────────────── */

/**
 * @description Maps an action's x/y into PHYSICAL device pixels. coordinateSpace
 * 'screenshot' (the default — swarm callers read click targets off the possibly-
 * downscaled screen.capture image) rescales through the capture metrics;
 * 'physical' passes coordinates through untouched. With no metrics available
 * (no capture yet) screenshot-space coordinates pass through unchanged — exact
 * only on an unscaled 1:1 display, so callers should capture before clicking.
 * Pure — exported for unit tests.
 * @param action - The requested input action.
 * @param metrics - Capture metrics mapping screenshot space to physical space, or null.
 * @returns An equivalent action whose x/y are physical device pixels.
 */
export function resolveInputAction(action: InputAction, metrics: CaptureMetrics | null): InputAction {
  if (action.x == null && action.y == null) return action;
  if (action.coordinateSpace === 'physical') return action;
  if (!metrics || metrics.width <= 0 || metrics.height <= 0) return action;
  const sx = metrics.physicalWidth / metrics.width;
  const sy = metrics.physicalHeight / metrics.height;
  return {
    ...action,
    x: action.x != null ? Math.round(action.x * sx) : undefined,
    y: action.y != null ? Math.round(action.y * sy) : undefined,
    coordinateSpace: 'physical',
  };
}

/**
 * @description Performs one input action. Screenshot-space coordinates (the
 * default) are first rescaled to physical pixels via the last capture's metrics.
 * Uses the zero-dependency PowerShell implementation directly. Keeping one OS
 * input path avoids native Electron ABI drift and removes the unpatched image-
 * parser dependency chain previously pulled in by nut.js.
 * @param action - Input operation in screenshot or physical coordinate space.
 * @returns Structured success/failure without exposing the generated shell command.
 */
export async function controlInput(action: InputAction): Promise<{ success: boolean; via: 'powershell'; error?: string }> {
  const resolved = resolveInputAction(action, lastCaptureMetrics);
  try {
    await psControl(resolved);
    return { success: true, via: 'powershell' };
  } catch (error) {
    return { success: false, via: 'powershell', error: msg(error) };
  }
}

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** Zero-dependency Windows input path: user32 P/Invoke + SendKeys + Start-Process. */
async function psControl(action: InputAction): Promise<void> {
  const user32 = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);' -Name U -Namespace W -ErrorAction SilentlyContinue;`;
  const L_DOWN = '0x0002', L_UP = '0x0004', R_DOWN = '0x0008', R_UP = '0x0010';
  let script: string;
  switch (action.kind) {
    case 'move':
      script = `${user32} [W.U]::SetCursorPos(${int(action.x)},${int(action.y)})`;
      break;
    case 'click':
      script = `${user32} ${action.x != null ? `[W.U]::SetCursorPos(${int(action.x)},${int(action.y)});` : ''} [W.U]::mouse_event(${L_DOWN},0,0,0,0); [W.U]::mouse_event(${L_UP},0,0,0,0)`;
      break;
    case 'doubleclick':
      script = `${user32} ${action.x != null ? `[W.U]::SetCursorPos(${int(action.x)},${int(action.y)});` : ''} [W.U]::mouse_event(${L_DOWN},0,0,0,0);[W.U]::mouse_event(${L_UP},0,0,0,0);Start-Sleep -Milliseconds 60;[W.U]::mouse_event(${L_DOWN},0,0,0,0);[W.U]::mouse_event(${L_UP},0,0,0,0)`;
      break;
    case 'rightclick':
      script = `${user32} ${action.x != null ? `[W.U]::SetCursorPos(${int(action.x)},${int(action.y)});` : ''} [W.U]::mouse_event(${R_DOWN},0,0,0,0); [W.U]::mouse_event(${R_UP},0,0,0,0)`;
      break;
    case 'type':
      script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psStr(action.text ?? '')})`;
      break;
    case 'launch':
      script = `Start-Process ${psStr(action.app ?? '')}`;
      break;
    default:
      throw new Error(`unknown action "${action.kind}"`);
  }
  const res = await runShell(script, 30_000);
  if (!res.success) throw new Error(res.stderr || `exit ${res.exitCode}`);
}

function int(n: number | undefined): number { return Math.round(Number(n) || 0); }
/** Single-quote a PowerShell string literal (doubling internal quotes). */
function psStr(s: string): string { return `'${String(s).replace(/'/g, "''")}'`; }
