/**
 * Surface-bridge PRODUCER — the reply→surface half of the browser wiring over
 * src/features/surface-bridge/ (the cockpit relay is surface-bridge-relay.js; the surface-side
 * renderer/emitter is shared/ui/js/surface-bridge-client.js — its sibling in THIS shared dir).
 *
 * It parses a bot reply's single ```oshal:surface fenced JSON block and posts each declared outbound
 * op as a SEAM-B envelope ({ channel:'oshal-surface-bridge', v:1, app, op, ... }). The reply's
 * user-visible text is the SAME reply with the fence removed — the bubble never shows the control
 * syntax (the exact sibling of the server-side stripSurfaceDirective).
 *
 * TWO DELIVERY MODES (postTarget), because the same parse/strip vocabulary serves two callers:
 *   - `parent` (default) — the cockpit CHAT RAIL: the envelope is posted to the parent shell so the
 *     EXISTING relay validates channel/version/app + the manifest allow-list and routes it to the
 *     focused app's surface iframe. This is the swarmbot-chat rail's path.
 *   - `self` — a SURFACE driving its OWN embedded dock (e.g. workflow-studio's talk-to-build panel,
 *     which lives INSIDE the app-surface iframe alongside the surface-bridge-client). The relay
 *     refuses a `to_surface` from a non-chat-rail frame (emitter_not_chat_rail — a surface must not
 *     forge bot-direction events for OTHER apps), so the panel cannot use the relay; instead it posts
 *     the envelope to its OWN window, where the co-resident surface-bridge-client receives it. This is
 *     same-app-by-construction (the app drives only itself), so the relay's cross-app allow-list is
 *     moot; ops are still name-validated here and the client renders textContent-only.
 *
 * It also closes the loop the other way (chat-rail mode): a `select`/`field_change`/`submit`/`event`
 * the surface emits is relayed BACK to the rail (surface→bot), and consumeInbound() turns it into a
 * plain-text chat message for the bot ("selections flow back to the bot, end to end").
 *
 * APP BINDING: an envelope's `app` is either the caller's EXPLICIT `app` (a surface knows its own
 * identity by construction — the `self` mode) or the cockpit's focused `?app=` read from the parent
 * shell's URL (the chat rail, same-origin by construction — the trusted binding the relay checks).
 * No app resolvable ⇒ nothing is emitted (still returns the stripped text).
 *
 * The channel/version literals + the outbound op list are LITERALS here (not imports) for the same
 * reason the surface client keeps its own: a browser surface module must not drag the zod/contract
 * bundle (or an auth-gated /dist fetch) in for a few constants. tests/unit/surface-directives.spec.ts
 * asserts these equal the TS contract's SURFACE_BRIDGE_CHANNEL / SURFACE_BRIDGE_VERSION /
 * SURFACE_BRIDGE_OUTBOUND_OPS so they can never drift.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — chat-rail producer: relayReply (parse the reply's oshal:surface fence → post validated outbound ops to the shell relay, return the fence-stripped text), stripDirectives (strip-only for history replay), and consumeInbound (a relayed surface→bot op → a chat message for the bot). No focused app ⇒ no-op.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Moved src/pages/swarmbot-chat/ → src/shared/ui/js/ (next to surface-bridge-client.js) so it is a SHARED surface module both the chat rail and an app surface import without a pages→pages cross-slice (FSD). Added postTarget ('parent' default | 'self') + an explicit `app` option so a surface (workflow-studio talk-to-build) can drive its OWN co-resident dock — the relay refuses a to_surface from a non-chat-rail frame, so same-iframe self-delivery is the correct path. Parse/strip vocabulary + drift guards unchanged.
 */

/** postMessage channel discriminator — MUST equal SURFACE_BRIDGE_CHANNEL in features/surface-bridge/types.ts (drift-guarded by spec). */
export const SURFACE_BRIDGE_CHANNEL = 'oshal-surface-bridge';
/** Contract version — MUST equal SURFACE_BRIDGE_VERSION in features/surface-bridge/types.ts (drift-guarded by spec). */
export const SURFACE_BRIDGE_VERSION = 1;
/** The CLOSED bot→surface op vocabulary — MUST equal SURFACE_BRIDGE_OUTBOUND_OPS (drift-guarded by spec). */
export const SURFACE_PRODUCER_OUTBOUND_OPS = ['render_options', 'set_field', 'set_content', 'propose', 'navigate', 'notify', 'custom'];

