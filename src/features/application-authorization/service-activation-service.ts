/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-157: activate, deactivate and resolve scheduled application services. A system service is classified and turned on by a swarm administrator and runs as the application's own principal; a user service is turned on by a person, for themselves, and only after they are authorized for what it needs RIGHT NOW. Nothing here bypasses authorize(); it records what a person did.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | ADR-157: the services view carries the ADR-145 to-do descriptor for itself — a path and RFC 6901 pointers a setup dashboard probes in the viewer's own session — so "N scheduled services awaiting activation" is a readiness fact the kernel states, not a string a surface invents.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Fix: a deactivation names its principal class instead of inferring it. Asking for a principal that held no activation fell through to an untargeted lookup, and the row that matches COALESCE(target_sub,'')='' is the application's OWN system activation — so a stale or mistyped target switched off a service for everyone, and a person with nothing to turn off was told they needed administration. The class now decides: `system` takes the same swarm-administration check activation takes, through one shared assertion, and everything else resolves exactly one named person's activation or answers not-found.
 *
 * @module service-activation-service
 */
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '@/shared/logger';
import type { AuthorizationActor, AuthorizationCatalog, AuthorizationDecision, AuthorizationOperation } from '@/shared/application-authorization';
import { assertActor, validSubject } from './policy';
import { ApplicationAuthorizationError, type AuthorizationStore } from './types';
import { revokeServiceActivationGrants, writeServiceActivationGrants } from './service-activation-grants';
import {
  APPLICATION_SERVICE_PRINCIPAL_ISSUER, applicationServicePrincipalSub,
  type ApplicationServiceActivation, type ApplicationServiceActivationStore, type ApplicationServiceRunsAs,
} from './service-activation-types';

const logger = createChildLogger({ module: 'application-service-activation' });

/** One schedule an installed application declares, as the kernel reads it from the manifest. */
export interface ApplicationServiceDeclaration {
  /** Installed application that declares it. */
  app: string;
  /** Local id inside the manifest. */
  id: string;
  /** Full schedule id the scheduler dispatches — `{app}-{id}`. */
  scheduleId: string;
  cron: string;
  description?: string;
  /** The package's proposed class. Absent = unclassified until an administrator chooses. */
  runsAs?: ApplicationServiceRunsAs;
  requires: string[];
  queue: string;
}

/** What one service looks like to the panel that renders it. */
export interface ApplicationServiceState {
  id: string;
  scheduleId: string;
  cron: string;
  description?: string;
  proposedRunsAs?: ApplicationServiceRunsAs;
  /** The declared permissions resolved against the catalog, for the confirmation screen. */
  requires: Array<{ permission: string; resource?: string; effect?: string }>;
  state: 'not-activated' | 'active' | 'suspended';
  runsAs?: ApplicationServiceRunsAs;
  activatedAt?: string;
  activatedBy?: string;
  suspendedReason?: string;
  /** How many people run this user service. Never who. */
  userCount: number;
  activeForCaller: boolean;
}

/**
 * An ADR-145 readiness to-do, shaped exactly like the per-user probes a package declares: a path
 * to GET in the viewer's own session and RFC 6901 pointers into the response. This one points at
 * the services endpoint itself, because the kernel — not the package — owns this fact.
 */
export interface ApplicationServicesReadiness {
  app: string;
  label: string;
  path: string;
  readyPointer: string;
  detailPointer: string;
}

/** The services view, shaped so an ADR-145 readiness probe can point straight at it. */
export interface ApplicationServicesView {
  app: string;
  services: ApplicationServiceState[];
  /** False while any system service is declared and not activated. */
  ready: boolean;
  readyDetail: string;
  awaitingActivation: number;
  /** The to-do a setup dashboard renders while ready is false. */
  readiness: ApplicationServicesReadiness;
}

/**
 * What a deactivation names. The principal class is stated, never inferred from a lookup that
 * missed: the schedule's untargeted row belongs to the application itself, so resolving it because
 * some other principal had no activation would close a service nobody asked about.
 */
export interface ApplicationServiceDeactivation {
  app: string;
  scheduleId: string;
  /** The class being closed. Absent means `user` — one person's activation. */
  runsAs?: ApplicationServiceRunsAs;
  /** Whose activation, for a `user` deactivation. Absent means the caller's own. */
  targetSub?: string;
  targetIssuer?: string;
}

