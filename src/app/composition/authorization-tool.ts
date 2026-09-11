/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Register caller-bound authorization operations backed by the administration service.
 */
import { CreateToolSchema } from '@/entities/tool';
import type { DynamicToolExecutorRegistry, ToolRegistryService } from '@/features/tool-registry';
import type { ApplicationAuthorizationManagementService, AuthorizationActor, AuthorizationCatalogResult } from '@/shared/application-authorization';
import { AuthMode, InstallMethod, ToolType } from '@/shared/types/tool';
import { createChildLogger } from '@/shared/logger';
import {
  AUTHORIZATION_TOOL, AUTHORIZATION_READ_TOOL, AuthorizationToolInputSchema, isAuthorizationTool,
  type AuthorizationToolDiscovery, type AuthorizationToolExecutor, type AuthorizationToolInvocation,
  type AuthorizationToolOperation,
} from '@/shared/security/authorization-tool-contract';

const logger = createChildLogger({ module: 'authorization-tool' });
const READ_OPERATIONS: AuthorizationToolOperation[] = ['catalog', 'effective', 'explain'];
const CHANGE_OPERATIONS: AuthorizationToolOperation[] = ['preview_change', 'apply_change'];
const KEYWORDS = ['access', 'permissions', 'authorization', 'roles', 'users', 'groups', 'application admin', 'directory mapping'];
type JsonSchema = Record<string, unknown>;
const string: JsonSchema = { type: 'string', minLength: 1, maxLength: 512 };
const targetProperties = { app: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', maxLength: 128 },
  targetSub: string, targetIssuer: string, tenantId: string };
function object(properties: Record<string, unknown>, required: string[]): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}
const targetSchema = object(targetProperties, ['app']);
const explainSchema = object({ ...targetProperties, permission: string,
  kind: { enum: ['http', 'tools', 'bots', 'jobs', 'artifactActions'] }, operation: string,
  method: { enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }, path: string,
  resourceId: string, fields: { type: 'array', items: string, maxItems: 128 } }, ['app']);
const changeSchema = object({ ...targetProperties, action: { enum: ['grant', 'revoke', 'deny', 'clear-deny', 'group-map', 'group-unmap'] },
  role: string, permission: string, expiresAt: { type: 'string', format: 'date-time' },
  reason: { type: 'string', minLength: 1, maxLength: 2000 }, expectedRevision: { type: 'integer', minimum: 0 },
  group: object({ issuer: string, tenantId: string, id: string }, ['issuer', 'tenantId', 'id']),
}, ['action', 'app', 'reason', 'expectedRevision']);
const applySchema = object({ previewId: string, idempotencyKey: string, approvalReference: string }, ['previewId', 'idempotencyKey']);

/** @description Publish the same closed operation envelopes validated by the handler. @param readsOnly AUTO restriction. @returns JSON Schema. */
export function authorizationToolInputSchema(readsOnly = false): JsonSchema {
  const branches = [object({ operation: { const: 'catalog' } }, ['operation']),
    object({ operation: { const: 'effective' }, target: targetSchema }, ['operation', 'target']),
    object({ operation: { const: 'explain' }, request: explainSchema }, ['operation', 'request'])];
  if (!readsOnly) branches.push(
    object({ operation: { const: 'preview_change' }, change: changeSchema }, ['operation', 'change']),
    object({ operation: { const: 'apply_change' }, preview: applySchema }, ['operation', 'preview']),
  );
  return { type: 'object', oneOf: branches };
}

function metadata(name: string) {
  const readsOnly = name === AUTHORIZATION_READ_TOOL;
  return CreateToolSchema.parse({ name, displayName: readsOnly ? 'Inspect application access' : 'Manage application access',
    type: ToolType.API, category: 'authorization', version: '1.0.0',
    installSpec: { method: InstallMethod.NONE }, skills: ['application-authorization'],
    selectorFragment: 'Inspect application roles and permissions with exact principal and tenant scope.',
    routingTags: KEYWORDS, tags: [AUTHORIZATION_TOOL, 'core-owned', ...KEYWORDS], authGroup: AUTHORIZATION_TOOL,
    defaultAuthMode: readsOnly ? AuthMode.AUTO : AuthMode.ASK, requiresApproval: !readsOnly,
    description: readsOnly ? 'Read permitted application catalogs, effective access and decision explanations.'
      : 'Preview and apply scoped access changes through the same service as Access Administration.',
    usageInstructions: readsOnly ? 'Only catalog, effective and explain. Caller identity is supplied by the server.'
      : 'Use preview_change first, then review in /access and apply the exact unexpired preview. No unattended mutation.',
    inputSchema: authorizationToolInputSchema(readsOnly), registeredBy: 'core:authorization', enabled: true,
  });
}

/** Fixed handler, shared by the registry executor, internal read bridge and authenticated administration route. */
export class AuthorizationToolRuntime implements AuthorizationToolExecutor {
  constructor(private readonly service: ApplicationAuthorizationManagementService) {
    for (const method of ['catalog', 'effective', 'explain', 'previewChange', 'applyChange'] as const) {
      if (typeof service?.[method] !== 'function') throw new Error('Authorization management service is not ready');
    }
  }

