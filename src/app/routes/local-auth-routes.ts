/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Invitations send with NO mail password. The first hosted customer box had no SMTP, so an invited user simply never got an email and the admin had to notice the copy-link banner - the operator did not, and the invitee waited. Invite delivery now tries two rails in order: SMTP when a deployment configures its own server (explicit beats inherited), else the platform's EXISTING Gmail connector - the same OAuth grant every other outbound message in the swarm already uses, resolved through the same NOTIFY_EMAIL_SENDER_SUB / OSHAL_OPERATOR_SUBS identity notify-routes uses. sendGmail is reused, not re-implemented, so the header-injection fence still applies. The public-URL check moved FIRST because an emailed invite needs an absolute link (the copyable path still works without one - the browser knows its origin), and both rails failing is not an error: the admin screen always shows the link. Guard: local-auth-routes.spec rail-order case, mutation-proven.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | LOCAL_AUTH mode (ADR-117): a controlled invited-user login for deployments with no external IdP. createLocalAuthMiddlewareSet is the third sibling of the OIDC/mock middleware sets (server.ts picks it when LOCAL_AUTH=true): a session-cookie injector that fabricates the SAME req.oidc shape as the PAT/TV/guest injectors, a requiresAuth that answers API requests 401-JSON and browser documents with a /login redirect (reusing shouldReturnUnauthorizedResponse — one discrimination rule), and a loginHandler that serves the first-party credential page. createLocalAuthRoutes carries the flows: bootstrap-first-admin (the installer is the first login), email invitations with a copyable-link fallback when SMTP is absent, one-time accept (set password), login with per-ip+email rate limiting and account-enumeration-proof errors, logout, and the operator/trusted-service user administration API the CRM admin screen proxies to. Fail-closed at boot: LOCAL_AUTH+MOCK_OIDC together, or a missing SESSION_SECRET, throw instead of silently degrading to open auth.
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import path from 'path';
import fs from 'fs';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  isMockOidcEnabled,
  sanitizeLoginReturnTo,
  shouldReturnUnauthorizedResponse,
  type OidcMiddlewareSet,
} from '@/shared/middleware/oidc';
import { hasValidServiceSecret, isOperator } from '@/shared/middleware/authz';
import {
  LOCAL_SESSION_COOKIE,
  localAuthSigningSecret,
  mintLocalSession,
  shouldReissueLocalSession,
  verifyLocalSession,
  type LocalSessionIdentity,
  acceptInvite,
  bootstrapFirstAdmin,
  ensureLocalUserSchema,
  findByInviteToken,
  getSessionSnapshot,
  getUserById,
  isStoreEmpty,
  listUsers,
  setUserStatus,
  upsertInvite,
  verifyLogin,
  type LocalUser,
} from '@/features/local-auth';
import { sendTransactionalMail, smtpConfigured } from '@/features/notifications';
import { sendGmail } from './email-routes';
import { getValidAccessToken } from './connectors-routes';

const logger = createChildLogger({ module: 'local-auth-routes' });

export { isLocalAuthEnabled } from '@/features/local-auth';

// ── Session-validity snapshot cache ──────────────────────────────────────────
// The injector runs on EVERY request; a 30s cache keeps revocation (disable /
// password change) near-immediate without a per-request SELECT.
const SNAPSHOT_TTL_MS = 30_000;
type Snapshot = { status: string; tokenVersion: number; email: string; displayName: string | null };
const snapshotCache = new Map<string, { snap: Snapshot | null; at: number }>();

/**
 * @description Drops the cached session snapshot for one sub (or all), so an admin
 * action (disable, re-invite, accept) takes effect immediately in-process instead of
 * after the cache TTL.
 *
 * @param sub - The `local-…` sub to bust; omit to clear the whole cache.
 */
export function bustLocalUserSnapshot(sub?: string): void {
  if (sub) snapshotCache.delete(sub);
  else snapshotCache.clear();
}

