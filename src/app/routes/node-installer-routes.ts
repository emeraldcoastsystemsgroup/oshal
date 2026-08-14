/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | One-click worker-node install: mint the caller's per-device credential and return a runnable script with it already in place, so nothing has to be pasted into Settings.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Say plainly that the file belongs in an Open Swarm folder. The first version fetched an install script from a route that never existed, and even fetching it would have died on the missing packages/oshal-chat.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Pass -ClientId through: a device-bound token names the device it may register as, and the node was minting its own id, so the control plane refused every one-click enrolment.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Install the node app from npm instead of building it from a checkout, so the download works on a machine that has never seen this repo. The package is configurable (OSHAL_NODE_PACKAGE).
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
    '$major = [int](($nodeVersion.TrimStart("v") -split "\.")[0])',
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
    'Write-Host "Starting the node so it can register..."',
    'Start-Process -FilePath "oshal-chat" -WindowStyle Hidden',
    '',
    'Write-Host ""',
    'Write-Host "Done. This computer should appear in the cockpit within a minute."'
      + ' -ForegroundColor Green',
    'Write-Host "You can delete this file now." -ForegroundColor DarkGray',
    '',
  ];
  return lines.join('\r\n');
}

/**
 * @description Registers `GET /node-installer` on the join router.
 *
 *   Not operator-gated, deliberately: the file never contains a swarm-wide credential, only a
 *   per-device token the caller already has the right to mint through `POST /enroll`. What
 *   this adds over that endpoint is that the credential arrives already inside something the
 *   person can run.
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
      const script = renderNodeInstaller({
        controlPlaneUrl: url, token: minted.token, clientId, nodeName,
        nodePackage: nodePackageSpec(),
      });
      // The token itself is never logged — only which device it was bound to.
      logger.info({ id: minted.id, sub, nodeClientId: clientId }, 'one-click node installer issued');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="install-oshal-node.ps1"');
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
