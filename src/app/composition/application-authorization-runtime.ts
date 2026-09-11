/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Connect dynamic package activation to the shared application policy service and request boundaries.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Bind remote authorization to one fully activated executable policy generation.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Revalidate artifact source permissions by registered HTTP mount, retaining inactive ownership.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Validate declared package tools before activation and fence retired handler domain checks.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Identify fully read-only named bindings for automatic Jarvis proposals.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Preserve business-only browser navigation while retaining explicit data workspace authorization.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { ApplicationAuthorizationService } from '@/features/application-authorization';
import type { ManifestAuthorizationRegistrar, SwarmAppManifest, SwarmApplicationRecord } from '@/features/swarm-apps';
import { loadApplicationAuthorization, type AuthorizationActor, type AuthorizationAppRegistration,
  type AuthorizationDecision, type AuthorizationOperation, type AuthorizationResourceAdapter } from '@/shared/application-authorization';
import { getApplicationAuthorizationActor, runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { createChildLogger } from '@/shared/logger';
import type { RemoteApplicationSnapshot } from '@/shared/application-remote-execution';
import { assertPackageToolInvocation, validatePackageTools, type PackageToolDeclaration } from '@/shared/package-tools';
import { authorizeApplicationNavigation, navigationWorkspace } from './application-navigation-authorization';

const logger = createChildLogger({ module: 'application-authorization-runtime' });
interface RuntimeRegistration { registration: AuthorizationAppRegistration; generation: string; available: boolean; agents: string[]; tools: string[]; packageTools: PackageToolDeclaration[] }
export interface PackageAuthorizationContext {
  registerResource(resource: string, adapter: AuthorizationResourceAdapter): void;
  currentActor(): AuthorizationActor | undefined;
  authorize(operation: Omit<AuthorizationOperation, 'app'>): Promise<AuthorizationDecision>;
}
export interface ApplicationRouteAuthorization {
  guard(appName: string, req: Request, res: Response, next: () => void): Promise<void>;
  forPackage(appName: string): PackageAuthorizationContext;
  protectedApp(appName: string): boolean;
  packageToolDeclarations?(appName: string): PackageToolDeclaration[];
}

/** A reviewed legacy rollout is explicit; absent and unknown settings require app-admin. */
export function applicationAuthorizationMode(env: NodeJS.ProcessEnv = process.env): 'legacy' | 'enforce' {
  return (env.OSHAL_APPLICATION_AUTHORIZATION_MODE ?? 'enforce').trim().toLowerCase() === 'legacy' ? 'legacy' : 'enforce';
}

/** Use installer-owned source provenance, never a package-authored source claim to inherit grants. */
function installationSource(manifestPath: string): string {
  const packageDir = path.dirname(path.resolve(manifestPath));
  const stamp = path.join(packageDir, '.oshal-install.json');
  if (!fs.existsSync(stamp)) return `local:${createHash('sha256').update(packageDir).digest('hex')}`;
  if (fs.statSync(stamp).size > 64 * 1024) throw new Error('Authorization install provenance is oversized');
  const parsed: unknown = JSON.parse(fs.readFileSync(stamp, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid authorization install provenance');
  const value = parsed as { repo?: unknown; registry?: unknown };
  if (typeof value.repo !== 'string' || !value.repo) throw new Error('Missing authorization install provenance');
  return createHash('sha256').update(JSON.stringify({ repo: value.repo, registry: typeof value.registry === 'string' ? value.registry : null })).digest('hex');
}

/** One runtime wrapper owns availability, package adapters and transport ownership across reloads. */
export class ApplicationAuthorizationRuntime implements ManifestAuthorizationRegistrar, ApplicationRouteAuthorization {
  private readonly registrations = new Map<string, RuntimeRegistration>();
  constructor(readonly service: ApplicationAuthorizationService,
    readonly resolveActor: (req: Request) => Promise<AuthorizationActor>, private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly findApp?: (name: string) => Promise<SwarmApplicationRecord | null>) {}

  private candidate(manifest: SwarmAppManifest, manifestPath: string): AuthorizationAppRegistration {
    validatePackageTools(manifest);
    const catalog = loadApplicationAuthorization(path.dirname(path.resolve(manifestPath)), manifest);
    const isPackage = path.basename(manifestPath) === 'oshal-app.yaml';
    return { app: manifest.name, source: installationSource(manifestPath), version: manifest.version ?? '0.0.0', catalog,
      agentIds: (manifest.bots ?? []).flatMap(bot => bot.agentId ? [bot.agentId] : []),
      toolNames: (manifest.tools ?? []).map(tool => tool.name),
      mode: isPackage ? applicationAuthorizationMode(this.env) : 'legacy', access: manifest.access,
      mountPaths: (manifest.routes ?? []).map(route => route.mountPath) };
  }
  /** Reject catalog/source migrations before the previous live package or database record is changed. */
  async prepare(manifest: SwarmAppManifest, manifestPath: string): Promise<void> {
    await this.service.validateRegistration(this.candidate(manifest, manifestPath));
  }
  /** Keep a candidate unavailable until every activation step has completed. */
  async start(record: SwarmApplicationRecord): Promise<void> {
    const registration = this.candidate(record.manifest, record.manifestPath);
    this.registrations.set(record.name, { registration, generation: randomUUID(), available: false,
      agents: (record.manifest.bots ?? []).flatMap(bot => bot.agentId ? [bot.agentId] : []),
      tools: (record.manifest.tools ?? []).map(tool => tool.name), packageTools: validatePackageTools(record.manifest) });
    this.service.unregisterApp(record.name);
    await this.service.registerApp(registration);
  }
  complete(record: SwarmApplicationRecord): void { const state = this.registrations.get(record.name); if (state) state.available = true; }
  unregister(appName: string): void {
    const state = this.registrations.get(appName);
    if (state) state.available = false;
    this.service.unregisterApp(appName);
  }
  protectedApp(appName: string): boolean {
    const state = this.registrations.get(appName);
    return Boolean(state && (state.registration.catalog || state.registration.mode === 'enforce'));
  }
  /** @description Return validated declarations for one activation-scoped tool registry.
   * @param appName Installed package owner. @returns Detached declarations, including disabled tools.
   */
  packageToolDeclarations(appName: string): PackageToolDeclaration[] {
    return (this.registrations.get(appName)?.packageTools ?? []).map(item => ({ ...item }));
  }
  /** @description Constrain automatic Jarvis proposals to tools whose complete named binding is read-only.
   * @param appName Installed owner. @param name Exact tool binding. @returns True only when every required permission has read effect.
   */
  packageToolReadOnly(appName: string, name: string): boolean {
    const catalog = this.registrations.get(appName)?.registration.catalog;
    const binding = catalog?.bindings.tools?.find(item => item.id === name);
    return Boolean(binding?.allOf.length && binding.allOf.every(permission => catalog?.permissions[permission]?.effect === 'read'));
  }
  /** @description Bind remote work to one fully activated executable policy generation.
   * @param appName Controller-resolved application. @returns Live generation or unavailable null.
   */
  snapshot(appName: string): RemoteApplicationSnapshot | null {
    const state = this.registrations.get(appName); const app = this.service.getApp(appName);
    return state?.available && app ? { app: appName, source: app.source, catalogRevision: app.catalogRevision, generation: state.generation } : null;
  }
  /** Bind package code to its own namespace; it receives no policy-management service. */
  forPackage(appName: string): PackageAuthorizationContext {
    return {
      registerResource: (resource, adapter) => {
        const state = this.registrations.get(appName);
        if (!state || state.available) throw new Error('Resource adapters may register only during package activation');
        this.service.registerResourceAdapter(appName, resource, adapter);
      },
      currentActor: getApplicationAuthorizationActor,
      authorize: async operation => {
        assertPackageToolInvocation(appName);
        const actor = getApplicationAuthorizationActor();
        if (!actor) throw new Error('Verified application actor unavailable');
        const decision = await this.authorize(actor, { ...operation, app: appName });
        assertPackageToolInvocation(appName);
        return decision;
      },
    };
  }
  /** Authoritative availability check shared with non-HTTP callers. */
  async authorize(actor: AuthorizationActor, operation: AuthorizationOperation): Promise<AuthorizationDecision> {
    if (!this.registrations.get(operation.app)?.available) return { allowed: false, reason: 'authorization_app_unavailable',
      app: operation.app, decisionId: '', revision: 0, grants: [] };
    return this.service.authorize(actor, operation);
  }
  /** Resolve the owning app without inferring permissions from bot names or keywords. */
  owner(kind: 'bots' | 'tools', id: string): string | undefined {
    return [...this.registrations].find(([, row]) => (kind === 'bots' ? row.agents : row.tools).includes(id))?.[0];
  }
  /** @description Resolve the longest known package mount and recheck its named HTTP permission.
   * @param actor Verified caller. @param input Local request path and method. @returns Protected decision, or null for an unowned/legacy path.
   */
  async authorizeHttpPath(actor: AuthorizationActor, input: { method: string; path: string }): Promise<AuthorizationDecision | null> {
    const owner = [...this.registrations.entries()].flatMap(([app, state]) =>
      (state.registration.mountPaths ?? []).map(mount => ({ app, state, mount })))
      .filter(row => input.path === row.mount || input.path.startsWith(`${row.mount}/`))
      .sort((left, right) => right.mount.length - left.mount.length)[0];
    if (!owner || !(owner.state.registration.catalog || owner.state.registration.mode === 'enforce')) return null;
    // unregister retains the registration: a retired protected mount remains a denied owner.
    return this.authorize(actor, { app: owner.app, kind: 'http', method: input.method,
      path: input.path.slice(owner.mount.length) || '/' });
  }
  /** A coarse discovery check can hide inaccessible apps, but can never authorize an operation. */
  async canDiscover(appName: string, actor = getApplicationAuthorizationActor()): Promise<boolean> {
    if (!this.registrations.get(appName)?.available) return false;
    if (!this.protectedApp(appName)) return true;
    if (!actor || !this.registrations.get(appName)?.available) return false;
    try {
      for (const tenantId of [undefined, ...(actor.tenantIds ?? [])]) {
        const access = await this.service.effective(actor, { app: appName, tenantId });
        if (!access.denied && access.tier !== 'deny') return true;
      }
      return false;
    }
    catch { return false; }
  }
  /** Apply named permissions before package code, retaining a restricted business database identity. */
  async guard(appName: string, req: Request, res: Response, next: () => void): Promise<void> {
    try {
      const state = this.registrations.get(appName);
      if (!state) {
        const record = await this.findApp?.(appName);
        if (record?.manifest.authorization || (record && path.basename(record.manifestPath) === 'oshal-app.yaml' && applicationAuthorizationMode(this.env) === 'enforce')) {
          res.status(503).json({ error: 'authorization_app_unavailable' }); return;
        }
        next(); return;
      }
      if (!this.protectedApp(appName)) { next(); return; }
      if (!state.available) { res.status(503).json({ error: 'authorization_app_unavailable' }); return; }
      const actor = await this.resolveActor(req);
      const requestPath = (req.originalUrl || req.url).split('?')[0];
      const mounts = [...(state.registration.mountPaths ?? [])].sort((a, b) => b.length - a.length);
      const mount = mounts.find(prefix => requestPath === prefix || requestPath.startsWith(`${prefix}/`));
      const relative = mount ? requestPath.slice(mount.length) || '/' : requestPath;
      const selection = navigationWorkspace(req);
      if (!selection.valid) { res.status(400).json({ error: 'authorization_workspace_invalid' }); return; }
      await runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
        principalIssuer: actor.issuer, isOperator: false }, async () => {
        const decision = await authorizeApplicationNavigation(state.registration, actor,
          { app: appName, kind: 'http', method: req.method, path: relative,
            ...(selection.tenantId ? { tenantId: selection.tenantId } : {}) }, selection.explicit,
          operation => {
            if (this.registrations.get(appName) !== state || !state.available) throw new Error('Application generation changed');
            return this.authorize(actor, operation);
          });
        if (this.registrations.get(appName) !== state || !state.available) throw new Error('Application generation changed');
        if (!decision.allowed) { res.status(403).json({ error: decision.reason, decisionId: decision.decisionId }); return; }
        res.locals.applicationAuthorization = decision;
        next();
      }));
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error && error.status === 401 ? 401 : 503;
      logger.warn({ err: error, appName }, 'Application authorization refused');
      res.status(status).json({ error: status === 401 ? 'authorization_identity_required' : 'authorization_unavailable' });
    }
  }
}
