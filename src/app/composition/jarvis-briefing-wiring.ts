/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Connect briefing delivery to current exact identities and existing application authorization.
 */
import type { AppContext } from './app-context';
import type { createApplicationAuthorizationWiring } from './application-authorization-wiring';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { PrincipalDirectoryStore } from '@/features/principal-directory';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { envFlag } from '@/shared/middleware/oidc-providers';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { principalLoginProviders } from '../middleware/principal-provider-policy';
import { configureJarvisBriefingDelivery } from '../routes/jarvis-briefing-delivery';
import { createChildLogger } from '@/shared/logger';
import { JarvisBriefingService } from './jarvis-briefing-service';
import { ensureJarvisBriefingSchema } from './jarvis-briefing-schema';

const logger = createChildLogger({ module: 'jarvis-briefing-wiring' });
type Authorization = ReturnType<typeof createApplicationAuthorizationWiring>;
/** @description Refresh current account/provider availability before legacy or protected application data.
 * @param authorization - Trusted account resolver and existing business policy runtime.
 * @returns A current access check that preserves the original caller's delegation ceiling.
 */
export function createBriefingAccessCheck(authorization: Pick<Authorization, 'runtime' | 'targetActor' | 'isProtected'>) {
  return async (actor: AuthorizationActor, app: string, botAgentId?: string): Promise<boolean> => {
    const current = await authorization.targetActor(actor.sub, actor.issuer);
    if (!current?.isActive || current.sub !== actor.sub || current.issuer !== actor.issuer) return false;
    if (!await authorization.runtime.canDiscover(app, actor)) return false;
    if (!await authorization.isProtected(app)) return true;
    return (await authorization.runtime.authorize(actor, { app, ...(botAgentId ? { kind: 'bots' as const, operation: botAgentId } : {}) })).allowed;
  };
}
/** @description Resolve a legacy scheduler subject to exactly one currently usable canonical principal.
 * @param store - Verified principal directory, including explicit local bridge links.
 * @param targetActor - Server-owned current account resolver.
 * @param env - Configured login providers; disabled providers contribute no candidates.
 * @returns A resolver that refuses missing or ambiguous identities.
 */
export function createBriefingRecipientResolver(store: Pick<PrincipalDirectoryStore, 'list'>,
  targetActor: (sub: string, issuer: string) => Promise<AuthorizationActor | null>, env: NodeJS.ProcessEnv = process.env) {
  return async (sub: string): Promise<AuthorizationActor | null> => {
    const candidates = new Map<string, AuthorizationActor>();
    const add = (actor: AuthorizationActor | null, issuer: string) => {
      if (actor?.isActive && actor.sub === sub && actor.issuer === issuer) candidates.set(JSON.stringify([actor.issuer, actor.sub]), actor);
    };
    if (envFlag(env.LOCAL_AUTH, false) || envFlag(env.ENTRA_LOCAL_AUTH_HYBRID, false) || envFlag(env.ENTRA_LOCAL_IDENTITY_BRIDGE, false)) {
      add(await targetActor(sub, LOCAL_AUTH_PRINCIPAL_ISSUER), LOCAL_AUTH_PRINCIPAL_ISSUER);
    }
    const providers = principalLoginProviders(env);
    for (const row of await store.list()) {
      if (row.status !== 'active' || !providers.has(row.issuer)) continue;
      if (row.canonicalLocalSub === sub) add(await targetActor(sub, LOCAL_AUTH_PRINCIPAL_ISSUER), LOCAL_AUTH_PRINCIPAL_ISSUER);
      else if (!row.canonicalLocalSub && row.sub === sub) add(await targetActor(sub, row.issuer), row.issuer);
    }
    return candidates.size === 1 ? [...candidates.values()][0] : null;
  };
}

/** @description Compose durable preferences and current identity policy before package source registration.
 * @param ctx - Server application context.
 * @param authorization - Existing authorization composition, including trusted actor resolution.
 * @param env - Current provider configuration.
 * @returns The delivery service, readiness promise and authenticated route actor resolver.
 */
export function createJarvisBriefingWiring(ctx: AppContext, authorization: Authorization, env: NodeJS.ProcessEnv = process.env) {
  const ready = authorization.ready.then(() => runWithSystemIdentity(() => ensureJarvisBriefingSchema(ctx.pool)));
  void ready.catch(error => logger.error({ err: error }, 'Jarvis briefings unavailable'));
  const service = new JarvisBriefingService(ctx.pool, {
    resolveRecipient: createBriefingRecipientResolver(new PrincipalDirectoryStore(ctx.pool), authorization.targetActor, env),
    canAccess: createBriefingAccessCheck(authorization),
  }, ready);
  configureJarvisBriefingDelivery({ service, resolveActor: authorization.resolveActor, targetActor: authorization.targetActor });
  return { service, ready, resolveActor: authorization.resolveActor };
}
