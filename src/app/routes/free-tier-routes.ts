/**
 * Free-tier connect API (ADR-064) — let a signed-in user connect their OWN free tiers
 * across providers (OpenRouter, Gemini/AI Studio, Groq, Cerebras, Mistral) and have the
 * platform rotate across them. Mounted at /api/connect/free-tier (requiresAuth) BEFORE the
 * generic /api/connect/:provider routes so these paths resolve here.
 *
 * Surface:
 *   GET  /catalog                       — the connectable providers (for the connect UI)
 *   GET  /list                          — the caller's connections + rotation status (no keys)
 *   POST /connect  {providerId,apiKey,model?,label?,tenant?} — validate live, then store
 *   POST /test     {connectionId} | {providerId,apiKey,model} — round-trip a connection
 *   GET  /resolve                       — preview the NEXT rotation pick (provider/model/host; no key)
 *   DELETE /:connectionId               — disconnect
 *   GET  /openrouter/oauth/start        — begin OpenRouter PKCE connect
 *   GET  /openrouter/oauth/callback     — finish it (exchange code -> key -> store)
 *
 * "No connectors to nowhere": every save is validated by a REAL chat-completion round-trip
 * (fail closed, like byo-llm / the SmartThings token paste), so a stored connection is a
 * usable model, not a dead key. Keys are AES-GCM encrypted per-user via the shared connector
 * rails and never returned to the client.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — catalog/list/connect/test/resolve/delete + OpenRouter PKCE OAuth for ADR-064.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | OAuth callback lands back on /free-models (?connected= success banner / ?connect_error= readable failure banner) instead of dumping to /cockpit/ or a bare-text 400 — the free-credits click-through returns the user to the page they started from.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | OAuth start accepts ?return= and the callback honours it, so the free lanes can be connected from EITHER surface (they are now first-class cards on /utilities next to Claude/Codex, not only the standalone /free-models page). The return path rides a cookie beside the PKCE verifier (OpenRouter's callback_url cannot carry extra params) and is ALLOWLISTED, not sanitized — it feeds res.redirect, so a permissive check would be an open redirect.
 *
 * @module free-tier-routes
 */

import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { encryptToken } from './connector-token-crypto';
import {
  accessibleConnections, upsertConnection, isTenantMember, ownerSub,
} from './connector-tenancy';
import { decryptToken } from './connector-token-crypto';
import {
  FREE_PROVIDERS, getFreeProvider, providerColumnFor, freeIdFromProviderColumn, hostOf,
  OPENROUTER_OAUTH,
} from './free-tier-providers';
import {
  ensureFreeTierSchema, listFreeTierConnections, getFreeTierConnection, deleteState,
} from './free-tier-rotation';

const logger = createChildLogger({ module: 'free-tier-routes' });

/** The signed-in caller (sub + email) from the OIDC session, or null. */
function caller(req: Request): { sub: string; email: string } | null {
  const oidc = (req as any).oidc;
  if (!oidc || typeof oidc.isAuthenticated !== 'function' || !oidc.isAuthenticated()) return null;
  const u = oidc.user || {};
  const sub = u.sub || u.oid;
  if (!sub) return null;
  return { sub: String(sub), email: String(u.email || u.preferred_username || '') };
}

/**
 * @description Minimal OpenAI-compatible chat completion against a free-tier endpoint, used
 * to VALIDATE a key on save and to power Test. Throws a human-readable message on non-2xx.
 * @param baseUrl @param apiKey @param model @param prompt @param maxTokens
 * @returns { reply, ms }
 */
