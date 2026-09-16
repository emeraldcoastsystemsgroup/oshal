/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the macOS/Linux one-click installer: the route answers ?platform= over a real HTTP mount with a runnable .sh named for that platform, refuses an unknown platform BEFORE minting a credential, keeps the loopback and shared-secret refusals on every platform, and the Get oshal Desktop tile asks for the platform it detected.
 */

/**
 * Guards for the platform half of the one-click worker-node installer.
 *
 * The defect these exist for: `GET /api/join/node-installer` rendered a Windows `.cmd` and
 * nothing else, so a Mac or a Linux machine had no one-click path at all even though the node
 * app installs from npm on both and all five seeded values are platform-neutral.
 *
 * The boundary that failure lives on is the HTTP route — the query in, the file and its
 * `Content-Disposition` out — so these drive a real Express mount over a real socket rather
 * than calling the renderer directly. Only the Postgres pool is doubled; it is on the far side
 * of the boundary this change touches, and the assertions that matter are about what the
 * response carried and whether a credential row was written at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { Pool } from 'pg';
import {
  installerFilename, registerNodeInstallerRoute, renderPosixNodeInstaller,
  resolveInstallerPlatform,
} from '@/app/routes/node-installer-routes';

const VALID = {
  controlPlaneUrl: 'http://192.168.1.5:35457',
  token: 'placeholder-node-token',
  clientId: 'node-2f1c9e2a-0000-4a1b-9c3d-5e6f70819200',
  nodeName: 'roger-laptop',
  nodePackage: '@oshal/chat',
};

const servers: Server[] = [];
afterEach(() => { while (servers.length) servers.pop()?.close(); });

/** Every INSERT the route attempted, so "no credential was minted" is an assertion. */
interface RecordingPool { pool: Pool; inserts: unknown[][] }

