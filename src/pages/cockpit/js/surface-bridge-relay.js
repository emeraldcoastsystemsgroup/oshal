/**
 * Cockpit surface-bridge relay — the BROWSER wiring over the pure contract in
 * src/features/surface-bridge/ (bundled to /dist/surface-bridge.js by vite.config.ts, the
 * response-renderer precedent — the relay imports the REAL normalizer/resolver, never a
 * hand-ported twin that could drift).
 *
 * The cockpit hosts two sibling iframes: the focused app's surface (renderToolView's
 * `.tool-view-container iframe`) and the chat rail (#chatWorkspaceFrame). Neither can reach the
 * other directly — everything crosses this shell-mediated relay, which is the security point:
 *
 *   1. Only messages that normalize against the contract pass (channel + version + known op +
 *      schema; every text field HTML-stripped). Anything else is dropped, not thrown.
 *   2. The event's `app` claim is checked against the TRUSTED binding — the `?app=` the cockpit
 *      itself resolved (the same source of truth RibbonNav uses). An iframe can claim any app in
 *      its payload; it still only ever speaks as the app the shell embedded it for.
 *   3. The op must be in the app manifest's declared `surface.ops` allow-list (delivered on the
 *      synthesised UI profile as `surfaceOps`). FAIL-CLOSED: no declaration = empty allow-list =
 *      nothing relayed.
 *   4. The emitter must be the RIGHT sibling: to_bot only from the app-surface iframe, to_surface
 *      only from the chat rail — so a surface can't forge user-actions from the bot's direction
 *      or vice versa. Same-origin only (both frames are same-origin by construction).
 *
 * Routing: to_surface → the app-surface iframe (its surface-bridge-client renders it); to_bot →
 * the chat-rail iframe. The one special case is `navigate`, which targets the SHELL, not the
 * surface — it is re-posted as the ribbon's existing `{type:'app-navigate', tool}` dialect, so
 * RibbonNav's handler (and its not-in-ribbon warning) stays the single navigation authority.
 * This module is ADDITIVE alongside the existing `oshal-cockpit-*` (embedded-chat-panel) and
 * `app-navigate`/`lm-*` (RibbonNav) dialects — it rewrites neither.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — cockpit-mediated relay: normalize → trusted-app + surface.ops allow-list (fail-closed) → emitter-sibling check → deliver (to_surface → app iframe, to_bot → chat rail, navigate → the ribbon's app-navigate dialect). DI factory so the guard spec drives it with the real contract and fake windows.
 */

/**
 * @description Build a surface-bridge relay from injected dependencies. Pure wiring — no module
 * state, no DOM lookups of its own — so the unit guard can drive it with the REAL contract
 * functions and fake windows. The cockpit boots it via {@link bootSurfaceBridgeRelay}.
 * @param {object} deps
 * @param {{ normalizeSurfaceEvent: Function, resolveRelayTarget: Function }} deps.contract - the bundled surface-bridge contract.
 * @param {() => (string|null)} deps.getApp - TRUSTED app binding of the embedded surface (from the cockpit's own `?app=` resolution — never from a message).
 * @param {() => (string[]|null)} deps.getAllowedOps - the focused app's declared `surface.ops` (null/absent ⇒ treated as EMPTY — fail-closed).
 * @param {() => (Window|null)} deps.getSurfaceWindow - contentWindow of the app-surface iframe (looked up per message; the iframe is recreated on view changes).
 * @param {() => (Window|null)} deps.getChatWindow - contentWindow of the chat-rail iframe.
 * @param {(msg: object) => void} deps.postToShell - deliver a shell-targeted message (the ribbon's app-navigate dialect).
 * @param {string} deps.origin - the only origin accepted AND used for postMessage targeting.
 * @param {{ debug: Function, warn: Function }} [deps.logger] - optional logger (defaults to silent).
 * @returns {{ handleMessage: (evt: MessageEvent) => {delivered: boolean, reason: string, target?: string}, attach: (win: Window) => void, detach: (win: Window) => void }}
 */
