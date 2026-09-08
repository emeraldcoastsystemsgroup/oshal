/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the node app's vendor-login launcher, which failed on EVERY account row with the shell dialog "Windows cannot find 'login\'". The defect lived in the command line cmd.exe actually received, so a spec over the argv array alone would have passed while the product stayed broken: on Windows this runs the REAL cmd.exe and asserts the line it tokenizes, proves the old pre-quoted-title shape still reproduces the exact failure, and launches a probe through the real `start` to prove a command runs. Off Windows the quote-free/shape assertions stand, mirroring installer-scripts-parse.spec.ts.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  WINDOWS_LOGIN_TITLE,
  accountStatus,
  windowsLoginArgv,
} from '../../packages/oshal-chat/src/main/auth-manager';

const isWindows = process.platform === 'win32';

/** The exact argv the launcher used before the fix — kept so the guard can prove the failure. */
const BROKEN_ARGV = ['/c', 'start', '"OSHAL login"', 'cmd', '/k', 'claude /login'];

/**
 * @description Runs the real cmd.exe over an argv with `start` swapped for `echo`, returning the
 *   line cmd tokenized — i.e. exactly what `start` would have been handed. No window is opened.
 * @param argv - The cmd.exe argv to inspect.
 * @returns What cmd.exe echoed back.
 */
function tokenizedByCmd(argv: string[]): string {
  const probe = argv.map((a) => (a === 'start' ? 'echo' : a));
  return String(spawnSync('cmd.exe', probe, { encoding: 'utf8' }).stdout).trim();
}

/** A writable directory with no space in its path (the probe command is a bare path). */
function spaceFreeDir(): string {
  const base = /\s/.test(tmpdir()) ? process.cwd() : tmpdir();
  return mkdtempSync(join(base, 'oshal-login-probe-'));
}

const probeDirs: string[] = [];
afterAll(() => { for (const d of probeDirs) rmSync(d, { recursive: true, force: true }); });

describe('@oshal/chat login launcher — the argv that reaches cmd.exe', () => {
  it('never hands cmd.exe an argument carrying a quote — that is what broke it', () => {
    // libuv escapes a quote inside an argument as \" , which is a C-runtime convention cmd.exe
    // does not implement: it counts quotes instead, re-tokenizes, and `start` reads the wreckage
    // as a program name. So quoting is libuv's job alone, and no entry here may contain one.
    for (const argv of [windowsLoginArgv('claude auth login'), windowsLoginArgv('codex login')]) {
      for (const entry of argv) expect(entry).not.toContain('"');
    }
  });

  it('splits the vendor command into its own entries and keeps the title as one unquoted entry', () => {
    expect(windowsLoginArgv('claude auth login'))
      .toEqual(['/c', 'start', WINDOWS_LOGIN_TITLE, 'cmd', '/k', 'claude', 'auth', 'login']);
    // The title must contain a space: that is what makes libuv quote it, and an UNQUOTED first
    // token is read by `start` as the command to run, not as a title.
    expect(WINDOWS_LOGIN_TITLE).toMatch(/\S\s\S/);
  });

  it('launches each vendor CLI with the login verb that CLI actually has', () => {
    const cmds = new Map(accountStatus().map((a) => [a.id, a.loginCmd]));
    // `claude /login` is a REPL slash command; as an argv the CLI reads it as a prompt.
    expect(cmds.get('claude')).toBe('claude auth login');
    expect(cmds.get('codex')).toBe('codex login');
    expect(cmds.get('gcloud')).toBe('gcloud auth login');
    expect(cmds.get('aws')).toBe('aws sso login');
    for (const cmd of cmds.values()) expect(cmd).not.toContain('"');
  });
});

describe.skipIf(!isWindows)('@oshal/chat login launcher — against the real cmd.exe', () => {
  it('hands `start` a quoted title followed by the intact command', () => {
    expect(tokenizedByCmd(windowsLoginArgv('claude auth login')))
      .toBe(`"${WINDOWS_LOGIN_TITLE}" cmd /k claude auth login`);
    expect(tokenizedByCmd(windowsLoginArgv('codex login')))
      .toBe(`"${WINDOWS_LOGIN_TITLE}" cmd /k codex login`);
  });

  it('still reproduces the original defect for the pre-quoted-title argv', () => {
    // Proof the fix addresses the reported failure rather than something adjacent: cmd splits the
    // escaped title, and the token `start` would run as a program is `login\` — the exact name in
    // the operator's "Windows cannot find 'login\'" dialog.
    const tokens = tokenizedByCmd(BROKEN_ARGV).split(/\s+/);
    expect(tokens[0]).toBe('"\\"OSHAL');
    expect(tokens[1]).toBe('login\\""');
    expect(tokens[1].replace(/"/g, '')).toBe('login\\');
  });

  it('really launches the command through `start`', async () => {
    const dir = spaceFreeDir();
    probeDirs.push(dir);
    const marker = join(dir, 'marker.txt');
    const bat = join(dir, 'probe.bat');
    // The marker path is quoted INSIDE the .bat, so only the .bat's own path must be space-free.
    writeFileSync(bat, `@echo off\r\n> "${marker}" echo LAUNCHED\r\n`);

    // /c instead of /k so the probe console closes itself.
    const argv = windowsLoginArgv(bat).map((a) => (a === '/k' ? '/c' : a));
    spawn('cmd.exe', argv, { detached: true, stdio: 'ignore', windowsHide: false }).unref();

    for (let i = 0; i < 60 && !existsSync(marker); i += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 250); });
    }
    expect(existsSync(marker), 'start never ran the command it was given').toBe(true);
  }, 30_000);
});
