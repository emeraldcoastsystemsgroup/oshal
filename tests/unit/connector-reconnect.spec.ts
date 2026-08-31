/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Reconnect-in-place guard (the "dead connection forces delete + re-add" fix). Over a real express app with a fake pool: /start?reconnect=<id> pins login_hint to the STORED account_email (not the session email), does NOT force the ADR-113 account chooser (Google's def prompt=consent survives — the exact param that re-issues a dead refresh token; `select_account` reappearing goes red), carries the STORED label through the signed state (the upsert's label refresh would otherwise rename the account to its email mid-repair), and 404s for a connection id outside the caller's accessible rows. A plain /start with an existing connection must STILL force the chooser, so the repair path cannot regress multi-account (ADR-113 section 4).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
// The hub facade registers the Plaid Link + RingCentral SSE sub-surfaces at creation; neither is
// under test here, so both are inert stubs (isPlaidConfigured is read by the /list projection).
vi.mock('@/app/routes/connector-plaid-link', () => ({ registerPlaidLinkRoutes: () => {}, isPlaidConfigured: () => false }));
vi.mock('@/app/routes/ringcentral-screen-pop', () => ({ registerRingcentralScreenPop: () => {} }));

import { createConnectorsRoutes } from '@/app/routes/connectors-routes';
import { verifyState } from '@/app/routes/connector-oauth-ceremony';
import type { ConnectionRow } from '@/app/routes/connector-tenancy';

const SUB = 'auth0|reconnect-user';
const STORED_EMAIL = 'work@example.com';
const SESSION_EMAIL = 'session@example.com';

/** The caller's one google connection — a dead grant (no refresh token, lapsed expiry). */
function googleRow(over: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    connection_id: 'conn-google-work', user_sub: SUB, connected_by_sub: null, tenant_id: null,
    provider: 'google', label: 'work email', account_key: 'acct-work', is_default: true,
    account_email: STORED_EMAIL, account_id: 'acct-work', scopes: 'openid', access_token: 'enc',
    refresh_token: null, expiry: new Date(Date.now() - 3_600_000), created_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

/** A pool that serves the caller's connection rows and answers everything else emptily. */
function poolWithConnections(rows: ConnectionRow[]) {
  return {
    query: async (sql: string) => {
      if (/FROM oshal_tenant_memberships/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM oshal_connections/i.test(sql)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  };
}

let server: Server | undefined;
async function start(rows: ConnectionRow[]): Promise<string> {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { oidc: unknown }).oidc = {
      isAuthenticated: () => true,
      user: { sub: SUB, email: SESSION_EMAIL },
    };
    next();
  });
  app.use('/api/connect', createConnectorsRoutes({ pool: poolWithConnections(rows) } as never));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const addr = server!.address();
  if (!addr || typeof addr === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${addr.port}`;
}

beforeAll(() => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'connector-reconnect-guard-secret';
  process.env.APP_URL = process.env.APP_URL || 'http://localhost:35457';
  // The google connector reuses the login client by default — a configured pair is all /start needs.
  process.env.OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || 'test-google-client';
  process.env.OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || 'test-google-secret';
});
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => { server = undefined; resolve(); }) : resolve())));

describe('reconnect-in-place repairs a dead connection without delete + re-add', () => {
  it('pins login_hint to the STORED account and keeps prompt=consent (no account chooser)', async () => {
    const base = await start([googleRow()]);
    const res = await fetch(`${base}/api/connect/google/start?reconnect=conn-google-work`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') || '');
    // The provider must re-auth the STORED login, not whichever account the browser holds.
    expect(loc.searchParams.get('login_hint')).toBe(STORED_EMAIL);
    // Google's own def params stand: prompt=consent is what re-issues the dead refresh token.
    // 'select_account' reappearing means the ADR-113 chooser leaked into the repair path.
    expect(loc.searchParams.get('prompt')).toBe('consent');
    expect(loc.searchParams.get('access_type')).toBe('offline');
  });

  it('carries the STORED label through the signed state so the repair cannot rename the account', async () => {
    const base = await start([googleRow()]);
    const res = await fetch(`${base}/api/connect/google/start?reconnect=conn-google-work`, { redirect: 'manual' });
    const loc = new URL(res.headers.get('location') || '');
    const state = verifyState(loc.searchParams.get('state') || '');
    expect(state).not.toBeNull();
    expect(state!.provider).toBe('google');
    expect(state!.sub).toBe(SUB);
    // Without this, the callback's upsert label refresh resets "work email" to the account email.
    expect(state!.label).toBe('work email');
  });

  it('404s for a connection id outside the caller-accessible rows — no redirect leaves the app', async () => {
    const base = await start([googleRow()]);
    const res = await fetch(`${base}/api/connect/google/start?reconnect=someone-elses-connection`, { redirect: 'manual' });
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  it('a plain /start with an existing connection STILL forces the account chooser (ADR-113 unbroken)', async () => {
    const base = await start([googleRow()]);
    const res = await fetch(`${base}/api/connect/google/start`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') || '');
    expect(loc.searchParams.get('prompt')).toBe('select_account consent');
    expect(loc.searchParams.get('login_hint')).toBe(SESSION_EMAIL);
  });
});
