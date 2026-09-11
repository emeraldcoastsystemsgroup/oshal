/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Publish declared package handlers atomically and execute them under exact current user authority.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { AuthorizationActor, AuthorizationDecision, AuthorizationOperation } from '@/shared/application-authorization';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { runWithApplicationExecution } from '@/shared/application-authorization-execution';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

export type PackageToolHandler = (input: unknown) => Promise<unknown>;
export interface PackageToolContext { register(name: string, handler: PackageToolHandler): void }
export interface PackageToolDeclaration { name: string; enabled: boolean }
export interface PackageToolPolicy {
  owner(kind: 'tools', name: string): string | undefined;
  packageToolDeclarations(app: string): PackageToolDeclaration[];
  snapshot(app: string): { generation: string } | null;
  authorize(actor: AuthorizationActor, operation: AuthorizationOperation): Promise<AuthorizationDecision>;
}
export interface PackageToolStage {
  port: PackageToolContext;
  checkpoint(): number;
  rollback(checkpoint: number): void;
  validate(): void;
  publish(): void;
  abort(): void;
}
interface Entry { app: string; name: string; enabled: boolean; handler: PackageToolHandler }
const invocation = new AsyncLocalStorage<{ app: string; assertCurrent(): void }>();
const contract = createRequire(__filename)(resolve(__dirname, '../../../scripts/oshal-package-tools.js')) as {
  validatePackageTools(manifest: unknown): PackageToolDeclaration[];
};
export const validatePackageTools = contract.validatePackageTools;
const denied = (code: string) => Object.assign(new Error(code), { status: 403, statusCode: 403 });

/** @description Read a workspace selector without interpreting it as caller authority.
 * @param input Closed domain tool input. @returns Selected tenant, or undefined for personal scope.
 */
export function packageToolTenant(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !Object.prototype.hasOwnProperty.call(input, 'tenantId')) return undefined;
  const tenant = (input as { tenantId?: unknown }).tenantId;
  if (tenant === undefined) return undefined;
  if (typeof tenant !== 'string' || !tenant.trim() || tenant !== tenant.trim() || tenant.length > 200) throw denied('package_tool_tenant_invalid');
  return tenant;
}

/** @description Refuse a retired invocation at a package's fresh domain authorization boundary.
 * @param app Package whose bound authorization port is used. @returns Nothing when no tool is running or its exact registration remains active.
 */
export function assertPackageToolInvocation(app: string): void {
  const current = invocation.getStore(); if (!current) return;
  if (current.app !== app) throw denied('package_tool_namespace_mismatch');
  current.assertCurrent();
}

/** @description Manage fixed package tool handlers without a generic network or shell transport.
 * @param policy Current installed ownership/authorization. @param options Reserved core names captured before package activation.
 * @returns An initially empty registry whose retired names continue to refuse fallback.
 */
