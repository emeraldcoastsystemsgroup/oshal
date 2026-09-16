/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One-click worker-node install: mint the caller's per-device credential and return a runnable script with it already in place, so nothing has to be pasted into Settings.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Say plainly that the file belongs in an Open Swarm folder. The first version fetched an install script from a route that never existed, and even fetching it would have died on the missing packages/oshal-chat.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Pass -ClientId through: a device-bound token names the device it may register as, and the node was minting its own id, so the control plane refused every one-click enrolment.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Install the node app from npm instead of building it from a checkout, so the download works on a machine that has never seen this repo. The package is configurable (OSHAL_NODE_PACKAGE).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Render for macOS and Linux too (?platform=macos|linux -> a bash .sh). The five seeded values were always platform-neutral and the node app already installs from npm on both, but only a Windows .cmd was ever emitted, so a Mac or Linux machine had no one-click path at all. An unrecognised platform is a 400 rather than a silent Windows fallback, and it is refused BEFORE a token is minted so a rejected download leaves no live credential behind.
 */

/**
 * One-click worker-node installer.
 *
 * A person who needs a worker node — to submit job applications from their own browser, say —
 * previously had to be handed a join code by an operator and paste it into a terminal. This
 * hands them a file instead: it carries the control plane URL and a token, and running it
 * enrols the machine already bound to them.
 *
 * **No swarm-wide secret is in the download, and that is a precondition rather than a
 * detail.** The file carries a token bound to ONE device (`oshal_cli_tokens.node_client_id`),
 * which authenticates only that device's worker plane and can be revoked or rotated without
 * touching any other machine. That is sufficient to register only when
 * `REMOTE_CLIENT_REQUIRE_NODE_TOKEN` has retired the shared secret — so this route REFUSES
 * when it has not, rather than emitting a script that cannot register, or worse, reaching for
 * the swarm-wide credential to make it work.
 *
 * @module node-installer-routes
 */
import { randomUUID } from 'crypto';
import { type Request, type Response, type Router } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getCaller } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { insertCliToken } from '@/app/routes/cli-token-routes';
import { sharedSecretRetired } from '@/features/remote-client';

const logger = createChildLogger({ module: 'node-installer-routes' });

/**
 * The npm package the installer pulls the node app from. Configurable rather than fixed so a
 * fork, a private registry or a pinned version is an env var and not a code change — and so a
 * deployment can point at a prerelease without shipping a different installer.
 */
export function nodePackageSpec(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.OSHAL_NODE_PACKAGE ?? '').trim();
  return configured || '@oshal/chat';
}