const OUTBOUND = new Set(SURFACE_PRODUCER_OUTBOUND_OPS);
const SURFACE_FENCE = /```oshal:surface\s*([\s\S]*?)```/gi;
const UNTERMINATED_SURFACE_FENCE = /```oshal:surface\b[\s\S]*$/i;

/**
 * @description Removes the `oshal:surface` directive fence(s) from a reply so the chat bubble shows
 * only the human answer (mirrors the server-side stripSurfaceDirective, incl. unterminated fences).
 * @param {string} text - Raw bot reply text.
 * @returns {string} The reply with every surface fence removed.
 */
export function stripSurfaceFence(text) {
  return String(text == null ? '' : text)
    .replace(SURFACE_FENCE, '')
    .replace(UNTERMINATED_SURFACE_FENCE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @description Parses a reply's `oshal:surface` fence into the outbound ops it declares. Fail-closed:
 * a malformed fence body yields nothing, and only ops whose name is in the CLOSED outbound vocabulary
 * survive (the relay does the authoritative per-app + payload validation). Accepts `{ ops: [...] }`
 * or a bare `[...]` fence body.
 * @param {string} text - Raw bot reply text.
 * @returns {Array<Record<string, unknown>>} The declared, name-validated outbound op objects.
 */
export function parseSurfaceOps(text) {
  const ops = [];
  const src = String(text == null ? '' : text);
  SURFACE_FENCE.lastIndex = 0;
  let match;
  while ((match = SURFACE_FENCE.exec(src)) !== null) {
    let body = null;
    try {
      body = JSON.parse(match[1].trim());
    } catch (_error) {
      body = null;
    }
    const declared = Array.isArray(body)
      ? body
      : (body && typeof body === 'object' && Array.isArray(body.ops) ? body.ops : []);
    for (const raw of declared) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.op === 'string' && OUTBOUND.has(raw.op)) {
        ops.push(raw);
      }
    }
  }
  return ops;
}

/** Turn one relayed inbound (surface→bot) envelope into a concise chat message, or null if not one. */
function describeInbound(data) {
  switch (data.op) {
    case 'select':
      return `I selected "${data.optionId}".`;
    case 'field_change':
      return `I set ${data.field} to "${data.value}".`;
    case 'submit':
      return data.confirmed ? `I confirmed the action "${data.actionId}".` : `I cancelled the action "${data.actionId}".`;
    case 'event':
      return `Surface event: ${data.name}.`;
    default:
      return null;
  }
}

/**
 * @description Create a surface-bridge producer.
 * @param {object} opts
 * @param {Window} [opts.win] - The producer's window (defaults to the global). In `parent` mode its
 *   PARENT is the cockpit shell whose `?app=` is the trusted app binding.
 * @param {'parent'|'self'} [opts.postTarget] - Where the outbound envelope is posted: `parent`
 *   (default) → the shell relay (the chat rail); `self` → this same window, so a co-resident
 *   surface-bridge-client renders it (a surface driving its OWN dock — the relay refuses a to_surface
 *   from a non-chat-rail frame).
 * @param {string} [opts.app] - Explicit app binding, used when a surface drives itself (the `self`
 *   mode) — the app identity is known by construction, not derived from the shell. Omit for the chat
 *   rail, which derives the focused app from the shell's `?app=`.
 * @returns {{ relayReply: (text: string) => string, stripDirectives: (text: string) => string, consumeInbound: (data: unknown) => (string|null) }}
 */
export function createSurfaceProducer(opts) {
  const win = (opts && opts.win) || window;
  const postTarget = (opts && opts.postTarget) || 'parent';
  const explicitApp = (opts && typeof opts.app === 'string' && opts.app.trim()) || null;

  /** The bound app: an explicit `app` (a surface driving itself), else the shell's focused `?app=`. */
  function focusedApp() {
    if (explicitApp) {
      return explicitApp;
    }
    try {
      const shell = win.parent && win.parent !== win ? win.parent : null;
      if (!shell) {
        return null;
      }
      const params = new URLSearchParams(shell.location.search);
      const app = (params.get('app') || params.get('profile') || '').trim();
      return app || null;
    } catch (_error) {
      // Cross-origin parent (should never happen — same-origin by construction) ⇒ no focused app.
      return null;
    }
  }

  /** Post one outbound op as a SEAM-B envelope; base stamped LAST so a declared field can't spoof it. */
  function post(app, op) {
    const envelope = { ...op, channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app };
    // `self` targets this window (a co-resident surface-bridge-client); `parent` targets the shell relay.
    const target = postTarget === 'self' ? win : win.parent;
    target.postMessage(envelope, win.location.origin);
    return envelope;
  }

  return {
    /**
     * @description Parse a LIVE assistant reply's surface fence and emit each validated outbound op
     * to the shell relay for the focused app, then return the fence-stripped text for the bubble.
     * No focused app ⇒ no emit (still returns the stripped text).
     * @param {string} text - The assistant's raw reply text.
     * @returns {string} The reply with the surface fence removed.
     */
    relayReply(text) {
      const clean = stripSurfaceFence(text);
      const app = focusedApp();
      if (!app) {
        return clean;
      }
      for (const op of parseSurfaceOps(text)) {
        post(app, op);
      }
      return clean;
    },

    /**
     * @description Strip-only view for HISTORY replay — removes the surface fence WITHOUT emitting
     * (replayed messages already drove the surface when they were live; re-emitting would double it).
     * @param {string} text - A historical assistant reply.
     * @returns {string} The reply with the surface fence removed.
     */
    stripDirectives(text) {
      return stripSurfaceFence(text);
    },

    /**
     * @description Turn a relayed inbound (surface→bot) envelope into a chat message for the bot, or
     * null when it is not a bridge inbound event for the focused app. This is the "selections flow
     * back to the bot" leg — the caller sends the returned message to the active bot.
     * @param {unknown} data - A window-message payload delivered to the chat rail by the relay.
     * @returns {string|null} A plain-text message to send to the bot, or null.
     */
    consumeInbound(data) {
      const app = focusedApp();
      if (!app || !data || typeof data !== 'object') {
        return null;
      }
      if (data.channel !== SURFACE_BRIDGE_CHANNEL || data.v !== SURFACE_BRIDGE_VERSION || data.app !== app) {
        return null;
      }
      return describeInbound(data);
    },
  };
}
