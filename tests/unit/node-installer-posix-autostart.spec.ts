/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the login item the macOS/Linux one-click installer writes: the rendered script is EXECUTED by a real bash in a throwaway HOME, and the LaunchAgent / XDG autostart entry is read back off the filesystem, so "it comes back after a restart" is measured rather than asserted from the text.
 */

/**
 * The POSIX one-click installer has to leave a login item behind.
 *
 * The defect: `GET /api/join/node-installer?platform=macos|linux` installed the node app,
 * launched it once and wrote nothing else, so the first restart ended the node and the person
 * had to find and run a launcher they never chose. That is the same defect the Windows
 * renderer was fixed for (a per-user Startup shortcut), shipped on the two platforms whose
 * bare-machine run has not happened yet — so it would have been found by a human on a Mac,
 * after a reboot, with no way to tell it apart from an enrolment that simply failed.
 *
 * The boundary that failure lives on is the SHELL: the installer is text until a shell runs
 * it, and text that looks right can still write nothing (a heredoc in the wrong place, a
 * `set -e` that aborts the script before the write, a directory that never gets created).
 * So these cases render the real script through the real route and then EXECUTE it with a
 * real bash, in a throwaway HOME with stub `node`/`npm` on PATH, and read the login item back
 * off the filesystem. Nothing here installs anything, reaches the network, or touches the
 * machine outside its own temporary directory.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Pool } from 'pg';
import {
  registerNodeInstallerRoute, renderNodeInstaller, renderPosixNodeInstaller,
} from '@/app/routes/node-installer-routes';

const VALID = {
  controlPlaneUrl: 'http://192.168.1.5:35457',
  token: 'placeholder-node-token-value-long-enough-to-be-real',
  clientId: 'node-2f1c9e2a-0000-4a1b-9c3d-5e6f70819200',
  nodeName: 'roger-laptop',
  nodePackage: '@oshal/chat',
};

const sandboxes: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()?.close();
  while (sandboxes.length) {
    const dir = sandboxes.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A bash that is missing is a FAILURE, not a skip. A guard that quietly declines on the one
 * machine it was meant to run on is a guard that does not exist.
 */
function bashVersion(): string {
  return execFileSync('bash', ['--version'], { encoding: 'utf8' }).split('\n')[0];
}

/** MSYS/Git-bash needs forward slashes; a POSIX box is unaffected by the same rewrite. */
function shellPath(p: string): string { return p.replace(/\\/g, '/'); }

interface SandboxRun {
  stdout: string;
  status: number;
  autostartPath: string;
  autostartBody: string | null;
  launcher: string;
}

/**
 * Runs one rendered installer to completion in its own throwaway HOME.
 *
 * `node` and `npm` are stubs: the real `npm install -g @oshal/chat` downloads Electron, which
 * is neither this guard's subject nor something a test may do. The stub does exactly what the
 * real one does as far as this script can tell — it creates the launcher in the global prefix
 * and exits 0 — so every line after it is the real thing running.
 */
function runInstaller(
  script: string,
  opts: { platform: 'macos' | 'linux'; blockAutostartDir?: boolean; xdgConfigHome?: string } = {
    platform: 'macos',
  },
): SandboxRun {
  const root = mkdtempSync(join(tmpdir(), 'oshal-installer-'));
  sandboxes.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const prefix = join(root, 'prefix');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });

  writeFileSync(join(bin, 'node'),
    '#!/usr/bin/env bash\n[ "${1:-}" = "--version" ] && echo "v22.4.0" && exit 0\nexit 0\n',
    { mode: 0o755 });
  writeFileSync(join(bin, 'npm'),
    '#!/usr/bin/env bash\n'
    + `if [ "$1" = "prefix" ]; then echo "${shellPath(prefix)}"; exit 0; fi\n`
    + 'if [ "$1" = "install" ]; then\n'
    + `  printf '#!/usr/bin/env bash\\nexit 0\\n' > "${shellPath(prefix)}/bin/oshal-chat"\n`
    + `  chmod +x "${shellPath(prefix)}/bin/oshal-chat"\n`
    + '  exit 0\nfi\nexit 0\n',
    { mode: 0o755 });

  const configHome = opts.xdgConfigHome ?? join(home, '.config');
  const autostartDir = opts.platform === 'macos'
    ? join(home, 'Library', 'LaunchAgents')
    : join(configHome, 'autostart');
  const autostartPath = opts.platform === 'macos'
    ? join(autostartDir, 'com.oshal.node.plist')
    : join(autostartDir, 'oshal-node.desktop');
  if (opts.blockAutostartDir) {
    // A plain FILE where the directory has to go: `mkdir -p` cannot succeed, which is the
    // shape of a locked-down or profile-managed home. The node must still start.
    mkdirSync(join(autostartDir, '..'), { recursive: true });
    writeFileSync(autostartDir, 'not a directory\n');
  }

  const scriptPath = join(root, 'install-oshal-node.sh');
  writeFileSync(scriptPath, script, 'utf8');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: shellPath(home),
    PATH: `${shellPath(bin)}:${process.env.PATH ?? ''}`,
    // Linux refuses a headless box before the download; give it a session.
    DISPLAY: ':0',
  };
  delete env.XDG_CONFIG_HOME;
  if (opts.xdgConfigHome) env.XDG_CONFIG_HOME = shellPath(opts.xdgConfigHome);

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', [shellPath(scriptPath)], { encoding: 'utf8', env });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    status = failure.status ?? -1;
    stdout = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
  return {
    stdout,
    status,
    autostartPath,
    autostartBody: existsSync(autostartPath) && !opts.blockAutostartDir
      ? readFileSync(autostartPath, 'utf8')
      : null,
    launcher: join(prefix, 'bin', 'oshal-chat'),
  };
}