async function chatComplete(
  baseUrl: string, apiKey: string, model: string, prompt: string, maxTokens: number,
): Promise<{ reply: string; ms: number }> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens, temperature: 0, stream: false,
      }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`provider returned ${r.status}: ${text.slice(0, 240)}`);
    let reply = '';
    try {
      const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
      reply = j.choices?.[0]?.message?.content || '';
    } catch { /* a 2xx is still a pass even if the body is stream-wrapped */ }
    return { reply, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve + persist a validated free-tier connection. Shared by paste-connect and OAuth. */
async function saveConnection(
  ctx: AppContext, me: { sub: string; email: string },
  providerId: string, apiKey: string, model: string, label: string, tenant: string,
): Promise<{ providerId: string; model: string; host: string }> {
  const prov = getFreeProvider(providerId);
  if (!prov) throw new Error(`unknown free-tier provider '${providerId}'`);
  const chosenModel = (model || '').trim() || prov.freeModels[0];
  if (tenant && tenant !== 'personal' && !(await isTenantMember(ctx.pool, tenant, me.sub))) {
    throw new Error('not a member of that household');
  }
  // Fail closed: prove key+model answer before we persist.
  await chatComplete(prov.baseUrl, apiKey, chosenModel, 'ping', 1);
  const encAccess = await encryptToken(ctx.pool, me.sub, apiKey);
  await upsertConnection(ctx.pool, {
    userSub: me.sub, userEmail: me.email, provider: providerColumnFor(prov.id),
    accountEmail: `${prov.label} (free)`, accountId: prov.baseUrl, scopes: chosenModel,
    encAccess, encRefresh: null, expiry: null,
    tenantId: tenant && tenant !== 'personal' ? tenant : null, connectedBySub: me.sub,
    label: (label || '').trim().slice(0, 60) || prov.label,
  });
  logger.info({ sub: me.sub, providerId: prov.id, model: chosenModel }, 'free-tier connection saved');
  return { providerId: prov.id, model: chosenModel, host: hostOf(prov.baseUrl) };
}

// ── OpenRouter PKCE state (in-memory; single-process v1) ────────────────────────
//
// The verifier is stored in a short-lived httpOnly cookie that survives the redirect, so
// no shared server state is needed across the start/callback hop. Endpoints verified against
// OpenRouter's OAuth-PKCE docs 2026-06-21 (see OPENROUTER_OAUTH for the callback-URL port
// constraint). Paste-key (/connect) is the guaranteed fallback if a callback origin is rejected.

const PKCE_COOKIE = 'or_pkce';
/** Where to send the user after the OAuth round-trip (they can start from either surface). */
const RETURN_COOKIE = 'or_return';

/** Surfaces that render the free-lane cards and read the `?connected=` / `?connect_error=` banner. */
const RETURN_ALLOWED = ['/free-models', '/utilities'];
const RETURN_DEFAULT = '/free-models';

/**
 * @description Constrain the post-OAuth redirect to a known in-app surface. An ALLOWLIST, not a
 * sanitizer: anything unrecognized (absent, another origin, `//evil.com`, a path with a query or
 * fragment) collapses to the default. This value comes from a query param and lands in a
 * `res.redirect`, so a permissive check here would be an open redirect.
 * @param raw - the candidate path (from `?return=` or the return cookie)
 * @returns an allowlisted absolute path
 */
export function safeReturnPath(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return RETURN_ALLOWED.includes(v) ? v : RETURN_DEFAULT;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Read a cookie value off the request (works with or without cookie-parser). */
function readCookie(req: Request, name: string): string {
  const fromParser = (req as any).cookies?.[name];
  if (typeof fromParser === 'string') return fromParser;
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

/** Absolute base URL for building the OAuth callback (honors a configured public origin). */
function baseUrlOf(req: Request): string {
  const configured = (process.env.OSHAL_BASE_URL || process.env.BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * @description Free-tier connect sub-router (mounted at /api/connect/free-tier, requiresAuth).
 * @param ctx - app context (db pool)
 * @returns an Express router
 */
export function createFreeTierRoutes(ctx: AppContext): Router {
  const router = Router();
  ensureFreeTierSchema(ctx.pool).catch((err) => logger.error({ err }, 'Failed to ensure free-tier schema'));

  /** GET /catalog — the connectable providers (no secrets). */
  router.get('/catalog', (_req: Request, res: Response) => {
    const providers = Object.values(FREE_PROVIDERS).map((p) => ({
      id: p.id, label: p.label, host: hostOf(p.baseUrl), freeModels: p.freeModels,
      keyHelpUrl: p.keyHelpUrl, oauth: p.oauth, note: p.note,
      freeBlurb: p.freeBlurb, howTo: p.howTo,
      oauthStartPath: p.oauth ? `/api/connect/free-tier/${p.id}/oauth/start` : null,
    }));
    res.json({ providers });
  });

  /** GET /list — the caller's free-tier connections + rotation status + a capacity summary. */
  router.get('/list', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const connections = await listFreeTierConnections(ctx.pool, me.sub);
    const active = connections.filter((c) => !c.cooledDown).length;
    res.json({
      connections,
      summary: { connected: connections.length, active, cooledDown: connections.length - active },
    });
  });

  /** POST /connect — validate against the live provider, then store (encrypted, per-user). */
  router.post('/connect', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const providerId = String(req.body?.providerId || '').trim().toLowerCase();
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!getFreeProvider(providerId)) { res.status(400).json({ error: 'unknown providerId' }); return; }
    if (!apiKey) { res.status(400).json({ error: 'API key is required' }); return; }
    try {
      const out = await saveConnection(
        ctx, me, providerId, apiKey,
        String(req.body?.model || ''), String(req.body?.label || ''), String(req.body?.tenant || '').trim(),
      );
      res.json({ success: true, ...out });
    } catch (err: any) {
      logger.warn({ err, sub: me.sub, providerId }, 'free-tier connect failed');
      res.status(400).json({ error: err.message || 'connect validation failed' });
    }
  });

  /** POST /test — round-trip a stored connection (by id) or pasted { providerId, apiKey, model }. */
  router.post('/test', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    try {
      const conn = await resolveTestConn(ctx.pool, me.sub, req.body || {});
      if (!conn) { res.status(404).json({ error: 'no connection to test' }); return; }
      const { reply, ms } = await chatComplete(
        conn.baseUrl, conn.apiKey, conn.model, 'Reply with exactly: OSHAL connected.', 32);
      res.json({ success: true, reply: reply.trim(), ms, providerId: conn.providerId, model: conn.model });
    } catch (err: any) {
      logger.warn({ err, sub: me.sub }, 'free-tier test failed');
      res.status(400).json({ error: err.message || 'test failed' });
    }
  });

  /** GET /resolve — preview the NEXT rotation pick (provider/model/host only; never the key).
   *  This is the read-only window onto the seam the execution layer uses. */
  router.get('/resolve', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const providerId = String(req.query.providerId || '').trim().toLowerCase() || undefined;
    const conn = await getFreeTierConnection(ctx.pool, me.sub, providerId ? { providerId } : undefined);
    if (!conn) { res.json({ resolved: false, reason: 'no usable free-tier connection (none connected or all cooling down)' }); return; }
    res.json({
      resolved: true,
      connectionId: conn.connectionId, providerId: conn.providerId,
      clineProvider: conn.clineProvider, model: conn.model, host: hostOf(conn.baseUrl),
    });
  });

  /** DELETE /:connectionId — disconnect a free-tier connection the caller can see. */
  router.delete('/:connectionId', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const connectionId = String(req.params.connectionId || '');
    const rows = await accessibleConnections(ctx.pool, me.sub);
    const row = rows.find((r) => r.connection_id === connectionId && (r.provider || '').startsWith('free:'));
    if (!row) { res.status(404).json({ error: 'connection not found' }); return; }
    await ctx.pool.query('DELETE FROM oshal_connections WHERE connection_id = $1', [connectionId]);
    await deleteState(ctx.pool, connectionId);
    res.json({ success: true });
  });

  // ── OpenRouter OAuth (PKCE) ───────────────────────────────────────────────────

  /** GET /openrouter/oauth/start — redirect to OpenRouter to approve a provisioned key.
   *  `?return=/utilities` sends the user back where they started (the free lanes now live on
   *  BOTH /utilities and /free-models). OpenRouter's callback_url can't carry extra params, so
   *  the return path rides a cookie next to the PKCE verifier. */
  router.get('/openrouter/oauth/start', (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const callbackUrl = `${baseUrlOf(req)}/api/connect/free-tier/openrouter/oauth/callback`;
    const cookieOpts = {
      httpOnly: true, sameSite: 'lax' as const, maxAge: 10 * 60_000,
      path: '/api/connect/free-tier/openrouter',
    };
    res.cookie(PKCE_COOKIE, verifier, cookieOpts);
    res.cookie(RETURN_COOKIE, safeReturnPath(req.query.return), cookieOpts);
    const url = new URL(OPENROUTER_OAUTH.authUrl);
    url.searchParams.set('callback_url', callbackUrl);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    res.redirect(url.toString());
  });

  /** GET /openrouter/oauth/callback — exchange the code for a key, validate, and store it. */
  router.get('/openrouter/oauth/callback', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const code = String(req.query.code || '').trim();
    const verifier = readCookie(req, PKCE_COOKIE);
    const back = safeReturnPath(readCookie(req, RETURN_COOKIE));
    res.clearCookie(PKCE_COOKIE, { path: '/api/connect/free-tier/openrouter' });
    res.clearCookie(RETURN_COOKIE, { path: '/api/connect/free-tier/openrouter' });
    if (!code || !verifier) {
      res.redirect(`${back}?connect_error=${encodeURIComponent('missing code or verifier — start the connect again from this page')}`);
      return;
    }
    try {
      const r = await fetch(OPENROUTER_OAUTH.keyExchangeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`key exchange returned ${r.status}: ${text.slice(0, 200)}`);
      const key = (JSON.parse(text) as { key?: string }).key || '';
      if (!key) throw new Error('OpenRouter returned no key');
      await saveConnection(ctx, me, 'openrouter', key, '', 'OpenRouter', '');
      // Land back where the user started (/utilities or /free-models) with a success banner —
      // the card copy promises "You land back here, connected", and /cockpit/ never rendered
      // the old query flag.
      res.redirect(`${back}?connected=openrouter`);
    } catch (err: any) {
      logger.warn({ err, sub: me.sub }, 'OpenRouter OAuth callback failed');
      // Back to the page they started from with a readable banner — the old bare-text 400
      // told the user to POST to an API path by hand.
      res.redirect(`${back}?connect_error=${encodeURIComponent(String(err.message || 'unknown error').slice(0, 180))}`);
    }
  });

  return router;
}

