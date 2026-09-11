/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep first-run source selection, reviewed installs and account setup resumable without bypassing installer authority.
 */

const API = '/api/swarm/registries';
const identifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/.test(value);

function element(tag, text, parent) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (parent) parent.append(item);
  return item;
}

async function request(url, body) {
  const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || (response.status === 403
    ? 'An administrator manages sources and application installation. You can skip this step.'
    : `Request failed (${response.status}). Try again.`));
  return data;
}

function heading(container, title, detail) {
  container.replaceChildren();
  const section = element('section', undefined, container);
  section.className = 'step-content provisioning-step';
  element('h2', title, section);
  element('p', detail, section);
  return section;
}

function link(parent, label, href) {
  const anchor = element('a', label, parent);
  anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener';
  return anchor;
}

/**
 * @description Manage first-run choices through the existing operator-protected registry APIs.
 * Saved progress is presentation state and never installation or trust authority.
 * @param {Function} save Persist the caller's resumable preferences.
 * @returns {ProvisioningController} A controller with three wizard renderers.
 */
export class ProvisioningController {
  constructor(save) {
    this.save = save;
    this.state = { source: '', selected: [], installed: [] };
    this.busy = false;
  }

  /** @description Restore bounded selections, never credentials or arbitrary source URLs.
   * @param {object} input Saved preferences. @returns {void} */
  restore(input) {
    if (!input || typeof input !== 'object') return;
    const pairs = values => Array.isArray(values) ? values.filter(item => item
      && identifier(item.registry) && identifier(item.name)).slice(0, 80)
      .map(({ registry, name }) => ({ registry, name })) : [];
    this.state = { source: identifier(input.source) ? input.source : '',
      selected: pairs(input.selected), installed: pairs(input.installed) };
  }

  /** @description Return serializable progress only. @returns {object} Saved choices. */
  snapshot() { return JSON.parse(JSON.stringify(this.state)); }

  key(item) { return `${item.registry}/${item.name}`; }
  selected(item) { return this.state.selected.some(value => this.key(value) === this.key(item)); }
  installed(item) { return this.state.installed.some(value => this.key(value) === this.key(item)); }

  /** @description Require selected installs to succeed or be explicitly deselected.
   * @returns {boolean} Whether the wizard may complete. */
  ready() { return !this.busy && this.state.selected.every(item => this.installed(item)); }

  async changed() { await this.save(this.snapshot()); }

  async reconcile() {
    const data = await request('/api/swarm/apps');
    const active = new Set((data.apps || []).filter(app => app.status === 'active').map(app => app.name));
    const verified = [];
    for (const item of this.state.installed) {
      if (!active.has(item.name)) continue;
      // The installer's preview checks its on-disk source receipt. Name alone cannot
      // distinguish a package that another operator replaced from a different store.
      const preview = await request(`${API}/${encodeURIComponent(item.registry)}/preview/${encodeURIComponent(item.name)}`);
      if (preview.replacement === null && preview.source?.url) verified.push(item);
    }
    this.state.installed = verified;
  }

  /** @description List already trusted sources; adding trust uses the existing administration page.
   * @param {HTMLElement} container Wizard surface. @returns {Promise<void>} Render completion. */
  async renderSources(container) {
    const section = heading(container, 'Choose an application source',
      'Select an existing trusted source. You can skip application installation and return later.');
    link(section, 'Manage trusted sources', '/app-loader');
    try {
      const data = await request(API);
      const sources = (data.registries || []).filter(source => source.enabled && source.trustState === 'trusted');
      if (!sources.length) { element('p', 'No trusted sources are available yet.', section); return; }
      const select = element('select', undefined, section); select.id = 'provisioning-source';
      const blank = element('option', 'Choose a source', select); blank.value = '';
      for (const source of sources) {
        const option = element('option', source.displayName || source.slug, select); option.value = source.slug;
      }
      select.value = this.state.source;
      const status = element('p', '', section); status.setAttribute('role', 'status');
      select.addEventListener('change', async () => {
        this.state.source = select.value;
        try { await this.changed(); status.textContent = 'Source choice saved.'; }
        catch { status.textContent = 'Could not save this choice. Try again before leaving.'; }
      });
    } catch (error) { element('p', error.message, section).setAttribute('role', 'alert'); }
  }

  async toggle(item, checked, status) {
    this.state.selected = this.state.selected.filter(value => this.key(value) !== this.key(item));
    if (checked) this.state.selected.push({ registry: item.registry, name: item.name });
    try { await this.changed(); status.textContent = checked ? 'Selected. Review before installing.' : 'Skipped.'; }
    catch { status.textContent = 'Choice could not be saved. Try again.'; }
  }

