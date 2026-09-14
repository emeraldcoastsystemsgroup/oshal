/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Present controller-owned package tool proposals with explicit ASK approval and transient, revalidated results.
 */

'use strict';

{
  const seen = new Map();
  let active;

  /** Build text-only DOM; proposal and result bytes are never interpreted as markup. */
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  /** Keep tool controls aligned with the current shared Jarvis theme. */
  function stylePanel() {
    if (document.getElementById('jarvis-package-tool-style')) return;
    const style = node('style', `
      .jpt-panel{margin:14px 0;padding:16px;border:1px solid var(--ja-line,var(--line,#526078));
        border-radius:12px;background:var(--ja-card,var(--card,#172131));color:var(--ja-text,var(--text,#edf2fa))}
      .jpt-panel h3{margin:0 0 8px;color:inherit;font-size:1rem}
      .jpt-panel p{margin:8px 0;overflow-wrap:anywhere}
      .jpt-panel pre{max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;
        padding:12px;background:var(--ja-bg,var(--bg,#101723));color:inherit;border-radius:8px}
      .jpt-controls{display:flex;gap:10px;margin-top:12px}
      .jpt-controls button{font:inherit;padding:8px 14px;border-radius:8px;cursor:pointer;
        color:inherit;background:transparent;border:1px solid var(--ja-line,var(--line,#526078))}
      .jpt-controls button:focus-visible{outline:2px solid var(--ja-accent,var(--accent,#9ccaff));outline-offset:3px}
      .jpt-controls button:disabled{opacity:.6;cursor:default}
    `);
    style.id = 'jarvis-package-tool-style';
    document.head.append(style);
  }

  /** Copy a bounded display contract without extending the controller's authority. */
  function proposalSnapshot(value) {
    if (!value || typeof value !== 'object' || !['auto', 'ask'].includes(value.mode)) return null;
    for (const key of ['id', 'app', 'toolName', 'label']) {
      if (typeof value[key] !== 'string' || !value[key] || value[key].length > 512) return null;
    }
    const expiry = Date.parse(value.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return null;
    if (!value.input || typeof value.input !== 'object' || Array.isArray(value.input)) return null;
    try {
      const input = JSON.stringify(value.input, null, 2);
      if (!input || input.length > 32768) return null;
      return { id: value.id, app: value.app, toolName: value.toolName, label: value.label,
        mode: value.mode, input, expiry };
    } catch { return null; }
  }

  /** One live proposal; the controller retains execution identity, inputs and replay protection. */
  class PackageToolPanel {
    constructor(proposal, container) {
      this.proposal = proposal;
      this.state = 'ready';
      this.epoch = 0;
      this.abort = new AbortController();
      this.panel = node('section', undefined, 'jpt-panel');
      this.panel.setAttribute('aria-label', 'Application tool');
      this.panel.dataset.proposalId = proposal.id;
      this.panel.append(node('h3', proposal.label), node('p', `Application: ${proposal.app}`),
        node('p', `Tool: ${proposal.toolName}`), node('p', 'Inputs'), node('pre', proposal.input));
      this.status = node('p', proposal.mode === 'ask' ? 'Review these inputs before approving.' : 'Running read tool.');
      this.status.setAttribute('role', 'status');
      this.output = node('pre', ''); this.output.hidden = true;
      this.panel.append(this.status, this.output);
      this.addControls();
      container.append(this.panel);
      this.timer = setTimeout(() => this.dispose(), Math.min(proposal.expiry - Date.now(), 2147483647));
    }

    /** Only a real click or keyboard activation can approve an ASK proposal. */
    addControls() {
      const controls = node('div', undefined, 'jpt-controls');
      this.approve = node('button', 'Approve'); this.approve.type = 'button';
      this.approve.hidden = this.proposal.mode !== 'ask';
      this.approve.addEventListener('click', event => { if (event.isTrusted) void this.execute(); });
      const cancel = node('button', 'Cancel'); cancel.type = 'button';
      this.dismiss = cancel;
      cancel.addEventListener('click', () => this.dispose());
      controls.append(this.approve, cancel); this.panel.append(controls);
    }

    /** Expiry, replacement and cancellation remove all transient displayed inputs and results. */
    dispose() {
      this.state = 'closed'; this.epoch++;
      clearTimeout(this.timer); this.abort.abort();
      this.panel.remove(); this.panel.replaceChildren();
      if (active === this) active = undefined;
    }

    /** Send only the opaque proposal ID; input and approval authority stay on the controller. */
    async request(action) {
      const response = await fetch(`/api/jarvis/package-tools/${action}`, {
        method: 'POST', credentials: 'include', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-OSHAL-Package-Tool': '1' },
        body: JSON.stringify({ proposalId: this.proposal.id }),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) throw new Error('Application tool access is unavailable. Ask again.');
      const text = await response.text();
      if (text.length > 65536) throw new Error('Application tool result is too large to display.');
      const body = JSON.parse(text);
      const expiry = Date.parse(body.expiresAt);
      if (!Object.hasOwn(body, 'result') || !Number.isFinite(expiry) || expiry <= Date.now()) {
        throw new Error('Application tool result has expired. Ask again.');
      }
      return { text: JSON.stringify(body.result, null, 2), expiry: Math.min(expiry, this.proposal.expiry) };
    }

    /** Execute at most once in this page, including while a previous request is in flight. */
    async execute() {
      if (this.state !== 'ready') return;
      if (Date.now() >= this.proposal.expiry || !this.panel.isConnected) { this.dispose(); return; }
      this.state = 'running'; this.approve.disabled = true;
      this.dismiss.textContent = 'Dismiss';
      this.status.textContent = 'Running application tool…';
      const epoch = ++this.epoch;
      try {
        const result = await this.request('execute');
        if (this.state === 'closed' || epoch !== this.epoch) return;
        this.state = 'done';
        if (this.needsRecheck) { if (document.hasFocus()) await this.refresh(); return; }
        this.show(result);
      } catch { this.fail(epoch); }
    }

    /** Display only a current response, never a cached value following focus or expiry. */
    show(result) {
      if (!this.panel.isConnected || Date.now() >= result.expiry) { this.dispose(); return; }
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.dispose(), Math.min(result.expiry - Date.now(), 2147483647));
      this.output.textContent = result.text; this.output.hidden = false;
      this.status.textContent = 'Application tool result'; this.panel.hidden = false;
      this.needsRecheck = false;
    }

    /** Fail without replaying a write or retaining result bytes from an earlier authority check. */
    fail(epoch, expired = false) {
      if (this.state === 'closed' || epoch !== this.epoch) return;
      this.state = 'failed'; this.output.textContent = ''; this.output.hidden = true;
      this.panel.hidden = false;
      this.status.textContent = expired ? 'Results expired. Ask again to refresh.' : 'Application tool access is unavailable. Ask again.';
      this.panel.replaceChildren(this.status);
    }

    /** Hide private results when leaving the surface; unapproved proposals are canceled. */
    redact() {
      if (this.state === 'ready') { this.dispose(); return; }
      this.needsRecheck = true; this.panel.hidden = true;
      this.output.textContent = ''; this.output.hidden = true;
    }

    /** Completed output is delivered once; focusing again never restores private result bytes. */
    async refresh() {
      if (this.state !== 'done') return;
      this.output.textContent = ''; this.output.hidden = true; this.panel.hidden = true;
      const epoch = ++this.epoch;
      try { await this.request('result'); } catch { /* No cached output may be replayed. */ }
      this.fail(epoch, true);
    }
  }

  /** @description Present only a fresh live proposal, keeping private output outside history.
   * @param {object} value Controller-issued proposal metadata.
   * @param {HTMLElement} container Primary transient answer container.
   * @returns {void} No result is returned to the model or history renderer.
   */
  window.oshalPresentPackageTool = function presentPackageTool(value, container) {
    const proposal = proposalSnapshot(value);
    if (!proposal || !(container instanceof HTMLElement) || !container.isConnected) return;
    for (const [id, expiry] of seen) if (expiry <= Date.now()) seen.delete(id);
    if (seen.has(proposal.id) || seen.size >= 256) return;
    seen.set(proposal.id, proposal.expiry);
    active?.dispose(); stylePanel();
    active = new PackageToolPanel(proposal, container);
    if (proposal.mode === 'auto') void active.execute();
  };

  window.addEventListener('blur', () => active?.redact());
  window.addEventListener('focus', () => { void active?.refresh(); });
  window.addEventListener('pagehide', () => active?.dispose());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') active?.redact();
    else void active?.refresh();
  });
}
