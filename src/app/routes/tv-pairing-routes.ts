/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: OAuth-device-grant-style TV pairing so the Fire TV surface (ADR-047 phase-3) can sign in. Google blocks login inside embedded WebViews, so the TV shows a code, the user approves it in a real browser (/tv, requiresAuth → normal Google login), and the TV polls for an HMAC-signed token it then sends as the `oshal_tv` cookie. createTvTokenAuthMiddleware injects an authenticated req.oidc from that cookie, mirroring the MOCK_OIDC session shape, so requiresAuth + the home routes resolve the right user_sub.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Accept the token via the X-OSHAL-TV-Token / Authorization:Bearer header in addition to the cookie, so the native Roku channel (no browser cookie jar) reuses this same pairing rail (ADR-068). Cookie still wins when present; no change to the Fire TV path.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | "Scan to sign in": /pair/start now also returns verification_uri_complete + qr_url, and GET /api/tv/pair/qr renders a scannable QR PNG (login = the prefilled /tv approval URL; ?target=remote = the Jarvis phone push-to-talk URL). Native Roku can't draw an SVG, so it loads this PNG in a Poster (ADR-068).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Durable revocation + shorter TTL: tokens now carry a jti and a 30-day (was 90) TTL; POST /api/tv/pair/revoke (requiresAuth) upserts a per-user min_iat watermark in tv_token_revocations so "sign out all my TVs" invalidates every existing token and survives restarts. The auth middleware checks the watermark (cached) ONLY when a TV token is actually presented, so normal session traffic is unaffected; the check fails open on a DB error (signature is still verified).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Lazy-DDL chokepoint + tier-1 RLS (A1.2 follow-up): new ensureTvRevocationSchema creates tv_token_revocations if absent (DDL mirrors docker/postgres/migrations/003_tv_token_revocations.sql, which no automated runner applies — so this is the table's only fresh-deploy creation path) and appends buildOwnerRlsPolicyStatements so it is never policy-less. Fired once, non-fatally, at router creation when a pool is provided; the revoke/watermark paths keep their existing fail-open behavior.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | guc-strict fix: revocationWatermark queried FORCE-RLS tv_token_revocations from the auth middleware — BEFORE any request identity exists — so under OSHAL_DB_GUC_STRICT=deny the read silently returned no rows (not an error → the fail-open path) and minIat stayed 0: "sign out all my TVs" no longer invalidated anything. The watermark read now runs under runWithSystemIdentity (trusted pre-identity auth path, scoped to the sub already proven by the token's HMAC signature). Guard: tests/unit/token-middleware-rls.spec.ts.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Carry the approving session's verified issuer in newly signed TV tokens and restore it during authentication. Existing issuer-less tokens retain core access but cannot be guessed into an issuer-bound application account.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Pairing QR: `?target=cockpit` encodes the installable cockpit URL (the phone tile on the Get oshal page). The URL choice moved out of the handler into the exported pairingQrUrl so it is testable and the allowlist of targets lives in one place. Guard: tests/unit/tv-pairing-qr-target.spec.ts.
 */
import { Router, RequestHandler, Request, Response } from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import {
  getAuthenticatedPrincipalIssuer,
  normalizePrincipalIssuer,
} from '@/shared/middleware/principal-issuer';

const logger = createChildLogger({ module: 'tv-pairing' });

/** How long a pairing code is valid before the user must restart on the TV. */
const PAIRING_TTL_MS = 10 * 60 * 1000;
/** TV token lifetime — pair once but bounded; POST /api/tv/pair/revoke kills all of a user's
 *  tokens before this, and rotating SESSION_SECRET invalidates every token globally. */
const TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
/** Per-user revocation watermark cache TTL — avoids a DB read on every poll while staying fresh. */
const REV_CACHE_TTL_MS = 60 * 1000;
/** Cookie the TV app sets (client-side via WebView CookieManager) carrying the token. */
const TV_COOKIE = 'oshal_tv';
/** Header a NATIVE TV client (Roku — no browser cookie jar) presents the token on instead. */
const TV_HEADER = 'x-oshal-tv-token';

interface TvClaims {
  iss?: string;
  sub: string;
  name?: string;
  email?: string;
  iat: number;
  exp: number;
  jti?: string;
}

interface Pairing {
  deviceCode: string;
  userCode: string;
  status: 'pending' | 'approved';
  token?: string;
  expiresAt: number;
}

/** In-memory pending pairings, keyed by user_code. Pairing completes within minutes,
 *  so volatility across an api restart is acceptable (the user simply retries on the TV). */
const pairings = new Map<string, Pairing>();

/** @description HMAC signing secret, reusing the OIDC session secret chain. */
function secret(): string {
  const s =
    process.env.SESSION_SECRET || process.env.AUTH_SESSION_SECRET || process.env.KEYCLOAK_CLIENT_SECRET || '';
  if (!s) throw new Error('TV pairing requires SESSION_SECRET (or AUTH_SESSION_SECRET/KEYCLOAK_CLIENT_SECRET).');
  return s;
}

/** @description Base64url HMAC-SHA256 of `data` under the session secret. */
function sign(data: string): string {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

/**
 * @description Mints a compact signed token (`v1.<payload>.<sig>`) binding a user identity.
 * @param user the authenticated approver (sub required).
 * @returns the signed token string the TV will present as the `oshal_tv` cookie.
 */
function mintToken(user: { iss?: string; sub: string; name?: string; email?: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: TvClaims = {
    ...(user.iss ? { iss: user.iss } : {}),
    sub: user.sub, name: user.name, email: user.email, iat: now, exp: now + TOKEN_TTL_SEC,
    jti: crypto.randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `v1.${payload}.${sign(payload)}`;
}

/** Per-user revocation watermark cache (sub → {min_iat, fetchedAt}). Only read when a TV token
 *  is presented, so this never touches normal session traffic. */
const revCache = new Map<string, { minIat: number; at: number }>();

/**
 * @description Returns the user's revocation watermark (`min_iat`): a token with `iat` below it has
 * been revoked. Cached briefly; fails open (returns 0 = "nothing revoked") on a DB/no-pool error so
 * a transient DB blip can't lock every TV out — the HMAC signature is still verified independently.
 * @param pool optional Postgres pool.
 * @param sub the user sub from the token.
 * @returns the min valid issued-at (epoch seconds), or 0.
 */
async function revocationWatermark(pool: Pool | undefined, sub: string): Promise<number> {
  if (!pool) return 0;
  const cached = revCache.get(sub);
  if (cached && Date.now() - cached.at < REV_CACHE_TTL_MS) return cached.minIat;
  try {
    // SYSTEM identity: this runs in the auth middleware BEFORE any request identity exists, and
    // the table is FORCE-RLS — without the sentinel, guc-strict deny returns no rows and the
    // fail-open default silently disables revocation. The sub is already proven by the token's
    // verified HMAC signature; the read is scoped to exactly that sub.
    const r = await runWithSystemIdentity(() =>
      pool.query('SELECT min_iat FROM tv_token_revocations WHERE user_sub = $1', [sub]),
    );
    const minIat = r.rows[0] ? Number(r.rows[0].min_iat) : 0;
    revCache.set(sub, { minIat, at: Date.now() });
    return minIat;
  } catch (err) {
    logger.warn({ err, sub }, 'TV revocation check failed — failing open');
    return 0;
  }
}

/**
 * @description Verifies a TV token's signature + expiry in constant time.
 * @param token the `oshal_tv` cookie value.
 * @returns the decoded claims when valid, else null.
 */
function verifyToken(token: string): TvClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, sig] = parts;
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TvClaims;
    if (!claims.sub || typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    if (claims.iss !== undefined && !normalizePrincipalIssuer(claims.iss)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** @description Drops expired pairings so the map can't grow unbounded. */
function sweep(): void {
  const now = Date.now();
  for (const [code, p] of pairings) if (p.expiresAt < now) pairings.delete(code);
}

/** @description Generates an unambiguous 8-char user code formatted XXXX-XXXX. */
function genUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return out;
}

/** @description The browser-facing origin used to build the verification URL. */
function appOrigin(req: Request): string {
  return (process.env.APP_URL || `https://${req.hostname}`).replace(/\/$/, '');
}

/**
 * @description Picks the URL a pairing QR encodes. Every target is an auth-gated page on this
 *   origin — the QR carries a place to go, never a secret — and an unknown target falls back to
 *   the TV approval page, the QR's original purpose, rather than encoding the value it was given.
 * @param origin - The app origin the URL is built on (see appOrigin).
 * @param query - The raw query: `target` (`remote` | `cockpit`), `room` (remote only), `code`.
 * @returns The absolute URL to encode.
 */
export function pairingQrUrl(
  origin: string,
  query: { target?: unknown; room?: unknown; code?: unknown },
): string {
  const target = String(query.target || '');
  if (target === 'cockpit') return `${origin}/cockpit/`;
  if (target === 'remote') {
    const room = String(query.room || '').replace(/[^a-z0-9-]/gi, '');
    return `${origin}/api/jarvis/remote` + (room ? `?room=${encodeURIComponent(room)}` : '');
  }
  const code = String(query.code || '').toUpperCase().replace(/\s/g, '');
  return code ? `${origin}/tv?code=${encodeURIComponent(code)}` : `${origin}/tv`;
}

/**
 * @description Reads the TV token from wherever the client put it: the `oshal_tv` cookie (Fire TV
 * WebView via CookieManager), the `X-OSHAL-TV-Token` header, or `Authorization: Bearer` (native
 * Roku, which has no browser cookie jar). Cookie wins when both are present.
 * @param req the incoming request.
 * @returns the raw token string, or undefined when none is present.
 */
function tvTokenFromReq(req: Request): string | undefined {
  const cookie = (req as { cookies?: Record<string, string> }).cookies?.[TV_COOKIE];
  if (cookie) return cookie;
  const hdr = req.headers[TV_HEADER];
  if (typeof hdr === 'string' && hdr) return hdr;
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return undefined;
}

/** @description Pulls the authenticated approver from req.oidc (set by the OIDC session). */
function approver(req: Request): { iss?: string; sub: string; name?: string; email?: string } | null {
  const u = (req as { oidc?: { user?: { sub?: string; oid?: string; name?: string; email?: string } } }).oidc?.user;
  const sub = u?.sub || u?.oid;
  const issuer = getAuthenticatedPrincipalIssuer(req);
  return sub ? { ...(issuer ? { iss: issuer } : {}), sub: String(sub), name: u?.name, email: u?.email } : null;
}

/**
 * @description Global middleware that authenticates a request from the `oshal_tv` cookie when
 * there is no interactive OIDC session, injecting an authenticated `req.oidc` (same shape the
 * MOCK_OIDC path uses). Mount immediately AFTER the OIDC authMiddleware and BEFORE route guards.
 * @returns an Express RequestHandler.
 */
export function createTvTokenAuthMiddleware(pool?: Pool): RequestHandler {
  return async (req, _res, next) => {
    try {
      const existing = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc;
      if (existing?.isAuthenticated?.()) return next();
      const token = tvTokenFromReq(req);
      if (!token) return next();
      const claims = verifyToken(token);
      if (!claims) return next();
      // Reject tokens minted before the user's revocation watermark ("sign out all my TVs").
      if (claims.iat < (await revocationWatermark(pool, claims.sub))) return next();
      (req as { oidc?: unknown }).oidc = {
        isAuthenticated: () => true,
        user: {
          ...(claims.iss ? { iss: claims.iss } : {}),
          sub: claims.sub,
          name: claims.name,
          email: claims.email,
          preferred_username: claims.email,
        },
        idToken: 'tv-token',
        accessToken: 'tv-token',
      };
    } catch (err) {
      logger.error({ err }, 'TV token middleware failed');
    }
    next();
  };
}

/**
 * @description Creates the durable-revocation store if absent. DDL mirrors
 * docker/postgres/migrations/003_tv_token_revocations.sql (that file is not wired into any
 * automated runner, so this lazy chokepoint is the table's only fresh-deploy creation path).
 * @param pool - Postgres pool backing durable token revocation.
 * @returns Resolves when the table + policies exist (or requirements validate in validate-only mode).
 */
export async function ensureTvRevocationSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'tv pairing routes',
    statements: [
      `CREATE TABLE IF NOT EXISTS tv_token_revocations (
        user_sub    TEXT PRIMARY KEY,
        min_iat     BIGINT NOT NULL,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )`,

      /* ── owner-scoped RLS (A1.2): applied at the lazy-DDL chokepoint so a
         fresh database enforces isolation the moment this table is created,
         instead of waiting for migration 060 to re-run (it skips absent tables).
         Inert while the runtime connects as a superuser role. ─────────────── */
      ...buildOwnerRlsPolicyStatements('tv_token_revocations', 'user_sub'),
    ],
    requirements: [{ table: 'tv_token_revocations', columns: ['user_sub', 'min_iat', 'updated_at'] }],
  });
}

/** @description Registers the start/poll (public) + approve/revoke (requiresAuth) endpoints and the
 *  /tv approval page. `pool` (optional) backs durable token revocation. */
export function createTvPairingRoutes(requiresAuth: RequestHandler, pool?: Pool): Router {
  const router = Router();

  // Bootstrap the revocation store non-fatally: revocationWatermark fails open and /revoke
  // returns 500 on a missing table, so pairing itself never depends on this completing.
  if (pool) {
    void ensureTvRevocationSchema(pool).catch((err) => {
      logger.error({ err }, 'tv_token_revocations schema bootstrap failed — revocation stays fail-open');
    });
  }

  router.post('/api/tv/pair/start', (req, res) => {
    sweep();
    const deviceCode = crypto.randomBytes(32).toString('hex');
    let userCode = genUserCode();
    while (pairings.has(userCode)) userCode = genUserCode();
    pairings.set(userCode, { deviceCode, userCode, status: 'pending', expiresAt: Date.now() + PAIRING_TTL_MS });
    logger.info({ userCode }, 'TV pairing started');
    const origin = appOrigin(req);
    res.json({
      user_code: userCode,
      verification_uri: `${origin}/tv`,
      verification_uri_complete: `${origin}/tv?code=${userCode}`,
      qr_url: `${origin}/api/tv/pair/qr?code=${encodeURIComponent(userCode)}`,
      device_code: deviceCode,
      interval: 5,
      expires_in: Math.floor(PAIRING_TTL_MS / 1000),
    });
  });

  // PUBLIC. Renders a scannable QR PNG so a TV (esp. native Roku, which can't draw an SVG) can show
  // a "scan to sign in" code. `?code=` → the /tv approval URL prefilled with the pairing code;
  // `?target=remote` → the Jarvis phone push-to-talk URL; `?target=cockpit` → the installable
  // cockpit (the phone tile on the Get oshal page). Encodes only auth-gated app URLs, no secret.
  router.get('/api/tv/pair/qr', async (req: Request, res: Response) => {
    const url = pairingQrUrl(appOrigin(req), req.query as { target?: unknown; room?: unknown; code?: unknown });
    try {
      const png = await QRCode.toBuffer(url, { type: 'png', margin: 1, width: 480, color: { dark: '#0e0e16', light: '#ffffff' } });
      res.type('png').set('Cache-Control', 'no-store').send(png);
    } catch (err) {
      logger.error({ err }, 'pairing QR render failed');
      res.status(500).end();
    }
  });

  router.post('/api/tv/pair/poll', (req, res) => {
    sweep();
    const deviceCode = String((req.body as { device_code?: string })?.device_code || '');
    const pairing = [...pairings.values()].find((p) => p.deviceCode === deviceCode);
    if (!pairing) return res.json({ status: 'expired' });
    if (pairing.status === 'approved' && pairing.token) {
      pairings.delete(pairing.userCode); // one-time hand-off
      return res.json({ status: 'approved', token: pairing.token });
    }
    return res.json({ status: 'pending' });
  });

  router.post('/api/tv/pair/approve', requiresAuth, (req, res) => {
    sweep();
    const user = approver(req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const code = String((req.body as { user_code?: string })?.user_code || '')
      .toUpperCase()
      .replace(/\s/g, '');
    const pairing = pairings.get(code);
    if (!pairing || pairing.expiresAt < Date.now()) return res.status(404).json({ ok: false, error: 'invalid_or_expired' });
    pairing.status = 'approved';
    pairing.token = mintToken(user);
    logger.info({ userCode: code, sub: user.sub }, 'TV pairing approved');
    res.json({ ok: true });
  });

  // Sign out every TV/Roku the caller has paired: bump their revocation watermark so all existing
  // tokens (iat below now) are rejected by the auth middleware. Durable (Postgres) + cache-busted.
  router.post('/api/tv/pair/revoke', requiresAuth, async (req, res) => {
    const user = approver(req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!pool) return res.status(503).json({ ok: false, error: 'revocation_unavailable' });
    const now = Math.floor(Date.now() / 1000);
    try {
      await pool.query(
        `INSERT INTO tv_token_revocations (user_sub, min_iat, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (user_sub) DO UPDATE SET min_iat = EXCLUDED.min_iat, updated_at = NOW()`,
        [user.sub, now],
      );
      revCache.set(user.sub, { minIat: now, at: Date.now() });
      logger.info({ sub: user.sub }, 'TV tokens revoked for user');
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, sub: user.sub }, 'TV revoke failed');
      res.status(500).json({ ok: false, error: 'revoke_failed' });
    }
  });

  router.get('/tv', requiresAuth, (req, res) => {
    const prefill = String((req.query as { code?: string })?.code || '').toUpperCase();
    res.type('html').send(tvApprovalPage(prefill));
  });

  return router;
}

