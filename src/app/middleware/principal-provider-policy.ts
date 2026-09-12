/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reuse enabled login providers to scope observed principals and existing operator continuity.
 */
import { envFlag, resolveLoginProviders, resolveMicrosoftSecondaryLoginProvider, type LoginProvider } from '@/shared/middleware/oidc-providers';
import type { VerifiedPrincipal } from '@/features/principal-directory';

/** @description Resolve the same enabled providers as interactive authentication, without contacting an identity provider.
 * @param env Actual authentication configuration. @returns Trusted exact issuer records; disabled providers are absent.
 */
export function principalLoginProviders(env: NodeJS.ProcessEnv): ReadonlyMap<string, LoginProvider> {
  if (envFlag(env.MOCK_OIDC, false)) return new Map();
  const hybrid = envFlag(env.ENTRA_LOCAL_AUTH_HYBRID, false);
  const bridge = envFlag(env.ENTRA_LOCAL_IDENTITY_BRIDGE, false);
  if (envFlag(env.LOCAL_AUTH, false) && !hybrid && !bridge) return new Map();
  const primary = env.OIDC_ISSUER_URL?.trim() || `${env.KEYCLOAK_EXTERNAL_URL || env.KEYCLOAK_URL || 'http://localhost:8080'}/realms/${env.KEYCLOAK_REALM || 'oshal'}`;
  const providers = hybrid ? (envFlag(env.MICROSOFT_LOGIN, false) ? [resolveMicrosoftSecondaryLoginProvider(env)] : [])
    : resolveLoginProviders({ issuerBaseURL: primary, clientID: env.OIDC_CLIENT_ID || env.KEYCLOAK_CLIENT_ID || 'oshal-swarm',
      clientSecret: env.OIDC_CLIENT_SECRET || env.KEYCLOAK_CLIENT_SECRET || '' }, env);
  return new Map(providers.map(provider => [provider.issuerBaseURL, provider]));
}
/** @description Preserve explicitly configured operators only inside an actually enabled, permitted issuer namespace.
 * @param principal Metadata observed from authenticated protocol claims. @param providers Enabled provider set.
 * @param env Operator configuration. @returns Administration eligibility; never a business-data permission.
 */
export function configuredPrincipalOperator(principal: VerifiedPrincipal, providers: ReadonlyMap<string, LoginProvider>, env: NodeJS.ProcessEnv): boolean {
  const provider = providers.get(principal.issuer);
  const explicit = new Set((env.OSHAL_AUTHORIZATION_ADMIN_ISSUERS ?? '').split(',').map(value => value.trim()).filter(Boolean));
  if (!provider || principal.status !== 'active' || principal.canonicalLocalSub || (!provider.isPrimary && !explicit.has(principal.issuer))) return false;
  const subjects = new Set((env.OSHAL_OPERATOR_SUBS ?? '').split(',').map(value => value.trim()).filter(Boolean));
  const emails = new Set((env.OSHAL_OPERATOR_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  return subjects.has(principal.sub) || Boolean(principal.emailVerified && principal.email && emails.has(principal.email.toLowerCase()));
}
