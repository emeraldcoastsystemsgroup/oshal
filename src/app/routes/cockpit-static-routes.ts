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
  // on the hosted URL.
  //
  // `no-cache` WAS NOT ENOUGH, and this is measured, not theorised. On the hosted deployment:
  //
  //   origin :35457 -> Cache-Control: no-cache, must-revalidate      (what we set)
  //   edge   https:// -> Cache-Control: max-age=14400, must-revalidate  (what the browser got)
  //
  // Cloudflare's "Browser Cache TTL" zone setting defaults to 4 hours and REWRITES the header it
  // sends downstream for anything it considers cacheable. `no-cache` is still cacheable-with-
  // revalidation, so it was rewritten — pinning freshly deployed assets in every user's browser
  // for four hours while the origin, the edge and the container all verifiably held the new
  // bytes. That is what made a correct deploy indistinguishable from a failed one.
  //
  // `no-store` is not merely a stronger hint: it makes the response non-cacheable outright, which
  // takes it out of the set that Browser Cache TTL applies to. Cost is a full re-fetch instead of
  // a 304 — trivial for these files, and they were already revalidating on every request anyway.
  // The PWA is unaffected: the service worker's Cache Storage is separate from the HTTP cache and
  // is not bound by no-store, so offline still works from the precached shell.
  //
  // The zone setting (Caching -> Configuration -> Browser Cache TTL -> "Respect Existing Headers")
  // is the cleaner fix, but it lives in someone's dashboard; this one ships with the code.
  const noCache: express.RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
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