function recordingPool(): RecordingPool {
  const inserts: unknown[][] = [];
  const pool = {
    query: async (_text: string, values?: unknown[]) => {
      inserts.push(values ?? []);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, inserts };
}

/**
 * Mounts the real route on a real Express app over a real socket. `REMOTE_CLIENT_REQUIRE_NODE_TOKEN`
 * is read from the live process env by the route, so each caller sets it around its own request.
 */
async function mount(): Promise<{ baseUrl: string; inserts: unknown[][] }> {
  const { pool, inserts } = recordingPool();
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { oidc: unknown }).oidc = {
      isAuthenticated: () => true,
      user: { sub: 'auth0|installer-guard', email: 'owner@example.com' },
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
  return { baseUrl: `http://127.0.0.1:${address.port}`, inserts };
}

/** Runs one request with the shared-secret switch held at a known value for its duration. */
async function get(
  baseUrl: string, query: string, opts: { retired?: boolean; host?: string } = {},
) {
  const previous = process.env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN;
  process.env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN = opts.retired === false ? 'false' : 'true';
  try {
    // A LAN-shaped host, or the route refuses every download as loopback — the guard server
    // binds to 127.0.0.1, and that refusal is deliberate. `host` is a forbidden fetch header,
    // so this travels as x-forwarded-host, which is the one resolveControlPlaneUrl reads
    // first anyway.
    return await fetch(`${baseUrl}/api/join/node-installer${query}`, {
      headers: { 'x-forwarded-host': opts.host ?? 'swarm.example.lan:35457' },
    });
  } finally {
    if (previous === undefined) delete process.env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN;
    else process.env.REMOTE_CLIENT_REQUIRE_NODE_TOKEN = previous;
  }
}

describe('the route hands each platform a file it can actually run', () => {
  it('renders a bash script named .sh for macOS', async () => {
    const { baseUrl } = await mount();
    const res = await get(baseUrl, '?name=my-mac&platform=macos');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition'))
      .toBe('attachment; filename="install-oshal-node.sh"');
    const body = await res.text();
    expect(body.startsWith('#!/usr/bin/env bash')).toBe(true);
    // A CR anywhere makes the shebang `/usr/bin/env bash\r`, which fails as "bad interpreter".
    expect(body).not.toContain('\r');
    expect(body).not.toContain('@echo off');
    expect(body).toContain('macOS');
    // The per-device values the node needs, carried in the file rather than pasted by hand.
    // The token is asserted by SHAPE, never by a literal prefix: a literal that looks like a
    // credential is what the commit hook exists to stop, and the shape is the real claim.
    const carried = /^NODE_TOKEN='([^']+)'$/m.exec(body)?.[1] ?? '';
    expect(carried.length).toBeGreaterThan(24);
    expect(body).toMatch(/CLIENT_ID='node-[0-9a-f-]+'/);
    expect(body).toContain("CONTROL_PLANE_URL='http://swarm.example.lan:35457'");
    expect(body).toContain("NODE_NAME='my-mac'");
  });

  it('renders the same shape for Linux, plus the check a headless box needs', async () => {
    const { baseUrl } = await mount();
    const res = await get(baseUrl, '?platform=linux');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition'))
      .toBe('attachment; filename="install-oshal-node.sh"');
    const body = await res.text();
    expect(body.startsWith('#!/usr/bin/env bash')).toBe(true);
    // The node app opens a window. Saying so before a multi-minute Electron download is the
    // difference between a clear stop and an Electron error nobody can act on.
    expect(body).toContain('WAYLAND_DISPLAY');
    expect(body).toMatch(/No graphical session was found/);
  });

  it('still renders the Windows .cmd when no platform is asked for', async () => {
    // Every link and bookmark minted before this route knew about platforms must keep working.
    const { baseUrl } = await mount();
    const res = await get(baseUrl, '?name=my-computer');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition'))
      .toBe('attachment; filename="install-oshal-node.cmd"');
    expect((await res.text()).startsWith('@echo off')).toBe(true);
  });

  it('refuses an unknown platform WITHOUT minting a credential for it', async () => {
    // Handing a Mac a .cmd produces a file that cannot run and a person with no idea why. And
    // the refusal must come before the mint, or every rejected download leaves a live token.
    const { baseUrl, inserts } = await mount();
    const res = await get(baseUrl, '?platform=freebsd');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unsupported_platform' });
    expect(inserts).toHaveLength(0);
  });

  it('keeps the loopback refusal on the POSIX platforms too', async () => {
    // A localhost URL inside a downloaded installer points the NEW computer at itself.
    const { baseUrl, inserts } = await mount();
    const res = await get(baseUrl, '?platform=macos', { host: 'localhost:35457' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'loopback_control_plane' });
    expect(inserts).toHaveLength(0);
  });

  it('keeps the shared-secret precondition on the POSIX platforms too', async () => {
    // The download is only safe to hand a non-operator because a per-device token is
    // SUFFICIENT. That does not become true because the file is a .sh.
    const { baseUrl, inserts } = await mount();
    const res = await get(baseUrl, '?platform=linux', { retired: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'node_token_not_required' });
    expect(inserts).toHaveLength(0);
  });
});

