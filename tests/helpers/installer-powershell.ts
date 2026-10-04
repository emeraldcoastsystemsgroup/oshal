/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared helpers for guards that execute the SHIPPED Windows installer functions under real PowerShell: a load-insensitive executable lookup, a brace-counted function extractor, literal quoting, and a probe runner that dot-sources the real installer/lib/common.ps1. Same technique as installer-offlan-refusal.spec.ts, extracted so new installer guards do not copy it.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Repository root (vitest runs from it). */
export const INSTALLER_REPO_ROOT = process.cwd();
/** The shipped Windows installer flow. */
export const INSTALL_SWARM_PS1 = path.join(INSTALLER_REPO_ROOT, 'installer', 'lib', 'install-swarm.ps1');
/** The shipped helper library the installer dot-sources. */
export const INSTALLER_COMMON_PS1 = path.join(INSTALLER_REPO_ROOT, 'installer', 'lib', 'common.ps1');

/**
 * @description Resolves a PowerShell executable by inspecting the filesystem only. Probing by
 * running one made an earlier guard flaky under load; existence checks are load-insensitive.
 * @returns An absolute path to powershell/pwsh, or null when this machine has neither.
 */
export function findPowerShell(): string | null {
  const candidates: string[] = [];
  const sysRoot = process.env.SystemRoot || process.env.windir;
  if (sysRoot) candidates.push(path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const base of ['pwsh', 'powershell']) {
      for (const ext of exts) candidates.push(path.join(dir, base + ext));
    }
  }
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

/**
 * @description Cuts one whole `function Name { ... }` block out of a PowerShell script,
 * brace-counted so the guard executes the complete shipped function.
 * @param script - The PowerShell source.
 * @param name - The function to cut out.
 * @returns The function text, or null when the script defines no such function.
 */
export function extractPowerShellFunction(script: string, name: string): string | null {
  const start = script.indexOf(`function ${name} {`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    else if (script[i] === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * @description A single-quoted PowerShell string literal (`''` escapes a quote).
 * @param value - The string.
 * @returns The literal.
 */
export function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * @description Runs probe lines under the installer's strict mode with the real common.ps1
 * dot-sourced first. The common.ps1 path travels in the environment because Windows
 * command-line parsing eats the backslashes of an embedded absolute path.
 * @param powershell - The PowerShell executable.
 * @param probeLines - PowerShell statements to run after common.ps1 is loaded.
 * @returns The exit status and combined output.
 */
export function runInstallerProbe(powershell: string, probeLines: string[]): { status: number | null; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-installer-probe-'));
  try {
    const probe = path.join(dir, 'probe.ps1');
    const lines = ['Set-StrictMode -Version Latest', "$ErrorActionPreference = 'Stop'", '. $env:OSHAL_COMMON_PS1', '', ...probeLines];
    fs.writeFileSync(probe, lines.join('\r\n'));
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe], {
      encoding: 'utf8', timeout: 120_000, cwd: INSTALLER_REPO_ROOT, windowsHide: true,
      env: { ...process.env, OSHAL_COMMON_PS1: INSTALLER_COMMON_PS1 },
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
