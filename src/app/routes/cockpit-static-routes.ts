/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of dedicated cockpit/static asset route registration to reduce server.ts size before engineering-screen retrofit work
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Hardened cockpit sendFile error handling so retrofit validation typechecks cleanly
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added /css and /js static aliases so legacy ui-enhanced engineering pages resolve absolute asset references
 */

import express from 'express';
import path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'cockpit-static-routes' });

/**
 * @description Route registration dependencies for cockpit and shared static assets.
 */
export interface CockpitStaticRoutesOptions {
  app: Pick<express.Application, 'get' | 'use'>;
  requiresAuth: express.RequestHandler;
  cockpitDir: string;
  uiEnhancedDir: string;
  codiconFontsDir: string;
  sharedUiCssDir: string;
  /** Shared surface JS (surface-theme.js) — served public, see the mount comment. */
  sharedUiJsDir: string;
}

/**
 * @description Registers cockpit HTML/static assets plus supporting shared static directories.
 *
 * @param options - Auth, directories, and application dependencies required for cockpit route mounts.
 * @returns Nothing; mutates the provided Express app with cockpit/static route mounts.
 */
export function registerCockpitStaticRoutes(options: CockpitStaticRoutesOptions): void {
  logger.info({ cockpitDir: options.cockpitDir }, 'Registering cockpit static routes');

  // Force revalidation on cockpit HTML/JS/CSS. Cloudflare edge-caches static assets by
  // default (hours), ignoring max-age=0, so freshly deployed cockpit JS kept serving stale
  // on the hosted URL. `no-cache` => browser AND CF must revalidate with the origin every
  // time (cheap 304 when unchanged), so a rebuild is visible on the next reload.
  const noCache: express.RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    next();
  };

  options.app.use('/cockpit', options.requiresAuth, noCache, express.static(options.cockpitDir));
  options.app.get('/cockpit/', options.requiresAuth, noCache, (_req, res) => {
    logger.info('GET /cockpit/ (authenticated)');
    res.sendFile(path.join(options.cockpitDir, 'index.html'), (error) => {
      if (!error) {
        return;
      }

      logger.error({ err: error, cockpitDir: options.cockpitDir }, 'Failed to send cockpit index.html');
      if (!res.headersSent) {
        res.status(readSendFileStatusCode(error)).end();
      }
    });
  });

  options.app.use('/ui-enhanced', options.requiresAuth, express.static(options.uiEnhancedDir));

  // Legacy engineering page asset aliases — absolute /css/* and /js/* paths used by ui-enhanced HTML
  const uiEnhancedCssDir = require('path').join(options.uiEnhancedDir, 'css');
  const uiEnhancedJsDir = require('path').join(options.uiEnhancedDir, 'js');
  options.app.use('/css', options.requiresAuth, express.static(uiEnhancedCssDir));
  options.app.use('/js', options.requiresAuth, express.static(uiEnhancedJsDir));
  logger.info({ uiEnhancedCssDir, uiEnhancedJsDir }, 'Registered /css and /js legacy asset aliases');

  // Codicon font/icon CSS is a non-sensitive static asset loaded by every surface (incl. the
  // embedded swarmbot/chat iframe). It must NOT be auth-gated — a requiresAuth 302→/login returns
  // HTML, so the browser rejects it as a stylesheet ("failed to load codicon.css"). Serve public.
  options.app.use('/fonts', express.static(options.codiconFontsDir));
  options.app.use('/shared/ui/css', express.static(options.sharedUiCssDir));
  // NOTE: /shared/ui/js (surface-theme.js) is mounted in server.ts BEFORE the OIDC middleware —
  // NOT here. This function runs after OIDC, so a mount here would 302 to /login (the exact bug the
  // CSS mount in server.ts already dodges). Keep the theme bootstrap's mount beside the CSS one.
}

// Read the most specific HTTP status code available from Express sendFile errors.
function readSendFileStatusCode(error: Error & Partial<{ statusCode: number; status: number }>): number {
  if (typeof error.statusCode === 'number' && error.statusCode > 0) {
    return error.statusCode;
  }
  if (typeof error.status === 'number' && error.status > 0) {
    return error.status;
  }
  return 500;
}
