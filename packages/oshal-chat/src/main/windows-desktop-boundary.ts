/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add a non-destructive Windows acceptance runner that captures the real desktop and exercises the PowerShell/user32 input path by restoring the cursor to its current physical position.
 */

import { app } from 'electron';
import { captureScreen, controlInput, runShell } from './system-tools';

interface CursorPoint {
  x: number;
  y: number;
}

const CURSOR_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CursorBoundary {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
}
'@
$point = New-Object CursorBoundary+Point
if (-not [CursorBoundary]::GetCursorPos([ref]$point)) { throw 'GetCursorPos failed' }
Write-Output "$($point.X),$($point.Y)"
`;

async function readPhysicalCursor(): Promise<CursorPoint> {
  const result = await runShell(CURSOR_SCRIPT, 10_000);
  if (!result.success) throw new Error(result.stderr || 'cursor query failed');
  const match = result.stdout.trim().match(/^(-?\d+),(-?\d+)$/);
  if (!match) throw new Error('cursor query returned an invalid coordinate');
  return { x: Number(match[1]), y: Number(match[2]) };
}

async function verifyDesktopBoundary(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows desktop boundary requires win32');
  await app.whenReady();
  const capture = await captureScreen(640);
  if (!capture.success || !capture.dataUrl?.startsWith('data:image/png;base64,')) {
    throw new Error(capture.error || 'desktop capture did not return a PNG');
  }
  if (!capture.width || !capture.height || !capture.physicalWidth || !capture.physicalHeight) {
    throw new Error('desktop capture omitted coordinate metrics');
  }
  const before = await readPhysicalCursor();
  const input = await controlInput({ kind: 'move', ...before, coordinateSpace: 'physical' });
  if (!input.success || input.via !== 'powershell') throw new Error(input.error || 'user32 input failed');
  const after = await readPhysicalCursor();
  if (after.x !== before.x || after.y !== before.y) throw new Error('cursor did not remain at its requested position');
  process.stdout.write(`${JSON.stringify({
    capture: `${capture.width}x${capture.height}`,
    physical: `${capture.physicalWidth}x${capture.physicalHeight}`,
    pngBytes: Buffer.from(capture.dataUrl.slice('data:image/png;base64,'.length), 'base64').length,
    input: input.via,
  })}\n`);
}

void verifyDesktopBoundary()
  .then(() => app.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`Windows desktop boundary failed: ${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  });
