/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Developer Console — Phase 1 (ADR-077): super-admin-gated, read-only diagnostics. No shell, no writes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | proxyDevNode is now a JSON-only wall: the non-SSE branch previously forwarded the dev-node's body + content-type VERBATIM, so an Express HTML "<!DOCTYPE" 404/error page from a version-skewed dev-node (the api runs baked committed HEAD while the host dev-node runs the live tree — they CAN skew) or from anything else answering on that port transited /api/dev-console straight into the cockpit dev pane as `SyntaxError: Unexpected token '<' … <!DOCTYPE` (the operator's "Jarvis doctype error entering development mode"). Non-JSON upstream bodies are converted to a readable JSON error envelope via jsonOnlyBody(); guarded by tests/unit/dev-node-json-only.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | POST /apply + POST /promote (ADR-077 gaps 1/3): the super-admin-gated, audited front doors for the live fast lanes and the verified deploy. Both ALWAYS proxy to the dev-node and are never served in-process — the api container holds a read-write bind mount of the host repo (COMPOSE_PROJECT_ROOT, for dynamic bot launch), so "it can reach the tree" is true and is exactly why the boundary has to be explicit rather than incidental.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getCaller } from '@/shared/middleware/authz';
import { evaluateSuperAdmin, superAdminEnabled, type RequestWithSuperAdmin } from '@/shared/middleware/superadmin';
import { emitAuditEvent } from '@/features/governance';
import {
  DevSessionEngine,
  DevSessionManager,
  DevSessionOrchestrator,
  SandboxedAgentRunner,
  jsonOnlyBody,
  type DevSessionFrame,
} from '@/features/dev-console';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'dev-console-routes' });

/**
 * Deny-audit throttle. A denial writes an append-only audit row for forensics, but the
 * deny path is reachable by any authenticated caller, so an unthrottled write-per-request
 * would let a request flood amplify into unbounded DB writes (pool exhaustion). We record
 * at most ONE deny-audit per caller per window; denials are always logged regardless.
 */
const DENY_AUDIT_WINDOW_MS = 60_000;
const lastDenyAuditByCaller = new Map<string, number>();

/**
 * @description Whether a denial by `sub` should be persisted to the audit log right now.
 * Returns true at most once per caller per DENY_AUDIT_WINDOW_MS. Prunes stale entries so
 * the map cannot grow without bound under a flood of distinct callers.
 * @param sub - Caller sub (or null → bucketed as 'anon').
 * @param now - Current epoch ms (injected for deterministic testing).
 * @returns true when this denial should be audited.
 */
export function shouldAuditDeny(sub: string | null, now: number): boolean {
  const key = sub ?? 'anon';
  const last = lastDenyAuditByCaller.get(key) ?? 0;
  if (now - last < DENY_AUDIT_WINDOW_MS) {
    return false;
  }
  lastDenyAuditByCaller.set(key, now);
  if (lastDenyAuditByCaller.size > 2000) {
    for (const [entryKey, ts] of lastDenyAuditByCaller) {
      if (now - ts > DENY_AUDIT_WINDOW_MS) lastDenyAuditByCaller.delete(entryKey);
    }
  }
  return true;
}

/**
 * @description Developer Console routes — Phase 1. The router is mounted behind
 * `requiresAuth`, so every route already requires a signed-in identity. `/access` then
 * only reports the caller's OWN super-admin decision (safe for any authed user, drives
 * whether the UI reveals the Developer affordance); every capability route additionally
 * passes the audited super-admin guard. Phase 1 is strictly READ-ONLY: no shell, no
 * writes, no source access — just enough to answer "am I allowed?" and "how is it doing?".
 * @param ctx - Application context (pool for audit, task store for the health snapshot).
 * @returns Express Router.
 */