/** Composition-injected ports. The service owns no transport and no scheduler of its own. */
export interface ApplicationServiceActivationOptions {
  activations: ApplicationServiceActivationStore;
  policy: AuthorizationStore;
  /** Registered posture of the installed application; null when it is not registered. */
  describeApp(app: string): { source: string; catalogRevision: string; catalog: AuthorizationCatalog | null } | null;
  /** The service-route schedules the app's ACTIVE manifest declares. */
  declaredServices(app: string): Promise<ApplicationServiceDeclaration[]>;
  authorize(actor: AuthorizationActor, operation: AuthorizationOperation): Promise<AuthorizationDecision>;
  /** Register/remove the per-user schedule instance a user activation runs on. */
  registerUserInstance(input: { app: string; declaration: ApplicationServiceDeclaration; userSub: string }): Promise<void>;
  removeUserInstance(input: { app: string; declaration: ApplicationServiceDeclaration; userSub: string }): Promise<void>;
  now?: () => number;
}

/** ADR-157: the one authority over which declared services are actually running, and as whom. */
export class ApplicationServiceActivationService {
  private readonly now: () => number;

  /** @description Hold the injected ports.
   * @param options - Durable stores, application posture and the scheduler hooks.
   */
  constructor(private readonly options: ApplicationServiceActivationOptions) {
    this.now = options.now ?? Date.now;
  }

  /** @description Render every declared service of one application with its activation state.
   * @param actor - The verified caller; "active for you" is decided against this identity.
   * @param app - Installed application name.
   * @returns The services view, including the readiness answer the setup dashboard probes.
   */
  async listServices(actor: AuthorizationActor, app: string): Promise<ApplicationServicesView> {
    assertActor(actor);
    const declarations = await this.options.declaredServices(app);
    const live = await this.options.activations.listByApp(app);
    const catalog = this.options.describeApp(app)?.catalog ?? null;
    const services = declarations.map(declaration => this.describeService(declaration, live, actor, catalog));
    const awaitingActivation = services.filter(service =>
      service.proposedRunsAs === 'system' && service.state === 'not-activated').length;
    return {
      app, services, awaitingActivation, ready: awaitingActivation === 0,
      readyDetail: awaitingActivation === 0
        ? 'Every system service this application declares is activated.'
        : `${awaitingActivation} scheduled service(s) await activation by a swarm administrator.`,
      readiness: {
        app, label: 'Scheduled services', path: `/api/swarm/apps/${encodeURIComponent(app)}/services`,
        readyPointer: '/ready', detailPointer: '/readyDetail',
      },
    };
  }

  /** @description Activate one declared service under an explicitly named principal class.
   * @param actor - The verified caller. A swarm administrator for `system`; anyone for their own `user`.
   * @param input - Application, schedule and the class being confirmed.
   * @returns The stored activation.
   */
  async activate(actor: AuthorizationActor, input: { app: string; scheduleId: string; runsAs: ApplicationServiceRunsAs }): Promise<ApplicationServiceActivation> {
    assertActor(actor);
    const declaration = await this.requireDeclaration(input.app, input.scheduleId);
    const posture = this.requirePosture(input.app);
    this.assertClass(declaration, input.runsAs);
    this.assertSystemAuthority(actor, input.runsAs);
    const principal = input.runsAs === 'system'
      ? { sub: applicationServicePrincipalSub(input.app), issuer: APPLICATION_SERVICE_PRINCIPAL_ISSUER }
      : { sub: actor.sub, issuer: actor.issuer };
    if (input.runsAs === 'user') await this.assertCallerHoldsRequires(actor, input.app, declaration);
    const existing = await this.options.activations.findLive({
      app: input.app, scheduleId: declaration.scheduleId,
      ...(input.runsAs === 'user' ? { targetSub: principal.sub, targetIssuer: principal.issuer } : {}),
    });
    if (existing && !existing.suspendedReason && existing.catalogRevision === posture.catalogRevision) return existing;
    if (existing) await this.closeActivation(existing, actor);
    return this.openActivation(actor, declaration, input.runsAs, principal, posture);
  }

  /** @description Deactivate one scheduled service under the principal class the caller names.
   *
   * `system` is the application's own activation and takes the SAME swarm-administration check
   * that activating one takes — the shared assertion below, not a second rule. Anything else is
   * one person's activation: the caller's own, or a named person's for a swarm administrator, and
   * a principal that holds none is answered with not-found. Nothing falls back from one principal
   * to another, so a caller can only ever close what they named.
   *
   * The declaration's proposed class is deliberately NOT re-checked here: a package that changes
   * `runsAs` after the fact must not strand an activation that is already running.
   *
   * @param actor - The verified caller.
   * @param input - Application, schedule, the principal class and (administrators only) whose
   * activation to close.
   * @returns True when a live activation was closed; false when that principal holds none.
   */
  async deactivate(actor: AuthorizationActor, input: ApplicationServiceDeactivation): Promise<boolean> {
    assertActor(actor);
    const declaration = await this.requireDeclaration(input.app, input.scheduleId);
    const runsAs = input.runsAs ?? 'user';
    this.assertSystemAuthority(actor, runsAs);
    const activation = runsAs === 'system'
      ? await this.findSystemActivation(input, declaration.scheduleId)
      : await this.findPrincipalActivation(actor, input, declaration.scheduleId);
    if (!activation) return false;
    await this.closeActivation(activation, actor);
    if (activation.runsAs === 'user' && activation.targetSub) {
      await this.options.removeUserInstance({ app: input.app, declaration, userSub: activation.targetSub });
    }
    return true;
  }