  appCard(item, parent) {
    const card = element('article', undefined, parent); card.className = 'provisioning-app';
    card.dataset.package = this.key(item);
    const label = element('label', undefined, card);
    const checkbox = element('input', undefined, label); checkbox.type = 'checkbox'; checkbox.checked = this.selected(item);
    label.append(document.createTextNode(` ${item.displayName || item.name} (${item.registry})`));
    const status = element('p', this.installed(item) ? 'Installed.' : 'Not installed by this setup.', card);
    status.setAttribute('role', 'status');
    checkbox.addEventListener('change', () => this.toggle(item, checkbox.checked, status));
    const review = element('button', 'Review installation', card); review.type = 'button';
    const panel = element('div', undefined, card);
    review.addEventListener('click', () => this.preview(item, panel, status));
  }

  /** @description Discover packages through trusted registries and keep each source/name distinct.
   * @param {HTMLElement} container Wizard surface. @returns {Promise<void>} Render completion. */
  async renderApps(container) {
    const section = heading(container, 'Install your applications',
      'Select a package, review its changes, then install. Deselect a package to skip it. Failed installs remain here for retry.');
    const available = new Set();
    if (!this.state.source) {
      element('p', 'Choose a trusted source in the previous step, or skip applications.', section);
      this.renderOtherSelections(section, available); return;
    }
    try {
      await this.reconcile();
      const data = await request(`${API}/catalog`);
      const source = (data.sources || []).find(item => item.slug === this.state.source);
      if (!source?.ok) throw new Error(`Source ${this.state.source} is unavailable. Review it in Manage trusted sources.`);
      const apps = (data.apps || []).filter(item => item.registry === this.state.source);
      for (const app of apps) { available.add(this.key(app)); this.appCard(app, section); }
      if (!apps.length) element('p', 'This source currently has no applications.', section);
    } catch (error) { element('p', error.message, section).setAttribute('role', 'alert'); }
    this.renderOtherSelections(section, available);
  }

  renderOtherSelections(section, available) {
    for (const item of this.state.selected.filter(value => !available.has(this.key(value)))) {
      const row = element('p', `${this.key(item)}: ${this.installed(item) ? 'installed' : 'pending'} `, section);
      const remove = element('button', 'Skip this selection', row); remove.type = 'button';
      remove.addEventListener('click', async () => { await this.toggle(item, false, row); });
    }
  }

  async preview(item, panel, status) {
    panel.replaceChildren(); status.textContent = `Reviewing ${item.name}…`;
    try {
      const preview = await request(`${API}/${encodeURIComponent(item.registry)}/preview/${encodeURIComponent(item.name)}`);
      element('h3', `${preview.displayName || item.name} ${preview.version || ''}`, panel);
      element('p', preview.install?.note || 'Review the package changes.', panel);
      const impact = preview.impact || {};
      for (const [label, field] of [['Routes', 'routes'], ['Database changes', 'migrations'], ['Bots', 'bots'], ['Schedules', 'schedules']]) {
        element('p', `${label}: ${impact[field]?.count || 0}`, panel);
      }
      if (preview.replacement) {
        element('p', 'This replaces a package from another source. Review that replacement in the application loader.', panel);
        link(panel, 'Review source replacement', '/app-loader'); return;
      }
      if (preview.install?.allowed !== true) { status.textContent = `${item.name}: installation is unavailable.`; return; }
      const install = element('button', `Install ${item.name}`, panel); install.type = 'button';
      install.addEventListener('click', () => this.install(item, install, status));
      status.textContent = 'Review complete. Installation starts only when you select Install.';
    } catch (error) { status.textContent = `${item.name}: ${error.message}`; }
  }

  async install(item, button, status) {
    if (this.busy) { status.textContent = 'Wait for the current installation to finish.'; return; }
    this.busy = true; button.disabled = true; status.textContent = `Installing ${item.name}…`;
    try {
      const result = await request(`${API}/install`, { registry: item.registry, name: item.name });
      if (result.installed !== true) throw new Error('The installer did not confirm success.');
      this.state.installed = this.state.installed.filter(value => this.key(value) !== this.key(item));
      this.state.installed.push({ registry: item.registry, name: item.name });
      await this.changed(); status.textContent = `${item.name}: installed.`;
    } catch (error) { status.textContent = `${item.name}: ${error.message}`; }
    finally { this.busy = false; button.disabled = false; }
  }

  /** @description Link existing account administration into setup without electing a new root.
   * @param {HTMLElement} container Wizard surface. @returns {Promise<void>} Render completion. */
  async renderUsers(container) {
    const section = heading(container, 'People and access',
      'Existing Google, Microsoft and local accounts keep their identities. Administrators can invite local users and assign application access.');
    link(section, 'Open Users', '/users/'); element('p', '', section);
    link(section, 'Open Access Administration', '/access/');
    element('p', 'This step is optional. You can manage people later from Users.', section);
    try {
      const me = await request('/api/swarm/roles/me');
      element('p', me.isOperator ? 'You can review users and access.' : 'Ask a swarm administrator to manage invitations and roles.', section);
    } catch (error) { element('p', error.message, section); }
  }
}
