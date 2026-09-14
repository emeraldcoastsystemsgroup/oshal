/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind bounded package facts to current caller authority before accountable specialist dispatch.
 */
/** Package-owned, caller-authorized numeric facts for accountable specialist dispatch. */
import type { AuthorizationActor, AuthorizationDecision, AuthorizationOperation } from '@/shared/application-authorization';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { runWithApplicationExecution } from '@/shared/application-authorization-execution';
import { getRequestIdentity, isSystemIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';

/** @description Restrict outgoing context to scalar facts without raw content or credentials. */
export type SpecialistFact = number | boolean | null;
/** @description Preserve the authenticated subject's issuer namespace. */
export interface SpecialistPrincipal { sub: string; issuer: string }
/** @description Bind one package reader to its owned specialist and named read permission. */
export interface SpecialistContextDeclaration {
  agentId: string;
  toolName: string;
  /** Closed, package-authored fact keys. No query, prompt, connection or credential is supplied. */
  facts: string[];
  /** @description Read through existing package record policy. @param input Verified principal and cancellation signal. @returns Closed scalar facts. */
  read(input: Readonly<SpecialistPrincipal & { signal: AbortSignal }>): Promise<Record<string, SpecialistFact>>;
}
/** @description Expose only activation-scoped registration to package code. */
export interface PackageSpecialistContext { register(declaration: SpecialistContextDeclaration): void }
/** @description Inject authoritative executable ownership and current caller rights. */
export interface SpecialistContextPolicy {
  owner(kind: 'bots' | 'tools', id: string): string | undefined;
  authorize(actor: AuthorizationActor, operation: AuthorizationOperation): Promise<AuthorizationDecision>;
}
interface Registration extends SpecialistContextDeclaration { app: string }
/** @description Refuse dispatch without exposing package errors. @param code Stable refusal reason. @returns Typed unavailable error. */
export class SpecialistContextError extends Error {
  readonly status = 503;
  constructor(readonly code: string) { super(code); this.name = 'SpecialistContextError'; }
}
const stableKey = /^[a-z][a-z0-9_.-]{0,63}$/;
const reserved = new Set(['__proto__', 'constructor', 'prototype']);

/** @description Retain data requirements when readers retire so dispatch never silently loses required facts.
 * @param policy Live ownership and permission policy. @param options Bounded reader deadline. @returns Lifecycle-aware specialist registry. */
export class SpecialistContextRegistry {
  private readonly entries = new Map<string, { app: string; registration?: Registration }>();
  private readonly generations = new Map<string, number>();
  private readonly timeoutMs: number;
  /** @description Bind ownership and current policy to each read. @param policy Live runtime authority.
   * @param options Deadline in milliseconds. @returns Registry with no active readers. */
  constructor(private readonly policy: SpecialistContextPolicy, options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 2000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 20 || this.timeoutMs > 10000) throw new Error('Invalid specialist context timeout');
  }
  /** @description Remember retired requirements. @param agentId Exact owned bot. @returns Whether dispatch requires context. */
  requires(agentId: string): boolean { return this.entries.has(agentId); }
  /** @description Bind delivery to the reader used for this dispatch. @param agentId Owned bot. @returns Synchronous post-authorization freshness check. */
  capture(agentId: string): () => void {
    const entry = this.entries.get(agentId), registration = entry?.registration;
    if (!registration) throw new SpecialistContextError('specialist_context_unavailable');
    return () => {
      if (this.entries.get(agentId) !== entry) throw new SpecialistContextError('specialist_context_changed');
      this.assertOwnership(registration.app, agentId, registration.toolName);
    };
  }
  /** @description Invalidate staged and published readers. @param app Exact owning package. @returns Nothing. */
  unregister(app: string): void {
    this.generations.set(app, (this.generations.get(app) ?? 0) + 1);
    this.retire(app);
  }
  private retire(app: string): void {
    for (const [agentId, entry] of this.entries) if (entry.app === app) this.entries.set(agentId, { app });
  }
  /** @description Stage factory contributions until activation succeeds. @param app Owning package. @returns Scoped registration and lifecycle controls. */
  stage(app: string) {
    const generation = (this.generations.get(app) ?? 0) + 1;
    this.generations.set(app, generation);
    const candidates: Registration[] = [];
    let open = true;
    const port: PackageSpecialistContext = Object.freeze({ register: (input: SpecialistContextDeclaration) => {
      if (!open) throw new SpecialistContextError('specialist_registration_closed');
      if (!input || typeof input.read !== 'function' || typeof input.agentId !== 'string' || typeof input.toolName !== 'string'
        || !Array.isArray(input.facts) || !input.facts.length || input.facts.length > 64
        || new Set(input.facts).size !== input.facts.length || input.facts.some(key => typeof key !== 'string' || !stableKey.test(key) || reserved.has(key))) {
        throw new SpecialistContextError('specialist_registration_invalid');
      }
      this.assertOwnership(app, input.agentId, input.toolName);
      if (candidates.some(candidate => candidate.agentId === input.agentId)) throw new SpecialistContextError('specialist_registration_duplicate');
      if (!this.entries.has(input.agentId)) this.entries.set(input.agentId, { app });
      candidates.push({ app, agentId: input.agentId, toolName: input.toolName, facts: [...input.facts], read: input.read });
    } });
    return { port, checkpoint: () => candidates.length, rollback: (length: number) => { candidates.splice(length); },
      abort: () => { open = false; if (this.generations.get(app) === generation) this.unregister(app); },
      publish: () => {
        if (!open) throw new SpecialistContextError('specialist_registration_closed');
        if (this.generations.get(app) !== generation) throw new SpecialistContextError('specialist_registration_superseded');
        for (const candidate of candidates) this.assertOwnership(app, candidate.agentId, candidate.toolName);
        open = false; this.retire(app);
        for (const registration of candidates) this.entries.set(registration.agentId, { app, registration });
      } };
  }
  private assertOwnership(app: string, agentId: string, toolName: string): void {
    if (this.policy.owner('bots', agentId) !== app || this.policy.owner('tools', toolName) !== app) {
      throw new SpecialistContextError('specialist_registration_owner_mismatch');
    }
  }
  /** @description Read and bound facts under current caller authority. @param agentId Owned specialist. @param text Original task text.
   * @param principal Verified delegated subject and issuer. @returns Original task with deterministic facts appended. */
  async append(agentId: string, text: string, principal: SpecialistPrincipal): Promise<string> {
    const entry = this.entries.get(agentId), registration = entry?.registration;
    if (!registration) throw new SpecialistContextError('specialist_context_unavailable');
    const actor = getApplicationAuthorizationActor(), identity = getRequestIdentity();
    if (!actor?.isActive || actor.sub !== principal.sub || actor.issuer !== principal.issuer
      || !identity || isSystemIdentity(identity) || identity.sub !== principal.sub || identity.principalIssuer !== principal.issuer) {
      throw new SpecialistContextError('specialist_context_identity_required');
    }
    return runWithRequestIdentity({ sub: principal.sub, principalIssuer: principal.issuer, isOperator: false }, async () => {
      try {
        return await withinDeadline(async signal => {
          await this.assertCurrent(actor, entry, registration, signal);
          const value = await runWithApplicationExecution({ app: registration.app, kind: 'tools', operation: registration.toolName, userSub: principal.sub },
            () => {
              if (signal.aborted) throw new SpecialistContextError('specialist_context_timeout');
              return registration.read(Object.freeze({ ...principal, signal }));
            });
          const facts = normalizeFacts(value, registration.facts);
          await this.assertCurrent(actor, entry, registration, signal);
          return `${text}\n\nApplication facts (${registration.app}; ${registration.toolName}):\n${JSON.stringify(facts)}`;
        }, this.timeoutMs);
      } catch (error) {
        if (error instanceof SpecialistContextError) throw error;
        throw new SpecialistContextError('specialist_context_read_failed');
      }
    });
  }
  private async assertCurrent(actor: AuthorizationActor, entry: unknown, registration: Registration, signal: AbortSignal): Promise<void> {
    const unchanged = () => {
      if (signal.aborted) throw new SpecialistContextError('specialist_context_timeout');
      if (this.entries.get(registration.agentId) !== entry) throw new SpecialistContextError('specialist_context_changed');
      this.assertOwnership(registration.app, registration.agentId, registration.toolName);
    };
    unchanged();
    const decision = await this.policy.authorize(actor, { app: registration.app, kind: 'tools', operation: registration.toolName });
    unchanged();
    if (!decision.allowed) throw new SpecialistContextError('specialist_context_permission_denied');
  }
}

