/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Authorize ticket SSE before subscribing and recheck current rights before each event and heartbeat.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The ticket-else-task check moved unchanged to cockpit-resource-access.ts (canReadCockpitTicketOrTask) so other cockpit routes share it.
 */
import type { Request, Response } from 'express';
import type { AppContext } from '../composition-root';
import { canReadCockpitTicketOrTask as readable } from './cockpit-resource-access';

/** @description A canonical ticket ID and its activity payload; wildcard IDs are never delivered. */
export type TicketActivityEvent = { ticketId: string; entry: Record<string, unknown> };
/** @description An event-bus observer owned by one authenticated stream connection. */
export type TicketActivityListener = (event: TicketActivityEvent) => void;

/** @description Own one admitted SSE subscription and serialize current-policy checks. @param ctx Runtime. @param req Verified caller. @param res Stream response. @param bus Existing event bus. @returns No value. */
function subscribe(ctx: AppContext, req: Request, res: Response, bus: Set<TicketActivityListener>): void {
  const id = String(req.params.ticketId);
  let closed = false;
  let pending = Promise.resolve();
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(heartbeat); bus.delete(listener); res.end();
  };
  const send = (event: string, payload: Record<string, unknown>) => {
    pending = pending.then(async () => {
      if (closed) return;
      if (!await readable(ctx, req, id)) { close(); return; }
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }).catch(close);
  };
  const listener: TicketActivityListener = event => {
    if (event.ticketId === id) send('ticket-activity', event.entry);
  };
  const heartbeat = setInterval(() => send('heartbeat', { timestamp: Date.now() }), 30000);
  res.once('close', close);
  bus.add(listener);
  send('connected', { ticketId: id, timestamp: Date.now() });
}

/** @description Refuse unreadable resources before sending headers or registering listeners. @param ctx Runtime. @param bus Existing event bus. @returns Ticket SSE handler. */
export function handleCockpitTicketStream(ctx: AppContext, bus: Set<TicketActivityListener>) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!await readable(ctx, req, String(req.params.ticketId))) {
      res.status(404).json({ success: false, error: 'Ticket not found' }); return;
    }
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    subscribe(ctx, req, res, bus);
  };
}