export function createDevConsoleRoutes(ctx: AppContext): Router {
  const router = Router();

  // The self-edit runtime (engine + sandbox + orchestrator) can only run where the repo + docker
  // live — the host/sidecar. In the containerized controller (`.git` absent) the session routes
  // report unavailable rather than pretend. See ADR-077: dispatched-to-node is the deploy wiring.
  const repoRoot = path.resolve(process.env.OSHAL_REPO_ROOT || process.cwd());
  const repoAvailable = existsSync(path.join(repoRoot, '.git'));
  const manager = repoAvailable ? buildManager(repoRoot) : null;
  // Option B: when the engine can't run in-process (containerized controller, no .git), proxy the
  // session routes to a host dev-node that DOES run it. The super-admin gate stays here (the auth
  // boundary); the dev-node trusts our shared secret + the forwarded caller sub.
  const devNodeUrl = (process.env.OSHAL_DEV_NODE_URL || '').trim();

  /**
   * Pool-bound super-admin guard: attaches the decision, AND writes an append-only audit
   * row on DENY (security forensics) before returning 403. Allows are audited per-action
   * in each handler so the metadata is meaningful.
   */
  const requireSuperAdminAudited = (req: Request, res: Response, next: NextFunction): void => {
    const decision = evaluateSuperAdmin(req);
    (req as RequestWithSuperAdmin).superAdminDecision = decision;
    if (decision.allowed) {
      next();
      return;
    }
    logger.warn({ decision, path: req.path, method: req.method }, 'Developer Console access denied');
    // Throttled so a request flood on the (authenticated-reachable) deny path cannot
    // amplify into unbounded audit writes / pool exhaustion.
    if (shouldAuditDeny(decision.sub, Date.now())) {
      void emitAuditEvent(ctx.pool, {
        actorSub: decision.sub,
        action: 'dev-console.denied',
        resourceType: 'dev_console',
        resourceId: req.path,
        decision: 'deny',
        metadata: { reason: decision.reason, checks: decision.checks },
      });
    }
    res.status(403).json({ error: 'Super-admin privilege required', reason: decision.reason });
  };

  // GET /access — the caller's OWN super-admin status. Auth-only (no super-admin gate) so
  // the cockpit can decide whether to reveal the Developer affordance. A non-admin gets a
  // BARE { superAdmin:false } — no reason, no checks, no config/env-var names — so a
  // non-privileged caller learns nothing about the deployment's configuration. Only an
  // actual super-admin (debugging their own access) receives the full decision trace. The
  // whole router is additionally mounted only when the capability is enabled (server.ts),
  // so a never-opted-in deployment returns 404 here and exposes nothing at all.
  router.get('/access', (req: Request, res: Response) => {
    const decision = evaluateSuperAdmin(req);
    logger.info({ sub: decision.sub, allowed: decision.allowed }, 'GET /api/dev-console/access');
    if (!decision.allowed) {
      res.json({ superAdmin: false });
      return;
    }
    res.json({ superAdmin: true, enabled: true, reason: decision.reason, checks: decision.checks });
  });

  // GET /status — runtime + capability snapshot for a super-admin. Read-only; audited.
  router.get('/status', requireSuperAdminAudited, (req: Request, res: Response) => {
    const sub = getCaller(req).sub;
    void emitAuditEvent(ctx.pool, {
      actorSub: sub,
      action: 'dev-console.status',
      resourceType: 'dev_console',
      resourceId: null,
      decision: 'allow',
      metadata: {},
    });
    res.json({
      enabled: superAdminEnabled(),
      phase: 2,
      capabilities: { diagnostics: true, edit: repoAvailable || Boolean(devNodeUrl), recover: false },
      selfEditRuntimeAvailable: repoAvailable || Boolean(devNodeUrl),
      runtime: {
        node: process.version,
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
      },
      generatedAt: new Date().toISOString(),
    });
  });

  // POST /sessions — open a streamed, operator-approved self-edit session (super-admin; audited).
  // The agent command is built server-side from `mode`; the caller's instruction is only ever the
  // sandboxed agent's argument, never a host shell.
  router.post('/sessions', requireSuperAdminAudited, (req: Request, res: Response) => {
    if (!manager) { void proxyDevNode(req, res, devNodeUrl); return; }
    const sub = getCaller(req).sub;
    const mode = (req.body as { mode?: string })?.mode === 'agent' ? 'agent' : 'demo';
    const instruction = readStr((req.body as { instruction?: unknown })?.instruction, 4000);
    if (mode === 'agent' && !instruction) { res.status(400).json({ error: 'instruction is required for agent mode' }); return; }
    try {
      const { sessionId } = manager.start({ ownerSub: sub, mode, instruction, label: readStr((req.body as { label?: unknown })?.label, 40) });
      void emitAuditEvent(ctx.pool, {
        actorSub: sub, action: 'dev-console.session-start', resourceType: 'dev_session', resourceId: sessionId,
        decision: 'allow', metadata: { mode },
      });
      res.status(202).json({ sessionId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'failed to start session';
      res.status(msg.includes('too many') ? 429 : 400).json({ error: msg });
    }
  });

  // GET /sessions/:id/stream — SSE of the session's thought-chain frames (super-admin; owner-only).
  router.get('/sessions/:id/stream', requireSuperAdminAudited, (req: Request, res: Response) => {
    if (!manager) { void proxyDevNode(req, res, devNodeUrl); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (frame: DevSessionFrame): void => { try { res.write(`data: ${JSON.stringify(frame)}\n\n`); } catch { /* client gone */ } };
    const unsubscribe = manager.subscribe(String(req.params.id), getCaller(req).sub, write);
    if (!unsubscribe) { res.write(`data: ${JSON.stringify({ type: 'error', message: 'session not found' })}\n\n`); res.end(); return; }
    const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* client gone */ } }, 25_000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  // POST /sessions/:id/commit — approve + commit the reviewed diff to the branch (verify-gated).
  router.post('/sessions/:id/commit', requireSuperAdminAudited, async (req: Request, res: Response) => {
    if (!manager) { void proxyDevNode(req, res, devNodeUrl); return; }
    const sub = getCaller(req).sub;
    try {
      const result = await manager.commit(String(req.params.id), sub, readStr((req.body as { message?: unknown })?.message, 200) ?? '');
      void emitAuditEvent(ctx.pool, { actorSub: sub, action: 'dev-console.session-commit', resourceType: 'dev_session', resourceId: result.branch, decision: 'allow', metadata: { sha: result.sha } });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : 'commit failed' });
    }
  });

  // POST /sessions/:id/discard — tear the session down (owner-only).
  router.post('/sessions/:id/discard', requireSuperAdminAudited, (req: Request, res: Response) => {
    if (!manager) { void proxyDevNode(req, res, devNodeUrl); return; }
    try {
      manager.discard(String(req.params.id), getCaller(req).sub);
      res.json({ ok: true });
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : 'not found' });
    }
  });

  // GET /sessions — the caller's sessions (super-admin; owner-only).
  router.get('/sessions', requireSuperAdminAudited, (req: Request, res: Response) => {
    if (!manager) { void proxyDevNode(req, res, devNodeUrl); return; }
    // In-process (host-run api) there is no applier/promoter: those act on the live box and are
    // dev-node capabilities by design. Reporting them false is the honest answer, not a gap.
    res.json({ runtimeAvailable: true, applyAvailable: false, promoteAvailable: false, sessions: manager.list(getCaller(req).sub) });
  });

  // POST /apply — apply an approved asset/manifest/persona/package change set to the LIVE tree
  // and take its restart action. ALWAYS proxied: the api container must never write the host tree
  // or drive Docker itself, even where a bind mount would let it (ADR-077's isolation is the point).
  router.post('/apply', requireSuperAdminAudited, (req: Request, res: Response) => {
    const sub = getCaller(req).sub;
    const paths = Array.isArray((req.body as { changes?: unknown })?.changes)
      ? ((req.body as { changes: { path?: unknown }[] }).changes).map((c) => String(c?.path ?? '')).slice(0, 50)
      : [];
    void emitAuditEvent(ctx.pool, {
      actorSub: sub,
      action: 'dev-console.live-apply',
      resourceType: 'dev_console',
      resourceId: null,
      decision: 'allow',
      metadata: { paths, count: paths.length },
    });
    void proxyDevNode(req, res, devNodeUrl);
  });

  // POST /promote — run the verified deploy (scripts/oshal-deploy.sh) for core changes already
  // merged to the trunk. Audited BEFORE dispatch so an interrupted deploy still leaves a record
  // of who asked for it.
  router.post('/promote', requireSuperAdminAudited, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { dryRun?: unknown };
    void emitAuditEvent(ctx.pool, {
      actorSub: getCaller(req).sub,
      action: 'dev-console.promote',
      resourceType: 'dev_console',
      resourceId: null,
      decision: 'allow',
      metadata: { dryRun: body.dryRun === true },
    });
    void proxyDevNode(req, res, devNodeUrl);
  });

  // GET /health-snapshot — bounded, sanitized read of recent task health (the "how are
  // jobs doing / any errors?" glance). No message bodies, no secrets. Super-admin; audited.
  router.get('/health-snapshot', requireSuperAdminAudited, async (req: Request, res: Response) => {
    const sub = getCaller(req).sub;
    try {
      const snapshot = await buildHealthSnapshot(ctx);
      void emitAuditEvent(ctx.pool, {
        actorSub: sub,
        action: 'dev-console.health-snapshot',
        resourceType: 'dev_console',
        resourceId: null,
        decision: 'allow',
        metadata: { scanned: snapshot.scanned },
      });
      res.json(snapshot);
    } catch (error) {
      logger.error({ err: error }, 'Failed to build dev-console health snapshot');
      res.status(500).json({ error: 'Failed to build health snapshot' });
    }
  });

  logger.info({ enabled: superAdminEnabled() }, 'Developer Console routes registered (Phase 1, read-only)');
  return router;
}

