/**
 * Broker-only credential resolution for connector WRITE actions (connector-writes tier).
 *
 * Deliberately a sibling of resolveConnectorSpecCreds (spec-tools) with the env fallback REMOVED.
 * The read tier's documented `CONNECTOR_<PROVIDER>_TOKEN`/`_KEY` operator-shared fallback must
 * never apply to a mutation: an env-credentialed write would execute on the provider AS THE
 * OPERATOR while the audit row names the caller — a cross-identity write. Here a caller with no
 * brokered connection resolves to `null`, which the action executor turns into an audited 401
 * `not_connected` instead of silently borrowing the operator's key.
 *
 * The token resolver is injected (the route passes getValidAccessToken) so this module stays
 * dependency-light and unit-testable without the connectors-routes import graph.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — review fix: write actions resolve ONLY the caller's brokered credential (no CONNECTOR_* env fallback), returning null (-> audited 401 not_connected) when the caller has no stored connection.
 *
 * @module connectors/runtime/action-creds
 */

import type { BuildSpecOptions, ConnectorSpec } from './spec';

/**
 * @description The ADR-056 broker read (getValidAccessToken shape): decrypts + refreshes the
 * caller's own stored connection token. Injected rather than imported so tests can fake it and
 * this runtime module never depends on the routes layer.
 * @param pool pg pool holding oshal_connections.
 * @param userSub The caller's OIDC sub — the isolation key.
 * @param provider The credential provider slug (spec.credProvider || spec.provider).
 * @returns The decrypted access token, or null when the caller has no usable connection.
 */
export type ConnectorActionTokenResolver = (
  pool: unknown,
  userSub: string,
  provider: string,
) => Promise<string | null>;

/**
 * @description Resolves credentials for a connector WRITE action from the caller's brokered
 * connection ONLY — never from operator env keys, because a write must always execute under the
 * caller's own provider identity (the audit trail records the caller's sub as the actor).
 * @param spec The connector spec (auth type + credProvider).
 * @param pool pg pool for the broker read.
 * @param userSub The authenticated caller's sub.
 * @param getAccessToken The broker resolver (route passes getValidAccessToken). May throw on a
 * failed refresh — callers must treat a throw as a credential failure, not a server error.
 * @returns BuildSpecOptions for the client, `{}` for auth-type `none` specs (no credential
 * involved, no identity to confuse), or null when the caller is not connected.
 */
export async function resolveConnectorActionCreds(
  spec: ConnectorSpec,
  pool: unknown,
  userSub: string,
  getAccessToken: ConnectorActionTokenResolver,
): Promise<BuildSpecOptions | null> {
  if (spec.auth.type === 'none') return {};
  const credProvider = spec.credProvider || spec.provider;
  const brokerToken = await getAccessToken(pool, userSub, credProvider);
  switch (spec.auth.type) {
    case 'oauth2':
      return brokerToken ? { token: async () => brokerToken } : null;
    case 'apiKeyHeader':
    case 'apiKeyQuery':
      return brokerToken ? { apiKeyValue: brokerToken } : null;
    case 'basic': {
      const colon = brokerToken ? brokerToken.indexOf(':') : -1;
      if (colon > 0) {
        return { username: brokerToken!.slice(0, colon), password: brokerToken!.slice(colon + 1) };
      }
      return null;
    }
    default:
      return null;
  }
}
