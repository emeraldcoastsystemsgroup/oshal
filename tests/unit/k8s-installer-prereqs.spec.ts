/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the k8s installer's prerequisite bootstrap (operator: the installer should include the prereqs). The behavior that matters is a SAFETY property, so it is tested by RUNNING the real script rather than grepping it: with kubectl/helm absent and no tty, it must exit non-zero, name the missing tool, and install NOTHING — a `curl | bash` that silently sudo-installs packages on a non-interactive host is the failure mode this bootstrap could most easily become. Also pins the two-substrate offer (k3s on Linux, kind where Docker is), the compose-swarm refusal (kind beside the swarm OOM-wedged a 6GB engine twice), and bash/ps1 flag lockstep.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SH = path.join(REPO_ROOT, 'scripts', 'oshal-install.sh');
const PS1 = path.join(REPO_ROOT, 'scripts', 'oshal-install.ps1');
const shSource = fs.readFileSync(SH, 'utf8');
const ps1Source = fs.readFileSync(PS1, 'utf8');

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * @description Absolute path to bash, plus a MINIMAL PATH that still contains the
 * POSIX tools the script needs. Both are platform-specific: on Windows the shell
 * is git-bash and a bare "/usr/bin:/bin" is meaningless to process spawning, so
 * the sibling usr/bin of the resolved bash.exe is used instead.
 * @returns {{bash: string, minimalPath: string} | null} null when no bash exists
 */
function resolveBash(): { bash: string; minimalPath: string } | null {
  if (process.platform !== 'win32') {
    return fs.existsSync('/bin/bash') ? { bash: '/bin/bash', minimalPath: '/usr/bin:/bin' } : null;
  }
  const probe = spawnSync('where', ['bash'], { encoding: 'utf8' });
  const bash = (probe.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith('bash.exe'));
  if (!bash || !fs.existsSync(bash)) return null;
  // .../Git/bin/bash.exe or .../Git/usr/bin/bash.exe -> keep both tool dirs.
  const binDir = path.dirname(bash);
  const gitRoot = path.basename(path.dirname(binDir)).toLowerCase() === 'usr' ? path.dirname(path.dirname(binDir)) : path.dirname(binDir);
  return { bash, minimalPath: [binDir, path.join(gitRoot, 'usr', 'bin')].join(path.delimiter) };
}

const BASH = resolveBash();

/**
 * @description Run the installer with a minimal PATH (so kubectl/helm/docker are
 * genuinely absent) and a sandboxed HOME, with stdin closed so the script sees a
 * non-interactive host.
 * @param args installer arguments
 * @returns {{status: number|null, out: string, home: string}}
 */
function runWithoutTools(args: string[]): { status: number | null; out: string; home: string } {
  if (!BASH) throw new Error('bash not found — this guard requires a POSIX shell (git-bash on Windows)');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-k8s-prereq-'));
  sandboxes.push(home);
  const res = spawnSync(BASH.bash, [SH, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: BASH.minimalPath, HOME: home, TMPDIR: home, SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`, home };
}

describe('k8s installer prerequisites — never surprise-install', () => {
  it('a non-interactive host is TOLD what is missing and nothing is installed', () => {
    const { status, out, home } = runWithoutTools(['--mode', '4', '--dir', 'sandbox']);
    expect(status, 'a missing prerequisite must fail the install, not proceed').not.toBe(0);
    expect(out).toMatch(/kubectl is not installed/i);
    expect(out).toMatch(/kubernetes\.io\/docs\/tasks\/tools/);
    // The decisive assertion: no binary was fetched into the sandboxed HOME.
    const localBin = path.join(home, '.local', 'bin');
    const installed = fs.existsSync(localBin) ? fs.readdirSync(localBin) : [];
    expect(installed, 'a non-interactive run must never install anything').toEqual([]);
  }, 120_000);

  it('--dry-run prints the plan and never reaches the prerequisite step', () => {
    const { status, out, home } = runWithoutTools(['--mode', '4', '--dry-run', '--dir', 'sandbox']);
    expect(status).toBe(0);
    expect(out).toMatch(/DRY RUN/);
    expect(out).toMatch(/mode=4 \(kubernetes\)/);
    expect(out).not.toMatch(/is not installed/);
    expect(fs.existsSync(path.join(home, '.local', 'bin'))).toBe(false);
  }, 120_000);
});

describe('k8s installer prerequisites — the bootstrap contract', () => {
  it('bash installs kubectl and helm from their official sources', () => {
    expect(shSource).toContain('install_kubectl');
    expect(shSource).toContain('install_helm');
    expect(shSource).toMatch(/dl\.k8s\.io\/release/);
    expect(shSource).toMatch(/get-helm-3/);
  });

  it('bash offers BOTH substrates: k3s on Linux, kind wherever Docker is', () => {
    expect(shSource).toMatch(/get\.k3s\.io/);
    expect(shSource).toMatch(/kind\.sigs\.k8s\.io\/dl/);
    // k3s must be gated to Linux — it is a systemd service, not a macOS/Windows thing.
    const k3sLine = shSource.split('\n').findIndex((l) => l.includes('get.k3s.io'));
    const linuxGuard = shSource.split('\n').slice(0, k3sLine).reverse().findIndex((l) => l.includes('$OSK" = linux'));
    expect(linuxGuard, 'the k3s install must sit inside a Linux guard').toBeGreaterThan(-1);
  });

  it('both installers refuse to create kind beside a running compose swarm', () => {
    // Proven twice on a 6GB engine: that pairing OOM-wedges Docker.
    for (const [label, src] of [['bash', shSource], ['ps1', ps1Source]] as const) {
      expect(src, `${label}: lost the compose-swarm refusal`).toMatch(/oshal-local-api/);
      expect(src, `${label}: lost the refusal message`).toMatch(/Refusing to create a kind cluster/);
    }
  });

  it('both installers expose an unattended consent flag and default to asking', () => {
    expect(shSource).toMatch(/--yes\|-y\)/);
    expect(shSource).toMatch(/ASSUME_YES=0/);
    expect(ps1Source).toMatch(/\[switch\]\$Yes/);
    // Non-interactive must DECLINE, not proceed: both guard on interactivity.
    expect(shSource).toMatch(/\[ -t 0 \] \|\| return 1/);
    expect(ps1Source).toContain('if (-not [Environment]::UserInteractive) { return $false }');
  });

  it('ps1 re-reads PATH after winget so the run continues in-session', () => {
    // winget writes PATH to the registry, not the current process. Without this the
    // installer could only tell the user to open a new terminal and start over.
    expect(ps1Source).toContain('Update-SessionPath');
    expect(ps1Source).toMatch(/GetEnvironmentVariable\('Path', 'Machine'\)/);
    const installToolIdx = ps1Source.indexOf('function Install-Tool');
    const refreshIdx = ps1Source.indexOf('Update-SessionPath', installToolIdx);
    expect(refreshIdx, 'Install-Tool must refresh PATH after winget').toBeGreaterThan(installToolIdx);
  });

  it('ps1 offers every Windows prerequisite by winget id', () => {
    for (const id of ['Kubernetes.kubectl', 'Helm.Helm', 'Kubernetes.kind', 'Docker.DockerDesktop']) {
      expect(ps1Source, `missing winget id ${id}`).toContain(id);
    }
  });
});
