/**
 * Bring-Your-Own-LLM connector — per-user "any API, any LLM" connection.
 *
 * This is OSHAL's vendor-neutral selling point made into a first-class connector on
 * the Utilities/Connections page (parallel to Gmail/SmartThings/etc.), NOT a global
 * provider setting. A signed-in user pastes ANY OpenAI-compatible endpoint:
 *   { label, baseUrl, apiKey, model }
 * and we store it the same way as every other connector — per-user, AES-GCM encrypted
 * (only the API key; the base URL + model are not secrets) in oshal_connections under
 * the synthetic provider id `any-llm`. We reuse the connector storage columns directly:
 * for an LLM the "account" IS the endpoint, so account_id = base URL (the per-account
 * uniqueness key) and scopes = model; the encrypted access_token holds the API key.
 * The generic disconnect / relabel / make-default rails in connectors-routes.ts then
 * work for these rows for free.
 *
 * "No connectors to nowhere": a save is validated by a REAL chat-completion round-trip
 * against the endpoint (fails closed, like the SmartThings token paste), so a stored
 * connection is provably a usable model — not a dead credential.
 *
 * getUserLlmConnection() is the resolution seam the execution wiring (next step) calls
 * to run a bot's inference against the caller's own endpoint+key+model.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial Bring-Your-Own-LLM connector: POST /save (live chat-completion validation + per-user encrypted store), POST /test (round-trip ping), GET /models (endpoint model list), buildAnyLlmListEntry() for the /list surface, and getUserLlmConnection() resolution seam. Reuses connector-token-crypto + connector-tenancy so disconnect/relabel/default come from the shared rails.
 * -----------------------------------------------------------------------------
 *
 * @module byo-llm-routes
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { encryptToken, decryptToken } from './connector-token-crypto';
import { assertPublicHttpUrl } from '@/shared/security/ssrf-guard';
import { redactEgress } from '@/features/governance';
import {
  accessibleConnections, resolveConnectionRow, upsertConnection, isTenantMember,
  ownerSub, type ConnectionRow, type ConnectionSelector,
} from './connector-tenancy';

const logger = createChildLogger({ module: 'byo-llm-routes' });

/** Synthetic provider id for the per-user bring-your-own-LLM connection. */
export const ANY_LLM_PROVIDER = 'any-llm';

/** A resolved BYO-LLM connection — the three values a harness needs to call the endpoint. */
export interface ByoLlmConnection {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** The signed-in caller (sub + email) from the OIDC session, or null. */
function caller(req: Request): { sub: string; email: string } | null {
  const oidc = (req as any).oidc;
  if (!oidc || typeof oidc.isAuthenticated !== 'function' || !oidc.isAuthenticated()) return null;
  const u = oidc.user || {};
  const sub = u.sub || u.oid;
  if (!sub) return null;
  return { sub: String(sub), email: String(u.email || u.preferred_username || '') };
}

/** Normalize an OpenAI-compatible base URL: trim, drop a trailing slash, and strip a
 *  trailing /chat/completions or /models the user may have pasted by mistake. */
function normalizeBaseUrl(raw: string): string {
  let u = String(raw || '').trim().replace(/\s+/g, '');
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/(chat\/completions|completions|models)$/i, '');
  return u;
}

/** Short host label for display (e.g. "gpt-4o-mini @ api.openai.com"). */
function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

/**
 * @description Run a minimal OpenAI-compatible chat completion against an endpoint.
 * Used both to VALIDATE a connection on save and to power the Test button. Throws with
 * a human-readable message on a non-2xx response so the UI can show why it failed.
 * @param conn - { baseUrl, apiKey, model }
 * @param prompt - the user/probe message
 * @param maxTokens - cap on the reply (small for validation)
 * @returns the assistant reply text (may be empty) and the round-trip latency in ms
 */
