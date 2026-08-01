/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ADR-117 self-service password reset (BACKLOG done-when), driven through the REAL router: (1) ENUMERATION SAFETY — known-active, unknown, and disabled addresses get byte-identical responses, an unknown address mints NO account and NO token, and the response returns while delivery is still pending (a hanging mail transport cannot become a timing oracle); (2) the full reset flow — /forgot mints a one-time link (captured from the mocked SMTP rail), /accept sets the new password, the old one dies, the new one signs in; (3) a reset NEVER strips the second factor — a TOTP-enabled account still gets secondFactor:'required' after the reset and signs in only with a code; (4) per-IP rate limiting answers 429 over the cap, and the per-EMAIL cap silently stops token rotation with an identical 200; (5) a pending admin INVITE is not stomped by a forgot request (the reset only touches active accounts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

// Mock the SMTP rail so the spec can (a) capture the reset link and (b) prove the
// response never waits on delivery. Declared before the routes import (vitest hoists).
const smtp = vi.hoisted(() => ({
  sends: [] as Array<{ to: string; subject: string; text: string }>,
  gate: null as null | { resolve: () => void; promise: Promise<{ ok: boolean }> },
  configured: true,
}));
vi.mock('@/features/notifications', () => ({
  smtpConfigured: () => smtp.configured,
  sendTransactionalMail: async (mail: { to: string; subject: string; text: string }) => {
    smtp.sends.push(mail);
    if (smtp.gate) return smtp.gate.promise;
    return { ok: true };
  },
}));

import { createLocalAuthRoutes } from '@/app/routes/local-auth-routes';
import { base32Decode, currentStep, totpCodeForStep } from '@/features/local-auth';

// ── In-memory stand-in for oshal_local_users (the local-auth-routes.spec.ts fake,
//    extended with the reset UPDATE the forgot flow issues) ────────────────────
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
      // The forgot flow's reset mint: active accounts only, by email.
      if (sql.includes('SET invite_token_hash = $2')) {
        const [email, tokenHash, expiresAt] = params;
        const row = byEmail(email);
        if (!row || row.status !== 'active') return { rows: [] };
        row.invite_token_hash = tokenHash;
        row.invite_expires_at = expiresAt;
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
      if (sql.includes('totp_enabled, totp_required')) {
        const row = rows.find((r) => r.user_sub === params[0]);
        return {
          rows: row ? [{
            totp_enabled: row.totp_enabled === true,
            totp_required: row.totp_required === true,
            totp_confirmed_at: row.totp_confirmed_at ?? null,
            totp_recovery_hashes: row.totp_recovery_hashes ?? [],
          }] : [],
        };
      }
      if (sql.includes('totp_secret_enc, totp_last_step')) {
        const row = rows.find((r) => r.user_sub === params[0]);
        return {
          rows: row ? [{
            totp_secret_enc: row.totp_secret_enc ?? null,
            totp_last_step: row.totp_last_step ?? null,
            totp_recovery_hashes: row.totp_recovery_hashes ?? [],
          }] : [],
        };
      }
      if (sql.includes('SELECT totp_secret_enc FROM')) {
        const row = rows.find((r) => r.user_sub === params[0]);
        return { rows: row ? [{ totp_secret_enc: row.totp_secret_enc ?? null }] : [] };
      }
      if (sql.includes('UPDATE oshal_local_users') && sql.includes('totp_')) {
        const row = rows.find((r) => r.user_sub === params[0]);
        if (row) {
          if (sql.includes('totp_secret_enc = $2')) {
            row.totp_secret_enc = params[1];
            row.totp_enabled = false;
            row.totp_confirmed_at = null;
            row.totp_last_step = null;
            row.totp_recovery_hashes = JSON.parse(String(params[2]));
          } else if (sql.includes('totp_enabled = TRUE')) {
            row.totp_enabled = true;
            row.totp_confirmed_at = new Date();
            row.totp_last_step = params[1];
          } else if (sql.includes('totp_secret_enc = NULL')) {
            row.totp_secret_enc = null;
            row.totp_enabled = false;
            row.totp_confirmed_at = null;
            row.totp_last_step = null;
            row.totp_recovery_hashes = [];
          } else if (sql.includes('totp_required = $2')) {
            row.totp_required = params[1] === true;
          } else if (sql.includes('totp_last_step = $2')) {
            row.totp_last_step = params[1];
          } else if (sql.includes('totp_recovery_hashes = $2')) {
            row.totp_recovery_hashes = JSON.parse(String(params[1]));
          }
        }
        return { rows: [] };
      }
      if (sql.includes('ORDER BY created_at')) return { rows: [...rows] };
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
// Distinct per-test client IPs (via trust proxy + X-Forwarded-For) so the module-level
// per-IP limiter never bleeds between cases; the rate-limit case picks its own IP.
let clientIp = '10.0.0.1';

function startApp(authAs?: { sub: string; email: string }): Promise<void> {
  const app = express();
  app.set('trust proxy', true); // req.ip honors X-Forwarded-For — per-test caller identities
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
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null), setCookie: res.headers.get('set-cookie') };
}

