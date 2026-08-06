/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial swarm-app routes per ADR 2026-04-20 + export/import extension
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Harden POST /load: confine the operator-supplied manifest path to the swarm-apps/ directory (reject absolute paths + ../ traversal + non-YAML) so it can't read arbitrary files
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Bot Forge bulletproofing: GET /pending lists on-disk manifests not yet loaded; resolveSafeManifestPath now also permits the writable deployed-apps/ dir (where the Forge writes packed bots) so the authenticated operator can one-click Inject them live — replaces the agent's broken unauthenticated curl to /load.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | (1) createPackagedThemeCssFallback — serve an active package's bundled ui/<id>.css at the legacy /cockpit/css/themes/<id>.css path (carve-out deleted core's copy; LM iframes lost every color variable). (2) POST /load stamps the caller as ownerSub — installing a person-scoped package left owner_sub NULL, so RLS hid the app row from every non-operator session and the profile fell back to a stale disk config.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 §5 data plane: uninstall-impact reports the live RAG collections the manifest's ragCollections globs match; DELETE /:name accepts ?dropData=true (OPERATOR-ONLY — destructive) which deletes them via the injected teardown port and returns droppedRagCollections.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D11: uninstall-impact reports toolsProvided + toolDependents (active apps whose dependencies.tools name a tool this app provides) and blocked reflects them; the DELETE 409 body names the stranded tools.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D7: wire the app-store remote rail (GET /catalog + operator-only POST /install-remote from app-store-remote.ts) BEFORE the /:name params so the literal segments aren't captured as app names.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: add framework-owned operator APIs for the user-by-app access matrix, assignment updates, and explicit-assignment clearing.
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { createChildLogger } from '@/shared/logger';
import {
  SwarmAppService,
  APP_ACCESS_TIERS,
  isAppAccessTier,
  type AppAccessService,
  listManifestFiles,
  readManifest,
  serializeManifest,
  compileWorkflowSpec,
  type SwarmAppScope,
  type SwarmAppManifest,
} from '@/features/swarm-apps';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import { GUEST_TIERS, isGuestTier } from '@/shared/middleware/guest-capability-matrix';
import { registerAppStoreRemoteRoutes } from './app-store-remote';

const logger = createChildLogger({ module: 'swarm-app-routes' });

const SWARM_APPS_DIR = path.resolve(process.cwd(), process.env.SWARM_APPS_DIR || 'swarm-apps');
// Packed bots authored by the Forge (codex-packer) land in the writable deployed-apps/
// dir under the workspace root; both dirs are valid manifest sources (mirrors
// listManifestFiles in swarm-app-loader). Anything outside them is rejected.
const DEPLOYED_APPS_DIR = path.resolve(
  process.env.CLINE_WORKSPACE_ROOT || '/app/workspace-shared',
  'deployed-apps',
);
const ALLOWED_MANIFEST_DIRS = [SWARM_APPS_DIR, DEPLOYED_APPS_DIR];

/**
 * @description Resolve an operator-supplied manifest path and confine it to one of
 * the permitted manifest directories (swarm-apps/ or the writable deployed-apps/).
 * Returns the absolute path when safe, or null when it escapes every permitted dir
 * via `..` or is not a YAML file — preventing the load endpoint from reading
 * arbitrary files off disk. Absolute paths are allowed only when they already sit
 * inside a permitted dir.
 * @param input - cwd-relative or absolute path from the request body / pending list
 * @returns the validated absolute path, or null if it must be rejected
 */
function resolveSafeManifestPath(input: string): string | null {
  const candidate = path.resolve(process.cwd(), input);
  if (!/\.(ya?ml)$/i.test(candidate)) return null;
  for (const base of ALLOWED_MANIFEST_DIRS) {
    const rel = path.relative(base, candidate);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return candidate;
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 }, // 1MB — manifests are small
});

/**
 * @description Swarm application management routes.
 *
 *   GET    /api/swarm/apps                      list installed apps
 *   GET    /api/swarm/apps/access-matrix        operator user-by-app access matrix
 *   PUT    /api/swarm/apps/:name/access         operator assignment upsert/clear
 *   GET    /api/swarm/apps/:name                get one app (manifest included)
 *   POST   /api/swarm/apps/load                 load a manifest by path {path}
 *   PATCH  /api/swarm/apps/:name/toggle         body {active:bool}
 *   DELETE /api/swarm/apps/:name                unload entirely
 *   GET    /api/swarm/apps/:name/export         download manifest YAML
 *   POST   /api/swarm/apps/import               upload a manifest YAML file
 *
 * @param service - SwarmAppService instance
 * @returns Express Router
 */
