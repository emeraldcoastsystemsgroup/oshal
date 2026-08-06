/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 P1: in-process dynamic mount/unmount of an installed app package's own compiled-JS routes, flag-gated (APP_PACKAGE_DYNAMIC_ROUTES), so a package can bring its Express routes without being compiled into the core image.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Register @/ runtime alias resolution (framework root from __dirname → dist in prod / src in dev) so a package's route JS resolves framework modules by alias wherever it sits on disk; load modules via createRequire for bundler/test-runner robustness. Verified end-to-end by tests/unit/manifest-route-mounter.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Set OSHAL_APP_PACKAGE_DIR before each package-module require so package sources resolve their bundled assets (tools/, ui/) from the package dir at module-load time (little-monsters' education surfaces are the first consumer).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | dispatch() now CHAINS every matching package router (most-specific mount first, declaration order within a mount) instead of running a single "best" one — little-monsters declares 3 modules at /api/education and only the first was reachable, 404ing the calendar + voice modules (silent TTS).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | D10 fix: each package factory now receives a PER-PACKAGE context carrying ctx.appPackageDir. The process-global OSHAL_APP_PACKAGE_DIR env var stays as a load-time-only channel (set→require is synchronous) but request-time readers got whichever package mounted LAST — with 2+ apps, a reload made one app serve another's bundled assets.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D2: apply the manifest's declared route AUTH MODE (oidc | service-or-oidc | service | operator | public) instead of a single boolean. The mounter knew ONE posture (plain OIDC), which is why serviceSecretOr apps could not carve — carving one would have re-authed it and 401'd every bot node, the headless CLI and its own in-container tools. Guards are built once at mount; an omitted or unknown mode resolves to 'oidc', never anonymous. Also hands the package a resolved caller sub (oshalCallerSub) under service/service-or-oidc, where a valid secret passes WITHOUT populating req.oidc — a carved app reading getCaller() would otherwise see a null sub and mis-scope its user_sub-keyed store.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Extract the real tsconfig-paths registration seam so regression tests resolve an @/ module from an external package with Node createRequire instead of stubbing the resolver the fix depends on.
 */

import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import { resolve as resolvePath } from 'path';
import { createRequire } from 'module';
import * as tsconfigPaths from 'tsconfig-paths';
import { createChildLogger } from '@/shared/logger';
import {
  getTrustedServiceUserSub,
  hasValidServiceSecret,
  requiresOperator,
  serviceSecretOr,
} from '@/shared/middleware/authz';
import { resolveRouteAuthMode, type SwarmAppRouteAuthMode } from '@/shared/route-auth';
import type { ManifestRouteMounter, SwarmAppRouteDeclaration } from '@/features/swarm-apps';
import type { AppContext } from '@/app/composition/app-context';

const logger = createChildLogger({ module: 'manifest-route-mounter' });

// A genuine Node require bound to this module — used to load a package's external route
// modules by absolute path. createRequire is robust under bundlers/test runners that would
// otherwise shim the ambient `require`, and exposes `.resolve` + `.cache` for reloads.
const nodeRequire = createRequire(__filename);

/**
 * @description Register the package-facing `@/` alias against one concrete framework root.
 * Keeping this as an executable seam lets tests prove Node can resolve an external package's
 * framework import; a mocked resolver would stay green if tsconfig-paths wiring regressed.
 * @param frameworkRoot - Absolute `src/` or `dist/` root exposed to installed package routes.
 * @returns A cleanup callback that restores the previous Node resolver hook.
 */
export function registerPackageFrameworkAliases(frameworkRoot: string): () => void {
  return tsconfigPaths.register({ baseUrl: frameworkRoot, paths: { '@/*': ['*'] } });
}

/** One dynamically-mounted route belonging to an installed app package. */
interface MountedRoute {
  /** The URL prefix this route owns, e.g. `/api/education`. */
  mountPath: string;
  /** ADR-085 D2: the resolved auth posture for this route. */
  mode: SwarmAppRouteAuthMode;
  /** The middleware chain implementing `mode`, built ONCE at mount (never per request). */
  guards: RequestHandler[];
  /** The package's own router/handler (result of calling its exported factory). */
  handler: RequestHandler;
}

/**
 * @description In-process implementation of the ManifestRouteMounter port (ADR-085 P1).
 * Lets an installed app package (in `deployed-apps/<name>/`) contribute its own Express
 * routes at activation time, WITHOUT those routes being compiled into the core image and
 * hard-mounted in server.ts. It resolves each declared route module as compiled JS relative
 * to the package directory, calls its exported factory to build a router, and dispatches
 * matching requests to it through a single middleware installed once at construction.
 *
 * Reversibility is the point: a per-app entry list is added on mount and dropped on unmount,
 * so toggling/uninstalling an app cleanly removes its routes with no Express-internal surgery.
 *
 * Safety: the whole mechanism is gated on `APP_PACKAGE_DYNAMIC_ROUTES`. When the flag is off
 * (the default) the dispatcher is never installed and mount/unmount are no-ops — activation is
 * byte-for-byte unchanged and the framework's hardcoded server.ts mounts remain authoritative.
 */
export class ManifestRouteMounterImpl implements ManifestRouteMounter {
  /** appName → its mounted routes. Absent app = nothing mounted. */
  private readonly byApp = new Map<string, MountedRoute[]>();
  private readonly enabled: boolean;

  /**
   * @param app - the Express application (the dispatcher middleware is installed on it)
   * @param requiresAuth - the framework's auth middleware, applied per route when declared
   * @param ctx - the app context passed to each package's route factory
   */
  constructor(
    app: Express,
    private readonly requiresAuth: RequestHandler,
    private readonly ctx: AppContext,
  ) {
    this.enabled = ['1', 'true', 'yes'].includes(
      (process.env.APP_PACKAGE_DYNAMIC_ROUTES || '').trim().toLowerCase(),
    );
    if (!this.enabled) {
      logger.info('Dynamic manifest route mounting disabled (set APP_PACKAGE_DYNAMIC_ROUTES=1 to enable)');
      return;
    }
    this.registerFrameworkAliasResolution();
    // Install the single dispatcher exactly once. It is inert until an app mounts routes.
    app.use((req: Request, res: Response, next: NextFunction) => this.dispatch(req, res, next));
    logger.info('Dynamic manifest route mounting ENABLED');
  }

  /**
   * @description Make `@/…` framework imports resolvable from a package's route modules.
   * A package ships route JS whose framework imports are LEFT as `@/features/…` (not rewritten
   * to relative paths), so they resolve to the RUNNING framework wherever the package sits on
   * disk. But the framework's own dist uses tsc-alias-rewritten relative requires, so `@/` is
   * unregistered at runtime in prod — register it here, mapping `@/*` to the framework root
   * derived from this module's location (`dist/` in prod, `src/` in dev). Only runs when dynamic
   * routes are enabled; skipped under vitest (its own resolver handles `@/`); non-fatal.
   */
  private registerFrameworkAliasResolution(): void {
    if (process.env.VITEST) return;
    try {
      const frameworkRoot = resolvePath(__dirname, '..', '..'); // dist/ (prod) or src/ (dev)
      registerPackageFrameworkAliases(frameworkRoot);
      logger.info({ frameworkRoot }, 'Registered @/ runtime alias resolution for package routes');
    } catch (err) {
      logger.error({ err }, 'Failed to register @/ alias resolution — package routes with framework imports may fail to load');
    }
  }

  /**
   * @description Resolve + mount every route the app's manifest declares. Each declaration's
   * `module` is resolved as compiled JS relative to `packageDir`; its exported `factory` is
   * called with the app context to build a router. Failures are logged and skipped so one bad
   * module cannot brick activation. No-op when the feature flag is off.
   */
  async mount(appName: string, packageDir: string, routes: SwarmAppRouteDeclaration[]): Promise<void> {
    if (!this.enabled || !routes.length) return;
    const entries: MountedRoute[] = [];
    for (const decl of routes) {
      try {
        // Legacy core manifests carry INFORMATIONAL routes[] (repo paths like
        // src/app/routes/x.ts) that don't exist under the manifest dir — those are
        // hard-mounted in server.ts, not ours to load. Skip quietly, not as an error.
        const declared = resolvePath(packageDir, decl.module);
        if (!require('fs').existsSync(declared)) {
          logger.info({ appName, module: decl.module }, 'Route declaration not package-relative — skipped (hard-mounted by the framework)');
          continue;
        }
        const modPath = nodeRequire.resolve(declared);
        // Bust the cache so a reinstall of the same package picks up new code.
        delete nodeRequire.cache[modPath];
        // LOAD-TIME-ONLY channel: package modules may read OSHAL_APP_PACKAGE_DIR into a
        // module const while being required (set→require is synchronous, so concurrent
        // mounts can't interleave here). It is NOT valid at request time — after the next
        // mount it points at a DIFFERENT package (D10). The sanctioned request-time channel
        // is ctx.appPackageDir on the per-package context below.
        process.env.OSHAL_APP_PACKAGE_DIR = packageDir;
        const mod = nodeRequire(modPath) as Record<string, unknown>;
        const factory = mod[decl.factory];
        if (typeof factory !== 'function') {
          logger.error({ appName, module: decl.module, factory: decl.factory }, 'Route factory not found or not a function — skipping');
          continue;
        }
        // Per-package context: same framework services, plus THIS package's own directory.
        // The factory captures appPackageDir once, so serving bundled assets stays correct
        // no matter how many packages mount or reload afterwards.
        const packageCtx: AppContext = { ...this.ctx, appPackageDir: packageDir };
        const handler = (factory as (ctx: AppContext) => RequestHandler)(packageCtx);
        if (typeof handler !== 'function') {
          logger.error({ appName, module: decl.module, factory: decl.factory }, 'Route factory did not return a handler — skipping');
          continue;
        }
        // ADR-085 D2: resolve the declared posture. Fail-safe at every branch — an omitted or
        // unrecognized `auth` resolves to `oidc`, never to anonymous. An app-contributed route
        // must not become publicly callable through a forgotten field (CLAUDE.md: auth is opt-in
        // per route, so an unwrapped Express route IS public).
        const mode = resolveRouteAuthMode(decl);
        const guards = this.buildGuards(mode, appName, decl.mountPath);
        entries.push({ mountPath: decl.mountPath, mode, guards, handler });
        logger.info({ appName, mountPath: decl.mountPath, module: decl.module, auth: mode }, 'Mounted package route');
      } catch (err) {
        logger.error({ err, appName, module: decl.module }, 'Failed to mount package route (skipping)');
      }
    }
    if (entries.length) this.byApp.set(appName, entries);
  }

  /**
   * @description Build the middleware chain for a declared auth mode (ADR-085 D2).
   *
   * Built once per route at MOUNT time, never per request. Before D2 the mounter knew a single
   * posture (plain OIDC), which is why `serviceSecretOr` apps could not carve: carving one would
   * have re-authed it and 401'd every bot node, the headless CLI, and its own in-container tools.
   *
   * `service` is deliberately NOT `requireServiceSecretWhenConfigured` — that helper is FAIL-OPEN
   * when `SWARM_SERVICE_SECRET` is unset (it is bot-node-side, where that is the right call). A
   * manifest-reachable mode must never be fail-open: with no secret configured, nothing can present
   * one, so the route is closed.
   *
   * @param mode - The resolved auth mode.
   * @param appName - Owning app, for the anonymous-route warning.
   * @param mountPath - The route's mount, for the anonymous-route warning.
   * @returns The guard chain, in order.
   */
  private buildGuards(mode: SwarmAppRouteAuthMode, appName: string, mountPath: string): RequestHandler[] {
    switch (mode) {
      case 'service-or-oidc':
        return [serviceSecretOr(this.requiresAuth)];
      case 'service':
        return [
          (req: Request, res: Response, next: NextFunction): void => {
            if (hasValidServiceSecret(req)) {
              next();
              return;
            }
            logger.warn({ appName, mountPath }, 'Package route requires the service secret — rejected');
            res.status(401).json({ error: 'This route requires a valid service secret' });
          },
        ];
      case 'operator':
        return [this.requiresAuth, requiresOperator];
      case 'public':
        logger.warn(
          { appName, mountPath },
          'Package route mounted ANONYMOUS (auth: public) — it must self-guard inside the router',
        );
        return [];
      case 'oidc':
      default:
        return [this.requiresAuth];
    }
  }

  /** @description Remove every route mounted for this app. Idempotent; no-op when flag off. */
  unmount(appName: string): void {
    if (!this.enabled) return;
    if (this.byApp.delete(appName)) {
      logger.info({ appName }, 'Unmounted package routes');
    }
  }

  /**
   * @description The single dispatcher middleware. Collects EVERY active package route whose
   * mountPath prefixes the request path and runs them as a chain — most-specific mount first,
   * declaration order within the same mount — exactly as Express treats multiple app.use()
   * registrations on one path. A router that doesn't match falls through to the next entry,
   * not straight out of the package layer: an app may legitimately split one mountPath across
   * several modules (little-monsters mounts 3 at /api/education). O(routes) per request, and
   * skipped entirely when nothing is mounted.
   */
  private dispatch(req: Request, res: Response, next: NextFunction): void {
    if (this.byApp.size === 0) {
      next();
      return;
    }
    const matches: MountedRoute[] = [];
    for (const entries of this.byApp.values()) {
      for (const e of entries) {
        if (req.path === e.mountPath || req.path.startsWith(e.mountPath + '/')) {
          matches.push(e);
        }
      }
    }
    if (!matches.length) {
      next();
      return;
    }
    // Stable sort: longer (more specific) mounts first; same-mount entries keep manifest order.
    matches.sort((a, b) => b.mountPath.length - a.mountPath.length);
    const runAt = (i: number): void => {
      if (i >= matches.length) {
        next();
        return;
      }
      this.run(matches[i], req, res, (err?: unknown) => {
        if (err) {
          next(err as Parameters<NextFunction>[0]);
          return;
        }
        runAt(i + 1);
      });
    };
    runAt(0);
  }

  /**
   * @description Run one matched package route the way `app.use(mountPath, [auth], handler)`
   * would: apply auth first when declared, then invoke the handler with the mount-path prefix
   * stripped from req.url (restoring it if the handler falls through to next). This replicates
   * Express's own mount-path stripping without touching Express internals, so mounting is
   * fully dynamic and reversible.
   */
  private run(entry: MountedRoute, req: Request, res: Response, next: NextFunction): void {
    const originalUrl = req.url;
    const remainder = originalUrl.slice(entry.mountPath.length) || '/';
    const invoke = (): void => {
      // ADR-085 D2: hand the package a resolved caller identity. Under `service`/`service-or-oidc`
      // a valid secret passes WITHOUT populating req.oidc, so a carved app reading getCaller(req)
      // would see a null sub and mis-scope its user_sub-keyed store — the ADR-036 failure mode.
      // Core's serviceSecretOr routers each resolve this themselves; packages get it for free.
      const trusted = getTrustedServiceUserSub(req);
      if (trusted) (req as Request & { oshalCallerSub?: string }).oshalCallerSub = trusted;

      req.url = remainder.startsWith('/') ? remainder : '/' + remainder;
      entry.handler(req, res, (err?: unknown) => {
        req.url = originalUrl; // restore for any downstream middleware
        next(err as Parameters<NextFunction>[0]);
      });
    };
    this.runGuards(entry.guards, 0, req, res, next, invoke);
  }

  /**
   * @description Run a route's guard chain in order, then invoke the handler.
   *
   * A guard that responds (401/403) simply never calls next, which ends the request — the handler
   * is not reached and, critically, the dispatcher does NOT fall through to a laxer sibling route.
   * Falling through after a rejection would be an auth bypass. (The loader forbids mixed modes on
   * one mountPath, so siblings share a posture and this case should not arise; it fails safe if it
   * ever does.)
   *
   * @param guards - The chain.
   * @param i - Current index.
   * @param req - Request.
   * @param res - Response.
   * @param next - Express next, for errors.
   * @param invoke - Called once every guard has passed.
   */
  private runGuards(
    guards: RequestHandler[],
    i: number,
    req: Request,
    res: Response,
    next: NextFunction,
    invoke: () => void,
  ): void {
    if (i >= guards.length) {
      invoke();
      return;
    }
    guards[i](req, res, (err?: unknown) => {
      if (err) {
        next(err as Parameters<NextFunction>[0]);
        return;
      }
      this.runGuards(guards, i + 1, req, res, next, invoke);
    });
  }
}