/** Characters that would end a PowerShell single-quoted literal, or a line. */
const UNSAFE_IN_LITERAL = /['"`$\r\n\\]/;

/**
 * @description Renders the Windows installer with this download's own values baked in.
 *
 *   Generated rather than served static because two of the values are per-download. They go
 *   in as single-quoted PowerShell literals; a single-quoted literal has exactly one escape
 *   concern, and rather than escaping it this refuses to render at all. Every value is
 *   server-produced (a URL this server resolved, an `oshal_pat_` token it minted, a UUID),
 *   so a quotable character means something upstream is wrong, not that a user typed one.
 * @param options - Control plane URL, minted token, device id, and the node's display name.
 * @returns The PowerShell script text, CRLF-terminated for Windows.
 * @throws When any value carries a character that could break out of a literal.
 */
export function renderNodeInstaller(options: {
  controlPlaneUrl: string; token: string; clientId: string; nodeName: string; nodePackage: string;
}): string {
  for (const [field, value] of Object.entries(options)) {
    if (UNSAFE_IN_LITERAL.test(value)) {
      throw new Error(`refusing to render an installer: ${field} carries a quotable character`);
    }
  }
  const lines = [
    '# OSHAL worker node - one-click install.',
    '#',
    '# HOW TO RUN THIS: double-click it. Nothing else is needed.',
    '#',
    '# The batch header above re-launched PowerShell for this section with -ExecutionPolicy',
    '# Bypass, which applies to THAT ONE RUN and changes no system setting. That is why this',
    '# is a .cmd: a downloaded .ps1 is refused as "not digitally signed" on a default Windows,',
    '# and nothing the person running it does at the double-click can fix that.',
    '#',
    '# If Windows shows a "the publisher could not be verified" prompt, that is the same tag',
    '# on any downloaded file; Run answers it. Everything below is the whole script.',
    '#',
    '# This file contains YOUR credential for THIS computer. Anyone who runs it enrols a',
    '# machine that receives work dispatched to you. Do not share it and do not commit it;',
    '# delete it once the computer appears in the cockpit. You can revoke it at any time from',
    '# Settings, which disables this one computer and nothing else.',
    '#',
    '# Bound to device : ' + options.clientId,
    '# Control plane   : ' + options.controlPlaneUrl,
    '',
    '$ErrorActionPreference = "Stop"',
    "$ControlPlaneUrl = '" + options.controlPlaneUrl + "'",
    "$NodeToken       = '" + options.token + "'",
    "$ClientId        = '" + options.clientId + "'",
    "$NodeName        = '" + options.nodeName + "'",
    "$NodePackage     = '" + options.nodePackage + "'",
    '',
    'Write-Host "Setting up an OSHAL worker node bound to your account..." -ForegroundColor Cyan',
    'Write-Host "  control plane: $ControlPlaneUrl"',
    '',
    '# 1. Node.js is the ONLY prerequisite. The app installs from npm already built, so',
    '#    there is no checkout to clone here and nothing to compile.',
    '$nodeVersion = $null',
    'try { $nodeVersion = (& node --version) } catch { }',
    'if (-not $nodeVersion) {',
    '    Write-Host ""',
    '    Write-Host "Node.js is required and was not found." -ForegroundColor Yellow',
    '    Write-Host "  Install the LTS build from https://nodejs.org, then run this again."',
    '    exit 1',
    '}',
    // .Split() and NOT -split: -split takes a REGEX, and the "\." that would make it a
    // literal dot cannot survive a JavaScript string literal ('\.' is just '.'), so the
    // emitted script silently split on "any character". Every element came back empty,
    // [int]"" was 0, and 0 -lt 20 reported Node 24 as too old on every machine.
    '$major = [int]($nodeVersion.TrimStart("v").Split(".")[0])',
    'if ($major -lt 20) {',
    '    Write-Host ""',
    '    Write-Host "Node.js 20 or newer is required (found $nodeVersion)." -ForegroundColor Yellow',
    '    exit 1',
    '}',
    'Write-Host "  node: $nodeVersion" -ForegroundColor DarkGray',
    '',
    '# 2. The node app. Ships built, so this pulls the app plus Electron and nothing else.',
    'Write-Host "Installing $NodePackage (this downloads Electron - a few minutes)..."',
    '& npm install -g $NodePackage',
    'if ($LASTEXITCODE -ne 0) {',
    '    Write-Host ""',
    '    Write-Host "npm could not install $NodePackage." -ForegroundColor Yellow',
    '    Write-Host "  Scroll up for the npm error - a proxy or an offline machine is the usual cause."',
    '    exit 1',
    '}',
    '',
    '# 3. Seed it. The app reads these ONCE on first launch and persists them, so the desktop',
    '#    shortcut it creates later carries no credential and its settings pane stays',
    '#    authoritative. The token is both halves at once: the bearer credential this device',
    '#    authenticates with, and the proof of who owns it. The client id is NOT optional -',
    '#    the token is bound to it, and the control plane refuses a mismatch.',
    '$env:OSHAL_CONTROL_PLANE_URL = $ControlPlaneUrl',
    '$env:OSHAL_SHARED_SECRET     = $NodeToken',
    '$env:OSHAL_ENROLLMENT_TOKEN  = $NodeToken',
    '$env:OSHAL_CLIENT_ID         = $ClientId',
    '$env:OSHAL_CLIENT_NAME       = $NodeName',
    '$env:OSHAL_WORKER_ENABLED    = "true"',
    '$env:OSHAL_FULL_JARVIS       = "false"',
    '',
    '# 4. Prove the install produced a launcher before claiming success. npm can exit 0 while',
    '#    leaving nothing behind, and this script used to print "Done" regardless — so a run',
    '#    that installed nothing looked identical to one that worked.',
    '$npmDir = ""',
    'try { $npmDir = (& npm prefix -g) } catch { }',
    '$launcher = ""',
    'foreach ($candidate in @(',
    '        (Join-Path $npmDir "oshal-chat.cmd"),',
    '        (Join-Path $env:APPDATA "npm\\oshal-chat.cmd"))) {',
    '    if ($candidate -and (Test-Path $candidate)) { $launcher = $candidate; break }',
    '}',
    'if (-not $launcher) {',
    '    Write-Host ""',
    '    Write-Host "npm reported success but no launcher was created." -ForegroundColor Yellow',
    '    Write-Host "  Looked in: $npmDir"',
    '    Write-Host "  Run this and read the output: npm install -g $NodePackage"',
    '    exit 1',
    '}',
    '',
    '# Launch the .cmd shim BY PATH. npm writes three launchers per package - oshal-chat,',
    '# oshal-chat.cmd and oshal-chat.ps1 - and Start-Process on the bare name lets Windows',
    '# choose. It chose the .ps1, which has no association on a default Windows, so the user',
    '# got an "open with" dialog instead of a running node.',
    'Write-Host "Starting the node so it can register..."',
    'Start-Process -FilePath $launcher -WindowStyle Hidden',
    '',
    'Write-Host ""',
    'Write-Host "Done. This computer should appear in the cockpit within a minute."'
      + ' -ForegroundColor Green',
    'Write-Host "You can delete this file now." -ForegroundColor DarkGray',
    '',
  ];
  return [...CMD_PREAMBLE, ...lines].join('\r\n');
}

/**
 * The platforms this route can hand a runnable file to. Same vocabulary the node app reports
 * itself as when it registers (`mesh-client.ts`), so a download and the device it produces
 * describe the machine the same way.
 */
export const INSTALLER_PLATFORMS = ['windows', 'macos', 'linux'] as const;

/** One of the platforms an installer can be rendered for. */
export type InstallerPlatform = (typeof INSTALLER_PLATFORMS)[number];

/**
 * @description Resolves the `?platform=` query value to a platform this route can render.
 *
 *   An absent value is `windows`, which keeps every link and bookmark minted before this route
 *   knew about platforms working unchanged. An unrecognised value is `null` rather than a
 *   silent fall back to Windows: handing a Mac a `.cmd` produces a file that cannot run and a
 *   person with no idea why, which is worse than a refusal that names the supported set.
 * @param raw - The raw query value, of whatever type Express produced.
 * @returns The platform, or null when the value is not one this route renders.
 */
export function resolveInstallerPlatform(raw: unknown): InstallerPlatform | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return 'windows';
  return (INSTALLER_PLATFORMS as readonly string[]).includes(value)
    ? (value as InstallerPlatform)
    : null;
}

