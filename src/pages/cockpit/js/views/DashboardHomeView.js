/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Published responsive application/core GitHub request and defect entry points on the cockpit home screen
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Point the four request/defect links at the repos a user can actually open. All four 404'd: app work went to the private application trunk, and core work went to open-shal — the pre-cutover repo, a frozen reference archive since ADR-115. The public trunks (oshal / oshal-apps) are where issues are accepted, which is already what README's request queues say.
 */

/**
 * DashboardHomeView — Cockpit homepage / summary dashboard.
 * Sections: Config Health, Recently Completed, Needs Attention,
 *           Total Spend, Swarm Messages, What's New, Saved Presets.
 *
 * @description Top-level cockpit landing view that gives an at-a-glance
 * operational picture by fetching several independent backend endpoints in
 * parallel and rendering each result into its own self-contained card. Each
 * section degrades independently so one failed request never blanks the whole
 * dashboard, letting an operator quickly spot config gaps, work needing
 * attention, spend, and recent swarm activity without drilling into sub-views.
 */
export class DashboardHomeView {
  /**
   * @description Wire up the collaborators the view needs to talk to the
   * backend and the surrounding cockpit shell, so rendering stays free of
   * direct global lookups and the view is easy to instantiate in tests.
   * @param {Object} deps Injected collaborators.
   * @param {Object} deps.api API client for backend calls.
   * @param {Function} deps.showToast Callback to surface transient user notifications.
   * @param {Function} deps.navigateToView Callback to switch the cockpit to another view by name.
   */
  constructor({ api, showToast, navigateToView }) {
    this.api = api;
    this.showToast = showToast;
    this.navigateToView = navigateToView;
  }

  /**
   * @description Paint the dashboard skeleton with per-section loading
   * placeholders, then kick off every section's data load concurrently. Using
   * allSettled (rather than all) is intentional so a single failing endpoint
   * cannot reject the batch and leave other sections stuck on "Loading…".
   * @param {HTMLElement} container Host element whose innerHTML is replaced with the dashboard markup.
   * @returns {Promise<void>} Resolves once all section loads have settled.
   */
  async render(container) {
    container.innerHTML = `
      <div class="dashboard-home">
        <section class="dash-section" id="dashConfigHealth">
          <h3>⚙️ Configuration Health</h3>
          <div class="dash-loading">Loading…</div>
        </section>
        <section class="dash-section dash-request-card" aria-labelledby="dashRequestTitle">
          <div>
            <span class="dash-request-kicker">GitHub-backed backlog</span>
            <h3 id="dashRequestTitle">Requests &amp; defects</h3>
            <p>App work routes to the application queue. Platform, cockpit, and orchestration work routes to the active core queue.</p>
          </div>
          <div class="dash-request-actions">
            <a class="dash-request-link" href="https://github.com/emeraldcoastsystemsgroup/oshal-apps/issues/new?labels=enhancement&amp;title=%5BRequest%5D%20">App request</a>
            <a class="dash-request-link" href="https://github.com/emeraldcoastsystemsgroup/oshal-apps/issues/new?labels=bug%2Cdefect&amp;title=%5BDefect%5D%20">App defect</a>
            <a class="dash-request-link" href="https://github.com/emeraldcoastsystemsgroup/oshal/issues/new?labels=enhancement&amp;title=%5BRequest%5D%20">Core request</a>
            <a class="dash-request-link" href="https://github.com/emeraldcoastsystemsgroup/oshal/issues/new?labels=bug%2Cdefect&amp;title=%5BDefect%5D%20">Core defect</a>
          </div>
          <p class="dash-request-policy">Defects stay open. Accepted <code>code-write</code> requests close only through a proven release PR. GitHub collaborator access is required during prerelease.</p>
        </section>
        <div class="dash-grid">
          <section class="dash-section dash-card" id="dashRecentCompleted">
            <h3>✅ Recently Completed</h3>
            <div class="dash-loading">Loading…</div>
          </section>
          <section class="dash-section dash-card" id="dashNeedsAttention">
            <h3>🔔 Needs Attention</h3>
            <div class="dash-loading">Loading…</div>
          </section>
          <section class="dash-section dash-card" id="dashTotalSpend">
            <h3>💰 Total Spend</h3>
            <div class="dash-loading">Loading…</div>
          </section>
          <section class="dash-section dash-card" id="dashSwarmMessages">
            <h3>🐝 Swarm Messages</h3>
            <div class="dash-loading">Loading…</div>
          </section>
        </div>
        <div class="dash-grid">
          <section class="dash-section dash-card" id="dashWhatsNew">
            <h3>🆕 What's New</h3>
            <div class="dash-loading">Loading…</div>
          </section>
          <section class="dash-section dash-card" id="dashSwarmPresets">
            <h3>💾 Saved Swarm Presets</h3>
            <div class="dash-loading">Loading…</div>
          </section>
        </div>
      </div>`;

    await Promise.allSettled([
      this.loadConfigHealth(),
      this.loadRecentCompleted(),
      this.loadNeedsAttention(),
      this.loadTotalSpend(),
      this.loadSwarmMessages(),
      this.loadWhatsNew(),
      this.loadSwarmPresets(),
    ]);
  }

