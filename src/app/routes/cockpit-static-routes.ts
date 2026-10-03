/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial implementation of dedicated cockpit/static asset route registration to reduce server.ts size before engineering-screen retrofit work
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Hardened cockpit sendFile error handling so retrofit validation typechecks cleanly
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Added /css and /js static aliases so legacy ui-enhanced engineering pages resolve absolute asset references
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Mount a fixed authenticated allowlist for locked local startup dependencies.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | ADR-164 experience shells: resolve the experience directory like cockpitDir (src/ or the image copy) so /portal, /studio, /jarvis, /orbit, /commons, /homebase and /nexus serve from the built container; the dist-relative guess, the layout-prefixed cockpit duplicates and the store-checkout Little Monsters mount are gone, and /little-monsters redirects to the classroom preset.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Serve /simple (simple.html, docs/architecture/simple-chat.md) behind requiresAuth like every experience entry page: the opt-in plain text screen over the caller's Jarvis thread.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Shell lock (ADR-164 amendment, 2026-10-02): with the optional `shellLock` ports, a non-operator on a deployment whose landing names an application is redirected from the plain cockpit document (incl. index.html, decided before the static mount) and every experience entry page to that landing; operators, focused ?app= requests and assets are untouched. A customer's staff opened the product they were sold and found the operator cockpit one click away.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Route legacy experience entries through installed package open authorization while preserving shared assets and focused landing behavior.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { createChildLogger } from '@/shared/logger';
import { OPERATOR_SURFACES, shellRedirectFor } from '@/app/experience-shell-lock';
import { registerCockpitVendorAssets } from './cockpit-vendor-assets';

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
  /**
   * Shell lock (ADR-164 amendment): on a deployment whose landing names an application, a signed-in
   * non-operator asking for the plain cockpit document or an experience entry page is redirected to
   * that landing. Omitted = no lock (every surface served as before).
   */
  shellLock?: {
    isOperator(req: express.Request): boolean;
    landingPath(req: express.Request): string;
  };
}

/** Entry pages served from the experience directory: every path an experience chooser links to. */
const EXPERIENCE_PAGES: ReadonlyArray<readonly [string[], string]> = [
  [['/experience', '/experience/', '/portal', '/portal/'], 'index.html'],
  [['/nexus', '/nexus/'], 'nexus.html'],
  // Simple chat (docs/architecture/simple-chat.md): the plain text screen over the caller's Jarvis thread.
  [['/simple', '/simple/'], 'simple.html'],
];

/**
 * @description Locate the experience directory for this process: beside the compiled routes when a
 * build copies it there, otherwise `src/experience` under the working directory (ts-node and the
 * image, where the Dockerfile copies the source tree). The first candidate holding index.html wins.
 * @returns Absolute directory path; the first candidate when none exists so the 404 names a real path.
 */
export function resolveExperienceDir(): string {
  const candidates = [path.resolve(__dirname, '../../experience'), path.resolve(process.cwd(), 'src/experience')];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? candidates[0];
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

  // Shell lock: registered ONCE over every operator surface, ahead of every static mount, so
  // neither `/cockpit/index.html` nor the `/experience/` directory index can bypass the document
  // routes. Assets never pass through it (they are not surfaces).
  const shellLockGuard: express.RequestHandler = (req, res, next) => {
    const lock = options.shellLock;
    if (!lock) { next(); return; }
    const redirect = shellRedirectFor({
      operator: lock.isOperator(req), landingPath: lock.landingPath(req), pathname: req.path,
      requestedApp: req.query.app ?? req.query.profile,
    });
    if (!redirect) { next(); return; }
    logger.info({ path: req.path, redirect }, 'Operator surface requested by a non-operator on a focused-landing deployment; redirecting to the landing');
    res.redirect(302, redirect);
  };
  options.app.get([...OPERATOR_SURFACES], options.requiresAuth, shellLockGuard);

  registerCockpitVendorAssets(options.app, options.requiresAuth, noCache);
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

  // ADR-164 experience shells: one authenticated static mount plus the named entry pages. The
  // directory is resolved the same way as cockpitDir so ts-node (src/) and the built image
  // (/app/src/experience, copied by Dockerfile.oshal) both serve it; a dist-relative guess 404s.
  const experienceDir = resolveExperienceDir();
  // These documents belong to installed applications. Even a raw legacy HTML URL
  // passes through the same independently authorized open operation as the chooser.
  const legacyEntries: Array<[string[], (req: express.Request) => string]> = [
    ...['studio', 'jarvis', 'orbit', 'commons'].map((name): [string[], () => string] =>
      [[`/${name}`, `/${name}/`, `/experience/${name}.html`], () => `${name}-experience`]),
    [['/homebase', '/homebase/', '/experience/homebase.html'], (req) =>
      req.query.preset === 'company' ? 'business-experience' : req.query.preset === 'classroom' ? 'classroom-experience' : 'home-experience'],
    [['/little-monsters', '/little-monsters/'], () => 'classroom-experience'],
  ];
  for (const [paths, packageFor] of legacyEntries) {
    options.app.get(paths, options.requiresAuth, noCache, (req, res) => {
      const lock = options.shellLock;
      const landing = lock && shellRedirectFor({ operator: lock.isOperator(req), landingPath: lock.landingPath(req),
        pathname: '/homebase', requestedApp: req.query.app ?? req.query.profile });
      res.redirect(302, landing || `/api/ui/experiences/${packageFor(req)}/open`);
    });
  }
  options.app.use('/experience', options.requiresAuth, noCache, express.static(experienceDir));
  const sendHtml = (filePath: string): express.RequestHandler => (_req, res) => {
    res.sendFile(filePath, (error) => {
      if (!error) {
        return;
      }
      logger.error({ err: error, filePath }, 'Failed to send experience page');
      if (!res.headersSent) {
        res.status(readSendFileStatusCode(error)).end();
      }
    });
  };
  for (const [paths, file] of EXPERIENCE_PAGES) {
    options.app.get(paths, options.requiresAuth, noCache, sendHtml(path.join(experienceDir, file)));
  }
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