/**
 * @description The name a downloaded installer is saved under for a platform.
 * @param platform - The platform the script was rendered for.
 * @returns The download filename, including its extension.
 */
export function installerFilename(platform: InstallerPlatform): string {
  return platform === 'windows' ? 'install-oshal-node.cmd' : 'install-oshal-node.sh';
}

/**
 * @description Renders the macOS / Linux installer with this download's own values baked in.
 *
 *   The same contract as the Windows renderer, deliberately: the five seeded values are
 *   platform-neutral, the file carries a token bound to ONE device and never a swarm-wide
 *   credential, and a value carrying a character that could end a quoted literal is a refusal
 *   rather than an escaping exercise. A POSIX single-quoted literal has only one escape concern
 *   (`'`), but the check stays identical across both renderers so there is one rule to reason
 *   about rather than two that drift.
 *
 *   LF-terminated, not CRLF: a shell refuses a script whose shebang line ends in a carriage
 *   return with `bad interpreter: /usr/bin/env bash^M`, which reads as a missing interpreter.
 * @param options - Control plane URL, minted token, device id, node display name, npm package,
 *   and which of the two POSIX platforms this is for.
 * @returns The shell script text, LF-terminated.
 * @throws When any value carries a character that could break out of a literal.
 */
export function renderPosixNodeInstaller(options: {
  controlPlaneUrl: string; token: string; clientId: string; nodeName: string;
  nodePackage: string; platform: 'macos' | 'linux';
}): string {
  const { platform, ...values } = options;
  for (const [field, value] of Object.entries(values)) {
    if (UNSAFE_IN_LITERAL.test(value)) {
      throw new Error(`refusing to render an installer: ${field} carries a quotable character`);
    }
  }
  return [
    ...posixHeader(options, platform === 'macos' ? 'macOS' : 'Linux'),
    ...POSIX_NODE_CHECK,
    ...(platform === 'linux' ? POSIX_DISPLAY_CHECK : []),
    ...POSIX_INSTALL_AND_LAUNCH,
  ].join('\n');
}

