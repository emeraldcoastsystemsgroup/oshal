/**
 * DevOps Routes — DevOps + Vault swarm console (ACTIVATED, ADR-040).
 *
 * No longer a facade. Serves the live DevOps/Vault control console (src/api/devops-vault.html)
 * AND the superadmin-gated JSON API behind it: Vault KV secret management plus the credential
 * broker (mint short-TTL scoped creds → inspect → revoke) and the database dynamic-secrets
 * engine, all executed via VaultConsoleService against the configured HashiCorp Vault.
 *
 * Access model — this operates the OPERATOR's infrastructure Vault, so every data/action
 * endpoint is `requireSuperAdmin`-gated (OSHAL_DEV_CONSOLE_ENABLED + the super-admin allowlist,
 * fail-closed) — NOT merely authenticated. Mutating endpoints additionally require an explicit
 * `confirm: true` (positive-signal write guard) and are written to the governance audit trail.
 * The `/console` HTML itself is served to any authed caller; it calls GET /access first and
 * shows a "super-admin required" state instead of broken controls when the caller isn't gated.
 * The Vault token stays in the controller env (VAULT_TOKEN) and never reaches the browser.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — serves the DevOps + Vault control-panel facade at GET /api/devops/console (auth-gated, mounted at /api/devops).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ACTIVATE (ADR-040): the console is live. Superadmin-gated + audited JSON API (status / kv read·write·list / policy / issue / lookup / revoke / setup-db) via VaultConsoleService; mutations require confirm:true; GET /access reports the caller's superadmin status so the surface can gate itself.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Live process trace: GET /trace/stream (superadmin SSE, OWNER-SCOPED via devopsTraceHub — a subscriber only ever receives its own actor's frames, the deliberate answer to the old cross-bot SSE fan-out). Every action publishes a trace frame (mutations: start→ok/error; reads: info) with a SECRET-REDACTED summary so the console reflects everything live without leaking secret values.
 *
 * @module devops-routes
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { VaultConsoleService, devopsTraceHub, type TraceFrame } from '@/features/devops-vault';
import { evaluateSuperAdmin, type RequestWithSuperAdmin } from '@/shared/middleware/superadmin';
import { emitAuditEvent } from '@/features/governance';
import { confirmationRequiredPayload, hasExplicitWriteConfirmation } from '@/shared/security/explicit-write-confirmation';

const logger = createChildLogger({ module: 'devops-routes' });

/**
 * @description Builds the DevOps/Vault console router (mount at /api/devops, requiresAuth).
 * @param ctx - app context (Postgres pool for the audit trail).
 * @param apiDir - directory holding the HTML surfaces (devops-vault.html).
 * @returns Express router serving the live, superadmin-gated Vault console.
 */
