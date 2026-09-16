/**
 * Guard for reading the operator's verification PAT out of .env.
 *
 * The gate reads OSHAL_VERIFY_OPERATOR_PAT from the environment, and nothing on the deploy path
 * sources .env — so a token the operator added there was inert, and the gate reported the same
 * UNVERIFIED as if none existed. A control that is present, configured as documented, and silently
 * does nothing is the exact failure this gate exists to catch, so the loader gets its own cases.
 *
 * These drive the real function out of the shipped scripts/lib/deploy-verify.sh in a real bash.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins that a PAT in .env is loaded AND EXPORTED (docker exec -e NAME resolves the name in this shell's exported environment, so a non-exported assignment is forwarded as an empty value and the probe refuses as if no token existed), that an environment value already present WINS over the file, that the common .env quoting shapes and a CRLF checkout are tolerated, that a missing file or key is not an error, and that the value never reaches stdout or stderr.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { VERIFY_LIB, resolveHostBash } from '../helpers/deploy-verify-shell';

/** A value that would be catastrophic to print; every case asserts it never appears. */
const TOKEN = 'oshpat_TESTONLY_not_a_real_credential_99';
const RUN_TIMEOUT_MS = 30_000;

let BASH = '';
beforeAll(() => { BASH = resolveHostBash(); });

interface Run { out: string; loaded: string; exported: string }

/**
 * @description Sources the shipped library, runs the real loader against a scratch .env, and
 * reports what the variable holds and whether it is exported.
 * @param envBody - Contents to write to the scratch .env (empty string writes no file).
 * @param preset - Value already in the environment before the loader runs, if any.
 * @returns The loader's output plus the resulting value and export state.
 */
function runLoader(envBody: string, preset?: string): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pat-'));
  if (envBody !== '') fs.writeFileSync(path.join(dir, '.env'), envBody);
  const script = path.join(dir, 'harness.sh');
  fs.writeFileSync(script, [
    'set -uo pipefail',
    `REPO_DIR='${dir.replace(/\\/g, '/')}'`,
    `. '${VERIFY_LIB.replace(/\\/g, '/')}'`,
    'oshal_verify_load_operator_pat',
    // `export -p` lists only EXPORTED names — a plain assignment would not appear.
    'printf "VALUE[%s]\\n" "${OSHAL_VERIFY_OPERATOR_PAT:-}"',
    'if export -p | grep -q "OSHAL_VERIFY_OPERATOR_PAT"; then printf "EXPORTED[yes]\\n"; else printf "EXPORTED[no]\\n"; fi',
  ].join('\n') + '\n');
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.OSHAL_VERIFY_OPERATOR_PAT;
  if (preset !== undefined) env.OSHAL_VERIFY_OPERATOR_PAT = preset;
  const r = spawnSync(BASH, [script.replace(/\\/g, '/')], { encoding: 'utf8', timeout: RUN_TIMEOUT_MS, env });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    out,
    loaded: (/VALUE\[(.*)\]/.exec(out) ?? [, ''])[1] as string,
    exported: (/EXPORTED\[(\w+)\]/.exec(out) ?? [, '?'])[1] as string,
  };
}

describe('the verification PAT is read from .env', () => {
  it('loads it, and EXPORTS it so docker exec -e NAME can resolve it', () => {
    const r = runLoader(`OSHAL_VERIFY_OPERATOR_PAT=${TOKEN}\n`);
    expect(r.loaded).toBe(TOKEN);
    // A plain assignment would be forwarded as a bare -e NAME with no value, and the probe would
    // refuse exactly as if no token existed. The export is the load-bearing half.
    expect(r.exported, 'the PAT was loaded but not exported').toBe('yes');
  });

  it('an environment value already present wins over the file', () => {
    const r = runLoader(`OSHAL_VERIFY_OPERATOR_PAT=${TOKEN}\n`, 'from-the-command-line');
    expect(r.loaded, 'the file overrode an explicit environment value').toBe('from-the-command-line');
  });

  it('tolerates the quoting a .env actually carries, and a CRLF checkout', () => {
    expect(runLoader(`OSHAL_VERIFY_OPERATOR_PAT="${TOKEN}"\n`).loaded).toBe(TOKEN);
    expect(runLoader(`OSHAL_VERIFY_OPERATOR_PAT='${TOKEN}'\n`).loaded).toBe(TOKEN);
    expect(runLoader(`OSHAL_VERIFY_OPERATOR_PAT=${TOKEN}\r\n`).loaded).toBe(TOKEN);
    expect(runLoader(`# a comment\nOTHER=1\nOSHAL_VERIFY_OPERATOR_PAT=${TOKEN}\nMORE=2\n`).loaded).toBe(TOKEN);
  });

  it('is silent and harmless when the file or the key is absent', () => {
    expect(runLoader('').loaded).toBe('');
    expect(runLoader('SOMETHING_ELSE=1\n').loaded).toBe('');
    expect(runLoader('').out).not.toMatch(/error|not found/i);
  });

  it('never prints the value', () => {
    const r = runLoader(`OSHAL_VERIFY_OPERATOR_PAT=${TOKEN}\n`);
    // The harness echoes it deliberately; the LOADER itself must contribute nothing.
    const loaderOutput = r.out.replace(/VALUE\[.*\]/g, '');
    expect(loaderOutput, 'the loader printed the credential').not.toContain(TOKEN);
  });
});
