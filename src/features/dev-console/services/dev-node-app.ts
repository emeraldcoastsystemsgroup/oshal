/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the host dev-node's Express app out of scripts/dev-node.ts into a testable factory, and made the port JSON-only. Root cause of the operator's "Jarvis doctype error entering development mode": Express's DEFAULTS on this port answered an unmatched path with an HTML 404 page and a body-parser error with an HTML 400 page carrying a full stack trace (host paths, LAN-exposed) — the api's dev-console proxy forwarded both verbatim, and the cockpit dev pane surfaced them as `SyntaxError: Unexpected token '<' … <!DOCTYPE`. The app now ends in a JSON 404 catch-all + a JSON error envelope (message only, never a stack), and jsonOnlyBody() gives the api proxy a wall so no non-JSON dev-node body can ever transit /api/dev-console.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added POST /apply (live fast lanes for asset/manifest/persona/package changes) and POST /promote (the verified deploy for core changes). The dev-node is where both belong: it is the only process that holds the repo, the Docker socket and the host filesystem at once. Both are optional capabilities — a dev-node built without them answers 503 rather than pretending.
 */

import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { DevSessionManager, DevSessionFrame } from './dev-session-manager';
import type { DeployPromoter } from './deploy-promoter';
import type { LiveApplier, LiveChange } from './live-apply';

const logger = createChildLogger({ module: 'dev-node-app' });

/**
 * @description Guarantees a dev-node response body is JSON before it crosses a boundary a
 * JSON-parsing client sits behind (the api's /api/dev-console proxy → the cockpit dev pane).
 * A body that already parses as JSON passes through byte-for-byte; anything else (Express's
 * HTML "<!DOCTYPE" 404/error pages from a version-skewed or foreign listener, an empty body,
 * a crash page from something squatting the port) is replaced with a readable JSON error
 * envelope so `<!DOCTYPE` can never reach an operator as a raw SyntaxError.
 * @param status - The upstream HTTP status (echoed into the envelope for operator context).
 * @param text - The raw upstream body text.
 * @returns The original text when it is valid JSON, else a JSON error envelope string.
 */
export function jsonOnlyBody(status: number, text: string): string {
  try {
    JSON.parse(text);
    return text;
  } catch {
    return JSON.stringify({ error: `self-edit dev-node returned a non-JSON response (HTTP ${status})` });
  }
}

/**
 * Options for building the dev-node HTTP app.
 */
export interface DevNodeAppOptions {
  /** Shared secret (>= 32 chars enforced by the entrypoint) — the api's identity. */
  secret: string;
  /** The self-edit session manager the routes drive. */
  manager: DevSessionManager;
  /** Optional: runs the verified deploy for core changes. Absent ⇒ /promote answers 503. */
  promoter?: DeployPromoter;
  /** Optional: applies asset/manifest/persona/package changes live. Absent ⇒ /apply answers 503. */
  applier?: LiveApplier;
}

/** Upper bound on one live-apply payload — a governed edit set, not a repo import. */
const MAX_APPLY_FILES = 200;

/**
 * @description Builds the host dev-node's Express app (ADR-077 Option B "muscle"): the api is
 * the OIDC/super-admin auth boundary and proxies session routes here, where the repo + docker
 * live. This process holds NO OIDC — every route except /health requires the api's shared
 * secret, and the forwarded caller sub is trusted for owner-scoping only (documented trust
 * boundary; keep the port firewalled). The app is JSON-only end to end: unmatched paths and
 * middleware errors answer JSON envelopes, never Express's HTML pages.
 * @param options - Shared secret + session manager.
 * @returns The configured Express app (caller decides host/port binding).
 */
