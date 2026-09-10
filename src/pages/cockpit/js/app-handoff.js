/** Context stays in memory and is delivered only to the selected same-origin app frame. */
const TTL = 120000;
let pending = null;

/** A Home destination comes from the caller-visible manifest plan, never a summary item's URL. */
export function homeSurfaceView(viewId, destination) {
  if (!destination || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(destination.name)
    || viewId !== `tool-${destination.name}` || typeof destination.url !== 'string'
    || !/^\/(?!\/)/.test(destination.url) || /[\\\r\n]/.test(destination.url)) return null;
  const url = new URL(destination.url, window.location.origin);
  if (url.origin !== window.location.origin) return null;
  return { id: viewId, label: destination.name.replace(/[-_]/g, ' '),
    toolUi: { iframeUrl: url.href } };
}

/** Strict receiver field allow-list. Values are text, never executable options or authority. */
export function contextFor(fields, value) {
  if (!Array.isArray(fields) || !fields.length || fields.length > 12 || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).length > 12 || Object.keys(value).some(key => !fields.includes(key))) return null;
  const result = {};
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || typeof value[key] !== 'string' || value[key].length > 2000) return null;
    result[key] = value[key];
  }
  return Object.keys(result).length ? result : null;
}

/** Stage only a resolved contract obtained again from the current authenticated Home plan. */
export function stageHandoff(offer, value) {
  pending = null;
  const context = contextFor(offer?.fields, value);
  if (offer?.state !== 'available' || !offer.surface || !context) return false;
  pending = { type: 'oshal:app-context', sourceApp: offer.sourceApp, targetApp: offer.targetApp,
    action: offer.targetAction, contextType: offer.contextType, version: offer.version,
    surface: offer.surface, context, expiresAt: Date.now() + TTL };
  return true;
}

/** Called by the shell when its chosen frame loads; consumes once even on failure. */
export function deliverHandoff(frame, surface) {
  const message = pending;
  pending = null;
  if (!message || message.surface !== surface || message.expiresAt < Date.now()) return;
  const destination = new URL(frame.src, window.location.href);
  if (destination.origin !== window.location.origin) return;
  frame.addEventListener('load', () => {
    if (message.expiresAt >= Date.now() && frame.isConnected) frame.contentWindow?.postMessage(message, destination.origin);
  }, { once: true });
}

/** App receiver: fill a reviewable draft only. The callback must never execute business actions. */
export function receiveHandoff(contract, onDraft) {
  const listener = event => {
    if (window.parent === window || event.source !== window.parent || event.origin !== window.location.origin) return;
    const m = event.data;
    if (!m || m.type !== 'oshal:app-context' || m.targetApp !== contract.app || m.action !== contract.action
      || m.contextType !== contract.contextType || m.version !== contract.version
      || !Number.isFinite(m.expiresAt) || m.expiresAt < Date.now() || m.expiresAt > Date.now() + TTL) return;
    const context = contextFor(contract.fields, m.context);
    if (!context) return;
    window.removeEventListener('message', listener);
    onDraft(context, { sourceApp: String(m.sourceApp || '').slice(0, 64) });
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
