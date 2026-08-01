'use strict';
/**
 * @description Real desktop control on Windows — zero native deps, pure
 * PowerShell/.NET. Moves the operator's ACTUAL cursor, clicks the ACTUAL
 * buttons, types into the ACTUAL focused app, and screenshots the ACTUAL screen.
 * This is what the Codex computer-use loop (src/agent/loop.js) drives.
 *
 * Coordinates are physical screen pixels. We force per-process DPI awareness so
 * the screenshot pixel space == the cursor pixel space (no scaling mismatch).
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { pairedTyper } = require('./paired-typer');

// PowerShell prelude: DPI-aware + load Forms/Drawing + a user32 shim for clicks.
const PRELUDE = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing | Out-Null
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class U32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int ei);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@ | Out-Null
# PER_MONITOR_AWARE_V2 (-4): physical-pixel coords consistent across mixed-DPI
# monitors so screenshot pixels == cursor/click pixels on EVERY screen. Fall back
# to system DPI awareness on older Windows.
try { [U32]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { [U32]::SetProcessDPIAware() | Out-Null }
`;

const SCREEN_DIR = path.join(os.tmpdir(), 'oshal-vids-frames');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

/** Run a PowerShell snippet (prelude prepended), resolve stdout. */
function ps(script, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PRELUDE + script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) reject(new Error(`powershell exited ${code}: ${err.trim().slice(0, 300)}`));
      else resolve(out.trim());
    });
  });
}

// mouse_event flags
const MOVE = 0x0001;
const LDOWN = 0x0002;
const LUP = 0x0004;
const RDOWN = 0x0008;
const RUP = 0x0010;
const WHEEL = 0x0800;

const Desktop = {
  /**
   * Capture ONE monitor (not the whole multi-monitor desktop) so UI is big and
   * targetable. Defaults to the primary screen; VIDS_MONITOR=<index> picks another
   * (the one your Vids window is on). Returns { path, width, height, originX, originY }
   * where origin is that monitor's offset in virtual-desktop coords.
   */
  async screenshot() {
    const file = path.join(SCREEN_DIR, 'frame.png');
    const mon = /^\d+$/.test(process.env.VIDS_MONITOR || '') ? process.env.VIDS_MONITOR : '';
    // No explicit monitor → capture the screen the FOREGROUND window is on, so the
    // capture follows whatever app is in front (Vids, after we bring it forward).
    const out = await ps(`
$scr = if ('${mon}' -ne '') { [System.Windows.Forms.Screen]::AllScreens[[int]'${mon}'] } else { [System.Windows.Forms.Screen]::FromHandle([U32]::GetForegroundWindow()) }
$b=$scr.Bounds
$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size)
$bmp.Save('${file.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose()
Write-Output ("{0} {1} {2} {3}" -f $b.Width,$b.Height,$b.X,$b.Y)
`);
    const [w, h, ox, oy] = out.split(/\s+/).map(Number);
    return { path: file, width: w, height: h, originX: ox, originY: oy };
  },

  /** List monitors (index, bounds, primary) so the operator can pick VIDS_MONITOR. */
  async monitors() {
    const out = await ps(`
$i=0
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  Write-Output ("{0} {1}x{2} @{3},{4} primary={5}" -f $i,$_.Bounds.Width,$_.Bounds.Height,$_.Bounds.X,$_.Bounds.Y,$_.Primary)
  $i++
}
`);
    return out.split(/\r?\n/).filter(Boolean);
  },

  /** Move the real cursor to absolute screen px (accounts for virtual-screen origin). */
  async move(x, y) {
    await ps(`[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})`);
  },

  async click(x, y, { button = 'left', double = false } = {}) {
    await this.move(x, y);
    const down = button === 'right' ? RDOWN : LDOWN;
    const up = button === 'right' ? RUP : LUP;
    const once = `[U32]::mouse_event(${down},0,0,0,0);Start-Sleep -Milliseconds 30;[U32]::mouse_event(${up},0,0,0,0)`;
    await ps(double ? `${once};Start-Sleep -Milliseconds 60;${once}` : once);
  },

  /**
   * Type arbitrary text. Normal mode uses clipboard paste. In paired mode each
   * physical non-modifier keypress advances one prepared character.
   */
  async type(text) {
    if (pairedTyper.snapshot().enabled) return pairedTyper.type(text);
    const safe = String(text).replace(/'/g, "''");
    await ps(`Set-Clipboard -Value '${safe}'`);
    await this.key('^v');
  },

  async setPairedTyping(enabled) {
    return enabled ? pairedTyper.enable() : pairedTyper.disable();
  },

  pairedTypingState() {
    return pairedTyper.snapshot();
  },

  onPairedTyping(listener) {
    pairedTyper.on('state', listener);
    return () => pairedTyper.off('state', listener);
  },

  pauseTyping() {
    pairedTyper.pause();
  },

  resumeTyping() {
    pairedTyper.resume();
  },

  cancelTyping(reason = 'operator') {
    pairedTyper.cancel(reason);
  },

  /** Send a SendKeys combo, e.g. '^a' (ctrl+a), '{ENTER}', '%{F4}'. */
  async key(combo) {
    const safe = String(combo).replace(/'/g, "''");
    await ps(`[System.Windows.Forms.SendKeys]::SendWait('${safe}')`);
  },

  async scroll(amount) {
    // positive = up, negative = down; one notch ~ 120
    await ps(`[U32]::mouse_event(${WHEEL},0,0,${Math.round(amount * 120)},0)`);
  },

  async wait(ms) {
    await new Promise((r) => setTimeout(r, ms));
  },

  /**
   * Open a URL in the default browser and bring it to the FRONT. This anchors the
   * agent: before a web task it must actually be looking at the right site, not at
   * the chat panel or whatever window happened to be focused.
   */
  async openSite(url) {
    const safe = String(url).replace(/'/g, "''");
    // Open the URL, let the browser take focus, then MAXIMIZE the foreground window
    // so the screenshot layout is predictable (floating/half windows broke the locates).
    await ps(`Start-Process '${safe}'; Start-Sleep -Milliseconds 4000; [U32]::ShowWindow([U32]::GetForegroundWindow(), 3) | Out-Null`, 20_000);
  },
};

// Headless/worker opt-in. The control-panel toggle is preferred.
if (process.env.VIDS_PAIRED_TYPING === '1') {
  pairedTyper.enable().catch(() => {});
}

module.exports = { Desktop };