export function createSurfaceBridgeRelay(deps) {
  const { contract, getApp, getAllowedOps, getSurfaceWindow, getChatWindow, postToShell, origin } = deps;
  const logger = deps.logger || { debug: () => {}, warn: () => {} };

  /** Route one delivered event to its sibling frame (or the shell, for navigate). */
  function deliver(evt, event, direction) {
    const surfaceWin = getSurfaceWindow();
    const chatWin = getChatWindow();
    if (direction === 'to_bot') {
      // User-action events may only originate from the app's own surface iframe.
      if (!surfaceWin || evt.source !== surfaceWin) return { delivered: false, reason: 'emitter_not_surface' };
      if (!chatWin) return { delivered: false, reason: 'no_chat_frame' };
      chatWin.postMessage(event, origin);
      return { delivered: true, reason: 'ok', target: 'chat' };
    }
    // Bot-driven events may only originate from the chat rail.
    if (!chatWin || evt.source !== chatWin) return { delivered: false, reason: 'emitter_not_chat_rail' };
    if (event.op === 'navigate') {
      // Navigation targets the SHELL: reuse the ribbon's existing dialect so RibbonNav
      // stays the one navigation authority (including its target-not-in-ribbon warning).
      postToShell({ type: 'app-navigate', tool: event.to });
      return { delivered: true, reason: 'ok', target: 'shell' };
    }
    if (!surfaceWin) return { delivered: false, reason: 'no_surface_frame' };
    surfaceWin.postMessage(event, origin);
    return { delivered: true, reason: 'ok', target: 'surface' };
  }

  /** The window 'message' listener: normalize → authorize → deliver. Drops are returns, never throws. */
  function handleMessage(evt) {
    if (!evt || evt.origin !== origin) return { delivered: false, reason: 'foreign_origin' };
    const normalized = contract.normalizeSurfaceEvent(evt.data);
    if (!normalized.ok) {
      // Non-bridge window traffic (the oshal-cockpit-* and app-navigate dialects, devtools, …)
      // lands here constantly — debug, not warn.
      logger.debug('surface-bridge: message not a bridge event', { reason: normalized.reason });
      return { delivered: false, reason: normalized.reason };
    }
    const app = getApp();
    if (!app) return { delivered: false, reason: 'no_focused_app' };
    // FAIL-CLOSED: an app that declared no surface.ops gets an EMPTY allow-list, not a pass-through.
    const allowedOps = getAllowedOps() || [];
    const decision = contract.resolveRelayTarget(normalized.event, { app, allowedOps });
    if (!decision.deliver) {
      // A silent drop of a VALID bridge event is how a broken app surface hides for months —
      // warn with the reason (app_mismatch / op_not_allowed) so the sending surface gets fixed.
      logger.warn('surface-bridge: valid event refused', { reason: decision.reason, op: normalized.event.op });
      return { delivered: false, reason: decision.reason };
    }
    const outcome = deliver(evt, normalized.event, decision.direction);
    if (!outcome.delivered) logger.warn('surface-bridge: delivery failed', { reason: outcome.reason, op: normalized.event.op });
    return outcome;
  }

  return {
    handleMessage,
    attach(win) { win.addEventListener('message', handleMessage); },
    detach(win) { win.removeEventListener('message', handleMessage); },
  };
}

/**
 * @description Boot the relay inside the cockpit shell: resolve the trusted `?app=` binding
 * (no app focused ⇒ no relay — the plain cockpit embeds no app surface), import the bundled
 * contract, and attach the listener. The allow-list is read LAZILY per message from the ribbon's
 * fetched profile (`surfaceOps` off synthesiseProfile), so the relay never races the profile
 * fetch — before it resolves the list is empty and everything drops, which is the correct
 * fail-closed posture.
 * @param {Window} [win] - the shell window (defaults to the global).
 * @returns {Promise<null|object>} the attached relay, or null when there is nothing to relay.
 */
export async function bootSurfaceBridgeRelay(win = window) {
  const params = new URLSearchParams(win.location.search);
  const app = params.get('app') || params.get('profile');
  if (!app) return null;
  let contract;
  try {
    contract = await import(/* @vite-ignore */ '/dist/surface-bridge.js');
  } catch (err) {
    // Bundle missing (dev tree without a vite build) — the bridge is additive, never fatal.
    console.warn('[surface-bridge] contract bundle unavailable — relay disabled', err?.message || err);
    return null;
  }
  const relay = createSurfaceBridgeRelay({
    contract,
    getApp: () => app,
    getAllowedOps: () => {
      const profile = win.__cockpit?.ribbon?.profile;
      // Only trust the allow-list when the fetched profile IS the focused app's.
      return profile && profile.name === app && Array.isArray(profile.surfaceOps) ? profile.surfaceOps : [];
    },
    getSurfaceWindow: () => win.document.querySelector('.tool-view-container iframe')?.contentWindow ?? null,
    getChatWindow: () => win.document.getElementById('chatWorkspaceFrame')?.contentWindow ?? null,
    postToShell: (msg) => win.postMessage(msg, win.location.origin),
    origin: win.location.origin,
    logger: { debug: () => {}, warn: (m, d) => console.warn('[surface-bridge]', m, d) },
  });
  relay.attach(win);
  win.__surfaceBridgeRelay = relay;
  return relay;
}

// Self-boot in the browser only (the guard spec imports the factory without a window).
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__SURFACE_BRIDGE_RELAY_NO_AUTOBOOT) {
  void bootSurfaceBridgeRelay(window);
}
