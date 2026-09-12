/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add an optional authorized workspace rail without replacing application screens or their navigation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep iframe-to-shell focus transitions from replacing a navigation control during its click while retaining external-focus policy refresh.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Prefer the admitted Career group with the admitted Career app as its curated fallback, keeping the selected destination out of More.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Allow bounded cold profile discovery to finish within thirty seconds without retaining stale destinations or changing cancellation fences.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Place workspaces beside the header brand and expose the same admitted destinations through an accessible compact phone disclosure.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Deduplicate Home and current workspace labels, anchor More to its trigger, and share one utilities panel with the sidebar header.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Add admitted Federal CRM and delegate repeated default-sidebar pages only while their complete workspace is available on top.
 */
import { createUiLogger, serializeUiError } from '../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-workspace-navigation');
const STORAGE_KEY = 'oshal-navigation-layout';
const CHANGE_EVENT = 'oshal-navigation-layout-changed';
const CURATED = [['little-monsters'], ['create'], ['intelligent-career', 'career-hunter'], ['capture-crm']];
/** Current top destinations, sent to sidebar presentation without changing view registrations. */
export const WORKSPACE_DESTINATIONS_EVENT = 'oshal-workspace-destinations-changed';

/**
 * @description Name the sidebar delegations fulfilled by selected top destinations, including the Career fallback.
 * @param {Array<{name: string}>} items Currently admitted, selected top workspace records.
 * @returns {string[]} Exact workspace slugs whose pages are available through the top rail.
 */
export function workspaceSidebarNames(items) {
  return CURATED.filter(names => items.some(item => names.includes(item.name))).flat();
}

/**
 * @description Only explicit metadata in the default framework profile delegates a sidebar page.
 * @param {object} view Registered sidebar view, never removed from the navigation registry.
 * @param {string} profileName Current resolved profile name.
 * @param {string[]} names Current admitted top-workspace delegations.
 * @returns {boolean} Whether the top navigation already exposes the complete workspace for this page.
 */
export function isWorkspaceDelegated(view, profileName, names) {
  return profileName === 'oshal-framework' && typeof view?.workspace === 'string' && names.includes(view.workspace);
}

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

/** Choose each slot from currently admitted destinations in preference order. */
function curatedWorkspaces(items) {
  const selected = [];
  for (const names of CURATED) {
    const item = names.map(name => items.find(candidate => candidate.name === name)).find(Boolean);
    if (item) selected.push(item);
  }
  return selected;
}