export class PackageToolRegistry {
  private readonly entries = new Map<string, Entry | null>();
  private readonly ownership = new Map<string, string>();
  private readonly generations = new Map<string, number>();
  private readonly reserved: Set<string>;
  constructor(private readonly policy: PackageToolPolicy, options: { reservedNames?: string[] } = {}) {
    this.reserved = new Set(options.reservedNames ?? []);
  }
  /** @description Identify names that must never fall back to generic execution.
   * @param name Exact tool name. @returns Whether any accepted activation declared it.
   */
  requires(name: string): boolean { return this.ownership.has(name); }
  /** @description Retract all handlers and invalidate pending activation/invocation generations.
   * @param app Owning application. @returns Nothing; tombstones remain for every declared tool.
   */
  unregister(app: string): void {
    this.generations.set(app, (this.generations.get(app) ?? 0) + 1);
    for (const [name, owner] of this.ownership) if (owner === app) this.entries.set(name, null);
  }
  /** @description Stage all factories as one activation and require every declared handler before publication.
   * @param app Exact installed app owner. @returns A factory-scoped registration port and transactional lifecycle controls.
   */
  stage(app: string): PackageToolStage {
    const declarations = this.policy.packageToolDeclarations(app);
    this.assertDeclarations(app, declarations); this.unregister(app);
    const generation = this.generations.get(app), candidates: Entry[] = []; let open = true;
    for (const item of declarations) this.ownership.set(item.name, app);
    const current = () => { if (!open || this.generations.get(app) !== generation) throw denied('package_tool_activation_closed'); };
    const validate = () => { current(); if (declarations.some(item => !candidates.some(entry => entry.name === item.name))) throw denied('package_tool_handler_missing'); };
    return {
      port: { register: (name, handler) => {
        current(); const declared = declarations.find(item => item.name === name);
        if (!declared || typeof handler !== 'function' || candidates.some(item => item.name === name)) throw denied('package_tool_registration_invalid');
        candidates.push({ app, name, enabled: declared.enabled, handler });
      } },
      checkpoint: () => candidates.length,
      rollback: checkpoint => { current(); candidates.splice(checkpoint); },
      validate,
      publish: () => { validate(); for (const entry of candidates) this.entries.set(entry.name, entry); open = false; },
      abort: () => { open = false; if (this.generations.get(app) === generation) this.unregister(app); },
    };
  }
  private assertDeclarations(app: string, declarations: PackageToolDeclaration[]): void {
    for (const item of declarations) {
      const prior = this.ownership.get(item.name);
      if (this.reserved.has(item.name) || this.policy.owner('tools', item.name) !== app || (prior && prior !== app)) throw denied('package_tool_owner_conflict');
    }
  }
  private capture(entry: Entry, generation: string): () => void {
    return () => {
      if (this.entries.get(entry.name) !== entry || this.policy.owner('tools', entry.name) !== entry.app
        || this.policy.snapshot(entry.app)?.generation !== generation) throw denied('package_tool_registration_changed');
    };
  }
  /** @description Execute one registered handler under the actual principal and recheck before releasing its JSON result.
   * @param name Exact declared tool. @param input Domain input without fabricated identity. @param userSub Optional trusted execution subject.
   * @returns Serialized bounded JSON result, or a refusal after revocation/unload/failure.
   */
  async execute(name: string, input: unknown, userSub?: string): Promise<string> {
    const entry = this.entries.get(name), actor = getApplicationAuthorizationActor();
    if (!entry?.enabled || !actor?.isActive || !actor.issuer || !actor.sub || (userSub !== undefined && userSub !== actor.sub)) throw denied('package_tool_unavailable');
    const snapshot = this.policy.snapshot(entry.app); if (!snapshot) throw denied('package_tool_unavailable');
    const assertCurrent = this.capture(entry, snapshot.generation); assertCurrent();
    const tenantId = packageToolTenant(input);
    const operation = { app: entry.app, kind: 'tools' as const, operation: name, ...(tenantId ? { tenantId } : {}) };
    const authorize = async () => { if (!(await this.policy.authorize(actor, operation)).allowed) throw denied('package_tool_permission_denied'); assertCurrent(); };
    await authorize();
    return runWithApplicationExecution({ ...operation, userSub: actor.sub }, () =>
      runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, () => invocation.run({ app: entry.app, assertCurrent }, async () => {
        assertCurrent(); const result = await entry.handler(input); await authorize();
        const encoded = JSON.stringify(result);
        if (encoded === undefined || Buffer.byteLength(encoded) > 256 * 1024) throw denied('package_tool_result_invalid');
        assertCurrent(); return encoded;
      })));
  }
}

let configured: PackageToolRegistry | undefined;
/** @description Bind the one composition-owned registry used by trusted tool execution.
 * @param registry Current registry, or undefined during teardown. @returns Nothing.
 */
export function configurePackageToolRegistry(registry: PackageToolRegistry | undefined): void { configured = registry; }
/** @description Detect a registered or retired package name before considering a generic descriptor.
 * @param name Exact tool name. @returns Whether package execution is required.
 */
export function requiresPackageTool(name: string): boolean { return configured?.requires(name) === true; }
/** @description Execute through the configured registry without falling back to a transport.
 * @param name Declared tool. @param input Domain payload. @param userSub Trusted subject. @returns Serialized JSON result.
 */
export function executePackageTool(name: string, input: unknown, userSub?: string): Promise<string> {
  if (!configured) throw denied('package_tool_registry_unavailable');
  return configured.execute(name, input, userSub);
}