/**
 * Proxies a session request to the host dev-node (Option B): the api is the OIDC/super-admin auth
 * boundary; the dev-node runs the engine where the repo + docker live. We forward the shared secret
 * (only we know it) + the authenticated caller sub (for owner-scoping), and pipe SSE straight
 * through. The caller has already passed the super-admin gate before this runs.
 */
async function proxyDevNode(req: Request, res: Response, devNodeUrl: string): Promise<void> {
  if (!devNodeUrl) { res.status(503).json({ error: 'Self-edit runtime not configured on this deployment.' }); return; }
  const suffix = req.originalUrl.replace(/^.*\/api\/dev-console/, '');
  const target = `${devNodeUrl.replace(/\/$/, '')}${suffix}`;
  const isSse = req.path.endsWith('/stream');
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'x-dev-node-secret': process.env.OSHAL_DEV_NODE_SECRET || '',
        'x-oshal-sub': getCaller(req).sub ?? '',
        ...(req.method !== 'GET' ? { 'content-type': 'application/json' } : {}),
        ...(isSse ? { accept: 'text/event-stream' } : {}),
      },
      body: req.method !== 'GET' ? JSON.stringify(req.body ?? {}) : undefined,
    });
    if (isSse && upstream.body) {
      res.writeHead(upstream.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      // Pipe with backpressure (Readable.fromWeb honors drain) and tear down the upstream on close.
      const source = Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
      req.on('close', () => source.destroy());
      source.on('error', () => { if (!res.writableEnded) res.end(); });
      source.pipe(res);
      return;
    }
    // JSON-only wall: never forward a non-JSON dev-node body (an Express HTML "<!DOCTYPE"
    // 404/error page from a version-skewed dev-node, or anything else squatting the port) —
    // the cockpit dev pane parses these responses as JSON. jsonOnlyBody passes valid JSON
    // through byte-for-byte and converts everything else to a readable JSON error envelope.
    const text = await upstream.text();
    const body = jsonOnlyBody(upstream.status, text);
    if (body !== text) {
      logger.warn({ target, status: upstream.status, contentType: upstream.headers.get('content-type') }, 'dev-node answered non-JSON; converted to a JSON error envelope');
    }
    res.status(upstream.status).setHeader('content-type', 'application/json');
    res.send(body);
  } catch (error) {
    logger.error({ err: error, target }, 'dev-node proxy failed');
    if (!res.headersSent) res.status(502).json({ error: 'self-edit dev-node unreachable' });
  }
}