async function chatComplete(
  conn: ByoLlmConnection, prompt: string, maxTokens: number,
): Promise<{ reply: string; ms: number }> {
  const started = Date.now();
  // SSRF guard: reject endpoints that resolve to internal/metadata/loopback addresses.
  await assertPublicHttpUrl(conn.baseUrl);
  // DLP egress guard: screen the outbound prompt before it leaves the box. No-op unless
  // OSHAL_DLP_MODE is set; in 'block' mode a finding refuses the send, in 'mask' mode the
  // sensitive spans are replaced with typed placeholders. This is the LLM egress chokepoint.
  const dlp = redactEgress(prompt);
  if (dlp.blocked) {
    throw new Error(`DLP blocked egress: ${dlp.findings.map((f) => f.kind).join(', ')}`);
  }
  prompt = dlp.redacted;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(`${conn.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
      body: JSON.stringify({
        model: conn.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`endpoint returned ${r.status}: ${text.slice(0, 240)}`);
    let reply = '';
    try {
      const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
      reply = j.choices?.[0]?.message?.content || '';
    } catch { /* some gateways stream-wrap; a 2xx is still a pass */ }
    return { reply, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @description The /api/connect/list entry for the BYO-LLM connector, built from the
 * caller's already-fetched connection rows (no extra query). Shape matches the OAuth
 * connectors so the page renders it in the same grid; auth:'llm' tells the UI to show
 * the base-URL/model/key form instead of a Connect button.
 * @param rows - the caller's accessible connection rows (any provider; filtered here)
 * @returns the provider list entry for the any-llm connector
 */
export function buildAnyLlmListEntry(rows: ConnectionRow[]): Record<string, unknown> {
  const conns = rows.filter((r) => r.provider === ANY_LLM_PROVIDER);
  return {
    id: ANY_LLM_PROVIDER,
    label: 'Bring Your Own LLM',
    category: 'llm',
    auth: 'llm',
    configured: true, // the user supplies the endpoint — nothing to register server-side
    tokenHelpUrl: null,
    tokenFallback: false,
    connected: conns.length > 0,
    connections: conns.map((c) => ({
      connectionId: c.connection_id,
      label: c.label,
      account: c.account_email,        // "model @ host"
      baseUrl: c.account_id,           // the endpoint
      model: c.scopes,                 // the model id
      tenantId: c.tenant_id || null,
      isDefault: c.is_default,
    })),
    status: conns.length ? 'connected' : 'not_connected',
  };
}

/**
 * @description Resolve the caller's BYO-LLM connection (decrypted) for use by a harness.
 * Honors the same selectors (connectionId / label / tenant) as the other connectors and
 * the personal∪shared, default-first resolution. Returns null if none configured.
 * @param pool - pg pool
 * @param userSub - the caller's OIDC sub
 * @param opts - optional connection selector
 * @returns { baseUrl, model, apiKey } or null
 */
export async function getUserLlmConnection(
  pool: any, userSub: string, opts?: ConnectionSelector,
): Promise<ByoLlmConnection | null> {
  const row = await resolveConnectionRow(pool, userSub, ANY_LLM_PROVIDER, opts);
  if (!row || !row.account_id || !row.scopes || !row.access_token) return null;
  const apiKey = await decryptToken(pool, ownerSub(row), row.access_token);
  return { baseUrl: row.account_id, model: row.scopes, apiKey };
}

/** Read + decrypt the caller's stored API key for a given endpoint (for blank-key re-saves
 *  and key-less Test/Models calls). Returns '' if no matching connection exists. */
async function storedKeyFor(pool: any, userSub: string, baseUrl: string): Promise<string> {
  const rows = await accessibleConnections(pool, userSub, ANY_LLM_PROVIDER);
  const row = rows.find((r) => r.account_id === baseUrl) || rows.find((r) => r.is_default) || rows[0];
  if (!row?.access_token) return '';
  try { return await decryptToken(pool, ownerSub(row), row.access_token); } catch { return ''; }
}

/**
 * @description BYO-LLM connector sub-router (mounted at /api/connect/any-llm, requiresAuth).
 * @param ctx - app context (db pool)
 * @returns an Express router
 */
export function createByoLlmRoutes(ctx: AppContext): Router {
  const router = Router();

  /** POST /save — validate against the live endpoint, then store (encrypted, per-user). */
  router.post('/save', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
    const model = String(req.body?.model || '').trim();
    const label = String(req.body?.label || '').trim().slice(0, 60);
    let apiKey = String(req.body?.apiKey || '').trim();
    if (!/^https?:\/\//i.test(baseUrl)) { res.status(400).json({ error: 'base URL must start with http(s)://' }); return; }
    if (!model) { res.status(400).json({ error: 'model name is required' }); return; }
    // Blank key on re-save = keep the key already on file for this endpoint.
    if (!apiKey) apiKey = await storedKeyFor(ctx.pool, me.sub, baseUrl);
    if (!apiKey) { res.status(400).json({ error: 'API key is required' }); return; }
    const tenant = String(req.body?.tenant || '').trim();
    if (tenant && tenant !== 'personal' && !(await isTenantMember(ctx.pool, tenant, me.sub))) {
      res.status(403).json({ error: 'not a member of that household' }); return;
    }
    try {
      // Fail closed: prove the endpoint+key+model actually answer before we persist.
      await chatComplete({ baseUrl, model, apiKey }, 'ping', 1);
      const encAccess = await encryptToken(ctx.pool, me.sub, apiKey);
      await upsertConnection(ctx.pool, {
        userSub: me.sub, userEmail: me.email, provider: ANY_LLM_PROVIDER,
        accountEmail: `${model} @ ${hostOf(baseUrl)}`, accountId: baseUrl, scopes: model,
        encAccess, encRefresh: null, expiry: null,
        tenantId: tenant && tenant !== 'personal' ? tenant : null, connectedBySub: me.sub, label: label || null,
      });
      logger.info({ sub: me.sub, host: hostOf(baseUrl), model }, 'BYO-LLM connection saved');
      res.json({ success: true, model, host: hostOf(baseUrl) });
    } catch (err: any) {
      logger.error({ err, sub: me.sub, host: hostOf(baseUrl) }, 'BYO-LLM save validation failed');
      res.status(400).json({ error: err.message || 'endpoint validation failed' });
    }
  });

  /** POST /test — run a real prompt through a stored connection (or pasted creds). */
  router.post('/test', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    try {
      const conn = await resolveTestConn(ctx.pool, me.sub, req.body || {});
      if (!conn) { res.status(404).json({ error: 'no connection to test' }); return; }
      const { reply, ms } = await chatComplete(conn, 'Reply with exactly: OSHAL connected.', 32);
      res.json({ success: true, reply: reply.trim(), ms, model: conn.model, host: hostOf(conn.baseUrl) });
    } catch (err: any) {
      logger.warn({ err, sub: me.sub }, 'BYO-LLM test failed');
      res.status(400).json({ error: err.message || 'test failed' });
    }
  });

  /** GET /models?baseUrl=&apiKey= — list model ids the endpoint exposes (to help pick). */
  router.get('/models', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const baseUrl = normalizeBaseUrl(String(req.query.baseUrl || ''));
    if (!/^https?:\/\//i.test(baseUrl)) { res.status(400).json({ error: 'base URL must start with http(s)://' }); return; }
    let apiKey = String(req.query.apiKey || '').trim();
    if (!apiKey) apiKey = await storedKeyFor(ctx.pool, me.sub, baseUrl);
    try {
      // SSRF guard: reject endpoints that resolve to internal/metadata/loopback addresses.
      await assertPublicHttpUrl(baseUrl);
      const r = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!r.ok) { res.status(400).json({ error: `endpoint returned ${r.status}` }); return; }
      const j = (await r.json()) as { data?: Array<{ id?: string }> };
      const models = (j.data || []).map((m) => m.id).filter(Boolean).slice(0, 200);
      res.json({ models });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'could not list models' });
    }
  });

  return router;
}

/** Resolve the connection a /test call should exercise: pasted { baseUrl, apiKey, model }
 *  win (lets the user test before saving); otherwise the stored connection by id/default. */
async function resolveTestConn(
  pool: any, userSub: string, body: Record<string, any>,
): Promise<ByoLlmConnection | null> {
  const baseUrl = normalizeBaseUrl(body.baseUrl || '');
  const model = String(body.model || '').trim();
  let apiKey = String(body.apiKey || '').trim();
  if (baseUrl && model) {
    if (!apiKey) apiKey = await storedKeyFor(pool, userSub, baseUrl);
    if (apiKey) return { baseUrl, model, apiKey };
  }
  const sel: ConnectionSelector = { connectionId: String(body.connectionId || '').trim() || undefined };
  return getUserLlmConnection(pool, userSub, sel);
}
