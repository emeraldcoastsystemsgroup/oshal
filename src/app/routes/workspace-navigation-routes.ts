/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Discover current authorized application workspaces without changing profiles, roles or business data.
 */
import { Router, type Request } from 'express';
import type { SwarmAppService, AppAccessService, SwarmApplicationRecord } from '@/features/swarm-apps';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { navigationWorkspace } from '@/app/composition/application-navigation-authorization';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'workspace-navigation-routes' });
type Profile = NonNullable<Awaited<ReturnType<SwarmAppService['synthesiseProfile']>>>;
interface WorkspaceNavigationOptions {
  apps: Pick<SwarmAppService, 'listApps' | 'getAppForViewer' | 'synthesiseProfile'>;
  runtime: Pick<ApplicationAuthorizationRuntime, 'canDiscover' | 'canNavigateHttpPath' | 'snapshot'>;
  resolveActor(req: Request): Promise<AuthorizationActor>;
  access: Pick<AppAccessService, 'resolve'>;
}

/** @description Resolve only the installed profile's actual initial surface; never accept a package URL as a top-level destination.
 * @param profile Current synthesized profile. @returns Local pathname and validated workspace selector, or null for an unsupported surface.
 */
function initialSurface(profile: Profile): { pathname: string; selection: { explicit: boolean; tenantId?: string } } | null {
  const item = profile.ribbon.items.find(item => typeof item !== 'string' && item.id === profile.defaultView);
  if (!item || typeof item === 'string' || !item.toolUi) return null;
  const source = item.toolUi.iframeUrl;
  if (!source.startsWith('/') || source.startsWith('//') || source.includes('\\')) return null;
  const url = new URL(source, 'https://workspace.invalid');
  const selection = navigationWorkspace({ method: 'GET', url: source, get: () => undefined });
  return url.origin === 'https://workspace.invalid' && selection.valid ? { pathname: url.pathname, selection } : null;
}

/** @description Admit one active visible workspace and its initial page through current application policy.
 * @param record Caller-visible installation. @param actor Verified caller. @param options Installed registry and policy ports.
 * @returns Navigation metadata, or null for unavailable or inaccessible profiles.
 */
async function workspace(record: SwarmApplicationRecord, actor: AuthorizationActor, options: WorkspaceNavigationOptions) {
  const manifest = record.manifest;
  if (record.status !== 'active' || (!manifest.theme && manifest.kind !== 'group')) return null;
  const generation = options.runtime.snapshot(record.name);
  if (!generation || !await options.runtime.canDiscover(record.name, actor)) return null;
  if (manifest.access && (await options.access.resolve(record.name, actor.sub, manifest.access)).tier === 'deny') return null;
  const profile = await options.apps.synthesiseProfile(record.name);
  if (!profile || profile.name !== record.name) return null;
  const surface = initialSurface(profile);
  if (!surface) return null;
  const admitted = await options.runtime.canNavigateHttpPath(actor, surface.pathname, surface.selection);
  // Only a group's own kernel setup screen has no package HTTP owner.
  const setup = manifest.kind === 'group' && surface.pathname === `/api/swarm/apps/${encodeURIComponent(record.name)}/setup-dashboard`;
  if (admitted !== true && !(admitted === null && setup)) return null;
  if (options.runtime.snapshot(record.name)?.generation !== generation.generation) return null;
  return { name: record.name, displayName: record.displayName || record.name,
    href: `/cockpit/?app=${encodeURIComponent(record.name)}`, kind: manifest.kind === 'group' ? 'group' : 'app',
    ...(manifest.theme ? { theme: manifest.theme } : {}) };
}

/** @description Serve a caller-scoped, uncached list of existing focused applications for optional shell navigation.
 * @param options Registry and current authorization dependencies. @returns Router mounted behind requiresAuth at /api/ui.
 */
export function createWorkspaceNavigationRoutes(options: WorkspaceNavigationOptions): Router {
  const router = Router();
  router.get('/workspaces', async (req, res) => {
    const started = Date.now();
    res.set('Cache-Control', 'private, no-store');
    logger.debug('Workspace discovery started');
    try {
      const actor = await options.resolveActor(req);
      if (!actor.isActive || !actor.sub || !actor.issuer) { res.status(401).json({ error: 'authorization_identity_required' }); return; }
      const viewer = { ownerSub: actor.sub, isOperator: actor.isSwarmAdmin };
      const summaries = await options.apps.listApps('active', viewer);
      const workspaces = [];
      for (const summary of summaries) {
        const record = await options.apps.getAppForViewer(summary.name, viewer);
        if (!record) continue;
        const item = await workspace(record, actor, options);
        if (item) workspaces.push(item);
      }
      logger.info({ count: workspaces.length, durationMs: Date.now() - started }, 'Workspace discovery completed');
      res.json({ workspaces });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - started }, 'Workspace discovery unavailable');
      const unauthorized = error && typeof error === 'object' && 'status' in error && error.status === 401;
      res.status(unauthorized ? 401 : 503).json({ error: unauthorized ? 'authorization_identity_required' : 'workspace_navigation_unavailable' });
    }
  });
  return router;
}
