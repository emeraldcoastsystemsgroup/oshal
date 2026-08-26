/**
 * RingCentral inbound-call screen-pop listener (docs/connectors/ringcentral-screen-pop-spec.md).
 *
 * The API owns one RingCentral WebSocket per connected user who currently has the CRM open,
 * subscribed to that user's detailed extension presence. Inbound-ringing snapshots are
 * normalized to a minimal event and forwarded ONLY to that same user's authenticated SSE
 * clients. RingCentral tokens and WebSocket tokens never reach the browser or a package.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial listener manager per the screen-pop spec: owner-scoped SSE route (GET /ringcentral/events), one lazily-started RingCentral WebSocket per user keyed by user_sub (tabs share it; the last tab's close releases it after a grace period), wstoken + subscription-create over the socket, pure presence-frame parser (inbound Ringing only), per-user telephonySessionId dedupe with TTL, generation-guarded reconnect with bounded jittered backoff, and 401/403 -> reconnect_required status instead of a retry loop. No call control anywhere - ReadPresence + WebSocketsSubscription is the whole surface.
 */

import type { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import WebSocket from 'ws';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { getValidAccessToken } from './connector-account-operations';
import { caller } from './connector-response-helpers';

const logger = createChildLogger({ module: 'ringcentral-screen-pop' });

const PRESENCE_FILTER = '/restapi/v1.0/account/~/extension/~/presence?detailedTelephonyState=true';
const RELEASE_GRACE_MS = 30_000;   // absorb page reloads before releasing the listener
const DEDUPE_TTL_MS = 10 * 60_000; // one prompt per telephony session, snapshots suppressed
const KEEPALIVE_MS = 25_000;       // SSE comment ping so proxies keep the stream open
const MAX_BACKOFF_MS = 60_000;

/** @description RingCentral API host (production default; devtest sandbox via env). @returns Base URL, no trailing slash. */
function rcBase(): string {
  return (process.env.RINGCENTRAL_SERVER_URL || 'https://platform.ringcentral.com').replace(/\/$/, '');
}

/** @description The minimized ringing event a browser is allowed to see — never tokens, never other calls. */
export interface RingingEvent {
  type: 'ringcentral.inbound-ringing';
  telephonySessionId: string;
  extensionId: string;
  from: string;
  fromName?: string;
  queueCall: boolean;
  startedAt?: string;
  receivedAt: string;
}

/**
 * @description Parse one raw RingCentral WebSocket frame into inbound-ringing events. Pure and
 * fail-quiet: a malformed frame, a non-notification message, an outbound call, or any telephony
 * state other than Ringing yields nothing — the listener must never crash on provider data. Only
 * the minimum screen-pop fields are read; unrelated active calls are dropped here, before any
 * broadcast, so they cannot reach a browser.
 * @param raw - the frame text as received from the socket
 * @returns zero or more normalized ringing events
 */
export function parsePresenceFrames(raw: string): RingingEvent[] {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return []; }
  const parts = Array.isArray(msg) ? msg : [msg];
  const out: RingingEvent[] = [];
  for (const part of parts) {
    const body = (part as any)?.body;
    if (!body || !Array.isArray(body.activeCalls)) continue;
    for (const call of body.activeCalls) {
      if (call?.direction !== 'Inbound' || call?.telephonyStatus !== 'Ringing') continue;
      if (!call.telephonySessionId || typeof call.from !== 'string' || !call.from.trim()) continue;
      out.push({
        type: 'ringcentral.inbound-ringing',
        telephonySessionId: String(call.telephonySessionId),
        extensionId: body.extensionId != null ? String(body.extensionId) : '',
        from: String(call.from).trim(),
        ...(call.fromName ? { fromName: String(call.fromName).slice(0, 120) } : {}),
        queueCall: call.queueCall === true,
        ...(call.startTime ? { startedAt: String(call.startTime) } : {}),
        receivedAt: new Date().toISOString(),
      });
    }
  }
  return out;
}

