/**
 * Connector HTTP response helpers.
 *
 * Keeps identity extraction and token-free connector list shaping outside the route
 * registrar. Responses expose status and account selectors only; encrypted credentials
 * and plaintext tokens never enter these structures.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted authenticated caller resolution and /list response shaping from connectors-routes.ts without changing response fields or provider configuration rules.
 * -----------------------------------------------------------------------------
 *
 * @module connector-response-helpers
 */

import type { Request } from 'express';
import { buildAnyLlmListEntry } from './byo-llm-routes';
import { isPlaidConfigured } from './connector-plaid-link';
import {
  CONNECTOR_CATEGORY, PLATFORM_DEFAULT_ENV, PROVIDERS, providerCreds,
} from './connector-provider-registry';
import { pickConnection, type ConnectionRow } from './connector-tenancy';

/**
 * @description Authenticated connector caller identity resolved from the OIDC session.
 */
export interface ConnectorCaller {
  sub: string;
  email: string;
}

/**
 * @description Pull the signed-in user's stable identity and display email from OIDC.
 * @param req - authenticated Express request
 * @returns the caller identity, or null when the request is not authenticated
 */
export function caller(req: Request): ConnectorCaller | null {
  const oidc = (req as any).oidc;
  if (!oidc || typeof oidc.isAuthenticated !== 'function' || !oidc.isAuthenticated()) return null;
  const u = oidc.user || {};
  const sub = u.sub || u.oid;
  if (!sub) return null;
  return { sub: String(sub), email: String(u.email || u.preferred_username || '') };
}

/**
 * @description Shape the token-free provider catalog and all accessible account selectors.
 * @param rows - caller-accessible personal and shared connector rows
 * @returns connector list entries in the established /api/connect/list response shape
 */
export function buildConnectorListResponse(rows: ConnectionRow[]): Array<Record<string, unknown>> {
  const byProvider = new Map<string, ConnectionRow[]>();
  for (const row of rows) {
    const providerRows = byProvider.get(row.provider) || [];
    providerRows.push(row);
    byProvider.set(row.provider, providerRows);
  }
  const providers: Array<Record<string, unknown>> = Object.entries(PROVIDERS).map(([id, def]) => {
    const conns = byProvider.get(id) || [];
    const creds = providerCreds(id);
    const authModel = def.auth || 'oauth';
    return {
      id,
      label: def.label,
      category: CONNECTOR_CATEGORY[id] || 'other',
      auth: authModel,
      // Token-paste connectors need no OAuth client — they're configured by the user's token.
      // Link connectors need platform app credentials; OAuth connectors need client id + secret.
      configured: authModel === 'token' ? true
        : authModel === 'link' ? isPlaidConfigured()
        : !!(creds.clientId && creds.clientSecret),
      tokenHelpUrl: def.tokenHelpUrl || null,
      tokenFallback: !!def.allowTokenFallback,
      // Shared read-only catalog keys make a personal connection optional.
      platformDefault: (PLATFORM_DEFAULT_ENV[id] || []).some((key) => !!(process.env[key] || '').trim()),
      connected: conns.length > 0,
      connections: conns.map((connection) => ({
        connectionId: connection.connection_id,
        label: connection.label,
        account: connection.account_email,
        tenantId: connection.tenant_id || null,
        isDefault: connection.is_default,
      })),
      multiAccount: conns.length > 1,
      defaultConnectionId: pickConnection(conns)?.connection_id ?? null,
      status: conns.length ? 'connected' : 'not_connected',
    };
  });
  // The vendor-neutral "any API, any LLM" entry shares the same response collection.
  providers.push(buildAnyLlmListEntry(rows) as Record<string, unknown>);
  return providers;
}

