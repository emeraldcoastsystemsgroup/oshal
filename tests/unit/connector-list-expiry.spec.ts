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
 *    The same holds one level up, for the PROVIDER entry that carries those connections: the hub
 *    reads `configured` and `tokenFallback` off it to decide whether a card can be connected at
 *    all, and to count "Ready to enable". Those keys are pinned here for the same reason.
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
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin the PROVIDER-level keys too. The per-connection contract left the other half of what Identity Hub reads unguarded: `configured` drives its needs-attention filter and its Ready-to-enable tile, and `tokenFallback` decides whether a card offers "Set up" or "Not configured" - neither was asserted anywhere in this repo (only a Playwright spec touched `configured`, incidentally), so dropping either from the projection went green while a shipped surface silently read undefined. Same failure shape as BUG-13, one layer up.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Add 'expiring' to CONNECTION_KEYS and comprehensive boundary tests for isConnectionExpiring (outside window, inside window, boundary at exactly 14d, already lapsed at now, refreshable grant immunity, null/invalid expiry, and end-to-end derivation).
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from 'vitest';

import { buildConnectorListResponse } from '@/app/routes/connector-response-helpers';
import { isConnectionExpired, isConnectionExpiring, UNRENEWABLE_EXPIRING_WINDOW_MS, type ConnectionRow } from '@/app/routes/connector-tenancy';
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
  'expiring',     // Identity Hub: Expiring pill, · expiring marker, access review, Jarvis briefing
] as const;

/**
 * Every key a PROVIDER entry in /api/connect/list promises, and who reads it. A key deleted from
 * the projection renders as `undefined` on the surfaces below - falsy, never an error - so the
 * only thing that can catch it is an assertion here.
 */
const PROVIDER_KEYS = [
  'id',                  // the card's identity; /api/connect/<id>/start is built from it
  'label',               // the card heading
  'category',            // the hub's group headings and its icon map
  'auth',                // oauth | token | link | llm - which action the card offers
  'configured',          // Identity Hub: "Ready to enable" tile, needs-attention filter, and the
                         //   disabled "Not configured" button; core /utilities gates reconnect on it
  'tokenHelpUrl',        // where /utilities sends a user to mint a pasted token
  'tokenFallback',       // Identity Hub isTokenSetup(): an unregistered OAuth client that still
                         //   accepts a pasted token offers "Set up" instead of "Not configured"
  'platformDefault',     // a shared read-only catalog makes a personal connection optional
  'connected',           // the Connected tile, the connected/available filters, the pill
  'connections',         // the per-account rows (their own key contract is CONNECTION_KEYS)
  'multiAccount',        // more than one account for this provider
  'defaultConnectionId', // which account a bare request resolves to
  'status',              // connected | not_connected
] as const;

/**
 * The subset the Identity Hub surface (oshal-applications/identity/tools/identity.html) reads off
 * a provider entry. Held separately because the any-llm entry is shaped by a different builder and
 * carries fewer keys - what matters is that no key a shipped surface reads is missing from it.
 */