/**
 * @description Recognize the acknowledgement of our subscription-create request so the UI may
 * honestly claim "listening" — the spec forbids claiming it before RingCentral acknowledges.
 * @param raw - the frame text
 * @param messageId - the ClientRequest messageId we sent
 * @returns true when this frame is a successful (2xx/absent-status) reply to that request
 */
export function isSubscriptionAck(raw: string, messageId: string): boolean {
  let msg: unknown;
  try { msg = JSON.parse(raw); } catch { return false; }
  const meta = Array.isArray(msg) ? (msg as any[])[0] : (msg as any);
  if (!meta || meta.messageId !== messageId) return false;
  const status = Number(meta.status ?? 200);
  return status >= 200 && status < 300;
}

interface UserListener {
  sub: string;
  clients: Set<Response>;
  ws: WebSocket | null;
  state: 'starting' | 'listening' | 'reconnecting' | 'not_connected' | 'reconnect_required';
  seen: Map<string, number>;
  releaseTimer: NodeJS.Timeout | null;
  keepalive: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  attempts: number;
  gen: number;   // bumps on every (re)start; stale socket callbacks compare and bail
}

const listeners = new Map<string, UserListener>();

/** @description Write one SSE event to a client; a dead socket just drops it. */
function sseWrite(res: Response, event: string, data: unknown): void {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
}

/** @description Broadcast the listener's state to every attached tab. */
function broadcastStatus(l: UserListener): void {
  for (const res of l.clients) sseWrite(res, 'status', { state: l.state });
}

/** @description Forward a ringing event once per telephony session (snapshots repeat it). */
function broadcastRing(l: UserListener, evt: RingingEvent): void {
  const now = Date.now();
  for (const [k, t] of l.seen) if (now - t > DEDUPE_TTL_MS) l.seen.delete(k);
  if (l.seen.has(evt.telephonySessionId)) return;
  l.seen.set(evt.telephonySessionId, now);
  logger.info({ sub: l.sub, session: evt.telephonySessionId.slice(0, 12) }, 'ringcentral: inbound ringing forwarded');
  for (const res of l.clients) sseWrite(res, 'ring', evt);
}

/** @description Tear the socket down without touching SSE clients (reconnect keeps them). */
function closeSocket(l: UserListener): void {
  l.gen += 1;
  if (l.ws) { try { l.ws.close(); } catch { /* already closed */ } l.ws = null; }
}

/** @description Schedule a jittered, bounded reconnect while any tab is still attached. */
function scheduleReconnect(ctx: AppContext, l: UserListener): void {
  if (!l.clients.size || l.reconnectTimer) return;
  l.state = 'reconnecting';
  broadcastStatus(l);
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(l.attempts, 6)) + Math.floor(Math.random() * 1000);
  l.attempts += 1;
  l.reconnectTimer = setTimeout(() => {
    l.reconnectTimer = null;
    void startListener(ctx, l);
  }, delay);
}

/**
 * @description Acquire the user's RingCentral socket: fresh access token → short-lived
 * WebSocket token → socket → subscription-create for detailed extension presence. An
 * authorization failure parks the listener as reconnect_required (the user must re-consent);
 * anything else retries with backoff while a tab remains attached.
 * @param ctx - app context (pool for the token broker)
 * @param l - the user's listener record
 * @returns resolves when the start attempt has concluded (listening, parked, or rescheduled)
 */
