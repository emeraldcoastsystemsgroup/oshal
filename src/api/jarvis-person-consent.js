/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-100 Phase 2 enable-gate: the per-person insights consent panel. A self-contained companion that wires its own launcher next to "Manage voices" and drives the live GET/POST /api/jarvis/ambient/person/consents endpoints — per-heard-voice modeling grant/decline/minor. Modeling is default-OFF; declining purges what was already inferred. Consumes the framework theme read-only (never edits shared CSS).
 */

/**
 * Per-person insights (ambient consent) panel.
 *
 * ADR-100 Phase 2 ships the consent MECHANISM as an API (listPersonConsentStatus / recordConsent);
 * this is the graphical control over it. Each heard voice gets an explicit, reversible modeling
 * decision. The panel never derives or displays inferences itself — it only reads each voice's
 * posture and records the owner's decision. Declining calls the same purge path the server runs.
 *
 * Public API: window.JarvisPersonConsent.mount({ apiBase }) → { open, refresh, unmount }.
 */
(function (global) {
  'use strict';

  const API_DEFAULT = '/api/jarvis/ambient/person';
  const STYLE_ID = 'jarvis-person-consent-styles';

  /** @description Terse element factory. @returns {HTMLElement} The built node. */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of children) {
      if (child == null) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  /** @description Inject the panel's scoped stylesheet once. Consumes framework --ja-* theme vars
   *  (read-only) with generic + hard fallbacks; never touches shared CSS. @returns {void} */
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
    .jpc-backdrop{position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;
      background:rgba(4,7,14,.62);backdrop-filter:blur(3px);padding:20px;}
    .jpc-backdrop[data-open="1"]{display:flex;}
    .jpc-panel{width:min(560px,100%);max-height:min(84vh,720px);overflow:auto;border-radius:16px;
      background:var(--ja-card,var(--card,#0f1626));color:var(--ja-text,var(--text,#e8edf6));
      border:1px solid var(--ja-line,var(--line,#243049));box-shadow:0 24px 60px rgba(0,0,0,.5);
      font:14px/1.5 var(--ja-font,var(--font,system-ui,-apple-system,Segoe UI,Roboto,sans-serif));}
    .jpc-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
      padding:18px 20px 12px;position:sticky;top:0;background:inherit;border-bottom:1px solid var(--ja-line,var(--line,#243049));}
    .jpc-head h2{margin:0;font-size:16px;font-weight:650;}
    .jpc-x{background:transparent;border:0;color:var(--ja-muted,var(--muted,#93a0b8));font-size:22px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:8px;}
    .jpc-x:hover{color:var(--ja-text,var(--text,#e8edf6));background:rgba(255,255,255,.06);}
    .jpc-intro{padding:12px 20px;color:var(--ja-muted,var(--muted,#93a0b8));font-size:12.5px;border-bottom:1px solid var(--ja-line,var(--line,#243049));}
    .jpc-list{list-style:none;margin:0;padding:8px 12px 16px;display:flex;flex-direction:column;gap:8px;}
    .jpc-row{display:flex;flex-direction:column;gap:8px;padding:12px 12px;border:1px solid var(--ja-line,var(--line,#243049));border-radius:12px;background:rgba(255,255,255,.02);}
    .jpc-row__top{display:flex;align-items:center;justify-content:space-between;gap:10px;}
    .jpc-name{font-weight:600;}
    .jpc-badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--ja-line,var(--line,#243049));color:var(--ja-muted,var(--muted,#93a0b8));white-space:nowrap;}
    .jpc-badge[data-on="1"]{color:var(--ja-ok,var(--ok,#54d18c));border-color:var(--ja-ok,var(--ok,#54d18c));}
    .jpc-choices{display:flex;flex-wrap:wrap;gap:6px;}
    .jpc-choice{flex:1 1 auto;min-width:96px;text-align:center;padding:8px 10px;border-radius:9px;cursor:pointer;
      border:1px solid var(--ja-line,var(--line,#243049));background:transparent;color:var(--ja-text,var(--text,#e8edf6));font:inherit;}
    .jpc-choice:hover{border-color:var(--ja-accent,var(--accent,#6ea8fe));}
    .jpc-choice[aria-pressed="true"]{background:var(--ja-accent,var(--accent,#6ea8fe));border-color:var(--ja-accent,var(--accent,#6ea8fe));color:#08111f;font-weight:600;}
    .jpc-choice[data-kind="off"][aria-pressed="true"],.jpc-choice[data-kind="minor"][aria-pressed="true"]{background:var(--ja-warn,var(--warn,#e0a94a));border-color:var(--ja-warn,var(--warn,#e0a94a));}
    .jpc-self{color:var(--ja-muted,var(--muted,#93a0b8));font-size:12.5px;}
    .jpc-empty,.jpc-error{padding:22px 20px;color:var(--ja-muted,var(--muted,#93a0b8));text-align:center;}
    .jpc-error{color:var(--ja-danger,var(--danger,#e0616f));}
    .jpc-launch{margin-left:8px;}
    `;
    document.head.appendChild(el('style', { id: STYLE_ID, text: css }));
  }

  /** One reusable per-person consent panel. */
  class ConsentPanel {
    /** @param {{apiBase?:string}} options Mount options. */
    constructor(options) {
      this.apiBase = (options && options.apiBase) || API_DEFAULT;
      this.backdrop = null;
      this.listNode = null;
      this.lastFocus = null;
      this.busy = false;
    }

    /** @description Inject styles + self-wire the launcher. @returns {ConsentPanel} this. */
    mount() {
      injectStyles();
      this.wireLauncher();
      return this;
    }

    /** @description Insert a "Per-person insights" launcher beside the ambient panel's "Manage voices"
     *  button, retrying via a MutationObserver because the ambient panel may mount after us. @returns {void} */
    wireLauncher() {
      const place = () => {
        const anchor = document.querySelector('[data-ja-speakers-open]');
        if (!anchor || anchor.parentNode.querySelector('[data-jpc-open]')) return false;
        const btn = el('button', {
          type: 'button', 'data-jpc-open': true,
          class: (anchor.className || '') + ' jpc-launch',
          onclick: () => this.open(),
        }, 'Per-person insights');
        anchor.insertAdjacentElement('afterend', btn);
        return true;
      };
      if (place()) return;
      const obs = new MutationObserver(() => { if (place()) obs.disconnect(); });
      obs.observe(document.body, { childList: true, subtree: true });
      this._observer = obs;
    }

    /** @description Build the modal backdrop once. @returns {void} */
    ensureBackdrop() {
      if (this.backdrop) return;
      this.listNode = el('ul', { class: 'jpc-list', 'aria-live': 'polite' });
      const panel = el('section', { class: 'jpc-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Per-person insights' },
        el('div', { class: 'jpc-head' },
          el('h2', { text: 'Per-person insights' }),
          el('button', { class: 'jpc-x', type: 'button', 'aria-label': 'Close', onclick: () => this.close() }, '×'),
        ),
        el('p', { class: 'jpc-intro' },
          'Insights are off for everyone by default. Turn a voice on to let OSHAL keep its own read of what '
          + 'they say — topics, tone, follow-up asks — as deletable inferences beside the actual words. Turning a '
          + 'voice off (or marking a minor) stops that and deletes what was already inferred about them.'),
        this.listNode,
      );
      this.backdrop = el('div', { class: 'jpc-backdrop', onclick: (e) => { if (e.target === this.backdrop) this.close(); } }, panel);
      document.body.appendChild(this.backdrop);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen()) this.close(); });
    }

    /** @description Whether the modal is visible. @returns {boolean} Open state. */
    isOpen() { return Boolean(this.backdrop && this.backdrop.getAttribute('data-open') === '1'); }

    /** @description Open + refresh the panel. @returns {Promise<ConsentPanel>} this after render. */
    async open() {
      this.ensureBackdrop();
      this.lastFocus = document.activeElement;
      this.backdrop.setAttribute('data-open', '1');
      this.backdrop.querySelector('.jpc-x')?.focus();
      await this.refresh();
      return this;
    }

    /** @description Hide the panel and restore focus. @returns {void} */
    close() {
      if (!this.backdrop) return;
      this.backdrop.removeAttribute('data-open');
      if (this.lastFocus && typeof this.lastFocus.focus === 'function') this.lastFocus.focus();
    }

    /** @description Fetch consent statuses and render the rows. @returns {Promise<void>} */
    async refresh() {
      if (!this.listNode) return;
      this.listNode.replaceChildren(el('li', { class: 'jpc-empty', text: 'Loading heard voices…' }));
      try {
        const res = await fetch(`${this.apiBase}/consents`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this.render(Array.isArray(data.consents) ? data.consents : []);
      } catch (err) {
        this.listNode.replaceChildren(el('li', { class: 'jpc-error', text: 'Could not load voices — try again in a moment.' }));
      }
    }

    /** @description Render one row per heard voice. @param {Array<object>} consents Statuses. @returns {void} */
    render(consents) {
      if (!consents.length) {
        this.listNode.replaceChildren(el('li', { class: 'jpc-empty', text: 'No voices heard yet. Enable ambient listening and Jarvis will start recognizing speakers.' }));
        return;
      }
      this.listNode.replaceChildren(...consents.map((c) => this.row(c)));
    }

    /** @description Build one voice row with its modeling controls. @param {object} c Status. @returns {HTMLElement} Row. */
    row(c) {
      const badge = c.isSelf
        ? el('span', { class: 'jpc-badge', 'data-on': '1', text: 'You' })
        : el('span', { class: 'jpc-badge', 'data-on': c.eligible ? '1' : null, text: c.eligible ? 'Insights on' : 'Insights off' });
      const top = el('div', { class: 'jpc-row__top' }, el('span', { class: 'jpc-name', text: c.label }), badge);
      if (c.isSelf) {
        return el('li', { class: 'jpc-row' }, top,
          el('div', { class: 'jpc-self', text: 'Your own voice is always included while ambient listening is on.' }));
      }
      const active = c.status === 'granted' && !c.isMinor ? 'on' : (c.isMinor ? 'minor' : (c.status ? 'off' : 'none'));
      const choices = el('div', { class: 'jpc-choices' },
        this.choice('on', 'Model', active === 'on', () => this.set(c.profileId, 'granted', false)),
        this.choice('off', "Don't model", active === 'off', () => this.set(c.profileId, 'declined', false)),
        this.choice('minor', 'Minor — never', active === 'minor', () => this.set(c.profileId, 'declined', true)),
      );
      return el('li', { class: 'jpc-row' }, top, choices);
    }

    /** @description Build one choice button. @returns {HTMLElement} Button. */
    choice(kind, label, pressed, onClick) {
      return el('button', {
        type: 'button', class: 'jpc-choice', 'data-kind': kind, 'aria-pressed': pressed ? 'true' : 'false',
        onclick: () => { if (!this.busy) onClick(); },
      }, label);
    }

    /** @description Record a consent decision, then refresh. @returns {Promise<void>} */
    async set(profileId, status, isMinor) {
      if (this.busy) return;
      this.busy = true;
      try {
        const res = await fetch(`${this.apiBase}/consents`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId, status, isMinor, scope: 'transcript' }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await this.refresh();
      } catch (err) {
        this.listNode.replaceChildren(el('li', { class: 'jpc-error', text: 'That change did not save — try again.' }));
      } finally {
        this.busy = false;
      }
    }

    /** @description Tear down the panel. @returns {void} */
    unmount() {
      this._observer?.disconnect();
      this.backdrop?.remove();
      this.backdrop = null;
      document.querySelector('[data-jpc-open]')?.remove();
    }
  }

  let active = null;

  /** @description Mount the singleton consent panel. @param {object} options Mount options. @returns {object} Controller. */
  function mount(options) {
    if (active) active.unmount();
    active = new ConsentPanel(options || {}).mount();
    return api;
  }
  /** @description Open the panel, mounting a default instance if needed. @returns {Promise<void>} */
  function open() { if (!active) active = new ConsentPanel({}).mount(); return active.open(); }
  /** @description Refresh the open panel. @returns {Promise<void>} */
  function refresh() { return active ? active.refresh() : Promise.resolve(); }
  /** @description Tear down the panel. @returns {void} */
  function unmount() { active?.unmount(); active = null; }

  const api = Object.freeze({ mount, open, refresh, unmount });
  global.JarvisPersonConsent = api;
})(window);
