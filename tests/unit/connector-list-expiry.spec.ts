/**
 * Connector list projection — the per-connection contract, and what "expired" means.
 *
 * BUG-13: Identity Hub's whole reason to exist is telling you which connected account has gone
 * stale. It read a per-connection `expired` flag in four places; the /api/connect/list projection
 * never emitted one, so every read was `undefined`, "Need attention" always rendered 0, and the
 * red Reconnect pill could not appear on any card. Nothing failed — a surface reading a key its
 * response does not carry just renders a falsy value — which is exactly why it shipped looking
 * correct and why this file exists.
 *
 * Two properties are pinned here:
 *
 * 1. THE KEY SET. Every connection object in the response carries exactly the keys consumers
 *    read. Dropping one goes red instead of silently rendering a zero on some other screen.
 *    Scope limit, stated rather than implied: this asserts the PRODUCING side. The Identity Hub
 *    surface lives in the oshal-applications store repo, which a core spec cannot read, so the
 *    consuming half is guarded there (identity/tests/list-contract.test.js) against the same list.
 *
 * 2. THE MEANING of `expired`. The naive rule — expiry in the past — is wrong and would be worse
 *    than the dead flag it replaces: getValidAccessToken renews silently whenever a refresh token
 *    is stored, so a lapsed access token on a refreshable grant is the ordinary steady state (a
 *    Google access token lives one hour). On the deployment where this was found, 9 of 24
 *    connections had a past expiry and ALL NINE were refreshable and healthy. A connection needs
 *    re-consent only when its authorization has lapsed and nothing can renew it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial BUG-13 guard: per-connection key-set contract on both the provider entries and the any-llm entry, isConnectionExpired semantics (refreshable / unrefreshable / no-expiry / boundary), the end-to-end derivation through buildConnectorListResponse, and a no-token-material assertion on the whole response.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';

import { buildConnectorListResponse } from '@/app/routes/connector-response-helpers';
import { isConnectionExpired, type ConnectionRow } from '@/app/routes/connector-tenancy';
import { ANY_LLM_PROVIDER } from '@/app/routes/byo-llm-routes';

/**
 * Every key a connection object in /api/connect/list promises its consumers, and who reads it.
 * Changing this list is a response-contract change: update the consumers in the same breath.
 */
const CONNECTION_KEYS = [
  'connectionId', // account selector — every surface, and every bot passing opts.connectionId
  'label',        // display name on the card
  'account',      // the account email shown under the label
  'tenantId',     // marks a household (shared) account
  'isDefault',    // the ★ marker and the default-account resolution
  'expired',      // Identity Hub: Need attention tile, needs-attention filter, Reconnect pill, · expired
] as const;

const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-12T12:00:00.000Z');

/** A connection row with only the fields under test varied. */
function connection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
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
    access_token: 'encrypted-access-never-returned',
    refresh_token: 'encrypted-refresh-never-returned',
    expiry: new Date(NOW + HOUR),
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('connector list — per-connection contract', () => {
  it('carries every key consumers read, on a provider entry', () => {
    const google = buildConnectorListResponse([connection()])
      .find((entry) => entry.id === 'google') as { connections: Array<Record<string, unknown>> };

    expect(Object.keys(google.connections[0]).sort()).toEqual([...CONNECTION_KEYS].sort());
  });

  it('carries the same keys on the any-llm entry, so no entry in the collection is a special case', () => {
    const rows = [connection({ provider: ANY_LLM_PROVIDER, connection_id: 'connection-byo' })];
    const anyLlm = buildConnectorListResponse(rows)
      .find((entry) => entry.id === ANY_LLM_PROVIDER) as { connections: Array<Record<string, unknown>> };

    // The BYO entry carries extra endpoint fields (baseUrl, model); what matters is that no key
    // the consumers read is MISSING from it.
    const keys = Object.keys(anyLlm.connections[0]);
    for (const key of CONNECTION_KEYS) expect(keys).toContain(key);
  });

  it('never returns token material in the response', () => {
    const serialized = JSON.stringify(buildConnectorListResponse([connection({ expiry: new Date(NOW - HOUR) })]));
    expect(serialized).not.toContain('encrypted-access-never-returned');
    expect(serialized).not.toContain('encrypted-refresh-never-returned');
  });
});

describe('isConnectionExpired — a lapsed grant, not a lapsed access token', () => {
  it('is false for a lapsed access token that still holds a refresh token', () => {
    // The 9-of-24 case on the live deployment. getValidAccessToken renews this silently; calling
    // it expired would flag healthy accounts and make "Need attention" wrong in the loud direction.
    expect(isConnectionExpired({ expiry: new Date(NOW - HOUR), refresh_token: 'enc' }, NOW)).toBe(false);
  });

  it('is true only when the authorization has lapsed and nothing can renew it', () => {
    expect(isConnectionExpired({ expiry: new Date(NOW - HOUR), refresh_token: null }, NOW)).toBe(true);
  });

  it('is false for a connection whose provider issues no expiry (pasted PATs, Slack, Plaid)', () => {
    expect(isConnectionExpired({ expiry: null, refresh_token: null }, NOW)).toBe(false);
  });

  it('is false while an unrefreshable authorization is still valid', () => {
    expect(isConnectionExpired({ expiry: new Date(NOW + HOUR), refresh_token: null }, NOW)).toBe(false);
  });

  it('treats the expiry instant itself as lapsed, and an unparseable expiry as not lapsed', () => {
    expect(isConnectionExpired({ expiry: new Date(NOW), refresh_token: null }, NOW)).toBe(true);
    expect(isConnectionExpired({ expiry: new Date('not-a-date'), refresh_token: null }, NOW)).toBe(false);
  });

  it('derives the flag end-to-end through the list projection', () => {
    const entries = buildConnectorListResponse([
      connection({ connection_id: 'refreshable', expiry: new Date(Date.now() - HOUR), refresh_token: 'enc' }),
      connection({ connection_id: 'lapsed', account_key: 'other@example.com', expiry: new Date(Date.now() - HOUR), refresh_token: null }),
    ]);
    const google = entries.find((entry) => entry.id === 'google') as {
      connections: Array<{ connectionId: string; expired: boolean }>;
    };
    const byId = new Map(google.connections.map((c) => [c.connectionId, c.expired]));

    expect(byId.get('refreshable')).toBe(false);
    expect(byId.get('lapsed')).toBe(true);
  });
});
