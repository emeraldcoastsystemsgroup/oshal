/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of dedicated standalone UI-surface route registration so engineering screens can be added without growing server.ts further
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Mounted shared standalone page assets and inferred folder-name aliases so containerized /config pages resolve CSS and module dependencies correctly
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added nested route shared-asset aliases so /swarmbot/chat pages can resolve ../shared module imports inside cockpit embeds
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Optional per-page guestWelcome flag: an opted-in surface (the /applications app-store preview) wraps its auth in createGuestWelcomeMat so anonymous visitors 302 to the /guest landing (with ?next= back here) instead of the OIDC provider
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import type { StaticHtmlPageRouteOptions } from './static-html-page-route';
import { registerStaticHtmlPageRoute } from './static-html-page-route';
import { createGuestWelcomeMat } from '@/shared/middleware/guest-session';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'ui-surface-routes' });

/**
 * @description Definition for one auth-protected standalone UI surface.
 */
export interface UiSurfacePageDefinition {
  routePath: string;
  pageDir: string;
  /** Extra middleware mounted after requiresAuth for this page (e.g. an admin-only gate). */
  extraGuards?: express.RequestHandler[];
  /**
   * When true, anonymous visitors are 302'd to the /guest landing (carrying a ?next=
   * deep link back to this page) instead of the OIDC provider — for surfaces that
   * double as public previews. No-op when ENABLE_GUEST_MODE is off.
   */
  guestWelcome?: boolean;
}

/**
 * @description Registration dependencies for grouped standalone UI surface routes.
 */
export interface UiSurfaceRoutesOptions {
  app: Pick<express.Application, 'get' | 'use'>;
  requiresAuth: express.RequestHandler;
  serveHtml: StaticHtmlPageRouteOptions['serveHtml'];
  pages: UiSurfacePageDefinition[];
}

/**
 * @description Registers multiple auth-protected standalone HTML surfaces using the shared page-route helper.
 *
 * @param options - App, auth, HTML response helper, and page definitions to mount.
 * @returns Nothing; mutates the provided Express app with standalone page mounts.
 */
export function registerUiSurfaceRoutes(options: UiSurfaceRoutesOptions): void {
  logger.info({ routeCount: options.pages.length }, 'Registering standalone UI surface routes');

  registerSharedUiSurfaceAssets(options);

  for (const page of options.pages) {
    registerStaticHtmlPageRoute({
      app: options.app,
      assetAliases: inferAssetAliases(page.routePath, page.pageDir),
      pageDir: page.pageDir,
      requiresAuth: page.guestWelcome ? createGuestWelcomeMat(options.requiresAuth) : options.requiresAuth,
      extraGuards: page.extraGuards,
      routePath: page.routePath,
      serveHtml: options.serveHtml,
      onRequestLog: (routePath) => logger.info({ routePath }, 'Serving standalone UI surface route'),
    });
  }
}

/**
 * @description Infers stable static asset aliases for standalone page routes when the public route
 * path differs from the underlying folder name. This preserves absolute asset URLs like
 * `/config-admin/config-admin.css` even when the HTML page itself is mounted at `/config`.
 *
 * @param routePath - Public page route path.
 * @param pageDir - Source directory containing the standalone page assets.
 * @returns Additional static mount aliases for the page directory.
 */
function inferAssetAliases(routePath: string, pageDir: string): string[] {
  const routeBaseName = path.posix.basename(routePath);
  const pageDirBaseName = path.basename(pageDir);

  if (!pageDirBaseName || pageDirBaseName === routeBaseName) {
    return [];
  }

  return [`/${pageDirBaseName}`];
}

/**
 * @description Registers the shared standalone page asset directory so page modules can import
 * common helpers such as `/shared/ui-debug.js` regardless of which standalone route served them.
 *
 * @param options - Shared standalone UI surface route registration options.
 */
function registerSharedUiSurfaceAssets(options: UiSurfaceRoutesOptions): void {
  if (options.pages.length === 0) {
    return;
  }

  const sharedAssetsDir = path.resolve(path.dirname(options.pages[0].pageDir), 'shared');
  if (!fs.existsSync(sharedAssetsDir)) {
    logger.warn({ sharedAssetsDir }, 'Shared standalone UI asset directory not found; skipping /shared static mount');
    return;
  }

  const sharedAssetMountPaths = inferSharedAssetMountPaths(options.pages);

  for (const sharedAssetMountPath of sharedAssetMountPaths) {
    options.app.use(
      sharedAssetMountPath,
      options.requiresAuth,
      express.static(sharedAssetsDir, { index: false, redirect: false }),
    );
  }

  logger.info({ sharedAssetsDir, sharedAssetMountPaths }, 'Registered shared standalone UI assets');
}

/**
 * @description Infers every shared-asset mount path needed by the current standalone route set.
 * Top-level pages import shared helpers through `/shared/...`, while nested routes like
 * `/swarmbot/chat/...` resolve `../shared/...` to `/swarmbot/shared/...`.
 *
 * @param pages - Registered standalone UI pages.
 * @returns Unique shared asset mount paths.
 */
function inferSharedAssetMountPaths(pages: UiSurfacePageDefinition[]): string[] {
  const mountPaths = new Set<string>(['/shared']);

  for (const page of pages) {
    const parentRoutePath = page.routePath.split('/').slice(0, -1).filter((segment) => segment.length > 0).join('/');
    if (!parentRoutePath) {
      continue;
    }

    mountPaths.add(`/${parentRoutePath}/shared`);
  }

  return Array.from(mountPaths);
}