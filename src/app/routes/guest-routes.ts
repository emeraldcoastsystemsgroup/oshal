/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guest-mode entry routes (Phase 1). Public `/guest` landing with a "Continue as guest" button, plus POST /api/guest/start (mint cookie → cockpit) and POST /api/guest/end (clear). All inert (404) when ENABLE_GUEST_MODE is off.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | `?next=<relative-path>` deep links: /guest carries a sanitized next through the start form (action query string, so no body-parser dependency) and /api/guest/start redirects there instead of /cockpit/; an already-authenticated visitor (guest or real) hitting /guest with a next skips the landing entirely. Lets the marketing sites deep-link a specific app surface (e.g. ?app=jarvis) through the guest gate instead of bouncing anonymous visitors to Google login. next is same-origin only: must start with a single '/', no '\', no CR/LF, ≤300 chars — else ignored.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { isGuestModeEnabled, setGuestCookie, clearGuestCookie } from '@/shared/middleware/guest-session';
import { seedGuestDemoData } from './guest-demo-seed';

const logger = createChildLogger({ module: 'guest-routes' });

/**
 * @description Same-origin sanitizer for the `next` deep-link target. Accepts only a
 * relative path: single leading '/', no '//' (protocol-relative), no '\', no CR/LF,
 * bounded length. Anything else returns null and callers fall back to /cockpit/.
 * @param raw - Candidate from the query string.
 * @returns The safe path, or null.
 */
function sanitizeNext(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (/[\\\r\n]/.test(raw)) return null;
  return raw;
}

/** HTML-escape for attribute interpolation in the landing template. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * @description Renders the guest landing card. The optional `next` rides the form's
 * action query string (not a body field) so no urlencoded body parser is needed.
 * @param next - Sanitized same-origin path the started session should land on.
 */
function guestLandingHtml(next: string | null): string {
  const action = next ? `/api/guest/start?next=${encodeURIComponent(next)}` : '/api/guest/start';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Try OSHAL</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; font-family:Inter,system-ui,sans-serif;
         background:#0b1220; color:#e6edf6; }
  .card { max-width:420px; padding:40px 36px; text-align:center; background:#101a2e; border:1px solid #1e2c47;
          border-radius:16px; box-shadow:0 20px 60px rgba(0,0,0,.4); }
  h1 { margin:0 0 8px; font-size:22px; }
  p { margin:0 0 24px; color:#9fb0c8; line-height:1.5; font-size:14px; }
  button { width:100%; padding:13px 16px; font-size:15px; font-weight:600; border:0; border-radius:10px;
           cursor:pointer; background:#10b981; color:#06231a; }
  button:hover { background:#0ea372; }
  .alt { display:block; margin-top:16px; color:#7d8ea8; text-decoration:none; font-size:13px; }
  .alt:hover { color:#9fb0c8; }
</style></head>
<body>
  <div class="card">
    <h1>Take a look around</h1>
    <p>Continue as a guest to explore OSHAL. Guest sessions are read-only across most apps &mdash; nothing you do affects real accounts, money, or external services.</p>
    <form method="POST" action="${escapeHtml(action)}">
      <button type="submit">Continue as guest</button>
    </form>
    <a class="alt" href="/login">Sign in with your account instead</a>
  </div>
</body></html>`;
}

/**
 * @description Registers the public guest landing page + guest session endpoints.
 * Returns a router whose handlers 404 when guest mode is disabled.
 */
export function createGuestRoutes(pool?: Pool): Router {
  const router = Router();

  const guard = (_req: Request, res: Response, nextFn: () => void): void => {
    if (!isGuestModeEnabled()) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    nextFn();
  };

  // Public landing — a friend who doesn't want to hand over a Google account.
  // ?next=<relative-path> deep-links a specific surface through the guest gate; an
  // already-authenticated visitor (guest cookie or real session) skips the landing.
  router.get('/guest', guard, (req, res) => {
    const next = sanitizeNext((req.query as Record<string, unknown>).next);
    const authed = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.();
    if (next && authed) {
      res.redirect(302, next);
      return;
    }
    res.type('html').send(guestLandingHtml(next));
  });

  // Mint a fresh per-browser guest identity and drop them into the cockpit (or the
  // sanitized ?next= surface the landing carried through its form action).
  router.post('/api/guest/start', guard, (req, res) => {
    const sub = setGuestCookie(req, res);
    if (!sub) {
      res.status(503).json({ error: 'guest_unavailable', message: 'Guest mode is not configured.' });
      return;
    }
    const next = sanitizeNext((req.query as Record<string, unknown>).next) ?? '/cockpit/';
    logger.info({ sub, next }, 'Guest session started');
    // Plant the shared fake finance account so the read-only Finance app shows data.
    // Fire-and-forget — never block the redirect on a seed hiccup.
    if (pool) void seedGuestDemoData(pool, sub);
    res.redirect(302, next);
  });

  // End a guest session (clears the cookie).
  router.post('/api/guest/end', guard, (_req, res) => {
    clearGuestCookie(res);
    res.json({ ok: true });
  });

  return router;
}
