/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | --from-archive selected the REGISTRY default image and never consulted what `docker load` produced, so an archive built with any other tag loaded fine and then every later step pointed at an image that was never on the box: `docker create "$IMAGE"` to extract compose.dist.yml, and OSHAL_BOT_IMAGE in the generated .env. Offline there is no pull to paper over it. EXECUTED in a real bash with a stub `docker` first on PATH, because the whole defect is what a shell does with command output and no reading of the script shows it - the branch looks correct until you notice IMAGE was assigned two hundred lines earlier. The stub is outside the boundary: what docker does with a tar is not the claim, only what the installer does with the line docker prints.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const NEWLINE = String.fromCharCode(10);
const SH = join(process.cwd(), 'scripts/oshal-install.sh');

/**
 * `C:/x` -> `/c/x`. A drive-letter colon inside PATH is read as the PATH SEPARATOR, so exporting
 * a Windows-form directory silently puts nothing usable on PATH and the stub is never found —
 * which presents as the script failing for an unrelated reason.
 */
function toMsysPath(p: string): string {
  const forward = p.split('\\').join('/');
  return /^[A-Za-z]:\//.test(forward)
    ? `/${forward[0].toLowerCase()}/${forward.slice(3)}`
    : forward;
}

/** Git Bash by path — System32\bash.exe is WSL and would not see this checkout. */
function bashPath(): string {
  for (const candidate of ['C:/Program Files/Git/bin/bash.exe', '/usr/bin/bash', '/bin/bash']) {
    try { execSync(`"${candidate}" -c "exit 0"`, { stdio: 'ignore' }); return candidate; } catch { /* next */ }
  }
  throw new Error('no usable bash found — this guard must fail loudly, not skip');
}

/** The real archive branch, lifted out of the mode dispatch so nothing else runs. */
function archiveBranch(): string {
  const text = readFileSync(SH, 'utf8');
  const start = text.indexOf('elif [ -n "$FROM_ARCHIVE" ]; then');
  expect(start, 'the --from-archive branch is gone').toBeGreaterThan(-1);
  const end = text.indexOf('\nelse\n', start);
  expect(end, 'could not find the end of the archive branch').toBeGreaterThan(start);
  // Turn the `elif` into a plain `if` so it stands alone.
  return `if [ -n "$FROM_ARCHIVE" ]; then${text.slice(start + 'elif [ -n "$FROM_ARCHIVE" ]; then'.length, end)}\nfi\n`;
}

/** Run the branch with a stub `docker load` printing `loadOutput`; returns the resulting IMAGE. */
function imageAfterLoad(loadOutput: string): { image: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-archive-'));
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    // A stub docker that prints exactly what the real one would for this archive.
    const stub = join(binDir, 'docker');
    writeFileSync(stub, [
      '#!/usr/bin/env bash',
      'if [ "$1" = "load" ]; then',
      `  cat <<'LOADEOF'${NEWLINE}${loadOutput}${NEWLINE}LOADEOF`,
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join(NEWLINE), 'utf8');
    chmodSync(stub, 0o755);

    const archive = join(dir, 'swarm.tar');
    writeFileSync(archive, 'not a real tar — the stub never reads it', 'utf8');

    const script = join(dir, 'run.sh');
    writeFileSync(script, [
      'set -euo pipefail',
      `export PATH="${toMsysPath(binDir)}:$PATH"`,
      'say() { echo "say: $*"; }',
      `FROM_ARCHIVE="${toMsysPath(archive)}"`,
      // What the script had already decided before the branch runs — the registry default.
      'IMAGE="ghcr.io/emeraldcoastsystemsgroup/oshal-bot:latest"',
      'COMPOSE_SRC="unset"',
      archiveBranch(),
      'echo "RESULT_IMAGE=$IMAGE"',
      '',
    ].join(NEWLINE), 'utf8');

    const res = spawnSync(bashPath(), [script], { encoding: 'utf8' });
    const match = /RESULT_IMAGE=(.*)/.exec(String(res.stdout));
    expect(match, `the branch did not run to completion:${NEWLINE}${res.stdout}${res.stderr}`).toBeTruthy();
    return { image: String(match?.[1]).trim(), stderr: String(res.stderr) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('--from-archive installs the image the archive actually contains', () => {
  it('a single loaded image becomes IMAGE, overriding the registry default', () => {
    const { image } = imageAfterLoad('Loaded image: oshal-bot:2026-09-19-offline');
    expect(image, 'the registry default survived — nothing consulted docker load')
      .toBe('oshal-bot:2026-09-19-offline');
  });

  it('an archive carrying several images picks the swarm one, not whatever came first', () => {
    const { image } = imageAfterLoad([
      'Loaded image: postgres:16-alpine',
      'Loaded image: oshal-bot:2026-09-19-offline',
      'Loaded image: redis:7-alpine',
    ].join(NEWLINE));
    expect(image).toBe('oshal-bot:2026-09-19-offline');
  });

  it('with no oshal-bot image it takes the first tag rather than the registry default', () => {
    const { image } = imageAfterLoad('Loaded image: someones-fork/swarm:custom');
    expect(image).toBe('someones-fork/swarm:custom');
  });

  it('an UNTAGGED load says so on stderr instead of proceeding silently', () => {
    // `Loaded image ID: sha256:…` has no tag to use. Keeping the registry default is the only
    // option, but it must not be silent — offline there is no pull to discover it later.
    const { image, stderr } = imageAfterLoad('Loaded image ID: sha256:abc123def456');
    expect(image, 'an untagged load should leave the default in place').toBe(
      'ghcr.io/emeraldcoastsystemsgroup/oshal-bot:latest',
    );
    expect(stderr, 'the untagged load was silent').toMatch(/no tagged image/i);
  });

  it('the branch still refuses a missing archive file', () => {
    // The fix must not have swallowed the existence check that was already there.
    const text = readFileSync(SH, 'utf8');
    expect(text).toContain('archive not found: $FROM_ARCHIVE');
  });
});
