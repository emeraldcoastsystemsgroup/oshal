/**
 * Plaid Link connector — the hub's `auth:'link'` mode.
 *
 * Plaid does NOT use a redirect-OAuth handshake. It uses **Link**: a client-side JS widget
 * yields a short-lived `public_token`, which the server exchanges for a long-lived (non-
 * expiring) `access_token`. That is a different auth CEREMONY, not a reason to leave the
 * connector hub — so Plaid is a first-class hub connector with a new `auth:'link'` mode,
 * sibling to the `auth:'token'` paste mode (SmartThings/Twilio/Uber). Its tokens land in the
 * SAME per-user encrypted `oshal_connections` store and are read back through the SAME broker
 * (`getValidAccessToken` / `resolveBotCreds`) as every other connector.
 *
 * This module owns the two Plaid-specific routes the generic `PROVIDERS` machinery can't serve
 * (there is no `authUrl`/`/callback`):
 *   POST /api/connect/plaid/link-token  → create a Link token to initialize the widget for THIS user.
 *   POST /api/connect/plaid/exchange    → exchange the widget's public_token → access_token, store it.
 * The Link WIDGET renders on any surface (e.g. the Finance app), but the connection IDENTITY +
 * TOKEN live in the hub — the surface just POSTs the public_token here. Multiple banks are
 * supported natively: each Plaid Item is its own `access_token` and `item_id`, so `upsertConnection`
 * (keyed on `account_key` = the item_id) adds a distinct labeled connection per institution.
 *
 * Kept separate from connectors-routes.ts (already at the decomposition threshold) so the hub file
 * grows by only a small wiring seam.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Plaid Link connector: auth:'link' mode. POST /plaid/link-token (create) + POST /plaid/exchange (public_token → access_token, institution-labeled, stored in oshal_connections via upsertConnection). isPlaidConfigured() drives the /list card. Corrects ADR-048's app-private oshal_finance_items store: Plaid is now a referenced hub connector.
 *
 * @module connector-plaid-link
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { encryptToken } from './connector-token-crypto';
import { upsertConnection, isTenantMember } from './connector-tenancy';

const logger = createChildLogger({ module: 'connector-plaid-link' });

/** Plaid environment host. Sandbox is the default so the whole link→sync flow is testable
 *  without production access (which needs Plaid's one-time use-case review). */
const PLAID_ENV = (process.env.PLAID_ENV || 'sandbox').toLowerCase();
const PLAID_HOSTS: Record<string, string> = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};
/** Products consented to at link time (read-only aggregation — ADR-048). Env-overridable. */
const PLAID_PRODUCTS = (process.env.PLAID_PRODUCTS || 'transactions,investments').split(/[\s,]+/).filter(Boolean);
const PLAID_COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || 'US').split(/[\s,]+/).filter(Boolean);

/** @description The platform Plaid app credentials (client id + secret). Owned by the operator
 *  under the business email, per the partner-app rule — never a per-user value. */
function plaidCreds(): { clientId: string; secret: string } {
  return { clientId: process.env.PLAID_CLIENT_ID || '', secret: process.env.PLAID_SECRET || '' };
}

/**
 * @description Whether the Plaid connector is usable — i.e. The operator has registered the
 * platform Plaid app and set PLAID_CLIENT_ID + PLAID_SECRET. Unlike a token-paste connector
 * (usable out of the box because the user supplies the token), Link needs the platform app.
 * Drives the `configured` flag on the /utilities Plaid card.
 * @returns true when both PLAID_CLIENT_ID and PLAID_SECRET are set.
 */
export function isPlaidConfigured(): boolean {
  const c = plaidCreds();
  return !!(c.clientId && c.secret);
}

/** @description Resolve the Plaid API host for the configured environment (defaults to sandbox). */
function plaidHost(): string {
  return PLAID_HOSTS[PLAID_ENV] || PLAID_HOSTS.sandbox;
}

/**
 * @description POST a JSON body to a Plaid endpoint with the platform client_id + secret injected.
 * Throws with Plaid's `error_message` (or `error_code`) on a non-2xx so callers fail loudly.
 * @param path - Plaid API path (e.g. '/item/public_token/exchange').
 * @param body - request fields to merge with the injected credentials.
 * @returns the parsed JSON response typed as T.
 */
