/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Resolve the ADR-118 legacy explicit tier on the FULL verified principal. The wiring refused every non-local issuer BEFORE reading an assignment, so an explicit admin assignment written for a federated identity was unreadable and every catalog-less application answered that identity authorization_app_admin_required. Extracted from the wiring so the seam that decides it can be proved directly against a real store.
 */
/** The ADR-118 legacy tier bridge: one explicit assignment, read for one verified principal. */
import type { ApplicationAuthorizationServiceOptions } from '@/features/application-authorization';
import type { AppAccessService, SwarmAppAccessDeclaration, SwarmAppService } from '@/features/swarm-apps';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

/**
 * @description The tier vocabulary used for an application whose manifest declares no `access:`
 * block. It denies by default, so an application that never opted into ADR-118 gains nothing from
 * being resolved — only an assignment an operator explicitly wrote can lift it.
 * @returns A fresh declaration; callers must not share one instance.
 */
function undeclaredAccess(): SwarmAppAccessDeclaration {
  return { supported: ['deny', 'viewer', 'editor', 'admin'], defaultTier: 'deny' };
}

/**
 * @description Build the `resolveTier` port the authorization service consults for the legacy
 * ADR-118 explicit ceiling, and for the app-admin fallback a catalog-less application depends on.
 *
 * The lookup carries the actor's issuer as well as its subject. A subject identifier is unique
 * only inside its issuer, and the assignment store originally recorded no issuer at all, so the
 * only safe reading of an old row is "a canonical local account". That rule is preserved — inside
 * the query predicate, where it belongs — instead of being enforced by refusing to read anything
 * for any other issuer, which is what locked every OIDC-signed-in user out of every application.
 *
 * Nothing here grants access: it reports the assignment that already exists, and reports `explicit:
 * false` when the answer came from the manifest default rather than a written assignment.
 *
 * @param appAccess - The durable ADR-118 assignment store.
 * @param getApps - Lazy application registry, for the manifest's declared tier vocabulary.
 * @returns The tier resolver, reading under system identity so RLS admits the control-plane read.
 */
export function createLegacyTierResolver(
  appAccess: Pick<AppAccessService, 'resolveForPrincipal'>,
  getApps: () => Pick<SwarmAppService, 'getApp'>,
): NonNullable<ApplicationAuthorizationServiceOptions['resolveTier']> {
  return async (app, actor) => {
    const record = await getApps().getApp(app);
    const access = await runWithSystemIdentity(() => appAccess.resolveForPrincipal(
      app, actor.sub, actor.issuer, record?.manifest.access ?? undeclaredAccess(),
    ));
    return { tier: access.tier, explicit: access.source !== 'default' };
  };
}
