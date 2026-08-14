/**
 * Surface-bridge client — the surface-side half of the browser wiring over
 * src/features/surface-bridge/ (the cockpit-side half is surface-bridge-relay.js).
 *
 * An app surface (an ADR-085 package's iframe) includes this one module to speak the generic
 * contract instead of hand-rolling a postMessage vocabulary: it RENDERS the outbound ops the
 * relay delivers (render_options / set_field / set_content / propose / notify — `navigate` is
 * shell-handled by the relay, `custom` is re-dispatched as a DOM CustomEvent for app-specific
 * handling), and it EMITS the inbound ops back (select / field_change / submit / event).
 *
 * Markup contract (all opt-in; a surface only marks what its app's bot drives):
 *   - `data-bridge-field="<name>"`  on inputs/textareas/selects → set_field targets + user edits
 *     auto-emit `field_change` (wired by attach()).
 *   - `data-bridge-region="<name>"` on content elements → set_content targets.
 *   - `data-bridge-host="options"`  one container → render_options cards + propose confirmations.
 *   - `data-bridge-host="notices"`  one container → notify banners (floating fallback otherwise).
 *   - `document` CustomEvent `surface-bridge:custom` → `{ name, data }` of a delivered custom op.
 *
 * SECURITY: everything received here already passed the relay's normalize (channel/version/schema,
 * HTML stripped, app + op allow-listed against the manifest). This module still renders with
 * createElement/textContent ONLY — never innerHTML from event data — so even a hostile payload
 * could not become markup. The channel/version literals below are asserted equal to the TS
 * contract's constants by tests/unit/surface-bridge-relay.spec.ts (drift guard); they are literals
 * rather than an import so a public surface never drags the whole zod bundle (or an auth-gated
 * /dist fetch) in for two constants.
 *
 * Usage (ES module):
 *   import { createSurfaceBridgeClient } from '/shared/ui/js/surface-bridge-client.js';
 *   const bridge = createSurfaceBridgeClient({ app: 'presentations' });
 *   bridge.attach();                       // render bot ops + auto-emit field_change on edits
 *   bridge.emitEvent('deck-generated', { deckId });   // app-specific inbound signal
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — surface-side renderer/emitter for the surface-bridge contract: renders render_options/set_field/set_content/propose/notify, re-dispatches custom as a DOM event, emits select/field_change/submit/event; textContent-only rendering.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | emitContext(snapshot) — publish what the surface is SHOWING (inbound `context` op) so the floating assistant stops being blind to the screen the operator is on. Ambient state, not a user action: the assistant reads only the latest snapshot.
 */

/** postMessage channel discriminator — MUST equal SURFACE_BRIDGE_CHANNEL in features/surface-bridge/types.ts (guarded by spec). */
export const SURFACE_BRIDGE_CHANNEL = 'oshal-surface-bridge';
/** Contract version — MUST equal SURFACE_BRIDGE_VERSION in features/surface-bridge/types.ts (guarded by spec). */
export const SURFACE_BRIDGE_VERSION = 1;

/** Find the element carrying attr="name" without CSS-escaping games (names come from bot payloads). */
function findByAttr(doc, attr, name) {
  const all = doc.querySelectorAll(`[${attr}]`);
  for (const el of all) if (el.getAttribute(attr) === name) return el;
  return null;
}

/** Set a form control (or plain element) to a scalar and fire input+change so app listeners run. */
function applyScalar(el, value) {
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' && el.type === 'checkbox') el.checked = Boolean(value);
  else if (tag === 'input' || tag === 'textarea' || tag === 'select') el.value = String(value);
  else { el.textContent = String(value); return; }
  for (const type of ['input', 'change']) {
    try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch { /* fake-DOM tests */ }
  }
}

/**
 * @description Create the surface-side bridge client for one app surface.
 * @param {object} opts
 * @param {string} opts.app - this surface's manifest app name (stamped on every emitted envelope; the relay verifies it against the TRUSTED binding, so lying here only gets events dropped).
 * @param {Window} [opts.win] - the surface's window (defaults to the global).
 * @param {Document} [opts.doc] - the surface's document (defaults to the global).
 * @returns {{ attach: () => void, detach: () => void, handleMessage: Function, emit: Function, emitEvent: Function }}
 */
