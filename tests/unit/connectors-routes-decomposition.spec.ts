/**
 * Connector route decomposition regression.
 *
 * Pins the structural boundary that closed the connectors-routes.ts backlog item:
 * the public facade stays stable, response fields remain token-free, provider credential
 * environment paths stay explicit and reviewable, and every extracted module remains
 * comfortably below the repository's decomposition threshold.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial guard for the provider-registry/credentials, OAuth-ceremony, account-operation, response-helper, and stable-facade split.
 * -----------------------------------------------------------------------------
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import {
  additionalAccountAuthParams as facadeAdditionalAccountAuthParams,
  ensureConnectionsSchema as facadeEnsureConnectionsSchema,
  getValidAccessToken as facadeGetValidAccessToken,
} from '@/app/routes/connectors-routes';
import {
  ensureConnectionsSchema, getValidAccessToken,
} from '@/app/routes/connector-account-operations';
import {
  additionalAccountAuthParams,
} from '@/app/routes/connector-provider-registry';
import {
  buildConnectorListResponse, caller,
} from '@/app/routes/connector-response-helpers';
import type { ConnectionRow } from '@/app/routes/connector-tenancy';

const ROOT = path.resolve(__dirname, '../..');
const ROUTE_FILES = [
  'connectors-routes.ts',
  'connector-provider-registry.ts',
  'connector-oauth-ceremony.ts',
  'connector-account-operations.ts',
  'connector-response-helpers.ts',
] as const;

const APPROVED_CREDENTIAL_ENV = [
  'AZURE_EMAIL_APPLICATION_ID',
  'AZURE_EMAIL_APPLICCATION_ID',
  'AZURE_EMAIL_CLIENT_SECRET',
  'DROPBOX_APP_KEY',
  'DROPBOX_APP_SECRET',
  'DROPBOX_CLIENT_ID',
  'DROPBOX_CLIENT_SECRET',
  'FACEBOOK_APP_ID',
  'FACEBOOK_APP_SECRET',
  'GCP_CLIENT_ID',
  'GCP_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CONNECT_CLIENT_ID',
  'GOOGLE_CONNECT_CLIENT_SECRET',
  'GOOGLE_HOME_CLIENT_ID',
  'GOOGLE_HOME_CLIENT_SECRET',
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_CLIENT_SECRET',
  'LINKEDIN_PRIMARY_CLIENT_SECRET',
  'META_APPID_OSHAL_BUSINESS',
  'META_APPSECRET_OSHAL_BUSINESS',
  'META_APP_ID_OSHAL_BUSINESS',
  'META_APP_SECRET_OSHAL_BUSINESS',
  'MICROSOFT_OIDC_CLIENT_ID',
  'MICROSOFT_OIDC_CLIENT_SECRET',
  'meta_appid_oshal_business',
  'meta_appsecret_oshal_business',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OUTLOOK_CLIENT_SECRET',
  'OUTLOOK_CLIENT_VALUE',
  'OUTLOOK_OIDC_CLIENT_ID',
  'OUTLOOK_OIDC_CLIENT_SECRET',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'SCHWAB_APP_KEY',
  'SCHWAB_APP_SECRET',
  'SCHWAB_CLIENT_ID',
  'SCHWAB_CLIENT_ID_PRD',
  'SCHWAB_CLIENT_SECRET',
  'SCHWAB_CLIENT_SECRET_PRD',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_CLINET_ID',
  'SMARTTHINGS_CLIENT_ID',
  'SMARTTHINGS_CLIENT_SECRET',
  'SMARTTHINGS_OAUTH_CLIENT_ID',
  'SMARTTHINGS_OAUTH_CLIENT_SECRET',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SQUARE_APPLICATION_ID',
  'SQUARE_CLIENT_ID',
  'SQUARE_CLIENT_SECRET',
  'TWITTER_CLIENT_ID',
  'TWITTER_CLIENT_SECRET',
  'X_CLIENT_ID',
  'X_CLIENT_SECRECT',
  'X_CLIENT_SECRET',
] as const;

/** Read one route module from the real source tree. */
function routeSource(file: typeof ROUTE_FILES[number]): string {
  return fs.readFileSync(path.join(ROOT, 'src/app/routes', file), 'utf8');
}

