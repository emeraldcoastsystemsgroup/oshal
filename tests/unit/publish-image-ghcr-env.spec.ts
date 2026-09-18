/**
 * Guard for reading the image-publish credential out of .env.
 *
 * publish-image.sh reads OSHAL_GHCR_TOKEN / OSHAL_GHCR_USER from the environment, and the nightly
 * launcher's environment is the scheduled task's, not .env - so a token the operator added there
 * was inert and the gate refused exactly as if no token existed. A control that is present,
 * configured as documented, and silently does nothing is the failure this gate exists to catch.
 *
 * These drive the real loader out of the shipped scripts/lib/ghcr-env.sh in a real bash.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - pins that both names are loaded AND EXPORTED (the publisher is a child process; a plain assignment would leave it refusing as if no token existed), that an environment value already present wins over the file, that .env quoting and a CRLF checkout are tolerated, that a missing file or key is a silent no-op so the publisher's own refusal still fires, and that the value never reaches stdout or stderr.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveHostBash } from '../helpers/deploy-verify-shell';

const LIB = path.resolve('scripts/lib/ghcr-env.sh');
/** A value that would be catastrophic to print; every case asserts it never appears. */
const TOKEN = 'gho_TESTONLY_not_a_real_credential_0000000000';
const RUN_TIMEOUT_MS = 30_000;

let BASH = '';
beforeAll(() => { BASH = resolveHostBash(); });

interface Run { out: string; token: string; user: string; exported: string }

/**
 * @description Sources the shipped library, runs the real loader against a scratch .env, and
 * reports what the two variables hold and whether the token is exported.
 * @param envBody - Contents to write to the scratch .env (empty string writes no file).
 * @param preset - Values already in the environment before the loader runs, if any.
 * @returns The loader's output plus the resulting values and export state.
 */
function runLoader(envBody: string, preset: Record<string, string> = {}): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcr-env-'));
  if (envBody !== '') fs.writeFileSync(path.join(dir, '.env'), envBody);
  const script = path.join(dir, 'harness.sh');
  fs.writeFileSync(script, [
    'set -uo pipefail',
    `REPO_DIR='${dir.replace(/\\/g, '/')}'`,
    `. '${LIB.replace(/\\/g, '/')}'`,
    'oshal_ghcr_load_env',
    'printf "TOKEN[%s]\\n" "${OSHAL_GHCR_TOKEN:-}"',
    'printf "USER[%s]\\n" "${OSHAL_GHCR_USER:-}"',
    // `export -p` lists only EXPORTED names - a plain assignment would not appear.
    'if export -p | grep -q "OSHAL_GHCR_TOKEN="; then printf "EXPORTED[yes]\\n"; else printf "EXPORTED[no]\\n"; fi',
  ].join('\n') + '\n');
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.OSHAL_GHCR_TOKEN;
  delete env.OSHAL_GHCR_USER;
  Object.assign(env, preset);
  const r = spawnSync(BASH, [script.replace(/\\/g, '/')], { encoding: 'utf8', timeout: RUN_TIMEOUT_MS, env });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    out,
    token: (/TOKEN\[(.*)\]/.exec(out) ?? [, ''])[1] as string,
    user: (/USER\[(.*)\]/.exec(out) ?? [, ''])[1] as string,
    exported: (/EXPORTED\[(\w+)\]/.exec(out) ?? [, '?'])[1] as string,
  };
}

describe('the image-publish credential is read from .env', () => {
  it('loads both names, and EXPORTS them so the publisher child process can see them', () => {
    const r = runLoader(`OSHAL_GHCR_TOKEN=${TOKEN}\nOSHAL_GHCR_USER=someorg\n`);
    expect(r.token).toBe(TOKEN);
    expect(r.user).toBe('someorg');
    expect(r.exported, 'the token was loaded but not exported').toBe('yes');
  });

  it('an environment value already present wins over the file', () => {
    const r = runLoader(`OSHAL_GHCR_TOKEN=${TOKEN}\nOSHAL_GHCR_USER=fileorg\n`,
      { OSHAL_GHCR_TOKEN: 'from-the-command-line', OSHAL_GHCR_USER: 'envorg' });
    expect(r.token).toBe('from-the-command-line');
    expect(r.user).toBe('envorg');
  });

  it('tolerates the quoting a .env actually carries, and a CRLF checkout', () => {
    expect(runLoader(`OSHAL_GHCR_TOKEN="${TOKEN}"\nOSHAL_GHCR_USER="o"\n`).token).toBe(TOKEN);
    expect(runLoader(`OSHAL_GHCR_TOKEN='${TOKEN}'\nOSHAL_GHCR_USER='o'\n`).token).toBe(TOKEN);
    expect(runLoader(`OSHAL_GHCR_TOKEN=${TOKEN}\r\nOSHAL_GHCR_USER=o\r\n`).user).toBe('o');
    expect(runLoader(`# comment\nOTHER=1\nOSHAL_GHCR_TOKEN=${TOKEN}\nMORE=2\nOSHAL_GHCR_USER=o\n`).token).toBe(TOKEN);
  });

  it('is a silent no-op when the file or the names are absent, so the publisher still refuses', () => {
    expect(runLoader('').token).toBe('');
    expect(runLoader('SOMETHING_ELSE=1\n').user).toBe('');
    expect(runLoader('').out).not.toMatch(/error|not found/i);
  });

  it('never prints the value', () => {
    const r = runLoader(`OSHAL_GHCR_TOKEN=${TOKEN}\nOSHAL_GHCR_USER=o\n`);
    // The harness echoes it deliberately; the LOADER itself must contribute nothing.
    const loaderOutput = r.out.replace(/TOKEN\[.*\]/g, '');
    expect(loaderOutput, 'the loader printed the credential').not.toContain(TOKEN);
  });
});