describe('the POSIX script carries exactly what the Windows one carries', () => {
  it('seeds every value the node needs to come up owned and correctly identified', () => {
    const script = renderPosixNodeInstaller({ ...VALID, platform: 'macos' });
    for (const seeded of ['OSHAL_CONTROL_PLANE_URL', 'OSHAL_SHARED_SECRET',
      'OSHAL_ENROLLMENT_TOKEN', 'OSHAL_CLIENT_ID', 'OSHAL_CLIENT_NAME']) {
      expect(script).toContain('export ' + seeded + '=');
    }
    // The token is bound to this id, and a node that invents its own is refused at registration.
    expect(script).toContain('export OSHAL_CLIENT_ID="$CLIENT_ID"');
  });

  it('never puts a swarm-wide credential in a per-user download', () => {
    const script = renderPosixNodeInstaller({ ...VALID, platform: 'linux' });
    expect(script).not.toContain('OSJOIN1');
    expect(script).not.toMatch(/SharedSecret/i);
    expect(script).not.toContain('REMOTE_CLIENT_SHARED_SECRET');
    expect(script).not.toContain('-JoinCode');
  });

  it('tells the person what they are holding', () => {
    const script = renderPosixNodeInstaller({ ...VALID, platform: 'macos' });
    expect(script).toMatch(/YOUR credential/i);
    expect(script).toMatch(/do not share/i);
    expect(script).toMatch(/revoke/i);
  });

  it('refuses to render rather than escape its way out of a quoted literal', () => {
    // Same rule as the Windows renderer: every value is server-produced, so a quote means
    // something upstream is wrong. Escaping is the version that ships a subtle injection the
    // day some upstream value starts carrying a user's text.
    for (const field of ['controlPlaneUrl', 'token', 'clientId', 'nodeName'] as const) {
      for (const bad of ["'", '"', '`', '$', '\n', '\\']) {
        expect(() => renderPosixNodeInstaller(
          { ...VALID, platform: 'macos', [field]: VALID[field] + bad },
        )).toThrow(/quotable character/);
      }
    }
  });

  it('parses the Node version with parameter expansion, never a regex split', () => {
    // The Windows renderer shipped `-split "."` — a REGEX split where "." matches every
    // character — and reported Node 24 as too old on every machine. ${v#v} and ${v%%.*} are
    // literal by definition, and a non-numeric result falls to 0 rather than erroring out.
    const script = renderPosixNodeInstaller({ ...VALID, platform: 'linux' });
    expect(script).toContain('NODE_MAJOR="${NODE_VERSION#v}"');
    expect(script).toContain('NODE_MAJOR="${NODE_MAJOR%%.*}"');
    expect(script).toContain('[ "$NODE_MAJOR" -lt 20 ]');
  });

  it('refuses to claim success when npm installed nothing', () => {
    const script = renderPosixNodeInstaller({ ...VALID, platform: 'macos' });
    expect(script).toMatch(/no launcher was created/);
    const failure = script.indexOf('no launcher was created');
    const success = script.indexOf('Done. This computer should appear');
    expect(failure).toBeGreaterThan(-1);
    expect(failure).toBeLessThan(success);
    expect(script.slice(failure, success)).toContain('exit 1');
  });

  it('never re-interpolates a value at the call site', () => {
    const script = renderPosixNodeInstaller({ ...VALID, platform: 'linux' });
    const invocation = script.split('\n').find((line) => line.includes('npm install -g'));
    expect(invocation).toBeTruthy();
    expect(invocation).not.toContain(VALID.nodePackage);
    expect(invocation).toContain('"$NODE_PACKAGE"');
  });
});

describe('the platform vocabulary', () => {
  it('is the same one the node app reports itself as', () => {
    for (const known of ['windows', 'macos', 'linux']) {
      expect(resolveInstallerPlatform(known)).toBe(known);
    }
    expect(resolveInstallerPlatform('MacOS')).toBe('macos');
    expect(resolveInstallerPlatform(undefined)).toBe('windows');
    expect(resolveInstallerPlatform('')).toBe('windows');
    for (const unknown of ['freebsd', 'darwin', 'win32', 'android', 'osx', 'mac']) {
      expect(resolveInstallerPlatform(unknown)).toBeNull();
    }
  });

  it('names each download for the shell that runs it', () => {
    expect(installerFilename('windows')).toBe('install-oshal-node.cmd');
    expect(installerFilename('macos')).toBe('install-oshal-node.sh');
    expect(installerFilename('linux')).toBe('install-oshal-node.sh');
  });
});

/**
 * One run of the SHIPPED Get oshal Desktop tile under a minimal fake DOM.
 *
 * The inline script out of `devices.html` is executed, not a copy of it: the boundary that
 * matters for the tile half is what the page ASKS the route for and what it names the saved
 * file, and a source-level assertion could not tell a correct detection from a hard-coded one.
 * There is no jsdom in this repo, so the fake exposes only what a browser would — a new DOM
 * dependency in the page fails here first rather than silently in a viewer's browser.
 */