const SURFACE_PROVIDER_KEYS = [
  'id', 'label', 'category', 'auth', 'configured', 'tokenFallback', 'connected', 'connections',
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

describe('connector list - the provider-entry contract', () => {
  it('carries every provider key consumers read, and nothing they do not', () => {
    const google = buildConnectorListResponse([connection()])
      .find((entry) => entry.id === 'google') as Record<string, unknown>;

    expect(Object.keys(google).sort()).toEqual([...PROVIDER_KEYS].sort());
  });

  it('carries the keys the Identity Hub surface reads on the any-llm entry too', () => {
    const anyLlm = buildConnectorListResponse([])
      .find((entry) => entry.id === ANY_LLM_PROVIDER) as Record<string, unknown>;

    // The hub renders this card like any other, so a key it reads must not be missing here either.
    for (const key of SURFACE_PROVIDER_KEYS) expect(Object.keys(anyLlm)).toContain(key);
  });

  it('reports configured and tokenFallback as the booleans the surfaces branch on', () => {
    // Deliberately env-independent providers: a token-auth connector is configured by the user's
    // pasted token (never by platform OAuth creds), and allowTokenFallback is a static registry
    // fact. A projection that emitted either as undefined would read as "not configured / no
    // fallback" - the hub would show a permanently disabled "Not configured" button on a
    // connector the user can set up right now.
    const entries = buildConnectorListResponse([]);
    const jira = entries.find((entry) => entry.id === 'jira') as Record<string, unknown>;
    const smartthings = entries.find((entry) => entry.id === 'smartthings') as Record<string, unknown>;

    expect(jira.auth).toBe('token');
    expect(jira.configured).toBe(true);
    expect(jira.tokenFallback).toBe(false);
    // SmartThings: OAuth connector that accepts a pasted PAT until the partner app is registered.
    expect(smartthings.tokenFallback).toBe(true);
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

describe('isConnectionExpiring — warning before an unrenewable connection lapses', () => {
  const DAY = 24 * HOUR;
  const FOURTEEN_DAYS = 14 * DAY;

  it('exposes UNRENEWABLE_EXPIRING_WINDOW_MS as exactly 14 days', () => {
    expect(UNRENEWABLE_EXPIRING_WINDOW_MS).toBe(FOURTEEN_DAYS);
  });

  it('is false when expiry is outside the 14-day window', () => {
    expect(isConnectionExpiring({ expiry: new Date(NOW + FOURTEEN_DAYS + HOUR), refresh_token: null }, NOW)).toBe(false);
  });

  it('is true when expiry is within the 14-day window and has no refresh token', () => {
    expect(isConnectionExpiring({ expiry: new Date(NOW + 7 * DAY), refresh_token: null }, NOW)).toBe(true);
  });

  it('is true at the exact boundary of the 14-day window', () => {
    expect(isConnectionExpiring({ expiry: new Date(NOW + FOURTEEN_DAYS), refresh_token: null }, NOW)).toBe(true);
  });

  it('is false once already lapsed (it is expired, not expiring)', () => {
    expect(isConnectionExpiring({ expiry: new Date(NOW), refresh_token: null }, NOW)).toBe(false);
    expect(isConnectionExpiring({ expiry: new Date(NOW - HOUR), refresh_token: null }, NOW)).toBe(false);
  });

  it('is false for a refreshable connection even within the 14-day window', () => {
    // Refreshable grants renew themselves silently; alerting the user would be a loud false positive.
    expect(isConnectionExpiring({ expiry: new Date(NOW + 2 * DAY), refresh_token: 'enc' }, NOW)).toBe(false);
  });

  it('is false for a connection with no expiry or an unparseable expiry', () => {
    expect(isConnectionExpiring({ expiry: null, refresh_token: null }, NOW)).toBe(false);
    expect(isConnectionExpiring({ expiry: new Date('invalid-date'), refresh_token: null }, NOW)).toBe(false);
  });

  it('derives the expiring flag end-to-end through the list projection', () => {
    const entries = buildConnectorListResponse([
      connection({ connection_id: 'expiring-conn', account_key: 'expiring@example.com', expiry: new Date(Date.now() + 5 * DAY), refresh_token: null }),
      connection({ connection_id: 'safe-future', account_key: 'future@example.com', expiry: new Date(Date.now() + 30 * DAY), refresh_token: null }),
      connection({ connection_id: 'lapsed-conn', account_key: 'lapsed@example.com', expiry: new Date(Date.now() - HOUR), refresh_token: null }),
      connection({ connection_id: 'refreshable-conn', account_key: 'refresh@example.com', expiry: new Date(Date.now() + 2 * DAY), refresh_token: 'enc' }),
    ]);
    const google = entries.find((entry) => entry.id === 'google') as {
      connections: Array<{ connectionId: string; expired: boolean; expiring: boolean }>;
    };
    const byId = new Map(google.connections.map((c) => [c.connectionId, { expired: c.expired, expiring: c.expiring }]));

    expect(byId.get('expiring-conn')).toEqual({ expired: false, expiring: true });
    expect(byId.get('safe-future')).toEqual({ expired: false, expiring: false });
    expect(byId.get('lapsed-conn')).toEqual({ expired: true, expiring: false });
    expect(byId.get('refreshable-conn')).toEqual({ expired: false, expiring: false });
  });
});

