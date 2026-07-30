/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Screen capture and input synthesis through short-lived PowerShell children rather than a native addon, so this tool installs with zero dependencies and no compiler on any Windows box — and so every privileged desktop call is one auditable script in this file instead of opaque binary. The DPI prelude is load-bearing, not boilerplate: without it Windows lies to a scaled process about both the bitmap size and the cursor coordinate space, so the model would be shown a downscaled screen and its normalized click would land somewhere other than what it saw. `SetProcessDpiAwarenessContext(-4)` is attempted first with `SetProcessDPIAware()` as the fallback for older builds. Screenshots go to a single dedicated temp directory and `removeScreenshot` refuses any path outside it, so a caller (or a model-supplied path) can never turn cleanup into arbitrary deletion — the callers delete each frame the moment its analysis ends, so a session leaves no accumulating record of the user's screen.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * @description The one directory screenshots may be written to or deleted from.
 *
 * Confining frames to a single known path is what makes `removeScreenshot` safe to hand a path that
 * travelled through a model round-trip: anything outside this directory is simply not deleted.
 */
const FRAME_DIR = path.join(os.tmpdir(), 'coder-bot');
fs.mkdirSync(FRAME_DIR, { recursive: true });

const PRELUDE = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing | Out-Null
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CoderBotU32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint data,int extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@ | Out-Null
try { [CoderBotU32]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { [CoderBotU32]::SetProcessDPIAware() | Out-Null }
`;

/**
 * @description Run a PowerShell fragment with the DPI/assembly prelude prepended.
 *
 * `-NoProfile` keeps the operator's profile from changing behaviour (and from costing startup time on
 * a call made many times a minute); `-NonInteractive` guarantees a prompt can never block the child
 * forever; `windowsHide` stops a console flashing over the very screen being captured. The timeout is
 * the backstop for a wedged desktop call so a stuck child cannot stall the monitor loop.
 *
 * @param {string} script PowerShell to append to the prelude.
 * @param {number} [timeoutMs=20000] Kill the child after this long.
 * @returns {Promise<string>} Trimmed stdout.
 * @throws {Error} With trailing stderr when PowerShell exits non-zero.
 */
function powershell(script, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      PRELUDE + script,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-2_000); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `PowerShell exited ${code}`));
      else resolve(stdout.trim());
    });
  });
}

/**
 * @description The single Windows desktop surface — capture, foreground identity, and input
 * synthesis. Exported as one object literal so tests and the control agent can substitute a fake:
 * every consumer takes it by injection (`{ desktop = Desktop }`), which is what lets the safety
 * tests prove a blocked keystroke never reaches the real desktop.
 */
const Desktop = {
  /**
   * @description Capture the monitor holding the foreground window, and a cheap change signature.
   *
   * It captures that monitor rather than the virtual desktop for two reasons: the user's attention is
   * there, and a multi-monitor composite would dilute the region of interest in the image the model
   * reads. `originX`/`originY` are returned because on a multi-monitor layout the monitor's bounds do
   * not start at 0,0 — the control agent adds them back when converting a normalized coordinate into
   * a cursor position, and omitting them would land clicks on the wrong screen. The 16x9 luminance
   * signature is computed in the same PowerShell pass while the bitmap is already in memory, so
   * change detection costs nothing extra.
   *
   * @returns {Promise<{path: string, width: number, height: number, originX: number, originY: number, signature: string}>}
   * Frame path inside FRAME_DIR (the caller MUST hand it to removeScreenshot), monitor geometry, and
   * a base64 greyscale signature.
   */
  async screenshot() {
    const file = path.join(FRAME_DIR, `screen-${Date.now()}-${process.pid}.png`);
    const escaped = file.replace(/'/g, "''");
    const output = await powershell(`
$screen=[System.Windows.Forms.Screen]::FromHandle([CoderBotU32]::GetForegroundWindow())
$bounds=$screen.Bounds
$bitmap=New-Object System.Drawing.Bitmap($bounds.Width,$bounds.Height)
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.X,$bounds.Y,0,0,$bitmap.Size)
$bitmap.Save('${escaped}',[System.Drawing.Imaging.ImageFormat]::Png)
$small=New-Object System.Drawing.Bitmap(16,9)
$smallGraphics=[System.Drawing.Graphics]::FromImage($small)
$smallGraphics.DrawImage($bitmap,0,0,16,9)
$signature=New-Object byte[] (16*9)
for ($y=0;$y -lt 9;$y++) {
  for ($x=0;$x -lt 16;$x++) {
    $pixel=$small.GetPixel($x,$y)
    $signature[$y*16+$x]=[byte](($pixel.R*30+$pixel.G*59+$pixel.B*11)/100)
  }
}
$signatureText=[Convert]::ToBase64String($signature)
$smallGraphics.Dispose();$small.Dispose()
$graphics.Dispose();$bitmap.Dispose()
Write-Output ("{0} {1} {2} {3} {4}" -f $bounds.Width,$bounds.Height,$bounds.X,$bounds.Y,$signatureText)
`);
    const [width, height, originX, originY, signature] = output.split(/\s+/);
    return {
      path: file,
      width: Number(width),
      height: Number(height),
      originX: Number(originX),
      originY: Number(originY),
      signature,
    };
  },

  /**
   * @description Identify the foreground window's title and process.
   *
   * Read before any proactive capture: it is how the monitor recognizes its own window and declines to
   * assess itself. The payload is base64'd across the process boundary because a window title is
   * arbitrary user text — quotes, newlines, and non-ASCII in a title would otherwise corrupt the
   * stdout parse. Failure degrades to empty strings rather than throwing: not knowing the title is not
   * a reason to break the loop.
   *
   * @returns {Promise<{title: string, process: string}>} Foreground window title and process name;
   * empty strings when it cannot be determined.
   */
  async foregroundInfo() {
    const output = await powershell(`