async function cachedSnapshot(pool: Pool, sub: string): Promise<Snapshot | null> {
  const hit = snapshotCache.get(sub);
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.snap;
  const snap = await getSessionSnapshot(pool, sub);
  snapshotCache.set(sub, { snap, at: Date.now() });
  return snap;
}

// ── Login rate limiting (fixed window, in-memory) ────────────────────────────
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

function loginKey(req: Request, email: string): string {
  return `${req.ip}|${email}`;
}

function isLoginBlocked(key: string): boolean {
  const bucket = loginFailures.get(key);
  if (!bucket || bucket.resetAt < Date.now()) return false;
  return bucket.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key: string): void {
  if (loginFailures.size > 5000) {
    for (const [k, v] of loginFailures) if (v.resetAt < Date.now()) loginFailures.delete(k);
  }
  const bucket = loginFailures.get(key);
  if (!bucket || bucket.resetAt < Date.now()) {
    loginFailures.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    return;
  }
  bucket.count += 1;
}

// ── Cookie plumbing ──────────────────────────────────────────────────────────

function setLocalSessionCookie(req: Request, res: Response, identity: LocalSessionIdentity, priorOrg?: number): boolean {
  const minted = mintLocalSession(identity, Date.now(), priorOrg);
  if (!minted) return false;
  res.cookie(LOCAL_SESSION_COOKIE, minted.value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: minted.maxAgeMs,
  });
  return true;
}

function clearLocalSessionCookie(res: Response): void {
  res.clearCookie(LOCAL_SESSION_COOKIE, { path: '/' });
}

function sessionIdentityFor(user: LocalUser): LocalSessionIdentity {
  return { userSub: user.userSub, email: user.email, displayName: user.displayName, tokenVersion: user.tokenVersion };
}

// ── Page resolution (dev ts-node, dist build, and the baked image all differ) ─

