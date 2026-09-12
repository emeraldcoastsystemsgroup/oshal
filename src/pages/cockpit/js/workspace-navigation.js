/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add an optional authorized workspace rail without replacing application screens or their navigation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep iframe-to-shell focus transitions from replacing a navigation control during its click while retaining external-focus policy refresh.
 */
import { createUiLogger, serializeUiError } from '../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-workspace-navigation');
const STORAGE_KEY = 'oshal-navigation-layout';
const CHANGE_EVENT = 'oshal-navigation-layout-changed';
const CURATED = ['little-monsters', 'create', 'intelligent-career'];

/** Read only the layout preference; a missing, invalid or unavailable value keeps the existing sidebar. */
export function readNavigationLayout() {
  try { return localStorage.getItem(STORAGE_KEY) === 'workspaces' ? 'workspaces' : 'sidebar'; }
  catch (error) {
    logger.debug('Navigation preference unavailable; keeping the existing sidebar', { error: serializeUiError(error) });
    return 'sidebar';
  }
}

/** Change browser-local navigation chrome without selecting a profile, changing a theme or touching a screen. */
export function setNavigationLayout(value) {
  const layout = value === 'workspaces' ? 'workspaces' : 'sidebar';
  try { localStorage.setItem(STORAGE_KEY, layout); }
  catch (error) { logger.debug('Navigation choice is limited to this tab', { error: serializeUiError(error) }); }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: layout }));
}

/** Render a separately labeled preference in the existing Settings page. */
export function navigationSettingsMarkup() {
  const current = document.documentElement.dataset.navigationLayout || readNavigationLayout();
  return `<div class="setting-field workspace-navigation-setting">
    <label for="settingsNavigationLayout">Navigation</label>
    <select id="settingsNavigationLayout">
      <option value="sidebar"${current === 'sidebar' ? ' selected' : ''}>Sidebar (existing layout)</option>
      <option value="workspaces"${current === 'workspaces' ? ' selected' : ''}>Top workspaces + sidebar</option>
    </select>
    <span class="field-hint">Saved in this browser, separately from the color theme. Top headings open complete applications; each application's screens and left navigation stay available.</span>
  </div>`;
}

/** Bind the local preference independently from the shared runtime Save action. */
export function bindNavigationSettings(container) {
  container.querySelector('#settingsNavigationLayout')?.addEventListener('change', event => {
    setNavigationLayout(event.target.value);
  });
}

/** Accept only the canonical installed-profile destinations supplied by the current-authority endpoint. */
export function admittedWorkspaces(payload) {
  const seen = new Set();
  return (Array.isArray(payload?.workspaces) ? payload.workspaces : []).filter(item => {
    if (!item || typeof item.name !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(item.name)
      || seen.has(item.name) || !['app', 'group'].includes(item.kind)
      || item.href !== `/cockpit/?app=${encodeURIComponent(item.name)}`
      || typeof item.displayName !== 'string' || !item.displayName.trim() || item.displayName.length > 160) return false;
    seen.add(item.name); return true;
  }).map(({ name, displayName, href, kind }) => ({ name, displayName, href, kind }));
}

/** The URL remains the sole profile selector; a layout preference never remembers an application. */
function currentWorkspace() {
  const params = new URLSearchParams(location.search);
  return params.get('app') || params.get('profile') || 'cockpit';
}

/** Use real links so native history, modifier clicks and application beforeunload handling remain intact. */
function workspaceLink(item, active) {
  const link = document.createElement('a');
  link.href = item.href;
  link.dataset.workspace = item.name;
  link.textContent = item.name === 'little-monsters' ? 'Learning' : item.displayName;
  if (item.name === 'little-monsters') link.title = 'Open Little Monsters';
  if (item.name === active) link.setAttribute('aria-current', 'page');
  return link;
}

/** Optional shell chrome. Application content, ribbon registrations and surface message bridges are not modified. */
export class WorkspaceNavigation {
  constructor({ profile, studentMode = false } = {}) {
    this.profile = profile;
    this.suppressed = studentMode;
    this.layout = readNavigationLayout();
    this.items = [];
    this.generation = 0;
    this.cleanups = [];
    if (this.suppressed || !document.querySelector('.header-bar')) return;
    this.mount();
    this.listen();
    this.update(this.layout);
  }

  /** Mount only two new chrome nodes; never replace or move the active screen or sidebar. */
  mount() {
    this.control = document.createElement('div');
    this.control.className = 'workspace-navigation-control';
    this.control.innerHTML = `<button type="button" class="header-btn" id="workspaceNavigationToggle"
      aria-label="Navigation layout" title="Navigation layout" aria-expanded="false" aria-controls="workspaceNavigationOptions">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 9v11"/>
      </svg></button>
      <div id="workspaceNavigationOptions" class="workspace-navigation-options" hidden>
        <fieldset><legend>Navigation layout</legend>
          <label><input type="radio" name="workspace-navigation-layout" value="sidebar"> Sidebar</label>
          <label><input type="radio" name="workspace-navigation-layout" value="workspaces"> Top workspaces + sidebar</label>
        </fieldset><p>Color themes and application screens stay the same.</p>
      </div>`;
    document.querySelector('.header-right')?.prepend(this.control);
    this.rail = document.createElement('nav');
    this.rail.id = 'workspaceNavigation';
    this.rail.setAttribute('aria-label', 'Application workspaces');
    this.rail.hidden = true;
    document.querySelector('.header-bar').after(this.rail);
    this.toggle = this.control.querySelector('button');
    this.options = this.control.querySelector('#workspaceNavigationOptions');
  }