export function createSwarmAppRoutes(service: SwarmAppService, appAccess?: AppAccessService): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const filter = status === 'active' || status === 'inactive' ? status : undefined;
      // Scope the listing to the caller: public apps + their own person-scoped apps.
      // Operators see everything. Built-in/framework apps default to 'public', so this
      // is a no-op for existing apps until person-scoped publishing stamps an owner.
      const { sub } = getCaller(req);
      const apps = await service.listApps(filter, { ownerSub: sub, isOperator: isOperator(req) });
      res.json({ apps });
    } catch (err: any) {
      logger.error({ err }, 'Failed to list swarm apps');
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /pending — manifest files present on disk (swarm-apps/ + deployed-apps/)
   * that are NOT currently loaded/active. These are bots the Forge (codex-packer)
   * authored but that haven't been injected yet; the surface offers a one-click
   * Inject (authenticated as the operator) for each. Registered before /:name so
   * the literal segment isn't captured by the name param.
   */
  router.get('/pending', async (_req: Request, res: Response) => {
    try {
      const active = new Set((await service.listApps()).map((a) => a.name));
      const pending: Array<{ name: string; displayName: string; description: string; path: string }> = [];
      for (const file of listManifestFiles()) {
        try {
          const m = readManifest(file);
          if (m?.name && !active.has(m.name)) {
            pending.push({
              name: m.name,
              displayName: m.displayName || m.name,
              description: m.description || '',
              path: file, // absolute; re-validated by resolveSafeManifestPath on load
            });
          }
        } catch (e: any) {
          logger.warn({ file, err: e?.message }, 'Skipping unreadable pending manifest');
        }
      }
      res.json({ pending });
    } catch (err: any) {
      logger.error({ err }, 'Failed to list pending manifests');
      res.status(500).json({ error: err.message });
    }
  });

  // ADR-085 D7: the store catalog (GET /catalog) + one-call install (POST /install-remote,
  // operator-only). Registered before /:name so the literal segments aren't captured by the
  // name param — same ordering rule as /pending above.
  registerAppStoreRemoteRoutes(router, { loadApp: (p, meta) => service.loadApp(p, meta) });

  /** GET /access-matrix — framework-owned operator view; package code never administers tiers. */
  router.get('/access-matrix', async (req: Request, res: Response) => {
    if (!isOperator(req)) {
      res.status(403).json({ error: 'Operator privilege required' });
      return;
    }
    if (!appAccess) {
      res.status(503).json({ error: 'App access service unavailable' });
      return;
    }
    try {
      const { sub } = getCaller(req);
      const summaries = await service.listApps(undefined, { ownerSub: sub, isOperator: true });
      const records = await Promise.all(summaries.map((app) => service.getApp(app.name)));
      const assignments = await appAccess.listAssignments();
      res.json({
        tiers: APP_ACCESS_TIERS,
        apps: records.filter(Boolean).map((app) => ({
          name: app!.name,
          displayName: app!.displayName,
          status: app!.status,
          access: app!.manifest.access ?? null,
        })),
        assignments,
      });
    } catch (err: any) {
      logger.error({ err }, 'Failed to build app access matrix');
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /:name/access — upsert `{userSub,tier,reason}` or clear with `tier:null`.
   * Unknown/unsupported tiers fail before the database and an app without a declaration keeps
   * its legacy behavior (it cannot receive assignments that would only look enforced).
   */
  router.put('/:name/access', async (req: Request, res: Response) => {
    if (!isOperator(req)) {
      res.status(403).json({ error: 'Operator privilege required' });
      return;
    }
    if (!appAccess) {
      res.status(503).json({ error: 'App access service unavailable' });
      return;
    }
    const name = String(req.params.name);
    try {
      const actorSub = getCaller(req).sub;
      if (!actorSub) {
        res.status(403).json({ error: 'An exact operator subject is required' });
        return;
      }
      const app = await service.getApp(name);
      if (!app) {
        res.status(404).json({ error: 'App not found' });
        return;
      }
      const declaration = app.manifest.access;
      if (!declaration) {
        res.status(409).json({ error: 'App has no access declaration; current behavior remains authoritative' });
        return;
      }
      const userSub = req.body?.userSub;
      const reason = req.body?.reason;
      const tier = req.body?.tier;
      if (typeof userSub !== 'string' || userSub.length === 0 || typeof reason !== 'string') {
        res.status(400).json({ error: 'userSub and reason are required' });
        return;
      }
      if (tier === null) {
        const cleared = await appAccess.clear({ userSub, appName: name, assignedBySub: actorSub, reason });
        res.json({ cleared, appName: name, userSub, effectiveTier: declaration.defaultTier });
        return;
      }
      if (!isAppAccessTier(tier)) {
        res.status(400).json({ error: `tier must be one of: ${APP_ACCESS_TIERS.join(', ')}, or null to clear` });
        return;
      }
      if (!declaration.supported.includes(tier)) {
        res.status(400).json({ error: `App ${name} does not support tier ${tier}` });
        return;
      }
      const assignment = await appAccess.assign({
        userSub,
        appName: name,
        tier,
        assignedBySub: actorSub,
        reason,
      });
      res.json({ assignment });
    } catch (err: any) {
      logger.error({ err, name }, 'Failed to update app access assignment');
      res.status(err instanceof TypeError ? 400 : 500).json({ error: err.message });
    }
  });

  router.get('/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    try {
      const app = await service.getApp(name);
      if (!app) {
        res.status(404).json({ error: 'App not found' });
        return;
      }
      res.json({ app });
    } catch (err: any) {
      logger.error({ err, name }, 'Failed to fetch swarm app');
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/load', async (req: Request, res: Response) => {
    try {
      const manifestPath = typeof req.body?.path === 'string' ? req.body.path : null;
      if (!manifestPath) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      const safePath = resolveSafeManifestPath(manifestPath);
      if (!safePath) {
        logger.warn({ manifestPath }, 'Rejected unsafe manifest path');
        res.status(400).json({ error: 'path must be a .yaml/.yml file within the swarm-apps/ directory' });
        return;
      }
      // Stamp the installing session as owner. Without this a person-scoped package
      // lands with owner_sub NULL — RLS then hides the row from every non-operator
      // session (the little-monsters reinstall regression). Scope still comes from
      // the manifest; upsert COALESCEs preserve any prior stamp on reload.
      const { sub } = getCaller(req);
      const record = await service.loadApp(safePath, { ownerSub: sub ?? null });
      res.status(201).json({ app: record });
    } catch (err: any) {
      logger.error({ err }, 'Failed to load swarm app');
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * POST /publish — compile an authored workflow spec into a manifest, write it to
   * the writable deployed-apps/ dir, and load it LIVE (no reboot). This is how a
   * Workflow Studio canvas / builder-bot turns an authored workflow into a runnable
   * app == queue. Two emit targets: a single-shot bot (manifest-worker) or an
   * authored multi-bot workflow (staged).
   *
   * Scope: 'person' (default) is owned by the caller and visible only to them;
   * 'public'/'tenant' require operator privilege. Owner is taken from the session,
   * never the spec. A name already owned by someone else (or a built-in/public app)
   * is rejected with 409 so a publish can't stomp another user's workflow.
   *
   * Body: { spec: WorkflowPublishSpec, scope?: 'person'|'tenant'|'public' }
   */
  router.post('/publish', async (req: Request, res: Response) => {
    try {
      const spec = (req.body?.spec ?? req.body) as Record<string, unknown>;
      const requested = (typeof req.body?.scope === 'string' ? req.body.scope : (spec?.scope as string)) ?? 'person';
      const scope: SwarmAppScope =
        requested === 'public' || requested === 'tenant' || requested === 'person' ? requested : 'person';

      const { sub } = getCaller(req);
      const operator = isOperator(req);

      if (scope === 'person' && !sub) {
        res.status(401).json({ error: 'authentication required to publish a personal workflow' });
        return;
      }
      if ((scope === 'public' || scope === 'tenant') && !operator) {
        res.status(403).json({ error: 'operator privilege required to publish a public or tenant workflow' });
        return;
      }

      let manifest;
      try {
        manifest = compileWorkflowSpec(spec as any, scope);
      } catch (compileErr: any) {
        res.status(400).json({ error: compileErr.message });
        return;
      }

      // Ownership / collision guard — never overwrite a built-in, a public app, or
      // another user's workflow. The owner (or an operator) may re-publish to update.
      const existing = await service.getApp(manifest.name);
      if (existing) {
        const ownsIt = !!existing.ownerSub && !!sub && existing.ownerSub === sub;
        if (!ownsIt && !operator) {
          res.status(409).json({ error: `an app named "${manifest.name}" already exists and is not yours` });
          return;
        }
      }

      if (!fs.existsSync(DEPLOYED_APPS_DIR)) fs.mkdirSync(DEPLOYED_APPS_DIR, { recursive: true });
      const destPath = path.join(DEPLOYED_APPS_DIR, `${manifest.name}.yaml`);
      fs.writeFileSync(destPath, serializeManifest(manifest));
      logger.info({ name: manifest.name, scope, ownerSub: sub }, 'Workflow published — manifest written, loading live');

      const record = await service.loadApp(destPath, {
        scope,
        ownerSub: scope === 'person' ? sub : null,
        tenantId: null, // tenant scoping is wired with the broader multi-tenant work
      });
      res.status(201).json({ app: record, manifestPath: destPath });
    } catch (err: any) {
      logger.error({ err }, 'Failed to publish workflow');
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * POST /:name/clone — import-by-copy: instantiate a visible workflow (a public one,
   * your own, or any if operator) as a NEW personal queue owned by the caller. This is
   * the "import a public workflow into my scope" path of the scope model — the source
   * is never mutated; the caller gets an independent copy with its own ticketType so the
   * two queues don't collide. Only workflow apps can be cloned.
   *
   * Body: { name?: <slug>, displayName?: string }  (name defaults to "<source>-<sub>")
   */
  router.post('/:name/clone', async (req: Request, res: Response) => {
    const sourceName = String(req.params.name);
    try {
      const { sub } = getCaller(req);
      const operator = isOperator(req);
      if (!sub) {
        res.status(401).json({ error: 'authentication required to clone a workflow' });
        return;
      }

      const source = await service.getApp(sourceName);
      // 404 (not 403) when not visible, so names aren't oracle-able — mirrors authz.ts.
      const visible = source && (source.scope === 'public' || source.ownerSub === sub || operator);
      if (!source || !visible) {
        res.status(404).json({ error: 'App not found' });
        return;
      }
      if (!source.manifest.workflow || !source.manifest.ticketType) {
        res.status(400).json({ error: 'only workflow apps (with a ticketType) can be cloned' });
        return;
      }

      const rawNew = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const subSlug = (sub.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-6)) || 'me';
      const newName = rawNew || `${source.name}-${subSlug}`;
      if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(newName)) {
        res.status(400).json({ error: 'name must be a slug: lowercase letters, digits, dashes; 2-64 chars' });
        return;
      }

      const existing = await service.getApp(newName);
      if (existing) {
        const ownsIt = !!existing.ownerSub && existing.ownerSub === sub;
        if (!ownsIt && !operator) {
          res.status(409).json({ error: `an app named "${newName}" already exists and is not yours` });
          return;
        }
      }

      // Clone only the workflow essentials — drop ui/routes/tools so a cloned queue
      // can't double-register the source app's surfaces. New ticketType == newName.
      const src = source.manifest;
      const cloned: SwarmAppManifest = {
        name: newName,
        displayName: rawNew ? (typeof req.body?.displayName === 'string' && req.body.displayName.trim() ? req.body.displayName.trim() : newName) : `${src.displayName} (copy)`,
        description: src.description,
        scope: 'person',
        bots: src.bots,
        ticketType: newName,
        workflow: src.workflow,
      };

      if (!fs.existsSync(DEPLOYED_APPS_DIR)) fs.mkdirSync(DEPLOYED_APPS_DIR, { recursive: true });
      const destPath = path.join(DEPLOYED_APPS_DIR, `${newName}.yaml`);
      fs.writeFileSync(destPath, serializeManifest(cloned));
      logger.info({ source: source.name, newName, ownerSub: sub }, 'Workflow cloned into personal scope — loading live');

      const record = await service.loadApp(destPath, { scope: 'person', ownerSub: sub, tenantId: null });
      res.status(201).json({ app: record, manifestPath: destPath, clonedFrom: source.name });
    } catch (err: any) {
      logger.error({ err, sourceName }, 'Failed to clone workflow');
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * PATCH /:name/guest-tier — approve (or revoke) an app's guest tier. **OPERATOR-ONLY.**
   *
   * ADR-085 D4. A manifest's `guestTier` is a REQUEST; this is the only thing that grants it.
   * Guests are UNAUTHENTICATED, so if an app could set its own tier, installing a package would
   * silently widen what an anonymous visitor can reach — `full` includes WRITES. The app asks; the
   * person who owns the deployment decides.
   *
   * Body: `{ tier: 'full' | 'readonly' | 'blocked' | null }` (null revokes → read-only default).
   */
  router.patch('/:name/guest-tier', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    if (!isOperator(req)) {
      res.status(403).json({ error: 'Approving a guest tier is operator-only' });
      return;
    }
    const tier = req.body?.tier ?? null;
    if (tier !== null && !isGuestTier(tier)) {
      res.status(400).json({
        error: `Unknown guest tier "${tier}". Known tiers: ${GUEST_TIERS.join(', ')} (or null to revoke).`,
      });
      return;
    }
    try {
      const app = await service.approveGuestTier(name, tier);
      if (!app) {
        res.status(404).json({ error: 'App not found' });
        return;
      }
      logger.info({ name, tier, by: getCaller(req).sub }, 'Operator set app guest tier');
      res.json({ app, requested: app.manifest.guestTier ?? null, approved: app.guestTierApproved });
    } catch (err: any) {
      logger.error({ err, name, tier }, 'Failed to set guest tier');
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:name/toggle', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    try {
      const active = Boolean(req.body?.active);
      const result = await service.toggleApp(name, active);
      if (!result) {
        res.status(404).json({ error: 'App not found' });
        return;
      }
      res.json({ app: result });
    } catch (err: any) {
      logger.error({ err, name }, 'Failed to toggle swarm app');
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /:name/theme.css — serve an ACTIVE app package's bundled skin (ui/<theme>.css
   * beside its manifest). ADR-085: a store-installed app brings its own cockpit look
   * without core registering the skin. The theme id is slug-validated and the path is
   * confined to the package's ui/ dir — no traversal.
   */
  router.get('/:name/theme.css', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    try {
      const app = await service.getApp(name);
      if (!app || app.status !== 'active' || !app.manifest.theme || !/^[a-z0-9-]+$/i.test(app.manifest.theme)) {
        res.status(404).type('text/plain').send('no bundled theme');
        return;
      }
      const cssPath = path.resolve(path.dirname(app.manifestPath), 'ui', `${app.manifest.theme}.css`);
      if (!cssPath.startsWith(path.resolve(path.dirname(app.manifestPath), 'ui')) || !fs.existsSync(cssPath)) {
        res.status(404).type('text/plain').send('no bundled theme');
        return;
      }
      res.type('text/css').sendFile(cssPath);
    } catch (err: any) {
      logger.error({ err, name }, 'Failed to serve package theme css');
      res.status(500).type('text/plain').send('theme error');
    }
  });

  /**
   * GET /:name/uninstall-impact — the ADR-085 §5 pre-flight: which ACTIVE apps depend on
   * this one (removal is blocked while any exist) and which of its own dependencies would
   * become orphans (offered for separate removal — nothing cascades). Surfaces render this
   * as the impact list + component picker before the user confirms an uninstall.
   */
  router.get('/:name/uninstall-impact', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    try {
      const impact = await service.uninstallImpact(name);
      if (!impact.exists) {
        res.status(404).json({ error: 'App not found' });
        return;
      }
      res.json({
        name,
        dependents: impact.dependents,
        orphanCandidates: impact.orphanCandidates,
        // ADR-085 §5 + ADR-091: live RAG collections the app's manifest claims —
        // what an operator's ?dropData=true uninstall would delete.
        ragCollections: impact.ragCollections,
        // ADR-085 D11: the tools this app provides, and the active apps that would be stranded
        // without them. Tool dependents block the uninstall exactly like app-level dependents.
        toolsProvided: impact.toolsProvided,
        toolDependents: impact.toolDependents,
        blocked: impact.dependents.length > 0 || impact.toolDependents.length > 0,
      });
    } catch (err: any) {
      logger.error({ err, name }, 'Failed to compute uninstall impact');
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /:name — dependency-aware (ADR-085 §5): 409 with the dependents list while
   * other active apps depend on this one; `?force=true` overrides (the caller has seen
   * the impact and decided). Orphaned dependencies are reported, never auto-removed.
   */
  router.delete('/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    try {
      const force = String(req.query.force || '').toLowerCase() === 'true';
      // Data-loss gate: dropData additionally deletes the RAG collections the
      // manifest's ragCollections globs match. Destructive → operator-only; the
      // plain (data-preserving) uninstall keeps its existing auth posture.
      const dropData = String(req.query.dropData || '').toLowerCase() === 'true';
      if (dropData && !isOperator(req)) {
        res.status(403).json({ error: 'dropData is operator-only (deletes the app\'s RAG data)' });
        return;
      }
      const result = await service.unloadApp(name, { force, dropData });
      if (result.blocked) {
        // ADR-085 D11: name the TOOLS too — "app X depends on this" is actionable; "something
        // broke after you uninstalled" is not.
        const toolDetail = (result.toolDependents ?? [])
          .map((d) => `${d.app} needs tool(s) ${d.tools.join(', ')}`)
          .join('; ');
        res.status(409).json({
          error:
            `blocked: active app(s) depend on "${name}" — remove them first or pass ?force=true` +
            (toolDetail ? ` (${toolDetail})` : ''),
          dependents: result.dependents,
          orphanCandidates: result.orphanCandidates,
          toolDependents: result.toolDependents,
        });
        return;
      }
      if (!result.removed) {
        res.status(404).json({ error: 'App not found' });
        return;
      }
      res.json({
        unloaded: true,
        name,
        orphanCandidates: result.orphanCandidates ?? [],
        droppedRagCollections: result.droppedRagCollections ?? [],
      });
    } catch (err: any) {
      logger.error({ err, name }, 'Failed to unload swarm app');
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:name/export', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    try {
      const yaml = await service.exportManifest(name);
      if (!yaml) {
        res.status(404).json({ error: 'App not found' });
        return;
      }
      res.setHeader('Content-Type', 'application/x-yaml');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.yaml"`);
      res.send(yaml);
    } catch (err: any) {
      logger.error({ err, name }, 'Failed to export swarm app');
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/import', upload.single('manifest'), async (req: Request, res: Response) => {
    try {
      const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined;
      if (!file) {
        res.status(400).json({ error: 'manifest file is required (field name: manifest)' });
        return;
      }
      // Persist the uploaded YAML into swarm-apps/ so future boots auto-load it
      const destDir = path.resolve(process.cwd(), 'swarm-apps');
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const destPath = path.join(destDir, safeName);
      fs.writeFileSync(destPath, file.buffer);
      logger.info({ destPath, size: file.buffer.length }, 'Imported swarm app manifest written to disk');
      // Same ownership stamp as POST /load: a person-scoped manifest imported without
      // an owner is RLS-invisible to its own users.
      const record = await service.loadApp(destPath, { ownerSub: getCaller(req).sub ?? null });
      res.status(201).json({ app: record, manifestPath: destPath });
    } catch (err: any) {
      logger.error({ err }, 'Failed to import swarm app');
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

/**
 * @description Fallback handler for `GET /cockpit/css/themes/:file` (registered AFTER the
 * cockpit express.static mount, so core-registered skins always win). Packaged app surfaces
 * are authored against the legacy contract "my skin lives at /cockpit/css/themes/<id>.css";
 * when the skin ships inside the package (ADR-085) that core file no longer exists and every
 * iframe loses its color variables — little-monsters' record button rendered transparent.
 * On a static miss this resolves the ACTIVE app bundling skin `<id>` and serves its
 * `ui/<id>.css`, slug-validated and confined to the package's ui/ dir (no traversal).
 * Anything unresolvable falls through to the stack's normal 404.
 * @param service - the swarm app service used to find the app bundling the requested skin
 * @returns an Express handler serving the packaged skin CSS or calling next()
 */
export function createPackagedThemeCssFallback(service: SwarmAppService): RequestHandler {
  return async (req, res, next) => {
    const match = /^([a-z0-9-]+)\.css$/i.exec(String(req.params.file || ''));
    if (!match) {
      next();
      return;
    }
    const themeId = match[1];
    try {
      const app = await service.findActiveAppByTheme(themeId);
      if (!app) {
        next();
        return;
      }
      const uiDir = path.resolve(path.dirname(app.manifestPath), 'ui');
      const cssPath = path.resolve(uiDir, `${themeId}.css`);
      if (!cssPath.startsWith(uiDir + path.sep) || !fs.existsSync(cssPath)) {
        next();
        return;
      }
      res.type('text/css').sendFile(cssPath);
    } catch (err) {
      logger.error({ err, themeId }, 'Packaged theme css fallback failed — falling through');
      next();
    }
  };
}