/** @description The /tv approval page: signed-in user types the TV code and approves it. */
function tvApprovalPage(prefill: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>Connect your TV — OSHAL</title>
<style>body{margin:0;font-family:system-ui,Segoe UI,sans-serif;background:#0e0e16;color:#e6e6f0;display:flex;
min-height:100vh;align-items:center;justify-content:center}.card{background:#15151f;border:1px solid #272735;
border-radius:16px;padding:32px;max-width:420px;width:90%}h1{font-size:20px;margin:0 0 6px}p{color:#8b8ba3;font-size:14px}
input{width:100%;box-sizing:border-box;background:#0e0e16;color:#e6e6f0;border:1px solid #272735;border-radius:10px;
padding:14px;font-size:22px;letter-spacing:3px;text-align:center;text-transform:uppercase;margin:16px 0}
button{width:100%;background:#7c6cff;color:#fff;border:0;border-radius:10px;padding:14px;font-size:16px;font-weight:600;
cursor:pointer}.msg{margin-top:14px;font-size:14px;min-height:20px}.ok{color:#00d3a7}.err{color:#ff6c8b}</style></head>
<body><div class="card"><h1>Connect your Fire TV</h1>
<p>Enter the code shown on your TV to sign it in to OSHAL Home.</p>
<input id="code" maxlength="9" placeholder="XXXX-XXXX" value="${prefill}"/>
<button id="go">Approve TV</button><div class="msg" id="msg"></div></div>
<script>
var btn=document.getElementById('go'),inp=document.getElementById('code'),msg=document.getElementById('msg');
btn.onclick=function(){var code=inp.value.trim().toUpperCase();if(!code){msg.textContent='Enter the code.';msg.className='msg err';return;}
btn.disabled=true;msg.textContent='Approving…';msg.className='msg';
fetch('/api/tv/pair/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user_code:code})})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});})
.then(function(x){if(x.ok&&x.j.ok){msg.textContent='✓ Your TV is connected — it will load in a few seconds.';msg.className='msg ok';}
else{msg.textContent=x.j.error==='invalid_or_expired'?'That code is invalid or expired. Restart on the TV.':'Could not approve. Try again.';msg.className='msg err';btn.disabled=false;}})
.catch(function(){msg.textContent='Network error. Try again.';msg.className='msg err';btn.disabled=false;});};
</script></body></html>`;
}