  /** @description Resolve the activation a due tick must run under.
   * @param input - The application, the schedule id, and the schedule instance's owner (null = the
   * framework instance, which only a system activation may run).
   * @returns The live activation, or null when the tick must be skipped as not activated.
   */
  resolveDispatch(input: { app: string; scheduleId: string; ownerSub: string | null }): Promise<ApplicationServiceActivation | null> {
    return this.options.activations.findLiveForDispatch(input.app, input.scheduleId, input.ownerSub);
  }

  /** @description Record that a tick was denied so the job stops silently failing and the panel
   * can say why. Never throws into the scheduler.
   * @param activation - The activation whose run was refused.
   * @param reason - The authorization decision's reason code.
   * @returns Completion after the suspension is stored.
   */
  async suspend(activation: ApplicationServiceActivation, reason: string): Promise<void> {
    try {
      await this.options.activations.suspend(activation.id, reason, new Date(this.now()).toISOString());
    } catch (error) {
      logger.error({ err: error, app: activation.app, scheduleId: activation.scheduleId }, 'Failed to suspend a denied service activation');
    }
  }

  /** @description Build one service's panel row from its declaration and the live activations. */
  private describeService(declaration: ApplicationServiceDeclaration, live: ApplicationServiceActivation[],
    actor: AuthorizationActor, catalog: AuthorizationCatalog | null): ApplicationServiceState {
    const mine = live.filter(row => row.scheduleId === declaration.scheduleId);
    const system = mine.find(row => row.runsAs === 'system');
    const users = mine.filter(row => row.runsAs === 'user');
    const own = users.find(row => row.targetSub === actor.sub && row.targetIssuer === actor.issuer);
    const current = system ?? own ?? users[0];
    return {
      id: declaration.id, scheduleId: declaration.scheduleId, cron: declaration.cron,
      ...(declaration.description ? { description: declaration.description } : {}),
      ...(declaration.runsAs ? { proposedRunsAs: declaration.runsAs } : {}),
      requires: declaration.requires.map(permission => ({
        permission,
        ...(catalog?.permissions[permission]
          ? { resource: catalog.permissions[permission].resource, effect: catalog.permissions[permission].effect }
          : {}),
      })),
      state: !current ? 'not-activated' : current.suspendedReason ? 'suspended' : 'active',
      ...(current ? { runsAs: current.runsAs, activatedAt: current.activatedAt, activatedBy: current.activatedBySub } : {}),
      ...(current?.suspendedReason ? { suspendedReason: current.suspendedReason } : {}),
      userCount: users.length, activeForCaller: Boolean(own && !own.suspendedReason),
    };
  }

  /** @description Insert the activation row, grant a system principal its permissions and, for a
   * user service, register that person's own schedule instance. */
  private async openActivation(actor: AuthorizationActor, declaration: ApplicationServiceDeclaration,
    runsAs: ApplicationServiceRunsAs, principal: { sub: string; issuer: string },
    posture: { source: string; catalogRevision: string }): Promise<ApplicationServiceActivation> {
    const activation: ApplicationServiceActivation = {
      id: randomUUID(), app: declaration.app, scheduleId: declaration.scheduleId, runsAs,
      ...(runsAs === 'user' ? { targetSub: principal.sub, targetIssuer: principal.issuer } : {}),
      requires: [...declaration.requires], catalogRevision: posture.catalogRevision,
      activatedBySub: actor.sub, activatedByIssuer: actor.issuer,
      activatedAt: new Date(this.now()).toISOString(),
    };
    await this.options.activations.insert(activation);
    if (runsAs === 'system' && declaration.requires.length) {
      await writeServiceActivationGrants(this.options.policy, {
        activationId: activation.id, app: activation.app, source: posture.source,
        catalogRevision: posture.catalogRevision, principal, permissions: declaration.requires,
        actor: { sub: actor.sub, issuer: actor.issuer }, at: activation.activatedAt,
      });
    }
    if (runsAs === 'user') {
      await this.options.registerUserInstance({ app: activation.app, declaration, userSub: principal.sub });
    }
    logger.info({ app: activation.app, scheduleId: activation.scheduleId, runsAs, permissions: declaration.requires.length },
      'Scheduled application service activated');
    return activation;
  }