export function createSurfaceBridgeClient(opts) {
  const app = opts.app;
  const win = opts.win || window;
  const doc = opts.doc || document;

  /** Post one inbound envelope to the parent (the cockpit relay validates + routes it). */
  function emit(op, payload) {
    const envelope = { channel: SURFACE_BRIDGE_CHANNEL, v: SURFACE_BRIDGE_VERSION, app, op, ...payload };
    win.parent.postMessage(envelope, win.location.origin);
    return envelope;
  }

  /** Render a set of clickable option cards; a click emits inbound `select`. */
  function renderOptions(event) {
    const host = findByAttr(doc, 'data-bridge-host', 'options');
    if (!host) return { handled: false, reason: 'no_options_host' };
    host.textContent = '';
    if (event.prompt) {
      const p = doc.createElement('p');
      p.className = 'bridge-prompt';
      p.textContent = event.prompt;
      host.appendChild(p);
    }
    for (const option of event.options) {
      const btn = doc.createElement('button');
      btn.className = 'bridge-option';
      btn.type = 'button';
      const label = doc.createElement('strong');
      label.textContent = option.label;
      btn.appendChild(label);
      if (option.description) {
        const desc = doc.createElement('span');
        desc.className = 'bridge-option-desc';
        desc.textContent = option.description;
        btn.appendChild(desc);
      }
      btn.addEventListener('click', () => emit('select', { optionId: option.id, from: 'render_options' }));
      host.appendChild(btn);
    }
    return { handled: true };
  }

  /** Render a propose confirmation card; confirm/cancel emits inbound `submit`. */
  function renderPropose(event) {
    const host = findByAttr(doc, 'data-bridge-host', 'options');
    if (!host) return { handled: false, reason: 'no_options_host' };
    host.textContent = '';
    const card = doc.createElement('div');
    card.className = 'bridge-propose';
    const summary = doc.createElement('p');
    summary.textContent = event.summary;
    card.appendChild(summary);
    for (const confirmed of [true, false]) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = confirmed ? 'bridge-confirm' : 'bridge-cancel';
      btn.textContent = confirmed ? (event.confirmLabel || 'Confirm') : (event.cancelLabel || 'Cancel');
      btn.addEventListener('click', () => {
        emit('submit', { actionId: event.actionId, confirmed });
        host.textContent = '';
      });
      card.appendChild(btn);
    }
    host.appendChild(card);
    return { handled: true };
  }

  /** Render a transient notice into the notices host (or a floating fallback on body). */
  function renderNotify(event) {
    let host = findByAttr(doc, 'data-bridge-host', 'notices');
    if (!host) {
      host = doc.createElement('div');
      host.className = 'bridge-notices-float';
      doc.body.appendChild(host);
    }
    const note = doc.createElement('div');
    note.className = `bridge-notice bridge-notice-${event.level}`;
    note.textContent = event.text;
    host.appendChild(note);
    win.setTimeout(() => { try { note.remove(); } catch { /* already gone */ } }, 6000);
    return { handled: true };
  }

  /** Apply one delivered outbound op to the surface. Unknown/foreign messages are ignored. */
  function handleMessage(evt) {
    if (!evt || evt.origin !== win.location.origin) return { handled: false, reason: 'foreign_origin' };
    const d = evt.data;
    if (!d || d.channel !== SURFACE_BRIDGE_CHANNEL || d.v !== SURFACE_BRIDGE_VERSION) return { handled: false, reason: 'not_bridge' };
    if (d.app !== app) return { handled: false, reason: 'app_mismatch' };
    switch (d.op) {
      case 'render_options': return renderOptions(d);
      case 'propose': return renderPropose(d);
      case 'notify': return renderNotify(d);
      case 'set_field': {
        const el = findByAttr(doc, 'data-bridge-field', d.field);
        if (!el) return { handled: false, reason: 'no_such_field' };
        applyScalar(el, d.value);
        return { handled: true };
      }
      case 'set_content': {
        const el = findByAttr(doc, 'data-bridge-region', d.region);
        if (!el) return { handled: false, reason: 'no_such_region' };
        applyScalar(el, d.content);
        return { handled: true };
      }
      case 'custom': {
        // App-specific vocabulary: re-dispatch as a DOM event the app's own script handles.
        const detail = { name: d.name, data: d.data || {} };
        const ev = typeof win.CustomEvent === 'function'
          ? new win.CustomEvent('surface-bridge:custom', { detail })
          : { type: 'surface-bridge:custom', detail };
        doc.dispatchEvent(ev);
        return { handled: true };
      }
      default:
        // navigate is shell-handled by the relay; anything else is not for this side.
        return { handled: false, reason: `unhandled_op:${d.op}` };
    }
  }

  /** Auto-emit inbound `field_change` when the user edits a data-bridge-field control. */
  function onFieldChange(evt) {
    const el = evt.target;
    const name = el && el.getAttribute && el.getAttribute('data-bridge-field');
    if (!name) return;
    const value = el.type === 'checkbox' ? Boolean(el.checked) : el.value;
    emit('field_change', { field: name, value });
  }

  return {
    handleMessage,
    emit,
    /** Emit a generic app surface event (inbound `event` op). */
    emitEvent(name, data) { return emit('event', { name, data: data || {} }); },
    /**
     * Publish what this surface is CURRENTLY SHOWING (inbound `context` op) so the floating
     * assistant can answer and act about the screen the operator is actually on.
     *
     * Call it on every state change worth knowing about (record opened, selection changed) — it is
     * a cheap postMessage and the assistant only ever reads the LATEST snapshot. Keep `digest` a
     * summary (headline, section names, counts): the app's own bot still owns the full document,
     * and the contract caps digest at 4000 chars, dropping the whole event if exceeded.
     * @param {{surface: string, title?: string, recordId?: string, digest?: string, fields?: object, can?: string[]}} snapshot
     * @returns {object} the posted envelope
     */
    emitContext(snapshot) { return emit('context', snapshot || {}); },
    attach() {
      win.addEventListener('message', handleMessage);
      doc.addEventListener('change', onFieldChange, true);
    },
    detach() {
      win.removeEventListener('message', handleMessage);
      doc.removeEventListener('change', onFieldChange, true);
    },
  };
}