/** The shebang, the credential notice, and this download's own values as shell literals. */
function posixHeader(
  options: { controlPlaneUrl: string; token: string; clientId: string; nodeName: string;
    nodePackage: string; },
  osName: string,
): string[] {
  return [
    '#!/usr/bin/env bash',
    '# OSHAL worker node - one-click install (' + osName + ').',
    '#',
    '# HOW TO RUN THIS: open a terminal and run',
    '#     bash ~/Downloads/install-oshal-node.sh',
    '# Nothing else is needed. A downloaded file does not arrive executable, which is why this',
    '# says `bash <file>` rather than `./<file>`: running it through bash needs no chmod and',
    '# no sudo.',
    '#',
    '# This file contains YOUR credential for THIS computer. Anyone who runs it enrols a',
    '# machine that receives work dispatched to you. Do not share it and do not commit it;',
    '# delete it once the computer appears in the cockpit. You can revoke it at any time from',
    '# Settings, which disables this one computer and nothing else.',
    '#',
    '# Bound to device : ' + options.clientId,
    '# Control plane   : ' + options.controlPlaneUrl,
    '',
    'set -euo pipefail',
    '',
    "CONTROL_PLANE_URL='" + options.controlPlaneUrl + "'",
    "NODE_TOKEN='" + options.token + "'",
    "CLIENT_ID='" + options.clientId + "'",
    "NODE_NAME='" + options.nodeName + "'",
    "NODE_PACKAGE='" + options.nodePackage + "'",
    '',
    'echo "Setting up an OSHAL worker node bound to your account..."',
    'echo "  control plane: $CONTROL_PLANE_URL"',
    '',
  ];
}

/**
 * Node.js is the only prerequisite, and the version is read with parameter expansion rather
 * than a split. The Windows renderer shipped `-split "."`, which takes a REGEX, so "." matched
 * every character and every machine was told its Node was too old. `${v#v}` drops one leading
 * "v" and `${v%%.*}` keeps everything before the first dot; both are literal by definition.
 */
const POSIX_NODE_CHECK = [
  '# 1. Node.js is the ONLY prerequisite. The app installs from npm already built, so there is',
  '#    no checkout to clone here and nothing to compile.',
  'if ! command -v node >/dev/null 2>&1; then',
  '  echo ""',
  '  echo "Node.js is required and was not found."',
  '  echo "  Install the LTS build from https://nodejs.org, then run this again."',
  '  exit 1',
  'fi',
  'NODE_VERSION="$(node --version)"',
  'NODE_MAJOR="${NODE_VERSION#v}"',
  'NODE_MAJOR="${NODE_MAJOR%%.*}"',
  'case "$NODE_MAJOR" in "" | *[!0-9]*) NODE_MAJOR=0 ;; esac',
  'if [ "$NODE_MAJOR" -lt 20 ]; then',
  '  echo ""',
  '  echo "Node.js 20 or newer is required (found $NODE_VERSION)."',
  '  echo "  Install the LTS build from https://nodejs.org, then run this again."',
  '  exit 1',
  'fi',
  'echo "  node: $NODE_VERSION"',
  '',
];

/**
 * Linux only. The node app opens a window, so a headless box can never run it — and finding
 * that out after a multi-minute Electron download, from Electron's own error, is the worst
 * place to learn it. macOS has no equivalent case: a logged-in desktop is the only state it has.
 */
const POSIX_DISPLAY_CHECK = [
  '# 2. The node app is a desktop app, so it needs a logged-in graphical session.',
  'if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then',
  '  echo ""',
  '  echo "No graphical session was found (DISPLAY and WAYLAND_DISPLAY are both unset)."',
  '  echo "  The node app opens a window, so run this from the desktop of that machine"',
  '  echo "  rather than over a plain SSH connection."',
  '  exit 1',
  'fi',
  '',
];