/** Builds the self-edit runtime (host/sidecar only — where the repo + docker live). */
function buildManager(repoRoot: string): DevSessionManager {
  const engine = new DevSessionEngine({ repoRoot });
  const runner = new SandboxedAgentRunner();
  const orchestrator = new DevSessionOrchestrator(engine, runner, path.join(repoRoot, '..', 'oshal-dev-scratch'));
  return new DevSessionManager(engine, orchestrator);
}

/** Reads a bounded, trimmed string from an untrusted body value (undefined when absent/empty). */
function readStr(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

interface HealthSnapshot {
  scanned: number;
  counts: Record<string, number>;
  failed: number;
  latestUpdatedAt: string | null;
  generatedAt: string;
}

/**
 * @description Builds a bounded, non-sensitive health snapshot from the task store —
 * status counts + a failed tally. Deliberately excludes message bodies, prompts, titles,
 * ids, and any per-user content so nothing sensitive crosses the console. Counts are
 * platform-global by design: super-admin is a platform-scoped role, not a tenant one. If a
 * tenant-scoped super-admin is ever introduced, thread ownerSub/tenant into taskStore.list.
 */
async function buildHealthSnapshot(ctx: AppContext): Promise<HealthSnapshot> {
  const tasks = await ctx.taskStore.list({ limit: 100 });
  const counts: Record<string, number> = {};
  let latest: string | null = null;
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    if (!latest || task.updatedAt > latest) {
      latest = task.updatedAt;
    }
  }
  return {
    scanned: tasks.length,
    counts,
    failed: counts.failed ?? 0,
    latestUpdatedAt: latest,
    generatedAt: new Date().toISOString(),
  };
}