export function createDevopsRoutes(ctx: AppContext, apiDir: string): Router {
  const router = Router();

  /** Superadmin gate for every data/action endpoint (fail-closed); logs + returns 403 on deny. */
  const requireSuperAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const decision = evaluateSuperAdmin(req);
    (req as RequestWithSuperAdmin).superAdminDecision = decision;
    if (decision.allowed) { next(); return; }
    logger.warn({ reason: decision.reason, path: req.path, method: req.method }, 'DevOps/Vault console access denied');
    res.status(403).json({ error: 'Super-admin privilege required', reason: decision.reason });
  };

  /** The caller's super-admin sub (for audit + trace owner-scope); the gate guarantees it. */
  const actor = (req: Request): string => (req as RequestWithSuperAdmin).superAdminDecision?.sub ?? '';

  /** Emit one owner-scoped trace frame for the acting superadmin. */
  const trace = (req: Request, f: Omit<TraceFrame, 'ts' | 'actor'>): void =>
    devopsTraceHub.publish({ ts: Date.now(), actor: actor(req), ...f });

  /**
   * A short, SECRET-FREE one-liner for the trace: a whitelist of safe metadata only. Never
   * reflects `data` / `token` / `password` / secret values; key NAMES are reduced to a count.
   */
  function safeSummary(out: Record<string, unknown>): string {
    const SAFE = ['path', 'version', 'removed', 'mode', 'engine', 'role', 'accessor', 'ttl', 'leaseId', 'policies', 'revoked', 'reason', 'light', 'policy', 'paths'];
    const parts: string[] = [];
    if (Array.isArray(out.keys)) parts.push(`keys=[${out.keys.length}]`);
    for (const k of SAFE) {
      const v = out[k];
      if (v == null) continue;
      if (Array.isArray(v)) parts.push(`${k}=[${v.join(',')}]`);
      else if (typeof v !== 'object') parts.push(`${k}=${v}`);
    }
    return parts.join(' ') || 'ok';
  }

  /** Run a Vault read → JSON, publishing a trace frame under `action` (null = untraced, e.g. status polls). */
  async function run(req: Request, res: Response, action: string | null, fn: (svc: VaultConsoleService) => Promise<Record<string, unknown>>): Promise<void> {
    const svc = new VaultConsoleService();
    if (!svc.isConfigured()) { res.status(503).json({ error: 'vault_not_configured', message: 'VAULT_TOKEN is not set on this deployment.' }); return; }
    try {
      const out = await fn(svc);
      if (action) trace(req, { action, level: 'info', text: safeSummary(out) });
      res.json(out);
    } catch (err) {
      if (action) trace(req, { action, level: 'error', text: (err as Error).message });
      logger.error({ err: (err as Error).message }, 'vault operation failed');
      res.status(502).json({ error: (err as Error).message });
    }
  }

  /** Guard a mutating action: require confirm:true, then run + write a governance audit row. */
  async function mutate(
    req: Request, res: Response, action: string, resourceId: string,
    fn: (svc: VaultConsoleService) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    if (!hasExplicitWriteConfirmation(req.body)) { res.status(428).json(confirmationRequiredPayload('vault-mutation', action)); return; }
    const svc = new VaultConsoleService();
    if (!svc.isConfigured()) { res.status(503).json({ error: 'vault_not_configured', message: 'VAULT_TOKEN is not set on this deployment.' }); return; }
    trace(req, { action, resource: resourceId, level: 'start' });
    try {
      const out = await fn(svc);
      void emitAuditEvent(ctx.pool, { actorSub: actor(req), action, resourceType: 'vault', resourceId, decision: 'allow', metadata: { action } });
      trace(req, { action, resource: resourceId, level: 'ok', text: safeSummary(out) });
      logger.info({ actor: actor(req), action, resourceId }, 'vault mutation');
      res.json(out);
    } catch (err) {
      trace(req, { action, resource: resourceId, level: 'error', text: (err as Error).message });
      logger.error({ err: (err as Error).message, action, resourceId }, 'vault mutation failed');
      res.status(502).json({ error: (err as Error).message });
    }
  }

  /** GET /console — the DevOps + Vault console surface (served to any authed caller; self-gates via /access). */
  router.get('/console', (_req: Request, res: Response) => {
    res.sendFile(path.join(apiDir, 'devops-vault.html'), (err) => {
      if (err) { logger.error({ err }, 'Failed to serve DevOps/Vault console'); res.status(404).send('Page not found'); }
    });
  });

  /** GET /access — the caller's OWN superadmin status, so the surface reveals controls or a gate message. */
  router.get('/access', (req: Request, res: Response) => {
    const decision = evaluateSuperAdmin(req);
    res.json(decision.allowed ? { superAdmin: true } : { superAdmin: false, reason: decision.reason });
  });

  /**
   * @description GET /trace/stream — the live process trace (SSE). Superadmin-gated AND
   * OWNER-SCOPED: `devopsTraceHub` delivers a subscriber only its own actor's frames, so a bot
   * or another user can't attach to this superadmin's infra firehose even if it reached the route
   * (the deliberate answer to the old cross-bot SSE fan-out). Quiet until an action runs.
   */
  router.get('/trace/stream', requireSuperAdmin, (req: Request, res: Response) => {
    const sub = actor(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (f: TraceFrame): void => { try { res.write(`data: ${JSON.stringify(f)}\n\n`); } catch { /* client gone */ } };
    write({ ts: Date.now(), actor: sub, action: 'trace.connected', level: 'info', text: 'Live process trace connected.' });
    const unsubscribe = devopsTraceHub.subscribe(sub, write);
    const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* client gone */ } }, 25_000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  // ── Read endpoints (superadmin-gated; traced except the frequent status poll) ─
  router.get('/status', requireSuperAdmin, (req, res) => run(req, res, null, (svc) => svc.status()));
  router.post('/kv/read', requireSuperAdmin, (req, res) => run(req, res, 'vault.kv.read', (svc) => svc.read(String((req.body || {}).path || ''))));
  router.post('/kv/list', requireSuperAdmin, (req, res) => run(req, res, 'vault.kv.list', (svc) => svc.list((req.body || {}).path ? String(req.body.path) : undefined)));
  router.post('/lookup', requireSuperAdmin, (req, res) => run(req, res, 'vault.broker.lookup', (svc) => svc.lookup(String((req.body || {}).accessor || ''))));

  // ── Mutating endpoints (superadmin-gated + confirm:true + audited) ────────────
  router.post('/kv/write', requireSuperAdmin, (req, res) => {
    const b = (req.body || {}) as { path?: string; data?: Record<string, unknown> };
    void mutate(req, res, 'vault.kv.write', String(b.path || ''), (svc) => svc.write(String(b.path || ''), b.data || {}));
  });
  router.post('/kv/delete', requireSuperAdmin, (req, res) => {
    const p = String(((req.body || {}) as { path?: string }).path || '');
    void mutate(req, res, 'vault.kv.delete', p, (svc) => svc.remove(p));
  });
  router.post('/policy', requireSuperAdmin, (req, res) => {
    const b = (req.body || {}) as { name?: string; paths?: Array<{ path: string; capabilities?: string[] }> };
    void mutate(req, res, 'vault.policy.set', String(b.name || ''), (svc) => svc.policy(String(b.name || ''), Array.isArray(b.paths) ? b.paths : []));
  });
  router.post('/issue', requireSuperAdmin, (req, res) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const rid = b.engine ? `${b.engine}/${b.role}` : `policy:${b.policy}`;
    void mutate(req, res, 'vault.broker.issue', rid, (svc) => svc.issue(b));
  });
  router.post('/revoke', requireSuperAdmin, (req, res) => {
    const b = (req.body || {}) as { accessor?: string; leaseId?: string; token?: string };
    void mutate(req, res, 'vault.broker.revoke', b.accessor || b.leaseId || 'token', (svc) => svc.revoke(b));
  });
  router.post('/setup-db', requireSuperAdmin, (req, res) => {
    void mutate(req, res, 'vault.engine.setup-db', 'database', (svc) => svc.setupDb((req.body || {}) as Record<string, unknown>));
  });

  return router;
}