async function startListener(ctx: AppContext, l: UserListener): Promise<void> {
  closeSocket(l);
  const gen = l.gen;
  try {
    const access = await getValidAccessToken(ctx.pool, l.sub, 'ringcentral');
    if (!access) { l.state = 'not_connected'; broadcastStatus(l); return; }
    const wst = await fetch(`${rcBase()}/restapi/oauth/wstoken`, {
      method: 'POST', headers: { Authorization: `Bearer ${access}` },
    });
    if (wst.status === 401 || wst.status === 403) {
      l.state = 'reconnect_required';
      broadcastStatus(l);
      logger.warn({ sub: l.sub, status: wst.status }, 'ringcentral: authorization no longer honored — reauthentication required');
      return;
    }
    if (!wst.ok) throw new Error(`wstoken ${wst.status}`);
    const grant = (await wst.json()) as { uri?: string; ws_access_token?: string };
    if (!grant.uri || !grant.ws_access_token) throw new Error('wstoken response missing uri/ws_access_token');
    if (gen !== l.gen || !l.clients.size) return; // released or restarted while we fetched

    const ws = new WebSocket(`${grant.uri}?access_token=${encodeURIComponent(grant.ws_access_token)}`);
    l.ws = ws;
    const subMsgId = `sub-${crypto.randomBytes(6).toString('hex')}`;
    ws.on('open', () => {
      if (gen !== l.gen) return;
      ws.send(JSON.stringify([
        { type: 'ClientRequest', messageId: subMsgId, method: 'POST', path: '/restapi/v1.0/subscription' },
        { eventFilters: [PRESENCE_FILTER], deliveryMode: { transportType: 'WebSocket' } },
      ]));
    });
    ws.on('message', (data: unknown) => {
      if (gen !== l.gen) return;
      const raw = String(data);
      if (l.state !== 'listening' && isSubscriptionAck(raw, subMsgId)) {
        l.state = 'listening';
        l.attempts = 0;
        broadcastStatus(l);
        logger.info({ sub: l.sub }, 'ringcentral: presence subscription acknowledged');
        return;
      }
      for (const evt of parsePresenceFrames(raw)) broadcastRing(l, evt);
    });
    const onGone = () => { if (gen === l.gen && l.clients.size) scheduleReconnect(ctx, l); };
    ws.on('close', onGone);
    ws.on('error', (err: Error) => {
      if (gen === l.gen) logger.warn({ err: err.message, sub: l.sub }, 'ringcentral: socket error');
      onGone();
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, sub: l.sub }, 'ringcentral: listener start failed');
    if (gen === l.gen) scheduleReconnect(ctx, l);
  }
}

/** @description Release a user's listener entirely (last tab gone past the grace period). */
function releaseListener(sub: string): void {
  const l = listeners.get(sub);
  if (!l || l.clients.size) return;
  closeSocket(l);
  if (l.keepalive) clearInterval(l.keepalive);
  if (l.reconnectTimer) clearTimeout(l.reconnectTimer);
  listeners.delete(sub);
  logger.info({ sub }, 'ringcentral: listener released');
}

/**
 * @description Register the owner-scoped screen-pop event stream on the /api/connect router.
 * GET /ringcentral/events (SSE): the first stream for a user acquires that user's RingCentral
 * listener, additional tabs share it, and the last close releases it after a grace period.
 * Events carry only the minimized ringing payload and status states — never tokens.
 * @param router - the /api/connect sub-router (already behind requiresAuth)
 * @param ctx - app context
 * @returns nothing; the route is registered in place
 */
export function registerRingcentralScreenPop(router: Router, ctx: AppContext): void {
  router.get('/ringcentral/events', (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    let l = listeners.get(me.sub);
    if (!l) {
      l = {
        sub: me.sub, clients: new Set(), ws: null, state: 'starting', seen: new Map(),
        releaseTimer: null, keepalive: null, reconnectTimer: null, attempts: 0, gen: 0,
      };
      listeners.set(me.sub, l);
      l.keepalive = setInterval(() => { for (const c of l!.clients) { try { c.write(': ping\n\n'); } catch { /* closed */ } } }, KEEPALIVE_MS);
      void startListener(ctx, l);
    }
    if (l.releaseTimer) { clearTimeout(l.releaseTimer); l.releaseTimer = null; }
    l.clients.add(res);
    sseWrite(res, 'status', { state: l.state });

    req.on('close', () => {
      const cur = listeners.get(me.sub);
      if (!cur) return;
      cur.clients.delete(res);
      if (!cur.clients.size && !cur.releaseTimer) {
        cur.releaseTimer = setTimeout(() => releaseListener(me.sub), RELEASE_GRACE_MS);
      }
    });
  });
}
