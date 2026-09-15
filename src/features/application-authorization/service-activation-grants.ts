/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-157: write and revoke the service principal's permissions as ordinary assignments tagged with the activation that created them, so a deactivation removes exactly those and nothing a person was granted separately.
 *
 * @module service-activation-grants
 */
import { randomUUID } from 'node:crypto';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { AuthorizationAssignment, AuthorizationStore } from './types';
import { serviceActivationGrantSource } from './service-activation-types';

/** Everything one activation needs to write its grants, resolved by the caller beforehand. */
export interface ServiceActivationGrantInput {
  activationId: string;
  app: string;
  /** The installed source the app's registration carries; assignments bind to it. */
  source: string;
  catalogRevision: string;
  principal: { sub: string; issuer: string };
  permissions: readonly string[];
  tenantId?: string;
  /** The administrator whose act this was; recorded on every audit entry. */
  actor: Pick<AuthorizationActor, 'sub' | 'issuer'>;
  at: string;
}

/**
 * @description Grant exactly the declared permissions to an application's service principal, each
 * assignment tagged with the activation that created it. One transaction, one revision bump, one
 * audit entry per permission, so `/access` shows the act with its permission list.
 * @param store - The durable authorization policy store.
 * @param input - The activation's resolved grant material.
 * @returns The identifiers of the assignments this activation created.
 */
export async function writeServiceActivationGrants(
  store: AuthorizationStore,
  input: ServiceActivationGrantInput,
): Promise<string[]> {
  const grantSource = serviceActivationGrantSource(input.activationId);
  return store.transaction(async ({ state, audit }) => {
    const created: string[] = [];
    for (const permission of input.permissions) {
      const assignment: AuthorizationAssignment = {
        id: randomUUID(), app: input.app, source: input.source, catalogRevision: input.catalogRevision,
        targetSub: input.principal.sub, targetIssuer: input.principal.issuer,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
        permission, deny: false, grantSource,
      };
      state.assignments.push(assignment);
      created.push(assignment.id);
    }
    if (!created.length) return created;
    state.revision += 1;
    for (const permission of input.permissions) {
      audit({
        id: randomUUID(), actor: { sub: input.actor.sub, issuer: input.actor.issuer }, at: input.at,
        revision: state.revision, previewId: grantSource,
        change: {
          action: 'grant', app: input.app, targetSub: input.principal.sub, targetIssuer: input.principal.issuer,
          ...(input.tenantId ? { tenantId: input.tenantId } : {}),
          permission, reason: `ADR-157 service activation ${input.activationId}`, expectedRevision: state.revision - 1,
        },
      });
    }
    return created;
  });
}

/**
 * @description Revoke exactly the assignments one activation created — matched on the activation
 * tag, never on "every permission this principal holds", so a second live activation of the same
 * application keeps its own grants.
 * @param store - The durable authorization policy store.
 * @param input - The activation being closed, the actor closing it and the time.
 * @returns How many assignments were removed.
 */
export async function revokeServiceActivationGrants(
  store: AuthorizationStore,
  input: { activationId: string; app: string; actor: Pick<AuthorizationActor, 'sub' | 'issuer'>; at: string },
): Promise<number> {
  const grantSource = serviceActivationGrantSource(input.activationId);
  return store.transaction(async ({ state, audit }) => {
    const removed = state.assignments.filter(row => row.grantSource === grantSource);
    if (!removed.length) return 0;
    state.assignments = state.assignments.filter(row => row.grantSource !== grantSource);
    state.revision += 1;
    for (const row of removed) {
      audit({
        id: randomUUID(), actor: { sub: input.actor.sub, issuer: input.actor.issuer }, at: input.at,
        revision: state.revision, previewId: grantSource,
        change: {
          action: 'revoke', app: row.app, targetSub: row.targetSub, targetIssuer: row.targetIssuer,
          ...(row.tenantId ? { tenantId: row.tenantId } : {}),
          permission: row.permission, reason: `ADR-157 service deactivation ${input.activationId}`,
          expectedRevision: state.revision - 1,
        },
      });
    }
    return removed.length;
  });
}
