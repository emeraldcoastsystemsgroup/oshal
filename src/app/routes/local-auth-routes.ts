/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | LOCAL_AUTH mode (ADR-117): a controlled invited-user login for deployments with no external IdP. createLocalAuthMiddlewareSet is the third sibling of the OIDC/mock middleware sets (server.ts picks it when LOCAL_AUTH=true): a session-cookie injector that fabricates the SAME req.oidc shape as the PAT/TV/guest injectors, a requiresAuth that answers API requests 401-JSON and browser documents with a /login redirect (reusing shouldReturnUnauthorizedResponse — one discrimination rule), and a loginHandler that serves the first-party credential page. createLocalAuthRoutes carries the flows: bootstrap-first-admin (the installer is the first login), email invitations with a copyable-link fallback when SMTP is absent, one-time accept (set password), login with per-ip+email rate limiting and account-enumeration-proof errors, logout, and the operator/trusted-service user administration API the CRM admin screen proxies to. Fail-closed at boot: LOCAL_AUTH+MOCK_OIDC together, or a missing SESSION_SECRET, throw instead of silently degrading to open auth.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Invitations send with NO mail password. The first hosted customer box had no SMTP, so an invited user simply never got an email and the admin had to notice the copy-link banner - the operator did not, and the invitee waited. Invite delivery now tries two rails in order: SMTP when a deployment configures its own server (explicit beats inherited), else the platform's EXISTING Gmail connector - the same OAuth grant every other outbound message in the swarm already uses, resolved through the same NOTIFY_EMAIL_SENDER_SUB / OSHAL_OPERATOR_SUBS identity notify-routes uses. sendGmail is reused, not re-implemented, so the header-injection fence still applies. The public-URL check moved FIRST because an emailed invite needs an absolute link (the copyable path still works without one - the browser knows its origin), and both rails failing is not an error: the admin screen always shows the link. Guard: local-auth-routes.spec rail-order case, mutation-proven.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | servePage passes dotfiles:'allow' to res.sendFile. Express defaults to 'ignore', which 404s when ANY segment of the resolved path starts with a dot — so /login, /invite and /2fa returned 404 for any checkout under `.claude/worktrees/<name>`, which is exactly how every agent worktree is laid out. Two page-serving specs went red for anyone running the suite from a worktree (and a future agent would misattribute them to their own change), and a real deployment under a dot-segment path would serve no login page at all. Safe: `file` is one of three hardcoded literals and `resolved` comes from resolveLoginPage's fixed candidate list, so no caller-supplied path reaches sendFile.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | INSTALLER-GAPS G14: a broken Google grant (token refresh rejected — getValidAccessToken throws `refresh 400`) now produces a DISTINCT emailDetail telling the admin to reconnect on the Connections screen, instead of the generic transport failure. On the G-Squared box the first two real invitations silently returned emailSent:false because a Testing-mode Google client had invalidated the refresh token for gmail.send hours after connecting, and the only signal was a container-log warning a prior triage had dismissed. The admin-facing message now names the fix (~30s reconnect) so no log dive is needed.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | ADR-117 deferred item: unauthenticated self-service password reset. POST /api/local-auth/forgot (public front door, like /login) asks the store for a reset token (createPasswordReset - active accounts only, never creates/resurrects/stomps) and emails the /invite link over the SAME two rails as invitations. Enumeration-safe by construction: ONE response body/status for known, unknown, invited and disabled addresses; one identical store round trip either way; delivery is fire-and-forget so response timing cannot become the oracle; and delivery outcomes are logged, never returned. Per-IP fixed-window limit answers 429; the per-EMAIL cap is enforced SILENTLY (same 200) because a distinct answer would itself leak, and it caps mailbombing a victim address. A reset never clears TOTP (acceptInvite leaves the factor columns alone - guarded). Guard: tests/unit/local-auth-forgot-password.spec.ts.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Stamp locally authenticated sessions with a stable issuer namespace so derived PAT/TV credentials and issuer-bound applications preserve the same account identity.
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
import QRCode from 'qrcode';
import { hasValidServiceSecret, isOperator } from '@/shared/middleware/authz';
import { LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
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
  // Second factor (TOTP, RFC 6238) — same feature slice, separate module.
  beginTotpEnrolment,
  confirmTotpEnrolment,
  disableTotp,
  ensureTotpSchema,
  formatSecretForDisplay,
  getTotpState,
  setTotpRequired,
  verifySecondFactor,
  findByInviteToken,
  createPasswordReset,
  looksLikeEmail,
  normalizeEmail,
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

// ── Forgot-password rate limiting (fixed window, in-memory) ──────────────────────
// Counts REQUESTS, not failures: the endpoint is unauthenticated and every ask spends
// real resources (a token write + an outbound mail), so the budget is per ask.
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_MAX_PER_IP = 5;
const FORGOT_MAX_PER_EMAIL = 3;
const forgotRequests = new Map<string, { count: number; resetAt: number }>();

function forgotOverLimit(key: string, max: number): boolean {
  const bucket = forgotRequests.get(key);
  return !!bucket && bucket.resetAt >= Date.now() && bucket.count >= max;
}

function recordForgotRequest(key: string): void {
  if (forgotRequests.size > 5000) {
    for (const [k, v] of forgotRequests) if (v.resetAt < Date.now()) forgotRequests.delete(k);
  }
  const bucket = forgotRequests.get(key);
  if (!bucket || bucket.resetAt < Date.now()) {
    forgotRequests.set(key, { count: 1, resetAt: Date.now() + FORGOT_WINDOW_MS });
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
  // dotfiles:'allow' because express defaults to 'ignore', which 404s when ANY segment of the
  // resolved path begins with a dot — including a checkout under `.claude/worktrees/<name>`, which
  // is how every agent worktree is laid out. That silently reddened two page-serving specs for
  // anyone running the suite from a worktree, and would 404 the real login page on any deployment
  // whose path contains a dot-segment. Safe here: `file` is one of three hardcoded literals and
  // `resolved` comes from resolveLoginPage's fixed candidate list, so no caller-supplied path
  // reaches this call and allowing dotfiles cannot widen traversal.
  res.sendFile(resolved, { dotfiles: 'allow' });
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
  // The second-factor columns are a separate ALTER: the table above is created with
  // IF NOT EXISTS, so an already-deployed box would never gain new columns from it.
  void ensureTotpSchema(pool).catch((err) => {
    logger.error({ err }, 'second-factor columns missing — TOTP unavailable until they exist');
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
          iss: LOCAL_AUTH_PRINCIPAL_ISSUER,
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
    const raw = err instanceof Error ? err.message : String(err);
    logger.error({ err, to: mail.to }, 'invitation send via Gmail connector failed');
    // A rejected token refresh (`refresh 400/401` from getValidAccessToken) means the stored
    // grant is dead — a connection row EXISTS but Google will no longer honor it. Google
    // applies a reauthentication policy to sensitive scopes (gmail.send) on Testing-mode
    // OAuth clients, so this happens on a working box hours after connecting (G-Squared
    // incident, INSTALLER-GAPS G14). Tell the admin the actual fix, not "no transport".
    if (/refresh 4\d\d/.test(raw)) {
      return {
        ok: false,
        detail: 'the operator\'s Google connection needs to be RECONNECTED (token refresh rejected by Google — expected periodically for Testing-mode clients with gmail.send). Fix: Connections screen -> Google -> reconnect (~30 seconds)',
      };
    }
    return { ok: false, detail: raw };
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

/**
 * @description Emails a self-service password-reset link over the SAME two rails as
 * invitations (deployment SMTP first, else the operator's connected Gmail). Called
 * fire-and-forget from the /forgot route: outcomes are logged, never returned — an
 * unauthenticated caller must see neither the link nor whether mail went out (either
 * difference is an account-probing oracle). A box with no working rail degrades to the
 * admin-driven Re-invite path, which this flow deliberately does not replace.
 *
 * @param pool - Postgres pool holding the connector tokens.
 * @param user - The account the reset was minted for.
 * @param token - One-time plaintext reset token (rides the /invite redeem page).
 * @param expiresAt - ISO expiry of the link.
 * @returns Resolves when delivery has been attempted on every rail.
 */
async function deliverPasswordReset(pool: Pool, user: LocalUser, token: string, expiresAt: string): Promise<void> {
  const base = publicBaseUrl();
  if (!base) {
    logger.warn('password reset requested but no public URL is configured (set LOCAL_AUTH_PUBLIC_URL or APP_URL) — no link can be emailed; the admin Re-invite path remains');
    return;
  }
  const product = process.env.SERVICE_DISPLAY_NAME || process.env.SERVICE_NAME || 'oshal';
  const link = `${base}${invitePath(token)}`;
  const expires = new Date(expiresAt).toUTCString();
  const mail = {
    to: user.email,
    subject: `Reset your ${product} password`,
    text: [
      `Someone asked to reset the ${product} password for this address.`,
      '',
      'Open this link to choose a new password:',
      link,
      '',
      `The link works once and expires ${expires}. If your account uses two-step sign-in,`,
      'the reset does not remove it — signing in still asks for your code.',
      "If you didn't ask for this, ignore this email; your password is unchanged.",
    ].join('\n'),
  };
  if (smtpConfigured()) {
    const result = await sendTransactionalMail(mail);
    if (result.ok) return;
    logger.warn({ detail: result.detail }, 'SMTP reset send failed — falling back to the connector rail');
  }
  const viaConnector = await sendViaConnectedGmail(pool, mail);
  if (!viaConnector.ok) {
    logger.warn({ detail: viaConnector.detail }, 'password-reset email could not be sent on any rail — the admin Re-invite path remains');
  }
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
 * public legs (login, state, invite-info, accept, bootstrap, forgot) are public by design
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

  /**
   * GET /2fa — the second-factor enrolment surface. Served to anyone; the page itself calls
   * the authenticated state endpoint and bounces to /login on a 401, which keeps one
   * redirect rule rather than a second copy of the auth discrimination logic.
   */
  router.get('/2fa', (_req, res) => servePage(res, 'two-factor.html'));

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
    const body = (req.body ?? {}) as { email?: string; password?: string; returnTo?: string; code?: string };
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
      // The password is right. Now the second factor, if this account has one. Note this
      // block is reached ONLY after a successful password check, so it can never be used to
      // probe which accounts have 2FA enabled.
      const factor = await getTotpState(pool, user.userSub);
      const code = String(body.code ?? '').trim();
      if (factor?.enabled) {
        if (!code) {
          // No session yet, and deliberately NOT counted as a failure: the credential was
          // correct and the client simply has one more step to complete.
          res.json({ ok: false, secondFactor: 'required' });
          return;
        }
        const verdict = await verifySecondFactor(pool, user.userSub, code, Date.now());
        if (verdict !== 'ok') {
          recordLoginFailure(key);
          res.status(401).json({
            error: 'that code did not match \u2014 check your authenticator app, or use a recovery code',
          });
          return;
        }
      }
      loginFailures.delete(key);
      bustLocalUserSnapshot(user.userSub);
      setLocalSessionCookie(req, res, sessionIdentityFor(user));
      logger.info({ sub: user.userSub, secondFactor: factor?.enabled === true }, 'local-auth login');
      res.json({
        ok: true,
        returnTo: sanitizeLoginReturnTo(body.returnTo) ?? '/',
        // An administrator may REQUIRE the factor on an account that has not enrolled yet.
        // Requiring it must never lock somebody out of an account they have not set up, so
        // the answer is "you are in, now go and enrol" rather than a refusal.
        enrolSecondFactor: factor?.required === true && factor.enabled !== true,
      });
    } catch (err) {
      logger.error({ err }, 'local-auth login failed');
      res.status(500).json({ error: 'login unavailable' });
    }
  });

  /**
   * POST /api/local-auth/forgot — unauthenticated self-service password reset (the /login
   * page's "Email me a reset link"). ENUMERATION-SAFE: one response body and status for
   * known, unknown, invited and disabled addresses; the store answers all of them with one
   * identical UPDATE round trip; and delivery runs fire-and-forget AFTER the response is
   * decided, so neither content nor timing says whether an account exists. Per-IP requests
   * answer 429 over the window cap; the per-EMAIL cap is enforced silently (same 200) —
   * a distinct answer would leak, and it stops mailbombing one victim address.
   */
  router.post('/api/local-auth/forgot', async (req, res) => {
    const email = normalizeEmail(String(((req.body ?? {}) as { email?: string }).email ?? ''));
    const ipKey = `ip|${req.ip}`;
    if (forgotOverLimit(ipKey, FORGOT_MAX_PER_IP)) {
      res.status(429).json({ error: 'too many reset requests — wait a few minutes and try again' });
      return;
    }
    recordForgotRequest(ipKey);
    try {
      const emailKey = `email|${email}`;
      if (looksLikeEmail(email) && !forgotOverLimit(emailKey, FORGOT_MAX_PER_EMAIL)) {
        recordForgotRequest(emailKey);
        const reset = await createPasswordReset(pool, email);
        if (reset) {
          // Fire-and-forget: the response must not wait on (or vary with) mail delivery.
          void deliverPasswordReset(pool, reset.user, reset.token, reset.expiresAt)
            .catch((err) => logger.error({ err }, 'password-reset delivery failed'));
          logger.info({ sub: reset.user.userSub }, 'password-reset link minted');
        }
      }
    } catch (err) {
      logger.error({ err }, 'forgot-password processing failed'); // the response stays identical
    }
    res.json({ ok: true, message: 'If that address has an account, a reset link is on its way.' });
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

  // ── Second factor (TOTP, RFC 6238) ─────────────────────────────────────────
  // Self-service: a signed-in user enrols their own authenticator app. Nothing here talks to
  // an external service — the secret is generated locally and the QR is rendered locally, so
  // this works on an air-gapped box and costs nothing per login.

  /** The signed-in caller's own sub, or null when the request is not authenticated. */
  function callerSub(req: Request): string | null {
    const oidc = (req as { oidc?: { isAuthenticated?: () => boolean; user?: { sub?: string } } }).oidc;
    if (!oidc?.isAuthenticated?.()) return null;
    const sub = oidc.user?.sub;
    return typeof sub === 'string' && sub ? sub : null;
  }

  /** Answers 401 and returns null when the caller has no session. */
  function requireSelf(req: Request, res: Response): string | null {
    const sub = callerSub(req);
    if (!sub) {
      res.status(401).json({ error: 'sign in first' });
      return null;
    }
    return sub;
  }

  /** GET /api/local-auth/2fa/state — the caller's own second-factor status. */
  router.get('/api/local-auth/2fa/state', async (req, res) => {
    const sub = requireSelf(req, res);
    if (!sub) return;
    try {
      const state = await getTotpState(pool, sub);
      res.json(state ?? { enabled: false, required: false, confirmedAt: null, recoveryCodesRemaining: 0 });
    } catch (err) {
      logger.error({ err }, 'second-factor state read failed');
      res.status(500).json({ error: 'second-factor state unavailable' });
    }
  });

  /**
   * POST /api/local-auth/2fa/setup — mint a secret + recovery codes and return the QR.
   * Stored UNCONFIRMED: the login path is untouched until the user proves the app works,
   * so a mis-scanned QR cannot lock them out of their own account.
   */
  router.post('/api/local-auth/2fa/setup', async (req, res) => {
    const sub = requireSelf(req, res);
    if (!sub) return;
    try {
      const snapshot = await getSessionSnapshot(pool, sub);
      if (!snapshot) {
        res.status(404).json({ error: 'no such account' });
        return;
      }
      const issuer = (process.env.TOTP_ISSUER || 'oshal').trim() || 'oshal';
      const enrolment = await beginTotpEnrolment(pool, sub, issuer, snapshot.email);
      // Rendered as a data URI so the page needs no external image host — the artifact CSP
      // and an offline client box both refuse anything else.
      const qrDataUri = await QRCode.toDataURL(enrolment.otpauthUri, { margin: 1, width: 240 });
      res.json({
        qrDataUri,
        otpauthUri: enrolment.otpauthUri,
        // Shown so a user whose camera will not cooperate can type the key in by hand.
        secret: formatSecretForDisplay(enrolment.secretBase32),
        // Shown ONCE. There is no endpoint that returns these again, by design.
        recoveryCodes: enrolment.recoveryCodes,
      });
    } catch (err) {
      logger.error({ err }, 'second-factor setup failed');
      res.status(500).json({ error: 'could not start second-factor setup' });
    }
  });

  /** POST /api/local-auth/2fa/confirm — verify a code from the app and switch the factor on. */
  router.post('/api/local-auth/2fa/confirm', async (req, res) => {
    const sub = requireSelf(req, res);
    if (!sub) return;
    const code = String(((req.body ?? {}) as { code?: string }).code ?? '').trim();
    try {
      const ok = await confirmTotpEnrolment(pool, sub, code, Date.now());
      if (!ok) {
        res.status(400).json({ error: 'that code did not match \u2014 check the clock on your phone and try the current code' });
        return;
      }
      res.json({ ok: true, enabled: true });
    } catch (err) {
      logger.error({ err }, 'second-factor confirm failed');
      res.status(500).json({ error: 'could not confirm the second factor' });
    }
  });

  /**
   * POST /api/local-auth/2fa/disable — turn it off. Requires the account PASSWORD again:
   * a live session alone must not be enough to strip a second factor, or an unattended
   * browser undoes the whole control.
   */
  router.post('/api/local-auth/2fa/disable', async (req, res) => {
    const sub = requireSelf(req, res);
    if (!sub) return;
    const password = String(((req.body ?? {}) as { password?: string }).password ?? '');
    try {
      const snapshot = await getSessionSnapshot(pool, sub);
      if (!snapshot) {
        res.status(404).json({ error: 'no such account' });
        return;
      }
      const state = await getTotpState(pool, sub);
      if (state?.required) {
        res.status(403).json({ error: 'an administrator requires a second factor on this account' });
        return;
      }
      if (!await verifyLogin(pool, snapshot.email, password)) {
        res.status(401).json({ error: 'that password did not match' });
        return;
      }
      await disableTotp(pool, sub);
      res.json({ ok: true, enabled: false });
    } catch (err) {
      logger.error({ err }, 'second-factor disable failed');
      res.status(500).json({ error: 'could not disable the second factor' });
    }
  });

  /**
   * POST /api/local-auth/users/:id/2fa — the administrator's two levers. Admin.
   * `{ required: true|false }` makes the factor mandatory for that account; `{ reset: true }`
   * clears an enrolment, which is the lost-phone path when the recovery codes are gone too.
   */
  router.post('/api/local-auth/users/:id/2fa', async (req, res) => {
    if (!requireUserAdmin(req, res)) return;
    const body = (req.body ?? {}) as { required?: boolean; reset?: boolean };
    try {
      const user = await getUserById(pool, String(req.params.id));
      if (!user) {
        res.status(404).json({ error: 'no such account' });
        return;
      }
      if (body.reset === true) await disableTotp(pool, user.userSub);
      if (typeof body.required === 'boolean') await setTotpRequired(pool, user.userSub, body.required);
      res.json({ ok: true, state: await getTotpState(pool, user.userSub) });
    } catch (err) {
      logger.error({ err }, 'second-factor administration failed');
      res.status(500).json({ error: 'could not change the second-factor setting' });
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