  /**
   * @description Render the configuration completeness summary so an operator
   * can immediately tell whether the system is fully set up and jump straight
   * to fixing critical gaps. Renders a percent ring plus per-item status chips.
   * @returns {Promise<void>} Resolves after the section is updated (success or failure state).
   */
  async loadConfigHealth() {
    const el = document.querySelector('#dashConfigHealth .dash-loading');
    try {
      const res = await fetch('/api/config/health');
      const data = await res.json();
      el.outerHTML = `
        <div class="config-health-bar">
          <div class="config-pct-ring" style="--pct: ${data.percentComplete}"><span>${data.percentComplete}%</span></div>
          <div class="config-health-items">
            ${data.items.map(i => `<span class="chi chi--${i.status}" title="${i.detail}">${i.status === 'ok' ? '✅' : i.status === 'missing' ? '❌' : '⚠️'} ${i.label}</span>`).join('')}
          </div>
          ${data.criticalMissing > 0 ? `<a href="/utilities" class="dash-link">Fix ${data.criticalMissing} issue(s) →</a>` : ''}
        </div>`;
    } catch { el.textContent = 'Failed to load'; }
  }

  /**
   * @description Surface the five most recently finished tickets so progress is
   * visible without opening the full ticket hierarchy. Filters the hierarchy to
   * done/completed/closed states and sorts newest-first by update time.
   * @returns {Promise<void>} Resolves after the section is updated (success or failure state).
   */
  async loadRecentCompleted() {
    const el = document.querySelector('#dashRecentCompleted .dash-loading');
    try {
      const res = await fetch('/api/v1/tickets/hierarchy');
      const data = await res.json();
      const done = (data.tickets || []).filter(t => /done|completed|closed/i.test(t.status || ''))
        .sort((a, b) => new Date(b.updated_at || b.updatedAt || 0) - new Date(a.updated_at || a.updatedAt || 0))
        .slice(0, 5);
      if (!done.length) { el.textContent = 'No completed items yet.'; return; }
      el.outerHTML = `<ul class="dash-list">${done.map(t => `<li class="dash-list-item"><span class="dash-item-title">${this.esc(t.name || t.title)}</span><span class="dash-item-meta">${this.timeAgo(t.updated_at || t.updatedAt)}</span></li>`).join('')}</ul>`;
    } catch { el.textContent = 'Failed to load'; }
  }

  /**
   * @description Highlight tickets that are stuck or have errored so an
   * operator can triage problems first. Filters the hierarchy to
   * blocked/failed/escalated states and shows up to five with a warning style.
   * @returns {Promise<void>} Resolves after the section is updated (success or failure state).
   */
  async loadNeedsAttention() {
    const el = document.querySelector('#dashNeedsAttention .dash-loading');
    try {
      const res = await fetch('/api/v1/tickets/hierarchy');
      const data = await res.json();
      const attention = (data.tickets || []).filter(t => /blocked|failed|escalat/i.test(t.status || ''))
        .slice(0, 5);
      if (!attention.length) { el.textContent = 'Nothing needs attention. 🎉'; return; }
      el.outerHTML = `<ul class="dash-list">${attention.map(t => `<li class="dash-list-item dash-list-item--warn"><span class="dash-item-title">${this.esc(t.name || t.title)}</span><span class="dash-item-status">${t.status}</span></li>`).join('')}</ul>`;
    } catch { el.textContent = 'Failed to load'; }
  }