async function withinDeadline<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new SpecialistContextError('specialist_context_timeout'));
  }, timeoutMs); });
  try { return await Promise.race([read(controller.signal), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function normalizeFacts(value: unknown, allowed: string[]): Record<string, SpecialistFact> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new SpecialistContextError('specialist_context_result_invalid');
  }
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) throw new SpecialistContextError('specialist_context_result_invalid');
  const result: Record<string, SpecialistFact> = Object.create(null);
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key), fact = descriptor?.value;
    if (!descriptor || !('value' in descriptor) || !(fact === null || typeof fact === 'boolean'
      || (typeof fact === 'number' && Number.isFinite(fact) && Math.abs(fact) <= 1e15))) {
      throw new SpecialistContextError('specialist_context_result_invalid');
    }
    result[key] = fact;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 8192) throw new SpecialistContextError('specialist_context_result_oversized');
  return result;
}
let registry: SpecialistContextRegistry | undefined;
/** @description Install the composition-owned registry. @param value Active registry or undefined for teardown. @returns Nothing. */
export function configureSpecialistContextRegistry(value: SpecialistContextRegistry | undefined): void { registry = value; }
/** @description Resolve the composition-owned dispatch port. @returns Active registry, if composed. */
export function getSpecialistContextRegistry(): SpecialistContextRegistry | undefined { return registry; }
