/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | INSTALLER-GAPS G14 guard: reconnect-message-distinct-from-transport-missing. Over a real express app (connector token broker + Gmail send mocked — no live calls): when the Gmail rail fails because the stored grant is DEAD (getValidAccessToken throws `refresh 400` — the Testing-mode Google reauth policy), the admin-facing emailDetail says the Google connection needs to be RECONNECTED and names the Connections screen; when the rail fails because NO account is connected, the detail is the generic connect/SMTP one; and the two messages are provably different — collapse them back into one generic banner and this goes red. sendGmail is asserted NEVER called in either failure.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

// Controllable stand-ins for the two transports the invite Gmail rail touches.
const rail = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'dead-grant',
  sendGmail: vi.fn(async () => undefined),
}));
vi.mock('@/app/routes/connectors-routes', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getValidAccessToken: async () => {
      if (rail.mode === 'dead-grant') throw new Error('refresh 400'); // Google rejected the stored grant
      return null; // no connection row at all
    },
  };
});
vi.mock('@/app/routes/email-routes', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, sendGmail: rail.sendGmail };
});

import { createLocalAuthRoutes } from '@/app/routes/local-auth-routes';

// ── Minimal in-memory pool: the invite upsert + benign answers elsewhere ─────
type Row = Record<string, unknown>;
function fakePool() {
  const rows: Row[] = [];
  return {
    rows,
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
      if (sql.includes('ON CONFLICT (email)')) {
        const [id, email, displayName, userSub, tokenHash, expiresAt, invitedBy] = params;
        const row: Row = {
          id, email, display_name: displayName, user_sub: userSub, password_hash: null,
          status: 'invited', token_version: 1, invite_token_hash: tokenHash,
          invite_expires_at: expiresAt, invited_by_sub: invitedBy,
          created_at: new Date(), activated_at: null, last_login_at: null,
        };
        rows.push(row);
        return { rows: [row] };
      }
      // Everything else (connector lookups, snapshots) answers empty — the mocked broker
      // above decides the rail outcome, not this table.
      return { rows: [] };
    },
  };
}

const SVC_SECRET = 'example-service-secret-0000';
const ENV_KEYS = ['SESSION_SECRET', 'SWARM_SERVICE_SECRET', 'SMTP_HOST', 'APP_URL', 'LOCAL_AUTH_PUBLIC_URL', 'OSHAL_OPERATOR_SUBS', 'OSHAL_OPERATOR_EMAILS'];
let saved: Record<string, string | undefined>;
let server: Server;
let base: string;

beforeAll(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SESSION_SECRET = 'example-session-secret-0000';
  process.env.SWARM_SERVICE_SECRET = SVC_SECRET;
  delete process.env.SMTP_HOST;                       // no SMTP → the Gmail connector rail decides
  process.env.APP_URL = 'https://box.example.com';    // absolute link → the mail rails ARE attempted
  process.env.OSHAL_OPERATOR_SUBS = 'auth0|operator'; // a sending identity exists
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function invite(email: string): Promise<{ status: number; data: { emailSent: boolean; emailDetail?: string } }> {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  const app = express();
  app.use(express.json());
  app.use(createLocalAuthRoutes(fakePool() as never));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const res = await fetch(`${base}/api/local-auth/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Secret': SVC_SECRET },
    body: JSON.stringify({ email }),
  });
  return { status: res.status, data: await res.json() };
}

describe('reconnect-message-distinct-from-transport-missing', () => {
  it('a DEAD grant (refresh 400) tells the admin to RECONNECT on the Connections screen', async () => {
    rail.mode = 'dead-grant';
    const res = await invite('employee-one@example.com');
    expect(res.status).toBe(201);
    expect(res.data.emailSent).toBe(false);
    expect(String(res.data.emailDetail)).toMatch(/reconnect/i);
    expect(String(res.data.emailDetail)).toMatch(/Connections screen/);
    // The dead-grant message must NOT read like "nothing is connected" — that sends the
    // admin to set up a connector they already have.
    expect(String(res.data.emailDetail)).not.toMatch(/no Google account is connected/i);
    expect(rail.sendGmail).not.toHaveBeenCalled();
  });

  it('NO connection at all gets the generic connect-or-SMTP transport message', async () => {
    rail.mode = 'none';
    const res = await invite('employee-two@example.com');
    expect(res.status).toBe(201);
    expect(res.data.emailSent).toBe(false);
    expect(String(res.data.emailDetail)).toMatch(/no Google account is connected/i);
    expect(String(res.data.emailDetail)).toMatch(/SMTP_HOST/);
    expect(String(res.data.emailDetail)).not.toMatch(/reconnected/i);
    expect(rail.sendGmail).not.toHaveBeenCalled();
  });

  it('the two failure messages are DISTINCT — collapsing them regresses G14', async () => {
    rail.mode = 'dead-grant';
    const dead = (await invite('employee-three@example.com')).data.emailDetail;
    rail.mode = 'none';
    const missing = (await invite('employee-four@example.com')).data.emailDetail;
    expect(dead).toBeTruthy();
    expect(missing).toBeTruthy();
    expect(dead).not.toBe(missing);
  });
});