  /** @description Close one activation and revoke exactly the assignments it created. */
  private async closeActivation(activation: ApplicationServiceActivation, actor: AuthorizationActor): Promise<void> {
    const at = new Date(this.now()).toISOString();
    await this.options.activations.revoke(activation.id, { sub: actor.sub, issuer: actor.issuer }, at);
    const removed = await revokeServiceActivationGrants(this.options.policy, {
      activationId: activation.id, app: activation.app, actor: { sub: actor.sub, issuer: actor.issuer }, at,
    });
    logger.info({ app: activation.app, scheduleId: activation.scheduleId, runsAs: activation.runsAs, removed },
      'Scheduled application service deactivated');
  }

  /** @description The one authority rule for a SYSTEM service, applied identically wherever the
   * application's own principal is turned on or off: only a swarm administrator (ADR-148) acts as
   * the application. Activation and deactivation call this same assertion so the two can never
   * drift apart.
   * @param actor - The verified caller.
   * @param runsAs - The principal class the caller named.
   * @returns Nothing; throws 403 when a system act is attempted without swarm administration.
   */
  private assertSystemAuthority(actor: AuthorizationActor, runsAs: ApplicationServiceRunsAs): void {
    if (runsAs === 'system' && !actor.isSwarmAdmin) {
      throw new ApplicationAuthorizationError(403, 'authorization_service_admin_required');
    }
  }

  /** @description The schedule's system activation: the application principal's own row, which
   * carries no target. Naming a person alongside it names two different principals, so that is a
   * refusal rather than a filter.
   * @param input - The deactivation request.
   * @param scheduleId - The resolved full schedule id.
   * @returns The live system activation, or null when the service is not activated as one.
   */
  private async findSystemActivation(input: ApplicationServiceDeactivation, scheduleId: string): Promise<ApplicationServiceActivation | null> {
    if (input.targetSub !== undefined || input.targetIssuer !== undefined) {
      throw new ApplicationAuthorizationError(400, 'authorization_service_class_mismatch');
    }
    return this.options.activations.findLive({ app: input.app, scheduleId });
  }

  /** @description Exactly one person's activation — the caller's own, or, for a swarm
   * administrator, a named person's. A target that is not a subject names nobody, and an
   * untargeted lookup is the application's own row, so it is refused rather than widened.
   * @param actor - The verified caller.
   * @param input - The deactivation request.
   * @param scheduleId - The resolved full schedule id.
   * @returns That person's live activation, or null when they hold none.
   */
  private async findPrincipalActivation(actor: AuthorizationActor, input: ApplicationServiceDeactivation,
    scheduleId: string): Promise<ApplicationServiceActivation | null> {
    const target = input.targetSub === undefined
      ? { targetSub: actor.sub, targetIssuer: actor.issuer }
      : { targetSub: input.targetSub, targetIssuer: input.targetIssuer ?? actor.issuer };
    if (!validSubject(target.targetSub) || !validSubject(target.targetIssuer)) {
      throw new ApplicationAuthorizationError(400, 'authorization_service_target_invalid');
    }
    const own = target.targetSub === actor.sub && target.targetIssuer === actor.issuer;
    if (!own && !actor.isSwarmAdmin) throw new ApplicationAuthorizationError(403, 'authorization_service_owner_required');
    return this.options.activations.findLive({ app: input.app, scheduleId, ...target });
  }

  /** @description A package proposal binds the class: a `user` service is never activated as system. */
  private assertClass(declaration: ApplicationServiceDeclaration, runsAs: ApplicationServiceRunsAs): void {
    if (declaration.runsAs && declaration.runsAs !== runsAs) {
      throw new ApplicationAuthorizationError(400, 'authorization_service_class_mismatch');
    }
  }

  /** @description Every required permission must be held by the caller NOW, not at some past grant. */
  private async assertCallerHoldsRequires(actor: AuthorizationActor, app: string, declaration: ApplicationServiceDeclaration): Promise<void> {
    for (const permission of declaration.requires) {
      const decision = await this.options.authorize(actor, { app, permission });
      if (!decision.allowed) throw new ApplicationAuthorizationError(403, decision.reason);
    }
  }

  /** @description Resolve one declared, enabled service or refuse with a not-found. */
  private async requireDeclaration(app: string, scheduleId: string): Promise<ApplicationServiceDeclaration> {
    const declarations = await this.options.declaredServices(app);
    const found = declarations.find(item => item.scheduleId === scheduleId || item.id === scheduleId);
    if (!found) throw new ApplicationAuthorizationError(404, 'authorization_service_unknown');
    return found;
  }

  /** @description Resolve the registered application posture an activation binds its grants to. */
  private requirePosture(app: string): { source: string; catalogRevision: string; catalog: AuthorizationCatalog | null } {
    const posture = this.options.describeApp(app);
    if (!posture) throw new ApplicationAuthorizationError(404, 'authorization_app_unavailable');
    return posture;
  }
}