/** The reset token most recently mailed to `to`, pulled off the captured SMTP rail. */
function mailedTokenFor(to: string): string {
  const mail = [...smtp.sends].reverse().find((m) => m.to === to);
  expect(mail, `no reset mail captured for ${to}`).toBeTruthy();
  const match = /oshal_inv_[0-9a-f]{48}/.exec(mail!.text);
  expect(match, 'reset mail carries no one-time link token').toBeTruthy();
  return match![0];
}

beforeAll(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SESSION_SECRET = 'example-session-secret-0000';
  process.env.SWARM_SERVICE_SECRET = SVC_SECRET;
  process.env.APP_URL = 'https://box.example.com'; // delivery needs an absolute link
  delete process.env.OSHAL_OPERATOR_EMAILS;
  delete process.env.OSHAL_OPERATOR_SUBS;
  delete process.env.SMTP_HOST; // transport is the vi.mock above, not env-detected
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterEach(() => {
  smtp.sends.length = 0;
  smtp.gate = null;
  smtp.configured = true;
  return new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

// ── The cases ────────────────────────────────────────────────────────────────

describe('forgot-password is enumeration-safe', () => {
  it('known-active, unknown, and disabled addresses get byte-identical responses; unknown mints nothing', async () => {
    clientIp = '10.1.0.1';
    pool = fakePool();
    await startApp();
    const svc = { 'X-Service-Secret': SVC_SECRET };
    await post('/api/local-auth/bootstrap', { email: 'admin@example.com', password: 'example-admin-pw-000001' });

    // A disabled account too — a reset must not resurrect it.
    const invited = await post('/api/local-auth/users', { email: 'gone@example.com' }, svc);
    const inviteToken = decodeURIComponent(String(invited.data.invitePath).split('token=')[1]);
    await post('/api/local-auth/accept', { token: inviteToken, password: 'example-chosen-pw-000009' });
    const goneId = String(pool.rows.find((r) => r.email === 'gone@example.com')!.id);
    await post(`/api/local-auth/users/${goneId}/disable`, {}, svc);
    smtp.sends.length = 0;

    const rowsBefore = pool.rows.length;
    const known = await post('/api/local-auth/forgot', { email: 'admin@example.com' });
    const unknown = await post('/api/local-auth/forgot', { email: 'ghost@example.com' });
    const disabled = await post('/api/local-auth/forgot', { email: 'gone@example.com' });

    // Byte-identical answers — no existence signal in status or body.
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(disabled.status).toBe(200);
    expect(unknown.data).toEqual(known.data);
    expect(disabled.data).toEqual(known.data);

    // Unknown mints NO account and NO token; disabled gains no live link.
    expect(pool.rows.length).toBe(rowsBefore);
    expect(pool.rows.find((r) => r.email === 'ghost@example.com')).toBeUndefined();
    expect(pool.rows.find((r) => r.email === 'gone@example.com')!.invite_token_hash).toBeNull();
    // ...while the active account did get one (the flow works — see the flow case).
    expect(pool.rows.find((r) => r.email === 'admin@example.com')!.invite_token_hash).toBeTruthy();
  });

  it('a pending admin INVITE is not stomped by a forgot request', async () => {
    clientIp = '10.1.0.2';
    pool = fakePool();
    await startApp();
    const svc = { 'X-Service-Secret': SVC_SECRET };
    await post('/api/local-auth/bootstrap', { email: 'admin2@example.com', password: 'example-admin-pw-000001' });
    await post('/api/local-auth/users', { email: 'newhire@example.com' }, svc);
    const before = pool.rows.find((r) => r.email === 'newhire@example.com')!.invite_token_hash;

    const res = await post('/api/local-auth/forgot', { email: 'newhire@example.com' });
    expect(res.status).toBe(200); // identical answer...
    expect(pool.rows.find((r) => r.email === 'newhire@example.com')!.invite_token_hash).toBe(before); // ...no stomp
  });

  it('the response returns while delivery is still pending — mail latency is not a timing oracle', async () => {
    clientIp = '10.1.0.3';
    pool = fakePool();
    await startApp();
    await post('/api/local-auth/bootstrap', { email: 'slow@example.com', password: 'example-admin-pw-000001' });

    let release!: () => void;
    smtp.gate = {
      resolve: () => release(),
      promise: new Promise((r) => { release = () => r({ ok: true }); }),
    };
    // With the transport HUNG, the response must still arrive.
    const res = await post('/api/local-auth/forgot', { email: 'slow@example.com' });
    expect(res.status).toBe(200);
    expect(smtp.sends.length).toBe(1); // delivery started…
    smtp.gate.resolve();               // …and only now completes
  });
});

describe('the reset flow end to end', () => {
  it('mints a one-time link, the new password signs in, the old one dies, and the link is single-use', async () => {
    clientIp = '10.2.0.1';
    pool = fakePool();
    await startApp();
    const email = 'resetme@example.com';
    const svc = { 'X-Service-Secret': SVC_SECRET };
    await post('/api/local-auth/bootstrap', { email: 'admin3@example.com', password: 'example-admin-pw-000001' });
    const invited = await post('/api/local-auth/users', { email }, svc);
    const inviteToken = decodeURIComponent(String(invited.data.invitePath).split('token=')[1]);
    await post('/api/local-auth/accept', { token: inviteToken, password: 'example-old-pw-0000001' });
    smtp.sends.length = 0;

    expect((await post('/api/local-auth/forgot', { email })).status).toBe(200);
    const token = mailedTokenFor(email);
    // The response itself never carries the token — only the mail does.
    expect(token.startsWith('oshal_inv_')).toBe(true);

    const accepted = await post('/api/local-auth/accept', { token, password: 'example-new-pw-0000001' });
    expect(accepted.status).toBe(200);
    // Old credential dead, new one live, link spent.
    expect((await post('/api/local-auth/login', { email, password: 'example-old-pw-0000001' })).status).toBe(401);
    expect((await post('/api/local-auth/login', { email, password: 'example-new-pw-0000001' })).status).toBe(200);
    expect((await post('/api/local-auth/accept', { token, password: 'example-other-pw-000001' })).status).toBe(410);
  });

  it('a reset does NOT strip the second factor: the new password still needs the code', async () => {
    clientIp = '10.2.0.2';
    pool = fakePool();
    await startApp();
    const email = 'twofactor@example.com';
    const svc = { 'X-Service-Secret': SVC_SECRET };
    await post('/api/local-auth/bootstrap', { email: 'admin4@example.com', password: 'example-admin-pw-000001' });
    const invited = await post('/api/local-auth/users', { email }, svc);
    const inviteToken = decodeURIComponent(String(invited.data.invitePath).split('token=')[1]);
    await post('/api/local-auth/accept', { token: inviteToken, password: 'example-old-pw-0000002' });
    const sub = String(pool.rows.find((r) => r.email === email)!.user_sub);

    // Enrol TOTP as the user through the real endpoints.
    server.close();
    await startApp({ sub, email });
    const setup = await post('/api/local-auth/2fa/setup', {});
    const secret = String(setup.data.secret).replace(/\s+/g, '');
    const confirm = await post('/api/local-auth/2fa/confirm', { code: totpCodeForStep(base32Decode(secret), currentStep(Date.now())) });
    expect(confirm.status).toBe(200);
    smtp.sends.length = 0;

    // Reset the password via the unauthenticated flow.
    server.close();
    await startApp();
    expect((await post('/api/local-auth/forgot', { email })).status).toBe(200);
    const token = mailedTokenFor(email);
    expect((await post('/api/local-auth/accept', { token, password: 'example-new-pw-0000002' })).status).toBe(200);

    // The factor SURVIVED: password alone is not enough…
    const step1 = await post('/api/local-auth/login', { email, password: 'example-new-pw-0000002' });
    expect(step1.status).toBe(200);
    expect(step1.data.ok).toBe(false);
    expect(step1.data.secondFactor).toBe('required');
    expect(step1.setCookie).toBeNull();
    // …and the code completes it.
    const code = totpCodeForStep(base32Decode(secret), currentStep(Date.now()));
    const ok = await post('/api/local-auth/login', { email, password: 'example-new-pw-0000002', code });
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toContain('oshal_local=');
  });
});

describe('forgot-password rate limits', () => {
  it('answers 429 per IP over the window cap', async () => {
    pool = fakePool();
    await startApp();
    clientIp = '10.3.0.99';
    for (let i = 0; i < 5; i += 1) {
      expect((await post('/api/local-auth/forgot', { email: `probe${i}@example.com` })).status).toBe(200);
    }
    const blocked = await post('/api/local-auth/forgot', { email: 'probe-final@example.com' });
    expect(blocked.status).toBe(429);
  });

  it('caps per-EMAIL silently: the answer stays identical but the token stops rotating', async () => {
    pool = fakePool();
    await startApp();
    await post('/api/local-auth/bootstrap', { email: 'victim@example.com', password: 'example-admin-pw-000001' });
    const row = () => pool.rows.find((r) => r.email === 'victim@example.com')!;

    let last: unknown = null;
    for (let i = 0; i < 3; i += 1) {
      clientIp = `10.4.0.${i + 1}`; // distinct IPs — this exercises the EMAIL cap alone
      expect((await post('/api/local-auth/forgot', { email: 'victim@example.com' })).status).toBe(200);
      expect(row().invite_token_hash).not.toBe(last); // rotated
      last = row().invite_token_hash;
    }
    clientIp = '10.4.0.9';
    const capped = await post('/api/local-auth/forgot', { email: 'victim@example.com' });
    expect(capped.status).toBe(200); // indistinguishable answer…
    expect(capped.data.ok).toBe(true);
    expect(row().invite_token_hash).toBe(last); // …but no fourth token, no fourth mail
  });
});