/** Optional shell chrome. Application content and ribbon registrations remain with their existing controllers. */
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
      </svg><span>Navigation layout</span></button>
      <div id="workspaceNavigationOptions" class="workspace-navigation-options" hidden>
        <fieldset><legend>Navigation layout</legend>
          <label><input type="radio" name="workspace-navigation-layout" value="sidebar"> Sidebar</label>
          <label><input type="radio" name="workspace-navigation-layout" value="workspaces"> Top workspaces + sidebar</label>
        </fieldset><p>Color themes and application screens stay the same.</p>
      </div>`;
    this.utilities = document.getElementById('cockpitHeaderUtilities');
    this.utilitiesHome = this.utilities?.parentElement;
    this.headerOptions = document.getElementById('cockpitHeaderOptions');
    if (this.utilities) this.utilities.append(this.control);
    else document.querySelector('.header-right')?.prepend(this.control);
    this.rail = document.createElement('nav');
    this.rail.id = 'workspaceNavigation';
    this.rail.setAttribute('aria-label', 'Application workspaces');
    this.rail.hidden = true;
    this.rail.innerHTML = `<button type="button" id="workspaceNavigationCompactToggle"
      aria-label="Application workspaces" title="Application workspaces" aria-expanded="false" aria-controls="workspaceNavigationDestinations">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
      </svg></button><div id="workspaceNavigationDestinations" class="workspace-navigation-destinations"></div>`;
    document.querySelector('.header-left').after(this.rail);
    this.compactToggle = this.rail.querySelector('#workspaceNavigationCompactToggle');
    this.destinations = this.rail.querySelector('#workspaceNavigationDestinations');
    this.toggle = this.control.querySelector('button');
    this.options = this.control.querySelector('#workspaceNavigationOptions');
    this.resizeObserver = new ResizeObserver(() => this.positionMore());
  }

  /** Own listeners explicitly so component teardown cannot retain a stale policy fetch. */
  on(target, name, listener) {
    target.addEventListener(name, listener);
    this.cleanups.push(() => target.removeEventListener(name, listener));
  }

  listen() {
    this.on(this.toggle, 'click', () => this.showOptions(this.options.hidden));
    this.on(this.compactToggle, 'click', () => this.showCompact(!this.compactOpen));
    this.on(matchMedia('(max-width: 640px)'), 'change', () => this.showCompact(false));
    this.on(window, 'resize', () => this.positionMore());
    this.on(this.rail, 'focusin', event => {
      event.target.closest('.workspace-navigation-links a')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    this.on(this.control, 'change', event => {
      if (event.target.name === 'workspace-navigation-layout') setNavigationLayout(event.target.value);
    });
    this.on(document, 'pointerdown', event => {
      if (!this.control.contains(event.target)) this.showOptions(false);
      const more = this.rail.querySelector('details[open]');
      if (more && !more.contains(event.target)) more.open = false;
      if (!this.rail.contains(event.target)) this.showCompact(false);
    });
    this.on(document, 'keydown', event => this.handleKey(event));
    this.on(window, CHANGE_EVENT, event => this.update(event.detail));
    this.on(window, 'storage', event => { if (event.key === STORAGE_KEY || event.key === null) this.update(readNavigationLayout()); });
    // A focused child iframe still gives this document focus; its return must not remove the clicked control.
    this.on(window, 'blur', () => {
      this.focusStayedInPage = document.hasFocus();
      this.showCompact(false);
    });
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
    if (!this.options.hidden) { this.showOptions(false); this.toggle.focus(); event.stopPropagation(); return; }
    const more = this.rail.querySelector('details[open]');
    if (more) { more.open = false; more.querySelector('summary').focus(); event.stopPropagation(); return; }
    if (this.compactOpen) { this.showCompact(false); this.compactToggle.focus(); event.stopPropagation(); }
  }

  showOptions(open) {
    if (open && !this.rail.contains(this.control)) this.showCompact(false);
    this.options.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    if (open) this.options.querySelector('input:checked')?.focus();
  }

  /** Keep the compact disclosure independent from discovery and the active application's document. */
  showCompact(open) {
    this.compactOpen = open;
    if (!open) { const more = this.rail.querySelector('details[open]'); if (more) more.open = false; }
    this.rail.toggleAttribute('data-compact-open', open);
    this.compactToggle.setAttribute('aria-expanded', String(open));
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
    if (this.rail.hidden) this.showCompact(false);
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
    const timer = setTimeout(() => controller.abort(), 30000);
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
    const curated = curatedWorkspaces(this.items);
    const links = document.createElement('div'); links.className = 'workspace-navigation-links';
    const home = document.getElementById('cockpitHomeLink');
    if (home) {
      if (active === 'cockpit') home.setAttribute('aria-current', 'page');
      else home.removeAttribute('aria-current');
    } else links.append(workspaceLink({ name: 'cockpit', displayName: 'oshal Cockpit', href: '/cockpit/' }, active));
    for (const item of curated) links.append(workspaceLink(item, active));
    this.destinations.replaceChildren(links, this.moreMenu(active, curated));
    this.publishSidebarDestinations(curated);
    this.resizeObserver.disconnect();
    this.resizeObserver.observe(this.rail); this.resizeObserver.observe(links);
    if (this.notice) {
      const status = document.createElement('span'); status.dataset.workspaceStatus = '';
      status.setAttribute('role', 'status'); status.textContent = this.notice;
      this.destinations.append(status);
      if (this.notice.startsWith('Workspaces unavailable')) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry';
        retry.addEventListener('click', () => this.refresh()); this.destinations.append(retry);
      }
    }
  }

  /** Share only currently represented workspaces; retraction restores the default sidebar immediately. */
  publishSidebarDestinations(curated) {
    const names = this.layout === 'workspaces' ? workspaceSidebarNames(curated) : [];
    const key = names.join('|');
    if (key === this.sidebarDestinations) return;
    this.sidebarDestinations = key;
    window.dispatchEvent(new CustomEvent(WORKSPACE_DESTINATIONS_EVENT, { detail: names }));
  }

  moreMenu(active, curated) {
    const more = document.createElement('details'); more.id = 'workspaceNavigationMore';
    more.addEventListener('toggle', () => this.positionMore());
    const summary = document.createElement('summary');
    const extras = this.items.filter(item => !curated.includes(item));
    summary.textContent = 'More';
    const body = document.createElement('div'); body.className = 'workspace-navigation-more';
    const links = document.createElement('div'); links.className = 'workspace-navigation-more-links';
    for (const item of extras) links.append(workspaceLink(item, active));
    if (!document.getElementById('cockpitHomeLink')) {
      const all = document.createElement('a'); all.href = '/cockpit/'; all.textContent = 'All applications';
      all.dataset.workspaceAll = ''; links.append(all);
    }
    body.append(links);
    if (this.utilities) {
      const enabled = this.layout === 'workspaces';
      (enabled ? body : this.utilitiesHome).append(this.utilities);
      if (this.headerOptions) { this.headerOptions.open = false; this.headerOptions.hidden = enabled; }
    }
    more.append(summary, body); return more;
  }

  /** Align to the same trigger's right edge only when a left-aligned list would leave the viewport. */
  positionMore() {
    const more = this.rail?.querySelector('details[open]');
    if (!more) return;
    const trigger = more.querySelector('summary').getBoundingClientRect();
    const menu = more.querySelector('.workspace-navigation-more');
    more.toggleAttribute('data-align-end', trigger.left + menu.offsetWidth > window.innerWidth - 12);
  }

  /** Release only this overlay's resources; active app content belongs to the existing controller. */
  destroy() {
    this.generation += 1; this.abort?.abort();
    this.publishSidebarDestinations([]);
    this.resizeObserver?.disconnect();
    this.cleanups.forEach(remove => remove());
    if (this.utilitiesHome) this.utilitiesHome.append(this.utilities);
    if (this.headerOptions) this.headerOptions.hidden = false;
    this.control?.remove(); this.rail?.remove();
  }
}