/** Install from npm, seed the five platform-neutral values, prove a launcher, start it. */
const POSIX_INSTALL_AND_LAUNCH = [
  '# 3. The node app. Ships built, so this pulls the app plus Electron and nothing else.',
  'echo "Installing $NODE_PACKAGE (this downloads Electron - a few minutes)..."',
  'if ! npm install -g "$NODE_PACKAGE"; then',
  '  echo ""',
  '  echo "npm could not install $NODE_PACKAGE."',
  '  echo "  Scroll up for the npm error. A proxy, an offline machine, or a global prefix owned"',
  '  echo "  by root are the usual causes. A prefix you own avoids sudo entirely:"',
  '  echo \'    npm config set prefix "$HOME/.npm-global"\'',
  '  echo \'    export PATH="$HOME/.npm-global/bin:$PATH"\'',
  '  exit 1',
  'fi',
  '',
  '# 4. Seed it. The app reads these ONCE on first launch and persists them, so nothing after',
  '#    this run carries a credential and its settings pane stays authoritative. The token is',
  '#    both halves at once: the bearer credential this device authenticates with, and the',
  '#    proof of who owns it. The client id is NOT optional - the token is bound to it, and the',
  '#    control plane refuses a mismatch.',
  'export OSHAL_CONTROL_PLANE_URL="$CONTROL_PLANE_URL"',
  'export OSHAL_SHARED_SECRET="$NODE_TOKEN"',
  'export OSHAL_ENROLLMENT_TOKEN="$NODE_TOKEN"',
  'export OSHAL_CLIENT_ID="$CLIENT_ID"',
  'export OSHAL_CLIENT_NAME="$NODE_NAME"',
  'export OSHAL_WORKER_ENABLED="true"',
  'export OSHAL_FULL_JARVIS="false"',
  '',
  '# 5. Prove the install produced a launcher before claiming success. npm can exit 0 while',
  '#    leaving nothing behind, and the Windows script used to print "Done" regardless - so a',
  '#    run that installed nothing looked identical to one that worked.',
  'NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"',
  'LAUNCHER=""',
  'if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/oshal-chat" ]; then',
  '  LAUNCHER="$NPM_PREFIX/bin/oshal-chat"',
  'elif command -v oshal-chat >/dev/null 2>&1; then',
  '  LAUNCHER="$(command -v oshal-chat)"',
  'fi',
  'if [ -z "$LAUNCHER" ]; then',
  '  echo ""',
  '  echo "npm reported success but no launcher was created."',
  '  echo "  Looked in: $NPM_PREFIX/bin"',
  '  echo "  Run this and read the output: npm install -g $NODE_PACKAGE"',
  '  exit 1',
  'fi',
  '',
  '# Detached, so closing the terminal does not take the node with it.',
  'echo "Starting the node so it can register..."',
  'nohup "$LAUNCHER" >/dev/null 2>&1 &',
  '',
  'echo ""',
  'echo "Done. This computer should appear in the cockpit within a minute."',
  'echo "You can delete this file now."',
  '',
];

/**
 * The batch header that makes this file self-launching.
 *
 * A downloaded .ps1 is refused twice by Windows — the execution policy rejects unsigned
 * scripts, and the download carries an internet tag that makes even RemoteSigned refuse.
 * Both refusals say "is not digitally signed", and neither is fixable by the person who
 * just wants their computer connected. Passing -ExecutionPolicy Bypass fixes it, but only
 * if they knew to pass it, and right-click "Run with PowerShell" does not.
 *
 * A .cmd is not subject to execution policy at all. cmd runs the header, which re-launches
 * PowerShell with Bypass over the rest of this same file, and stops at `exit /b` — so the
 * PowerShell below is never parsed by cmd and its `%` and quoting mean nothing to it. The
 * script stays plain readable text below the marker, which is what makes it auditable
 * before it is trusted.
 */
const PS_MARKER = '#___POWERSHELL_BELOW___';
const CMD_PREAMBLE = [
  '@echo off',
  'rem  OSHAL worker node installer. Double-click this file, or run it from a terminal.',
  'rem  Everything below the marker is plain PowerShell — read it before you trust it.',
  'setlocal',
  'set "OSHAL_SELF=%~f0"',
  'rem  Resolve PowerShell by absolute path first. A bare `powershell` depends on PATH, and a',
  'rem  PATH edited by an installer or a policy fails with "not recognized" — a message that',
  'rem  sends the reader looking for a PowerShell problem they do not have.',
  'set "OSHAL_PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
  'if not exist "%OSHAL_PS%" set "OSHAL_PS=powershell"',
  // The marker is assembled from two halves so this command line does not itself contain the
  // literal being searched for. Spelling it out here made IndexOf match THIS line and execute
  // the batch header as PowerShell — caught by running a downloaded copy, not by any test.
  '"%OSHAL_PS%" -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText($env:OSHAL_SELF);'
    + ` $m='${PS_MARKER.slice(0, 12)}'+'${PS_MARKER.slice(12)}';`
    + ' $i=$t.IndexOf($m); Invoke-Expression $t.Substring($i+$m.Length)"',
  'set "OSHAL_EXIT=%ERRORLEVEL%"',
  'if not "%OSHAL_EXIT%"=="0" pause',
  'exit /b %OSHAL_EXIT%',
  PS_MARKER,
];

