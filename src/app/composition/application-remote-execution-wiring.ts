/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Compose durable remote authority from current principal, package and existing controller signing services.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { configureApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';
import { configureProtectedResultAccess } from '@/shared/protected-results';
import { createRecordedDelegationTokenIssuer, createDelegationTokenVerifier,
  type RecordedDelegationTokenIssuer, type DelegationTokenVerifier } from '@/shared/security/delegation-token';
import { delegationIssuerFromEnvironment, delegationAudienceFromEnvironment } from '@/shared/security/delegation-http-policy';
import { ApplicationRemoteExecutionService, PostgresRemoteExecutionStore } from '@/features/application-remote-execution';
import { readApplicationExecutionOwnership } from '../application-execution-ownership';
import { applicationAuthorizationMode, type ApplicationAuthorizationRuntime } from './application-authorization-runtime';

function publicEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.OSHAL_DELEGATION_PUBLIC_KEYS) return { OSHAL_DELEGATION_PUBLIC_KEYS: env.OSHAL_DELEGATION_PUBLIC_KEYS };
  const material = env.OSHAL_DELEGATION_SIGNING_PRIVATE_KEY?.trim();
  if (!material || !env.OSHAL_DELEGATION_SIGNING_KID) return {};
  const key = createPrivateKey(material.startsWith('{') ? { key: JSON.parse(material), format: 'jwk' } : material);
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  return { OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({ [env.OSHAL_DELEGATION_SIGNING_KID]: publicKey }) };
}

function lazySigning(env: NodeJS.ProcessEnv) {
  let issuer: RecordedDelegationTokenIssuer | undefined; let verifier: DelegationTokenVerifier | undefined;
  return {
    issuer: { issue: (...args: Parameters<RecordedDelegationTokenIssuer['issue']>) => {
      issuer ??= createRecordedDelegationTokenIssuer({ env }); return issuer.issue(...args);
    } },
    verifier: { verify: (...args: Parameters<DelegationTokenVerifier['verify']>) => {
      verifier ??= createDelegationTokenVerifier({ env: publicEnvironment(env) }); return verifier.verify(...args);
    } },
  };
}

/** @description Register one controller authority while leaving signing keys lazy until protected dispatch.
 * @param pool Controller pool. @param ready Required schemas. @param runtime Current package generation and policy.
 * @param refreshActor Existing verified account refresh. @param env Controller configuration. @returns The shared authority.
 */
export function createApplicationRemoteExecutionWiring(pool: Pool, ready: Promise<unknown>, runtime: ApplicationAuthorizationRuntime,
  refreshActor: (actor: AuthorizationActor) => Promise<AuthorizationActor | null>, env: NodeJS.ProcessEnv = process.env) {
  const authority = new ApplicationRemoteExecutionService(new PostgresRemoteExecutionStore(pool, ready), {
    ...lazySigning(env), tokenIssuer: delegationIssuerFromEnvironment(env), dispatchAudience: delegationAudienceFromEnvironment(env),
    owner: async (kind, id) => { await ready; return readApplicationExecutionOwnership(pool, { kind, id, mode: applicationAuthorizationMode(env) }); },
    snapshot: app => runtime.snapshot(app), refreshActor,
    authorize: (actor, operation) => runtime.authorize(actor, operation),
    effective: (actor, app, tenantId) => runtime.service.effective(actor, { app, tenantId }),
  });
  configureApplicationRemoteExecutionAuthority(authority);
  configureProtectedResultAccess({
    assertResultAccess: (id, actor, binding) => authority.assertResultAccess(id, actor, binding),
    assertTaskResultAccess: (id, actor) => authority.assertTaskResultAccess(id, actor),
    hasTaskResults: id => authority.hasTaskResults(id),
    isProtectedAgent: async id => { await ready;
      return Boolean((await readApplicationExecutionOwnership(pool, { kind: 'bots', id, mode: applicationAuthorizationMode(env) }))?.protected);
    },
  });
  return authority;
}