function resolveLoginPage(file: string): string | null {
  const candidates = [
    path.resolve(__dirname, '../../pages/login', file),
    path.resolve(process.cwd(), 'src/pages/login', file),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  logger.error({ file, candidates }, 'local-auth page missing');
  return null;
}

function servePage(res: Response, file: string): void {
  const resolved = resolveLoginPage(file);
  if (!resolved) {
    res.status(500).type('text/plain').send('login surface is missing from this build');
    return;
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(resolved);
}

// ── The middleware set (server.ts picks this over OIDC when LOCAL_AUTH=true) ─

/**
 * @description Builds the LOCAL_AUTH middleware set — the invited-user sibling of the
 * OIDC and mock sets. The injector authenticates a valid `oshal_local` cookie into the
 * standard req.oidc shape (revocation via a 30s store snapshot: disabled account or
 * bumped token_version ends the session), reissues past the rolling half-life, and
 * defers to any identity another injector already established. Fail-closed at boot:
 * refuses to construct with MOCK_OIDC also enabled or with no signing secret.
 *
 * @param pool - Postgres pool backing the local-user store.
 * @returns The { authMiddleware, requiresAuth, loginHandler } set server.ts expects.
 */
export function createLocalAuthMiddlewareSet(pool: Pool): OidcMiddlewareSet {
  if (isMockOidcEnabled()) {
    throw new Error('LOCAL_AUTH and MOCK_OIDC are both enabled — pick one auth mode (MOCK_OIDC is open; LOCAL_AUTH is gated).');
  }
  if (!localAuthSigningSecret()) {
    throw new Error('LOCAL_AUTH requires SESSION_SECRET (or AUTH_SESSION_SECRET) to sign session cookies.');
  }
  void ensureLocalUserSchema(pool).catch((err) => {
    logger.error({ err }, 'oshal_local_users schema bootstrap failed — local login unavailable until it exists');
  });
  logger.warn('🔐 LOCAL_AUTH mode enabled — invited-user login (ADR-117). Only invited accounts can sign in.');

  const authMiddleware: RequestHandler = async (req, res, next) => {
    try {
      const existing = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc;
      if (existing?.isAuthenticated?.()) return next();
      const cookie = (req as { cookies?: Record<string, string> }).cookies?.[LOCAL_SESSION_COOKIE];
      const claims = verifyLocalSession(cookie);
      if (!claims) return next();
      const snap = await cachedSnapshot(pool, claims.sub);
      if (!snap || snap.status !== 'active' || snap.tokenVersion !== claims.v) return next();
      if (shouldReissueLocalSession(claims)) {
        setLocalSessionCookie(req, res, {
          userSub: claims.sub, email: snap.email, displayName: snap.displayName, tokenVersion: snap.tokenVersion,
        }, claims.org);
      }
      (req as { oidc?: unknown }).oidc = {
        isAuthenticated: () => true,
        user: {
          sub: claims.sub,
          email: snap.email,
          name: snap.displayName || snap.email,
          preferred_username: snap.email,
        },
        idToken: 'local-session',
        accessToken: 'local-session',
      };
    } catch (err) {
      logger.error({ err }, 'local-auth session injector failed');
    }
    next();
  };

  const localRequiresAuth: RequestHandler = (req, res, next) => {
    const oidc = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc;
    if (oidc?.isAuthenticated?.()) return next();
    if (shouldReturnUnauthorizedResponse(req)) {
      res.status(401).json({ authenticated: false, error: 'unauthorized', loginPath: '/login' });
      return;
    }
    const returnTo = sanitizeLoginReturnTo(req.originalUrl) ?? '/';
    res.redirect(302, `/login?returnTo=${encodeURIComponent(returnTo)}`);
  };

  const loginHandler: RequestHandler = (req, res) => {
    const oidc = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc;
    if (oidc?.isAuthenticated?.()) {
      res.redirect(302, sanitizeLoginReturnTo(req.query.returnTo) ?? '/');
      return;
    }
    servePage(res, 'login.html');
  };

  return { authMiddleware, requiresAuth: localRequiresAuth, loginHandler };
}

// ── Invite delivery ──────────────────────────────────────────────────────────

function invitePath(token: string): string {
  return `/invite?token=${encodeURIComponent(token)}`;
}

function publicBaseUrl(): string | null {
  const base = (process.env.LOCAL_AUTH_PUBLIC_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return base || null;
}

/**
 * @description The sending identity for connector-rail delivery: NOTIFY_EMAIL_SENDER_SUB, else
 * the first OSHAL_OPERATOR_SUBS entry — the same resolution notify-routes uses, so a deployment
 * configures ONE sender identity rather than one per feature.
 *
 * @returns The sub whose Google connection sends invitations, or '' when none is configured.
 */
function inviteSenderSub(): string {
  return (process.env.NOTIFY_EMAIL_SENDER_SUB || (process.env.OSHAL_OPERATOR_SUBS || '').split(',')[0] || '').trim();
}

/**
 * @description Sends an invitation through the platform's EXISTING Gmail connector rail — the
 * same path every other outbound mail in the swarm uses. This is why a deployment needs no SMTP
 * password: an operator connects their Google account once (OAuth, gmail.send scope, revocable
 * from the Google account page) and invitations ride that grant with the invitee as recipient.
 * sendGmail carries the header-injection fence; it is deliberately not re-implemented here.
 *
 * @param pool - Postgres pool holding the connector tokens.
 * @param mail - Recipient, subject, body.
 * @returns Send outcome; never throws (a failure degrades to the copyable link).
 */
async function sendViaConnectedGmail(pool: Pool, mail: { to: string; subject: string; text: string }): Promise<{ ok: boolean; detail?: string }> {
  const senderSub = inviteSenderSub();
  if (!senderSub) {
    return { ok: false, detail: 'no sending identity configured (set OSHAL_OPERATOR_SUBS or NOTIFY_EMAIL_SENDER_SUB)' };
  }
  try {
    const token = await getValidAccessToken(pool, senderSub, 'google');
    if (!token) {
      return { ok: false, detail: 'no Google account is connected on this deployment — connect one on the Connectors screen, or set SMTP_HOST' };
    }
    await sendGmail(token, { to: mail.to, subject: mail.subject, body: mail.text });
    logger.info({ to: mail.to }, 'invitation sent via the Gmail connector rail');
    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error({ err, to: mail.to }, 'invitation send via Gmail connector failed');
    return { ok: false, detail };
  }
}

async function deliverInvite(
  pool: Pool, user: LocalUser, token: string, expiresAt: string,
): Promise<{ emailSent: boolean; emailDetail?: string }> {
  const base = publicBaseUrl();
  if (!base) {
    return { emailSent: false, emailDetail: 'no public URL configured (set LOCAL_AUTH_PUBLIC_URL or APP_URL) — copy the invite link instead' };
  }
  const product = process.env.SERVICE_DISPLAY_NAME || process.env.SERVICE_NAME || 'oshal';
  const link = `${base}${invitePath(token)}`;
  const expires = new Date(expiresAt).toUTCString();
  const mail = {
    to: user.email,
    subject: `You're invited to ${product}`,
    text: [
      `You've been invited to ${product}.`,
      '',
      'Open this link to choose your password and sign in:',
      link,
      '',
      `The link works once and expires ${expires}.`,
      "If you weren't expecting this invitation, you can ignore this email.",
    ].join('\n'),
  };
  // Two rails, in this order. SMTP wins when a deployment configures its own mail server
  // (explicit beats inherited). Otherwise the platform's OWN Gmail connector sends it — the
  // rail every other outbound message in the swarm already uses, so a box needs no mail
  // password at all. Both failing is not an error: the admin screen always shows the link.
  if (smtpConfigured()) {
    const result = await sendTransactionalMail(mail);
    if (result.ok) return { emailSent: true };
    logger.warn({ detail: result.detail }, 'SMTP invite send failed — falling back to the connector rail');
    const viaConnector = await sendViaConnectedGmail(pool, mail);
    return viaConnector.ok
      ? { emailSent: true }
      : { emailSent: false, emailDetail: `SMTP failed (${result.detail}); Gmail rail failed (${viaConnector.detail})` };
  }
  const viaConnector = await sendViaConnectedGmail(pool, mail);
  return viaConnector.ok
    ? { emailSent: true }
    : { emailSent: false, emailDetail: `${viaConnector.detail} — copy the invite link to the user yourself` };
}

// ── Admin gate ───────────────────────────────────────────────────────────────
// User administration is an operator session OR a trusted internal service call (an
// app's own admin surface gates on ITS capability model, then proxies here with the
// service secret + the acting admin's sub — the ADR-036 trusted-call shape).
function requireUserAdmin(req: Request, res: Response): boolean {
  if (hasValidServiceSecret(req)) return true;
  const oidc = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc;
  const authenticated = !!oidc?.isAuthenticated?.();
  if (authenticated && isOperator(req)) return true;
  res.status(authenticated ? 403 : 401).json({
    error: 'user administration needs an operator session or a trusted service call',
  });
  return false;
}

function errStatus(err: unknown): number {
  const status = (err as { status?: number } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * @description Builds the LOCAL_AUTH router: the invite/accept/login/logout flows plus
 * the user-administration API. Mount at the app root ONLY when LOCAL_AUTH is enabled —
 * public legs (login, state, invite-info, accept, bootstrap) are public by design
 * (they are the front door); admin legs gate per-request via requireUserAdmin.
 *
 * @param pool - Postgres pool backing the local-user store.
 * @returns Express router.
 */
export function createLocalAuthRoutes(pool: Pool): Router {
  const router = Router();
  let knownNonEmpty = false;

  /** GET /invite — the set-your-password page an invite link lands on. */
  router.get('/invite', (_req, res) => servePage(res, 'invite.html'));

  /** GET /logout — ends the local session and returns to the login page. */
  router.get('/logout', (_req, res) => {
    clearLocalSessionCookie(res);
    res.redirect(302, '/login');
  });

  /** GET /api/local-auth/state — tells the login page whether first-run bootstrap is needed. */
  router.get('/api/local-auth/state', async (_req, res) => {
    try {
      const bootstrapRequired = knownNonEmpty ? false : await isStoreEmpty(pool);
      knownNonEmpty = knownNonEmpty || !bootstrapRequired;
      res.json({ localAuth: true, bootstrapRequired });
    } catch (err) {
      logger.error({ err }, 'local-auth state failed');
      res.status(500).json({ error: 'state unavailable' });
    }
  });

  /** POST /api/local-auth/bootstrap — creates the FIRST admin (the installer). Refused once any account exists. */
  router.post('/api/local-auth/bootstrap', async (req, res) => {
    const { email, name, password } = (req.body ?? {}) as { email?: string; name?: string; password?: string };
    try {
      const user = await bootstrapFirstAdmin(pool, { email: String(email ?? ''), displayName: name ?? null, password: String(password ?? '') });
      if (!user) {
        res.status(409).json({ error: 'an account already exists — sign in instead' });
        return;
      }
      knownNonEmpty = true;
      setLocalSessionCookie(req, res, sessionIdentityFor(user));
      logger.info({ email: user.email, sub: user.userSub }, 'local-auth first admin bootstrapped');
      res.status(201).json({ ok: true, email: user.email, sub: user.userSub });
    } catch (err) {
      logger.error({ err }, 'local-auth bootstrap failed');
      res.status(errStatus(err)).json({ error: (err as Error).message });
    }
  });

  /** POST /api/local-auth/login — email + password. One generic failure message (no enumeration). */
  router.post('/api/local-auth/login', async (req, res) => {
    const body = (req.body ?? {}) as { email?: string; password?: string; returnTo?: string };
    const email = String(body.email ?? '').trim().toLowerCase();
    const key = loginKey(req, email);
    if (isLoginBlocked(key)) {
      res.status(429).json({ error: 'too many attempts — wait a few minutes and try again' });
      return;
    }
    try {
      const user = await verifyLogin(pool, email, String(body.password ?? ''));
      if (!user) {
        recordLoginFailure(key);
        res.status(401).json({ error: 'that email and password did not match' });
        return;
      }
      loginFailures.delete(key);
      bustLocalUserSnapshot(user.userSub);
      setLocalSessionCookie(req, res, sessionIdentityFor(user));
      logger.info({ sub: user.userSub }, 'local-auth login');
      res.json({ ok: true, returnTo: sanitizeLoginReturnTo(body.returnTo) ?? '/' });
    } catch (err) {
      logger.error({ err }, 'local-auth login failed');
      res.status(500).json({ error: 'login unavailable' });
    }
  });

  /** GET /api/local-auth/invite-info — whose invitation a token is (proof-of-possession read). */
  router.get('/api/local-auth/invite-info', async (req, res) => {
    try {
      const user = await findByInviteToken(pool, String(req.query.token ?? ''));
      if (!user) {
        res.status(404).json({ error: 'this invitation link is invalid, expired, or already used' });
        return;
      }
      res.json({ email: user.email, displayName: user.displayName });
    } catch (err) {
      logger.error({ err }, 'local-auth invite-info failed');
      res.status(500).json({ error: 'invite lookup unavailable' });
    }
  });

  /** POST /api/local-auth/accept — redeem the one-time token, set the password, sign in. */
  router.post('/api/local-auth/accept', async (req, res) => {
    const body = (req.body ?? {}) as { token?: string; password?: string };
    try {
      const user = await acceptInvite(pool, String(body.token ?? ''), String(body.password ?? ''));
      if (!user) {
        res.status(410).json({ error: 'this invitation link is invalid, expired, or already used — ask your administrator for a new one' });
        return;
      }
      bustLocalUserSnapshot(user.userSub);
      setLocalSessionCookie(req, res, sessionIdentityFor(user));
      logger.info({ sub: user.userSub }, 'local-auth invite accepted');
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'local-auth accept failed');
      res.status(errStatus(err)).json({ error: (err as Error).message });
    }
  });

  /** GET /api/local-auth/users — every local account (metadata only). Admin. */
  router.get('/api/local-auth/users', async (req, res) => {
    if (!requireUserAdmin(req, res)) return;
    try {
      res.json({ users: await listUsers(pool), smtpConfigured: smtpConfigured() });
    } catch (err) {
      logger.error({ err }, 'local-auth user list failed');
      res.status(500).json({ error: 'user list unavailable' });
    }
  });

  /** POST /api/local-auth/users — invite a user by email. Always returns the copyable link. Admin. */
  router.post('/api/local-auth/users', async (req, res) => {
    if (!requireUserAdmin(req, res)) return;
    const body = (req.body ?? {}) as { email?: string; name?: string; invitedBySub?: string };
    try {
      const invitedBySub = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub
        ?? (typeof body.invitedBySub === 'string' ? body.invitedBySub : null);
      const invite = await upsertInvite(pool, { email: String(body.email ?? ''), displayName: body.name ?? null, invitedBySub });
      const delivery = await deliverInvite(pool, invite.user, invite.token, invite.expiresAt);
      bustLocalUserSnapshot(invite.user.userSub);
      logger.info({ email: invite.user.email, emailSent: delivery.emailSent }, 'local-auth invite created');
      res.status(201).json({ user: invite.user, invitePath: invitePath(invite.token), inviteExpiresAt: invite.expiresAt, ...delivery });
    } catch (err) {
      logger.error({ err }, 'local-auth invite failed');
      res.status(errStatus(err)).json({ error: (err as Error).message });
    }
  });

  /** POST /api/local-auth/users/:id/reinvite — new one-time link (also the password-reset path). Admin. */
  router.post('/api/local-auth/users/:id/reinvite', async (req, res) => {
    if (!requireUserAdmin(req, res)) return;
    try {
      const existing = await getUserById(pool, String(req.params.id));
      if (!existing) {
        res.status(404).json({ error: 'no such user' });
        return;
      }
      const invite = await upsertInvite(pool, { email: existing.email });
      const delivery = await deliverInvite(pool, invite.user, invite.token, invite.expiresAt);
      res.json({ user: invite.user, invitePath: invitePath(invite.token), inviteExpiresAt: invite.expiresAt, ...delivery });
    } catch (err) {
      logger.error({ err }, 'local-auth reinvite failed');
      res.status(errStatus(err)).json({ error: (err as Error).message });
    }
  });

  /** POST /api/local-auth/users/:id/disable | /enable — status flip; disable ends live sessions. Admin. */
  const statusHandler = (status: 'active' | 'disabled') => async (req: Request, res: Response) => {
    if (!requireUserAdmin(req, res)) return;
    try {
      const user = await setUserStatus(pool, String(req.params.id), status);
      if (!user) {
        res.status(404).json({ error: 'no such user' });
        return;
      }
      bustLocalUserSnapshot(user.userSub);
      logger.info({ sub: user.userSub, status }, 'local-auth user status changed');
      res.json({ ok: true, user });
    } catch (err) {
      logger.error({ err }, 'local-auth status change failed');
      res.status(500).json({ error: (err as Error).message });
    }
  };
  router.post('/api/local-auth/users/:id/disable', statusHandler('disabled'));
  router.post('/api/local-auth/users/:id/enable', statusHandler('active'));

  return router;
}
