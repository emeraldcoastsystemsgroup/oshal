/**
 * Webhook ingress framework (ADR-065 Phase 2).
 *
 * Today the only inbound webhook is the hardcoded Alertmanager route. "Consistent webhooks" across
 * a deep catalog needs ONE intake with pluggable signature verification, replay/dedup protection,
 * and a uniform dispatch into the swarm. This generalizes that pattern:
 *
 *   POST /api/hooks/:provider/:event
 *     -> look up the declared (provider,event) verification spec  (404 if unknown)
 *     -> verify the signature/secret over the RAW body            (401 if bad)
 *     -> dedup by delivery id                                     (200 "duplicate", no re-dispatch)
 *     -> onEvent({ provider, event, deliveryId, payload, headers })  (the caller wires this to a ticket)
 *
 * The verification + dispatch core (`verifySignature`, `dispatchWebhook`) is a pure function so it's
 * unit-testable with no HTTP. The Express router is a thin wrapper. Secrets come from env via
 * `resolveSecret('env:NAME')`, never from the manifest in plaintext.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-065 Phase 2. Additive;
 *            | not mounted in server.ts by default (off until a caller wires createWebhookIngressRouter).
 * -----------------------------------------------------------------------------
 * @module connectors/webhooks/webhook-ingress
 */

import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';

export type WebhookVerify =
  | { type: 'hmac'; header: string; secret: string; algo?: string; prefix?: string }
  | { type: 'shared-secret'; header: string; secret: string }
  | { type: 'jwt'; header: string; secret: string };

export interface WebhookEventSpec {
  provider: string;
  event: string;
  verify: WebhookVerify;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export interface WebhookEvent {
  provider: string;
  event: string;
  deliveryId: string;
  payload: unknown;
  headers: Record<string, string | undefined>;
}

/** Pluggable dedup store. The default is in-memory; production wires a DB/Redis-backed one. */
export interface SeenStore {
  has(id: string): boolean | Promise<boolean>;
  add(id: string): void | Promise<void>;
}

/** Resolve an `env:NAME` reference to its value; a literal is returned as-is. Empty if unset. */
export function resolveSecret(ref: string | undefined): string {
  if (!ref) return '';
  return ref.startsWith('env:') ? (process.env[ref.slice(4)] || '') : ref;
}

/** Constant-time string compare that won't throw on length mismatch. */
function timingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Verify a webhook signature/secret over the raw request body. The one place this logic lives. */
export function verifySignature(spec: WebhookVerify, rawBody: string, headers: Record<string, string | undefined>): VerifyResult {
  if (!spec.secret) return { ok: false, reason: 'no secret configured' };
  const provided = headers[spec.header.toLowerCase()];
  if (!provided) return { ok: false, reason: `missing ${spec.header}` };

  if (spec.type === 'shared-secret') {
    return timingEqual(provided, spec.secret) ? { ok: true } : { ok: false, reason: 'bad secret' };
  }
  if (spec.type === 'hmac') {
    const algo = spec.algo || 'sha256';
    const expected = crypto.createHmac(algo, spec.secret).update(rawBody, 'utf8').digest('hex');
    // Many providers send "sha256=<hex>"; strip any "name=" prefix before comparing.
    const got = provided.includes('=') ? provided.slice(provided.lastIndexOf('=') + 1) : provided;
    return timingEqual(got.toLowerCase(), expected.toLowerCase()) ? { ok: true } : { ok: false, reason: 'bad signature' };
  }
  if (spec.type === 'jwt') {
    // Minimal HS256 verification: header.payload signed with the secret.
    const parts = provided.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed jwt' };
    const expected = crypto.createHmac('sha256', spec.secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    return timingEqual(parts[2], expected) ? { ok: true } : { ok: false, reason: 'bad jwt signature' };
  }
  return { ok: false, reason: 'unknown verify type' };
}

export interface DispatchDeps {
  events: WebhookEventSpec[];
  onEvent: (e: WebhookEvent) => void | Promise<void>;
  seen?: SeenStore;
  deliveryIdHeader?: string;
}

export interface DispatchResult {
  status: number;
  body: { ok: boolean; reason?: string; deduped?: boolean };
}

/** Pure intake logic (no Express): verify, dedup, dispatch. Returns the HTTP status + body to send. */
export async function dispatchWebhook(
  deps: DispatchDeps,
  params: { provider: string; event: string },
  rawBody: string,
  headers: Record<string, string | undefined>,
): Promise<DispatchResult> {
  const spec = deps.events.find((e) => e.provider === params.provider && e.event === params.event);
  if (!spec) return { status: 404, body: { ok: false, reason: 'unknown provider/event' } };

  const verdict = verifySignature(spec.verify, rawBody, headers);
  if (!verdict.ok) return { status: 401, body: { ok: false, reason: verdict.reason } };

  const idHeader = (deps.deliveryIdHeader || 'x-delivery-id').toLowerCase();
  // Delivery id: provider header, else a content hash so replays of the same body dedup too.
  const deliveryId = headers[idHeader] || crypto.createHash('sha256').update(`${params.provider}:${params.event}:${rawBody}`).digest('hex');

  if (deps.seen && (await deps.seen.has(deliveryId))) {
    return { status: 200, body: { ok: true, deduped: true } };
  }

  let payload: unknown = {};
  try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch { payload = { raw: rawBody }; }

  await deps.onEvent({ provider: params.provider, event: params.event, deliveryId, payload, headers });
  if (deps.seen) await deps.seen.add(deliveryId);
  return { status: 200, body: { ok: true } };
}

/** Small bounded in-memory dedup store (default). Survives a single process; not cross-replica. */
export function inMemorySeenStore(max = 5000): SeenStore {
  const set = new Set<string>();
  const order: string[] = [];
  return {
    has: (id) => set.has(id),
    add: (id) => {
      if (set.has(id)) return;
      set.add(id); order.push(id);
      while (order.length > max) { const old = order.shift(); if (old) set.delete(old); }
    },
  };
}

/**
 * Express router mounting POST /:provider/:event (mount at /api/hooks). Requires the raw body — wire
 * `express.json({ verify: (req,_res,buf) => { (req as any).rawBody = buf.toString('utf8'); } })` so
 * HMAC verification sees the exact bytes the provider signed. This router is NOT mounted by default.
 */
export function createWebhookIngressRouter(deps: DispatchDeps): Router {
  const router = Router();
  const seen = deps.seen ?? inMemorySeenStore();
  router.post('/:provider/:event', async (req: Request, res: Response) => {
    const rawBody = (req as { rawBody?: string }).rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    const headers: Record<string, string | undefined> = {};
    for (const key of Object.keys(req.headers)) {
      const v = req.headers[key];
      headers[key.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }
    const result = await dispatchWebhook({ ...deps, seen }, { provider: String(req.params.provider), event: String(req.params.event) }, rawBody, headers);
    res.status(result.status).json(result.body);
  });
  return router;
}