describe('the rendered POSIX installer leaves a login item behind', () => {
  it('runs under a real bash at all (a missing shell is a failure, not a skip)', () => {
    expect(bashVersion()).toMatch(/GNU bash/);
  });

  it('writes a LaunchAgent on macOS that names the launcher npm actually created', () => {
    const run = runInstaller(renderPosixNodeInstaller({ ...VALID, platform: 'macos' }),
      { platform: 'macos' });
    expect(run.status).toBe(0);
    expect(run.autostartBody).not.toBeNull();
    expect(run.autostartPath).toMatch(/Library[\\/]LaunchAgents[\\/]com\.oshal\.node\.plist$/);
    const body = run.autostartBody ?? '';
    expect(body).toContain('<key>Label</key><string>com.oshal.node</string>');
    expect(body).toContain('<key>RunAtLoad</key><true/>');
    // The entry has to name the launcher that exists, not a name it hoped npm would produce.
    expect(body).toContain(shellPath(run.launcher));
    expect(run.stdout).toContain('It starts again by itself the next time you log in');
  });

  it('writes an XDG autostart entry on Linux, and honours XDG_CONFIG_HOME', () => {
    const plain = runInstaller(renderPosixNodeInstaller({ ...VALID, platform: 'linux' }),
      { platform: 'linux' });
    expect(plain.status).toBe(0);
    expect(plain.autostartPath).toMatch(/\.config[\\/]autostart[\\/]oshal-node\.desktop$/);
    const body = plain.autostartBody ?? '';
    expect(body).toContain('[Desktop Entry]');
    expect(body).toContain('Type=Application');
    expect(body).toContain(`Exec=${shellPath(plain.launcher)}`);

    // A desktop that sets XDG_CONFIG_HOME means it; writing to ~/.config anyway produces an
    // entry that no session ever reads, which looks exactly like a working one.
    const moved = mkdtempSync(join(tmpdir(), 'oshal-xdg-'));
    sandboxes.push(moved);
    const relocated = runInstaller(renderPosixNodeInstaller({ ...VALID, platform: 'linux' }),
      { platform: 'linux', xdgConfigHome: moved });
    expect(relocated.status).toBe(0);
    expect(relocated.autostartBody).not.toBeNull();
    expect(relocated.autostartPath.startsWith(moved)).toBe(true);
  });

  it('puts no credential in the login item on either platform', () => {
    // The entry names the launcher and nothing else — the token lives in the store the app
    // persisted on its first run, and a login item is a file every desktop tool can read.
    for (const platform of ['macos', 'linux'] as const) {
      const run = runInstaller(renderPosixNodeInstaller({ ...VALID, platform }), { platform });
      const body = run.autostartBody ?? '';
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toContain(VALID.token);
      expect(body).not.toContain(VALID.controlPlaneUrl);
      expect(body).not.toMatch(/OSHAL_SHARED_SECRET|OSHAL_ENROLLMENT_TOKEN/);
    }
  });

  it('reports a login item it could not write instead of claiming the node will come back', () => {
    const run = runInstaller(renderPosixNodeInstaller({ ...VALID, platform: 'linux' }),
      { platform: 'linux', blockAutostartDir: true });
    // Still an enrolment: the node was installed and started. It just will not come back.
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Done. This computer should appear in the cockpit');
    expect(run.stdout).toContain('This computer will NOT restart the node when you log in again');
    expect(run.stdout).not.toContain('It starts again by itself');
  });
});

describe('the three platforms do not drift apart on this', () => {
  it('every renderer emits a login item, so no platform silently loses one', () => {
    const windows = renderNodeInstaller(VALID);
    expect(windows).toMatch(/GetFolderPath\("Startup"\)/);
    expect(renderPosixNodeInstaller({ ...VALID, platform: 'macos' }))
      .toContain('Library/LaunchAgents');
    expect(renderPosixNodeInstaller({ ...VALID, platform: 'linux' }))
      .toContain('/autostart');
  });

  it('the script the ROUTE serves is the one that writes the entry', async () => {
    // The renderer is exported, so every case above could pass while the route served
    // something else. This drives the real Express mount and runs what came back.
    const pool = {
      query: async () => ({ rows: [], rowCount: 1 }),
    } as unknown as Pool;
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { oidc: unknown }).oidc = {
        isAuthenticated: () => true,
        user: { sub: 'auth0|autostart-guard', email: 'owner@example.com' },
      };
      next();
    });
    const router = express.Router();
    registerNodeInstallerRoute(router, pool);
    app.use('/api/join', router);
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('guard server did not bind');

    const previous = process.env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN;
    process.env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN = 'true';
    let body: string;
    try {
      const res = await fetch(
        `http://127.0.0.1:${address.port}/api/join/node-installer?platform=macos`,
        { headers: { 'x-forwarded-host': 'swarm.example.lan:35457' } },
      );
      expect(res.status).toBe(200);
      body = await res.text();
    } finally {
      if (previous === undefined) delete process.env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN;
      else process.env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN = previous;
    }

    const run = runInstaller(body, { platform: 'macos' });
    expect(run.status).toBe(0);
    expect(run.autostartBody).toContain('com.oshal.node');
    expect(run.autostartBody).toContain(shellPath(run.launcher));
  });
});