/** Resolve the connection a /test should exercise: pasted creds win (test-before-save);
 *  otherwise the stored connection by id. Returns { baseUrl, apiKey, model, providerId } or null. */
async function resolveTestConn(
  pool: any, userSub: string, body: Record<string, any>,
): Promise<{ baseUrl: string; apiKey: string; model: string; providerId: string } | null> {
  const providerId = String(body.providerId || '').trim().toLowerCase();
  const pastedKey = String(body.apiKey || '').trim();
  if (providerId && pastedKey) {
    const prov = getFreeProvider(providerId);
    if (!prov) return null;
    return { baseUrl: prov.baseUrl, apiKey: pastedKey, model: String(body.model || '').trim() || prov.freeModels[0], providerId };
  }
  const connectionId = String(body.connectionId || '').trim();
  if (!connectionId) return null;
  const rows = await accessibleConnections(pool, userSub);
  const row = rows.find((r) => r.connection_id === connectionId && (r.provider || '').startsWith('free:'));
  if (!row || !row.access_token || !row.scopes) return null;
  const id = freeIdFromProviderColumn(row.provider);
  const prov = getFreeProvider(id);
  if (!prov) return null;
  const apiKey = await decryptToken(pool, ownerSub(row), row.access_token);
  return { baseUrl: prov.baseUrl, apiKey, model: row.scopes, providerId: id };
}