$handle=[CoderBotU32]::GetForegroundWindow()
$title=''
$processName=''
try {
  $process=[System.Diagnostics.Process]::GetProcessById((Get-Process | Where-Object MainWindowHandle -eq $handle | Select-Object -First 1 -ExpandProperty Id))
  $title=$process.MainWindowTitle
  $processName=$process.ProcessName
} catch {}
$payload=@{title=$title;process=$processName} | ConvertTo-Json -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
`);
    try {
      return JSON.parse(Buffer.from(output, 'base64').toString('utf8'));
    } catch {
      return { title: '', process: '' };
    }
  },

  /**
   * @description Delete one captured frame, and only if it lives directly in FRAME_DIR.
   *
   * The guard is the point of the function. Frame paths are passed around and, in the control loop,
   * sit alongside model-supplied data; a bare unlink would make cleanup a deletion primitive. The
   * check resolves the path first so `..` traversal cannot walk out of the directory. Callers invoke
   * this in a `finally` so an image of the user's screen does not outlive the analysis that needed it.
   *
   * @param {string} file Absolute path to a frame.
   * @returns {void} Silently does nothing for any path outside FRAME_DIR.
   */
  removeScreenshot(file) {
    if (file && path.dirname(path.resolve(file)) === path.resolve(FRAME_DIR)) {
      fs.rmSync(file, { force: true });
    }
  },

  /**
   * @description Move the cursor to an absolute screen coordinate.
   * @param {number} x Absolute X in physical pixels (DPI-aware thanks to the prelude).
   * @param {number} y Absolute Y in physical pixels.
   * @returns {Promise<void>}
   */
  async move(x, y) {
    await powershell(`[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)})`);
  },

  /**
   * @description Move, then synthesize a left click at that point.
   *
   * `mouse_event` down/up is used rather than a higher-level automation API so the click is
   * indistinguishable from a human one to the target app. The small sleeps matter: apps that sample
   * button state debounce a zero-duration press, and a double click needs a gap inside the system's
   * double-click time to register as one gesture rather than two clicks.
   *
   * @param {number} x Absolute X in physical pixels.
   * @param {number} y Absolute Y in physical pixels.
   * @param {object} [options] Click options.
   * @param {boolean} [options.double=false] Send a double click.
   * @returns {Promise<void>}
   */
  async click(x, y, { double = false } = {}) {
    await this.move(x, y);
    const once = '[CoderBotU32]::mouse_event(2,0,0,0,0);Start-Sleep -Milliseconds 30;[CoderBotU32]::mouse_event(4,0,0,0,0)';
    await powershell(double ? `${once};Start-Sleep -Milliseconds 70;${once}` : once);
  },

  /**
   * @description Type text into the focused field via clipboard paste.
   *
   * Paste is chosen over per-character `SendKeys` deliberately. `SendKeys` treats `+ ^ % ~ ( ) { }` as
   * modifier syntax, so literal code or a password-shaped string would be silently mangled or, worse,
   * turn into an unintended chord — and `~` is Enter, meaning a stray tilde in typed text could submit
   * a form. Routing through the clipboard makes the text opaque data. It is base64'd into PowerShell
   * for the same reason: the text never becomes script that could be reinterpreted. Note the tradeoff
   * this accepts: it replaces the user's clipboard contents.
   *
   * @param {string} text Literal text to insert.
   * @returns {Promise<void>}
   */
  async type(text) {
    const encoded = Buffer.from(String(text), 'utf8').toString('base64');
    await powershell(`
$bytes=[Convert]::FromBase64String('${encoded}')
$text=[Text.Encoding]::UTF8.GetString($bytes)
Set-Clipboard -Value $text
[System.Windows.Forms.SendKeys]::SendWait('^v')
`);
  },

  /**
   * @description Send a raw `SendKeys` sequence.
   *
   * This is the one primitive that can press Enter, so it is NOT the safety boundary — the control
   * agent allowlists `{TAB}`/`{ESC}` before it ever gets here, and the "blocks Enter even if a model
   * requests it" test pins that. Anything calling this directly is asserting the key is already
   * vetted. Quotes are doubled so a combo cannot terminate the PowerShell string literal.
   *
   * @param {string} combo A SendKeys token such as `{TAB}`.
   * @returns {Promise<void>}
   */
  async key(combo) {
    const safe = String(combo).replace(/'/g, "''");
    await powershell(`[System.Windows.Forms.SendKeys]::SendWait('${safe}')`);
  },

  /**
   * @description Scroll the wheel under the current cursor position.
   * @param {number} amount Notches; negative scrolls down. Multiplied by the 120-unit Windows wheel
   * delta so callers can reason in notches rather than raw device units.
   * @returns {Promise<void>}
   */
  async scroll(amount) {
    await powershell(`[CoderBotU32]::mouse_event(2048,0,0,${Math.round(Number(amount) * 120)},0)`);
  },

  /**
   * @description Sleep. Part of the Desktop surface rather than a local helper so an injected fake
   * desktop can make the control agent's pause polling and inter-action settle waits resolve
   * instantly, keeping the safety tests fast and deterministic.
   * @param {number} ms Milliseconds to wait.
   * @returns {Promise<void>}
   */
  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

module.exports = { Desktop, FRAME_DIR };