  private async readCatalog(actor: AuthorizationActor): Promise<AuthorizationCatalogResult> {
    try { return await this.service.catalog(actor); }
    catch (error) {
      logger.error({ err: error }, 'Authorization management catalog declined');
      if ((error as { code?: string }).code === 'authorization_management_denied' && this.service.ownCatalog) {
        return this.service.ownCatalog(actor);
      }
      throw error;
    }
  }

  /** @description Resolve current caller on every call and delegate to authoritative policy. @param name Fixed family name. @param input Untrusted model/user envelope. @param invocation Trusted transport context. @returns Serialized service result. */
  async execute(name: string, input: unknown, invocation?: AuthorizationToolInvocation): Promise<string> {
    if (!isAuthorizationTool(name)) throw new Error('Unknown authorization tool');
    if (!invocation || typeof invocation.resolveActor !== 'function') throw new Error('Verified authorization caller required');
    const parsed = AuthorizationToolInputSchema.parse(input);
    if (CHANGE_OPERATIONS.includes(parsed.operation)
      && (name === AUTHORIZATION_READ_TOOL || invocation.allowChanges !== true)) {
      throw new Error('Authorization changes require the interactive preview and approval flow');
    }
    const actor = await invocation.resolveActor();
    if (!actor?.sub || !actor.issuer || !actor.isActive) throw new Error('Active verified authorization caller required');
    const startedAt = Date.now();
    logger.info({ operation: parsed.operation }, 'Authorization tool started');
    try {
      let result: unknown;
      switch (parsed.operation) {
        case 'catalog': result = await this.readCatalog(actor); break;
        case 'effective': result = await this.service.effective(actor, parsed.target); break;
        case 'explain': result = await this.service.explain(actor, parsed.request); break;
        case 'preview_change': result = await this.service.previewChange(actor, parsed.change); break;
        case 'apply_change': result = await this.service.applyChange(actor, parsed.preview); break;
      }
      logger.info({ operation: parsed.operation, durationMs: Date.now() - startedAt }, 'Authorization tool completed');
      return JSON.stringify(result);
    } catch (error) {
      logger.error({ err: error, operation: parsed.operation }, 'Authorization tool refused');
      throw error;
    }
  }

  /** @description Advertise only current visible targets and transport-supported operations. @param actor Verified current caller. @param allowChanges Interactive transport readiness. @returns Scoped family descriptors. */
  async discover(actor: AuthorizationActor, allowChanges = false): Promise<AuthorizationToolDiscovery[]> {
    if (!actor?.sub || !actor.issuer || !actor.isActive) return [];
    if (actor.allowedPermissions && !actor.allowedPermissions.includes('platform:authorization.read')) return [];
    const catalog = await this.readCatalog(actor);
    const targets = catalog.apps.map((entry) => {
      const scopes = entry.managementScopes ?? [];
      const mayChange = allowChanges && (!actor.allowedPermissions || actor.allowedPermissions.includes('platform:authorization.assign'))
        && scopes.some((scope) => scope.permissions.includes('assign'));
      return { app: entry.app, source: entry.source, catalogRevision: entry.catalogRevision,
        operations: [...READ_OPERATIONS, ...(mayChange ? CHANGE_OPERATIONS : [])],
        ...(actor.isSwarmAdmin ? {} : { tenantIds: scopes.flatMap((scope) => scope.tenantId ? [scope.tenantId] : []) }) };
    });
    if (!targets.length) return [];
    const descriptors: AuthorizationToolDiscovery[] = [{ name: AUTHORIZATION_READ_TOOL,
      operations: [...READ_OPERATIONS], targets: targets.map((target) => ({ ...target, operations: [...READ_OPERATIONS] })) }];
    const managementTargets = targets.filter((target) => target.operations.includes('preview_change'));
    if (managementTargets.length) descriptors.push({ name: AUTHORIZATION_TOOL,
      operations: [...READ_OPERATIONS, ...CHANGE_OPERATIONS], targets: managementTargets });
    return descriptors;
  }
}

/**
 * @description Reconcile durable code-owned metadata and restore fixed executors each startup; preserve agent consent modes.
 * @param registry Persistent tool catalog. @param executors In-process immutable descriptor registry. @param service Ready authoritative management service.
 * @returns Callable runtime only after both names and handlers are registered.
 */
export async function registerAuthorizationTools(registry: ToolRegistryService, executors: DynamicToolExecutorRegistry,
  service: ApplicationAuthorizationManagementService): Promise<AuthorizationToolRuntime> {
  const runtime = new AuthorizationToolRuntime(service);
  await registry.seedAuthorizationTool(metadata(AUTHORIZATION_TOOL));
  await registry.seedAuthorizationTool(metadata(AUTHORIZATION_READ_TOOL));
  executors.registerAuthorizationDescriptors();
  return runtime;
}
