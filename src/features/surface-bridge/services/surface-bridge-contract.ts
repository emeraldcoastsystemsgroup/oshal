/**
 * Surface Bridge — the pure normalizer + relay-target resolver.
 *
 * A cockpit relay (sibling iframes: an app surface + the chat rail) uses this to (1) validate and
 * clean any inbound window message against the {@link module:features/surface-bridge/types} contract
 * before trusting it, and (2) decide where a valid event goes (surface vs bot) and whether the
 * emitting app is even allowed to send it. Pure + DOM-free: unit-testable, and reusable server-side
 * to validate the ops an ADR-085 app package declares in its manifest.
 *
 * SECURITY POSTURE (why normalize is not optional):
 *   - A postMessage handler receives events from an iframe the cockpit hosts but does not fully
 *     trust (an app-store package's surface). So: reject anything without the channel discriminator
 *     + matching version, reject unknown ops (fail-closed), and STRIP HTML tags from every text
 *     field — the contract carries structured data + text, never markup; the renderer decides how to
 *     render, so a surface can never inject markup into another surface or the shell via the bridge.
 *   - `resolveRelayTarget` enforces the isolation key: an event's `app` must match the surface it
 *     came from, and its op must be in that app's declared allow-list — an app cannot drive another
 *     app's surface or emit an op it never registered.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — normalizeSurfaceEvent (schema-guard + HTML strip + direction classify) and resolveRelayTarget (app/op isolation + direction routing).
 *
 * @module features/surface-bridge/services/surface-bridge-contract
 */

import {
  INBOUND_OPS,
  InboundEventSchema,
  OUTBOUND_OPS,
  OutboundEventSchema,
  SURFACE_BRIDGE_CHANNEL,
  SURFACE_BRIDGE_VERSION,
  type InboundOp,
  type OutboundOp,
  type SurfaceBridgeDirection,
  type SurfaceBridgeEvent,
} from '../types';

/** Result of validating+cleaning a raw window message. */
export type NormalizeResult =
  | { ok: true; event: SurfaceBridgeEvent; direction: SurfaceBridgeDirection }
  | { ok: false; reason: string };

/** Remove HTML tags + collapse the leftover so no field can carry markup across the bridge. */
export function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')        // drop tags
    .replace(/&lt;|&gt;/gi, '')     // and pre-escaped angle brackets that could re-form a tag
    .trim();
}

/** Deep-sanitize every string in a value (recurses arrays/objects) via {@link stripHtml}. */
function sanitizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return stripHtml(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeDeep(v);
    return out;
  }
  return value;
}

const OUTBOUND = new Set<string>(OUTBOUND_OPS);
const INBOUND = new Set<string>(INBOUND_OPS);

/**
 * @description Validate + clean one raw window-message payload against the surface-bridge contract.
 * Fail-closed: anything without the channel/version, or with an unknown op or malformed payload, is
 * rejected. On success returns the parsed event with all text fields HTML-stripped, plus its
 * direction (so the relay routes without reparsing).
 * @param raw - The untrusted `event.data` from a postMessage listener.
 * @returns `{ok:true, event, direction}` or `{ok:false, reason}`.
 */
export function normalizeSurfaceEvent(raw: unknown): NormalizeResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not_an_object' };
  const rec = raw as Record<string, unknown>;
  if (rec.channel !== SURFACE_BRIDGE_CHANNEL) return { ok: false, reason: 'wrong_channel' };
  if (rec.v !== SURFACE_BRIDGE_VERSION) return { ok: false, reason: 'version_mismatch' };
  if (typeof rec.op !== 'string') return { ok: false, reason: 'missing_op' };

  const isOutbound = OUTBOUND.has(rec.op);
  const isInbound = INBOUND.has(rec.op);
  if (!isOutbound && !isInbound) return { ok: false, reason: `unknown_op:${rec.op}` };

  // Sanitize BEFORE schema validation so cleaned strings still satisfy .min(1) etc. — and a field
  // that was ONLY markup (→ empty after strip) correctly fails validation rather than passing blank.
  const cleaned = sanitizeDeep(rec) as Record<string, unknown>;
  const schema = isOutbound ? OutboundEventSchema : InboundEventSchema;
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) return { ok: false, reason: `invalid_payload:${parsed.error.issues[0]?.message ?? 'schema'}` };

  return { ok: true, event: parsed.data as SurfaceBridgeEvent, direction: isOutbound ? 'to_surface' : 'to_bot' };
}

/** Where a normalized event should be delivered, and whether it is allowed at all. */
export interface RelayDecision {
  deliver: boolean;
  direction: SurfaceBridgeDirection;
  reason: string;
}

/** Context the relay knows about the app the event concerns. */
export interface RelayContext {
  /** The manifest app the emitting iframe is bound to (the trusted source of truth, not from the event). */
  app: string;
  /** Ops this app declared it may use (from its manifest). Omit to allow any well-formed op. */
  allowedOps?: ReadonlyArray<OutboundOp | InboundOp>;
}

/**
 * @description Decide whether a normalized event may be relayed, and in which direction. Enforces
 * the isolation key: the event's `app` must equal the trusted `ctx.app` (an app can't spoof another),
 * and the op must be in `ctx.allowedOps` when the app declared a set. Deliver=false is a drop, not a
 * throw — the relay ignores it.
 * @param event - A normalized surface-bridge event.
 * @param ctx - The trusted app binding + optional declared op allow-list.
 * @returns The relay decision.
 */
export function resolveRelayTarget(event: SurfaceBridgeEvent, ctx: RelayContext): RelayDecision {
  const direction: SurfaceBridgeDirection = OUTBOUND.has(event.op) ? 'to_surface' : 'to_bot';
  if (event.app !== ctx.app) {
    return { deliver: false, direction, reason: `app_mismatch:${event.app}!=${ctx.app}` };
  }
  if (ctx.allowedOps && !ctx.allowedOps.includes(event.op as OutboundOp & InboundOp)) {
    return { deliver: false, direction, reason: `op_not_allowed:${event.op}` };
  }
  return { deliver: true, direction, reason: 'ok' };
}

/** Type guard: is this an outbound (bot→surface) op string? */
export function isOutboundOp(op: string): op is OutboundOp {
  return OUTBOUND.has(op);
}

/** Type guard: is this an inbound (surface→bot) op string? */
export function isInboundOp(op: string): op is InboundOp {
  return INBOUND.has(op);
}