/**
 * @description Registers `GET /node-installer` on the join router.
 *
 *   Not operator-gated, deliberately: the file never contains a swarm-wide credential, only a
 *   per-device token the caller already has the right to mint through `POST /enroll`. What
 *   this adds over that endpoint is that the credential arrives already inside something the
 *   person can run.
 *
 *   `?platform=` selects which script is rendered; absent means `windows`, so every link
 *   minted before this route knew about platforms keeps working.
 * @param router - The authenticated join router.
 * @param pool - The swarm database, or null on a database-less deployment.
 * @returns Nothing.
 */
export function registerNodeInstallerRoute(router: Router, pool: Pool | null): void {
  router.get('/node-installer', async (req: Request, res: Response) => {
    const { sub, email } = getCaller(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    if (!pool) { res.status(503).json({ error: 'enrollment_unavailable' }); return; }

    if (!sharedSecretRetired()) {
      // Refuse rather than emit a script that cannot register — and rather than reach for the
      // swarm-wide secret to make it work, which would put a credential for EVERY node in a
      // per-user download.
      res.status(409).json({
        error: 'node_token_not_required',
        message:
          'This swarm still accepts the swarm-wide shared secret, so a new computer also needs '
          + 'an operator join code. Set REMOTE_CLIENT_REQUIRE_NODE_TOKEN=true to make a '
          + 'per-device token sufficient, and this download becomes self-contained.',
      });
      return;
    }

    // Before the mint, deliberately: a refused download must not leave a live credential
    // behind for a file the caller never received.
    const platform = resolveInstallerPlatform(req.query.platform);
    if (!platform) {
      res.status(400).json({
        error: 'unsupported_platform',
        message: 'This swarm renders an installer for '
          + INSTALLER_PLATFORMS.join(', ') + '. Ask for one of those.',
      });
      return;
    }

    const requested = String(req.query.name ?? '')
      .replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 40);
    const nodeName = requested || 'my-computer';
    // A fresh device id per download, so two computers enrolled by one person hold two
    // credentials and revoking one leaves the other working.
    const clientId = 'node-' + randomUUID();

    try {
      const { url, loopback } = resolveControlPlaneUrl(req);
      if (loopback) {
        // A localhost URL inside a downloaded installer points the new computer at itself.
        res.status(409).json({
          error: 'loopback_control_plane',
          message:
            'You are browsing over localhost, so the installer would point the new computer at '
            + 'itself. Open the cockpit from this swarm\'s LAN address or public hostname and '
            + 'download again.',
        });
        return;
      }
      const minted = await insertCliToken(pool, {
        sub,
        email,
        principalIssuer: getAuthenticatedPrincipalIssuer(req),
        label: 'node ' + clientId,
        nodeClientId: clientId,
      });
      const shape = {
        controlPlaneUrl: url, token: minted.token, clientId, nodeName,
        nodePackage: nodePackageSpec(),
      };
      const script = platform === 'windows'
        ? renderNodeInstaller(shape)
        : renderPosixNodeInstaller({ ...shape, platform });
      // The token itself is never logged — only which device it was bound to.
      logger.info({ id: minted.id, sub, nodeClientId: clientId, platform },
        'one-click node installer issued');
      res.setHeader('Content-Type', 'application/octet-stream');
      // On Windows .cmd, not .ps1: a batch file is outside PowerShell's execution policy, so
      // it runs on a double-click, while a .ps1 is refused as "not digitally signed" on any
      // default Windows. Elsewhere a plain .sh the person runs through bash.
      res.setHeader('Content-Disposition',
        `attachment; filename="${installerFilename(platform)}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(script);
    } catch (err) {
      logger.error({ err, sub }, 'one-click node installer failed');
      res.status(500).json({ error: 'installer_render_failed' });
    }
  });
}

/**
 * @description Resolves the URL a downloaded installer should dial back on, and whether that
 *   URL only resolves on this machine.
 * @param req - The request the cockpit made.
 * @returns The absolute control-plane URL and whether it is loopback-only.
 */
function resolveControlPlaneUrl(req: Request): { url: string; loopback: boolean } {
  const forwardedHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  const host = forwardedHost || String(req.headers.host ?? '').trim();
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  return { url: `${protocol}://${host}`, loopback };
}
