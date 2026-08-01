/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Surface the 428 needs-confirmation gate: a connector that declares write actions gets a "Run write action" control that opens ConnectorActionRunner. The confirm rail existed since 2026-07-15 and no human could reach it — approval was a thing only a curl could give.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the per-user enablement layer + connect-state to the Discover surface (BACKLOG.md:2718 + :2672): each card now shows a connect-state badge (Connected / Not connected, from /api/connect/list) and an "On/Off for me" toggle (POST /api/connectors/marketplace/:provider/{enable,disable}-for-me, state from GET /api/connectors/marketplace/my-enablement). The existing deployment Enable/Disable/Remove controls are unchanged; the per-user toggle is an additive override.
 */

import { createUiLogger } from '../../../shared/ui-debug.js';
import { openConnectorActionRunner } from './ConnectorActionRunner.js';

const logger = createUiLogger('cockpit-connector-discover-view');

const FEATURED_CONNECTOR_IDS = [
  'google', 'github', 'slack', 'outlook', 'jira', 'dropbox',
  'spotify', 'tmdb', 'duffel', 'walmart', 'uber', 'uber-rides',
  'smartthings', 'google-home', 'linkedin', 'twitter',
  'stripe', 'square', 'paypal', 'openai',
];

const POPULAR_CONNECTOR_IDS = [
  ...FEATURED_CONNECTOR_IDS,
  'gmail', 'google-calendar', 'google-drive', 'youtube',
  'notion', 'airtable', 'asana', 'hubspot', 'calendly', 'figma', 'zoom',
  'gitlab', 'bitbucket', 'vercel', 'netlify', 'sentry', 'pagerduty',
  'sendgrid', 'postmark', 'shopify', 'shippo', 'mapbox', 'geoapify',
  'openweathermap', 'weatherapi', 'strava', 'oura', 'fitbit', 'whoop',
];

const POPULAR_SCORE = new Map(POPULAR_CONNECTOR_IDS.map((id, index) => [id, 2000 - index * 18]));

const ICON_BY_PROVIDER = {
  airtable: 'airtable',
  asana: 'asana',
  bitbucket: 'bitbucket',
  discord: 'discord',
  dropbox: 'dropbox',
  facebook: 'facebook',
  figma: 'figma',
  github: 'github',
  gitlab: 'gitlab',
  gmail: 'gmail',
  google: 'google',
  'google-calendar': 'googlecalendar',
  'google-drive': 'googledrive',
  'google-home': 'googlehome',
  hubspot: 'hubspot',
  jira: 'jira',
  linkedin: 'linkedin',
  mapbox: 'mapbox',
  'meta-business': 'meta',
  netlify: 'netlify',
  notion: 'notion',
  openai: 'openai',
  outlook: 'microsoftoutlook',
  paypal: 'paypal',
  postmark: 'postmark',
  sentry: 'sentry',
  shopify: 'shopify',
  slack: 'slack',
  spotify: 'spotify',
  square: 'square',
  stripe: 'stripe',
  tmdb: 'themoviedatabase',
  twitter: 'x',
  uber: 'uber',
  'uber-rides': 'uber',
  vercel: 'vercel',
  youtube: 'youtube',
  zoom: 'zoom',
};