async function runDesktopTile(agent: { platform: string; userAgent: string }) {
  const fs = await import('fs');
  const html = await fs.promises.readFile('src/pages/cockpit/tools/devices.html', 'utf8');
  const open = html.lastIndexOf('<script>');
  const close = html.lastIndexOf('</script>');
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  const source = html.slice(open + '<script>'.length, close);

  const elements: Record<string, FakeElement> = {};
  const element = (id: string): FakeElement => {
    if (!elements[id]) elements[id] = makeElement(id);
    return elements[id];
  };
  const requested: string[] = [];
  const saved: Array<{ name: string }> = [];

  const documentStub = {
    getElementById: element,
    createElement: () => {
      const anchor = {
        href: '', download: '',
        click: () => { saved.push({ name: anchor.download }); },
        remove: () => undefined,
      };
      return anchor;
    },
    body: { appendChild: () => undefined },
  };
  const fetchStub = async (url: string) => {
    requested.push(url);
    if (url.startsWith('/api/join/node-installer')) {
      return { ok: true, status: 200, blob: async () => ({}), json: async () => ({}) };
    }
    if (url.startsWith('/api/remote-clients')) {
      return { ok: true, status: 200, json: async () => ({ clients: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const navigatorStub = { platform: agent.platform, userAgent: agent.userAgent };
  const windowStub = { confirm: () => true };

  const run = new Function(
    'window', 'document', 'navigator', 'fetch', 'location', 'URL', 'setTimeout', 'setInterval',
    source,
  );
  run(
    windowStub, documentStub, navigatorStub, fetchStub, { origin: 'http://swarm.example.lan' },
    { createObjectURL: () => 'blob:fake', revokeObjectURL: () => undefined },
    () => 0, () => 0,
  );

  const click = element('downloadBtn').listeners.click?.[0];
  expect(click).toBeTypeOf('function');
  await click();
  return {
    selected: element('platform').value,
    installerRequests: requested.filter((url) => url.startsWith('/api/join/node-installer')),
    savedAs: saved.map((entry) => entry.name),
    howTo: element('howto').innerHTML,
  };
}

/** The element surface the page actually touches — nothing a browser would not give it. */
interface FakeElement {
  value: string; textContent: string; innerHTML: string; className: string;
  hidden: boolean; disabled: boolean;
  parentNode: { hidden: boolean };
  listeners: Record<string, Array<(event?: unknown) => unknown>>;
  addEventListener(type: string, handler: (event?: unknown) => unknown): void;
}

function makeElement(id: string): FakeElement {
  const listeners: FakeElement['listeners'] = {};
  return {
    // The name field starts populated the way the markup's value attribute populates it.
    value: id === 'nodeName' ? 'my-computer' : '',
    textContent: '', innerHTML: '', className: '', hidden: false, disabled: false,
    parentNode: { hidden: false },
    listeners,
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
  };
}

describe('the Get oshal Desktop tile offers the installer for the machine it is on', () => {
  it('asks for the macOS script, and names the saved file for it', async () => {
    const run = await runDesktopTile({
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        + ' (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    });
    expect(run.selected).toBe('macos');
    expect(run.installerRequests).toHaveLength(1);
    expect(run.installerRequests[0]).toContain('platform=macos');
    expect(run.savedAs).toEqual(['install-oshal-node.sh']);
    // ...and the steps shown afterwards are the ones that work on a Mac.
    expect(run.howTo).toContain('install-oshal-node.sh');
    expect(run.howTo).toContain('bash ~/Downloads/install-oshal-node.sh');
    expect(run.howTo).not.toContain('double-click');
  });

  it('asks for the Linux script on a Linux browser', async () => {
    const run = await runDesktopTile({
      platform: 'Linux x86_64',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)'
        + ' Chrome/140.0 Safari/537.36',
    });
    expect(run.selected).toBe('linux');
    expect(run.installerRequests[0]).toContain('platform=linux');
    expect(run.savedAs).toEqual(['install-oshal-node.sh']);
    // The one thing a Linux machine can get wrong that a Mac cannot.
    expect(run.howTo).toMatch(/SSH/);
  });

  it('still asks for Windows on a Windows browser, and still saves a .cmd', async () => {
    const run = await runDesktopTile({
      platform: 'Win32',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like'
        + ' Gecko) Chrome/140.0 Safari/537.36',
    });
    expect(run.selected).toBe('windows');
    expect(run.installerRequests[0]).toContain('platform=windows');
    expect(run.savedAs).toEqual(['install-oshal-node.cmd']);
    expect(run.howTo).toContain('double-click');
  });

  it('reads an iPad as a Mac rather than as Windows', async () => {
    // iPadOS reports itself as "Macintosh", and a `win` test run first would claim it as
    // Windows on any string containing "Win" — the ordering is the assertion.
    const run = await runDesktopTile({
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML,'
        + ' like Gecko) Version/17.0 Safari/605.1.15',
    });
    expect(run.selected).toBe('macos');
  });
});
