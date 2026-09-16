/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-157: the activation record, the application service principal, and the store port the runner and the routes both read. Nothing here grants; an activation is what a person did, and authorize() still decides every tick.
 *
 * @module service-activation-types
 */

/** ADR-157: the issuer every application service principal carries. Never a person's issuer. */
export const APPLICATION_SERVICE_PRINCIPAL_ISSUER = 'oshal:application-service';

/** The two principal classes a scheduled service may run under. */
export type ApplicationServiceRunsAs = 'system' | 'user';

/**
 * @description The actor an application's system services run as. One per application (per
 * tenant when tenancy is in force). Its `sub` matches no person, so row-level security keeps it
 * out of person-owned rows by construction — a job that needs a person's data is a user service.
 * @param app - Installed application name.
 * @returns The service principal's subject claim.
 */
export function applicationServicePrincipalSub(app: string): string {
  return `service:${app}`;
}

/**
 * @description Provenance tag written onto every assignment an activation creates, so
 * deactivation revokes exactly those and nothing else.
 * @param activationId - The activation row's id.
 * @returns The tag stored on each created assignment.
 */
export function serviceActivationGrantSource(activationId: string): string {
  return `service-activation:${activationId}`;
}

/** One row of oshal_application_service_activations (migration 144). */
export interface ApplicationServiceActivation {
  id: string;
  app: string;
  /** The full schedule id — `{app}-{localId}` — the scheduler dispatches. */
  scheduleId: string;
  runsAs: ApplicationServiceRunsAs;
  /** The person a user service runs as; absent for a system service. */
  targetSub?: string;
  targetIssuer?: string;
  tenantId?: string;
  /** Permissions recorded at activation, with the catalog revision they were read from. */
  requires: string[];
  catalogRevision: string;
  activatedBySub: string;
  activatedByIssuer: string;
  activatedAt: string;
  revokedBySub?: string;
  revokedByIssuer?: string;
  revokedAt?: string;
  /** Set when a tick was denied after rights changed. Cleared by a fresh activation. */
  suspendedReason?: string;
  suspendedAt?: string;
}

/** Identifies the one live activation a tick or a route is asking about. */
export interface ApplicationServiceActivationKey {
  app: string;
  scheduleId: string;
  targetSub?: string;
  targetIssuer?: string;
}

/**
 * Durable activation state. Every method is control-plane work: the service authorizes the
 * caller first and this port only reads and writes rows.
 */
export interface ApplicationServiceActivationStore {
  /** @description Read every live activation of one application. */
  listByApp(app: string): Promise<ApplicationServiceActivation[]>;
  /** @description Read every live activation across applications, for boot-time registration. */
  listLive(): Promise<ApplicationServiceActivation[]>;
  /** @description Read the one live activation matching the key, or null. */
  findLive(key: ApplicationServiceActivationKey): Promise<ApplicationServiceActivation | null>;
  /** @description Resolve the activation a due tick runs under: the system row when the schedule
   *  instance has no owner, or that person's row when it does. The schedule record carries a sub
   *  but no issuer, so a per-person lookup matches on sub alone and refuses an ambiguous pair. */
  findLiveForDispatch(app: string, scheduleId: string, ownerSub: string | null): Promise<ApplicationServiceActivation | null>;
  /** @description Read one activation by id regardless of its state. */
  read(id: string): Promise<ApplicationServiceActivation | null>;
  /** @description Insert a new activation row. */
  insert(activation: ApplicationServiceActivation): Promise<void>;
  /** @description Close a live activation; a revoked row stays for the audit trail. */
  revoke(id: string, by: { sub: string; issuer: string }, at: string): Promise<boolean>;
  /** @description Record that a tick was denied, with the decision's reason. */
  suspend(id: string, reason: string, at: string): Promise<void>;
}