/** Count executable/declarative lines using the repository's documented code-line convention. */
function codeLineCount(source: string): number {
  return source.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed
      && !trimmed.startsWith('//')
      && !trimmed.startsWith('/*')
      && !trimmed.startsWith('*')
      && !trimmed.startsWith('*/');
  }).length;
}

/** Build a complete personal connection row for response-shape assertions. */
function googleConnection(): ConnectionRow {
  return {
    connection_id: 'connection-google-work',
    user_sub: 'auth0|connector-owner',
    connected_by_sub: null,
    tenant_id: null,
    provider: 'google',
    label: 'work',
    account_key: 'work@example.com',
    is_default: true,
    account_email: 'work@example.com',
    account_id: 'google-account-1',
    scopes: 'openid email',
    access_token: 'encrypted-and-never-returned',
    refresh_token: 'encrypted-and-never-returned',
    expiry: new Date('2030-01-01T00:00:00.000Z'),
    created_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('connectors route decomposition boundary', () => {
  it('keeps every cohesive module below the 800-line proposal and 1000-line hard cap', () => {
    for (const file of ROUTE_FILES) {
      const source = routeSource(file);
      expect(codeLineCount(source), file).toBeLessThan(800);
      expect(source.split(/\r?\n/).length, file).toBeLessThan(1000);
    }
  });

  it('keeps the established connectors-routes public exports as identical bindings', () => {
    expect(facadeAdditionalAccountAuthParams).toBe(additionalAccountAuthParams);
    expect(facadeEnsureConnectionsSchema).toBe(ensureConnectionsSchema);
    expect(facadeGetValidAccessToken).toBe(getValidAccessToken);
  });

  it('keeps provider credential environment paths in the reviewed registry allowlist', () => {
    const source = routeSource('connector-provider-registry.ts');
    const resolver = source.slice(source.indexOf('export function providerCreds'));
    const actual = [...resolver.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)]
      .map((match) => match[1])
      .filter((name, index, names) => names.indexOf(name) === index)
      .sort();
    expect(actual).toEqual([...APPROVED_CREDENTIAL_ENV].sort());

    const facade = routeSource('connectors-routes.ts');
    expect(facade).not.toMatch(/process\.env\.(?:GOOGLE_CONNECT_CLIENT_ID|OIDC_CLIENT_SECRET|OUTLOOK_CLIENT_VALUE|TWITTER_CLIENT_SECRET)/);
  });

  it('preserves the token-free multi-account list response shape', () => {
    const providers = buildConnectorListResponse([googleConnection()]);
    const google = providers.find((provider) => provider.id === 'google');

    expect(google).toMatchObject({
      id: 'google',
      label: 'Google (Gmail + Calendar)',
      category: 'email',
      auth: 'oauth',
      connected: true,
      multiAccount: false,
      defaultConnectionId: 'connection-google-work',
      status: 'connected',
      connections: [{
        connectionId: 'connection-google-work',
        label: 'work',
        account: 'work@example.com',
        tenantId: null,
        isDefault: true,
      }],
    });
    expect(JSON.stringify(google)).not.toContain('encrypted-and-never-returned');
  });

  it('preserves authenticated caller extraction for OIDC sub and preferred username', () => {
    const req = {
      oidc: {
        isAuthenticated: () => true,
        user: { sub: 'auth0|connector-owner', preferred_username: 'owner@example.com' },
      },
    } as unknown as Request;

    expect(caller(req)).toEqual({
      sub: 'auth0|connector-owner',
      email: 'owner@example.com',
    });
  });
});
