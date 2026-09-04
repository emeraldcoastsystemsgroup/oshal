/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the node-plane print intake (ADR-135 amendment H). A print service running INSIDE a remote node could not deliver: decideNodeTokenScope confines a node-bound token to /api/remote-clients/<its own clientId>/*, so POST /api/print-ingest/documents was refused 'off-plane'. Rather than widen that scope (which would let any node file as anyone), this adds the intake to the node's OWN plane and does the identity translation there: the node token proves WHICH device, the registry record proves WHOSE device, and the document is filed under that owner. An UNOWNED device is refused — there is no one to file for.
 *
 * @module app/routes/remote-client-print-routes
 */

import type { Request, Response, RequestHandler, Router } from 'express';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'remote-client-print' });

/** Default listen port, mirroring server.ts, so the loopback target needs no configuration. */
const DEFAULT_PORT = 5000;

/** Upper bound on a single printed document's recovered text, before the app's own cap. */
const MAX_TEXT_CHARS = 500_000;

/** The subset of the registry this route reads — structural, so tests need no real registry. */
export interface PrintDeviceRegistry {
  getClient(clientId: string): { clientId?: string; ownerSub?: string | null } | null;
}

/** Injected collaborators. `fetchImpl` is here so the guard can drive the real handler. */
export interface RemoteClientPrintDeps {
  registry: PrintDeviceRegistry;
  fetchImpl?: typeof fetch;
}

/**
 * @description Where an accepted document is filed. The print-ingest app owns intake; core
 * only translates identity and forwards, so the target is configuration rather than an import
 * (the app ships in the store repo and may not be installed at all — Rule 0c).
 * @returns Absolute URL of the print-ingest document intake.
 */
function intakeUrl(): string {
  const explicit = String(process.env.OSHAL_PRINT_INTAKE_INTERNAL_URL || '').trim();
  if (explicit) return explicit;
  const port = String(process.env.PORT || DEFAULT_PORT).trim();
  return `http://127.0.0.1:${port}/api/print-ingest/documents`;
}

/**
 * @description Reads the document out of the request body, rejecting anything a printer would
 * not have produced. Only recovered TEXT crosses this boundary — never the spooled binary —
 * which is the same rule the print-drop package enforces on its side.
 * @param body - The raw request body.
 * @returns The validated payload, or a caller-safe rejection reason.
 */
function readDocument(body: unknown): { ok: true; text: string; sidecar: unknown } | { ok: false; error: string; detail: string } {
  const record = (body || {}) as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text : '';
  if (!text.trim()) {
    return { ok: false, error: 'no_text', detail: 'the document carried no recoverable text' };
  }
  if (text.length > MAX_TEXT_CHARS) {
    return { ok: false, error: 'too_large', detail: `text exceeds ${MAX_TEXT_CHARS} characters` };
  }
  return { ok: true, text, sidecar: record.sidecar ?? {} };
}

/**
 * @description Files one printed document on behalf of the node's OWNER.
 *
 * The identity translation is the whole point of this handler. `requireDeviceAccess` has
 * already proven the caller may drive this device; the registry says who the device belongs
 * to; the document is filed under that person. A node therefore cannot file into anyone
 * else's knowledge — not by choosing a sub, because it never supplies one.
 *
 * @param req - The node's request (body: `{ text, sidecar }`).
 * @param res - Express response.
 * @param deps - Registry + fetch implementation.
 * @returns Resolves when the response has been written.
 */
async function handlePrintDocument(req: Request, res: Response, deps: RemoteClientPrintDeps): Promise<void> {
  const started = Date.now();
  const clientId = String(req.params.clientId || '');
  const record = deps.registry.getClient(clientId);
  if (!record) {
    res.status(404).json({ error: 'unknown_device' });
    return;
  }

  // An unowned device has nobody to file for. Fail closed rather than guess a sub or fall
  // back to an operator: a printed document is somebody's private knowledge.
  const ownerSub = record.ownerSub ? String(record.ownerSub) : '';
  if (!ownerSub) {
    logger.warn({ clientId }, 'Print intake refused: device has no registered owner');
    res.status(409).json({
      error: 'device_unowned',
      detail: 'This computer is not registered to a user yet, so a printed document has no owner to file under. Re-run enrollment from the node.',
    });
    return;
  }

  const document = readDocument(req.body);
  if (!document.ok) {
    res.status(document.error === 'too_large' ? 413 : 422).json({ error: document.error, detail: document.detail });
    return;
  }

  const secret = String(process.env.SWARM_SERVICE_SECRET || '').trim();
  if (!secret) {
    logger.error({ clientId }, 'Print intake unavailable: SWARM_SERVICE_SECRET is not configured');
    res.status(503).json({
      error: 'intake_unavailable',
      detail: 'The swarm cannot file printed documents: SWARM_SERVICE_SECRET is not configured.',
    });
    return;
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const url = intakeUrl();
  try {
    const upstream = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-secret': secret,
        // The identity translation: the OWNER files, not the node.
        'x-oshal-user-sub': ownerSub,
      },
      body: JSON.stringify({ text: document.text, sidecar: document.sidecar }),
    });

    const payload = await upstream.text();
    logger.info(
      { clientId, status: upstream.status, textChars: document.text.length, durationMs: Date.now() - started },
      'Printed document forwarded to print intake',
    );
    // A 404 here means the print-ingest app is simply not installed — say so, rather than
    // letting the node see a bare 404 it would read as "wrong URL" and retry forever.
    if (upstream.status === 404) {
      res.status(503).json({
        error: 'print_ingest_not_installed',
        detail: 'This swarm has no print-ingest app installed, so printed documents cannot be filed.',
      });
      return;
    }
    res.status(upstream.status).type('application/json').send(payload);
  } catch (error) {
    logger.error(
      { err: error, stack: (error as Error).stack, clientId, url, durationMs: Date.now() - started },
      'Print intake forward failed',
    );
    res.status(502).json({ error: 'intake_unreachable', detail: 'The print intake could not be reached.' });
  }
}

/**
 * @description Mounts the node-plane print intake. Kept in its own module because
 * remote-client-routes.ts sits against the 1000-line cap, matching how the task and
 * workspace operations are already split out.
 * @param router - The `/api/remote-clients` router.
 * @param requireDeviceAccess - The device-ownership gate applied to every action route.
 * @param deps - Registry + optional fetch override.
 * @returns void
 */
export function registerRemoteClientPrintRoutes(
  router: Router,
  requireDeviceAccess: RequestHandler,
  deps: RemoteClientPrintDeps,
): void {
  router.post('/:clientId/print-documents', requireDeviceAccess, (req, res) => void handlePrintDocument(req, res, deps));
}

/** Exported for the regression guard, which drives the real handler rather than a copy. */
export const __testing = { handlePrintDocument, intakeUrl, readDocument };