  /** Own listeners explicitly so component teardown cannot retain a stale policy fetch. */
  on(target, name, listener) {
    target.addEventListener(name, listener);
    this.cleanups.push(() => target.removeEventListener(name, listener));
  }

  listen() {
    this.on(this.toggle, 'click', () => this.showOptions(this.options.hidden));
    this.on(this.control, 'change', event => {
      if (event.target.name === 'workspace-navigation-layout') setNavigationLayout(event.target.value);
    });
    this.on(document, 'pointerdown', event => {
      if (!this.control.contains(event.target)) this.showOptions(false);
    });
    this.on(document, 'keydown', event => this.handleKey(event));
    this.on(window, CHANGE_EVENT, event => this.update(event.detail));
    this.on(window, 'storage', event => { if (event.key === STORAGE_KEY || event.key === null) this.update(readNavigationLayout()); });
    // A focused child iframe still gives this document focus; its return must not remove the clicked control.
    this.on(window, 'blur', () => { this.focusStayedInPage = document.hasFocus(); });
    this.on(window, 'focus', () => {
      const internal = this.focusStayedInPage;
      this.focusStayedInPage = false;
      if (!internal) this.refresh();
    });
    this.on(window, 'pageshow', () => this.refresh());
    this.on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') this.refresh();
      else { this.focusStayedInPage = false; this.clearDiscovery(); }
    });
    this.on(document, 'fullscreenchange', () => this.syncVisibility());
  }

  handleKey(event) {
    if (event.key !== 'Escape') return;
    if (!this.options.hidden) { this.showOptions(false); this.toggle.focus(); event.stopPropagation(); }
    const more = this.rail.querySelector('details[open]');
    if (more) { more.open = false; more.querySelector('summary').focus(); event.stopPropagation(); }
  }

  showOptions(open) {
    this.options.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    if (open) this.options.querySelector('input:checked')?.focus();
  }

  /** Update chrome only; no URL changes, theme changes or application rerender. */
  update(value) {
    this.layout = value === 'workspaces' ? 'workspaces' : 'sidebar';
    document.documentElement.dataset.navigationLayout = this.layout;
    this.control.querySelectorAll('input').forEach(input => { input.checked = input.value === this.layout; });
    const settings = document.getElementById('settingsNavigationLayout');
    if (settings) settings.value = this.layout;
    this.syncVisibility();
    if (this.layout === 'workspaces') void this.refresh();
    else this.clearDiscovery();
  }

  syncVisibility() {
    this.rail.hidden = this.layout !== 'workspaces' || Boolean(document.fullscreenElement);
  }

  /** Never retain admitted names across a hidden page, failed refresh or layout opt-out. */
  clearDiscovery() {
    this.generation += 1;
    this.abort?.abort();
    this.items = [];
    this.notice = '';
    this.render();
  }

  async refresh() {
    if (this.layout !== 'workspaces' || document.visibilityState === 'hidden') return;
    this.clearDiscovery();
    const generation = this.generation;
    const controller = new AbortController();
    this.abort = controller;
    const timer = setTimeout(() => controller.abort(), 5000);
    this.notice = 'Loading workspaces…'; this.render();
    try {
      const response = await fetch('/api/ui/workspaces', { credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error('unavailable');
      const payload = await response.json();
      if (!Array.isArray(payload?.workspaces)) throw new Error('unavailable');
      if (generation !== this.generation) return;
      this.items = admittedWorkspaces(payload); this.notice = '';
    } catch (error) {
      if (generation !== this.generation) return;
      logger.warn('Current workspace discovery unavailable', { error: serializeUiError(error) });
      this.items = []; this.notice = 'Workspaces unavailable. Try again.';
    } finally { clearTimeout(timer); }
    if (generation === this.generation) this.render();
  }

  /** Keep the curated rail compact; every other admitted complete workspace remains in More. */
  render() {
    if (!this.rail) return;
    const active = currentWorkspace();
    const links = document.createElement('div'); links.className = 'workspace-navigation-links';
    links.append(workspaceLink({ name: 'cockpit', displayName: 'oshal Cockpit', href: '/cockpit/' }, active));
    for (const name of CURATED) {
      const item = this.items.find(candidate => candidate.name === name);
      if (item) links.append(workspaceLink(item, active));
    }
    this.rail.replaceChildren(links, this.moreMenu(active));
    if (this.notice) {
      const status = document.createElement('span'); status.dataset.workspaceStatus = '';
      status.setAttribute('role', 'status'); status.textContent = this.notice;
      this.rail.append(status);
      if (this.notice.startsWith('Workspaces unavailable')) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry';
        retry.addEventListener('click', () => this.refresh()); this.rail.append(retry);
      }
    }
  }

  moreMenu(active) {
    const more = document.createElement('details'); more.id = 'workspaceNavigationMore';
    const summary = document.createElement('summary');
    const extras = this.items.filter(item => !CURATED.includes(item.name));
    summary.textContent = extras.find(item => item.name === active)?.displayName || 'More';
    const body = document.createElement('div'); body.className = 'workspace-navigation-more';
    for (const item of extras) body.append(workspaceLink(item, active));
    const all = document.createElement('a'); all.href = '/cockpit/'; all.textContent = 'All applications';
    all.dataset.workspaceAll = ''; body.append(all);
    more.append(summary, body); return more;
  }

  /** Release only this overlay's resources; active app content belongs to the existing controller. */
  destroy() {
    this.generation += 1; this.abort?.abort();
    this.cleanups.forEach(remove => remove());
    this.control?.remove(); this.rail?.remove();
  }
}