  /**
   * @description Show estimated cumulative cost alongside ticket totals so spend
   * stays front-and-center for budget awareness. Pulls from the metrics summary
   * endpoint and defaults missing values to zero to keep the card stable.
   * @returns {Promise<void>} Resolves after the section is updated (success or failure state).
   */
  async loadTotalSpend() {
    const el = document.querySelector('#dashTotalSpend .dash-loading');
    try {
      const res = await fetch('/api/v1/metrics/summary');
      const data = await res.json();
      const totalCost = data.data?.estimatedTotalCost ?? 0;
      el.outerHTML = `<div class="spend-summary"><div class="spend-big">$${totalCost.toFixed(2)}</div><div class="spend-detail"><span>Tickets: ${data.data?.total ?? 0}</span><span>Active: ${data.data?.active ?? 0}</span></div></div>`;
    } catch { el.textContent = 'Failed to load'; }
  }

  /**
   * @description Give a recent-activity feel for the swarm by listing its
   * latest work items, so the operator sees the system is alive and what it is
   * doing. Tolerates multiple response shapes and title/timestamp field names.
   * @returns {Promise<void>} Resolves after the section is updated (success or failure state).
   */
  async loadSwarmMessages() {
    const el = document.querySelector('#dashSwarmMessages .dash-loading');
    try {
      const res = await fetch('/api/swarm/work-items');
      const data = await res.json();
      const items = (data.workItems || data.items || []).slice(0, 5);
      if (!items.length) { el.textContent = 'No recent swarm activity.'; return; }
      el.outerHTML = `<ul class="dash-list">${items.map(e => `<li class="dash-list-item"><span class="dash-item-title">${this.esc(e.title || e.summary || e.type || e.ticketId || 'Work item')}</span><span class="dash-item-meta">${this.timeAgo(e.updatedAt || e.createdAt || e.timestamp)}</span></li>`).join('')}</ul>`;
    } catch { el.textContent = 'No recent swarm activity.'; }
  }

  /**
   * @description Surface the latest release/changelog entries so operators learn
   * about new capabilities in-context rather than via external notes. Shows up
   * to four entries, each tagged with its version badge.
   * @returns {Promise<void>} Resolves after the section is updated (success or failure state).
   */
  async loadWhatsNew() {
    const el = document.querySelector('#dashWhatsNew .dash-loading');
    try {
      const res = await fetch('/api/whats-new');
      const data = await res.json();
      if (!data.entries?.length) { el.textContent = 'No updates.'; return; }
      el.outerHTML = `<ul class="dash-list">${data.entries.slice(0, 4).map(e => `<li class="dash-list-item"><span class="dash-item-badge">${e.version}</span><span class="dash-item-title">${this.esc(e.title)}</span></li>`).join('')}</ul>`;
    } catch { el.textContent = 'Failed to load'; }
  }

  /**
   * @description List saved swarm presets for quick reuse, and when none exist
   * offer a direct call-to-action into settings so first-time setup is
   * frictionless rather than a dead end. Renders each preset with its bot count.
   * @returns {Promise<void>} Resolves after the section is updated (success or failure state).
   */
  async loadSwarmPresets() {
    const el = document.querySelector('#dashSwarmPresets .dash-loading');
    try {
      const res = await fetch('/api/swarm-presets');
      const data = await res.json();
      if (!data.presets?.length) {
        el.outerHTML = `<div class="dash-empty"><p>No saved presets yet.</p><button class="btn btn-sm" id="btnCreatePreset">Create Preset</button></div>`;
        document.getElementById('btnCreatePreset')?.addEventListener('click', () => this.navigateToView?.('settings'));
        return;
      }
      el.outerHTML = `<ul class="dash-list">${data.presets.map(p => `<li class="dash-list-item"><span class="dash-item-title">${this.esc(p.name)}</span><span class="dash-item-meta">${p.botCount} bots</span></li>`).join('')}</ul>`;
    } catch { el.textContent = 'Failed to load'; }
  }

  /**
   * @description Escape arbitrary backend-supplied text before interpolating it
   * into the card markup, preventing XSS from ticket/preset names that may
   * contain HTML. Leans on the DOM's textContent->innerHTML round-trip.
   * @param {string} str Untrusted string to escape (nullish becomes empty).
   * @returns {string} HTML-safe representation of the input.
   */
  esc(str) { const d = document.createElement('div'); d.textContent = str ?? ''; return d.innerHTML; }
  /**
   * @description Convert an ISO timestamp into a compact human-friendly
   * relative label (e.g. "5m ago") so the dashboard reads at a glance without
   * forcing the operator to parse absolute dates.
   * @param {string} iso ISO-8601 timestamp, or falsy for unknown time.
   * @returns {string} Relative time label, or empty string when no timestamp is given.
   */
  timeAgo(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }
}