export function createDevNodeApp(options: DevNodeAppOptions): express.Express {
  const { manager, promoter, applier } = options;
  // Pre-hash the secret so the auth compare is fixed-length + constant-time: no length oracle,
  // and no throw on a multibyte header (comparing raw byte lengths would leak length / 500).
  const secretHash = crypto.createHash('sha256').update(options.secret).digest();

  const app = express();
  // 8mb: a live-apply set carries whole file contents. Still bounded, and the port is
  // secret-gated and firewalled — see the trust note on ownerSub below.
  app.use(express.json({ limit: '8mb' }));

  /** Constant-time shared-secret gate. Every route (except /health) requires it. */
  function requireSecret(req: Request, res: Response, next: NextFunction): void {
    const provided = req.header('x-dev-node-secret');
    if (typeof provided !== 'string') { res.status(401).json({ error: 'unauthorized' }); return; }
    const providedHash = crypto.createHash('sha256').update(provided).digest();
    if (!crypto.timingSafeEqual(providedHash, secretHash)) { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  }

  /**
   * The owner sub the api forwarded after authenticating the super-admin (used for
   * owner-scoping). TRUST NOTE: the dev-node does NOT verify this sub — it trusts the shared
   * secret. So a holder of the secret can act as any owner. That is the documented trust
   * boundary (secret = the api's identity); keep the port firewalled to the Docker subnet and
   * rotate the secret. (ADR-077.)
   */
  function ownerSub(req: Request): string | null {
    const sub = String(req.header('x-oshal-sub') || '').trim();
    return sub || null;
  }

  // Liveness only — no repo path / node version (unauthenticated, LAN-reachable).
  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.post('/sessions', requireSecret, (req: Request, res: Response) => {
    const mode = (req.body as { mode?: string })?.mode === 'agent' ? 'agent' : 'demo';
    const instruction = readStr((req.body as { instruction?: unknown })?.instruction, 4000);
    if (mode === 'agent' && !instruction) { res.status(400).json({ error: 'instruction is required for agent mode' }); return; }
    try {
      const { sessionId } = manager.start({ ownerSub: ownerSub(req), mode, instruction, label: readStr((req.body as { label?: unknown })?.label, 40) });
      res.status(202).json({ sessionId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'failed to start';
      res.status(msg.includes('too many') ? 429 : 400).json({ error: msg });
    }
  });

  app.get('/sessions/:id/stream', requireSecret, (req: Request, res: Response) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (frame: DevSessionFrame): void => { try { res.write(`data: ${JSON.stringify(frame)}\n\n`); } catch { /* client gone */ } };
    const unsubscribe = manager.subscribe(String(req.params.id), ownerSub(req), write);
    if (!unsubscribe) { res.write(`data: ${JSON.stringify({ type: 'error', message: 'session not found' })}\n\n`); res.end(); return; }
    const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* gone */ } }, 25_000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.post('/sessions/:id/commit', requireSecret, async (req: Request, res: Response) => {
    try {
      const result = await manager.commit(String(req.params.id), ownerSub(req), readStr((req.body as { message?: unknown })?.message, 200) ?? '');
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : 'commit failed' });
    }
  });

  app.post('/sessions/:id/discard', requireSecret, (req: Request, res: Response) => {
    try { manager.discard(String(req.params.id), ownerSub(req)); res.json({ ok: true }); }
    catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : 'not found' }); }
  });

  app.get('/sessions', requireSecret, (req: Request, res: Response) => {
    res.json({
      runtimeAvailable: true,
      applyAvailable: !!applier,
      promoteAvailable: !!promoter,
      promoteBusy: promoter?.busy ?? false,
      sessions: manager.list(ownerSub(req)),
    });
  });

  // ── Fast lanes: apply an approved change set to the LIVE tree ──────────────────────────
  // A refusal (core/infra) is a 409 carrying the class and the route to take instead — the
  // caller must not be able to read it as "applied" or as a transport failure.
  app.post('/apply', requireSecret, async (req: Request, res: Response) => {
    if (!applier) { res.status(503).json({ error: 'live apply is not enabled on this dev-node' }); return; }
    const changes = readChanges((req.body as { changes?: unknown })?.changes);
    if (!changes) {
      res.status(400).json({ error: `changes must be a non-empty array of {path, content} objects (max ${MAX_APPLY_FILES})` });
      return;
    }
    try {
      const result = await applier.apply(changes);
      res.status(result.applied ? 200 : 409).json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'apply failed' });
    }
  });

  // ── Promote: the verified deploy for core changes ──────────────────────────────────────
  app.post('/promote', requireSecret, async (req: Request, res: Response) => {
    if (!promoter) { res.status(503).json({ error: 'promote is not enabled on this dev-node' }); return; }
    const body = (req.body ?? {}) as { dryRun?: unknown; skipBuild?: unknown; allowUnpushed?: unknown };
    try {
      const outcome = await promoter.promote({
        dryRun: body.dryRun === true,
        skipBuild: body.skipBuild === true,
        allowUnpushed: body.allowUnpushed === true,
      });
      // 200 even for a failed deploy: the OPERATION completed and its verdict is the payload.
      // An HTTP status cannot distinguish "rolled back, stack serving" from "nothing is
      // serving", and that distinction is the whole point of the deploy's exit codes.
      res.json(outcome);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'promote failed';
      res.status(msg.includes('already running') ? 409 : 500).json({ error: msg });
    }
  });

  // ── LAST middlewares — this port must NEVER speak HTML ─────────────────────────────────
  // Express's defaults answer an unmatched path with an HTML "<!DOCTYPE" 404 page and a
  // body-parser SyntaxError with an HTML 400 page carrying a full stack trace (host paths on
  // a LAN-exposed port). The api proxy forwarded both verbatim and the cockpit dev pane
  // surfaced them to the operator as `SyntaxError: Unexpected token '<' … <!DOCTYPE`.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not found', path: req.originalUrl });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const candidate = (err as { status?: unknown; statusCode?: unknown }) ?? {};
    const status = typeof candidate.status === 'number' ? candidate.status
      : typeof candidate.statusCode === 'number' ? candidate.statusCode : 500;
    logger.error({ err, status }, 'dev-node request failed');
    if (res.headersSent) { res.end(); return; }
    // Message only — never the stack (it carries absolute host paths on a network port).
    res.status(status).json({ error: err instanceof Error ? err.message : 'request failed' });
  });

  return app;
}

/**
 * @description Validates an untrusted `changes` body into a live-apply set. Rejects anything
 * that is not a bounded array of `{path: string, content: string}` — path CONFINEMENT is the
 * applier's job, but shape validation belongs at the edge so a malformed payload never reaches it.
 * @param value - The raw `changes` value from the request body.
 * @returns The validated change set, or null when the payload is not usable.
 */
function readChanges(value: unknown): LiveChange[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_APPLY_FILES) return null;
  const changes: LiveChange[] = [];
  for (const entry of value) {
    const candidate = entry as { path?: unknown; content?: unknown };
    if (typeof candidate?.path !== 'string' || !candidate.path.trim()) return null;
    if (typeof candidate?.content !== 'string') return null;
    changes.push({ path: candidate.path.trim(), content: candidate.content });
  }
  return changes;
}

/** Reads a bounded, trimmed string from an untrusted body value (undefined when absent/empty). */
function readStr(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}
