/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted repeated native standalone page mounting from server.ts to keep the server under the 800-line governance trigger
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added static asset alias support so mounted UI pages can serve assets from stable route names when page routes differ from folder names
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added optional per-page extraGuards (mounted after requiresAuth) so a surface like the admin console can require admin role independent of global RBAC enforcement
 */

import express from 'express';
import path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'static-html-page-route' });

/**
 * @description Parameters required to mount one auth-protected standalone HTML page with static assets.
 */
export interface StaticHtmlPageRouteOptions {
  app: Pick<express.Application, 'get' | 'use'>;
  pageDir: string;
  requiresAuth: express.RequestHandler;
  routePath: string;
  assetAliases?: string[];
  serveHtml: (res: express.Response, filePath: string, routePath: string) => void;
  onRequestLog?: (routePath: string) => void;
  /** Extra middleware mounted AFTER requiresAuth (e.g. an admin-only gate) for both doc + assets. */
  extraGuards?: express.RequestHandler[];
}

/**
 * @description Mount an auth-protected standalone HTML page and its sibling static assets.
 *
 * @param options - Route mount dependencies including auth, page directory, and HTML response helper.
 * @returns Nothing; mutates the provided Express app with GET and static mounts.
 */
export function registerStaticHtmlPageRoute(options: StaticHtmlPageRouteOptions): void {
  const routeVariants = [options.routePath, `${options.routePath}/`];
  const indexFile = path.join(options.pageDir, 'index.html');
  const staticMountPaths = Array.from(
    new Set([options.routePath, ...(options.assetAliases ?? [])].filter((value) => value.length > 0)),
  );

  logger.info(
    { routePath: options.routePath, pageDir: options.pageDir, staticMountPaths },
    'Registering static HTML page route',
  );

  const extraGuards = options.extraGuards ?? [];

  options.app.get(routeVariants, options.requiresAuth, ...extraGuards, (_req, res) => {
    logger.info({ routePath: options.routePath, filePath: indexFile }, 'Serving static HTML page route');
    options.onRequestLog?.(options.routePath);
    options.serveHtml(res, indexFile, options.routePath);
  });

  for (const staticMountPath of staticMountPaths) {
    options.app.use(
      staticMountPath,
      options.requiresAuth,
      ...extraGuards,
      express.static(options.pageDir, { index: false, redirect: false }),
    );
  }

  logger.info({ routePath: options.routePath, staticMountPaths }, 'Static HTML assets registered');
}
