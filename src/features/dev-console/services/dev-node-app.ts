/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the host dev-node's Express app out of scripts/dev-node.ts into a testable factory, and made the port JSON-only. Root cause of the operator's "Jarvis doctype error entering development mode": Express's DEFAULTS on this port answered an unmatched path with an HTML 404 page and a body-parser error with an HTML 400 page carrying a full stack trace (host paths, LAN-exposed) — the api's dev-console proxy forwarded both verbatim, and the cockpit dev pane surfaced them as `SyntaxError: Unexpected token '<' … <!DOCTYPE`. The app now ends in a JSON 404 catch-all + a JSON error envelope (message only, never a stack), and jsonOnlyBody() gives the api proxy a wall so no non-JSON dev-node body can ever transit /api/dev-console.
 */

import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { DevSessionManager, DevSessionFrame } from './dev-session-manager';

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
}

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
  const { manager } = options;
  // Pre-hash the secret so the auth compare is fixed-length + constant-time: no length oracle,
  // and no throw on a multibyte header (comparing raw byte lengths would leak length / 500).
  const secretHash = crypto.createHash('sha256').update(options.secret).digest();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

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
    res.json({ runtimeAvailable: true, sessions: manager.list(ownerSub(req)) });
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

/** Reads a bounded, trimmed string from an untrusted body value (undefined when absent/empty). */
function readStr(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}
