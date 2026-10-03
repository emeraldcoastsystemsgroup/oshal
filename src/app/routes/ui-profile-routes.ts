/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Initial UI profile routes — /api/ui/profile, /api/ui/profiles
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Resolve swarm-app manifests first, then fall back to on-disk profile JSONs
 * 3 | maintainer@emeraldcoastsystemsgroup.com | WARN when an explicitly requested ?name= profile falls back to disk — the silent fallback served a stale pre-carve-out little-monsters.json (4 ribbon items, no Record, no theme) whenever RLS hid the app row, masquerading as the app for days.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | ADR-149 rail discoverability: the route has the request, so it resolves the verified actor and binds synthesiseProfile's discovery port to it (runtime.canDiscover + the role-guidance link the 403 page offers). A tile that opens ANOTHER package this person cannot discover now comes back locked instead of a dead frame. An actor that cannot be resolved is logged and the manifest-static rail is served as before — discovery hides, it never authorises; the mount guard stays the authority.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Per-caller visibility for the static rail: synthesised ribbon items that name a registered tool pass through the app's manifest-declared visibility rule with the caller's session, so a surface the app does not admit for this person (a teacher-only tab for a learner) is not offered anywhere the profile is rendered.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Shell lock (ADR-164 amendment, 2026-10-02): the profile response carries `landingApp` (the deployment's focused landing, or null) and `operator` (the server's verdict for this caller) so the ribbon withholds the operator doors with the same inputs the cockpit document route redirects on.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Discover and host installed experience packages through current authorization, preserving member visibility and supported assets.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Enforce the named app.open operation before serving a directly focused experience profile.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Preserve focused shell context on profile refusals and extract bounded profile handlers.
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { UIProfileService } from '@/features/ui-profile';
import type { RibbonTileDiscovery, SwarmAppService } from '@/features/swarm-apps';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { roleGuidance } from '@/app/composition/application-navigation-authorization';
import { filterToolsForCaller } from './tool-routes';
import { createExperiencePackageRoutes } from './experience-package-routes';

const logger = createChildLogger({ module: 'ui-profile-routes' });

/** The per-person ports the profile route needs to follow another package's discoverability (ADR-149). */
export interface UiProfileDiscoveryPorts {
  runtime: Pick<ApplicationAuthorizationRuntime, 'canDiscover'> & Partial<Pick<ApplicationAuthorizationRuntime, 'canNavigateHttpPath'>>;
  resolveActor(req: Request): Promise<AuthorizationActor>;
}

/** The shell-lock ports (ADR-164 amendment): the deployment's landing application for this request and the caller's operator status. */
export interface UiProfileShellPorts {
  landingApp(req: Request): string | null;
  isOperator(req: Request): boolean;
}

/**
 * @description Binds the discovery port synthesiseProfile takes to this request's verified actor.
 * A resolution failure is logged and yields no port: the rail then renders exactly as declared,
 * which is what every frame's own mount guard already answers for — never a wider result.
 * @param req - The profile request.
 * @param ports - Runtime discovery check and actor resolver.
 * @returns The bound port, or undefined when the actor could not be resolved.
 */
async function bindTileDiscovery(req: Request, ports: UiProfileDiscoveryPorts): Promise<RibbonTileDiscovery | undefined> {
  try {
    const actor = await ports.resolveActor(req);
    return { canDiscover: (app) => ports.runtime.canDiscover(app, actor), roleGuidanceUrl: roleGuidance(actor).href };
  } catch (err) {
    logger.error({ err }, 'Could not resolve the caller for rail discoverability — serving the manifest-static rail');
    return undefined;
  }
}

/**
 * @description Per-caller visibility for the static rail (ADR-085 generic hook). Items whose id names a
 * registered tool (`tool-<toolName>`) pass through the same manifest-declared visibility rules as the
 * dynamic tools, forwarding the caller's session; framework items and items without a tool id are untouched.
 * @param items The synthesised ribbon items.
 * @param req The caller's request (cookie and Authorization header are forwarded on the loopback).
 * @returns The items this caller may see, in their original order.
 */
async function filterRibbonItemsForCaller<T>(items: T[], req: Request): Promise<T[]> {
  const candidates = items.map((item, index) => {
    const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
    const borrowedName = item && typeof item === 'object' ? (item as { toolUi?: { visibilityToolName?: string } }).toolUi?.visibilityToolName : undefined;
    return { item, index, toolName: borrowedName || (typeof id === 'string' && id.startsWith('tool-') ? id.slice('tool-'.length) : '') };
  });
  const tools = candidates.filter(c => c.toolName);
  if (tools.length === 0) return items;
  const visible = new Set((await filterToolsForCaller(tools, { cookie: req.headers.cookie, authorization: req.headers.authorization })).map(c => c.index));
  return candidates.filter(c => !c.toolName || visible.has(c.index)).map(c => c.item);
}

/**
 * @description Resolves one UI profile request. The cockpit calls this at boot
 * to decide which ribbon items to render. A profile does NOT disable backend
 * routes or bots — the framework keeps running; the profile only masks/orders
 * the surfaces the operator sees.
 *
 * Resolution order for a named profile:
 *   1. If a swarm-app manifest is loaded with name=X, synthesise its profile.
 *   2. Otherwise load X from config-seed/profiles/X.json.
 * This lets an operator "focus" a running application without maintaining a
 * separate profile file — the manifest is the single source of truth.
 *
 * Routes:
 *   GET  /api/ui/profile            → resolved active profile (server default
 *                                     unless `?name=<name>` is provided)
 *   GET  /api/ui/profiles           → list of available profile names
 *   POST /api/ui/profile/reload     → clear the in-memory cache (dev only)
 *
 * @param req Current profile request. @param res Profile or refusal response.
 * @param service - UIProfileService for file-based profile fallback
 * @param swarmApps - optional SwarmAppService for manifest-first resolution
 * @param discovery - optional ADR-149 ports; when present a synthesised rail follows each
 *   target package's discoverability for the signed-in person (locked tiles, kept in place)
 * @param shell Server-owned focused-landing and operator inputs.
 * @returns Completion of the profile response.
 */
async function serveProfile(req: Request, res: Response, service: UIProfileService, swarmApps?: SwarmAppService, discovery?: UiProfileDiscoveryPorts, shell?: UiProfileShellPorts): Promise<void> {
  const requested = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  const selected = requested || service.getEnvSelectedName();
  // Shell lock inputs (ADR-164 amendment): the deployment's landing application and the
  // server's operator verdict, so the ribbon decides the operator doors the same way the
  // cockpit document route decides its redirect.
  const lock = { landingApp: shell?.landingApp(req) ?? null, operator: shell ? shell.isOperator(req) : undefined };
  try {
    // Try manifest synthesis for BOTH request-level and env-selected names.
    // Without this, UI_PROFILE=<app-name> on the server falls through to the
    // disk profile JSON and loses the manifest's tool-* prefixed IDs and
    // focused ribbon.
    if (selected && swarmApps) {
      if (!(await experienceProfileAllowed(selected, req, res, swarmApps, discovery, lock))) return;
      const port = discovery ? await bindTileDiscovery(req, discovery) : undefined;
      const synthetic = await swarmApps.synthesiseProfile(selected, port);
      if (synthetic) {
        if (synthetic.experience && !discovery) { res.status(503).json({ error: 'experience_discovery_unavailable', ...lock }); return; }
        synthetic.ribbon.items = await filterRibbonItemsForCaller(synthetic.ribbon.items, req);
        logger.debug({ selected, source: requested ? 'query' : 'env' }, 'Serving synthesised profile from swarm-app manifest');
        res.json({ profile: synthetic, requested: selected, source: 'swarm-app', envDefault: service.getEnvSelectedName(), ...lock });
        return;
      }
    }
    const profile = service.load(selected);
    if (requested && swarmApps) {
      // An explicit ?name= that reaches the disk fallback usually means the swarm-app
      // row exists but is invisible to THIS caller (RLS scope/owner mismatch) or the
      // app is unloaded — a stale profile JSON can silently impersonate the app here.
      logger.warn({ selected, resolved: profile.name }, 'Requested app profile fell back to disk JSON — manifest synthesis returned nothing for this caller');
    } else {
      logger.debug({ selected, resolved: profile.name }, 'Serving UI profile from disk');
    }
    res.json({ profile, requested: selected, source: 'disk', envDefault: service.getEnvSelectedName(), ...lock });
  } catch (err) {
    logger.error({ err, selected }, 'Failed to load UI profile');
    res.status(500).json({ error: 'Failed to load UI profile', ...lock });
  }
}

/** @description Refuse unavailable experience profiles without losing the deployment's shell context.
 * @param selected Requested or deployment-selected application. @param req Current request.
 * @param res Response carrying refusal and server-owned lock inputs. @param apps Loaded applications.
 * @param discovery Current authorization ports. @param lock Deployment and caller lock inputs.
 * @returns Whether manifest synthesis may proceed. */
async function experienceProfileAllowed(selected: string, req: Request, res: Response, apps: SwarmAppService,
  discovery: UiProfileDiscoveryPorts | undefined, lock: { landingApp: string | null; operator: boolean | undefined }): Promise<boolean> {
  if (!discovery) return true;
  const installed = await apps.getApp(selected);
  if (!installed?.manifest.experience) return true;
  const actor = await discovery.resolveActor(req);
  const record = await apps.getAppForViewer(selected, { ownerSub: actor.sub, isOperator: actor.isSwarmAdmin });
  if (!record || !record.manifest.experience || record.status !== 'active' || !actor.isActive || !(await discovery.runtime.canDiscover(selected, actor))) {
    res.status(404).json({ error: 'experience_unavailable', ...lock }); return false;
  }
  if (!discovery.runtime.canNavigateHttpPath) { res.status(503).json({ error: 'experience_navigation_unavailable', ...lock }); return false; }
  if (!(await discovery.runtime.canNavigateHttpPath(actor, record.manifest.experience.entry))) {
    res.status(403).json({ error: 'experience_navigation_refused', ...lock }); return false;
  }
  return true;
}

/** @description Bind profile resolution, discovery and development-only cache controls.
 * @param service File-based profile service. @param swarmApps Manifest-first application resolution.
 * @param discovery Current caller's discovery and navigation authority. @param shell Server-owned lock inputs.
 * @returns The UI profile router. */
export function createUiProfileRoutes(service: UIProfileService, swarmApps?: SwarmAppService, discovery?: UiProfileDiscoveryPorts, shell?: UiProfileShellPorts): Router {
  const router = Router();
  router.use(createExperiencePackageRoutes({ apps: swarmApps, authorization: discovery }));
  router.get('/profile', (req, res) => serveProfile(req, res, service, swarmApps, discovery, shell));

  router.get('/profiles', (_req: Request, res: Response) => {
    try {
      const names = service.list();
      res.json({ profiles: names, envDefault: service.getEnvSelectedName() });
    } catch (err) {
      logger.error({ err }, 'Failed to list UI profiles');
      res.status(500).json({ error: 'Failed to list UI profiles' });
    }
  });

  router.post('/profile/reload', (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({ error: 'Profile cache reload is disabled in production' });
      return;
    }
    service.reload();
    logger.info('UI profile cache cleared via API');
    res.json({ ok: true });
  });

  return router;
}
