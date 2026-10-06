/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Sole-operator self-approval (operator decision 2026-09-28). An access change or AUTH-07 catalog migration that touches the approver's own sensitive grants needs an approval reference an independent verifier accepts, and no verifier was wired, so on a one-administrator install such a change could never be applied by anyone. The swarm root may now approve it themselves by naming the exact preview, but only while no other identity resolves as a swarm administrator; the moment a second administrator exists the reference is refused again.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Count the MOCK_OIDC administrator too. Mock sessions are never observed into the principal directory, so a mock identity whose email is an operator email was an administrator the census could not see; with header overrides allowed any caller can pick a mock identity, so the census now refuses outright.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment A: the census no longer names local accounts matched by operator email (application-principal-directory swarmAdministrators). A local account's email was never verified; a local administrator holds a role row or an OSHAL_OPERATOR_SUBS entry, both of which this census already counts.
 */
import type { Pool } from 'pg';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getRootSubFromStore, listRoles } from '@/features/swarm-roles';
import { isMockOidcEnabled, MOCK_OIDC_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { isMockOidcHeaderOverrideEnabled, mockOidcDefaultIdentity } from '@/shared/middleware/oidc';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'sole-operator-approval' });

/** The typed confirmation prefix. The full reference names one preview, so it cannot be replayed on another. */
export const SOLE_OPERATOR_APPROVAL_PREFIX = 'sole-operator-self-approval:';

/** One identity that currently resolves as a swarm administrator. An absent issuer matches every issuer of that subject. */
export interface SwarmAdministratorIdentity { sub: string; issuer?: string }

/** Reads the verifier needs; composition supplies them from the role store, configuration and the principal directory. */
export interface SoleOperatorApprovalPorts {
  /** The subject holding swarm root (ADR-148), or null while root is unclaimed. */
  rootSub: () => Promise<string | null>;
  /** Every identity that would currently resolve as a swarm administrator, the approver included. */
  administrators: () => Promise<SwarmAdministratorIdentity[]>;
}

/** The preview fields the verifier reads: a catalog-migration preview names its app, an access-change preview names it on its change. */
export interface ApprovablePreview { previewId: string; app?: string; change?: { app: string } }

/**
 * @description The confirmation a sole operator types to approve one preview themselves. Bound to
 * the preview id so an approval for one change is never accepted for another.
 * @param previewId - The access-change or catalog-migration preview being approved.
 * @returns The approval reference to send as `approvalReference`.
 */
export function soleOperatorApprovalReference(previewId: string): string {
  return `${SOLE_OPERATOR_APPROVAL_PREFIX}${previewId}`;
}

/**
 * @description Whether a reference is a sole-operator self-approval at all, so an audit reader can
 * tell a self-approved change from one an independent approver signed.
 * @param reference - A stored approval reference.
 * @returns True for the sole-operator form.
 */
export function isSoleOperatorApprovalReference(reference: string | undefined): boolean {
  return typeof reference === 'string' && reference.startsWith(SOLE_OPERATOR_APPROVAL_PREFIX);
}

function sameIdentity(identity: SwarmAdministratorIdentity, actor: AuthorizationActor): boolean {
  return identity.sub === actor.sub && (identity.issuer === undefined || identity.issuer === actor.issuer);
}

function appOf(preview: ApprovablePreview): string | undefined { return preview.app ?? preview.change?.app; }

function refuse(reason: string, preview: ApprovablePreview, started: number): false {
  logger.warn({ reason, app: appOf(preview), previewId: preview.previewId, durationMs: Date.now() - started },
    'Sole-operator self-approval refused');
  return false;
}

/**
 * @description Build the approval verifier for both access changes and catalog migrations. It
 * accepts only when the reference names this exact preview, the caller is the active, undelegated
 * swarm root, and no OTHER identity resolves as a swarm administrator. A root already holds every
 * management right, so on a one-administrator install this approves nothing the root could not do;
 * where a second administrator exists the two-person rule stands and this refuses.
 * @param ports - Root and administrator reads.
 * @returns A verifier with the service's `verifyApproval` / `verifyCatalogMigrationApproval` shape.
 */
export function createSoleOperatorApprovalVerifier(ports: SoleOperatorApprovalPorts) {
  return async (actor: AuthorizationActor, preview: ApprovablePreview, reference: string): Promise<boolean> => {
    const started = Date.now();
    if (reference !== soleOperatorApprovalReference(preview.previewId)) return refuse('reference_not_bound_to_preview', preview, started);
    if (!actor.isActive || !actor.isSwarmAdmin || actor.allowedPermissions !== undefined) return refuse('not_swarm_administrator', preview, started);
    try {
      const root = await ports.rootSub();
      if (!root || root !== actor.sub) return refuse('not_swarm_root', preview, started);
      const others = (await ports.administrators()).filter(identity => !sameIdentity(identity, actor));
      if (others.length > 0) return refuse('second_administrator_present', preview, started);
    } catch (error) {
      logger.error({ err: error, app: appOf(preview), previewId: preview.previewId }, 'Sole-operator census unavailable; approval refused');
      return false;
    }
    logger.info({ app: appOf(preview), previewId: preview.previewId, durationMs: Date.now() - started }, 'Sole-operator self-approval accepted');
    return true;
  };
}

/**
 * @description The MOCK_OIDC administrator, when mock sign-in is on. Mock sessions are never
 * observed into the principal directory, so the census adds the fixed mock identity itself when its
 * email is a configured operator email. With header overrides allowed a caller can sign in as any
 * mock identity, so the administrators cannot be counted at all and the census refuses.
 * @param env - Authentication configuration.
 * @returns The mock administrator, if any.
 */
function mockAdministrators(env: NodeJS.ProcessEnv): SwarmAdministratorIdentity[] {
  if (!isMockOidcEnabled(env)) return [];
  if (isMockOidcHeaderOverrideEnabled(env)) throw new Error('MOCK_OIDC_ALLOW_HEADER lets a caller choose any mock identity; administrators cannot be counted');
  const identity = mockOidcDefaultIdentity(env);
  const emails = new Set((env.OSHAL_OPERATOR_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  return emails.has(identity.email.toLowerCase()) ? [{ sub: identity.sub, issuer: MOCK_OIDC_PRINCIPAL_ISSUER }] : [];
}

/**
 * @description The administrator census from every source that can make an identity a swarm
 * administrator: the ADR-148 role store (root and admin), the configured operator subjects, and
 * the directory identities that configuration admits (verified provider sign-ins; a local account
 * is never one by its unverified email), and the MOCK_OIDC identity when mock sign-in is on.
 * @param pool - Control-plane pool. @param env - Authentication configuration.
 * @param directoryAdministrators - Directory identities that resolve as administrators.
 * @returns The census port.
 */
export function createSwarmAdministratorCensus(pool: Pool, env: NodeJS.ProcessEnv,
  directoryAdministrators: () => Promise<SwarmAdministratorIdentity[]>): SoleOperatorApprovalPorts {
  return {
    rootSub: () => getRootSubFromStore(pool),
    administrators: async () => {
      const roles = (await listRoles(pool)).filter(row => row.role === 'root' || row.role === 'admin').map(row => ({ sub: row.userSub }));
      const configured = (env.OSHAL_OPERATOR_SUBS ?? '').split(',').map(value => value.trim()).filter(Boolean).map(sub => ({ sub }));
      return [...roles, ...configured, ...mockAdministrators(env), ...await directoryAdministrators()];
    },
  };
}
