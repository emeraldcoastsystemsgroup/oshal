/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The named guard for the LOCAL_AUTH critical path (ADR-117), exercised through a REAL express app against an in-memory pool: bootstrap-once (installer becomes the first admin, second attempt 409s), login with generic errors + per-email rate limiting, the one-time invite lifecycle (invite → info → accept → reuse 410), admin-gate matrix (anonymous 401 / non-operator 403 / operator + trusted-service 200), disable-kills-login, and the copyable-link fallback when SMTP is absent. If the login wall regresses open, this file goes red.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { createLocalAuthRoutes } from '@/app/routes/local-auth-routes';

// ── In-memory stand-in for the oshal_local_users table ───────────────────────
type Row = Record<string, unknown>;

function fakePool() {
  const rows: Row[] = [];
  const byEmail = (email: unknown) => rows.find((r) => r.email === email);
  return {
    rows,
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
      if (sql.includes('ON CONFLICT (email)')) {
        const [id, email, displayName, userSub, tokenHash, expiresAt, invitedBy] = params;
        const existing = byEmail(email);
        if (existing) {
          if (existing.status === 'disabled') return { rows: [] };
          existing.invite_token_hash = tokenHash;
          existing.invite_expires_at = expiresAt;
          existing.display_name = displayName ?? existing.display_name;
          return { rows: [existing] };
        }
        const row: Row = {
          id, email, display_name: displayName, user_sub: userSub, password_hash: null,
          status: 'invited', token_version: 1, invite_token_hash: tokenHash,
          invite_expires_at: expiresAt, invited_by_sub: invitedBy,
          created_at: new Date(), activated_at: null, last_login_at: null,
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (sql.includes('WHERE NOT EXISTS')) {
        if (rows.length > 0) return { rows: [] };
        const [id, email, displayName, userSub, passwordHash] = params;
        const row: Row = {
          id, email, display_name: displayName, user_sub: userSub, password_hash: passwordHash,
          status: 'active', token_version: 1, invite_token_hash: null, invite_expires_at: null,
          invited_by_sub: null, created_at: new Date(), activated_at: new Date(), last_login_at: null,
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (sql.includes('password_hash = $2')) {
        const [tokenHash, passwordHash] = params;
        const row = rows.find((r) => r.invite_token_hash === tokenHash && r.status !== 'disabled'
          && r.invite_expires_at && (r.invite_expires_at as Date).getTime() > Date.now());
        if (!row) return { rows: [] };
        row.password_hash = passwordHash;
        row.status = 'active';
        row.token_version = (row.token_version as number) + 1;
        row.invite_token_hash = null;
        row.invite_expires_at = null;
        row.activated_at = row.activated_at ?? new Date();
        return { rows: [row] };
      }
      if (sql.includes('SET last_login_at')) return { rows: [] };
      if (sql.includes('SET status = $2')) {
        const [id, status] = params;
        const row = rows.find((r) => r.id === id);
        if (!row) return { rows: [] };
        row.status = status;
        row.token_version = (row.token_version as number) + 1;
        return { rows: [row] };
      }
      if (sql.includes('SELECT status, token_version')) {
        const row = rows.find((r) => r.user_sub === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('WHERE invite_token_hash')) {
        const row = rows.find((r) => r.invite_token_hash === params[0] && r.status !== 'disabled'
          && r.invite_expires_at && (r.invite_expires_at as Date).getTime() > Date.now());
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('WHERE email =')) {
        const row = byEmail(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('WHERE id =')) {
        const row = rows.find((r) => r.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('SELECT 1 FROM oshal_local_users')) {
        return { rows: rows.length ? [{ one: 1 }] : [] };
      }
      if (sql.includes('ORDER BY created_at')) return { rows: [...rows] };
      // This fake models ONE table. The invite flow's Gmail rail legitimately queries the
      // connector store (and its tenancy helpers) looking for a sending account; answer
      // "nothing here" so the fallback exercises its real no-connection path instead of
      // surfacing a stub error as the admin-facing detail. Unknown queries against the
      // table we DO model still throw — that is what caught the earlier column mismatch.
      if (!sql.includes('oshal_local_users')) return { rows: [] };
      throw new Error(`fake pool has no handler for: ${sql.slice(0, 80)}`);
    },
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────
const SVC_SECRET = 'example-service-secret-0000';
let saved: Record<string, string | undefined>;
const ENV_KEYS = ['SESSION_SECRET', 'SWARM_SERVICE_SECRET', 'OSHAL_OPERATOR_EMAILS', 'OSHAL_OPERATOR_SUBS', 'SMTP_HOST', 'LOCAL_AUTH', 'APP_URL', 'LOCAL_AUTH_PUBLIC_URL'];

let pool: ReturnType<typeof fakePool>;
let server: Server;
let base: string;

function startApp(authAs?: { sub: string; email: string }): Promise<void> {
  const app = express();
  app.use(express.json());
  if (authAs) {
    app.use((req, _res, next) => {
      (req as { oidc?: unknown }).oidc = { isAuthenticated: () => true, user: authAs };
      next();
    });
  }
  app.use(createLocalAuthRoutes(pool as never));
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

async function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null), setCookie: res.headers.get('set-cookie') };
}

beforeAll(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SESSION_SECRET = 'example-session-secret-0000';
  process.env.SWARM_SERVICE_SECRET = SVC_SECRET;
  delete process.env.OSHAL_OPERATOR_EMAILS;
  delete process.env.SMTP_HOST; // force the copyable-link fallback
  delete process.env.OSHAL_OPERATOR_SUBS; // and no connector sending identity
  // A public URL is required before EITHER mail rail is attempted: an emailed invite
  // needs an absolute link. Without it the admin screen still shows a copyable path
  // (the browser knows its own origin), which is what the assertions below check.
  process.env.APP_URL = 'https://box.example.com';
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

// ── The flows ────────────────────────────────────────────────────────────────

describe('local-auth bootstrap (the installer is the first admin)', () => {
  it('offers bootstrap only while the store is empty, creates once, then refuses', async () => {
    pool = fakePool();
    await startApp();

    let state = await (await fetch(`${base}/api/local-auth/state`)).json();
    expect(state.bootstrapRequired).toBe(true);

    const created = await post('/api/local-auth/bootstrap', {
      email: 'Installer@Example.com', name: 'The Installer', password: 'example-first-admin-pw-00',
    });
    expect(created.status).toBe(201);
    expect(created.data.sub).toMatch(/^local-[0-9a-f]{16}$/);
    expect(created.setCookie).toContain('oshal_local=');

    state = await (await fetch(`${base}/api/local-auth/state`)).json();
    expect(state.bootstrapRequired).toBe(false);

    const again = await post('/api/local-auth/bootstrap', {
      email: 'second@example.com', password: 'example-other-pw-000001',
    });
    expect(again.status).toBe(409);
  });
});

describe('local-auth login', () => {
  it('answers every failure with one generic message and sanitizes returnTo', async () => {
    pool = fakePool();
    await startApp();
    await post('/api/local-auth/bootstrap', { email: 'admin@example.com', password: 'example-admin-pw-000001' });

    const wrongPw = await post('/api/local-auth/login', { email: 'admin@example.com', password: 'nope-nope-nope' });
    const unknown = await post('/api/local-auth/login', { email: 'ghost@example.com', password: 'nope-nope-nope' });
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPw.data.error).toBe(unknown.data.error); // no account enumeration

    const ok = await post('/api/local-auth/login', {
      email: 'admin@example.com', password: 'example-admin-pw-000001', returnTo: '//evil.example.com/',
    });
    expect(ok.status).toBe(200);
    expect(ok.data.returnTo).toBe('/'); // protocol-relative escape rejected
    expect(ok.setCookie).toContain('oshal_local=');
    expect(ok.setCookie).toContain('HttpOnly');
  });

  it('rate-limits after repeated failures for the same email', async () => {
    pool = fakePool();
    await startApp();
    await post('/api/local-auth/bootstrap', { email: 'ratelimit@example.com', password: 'example-admin-pw-000001' });
    for (let i = 0; i < 10; i += 1) {
      const fail = await post('/api/local-auth/login', { email: 'ratelimit@example.com', password: 'wrong-password' });
      expect(fail.status).toBe(401);
    }
    const blocked = await post('/api/local-auth/login', { email: 'ratelimit@example.com', password: 'wrong-password' });
    expect(blocked.status).toBe(429);
  });
});

describe('local-auth admin gates', () => {
  it('rejects anonymous (401) and authenticated non-operator (403) callers', async () => {
    pool = fakePool();
    await startApp();
    expect((await fetch(`${base}/api/local-auth/users`)).status).toBe(401);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await startApp({ sub: 'local-aaaaaaaaaaaaaaaa', email: 'not-an-operator@example.com' });
    expect((await fetch(`${base}/api/local-auth/users`)).status).toBe(403);
  });

  it('admits a trusted service call and an operator session', async () => {
    pool = fakePool();
    await startApp();
    const viaService = await fetch(`${base}/api/local-auth/users`, { headers: { 'X-Service-Secret': SVC_SECRET } });
    expect(viaService.status).toBe(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    process.env.OSHAL_OPERATOR_EMAILS = 'boss@example.com';
    await startApp({ sub: 'local-bbbbbbbbbbbbbbbb', email: 'boss@example.com' });
    expect((await fetch(`${base}/api/local-auth/users`)).status).toBe(200);
    delete process.env.OSHAL_OPERATOR_EMAILS;
  });
});

describe('local-auth invite lifecycle', () => {
  it('invite → info → accept → single-use → login; disable kills login; reinvite restores', async () => {
    pool = fakePool();
    await startApp();
    const svc = { 'X-Service-Secret': SVC_SECRET };

    // Invite (no SMTP → copyable link with an honest detail)
    const invited = await post('/api/local-auth/users', { email: 'bdo@example.com', name: 'A BDO' }, svc);
    expect(invited.status).toBe(201);
    expect(invited.data.emailSent).toBe(false);
    expect(String(invited.data.emailDetail)).toMatch(/copy the invite link/i);
    expect(invited.data.invitePath).toMatch(/^\/invite\?token=oshal_inv_[0-9a-f]{48}$/);
    const token = decodeURIComponent(String(invited.data.invitePath).split('token=')[1]);

    // Info leg shows whose invitation it is
    const info = await (await fetch(`${base}/api/local-auth/invite-info?token=${encodeURIComponent(token)}`)).json();
    expect(info.email).toBe('bdo@example.com');

    // Weak password refused, good password accepted, token spent
    expect((await post('/api/local-auth/accept', { token, password: 'short' })).status).toBe(400);
    const accepted = await post('/api/local-auth/accept', { token, password: 'example-chosen-pw-000001' });
    expect(accepted.status).toBe(200);
    expect(accepted.setCookie).toContain('oshal_local=');
    expect((await post('/api/local-auth/accept', { token, password: 'example-chosen-pw-000001' })).status).toBe(410);

    // The new credential works
    const login = await post('/api/local-auth/login', { email: 'bdo@example.com', password: 'example-chosen-pw-000001' });
    expect(login.status).toBe(200);

    // Disable ends sign-in; enable + reinvite mints a fresh one-time link
    const userId = String(pool.rows.find((r) => r.email === 'bdo@example.com')!.id);
    expect((await post(`/api/local-auth/users/${userId}/disable`, {}, svc)).status).toBe(200);
    expect((await post('/api/local-auth/login', { email: 'bdo@example.com', password: 'example-chosen-pw-000001' })).status).toBe(401);
    expect((await post(`/api/local-auth/users/${userId}/enable`, {}, svc)).status).toBe(200);
    const reinvited = await post(`/api/local-auth/users/${userId}/reinvite`, {}, svc);
    expect(reinvited.status).toBe(200);
    expect(reinvited.data.invitePath).toMatch(/oshal_inv_/);
  });
});

describe('local-auth invite delivery rails', () => {
  it('falls back to the Gmail connector rail when SMTP is absent, and still returns the link when both fail', async () => {
    pool = fakePool();
    await startApp();
    const svc = { 'X-Service-Secret': SVC_SECRET };

    // No SMTP and no sending identity: the copyable link is still the answer, and the
    // detail names the actual reason rather than blaming SMTP alone.
    const noRails = await post('/api/local-auth/users', { email: 'norails@example.com' }, svc);
    expect(noRails.status).toBe(201);
    expect(noRails.data.emailSent).toBe(false);
    expect(noRails.data.invitePath).toMatch(/oshal_inv_/);
    expect(String(noRails.data.emailDetail)).toMatch(/copy the invite link/);

    // With a sending identity configured but no connected Google account, the failure
    // must point at the connector — the fix an operator actually needs.
    process.env.OSHAL_OPERATOR_SUBS = 'local-operator-sub';
    const noConnection = await post('/api/local-auth/users', { email: 'noconn@example.com' }, svc);
    expect(noConnection.data.emailSent).toBe(false);
    expect(String(noConnection.data.emailDetail)).toMatch(/Google|connect|SMTP_HOST/i);
    delete process.env.OSHAL_OPERATOR_SUBS;
  });
});

describe('local-auth pages', () => {
  it('serves the invite page and clears the session on logout', async () => {
    pool = fakePool();
    await startApp();
    const page = await fetch(`${base}/invite?token=whatever`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Set your password');

    const logout = await fetch(`${base}/logout`, { redirect: 'manual' });
    expect(logout.status).toBe(302);
    expect(logout.headers.get('location')).toBe('/login');
    expect(logout.headers.get('set-cookie')).toContain('oshal_local=;');
  });
});