export class ConnectorDiscoverView {
  constructor(container, opts = {}) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.data = { entries: [], totals: {} };
    // Per-user enablement OVERRIDE (BACKLOG.md:2718): provider id -> explicit boolean (only
    // providers the signed-in user has toggled). Absent = default-allow.
    this.userEnablement = new Map();
    // Per-provider connect-state (BACKLOG.md:2672) from /api/connect/list: id -> { connected, status }.
    this.connectState = new Map();
    // Focused-app connector allow-list (manifest dependencies.connectors via the
    // profile). An array restricts the whole catalog — grid, featured strip,
    // counts — to those provider ids; null = framework default, no filtering.
    this.allow = Array.isArray(opts.allow) ? new Set(opts.allow) : null;
    this.query = '';
    this.category = 'all';
    this.status = 'all';
    this.risk = 'all';
    this.action = 'all';
    this.pageSize = 48;
    this.visibleLimit = this.pageSize;
    this.renderTimer = null;
  }

  async render() {
    if (!this.container) return;
    this.container.innerHTML = this._shell();
    this._bind();
    await this._load();
  }

  destroy() {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    if (this.container) this.container.innerHTML = '';
  }

  _shell() {
    return `<div class="connector-view">
      <div class="connector-header surface-card">
        <div class="connector-header-copy">
          <div class="connector-eyebrow">Integration Marketplace</div>
          <div class="connector-title"><i class="ph ph-plugs"></i> Connectors</div>
          <div class="connector-subtitle">Search the audited catalog, enable only what you need, and keep credentials user-owned.</div>
        </div>
        <div class="connector-header-actions">
          <a class="connector-export" href="/api/connectors/marketplace/audit-export?format=csv" download="connector-marketplace-audit-export.csv" title="Export audit CSV"><i class="ph ph-download-simple"></i><span>Export</span></a>
          <button class="connector-refresh" id="connectorRefresh" type="button" title="Refresh"><i class="ph ph-arrow-clockwise"></i></button>
        </div>
      </div>
      <div class="connector-toolbar">
        <div class="connector-search"><i class="ph ph-magnifying-glass"></i><input id="connectorSearch" type="search" placeholder="Search connectors"></div>
        <select id="connectorCategory" class="connector-select"><option value="all">All categories</option></select>
        <select id="connectorStatus" class="connector-select">
          <option value="all">All states</option>
          <option value="available">Available</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
          <option value="removed">Removed</option>
          <option value="blocked">Blocked</option>
        </select>
        <select id="connectorRisk" class="connector-select">
          <option value="all">All risk</option>
          <option value="low">Low risk</option>
          <option value="medium">Medium risk</option>
          <option value="high">High risk</option>
        </select>
        <select id="connectorAction" class="connector-select">
          <option value="all">All actions</option>
          <option value="read">Read</option>
          <option value="write">Write</option>
          <option value="destructive">Destructive</option>
        </select>
      </div>
      <div class="connector-quickbar" aria-label="Connector quick filters">
        <button type="button" data-connector-preset="popular">Top picks</button>
        <button type="button" data-connector-preset="clear">All</button>
        <button type="button" data-connector-preset="enabled">Enabled</button>
        <button type="button" data-connector-preset="dev">Developer</button>
        <button type="button" data-connector-preset="comms">Comms</button>
        <button type="button" data-connector-preset="commerce">Commerce</button>
        <button type="button" data-connector-preset="write">Write-capable</button>
        <button type="button" data-connector-preset="high-risk">High risk</button>
        <button type="button" data-connector-preset="api-key">API key</button>
        <button type="button" data-connector-preset="self-serve">Self-serve</button>
        <button type="button" data-connector-preset="oauth">OAuth</button>
        <button type="button" data-connector-preset="google">Google</button>
        <button type="button" data-connector-preset="security">Security</button>
      </div>
      <div id="connectorBody" class="connector-body">
        <div class="connector-loading"><i class="ph ph-spinner-gap ph-spin"></i></div>
      </div>
    </div>`;
  }

  _bind() {
    this.container.querySelector('#connectorRefresh')?.addEventListener('click', () => this._load());
    this.container.querySelector('#connectorSearch')?.addEventListener('input', (event) => {
      this.query = String(event.target.value || '').trim().toLowerCase();
      this.visibleLimit = this.pageSize;
      this._scheduleRenderBody();
    });
    this.container.querySelector('#connectorCategory')?.addEventListener('change', (event) => {
      this.category = String(event.target.value || 'all');
      this.visibleLimit = this.pageSize;
      this._scheduleRenderBody();
    });
    this.container.querySelector('#connectorStatus')?.addEventListener('change', (event) => {
      this.status = String(event.target.value || 'all');
      this.visibleLimit = this.pageSize;
      this._scheduleRenderBody();
    });
    this.container.querySelector('#connectorRisk')?.addEventListener('change', (event) => {
      this.risk = String(event.target.value || 'all');
      this.visibleLimit = this.pageSize;
      this._scheduleRenderBody();
    });
    this.container.querySelector('#connectorAction')?.addEventListener('change', (event) => {
      this.action = String(event.target.value || 'all');
      this.visibleLimit = this.pageSize;
      this._scheduleRenderBody();
    });
    this.container.querySelectorAll('[data-connector-preset]').forEach((button) => {
      button.addEventListener('click', () => this._applyPreset(button.getAttribute('data-connector-preset')));
    });
  }

  _scheduleRenderBody() {
    if (this.renderTimer) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this._renderBody(), 90);
  }

  async _load() {
    try {
      const res = await fetch('/api/connectors/marketplace');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      this.data = payload.data || { entries: [], totals: {} };
      if (this.allow) {
        this.data.entries = (this.data.entries || []).filter((entry) => this.allow.has(entry.id));
      }
      // Best-effort: layer per-user enablement + connect-state over the catalog. A failure here
      // must never blank the catalog, so each fetch is independent and swallows its own error.
      await Promise.all([this._loadUserEnablement(), this._loadConnectState()]);
      this.visibleLimit = this.pageSize;
      this._renderCategoryOptions();
      this._renderBody();
    } catch (error) {
      logger.warn('Connector marketplace load failed', { error: error?.message });
      const body = this.container.querySelector('#connectorBody');
      if (body) body.innerHTML = '<div class="connector-empty">Connector catalog unavailable</div>';
    }
  }

  async _loadUserEnablement() {
    try {
      const res = await fetch('/api/connectors/marketplace/my-enablement');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const overrides = (payload.data && payload.data.overrides) || [];
      this.userEnablement = new Map(overrides.map((row) => [row.provider, row.enabled === true]));
    } catch (error) {
      logger.warn('Per-user enablement load failed', { error: error?.message });
      this.userEnablement = new Map();
    }
  }

  async _loadConnectState() {
    try {
      const res = await fetch('/api/connect/list');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const providers = payload.providers || [];
      this.connectState = new Map(providers.map((p) => [p.id, {
        connected: p.connected === true,
        status: p.status || (p.connected ? 'connected' : 'not_connected'),
      }]));
    } catch (error) {
      logger.warn('Connector connect-state load failed', { error: error?.message });
      this.connectState = new Map();
    }
  }

  /**
   * Whether this connector is currently ON for the signed-in user. NON-BREAKING semantics
   * (mirrors the server): deployment-enabled AND NOT explicitly user-disabled. Absence of a
   * per-user override = allowed.
   */
  _isOnForUser(entry) {
    const explicit = this.userEnablement.get(entry.id);
    if (explicit === false) return false;
    return entry.enabled === true;
  }

  /** Connect-state for the card ('connected' | 'not_connected' | null when the provider isn't connectable). */
  _connectStateFor(entry) {
    const state = this.connectState.get(entry.id) || this.connectState.get(entry.credProvider);
    if (!state) return null;
    return state.connected ? 'connected' : 'not_connected';
  }

  _renderCategoryOptions() {
    const select = this.container.querySelector('#connectorCategory');
    if (!select) return;
    const categories = Array.from(new Set((this.data.entries || []).map((entry) => entry.category).filter(Boolean))).sort();
    select.innerHTML = '<option value="all">All categories</option>' + categories
      .map((category) => `<option value="${this._escape(category)}">${this._escape(category)}</option>`)
      .join('');
    select.value = categories.includes(this.category) ? this.category : 'all';
  }

  _renderBody() {
    const body = this.container.querySelector('#connectorBody');
    if (!body) return;
    const entries = this._filteredEntries();
    const visibleEntries = entries.slice(0, this.visibleLimit);
    const hasMore = visibleEntries.length < entries.length;
    body.innerHTML = `
      ${this._shouldShowFeatured() ? this._renderFeaturedConnectors() : ''}
      ${this._renderSummary()}
      ${this._renderCatalogMeta()}
      <div class="connector-results">
        <span>${visibleEntries.length.toLocaleString()} of ${entries.length.toLocaleString()} connectors</span>
        <span>${this._escape(this._activeFilterLabel())}</span>
      </div>
      <div class="connector-grid">${visibleEntries.map((entry) => this._renderCard(entry)).join('')}</div>
      ${hasMore ? '<button class="connector-load-more" id="connectorLoadMore" type="button"><i class="ph ph-arrow-down"></i> Show more connectors</button>' : ''}
      ${entries.length === 0 ? '<div class="connector-empty">No connectors match this view</div>' : ''}
    `;
    body.querySelector('#connectorLoadMore')?.addEventListener('click', () => {
      this.visibleLimit += this.pageSize;
      this._renderBody();
    });
    body.querySelectorAll('[data-connector-action]').forEach((button) => {
      button.addEventListener('click', () => this._toggleConnector(button.dataset.provider, button.dataset.connectorAction));
    });
    body.querySelectorAll('[data-connector-user-action]').forEach((button) => {
      button.addEventListener('click', () => this._toggleForUser(button.dataset.provider, button.dataset.connectorUserAction));
    });
    body.querySelectorAll('[data-connector-focus]').forEach((button) => {
      button.addEventListener('click', () => this._focusConnector(button.dataset.connectorFocus));
    });
    body.querySelectorAll('[data-connector-run]').forEach((button) => {
      button.addEventListener('click', () => {
        const entry = (this.data.entries || []).find((item) => item.id === button.dataset.connectorRun);
        if (entry) openConnectorActionRunner(entry);
      });
    });
    body.querySelectorAll('[data-connector-preset]').forEach((button) => {
      button.addEventListener('click', () => this._applyPreset(button.getAttribute('data-connector-preset')));
    });
  }

  _renderFeaturedConnectors() {
    const byId = new Map((this.data.entries || []).map((entry) => [entry.id, entry]));
    const entries = FEATURED_CONNECTOR_IDS
      .map((id) => byId.get(id))
      .filter(Boolean)
      .slice(0, 14);
    if (entries.length === 0) return '';
    return `<section class="connector-featured surface-card" aria-label="Most common connectors">
      <div class="connector-section-head">
        <div>
          <h2>Most Common Connectors</h2>
          <p>Google, GitHub, Slack, payments, media, travel, home, and commerce.</p>
        </div>
        <button type="button" data-connector-preset="popular">Reset to top picks</button>
      </div>
      <div class="connector-feature-grid">
        ${entries.map((entry) => this._renderFeaturedTile(entry)).join('')}
      </div>
    </section>`;
  }

  _renderFeaturedTile(entry) {
    const onboarding = this._onboarding(entry);
    const actionHint = entry.enabled ? 'Enabled' : onboarding.setupLevel === 'operator-assisted' ? 'OAuth app' : onboarding.mode === 'no-auth' ? 'Ready' : 'User key';
    return `<button type="button" class="connector-feature-card surface-card connector-feature-card--${entry.installState}" data-connector-focus="${this._escape(entry.id)}" title="Open ${this._escape(entry.label)}">
      <span class="connector-feature-icon">${this._connectorIcon(entry)}</span>
      <span class="connector-feature-copy">
        <b>${this._escape(entry.label)}</b>
        <span>${this._escape(entry.category)} - ${this._escape(actionHint)}</span>
      </span>
      <i class="ph ph-arrow-right"></i>
    </button>`;
  }

  _renderSummary() {
    const totals = this.data.totals || {};
    const items = [
      ['Catalog', totals.entries ?? 0, 'ph-stack'],
      ['Enabled', totals.enabled ?? 0, 'ph-check-circle'],
      ['Available', totals.available ?? 0, 'ph-plug'],
      ['Removed', totals.removed ?? 0, 'ph-archive'],
      ['Write-capable', totals.writeCapable ?? 0, 'ph-warning-circle'],
      ['Actions', totals.actionCount ?? 0, 'ph-lightning'],
      ['Blocked', totals.blocked ?? 0, 'ph-x-circle'],
    ];
    return `<div class="connector-summary">${items.map(([label, value, icon]) => `
      <div class="connector-kpi">
        <i class="ph ${icon}"></i>
        <span class="connector-kpi-value">${value}</span>
        <span class="connector-kpi-label">${label}</span>
      </div>`).join('')}
    </div>`;
  }

  _renderCatalogMeta() {
    const entries = this.data.entries || [];
    const imported = entries.filter((entry) => String(entry.source?.path || '').includes('imported-openapi')).length;
    const curated = Math.max(0, entries.length - imported);
    const verifiedIcons = entries.filter((entry) => entry.iconVerified).length;
    const faviconIcons = entries.filter((entry) => entry.iconUrl && !entry.iconVerified).length;
    const writeCapable = entries.filter((entry) => (entry.writeCount || 0) > 0).length;
    const selfServe = entries.filter((entry) => entry.onboarding?.setupLevel === 'self-serve').length;
    const oauthApps = entries.filter((entry) => entry.onboarding?.mode === 'oauth-app').length;
    const meta = [
      ['Curated', curated],
      ['Imported OpenAPI', imported],
      ['Verified logos', verifiedIcons],
      ['Favicon fallbacks', faviconIcons],
      ['Write-capable', writeCapable],
      ['Self-serve', selfServe],
      ['OAuth apps', oauthApps],
    ];
    return `<div class="connector-catalog-meta">${meta.map(([label, value]) => `
      <span><b>${Number(value).toLocaleString()}</b>${this._escape(label)}</span>
    `).join('')}</div>`;
  }

  _renderCard(entry) {
    const action = entry.enabled ? 'disable' : 'enable';
    const disabled = entry.installState === 'blocked' ? 'disabled' : '';
    const canRemove = entry.installState !== 'removed' && entry.installState !== 'blocked';
    const isTopPick = FEATURED_CONNECTOR_IDS.includes(entry.id);
    // Per-user override toggle (only meaningful when the connector is deployment-enabled).
    const onForUser = this._isOnForUser(entry);
    const showForMe = entry.enabled === true;
    const forMeAction = onForUser ? 'disable-for-me' : 'enable-for-me';
    const forMeLabel = onForUser ? 'On for me' : 'Off for me';
    const forMeIcon = onForUser ? 'ph-toggle-right' : 'ph-toggle-left';
    // Per-user connect-state badge (null when the provider isn't a connectable one).
    const connect = this._connectStateFor(entry);
    const connectBadge = connect
      ? `<span class="connector-connect connector-connect--${connect}"><i class="ph ${connect === 'connected' ? 'ph-check-circle' : 'ph-circle-dashed'}"></i>${connect === 'connected' ? 'Connected' : 'Not connected'}</span>`
      : '';
    const description = entry.description ? this._escape(entry.description) : 'Connector spec ready for credentialed enablement and runtime audit.';
    const onboarding = this._onboarding(entry);
    const iconBadge = entry.iconVerified
      ? '<span class="connector-logo-badge connector-logo-badge--verified">Logo</span>'
      : entry.iconUrl
        ? '<span class="connector-logo-badge">Favicon</span>'
        : '<span class="connector-logo-badge connector-logo-badge--fallback">Initials</span>';
    return `<article class="connector-card surface-card connector-card--${entry.installState}${isTopPick ? ' connector-card--top-pick' : ''}">
      <div class="connector-card-head">
        <div class="connector-icon">${this._connectorIcon(entry)}</div>
        <div class="connector-name-wrap">
          <div class="connector-name">${this._escape(entry.label)}</div>
          <div class="connector-meta">${this._escape(entry.category)} - ${this._escape(entry.authType)}</div>
        </div>
        <span class="connector-state">${this._escape(entry.installState)}</span>
      </div>
      ${connectBadge ? `<div class="connector-connect-row">${connectBadge}</div>` : ''}
      <p class="connector-description">${description}</p>
      <div class="connector-logo-source">${iconBadge}<span>${this._escape(entry.iconTitle || entry.website || entry.source?.path || 'Generated connector')}</span></div>
      <div class="connector-onboarding connector-onboarding--${this._escape(onboarding.mode)}">
        <i class="ph ${this._escape(onboarding.icon)}"></i>
        <div>
          <b>${this._escape(onboarding.label)}</b>
          <span>${this._escape(onboarding.description)}</span>
        </div>
      </div>
      <div class="connector-facts">
        <span>${entry.resourceCount} resources</span>
        <span>${entry.toolCount} tools</span>
        <span>${entry.readCount || 0} reads</span>
        <span>${entry.writeCount || 0} writes</span>
        ${(entry.destructiveCount || 0) > 0 ? `<span>${entry.destructiveCount} destructive</span>` : ''}
        <span class="connector-risk connector-risk--${entry.riskLevel}">${entry.riskLevel}</span>
      </div>
      <div class="connector-scope-list">${this._visibleChips(entry).map((scope) => `<span>${this._escape(scope)}</span>`).join('')}</div>
      <div class="connector-action-list">${(entry.actions || []).slice(0, 4).map((action) => `
        <span class="connector-action connector-action--${this._escape(action.actionType)}">${this._escape(this._actionLabel(entry, action))}</span>
      `).join('')}</div>
      <div class="connector-audit ${entry.audit?.pass ? 'pass' : 'fail'}">
        <i class="ph ${entry.audit?.pass ? 'ph-shield-check' : 'ph-shield-warning'}"></i>
        <span>${entry.audit?.errors ?? 0} errors - ${entry.audit?.warnings ?? 0} warnings</span>
      </div>
      <div class="connector-actions">
        <button class="connector-primary-action" type="button" ${disabled} data-provider="${this._escape(entry.id)}" data-connector-action="${action}">
          <i class="ph ${entry.enabled ? 'ph-power' : 'ph-plus-circle'}"></i>
          <span>${entry.enabled ? 'Disable' : 'Enable'}</span>
        </button>
        <button class="connector-icon-action" type="button" title="Refresh audit" data-provider="${this._escape(entry.id)}" data-connector-action="audit-refresh">
          <i class="ph ph-shield-check"></i>
        </button>
        <button class="connector-icon-action" type="button" ${canRemove ? '' : 'disabled'} title="Remove from deployment" data-provider="${this._escape(entry.id)}" data-connector-action="remove">
          <i class="ph ph-archive"></i>
        </button>
        ${(entry.writeActions || []).length ? `<button class="connector-icon-action" type="button" title="Run a declared write action (confirmation-gated)" data-connector-run="${this._escape(entry.id)}">
          <i class="ph ph-lightning"></i>
        </button>` : ''}
      </div>
      ${showForMe ? `<div class="connector-user-actions">
        <button class="connector-user-toggle connector-user-toggle--${onForUser ? 'on' : 'off'}" type="button" title="${onForUser ? 'Turn this connector off for your account only' : 'Turn this connector back on for your account'}" data-provider="${this._escape(entry.id)}" data-connector-user-action="${forMeAction}">
          <i class="ph ${forMeIcon}"></i>
          <span>${forMeLabel}</span>
        </button>
      </div>` : ''}
    </article>`;
  }

  _filteredEntries() {
    return (this.data.entries || []).filter((entry) => {
      const matchesCategory = this.category === 'all' || entry.category === this.category;
      const matchesStatus = this.status === 'all' || entry.installState === this.status;
      const matchesRisk = this.risk === 'all' || entry.riskLevel === this.risk;
      const matchesAction = this.action === 'all'
        || (this.action === 'read' && (entry.readCount || 0) > 0)
        || (this.action === 'write' && (entry.writeCount || 0) > 0)
        || (this.action === 'destructive' && (entry.destructiveCount || 0) > 0);
      const actionText = (entry.actions || []).map((action) => `${action.tool || ''} ${action.resource || ''} ${action.actionType || ''} ${action.method || ''}`).join(' ');
      const onboarding = entry.onboarding || {};
      const haystack = `${entry.label} ${entry.id} ${entry.category} ${entry.authType} ${entry.description || ''} ${entry.iconTitle || ''} ${entry.website || ''} ${onboarding.mode || ''} ${onboarding.label || ''} ${onboarding.setupLevel || ''} ${onboarding.credentialScope || ''} ${(entry.tags || []).join(' ')} ${(entry.scopes || []).join(' ')} ${actionText}`.toLowerCase();
      return matchesCategory && matchesStatus && matchesRisk && matchesAction && (!this.query || haystack.includes(this.query));
    }).sort((left, right) => this._compareEntries(left, right));
  }

  _applyPreset(preset) {
    this.query = '';
    this.category = 'all';
    this.status = 'all';
    this.risk = 'all';
    this.action = 'all';
    switch (preset) {
      case 'popular':
        break;
      case 'enabled':
        this.status = 'enabled';
        break;
      case 'dev':
        this.category = 'Developer tools';
        break;
      case 'comms':
        this.category = 'Communications';
        break;
      case 'commerce':
        this.category = 'Commerce';
        break;
      case 'write':
        this.action = 'write';
        break;
      case 'high-risk':
        this.risk = 'high';
        break;
      case 'api-key':
        this.query = 'apiKey';
        break;
      case 'self-serve':
        this.query = 'self-serve';
        break;
      case 'oauth':
        this.query = 'oauth2';
        break;
      case 'google':
        this.query = 'google';
        break;
      case 'security':
        this.query = 'security';
        break;
      default:
        break;
    }
    this.visibleLimit = this.pageSize;
    this._syncFilterControls();
    this._renderBody();
  }

  _syncFilterControls() {
    const search = this.container.querySelector('#connectorSearch');
    const category = this.container.querySelector('#connectorCategory');
    const status = this.container.querySelector('#connectorStatus');
    const risk = this.container.querySelector('#connectorRisk');
    const action = this.container.querySelector('#connectorAction');
    if (search) search.value = this.query;
    if (category) category.value = this.category;
    if (status) status.value = this.status;
    if (risk) risk.value = this.risk;
    if (action) action.value = this.action;
  }

  _connectorIcon(entry) {
    const label = String(entry.label || entry.id || '?').trim();
    const initials = label.split(/\s+|-/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';
    const iconSlug = this._iconSlug(entry);
    const img = entry.iconUrl
      ? entry.iconUrl
      : iconSlug
        ? `https://cdn.simpleicons.org/${encodeURIComponent(iconSlug)}/E2E8F0`
        : '';
    if (img) {
      return `<img src="${this._escape(img)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';"><span class="connector-initials connector-initials--hidden">${this._escape(initials)}</span>`;
    }
    return `<span class="connector-initials">${this._escape(initials)}</span>`;
  }

  _onboarding(entry) {
    const fallback = {
      mode: 'user-key',
      label: entry.authType === 'oauth2' ? 'OAuth app + user consent' : 'User-owned credential',
      description: 'Enable the connector, then resolve credentials through the per-user brokered store.',
      setupLevel: entry.authType === 'oauth2' ? 'operator-assisted' : 'self-serve',
      credentialScope: entry.authType === 'none' ? 'none' : 'per-user',
    };
    const onboarding = entry.onboarding || fallback;
    const iconByMode = {
      'user-key': 'ph-key',
      'oauth-app': 'ph-sign-in',
      'basic-auth': 'ph-identification-card',
      'no-auth': 'ph-globe',
    };
    return {
      ...fallback,
      ...onboarding,
      icon: iconByMode[onboarding.mode] || 'ph-plug',
    };
  }

  _activeFilterLabel() {
    const filters = [
      this.category !== 'all' ? this.category : '',
      this.status !== 'all' ? this.status : '',
      this.risk !== 'all' ? `${this.risk} risk` : '',
      this.action !== 'all' ? `${this.action} actions` : '',
    ].filter(Boolean);
    return filters.length ? filters.join(' / ') : 'Top connectors first';
  }

  _shouldShowFeatured() {
    return !this.query && this.category === 'all' && this.status === 'all' && this.risk === 'all' && this.action === 'all';
  }

  _focusConnector(provider) {
    if (!provider) return;
    this.query = provider;
    this.category = 'all';
    this.status = 'all';
    this.risk = 'all';
    this.action = 'all';
    this.visibleLimit = this.pageSize;
    this._syncFilterControls();
    this._renderBody();
  }

  _compareEntries(left, right) {
    const scoreDelta = this._entryScore(right) - this._entryScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    return String(left.label || left.id).localeCompare(String(right.label || right.id));
  }

  _entryScore(entry) {
    const id = String(entry.id || '');
    const sourcePath = String(entry.source?.path || '');
    let score = POPULAR_SCORE.get(id) || 0;
    if (entry.enabled) score += 500;
    if (entry.installState === 'available') score += 60;
    if (entry.audit?.pass) score += 60;
    if (!sourcePath.includes('imported-openapi')) score += 180;
    if (entry.iconVerified || entry.iconUrl || this._iconSlug(entry)) score += 80;
    if ((entry.readCount || 0) > 0) score += 20;
    if ((entry.writeCount || 0) > 0) score += 10;
    if (this.query && id.toLowerCase() === this.query.toLowerCase()) score += 1500;
    if (entry.installState === 'blocked') score -= 1000;
    if (entry.installState === 'removed') score -= 500;
    return score;
  }

  _iconSlug(entry) {
    const id = String(entry.id || '').toLowerCase();
    const credProvider = String(entry.credProvider || '').toLowerCase();
    if (entry.icon) return entry.icon;
    if (ICON_BY_PROVIDER[id]) return ICON_BY_PROVIDER[id];
    if (ICON_BY_PROVIDER[credProvider]) return ICON_BY_PROVIDER[credProvider];
    if (id.startsWith('googleapis-') || id.startsWith('google-')) return 'googlecloud';
    if (id.includes('ebay')) return 'ebay';
    if (id.includes('amazonaws')) return 'amazonaws';
    if (id.includes('microsoft') || id.includes('azure')) return 'microsoftazure';
    if (id.includes('paypal')) return 'paypal';
    if (id.includes('stripe')) return 'stripe';
    return '';
  }

  _visibleChips(entry) {
    const onboarding = this._onboarding(entry);
    const chips = [];
    if (FEATURED_CONNECTOR_IDS.includes(entry.id)) chips.push('Top pick');
    if (onboarding.mode === 'oauth-app') chips.push('OAuth app');
    if (onboarding.mode === 'user-key') chips.push('API key');
    if (onboarding.mode === 'basic-auth') chips.push('Basic auth');
    if (onboarding.mode === 'no-auth') chips.push('No auth');
    if ((entry.readCount || 0) > 0) chips.push('Read');
    if ((entry.writeCount || 0) > 0) chips.push('Write');
    if ((entry.destructiveCount || 0) > 0) chips.push('Destructive');
    chips.push(String(entry.source?.path || '').includes('imported-openapi') ? 'Imported' : 'Curated');
    if (entry.iconVerified || entry.iconUrl || this._iconSlug(entry)) chips.push('Icon');
    return Array.from(new Set(chips)).slice(0, 6);
  }

  _actionLabel(entry, action) {
    const raw = String(action.tool || action.resource || action.method || 'Action');
    const provider = this._escapeRegex(String(entry.id || '')).replace(/[-_]/g, '[ -_]?');
    const clean = raw
      .replace(new RegExp(`^${provider}[ -_]?`, 'i'), '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b(get|post|put|patch|delete)\b/ig, (match) => match.toUpperCase());
    return clean
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .map((part) => part.length <= 3 ? part : part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || raw;
  }

  _escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async _toggleConnector(provider, action) {
    if (!provider || !action) return;
    const body = this.container.querySelector('#connectorBody');
    body?.classList.add('is-busy');
    try {
      const res = await fetch(`/api/connectors/marketplace/${encodeURIComponent(provider)}/${action}`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.success === false) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      await this._load();
    } catch (error) {
      logger.warn('Connector marketplace action failed', { provider, action, error: error?.message });
      if (body) body.insertAdjacentHTML('afterbegin', `<div class="connector-error">${this._escape(error?.message || 'Connector action failed')}</div>`);
    } finally {
      body?.classList.remove('is-busy');
    }
  }

  /**
   * Apply a per-user override (enable-for-me / disable-for-me) for the signed-in user only.
   * NON-BREAKING: this never changes deployment state or any other user; it hits the authed
   * /api/connectors/marketplace/:provider/{enable,disable}-for-me routes.
   */
  async _toggleForUser(provider, action) {
    if (!provider || (action !== 'enable-for-me' && action !== 'disable-for-me')) return;
    const body = this.container.querySelector('#connectorBody');
    body?.classList.add('is-busy');
    try {
      const res = await fetch(`/api/connectors/marketplace/${encodeURIComponent(provider)}/${action}`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload.success === false) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      await this._load();
    } catch (error) {
      logger.warn('Per-user connector toggle failed', { provider, action, error: error?.message });
      if (body) body.insertAdjacentHTML('afterbegin', `<div class="connector-error">${this._escape(error?.message || 'Per-user toggle failed')}</div>`);
    } finally {
      body?.classList.remove('is-busy');
    }
  }

  _escape(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