async function plaidApi<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const c = plaidCreds();
  const r = await fetch(`${plaidHost()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: c.clientId, secret: c.secret, ...body }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(String((j && (j.error_message || j.error_code)) || `plaid ${r.status}`));
  }
  return j as T;
}

/**
 * @description Best-effort human label for a linked Item — the institution name (e.g. "Chase").
 * Non-fatal: a lookup failure just yields null and the connection falls back to a generic label.
 * @param accessToken - the Item's Plaid access token.
 * @returns the institution display name, or null if unavailable.
 */
async function institutionLabel(accessToken: string): Promise<string | null> {
  try {
    const item = await plaidApi<{ item?: { institution_id?: string } }>('/item/get', { access_token: accessToken });
    const instId = item.item?.institution_id;
    if (!instId) return null;
    const inst = await plaidApi<{ institution?: { name?: string } }>(
      '/institutions/get_by_id', { institution_id: instId, country_codes: PLAID_COUNTRY_CODES },
    );
    return inst.institution?.name || null;
  } catch (err) {
    logger.warn({ err }, 'plaid: institution label lookup failed (non-fatal)');
    return null;
  }
}

/** @description The authenticated caller as resolved by the hub (OIDC sub + email), or null. */
type Caller = (req: Request) => { sub: string; email: string } | null;

/**
 * @description Register the Plaid Link routes on the connectors sub-router. Both are auth-gated
 * via the passed `caller` (the hub's OIDC resolver) and 503 when Plaid isn't configured.
 * @param router - the /api/connect sub-router.
 * @param ctx - app context (Postgres pool).
 * @param caller - the hub's authenticated-caller resolver.
 * @returns nothing; mounts POST /plaid/link-token and POST /plaid/exchange.
 */
export function registerPlaidLinkRoutes(router: Router, ctx: AppContext, caller: Caller): void {
  /** POST /api/connect/plaid/link-token — create a Link token to initialize the widget for the caller. */
  router.post('/plaid/link-token', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    if (!isPlaidConfigured()) {
      res.status(503).json({ error: 'Plaid connector is not configured (missing PLAID_CLIENT_ID / PLAID_SECRET)' });
      return;
    }
    try {
      const body: Record<string, unknown> = {
        user: { client_user_id: me.sub },
        client_name: process.env.PLAID_CLIENT_NAME || 'OSHAL Finance',
        products: PLAID_PRODUCTS,
        country_codes: PLAID_COUNTRY_CODES,
        language: 'en',
      };
      // Only sent when the operator has registered an OAuth redirect for OAuth-only banks.
      if (process.env.PLAID_REDIRECT_URI) body.redirect_uri = process.env.PLAID_REDIRECT_URI;
      const out = await plaidApi<{ link_token: string; expiration: string }>('/link/token/create', body);
      logger.info({ sub: me.sub, env: PLAID_ENV }, 'plaid link-token created');
      res.json({ link_token: out.link_token, expiration: out.expiration });
    } catch (err: any) {
      logger.error({ err, sub: me.sub }, 'plaid link-token failed');
      res.status(502).json({ error: err.message || 'link token creation failed' });
    }
  });

  /** POST /api/connect/plaid/exchange — exchange the widget's public_token and store the connection. */
  router.post('/plaid/exchange', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    if (!isPlaidConfigured()) { res.status(503).json({ error: 'Plaid connector is not configured' }); return; }
    const publicToken = String((req.body && req.body.public_token) || '').trim();
    if (!publicToken) { res.status(400).json({ error: 'public_token is required' }); return; }
    // Optional target household (shared) — caller must be a member (ADR-042).
    const tenant = String((req.body && req.body.tenant) || '').trim();
    if (tenant && tenant !== 'personal' && !(await isTenantMember(ctx.pool, tenant, me.sub))) {
      res.status(403).json({ error: 'not a member of that household' }); return;
    }
    const label = String((req.body && req.body.label) || '').trim().slice(0, 60);
    try {
      const ex = await plaidApi<{ access_token: string; item_id: string }>(
        '/item/public_token/exchange', { public_token: publicToken },
      );
      const institution = await institutionLabel(ex.access_token);
      const encAccess = await encryptToken(ctx.pool, me.sub, ex.access_token);
      // No refresh token / no expiry: Plaid access tokens are long-lived and non-expiring, so
      // getValidAccessToken returns this stored token as-is (its no-refresh_token branch).
      await upsertConnection(ctx.pool, {
        userSub: me.sub, userEmail: me.email, provider: 'plaid',
        accountEmail: institution || 'Linked bank', accountId: ex.item_id,
        scopes: PLAID_PRODUCTS.join(' '), encAccess, encRefresh: null, expiry: null,
        tenantId: tenant && tenant !== 'personal' ? tenant : null, connectedBySub: me.sub,
        label: label || institution || null,
      });
      logger.info({ sub: me.sub, itemId: ex.item_id, institution }, 'plaid item linked');
      res.json({ success: true, account: institution || 'Linked bank', itemId: ex.item_id });
    } catch (err: any) {
      logger.error({ err, sub: me.sub }, 'plaid exchange failed');
      res.status(400).json({ error: err.message || 'exchange failed' });
    }
  });
}
