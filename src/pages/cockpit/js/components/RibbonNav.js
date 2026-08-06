/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial cockpit ribbon navigation with Codicon icons
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | UI profile overlay — filter/order hardcoded + dynamic items via /api/ui/profile, with ?profile=<name> dev toggle
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Accept both ?app= and ?profile= as focus-mode URL override (contract doc uses ?app=)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | App ribbon items now render as in-page iframe tool views, not full-page navigations. Sync initial content area with profile.defaultView.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Generic iframe→ribbon message contract (app-navigate / app-tools-changed) with the legacy LM literals mapped onto it — the carve-out deleted the LM-specific bridge, silently no-op'ing every in-page navigation in the packaged app (My Day "Record Lecture", dashboard quick-actions, class tiles). Packaged surfaces can only reach the shell via postMessage, so core speaks a generic dialect.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Bridge: map lm-navigate 'class-<full-uuid>' onto the 8-char dynamic-button prefix (class tiles never matched a button — broken since before the carve-out), and WARN when a navigation targets a button the ribbon doesn't have — the silent no-op is what kept this invisible.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Platform tools: add 'tool-global-search' (Search) — the caller-scoped global search surface (/api/search/ui) rides along on every cockpit like Optimizer/Workflow Studio, since search over the caller's own data isn't owned by any one app.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Platform tools: add 'tool-run-trace' (Run Trace) — the caller-scoped run-trace waterfall surface (/api/trace/app) rides along on every cockpit, since tracing a ticket's execution timeline isn't owned by any one app.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Platform tools: add the four read surfaces for the shared platform services that shipped headless — Budgets (enforced spend caps), Notifications (per-topic routing prefs), Dead Letters (queue quarantine, operator-only), and My Data (export/delete). They are static pages under src/pages/cockpit/tools/, so they need no Express route. Added _loadOperatorState() (GET /api/cli-tokens/whoami) so the operator-only Dead Letters entry is not pinned into a basic user's rail — the routes self-gate server-side regardless, this only avoids offering a tool that can only answer 403.
 */

import { createUiLogger } from '../../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-ribbon-nav');

const PROFILE_LS_KEY = 'oshal-ui-profile';

/** Framework default ribbon items — used when no profile file exists. */
const HARDCODED_VIEWS = [
  { id: 'tickets',    icon: 'codicon codicon-tag',                 label: 'Tickets',      section: 'top' },
  { id: 'forge',      icon: 'codicon codicon-tools',               label: 'Bot Forge',    section: 'top' },
  { id: 'chat',       icon: 'codicon codicon-comment-discussion',  label: 'Chat',         section: 'top' },
  { id: 'calendar',   icon: 'codicon codicon-calendar',            label: 'Calendar',     section: 'top' },
  { id: 'addressbook',icon: 'codicon codicon-organization',        label: 'Address Book', section: 'top' },
  { id: 'dashboard',  icon: 'codicon codicon-graph-line',          label: 'Dashboard',    section: 'top' },
  { id: 'logs',       icon: 'codicon codicon-output',              label: 'Logs',         section: 'bottom' },
  { id: 'settings',   icon: 'codicon codicon-gear',                label: 'Settings',     section: 'bottom' },
  { id: 'operations', icon: 'codicon codicon-pulse',               label: 'Operations',   section: 'bottom' },
  { id: 'connectors', icon: 'codicon codicon-plug',                label: 'Connectors',   section: 'bottom' },
];

const PINNED_PLATFORM_VIEW_IDS = ['operations', 'connectors'];

/** The single rail entry that a focused app shows in place of the platform tool set. */
export const PLATFORM_HUB_ID = 'tool-platform-hub';

/**
 * @description Decide which views make up the pinned-settings tray at the foot of the rail.
 *
 * Pure and exported so it can be unit-tested against real view shapes. The duplicate-Settings
 * bug this guards lived in three lines of inline filtering inside render(), where nothing could
 * reach it: the hub is already a member of `views` (that is how it stays navigable when withheld
 * from the rail), so re-pushing it to force it last produced a second identical button.
 *
 * @param {Array<object>} views - All registered views.
 * @param {object} opts - Options.
 * @param {boolean} opts.studentMode - Kiosk rail: no settings tray at all.
 * @param {boolean} opts.hidePlatformChrome - Focused app: collapse platform tools behind the hub.
 * @returns {Array<object>} The tray's views, in render order, with no duplicates.
 */
export function computeBottomTray(views, opts) {
  const { studentMode = false, hidePlatformChrome = false } = opts || {};
  if (studentMode) return [];
  const bottom = views.filter(v => v.section === 'bottom');
  if (!hidePlatformChrome) return bottom;
  // Platform tools and the framework Settings entry leave the rail; the hub replaces them and is
  // appended last, so it sits below the app's own bottom items rather than among them.
  const kept = bottom.filter(
    v => !v.platformTool && v.id !== 'settings' && v.id !== PLATFORM_HUB_ID,
  );
  const hub = views.find(v => v.id === PLATFORM_HUB_ID);
  return hub ? [...kept, hub] : kept;
}

/** Resolve active profile name from URL ?app= or ?profile= only.
 *
 * Previous versions cached the URL choice in localStorage so that a plain
 * /cockpit/ reload would re-apply the same app shape. That made the URL
 * non-authoritative: visiting ?app=little-monsters once poisoned every
 * subsequent /cockpit/ visit with the LM ribbon shape, even after LM was
 * deactivated. URL is now the single source of truth — no URL means
 * framework-default cockpit (Tickets / Chat / Calendar / Dashboard / etc.).
 * Bookmark the URL with the app param if you want it to stick.
 */
function resolveRequestedProfileName() {
  try {
    const params = new URLSearchParams(window.location.search);
    const urlName = params.get('app') || params.get('profile');
    if (urlName) return urlName;
    // Clear any legacy cached value from earlier builds so old localStorage
    // entries don't keep resurrecting LM (or other inactive apps) after a
    // page reload.
    window.localStorage.removeItem(PROFILE_LS_KEY);
    return null;
  } catch {
    return null;
  }
}

/**
 * Student/kiosk mode: a stripped-down ribbon for a focused app (e.g. Little
 * Monsters) that shows ONLY the app's own student-facing screens and hides all
 * operator chrome — the bottom platform tray (Settings, Operations, Connectors,
 * Optimizer, Workflow Studio) and any `section: bottom` tools (Teacher, Voice
 * Settings). Triggered by `?student=1` / `?kiosk=1` / `?view=student` alongside
 * `?app=<name>`. The plain `?app=<name>` view keeps full operator chrome, so this
 * is purely additive — a separate, child-safe entry point, not a replacement.
 */
function resolveStudentMode() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('student') === '1'
      || params.get('kiosk') === '1'
      || params.get('view') === 'student';
  } catch {
    return false;
  }
}

/** Convert a glob like `lm-class-*` to a RegExp matcher. */
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Does `name` match any glob in `patterns`? */
function matchesAnyGlob(name, patterns) {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some(p => globToRegex(p).test(name));
}

/**
 * @description Renders the cockpit's left-edge ribbon navigation, blending
 * framework-default views with profile-driven filtering/ordering and
 * self-registered tool UIs, and notifies the cockpit shell when the user
 * switches the active view.
 */
export class RibbonNav {
  /**
   * @description Resolves the host container, stores the view-change callback,
   * and kicks off asynchronous initialisation (profile fetch, render, tool load).
   * @param {string|HTMLElement} container - Element or element id that hosts the ribbon markup.
   * @param {(viewId: string) => void} onViewChange - Called whenever the active view changes (including the initial non-default view).
   */
  constructor(container, onViewChange) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.onViewChange = onViewChange;
    this.profile = null;
    this.views = [];
    this.activeView = null;
    // Child-safe student/kiosk rail — hides the bottom platform tray + operator tools.
    this.studentMode = resolveStudentMode();
    // Expose init as a promise so the cockpit shell can wait for the profile
    // (e.g. to preselect the focused app's chat bot) without racing the fetch.
    this.ready = this._init();
    // Generic iframe→ribbon message contract (ADR-085): an embedded app surface may ask
    // the ribbon to navigate or to re-resolve its dynamic tools — packaged apps have no
    // other path to the shell. Accepted shapes:
    //   {type:'app-navigate', tool:'<toolName>'}   → activate ribbon item tool-<toolName>
    //   {type:'app-tools-changed', prefix:'<p>'}   → drop views with id prefix tool-<p>, re-resolve
    // The legacy Little Monsters literals its installed surfaces still send map onto the
    // same paths. Navigation only lands on a button the caller's profile actually
    // rendered — nothing here grants a surface that wasn't already admitted.
    window.addEventListener('message', (e) => {
      const d = e && e.data;
      if (d === 'lm-classes-changed') { this._reloadDynamicTools('tool-lm-class-'); return; }
      if (!d || typeof d !== 'object') return;
      // The platform hub asks for the tools it should offer. Answering with the REGISTERED views
      // (not a hardcoded list in the page) is what keeps the hub from drifting as tools are added
      // or gated — a tool an operator may not have is never sent, so it can never be offered.
      if (d.type === 'platform-hub-ready') {
        const src = e.source;
        if (src) {
          src.postMessage({
            type: 'platform-hub-tools',
            tools: this.views
              .filter(v => v.platformTool || v.id === 'settings')
              .map(v => ({ id: v.id, label: v.label, icon: v.icon })),
          }, '*');
        }
        return;
      }
      let id = null;
      if (d.type === 'app-navigate' && d.tool) id = 'tool-' + String(d.tool);
      // `view` addresses a view by its own id, so the hub can reach a tool that is registered but
      // deliberately not on the rail. Resolved against this.views — the admitted set — so this
      // still cannot grant a surface the profile never admitted.
      else if (d.type === 'app-navigate' && d.view) {
        const want = String(d.view);
        if (this.views.find(v => v.id === want)) { this.setActive(want); return; }
        logger.warn('Bridge navigation target not registered — ignored', { target: want });
        return;
      }
      else if (d.type === 'app-tools-changed' && d.prefix) { this._reloadDynamicTools('tool-' + String(d.prefix)); return; }
      else if (d.type === 'lm-navigate' && d.view) {
        const view = String(d.view);
        // 'class-<uuid>' carries the FULL class id, but the dynamic ribbon buttons are
        // named with the manifest's {class_id_prefix} (first 8 chars) — map it down,
        // matching the lm-open-class shape. Without this, class tiles no-op.
        id = view.startsWith('class-')
          ? 'tool-lm-class-' + view.slice('class-'.length, 'class-'.length + 8)
          : 'tool-lm-' + view;
      }
      else if (d.type === 'lm-open-class' && d.classId) id = 'tool-lm-class-' + String(d.classId).substring(0, 8);
      if (!id) return;
      if (this.container && this.container.querySelector(`.ribbon-btn[data-view="${CSS.escape(id)}"]`)) {
        this.setActive(id);
      } else {
        // A silent no-op here is how broken in-app navigation hides for months —
        // surface the miss so the sending page (or a missing ribbon tool) gets fixed.
        logger.warn('Bridge navigation target not in ribbon — ignored', { target: id, messageType: d.type });
      }
    });
  }

  /**
   * @description Drop the dynamically-loaded tool views whose ids start with `prefix`
   * and re-resolve dynamic tools, so an embedded app can refresh its rail icons (e.g.
   * per-class tools after a join/leave) without a full cockpit reload.
   * @param {string} prefix - view-id prefix to drop before re-resolving (e.g. 'tool-lm-class-')
   * @returns {Promise<void>}
   */
  async _reloadDynamicTools(prefix) {
    this.views = this.views.filter((v) => !String(v.id || '').startsWith(prefix));
    this.render();
    await this._loadToolViews();
  }

  async _init() {
    await this._loadGuestState();
    await this._loadOperatorState();
    this.profile = await this._fetchProfile();
    this._applyAppBranding();
    this.activeView = this.profile?.defaultView || 'tickets';
    this.views = this._buildFrameworkViews();
    this._appendPlatformTools();

    // Platform chrome is OPT-IN for a focused app, opt-out for the operator cockpit. An app that
    // genuinely wants the operator tools on its rail says so with `ribbon.showPlatformTools: true`;
    // it is deliberately an explicit opt-in, because the previous default shipped a dozen operator
    // tools to every customer's staff and no manifest key could decline them.
    this.hidePlatformChrome = !!resolveRequestedProfileName()
      && this.profile?.ribbon?.showPlatformTools !== true
      && !this.studentMode;
    if (this.hidePlatformChrome) this._appendPlatformHub();

    logger.info('Ribbon initialised with profile', {
      profile: this.profile?.name,
      defaultView: this.activeView,
      viewCount: this.views.length,
      hidePlatformChrome: this.hidePlatformChrome,
    });
    this.render();
    this._loadToolViews();
  }

  /**
   * When a swarm app is focused (?app=<name>), rebrand the cockpit shell to the
   * app's displayName so the header + browser tab read "Little Monsters" instead
   * of the framework default "OSHAL Cockpit". The global /api/branding script
   * in index.html deliberately skips its own title/logo write when ?app= is
   * present, so this is the single source of truth for focused-app branding.
   */
  _applyAppBranding() {
    const requested = resolveRequestedProfileName();
    const displayName = this.profile?.displayName;
    if (!requested || !displayName) return;
    try {
      document.title = displayName;
      const logo = document.querySelector('.logo-text');
      if (logo) logo.textContent = displayName;
    } catch (err) {
      logger.warn('Failed to apply focused-app branding', { error: err?.message });
    }
  }

  /**
   * @description Resolves whether the current session is a guest and, if so, which
   * app segments are blocked (Tier C). Drives the ribbon graying. Falls back to a
   * non-guest (everything-enabled) view on any error.
   * @returns {Promise<void>}
   */
  async _loadGuestState() {
    this.guestMode = false;
    this.guestCaps = null;
    this.guestBlocked = new Set(); // Tier C
    this.guestTierA = new Set(); // fully interactive
    try {
      const res = await fetch('/api/auth/user');
      if (!res.ok) return;
      const data = await res.json();
      if (data?.guestMode && data?.capabilities) {
        this.guestMode = true;
        this.guestCaps = data.capabilities;
        this.guestBlocked = new Set(data.capabilities.blockedApps || []);
        this.guestTierA = new Set(data.capabilities.tierA || []);
      }
    } catch (err) {
      logger.debug('Could not resolve guest state (non-fatal)', { error: err?.message });
    }
  }

  /**
   * @description Resolves whether the signed-in caller is on the operator allowlist, so the
   * ribbon does not pin an operator-only tool (Dead Letters) into a basic user's rail where
   * every click can only answer 403. `/api/cli-tokens/whoami` is the existing identity probe
   * that already reports the operator flag. This is COSMETIC only — all three DLQ routes are
   * requiresAuth + requiresOperator server-side, and the surface itself renders an honest
   * "operator only" panel on a 403, so a wrong answer here leaks nothing. Fails closed
   * (non-operator) on any error, because pinning a dead tool is worse than omitting one.
   * @returns {Promise<void>}
   */
  async _loadOperatorState() {
    this.isOperator = false;
    try {
      const res = await fetch('/api/cli-tokens/whoami', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      this.isOperator = data?.operator === true;
    } catch (err) {
      logger.debug('Could not resolve operator state (non-fatal, treated as non-operator)', { error: err?.message });
    }
  }

  /** Map a ribbon view to its `/api/<app>` segment for guest-tier lookup. */
  _viewAppSegment(view) {
    const url = view?.toolUi?.iframeUrl;
    if (url) {
      const parts = String(url).split('/').filter(Boolean);
      if (parts.length) return parts[0] === 'api' ? (parts[1] || '') : parts[0];
    }
    let id = String(view?.id || '');
    if (id.startsWith('tool-')) id = id.slice(5);
    return id;
  }

  /** True when a view is blocked for the current guest (Tier C). */
  _isGuestBlocked(view) {
    if (!this.guestMode || !this.guestBlocked?.size) return false;
    return this.guestBlocked.has(this._viewAppSegment(view));
  }

  /**
   * @description Guest tier for a view: 'C' (blocked), 'A' (full write), or 'B'
   * (open but read-only — the default). Returns null when not a guest. Used by the
   * view controller to decide whether to apply the read-only surface treatment.
   * @returns {'A'|'B'|'C'|null}
   */
  guestTierForView(view) {
    if (!this.guestMode) return null;
    const seg = this._viewAppSegment(view);
    if (this.guestBlocked.has(seg)) return 'C';
    if (this.guestTierA.has(seg)) return 'A';
    return 'B';
  }

  /** Guest notation string for a view's app, if any (e.g. rides "really books"). */
  guestNotationForView(view) {
    if (!this.guestMode || !this.guestCaps?.notations) return null;
    return this.guestCaps.notations[this._viewAppSegment(view)] || null;
  }

  /** Fetch active profile; on failure fall back to everything-visible. */
  async _fetchProfile() {
    try {
      const requested = resolveRequestedProfileName();
      const url = requested ? `/api/ui/profile?name=${encodeURIComponent(requested)}` : '/api/ui/profile';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.profile;
    } catch (err) {
      logger.warn('Failed to fetch UI profile; rendering full framework ribbon', { error: err?.message });
      return {
        name: 'framework-fallback',
        ribbon: { items: HARDCODED_VIEWS.map(v => v.id), dynamicTools: { allow: ['*'] } },
        defaultView: 'tickets',
      };
    }
  }

  /**
   * @description Appends always-available PLATFORM tools (not owned by any one app) to EVERY cockpit —
   * the framework default AND focused apps (?app=…) — so the optimizer rides along on all of them
   * without each manifest having to declare it. Deduped by id, so if a profile already declares the
   * tool this is a no-op. Optimizer = the Token Chase capture + playback optimizer (replay a captured
   * LLM call against the user's own configured providers; ADR-046). Embedded as an iframe tool view
   * via toolUi.iframeUrl — the `tool-` id prefix routes it to renderToolView.
   *
   * Four of these (Budgets, Notifications, My Data, Dead Letters) point at static pages under
   * `src/pages/cockpit/tools/`, which the cockpit's own authenticated express.static mount already
   * serves at `/cockpit/tools/<name>.html` — they need no Express route of their own. Dead Letters
   * is appended only for an operator (see {@link RibbonNav#_loadOperatorState}).
   * @returns {void}
   */
  _appendPlatformTools() {
    // Everything this adds is PLATFORM chrome, not the app's. Tag it all so the rail can collapse
    // it behind one entry for a focused app. Tagging by diffing the view list rather than at each
    // push site: there are a dozen of those, and one missed tag is a tool that leaks back onto a
    // customer's rail — the exact failure this whole change exists to stop.
    const before = this.views.length;
    this._appendPlatformToolsInner();
    for (let i = before; i < this.views.length; i++) this.views[i].platformTool = true;
  }

  /**
   * @description Register the single "Settings" rail entry a focused app shows in place of the
   * platform tool set. The tools it fronts stay REGISTERED as views — they are only withheld from
   * the rail — so deep links and the iframe navigate bridge keep working and nothing is lost.
   *
   * A static page under `src/pages/cockpit/tools/`, like the four platform tools that already ship
   * that way, so it needs no Express route.
   * @returns {void}
   */
  _appendPlatformHub() {
    if (this.views.find(v => v.id === PLATFORM_HUB_ID)) return;
    this.views.push({
      id: PLATFORM_HUB_ID,
      icon: 'codicon codicon-gear',
      label: 'Settings',
      section: 'bottom',
      toolUi: { iframeUrl: '/cockpit/tools/platform.html' },
    });
  }

  /**
   * @description The platform-tool list itself. Called only via {@link RibbonNav#_appendPlatformTools},
   * which tags everything this appends.
   * @returns {void}
   */
  _appendPlatformToolsInner() {
    // Student/kiosk rail: no operator platform chrome (Operations, Connectors,
    // Optimizer, Workflow Studio). Leave the rail to the app's own screens only.
    if (this.studentMode) return;
    // An app that declares its connector needs (profile.connectors, from manifest
    // dependencies.connectors) with an EMPTY list gets no pinned Connectors item —
    // a kids' education app must not surface the Facebook/LinkedIn catalog. A
    // non-empty list keeps the pin (the marketplace view filters to it); an app
    // profile that already declares its own 'connectors' item still wins via dedup.
    const connectorsAllowed = !Array.isArray(this.profile?.connectors) || this.profile.connectors.length > 0;
    const byId = new Map(HARDCODED_VIEWS.map(v => [v.id, v]));
    for (const id of PINNED_PLATFORM_VIEW_IDS) {
      if (id === 'connectors' && !connectorsAllowed) continue;
      const view = byId.get(id);
      if (view && !this.views.find(v => v.id === id)) {
        this.views.push({ ...view, section: 'bottom' });
      }
    }

    const PLATFORM_TOOLS = [
      {
        id: 'tool-token-chase',
        icon: 'codicon codicon-rocket',
        label: 'Optimizer',
        section: 'bottom',
        // First-party Token Chase optimizer: replay captured calls against the caller's configured
        // providers, with cost/latency/accuracy diffs and framework logs. The old external
        // optimize.agenticfederal.us embed made failures opaque and detached from OSHAL auth.
        toolUi: { iframeUrl: '/api/token-chase/ui', sidebarLabel: 'Optimizer' },
      },
      {
        id: 'tool-workflow-studio',
        icon: 'codicon codicon-type-hierarchy-sub',
        label: 'Workflow Studio',
        section: 'bottom',
        // Talk-to-build workflow authoring (ADR-039): describe a process in words/voice and the
        // reason-only builder bot draws the graph live; publish it as a deterministic ticket-type
        // queue. Embedded as an iframe tool view (the `tool-` id prefix routes it to renderToolView).
        toolUi: { iframeUrl: '/workflow-studio/', sidebarLabel: 'Workflow Studio' },
      },
      {
        id: 'tool-global-search',
        icon: 'codicon codicon-search',
        label: 'Search',
        section: 'bottom',
        // Global search across the caller's own swarm data (tickets / chat / personal vault / RAG) —
        // served by global-search-routes.ts; iframe tool view (the `tool-` id prefix routes it to renderToolView).
        toolUi: { iframeUrl: '/api/search/ui', sidebarLabel: 'Search' },
      },
      {
        id: 'tool-run-trace',
        icon: 'codicon codicon-graph-scatter',
        label: 'Run Trace',
        section: 'bottom',
        // Read-model waterfall for one ticket (phases -> bot executions -> per-LLM-call cost),
        // assembled from persisted rows and caller-scoped by owner_sub — served by trace-routes.ts.
        toolUi: { iframeUrl: '/api/trace/app', sidebarLabel: 'Run Trace' },
      },
      {
        id: 'tool-budgets',
        icon: 'codicon codicon-dashboard',
        label: 'Budgets',
        section: 'bottom',
        // Read surface over /api/budgets: the spend caps the platform actually ENFORCES
        // (oshal_budgets, checked pre-dispatch) with their trailing-window spend. Operators see
        // every scope plus the enforcement trail; a basic user sees only their own cap. Static
        // page under src/pages/cockpit/tools/ — served by the cockpit's own express.static mount.
        toolUi: { iframeUrl: '/cockpit/tools/budgets.html', sidebarLabel: 'Budgets' },
      },
      {
        id: 'tool-notify',
        icon: 'codicon codicon-bell',
        label: 'Notifications',
        section: 'bottom',
        // Self-scoped notification preference center (/api/notify/prefs): per-topic channel,
        // quiet window, and destination, plus a confirm-gated real test send that reports the
        // router's actual outcome rather than an unconditional success.
        toolUi: { iframeUrl: '/cockpit/tools/notify.html', sidebarLabel: 'Notifications' },
      },
      {
        id: 'tool-my-data',
        icon: 'codicon codicon-archive',
        label: 'My Data',
        section: 'bottom',
        // The self-service data-lifecycle surface (/api/me): export your bundle, and run the
        // two-step delete (request a plan + token, then confirm) with the per-store outcomes and
        // the declared coverage gaps shown honestly.
        toolUi: { iframeUrl: '/cockpit/tools/my-data.html', sidebarLabel: 'My Data' },
      },
    ];

    // Dead letters is operator-only at every one of its three routes, so it is only pinned for an
    // operator. The surface still self-gates (it renders an "operator only" panel on a 403) —
    // this keeps a basic user's rail free of a tool that could never answer.
    if (this.isOperator) {
      PLATFORM_TOOLS.push({
        id: 'tool-dlq',
        icon: 'codicon codicon-warning',
        label: 'Dead Letters',
        section: 'bottom',
        // Operator view of oshal_queue_dlq (ADR queue dead-letter rails): the quarantine table,
        // the JSON export, and per-ticket requeue with each distinct failure surfaced separately.
        toolUi: { iframeUrl: '/cockpit/tools/dlq.html', sidebarLabel: 'Dead Letters' },
      });
    }

    for (const tool of PLATFORM_TOOLS) {
      if (!this.views.find(v => v.id === tool.id)) this.views.push(tool);
    }
  }

  /** Apply profile.ribbon.items to the hardcoded view list — filter, reorder, and splice in ad-hoc items. */
  _buildFrameworkViews() {
    const byId = new Map(HARDCODED_VIEWS.map(v => [v.id, v]));
    const items = this.profile?.ribbon?.items ?? [];
    const resolved = [];
    for (const item of items) {
      if (typeof item === 'string') {
        const found = byId.get(item);
        if (found) resolved.push({ ...found });
        else logger.warn('Profile references unknown hardcoded view id', { id: item });
      } else if (item && typeof item === 'object' && item.id) {
        // Preserve toolUi so the cockpit view controller can render an
        // iframe in the content area — never a full-page nav. `group` only
        // applies to scrollable `top` items; `home`/`bottom` are pinned trays.
        const section = item.section === 'bottom' ? 'bottom'
          : item.section === 'home' ? 'home'
          : 'top';
        resolved.push({
          id: item.id,
          icon: item.icon || 'codicon codicon-circle-outline',
          label: item.label || item.id,
          section,
          group: section === 'top' ? (item.group || '') : '',
          toolUi: item.toolUi || null,
        });
      }
    }
    return resolved;
  }

  /**
   * @description Fetches registered tools (DB + dynamic) and appends those
   * whose names match the active profile's `dynamicTools.allow` patterns.
   * Exact operators may register ephemeral UI surfaces through POST /api/tools/register;
   * application manifests use the in-process loader. A fleet service secret alone cannot
   * register or replace a ribbon because it does not establish bot ownership.
   */
  async _loadToolViews() {
    try {
      const [dbRes, dynRes] = await Promise.all([
        fetch('/api/tools').catch(() => null),
        fetch('/api/tools/dynamic').catch(() => null),
      ]);

      const dbTools = dbRes?.ok ? await dbRes.json().then(d => d.tools || d.data || []) : [];
      const dynTools = dynRes?.ok ? await dynRes.json().then(d => d.tools || []) : [];

      const normalizedDynamic = dynTools
        .filter(t => !t.expired && t.ui)
        .map(t => ({ name: t.toolName, displayName: t.toolName, enabled: true, ui: t.ui }));

      const allowPatterns = this.profile?.ribbon?.dynamicTools?.allow ?? [];
      const sectionOverride = this.profile?.ribbon?.dynamicTools?.section || null;
      const groupOverride = this.profile?.ribbon?.dynamicTools?.group || '';

      // (The Little Monsters per-class enrollment filter left with the LM carve-out,
      //  ADR-085. Per-user visibility of an app's dynamic tools should return as a
      //  GENERIC manifest-declared hook, not an app-specific fetch here.)
      const candidates = [...normalizedDynamic, ...dbTools];

      const seen = new Set();
      const admitted = [];
      for (const t of candidates) {
        if (!t.enabled || !t.ui || seen.has(t.name)) continue;
        if (!matchesAnyGlob(t.name, allowPatterns)) continue;
        seen.add(t.name);
        admitted.push(t);
      }

      if (admitted.length === 0) return;

      for (const tool of admitted) {
        const viewId = `tool-${tool.name}`;
        if (this.views.find(v => v.id === viewId)) continue;
        const section = sectionOverride || tool.ui.sidebarSection || 'top';
        this.views.push({
          id: viewId,
          icon: tool.ui.sidebarIcon || 'codicon codicon-extensions',
          label: tool.ui.sidebarLabel || tool.displayName,
          section,
          // Group dynamic tools (e.g. Little Monsters per-class icons) under the
          // profile's declared group header instead of the ungrouped lead band.
          group: section === 'top' ? (groupOverride || tool.ui.sidebarGroup || '') : '',
          toolUi: tool.ui,
        });
      }
      logger.info('Loaded tool UI views into ribbon', { count: admitted.length, profile: this.profile?.name });
      this.render();
    } catch (err) {
      logger.debug('Failed to load tool UI views (non-fatal)', { error: err?.message });
    }
  }


  /**
   * @description Rebuilds the ribbon's DOM from the current view list, splitting
   * items into top/bottom sections and wiring click handlers that switch views.
   * @returns {void}
   */
  render() {
    if (!this.container) return;
    logger.debug('Rendering cockpit ribbon navigation', { activeView: this.activeView, profile: this.profile?.name });
    // Three trays: `home` pinned at the top (the front-door surface, e.g. Jarvis),
    // `top` flows into the scrollable middle (grouped), `bottom` pinned at the base
    // (the always-there essentials: tickets / calendar / messages / settings).
    // In student/kiosk mode the entire bottom tray is hidden — Settings, the
    // pinned platform tools, and any `section: bottom` app tools (Teacher, Voice
    // Settings) — leaving only the app's own top-rail student screens.
    const homeViews = this.views.filter(v => v.section === 'home');
    const topViews = this.views.filter(v => v.section !== 'home' && v.section !== 'bottom');
    // A FOCUSED app (?app=<name>) shows the app's own screens plus ONE door to everything else.
    // Previously the platform appended its whole tool set to every cockpit — Optimizer, Workflow
    // Studio, Run Trace, Dead Letters, Budgets — on top of whatever the app declared, and a
    // manifest had no way to decline: `hideFrameworkItems` only reaches the hardcoded framework
    // views, never the appended ones. A customer's staff opened the product they were sold and
    // found a dozen operator tools, most of which answer 403 to them. That is what "it is not
    // usable or configurable" meant, and it is a positioning failure, not a layout one.
    //
    // The plain /cockpit/ (no ?app=) is the OPERATOR view and keeps the full dense rail.
    const bottomViews = computeBottomTray(this.views, {
      studentMode: this.studentMode,
      hidePlatformChrome: this.hidePlatformChrome,
    });

    this.container.innerHTML = `
      <nav class="ribbon-nav" id="ribbonNavInner">
        ${homeViews.length ? `<div class="ribbon-home">${homeViews.map(v => this._btn(v)).join('')}</div>` : ''}
        <div class="ribbon-scroll">
          ${this._renderGroups(topViews)}
          ${bottomViews.length ? `<div class="ribbon-bottom">${bottomViews.map(v => this._btn(v)).join('')}</div>` : ''}
        </div>
      </nav>
    `;

    this.container.querySelectorAll('.ribbon-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('guest-disabled')) return; // Tier-C app, blocked for guests
        this.setActive(btn.dataset.view);
      });
    });
  }

  /**
   * @description Renders the scrollable middle tray, splitting `top` views into
   * groups by their `group` label (order preserved by first appearance). Items
   * with no group render first under no header; each named group gets a small
   * header that fades in when the rail is hover-expanded and shows as a thin
   * divider when collapsed.
   * @param {Array<{id:string,group?:string}>} topViews - the scrollable items.
   * @returns {string} HTML for the grouped middle tray.
   */
  _renderGroups(topViews) {
    const order = [];
    const byGroup = new Map();
    for (const v of topViews) {
      const g = v.group || '';
      if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
      byGroup.get(g).push(v);
    }
    return order.map(g => {
      const header = g ? `<div class="ribbon-group-label" title="${g}">${g}</div>` : '';
      return header + byGroup.get(g).map(v => this._btn(v)).join('');
    }).join('');
  }

  _btn(view) {
    const active = view.id === this.activeView ? ' active' : '';
    const blocked = this._isGuestBlocked(view);
    const cls = `ribbon-btn${active}${blocked ? ' guest-disabled' : ''}`;
    const title = blocked ? `${view.label} — not available in guest mode` : view.label;
    const style = blocked ? ' style="opacity:.35;cursor:not-allowed;" aria-disabled="true"' : '';
    return `
      <button class="${cls}" data-view="${view.id}"${style} title="${title}">
        <i class="${blocked ? 'codicon codicon-lock' : view.icon}"></i>
        <span class="ribbon-label">${view.label}</span>
      </button>`;
  }

  /**
   * @description Makes the given view the active one (no-op if already active),
   * updates button highlighting in place, and notifies the cockpit shell.
   * @param {string} viewId - Identifier of the view/button to activate.
   * @returns {void}
   */
  setActive(viewId, options = {}) {
    if (this.activeView === viewId) return;
    logger.info('Switching cockpit ribbon view', { from: this.activeView, to: viewId });
    this.activeView = viewId;
    this.container.querySelectorAll('.ribbon-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewId);
    });
    if (options.notify === false) return;
    if (this.onViewChange) this.onViewChange(viewId);
  }

  /**
   * @description Returns the identifier of the currently active ribbon view.
   * @returns {string|null} The active view id, or null before initialisation.
   */
  getActive() {
    return this.activeView;
  }

  /** Set badge count on a ribbon button. */
  setBadge(viewId, count) {
    const btn = this.container.querySelector(`.ribbon-btn[data-view="${viewId}"]`);
    if (!btn) return;
    logger.debug('Updating cockpit ribbon badge', { viewId, count });
    let badge = btn.querySelector('.ribbon-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'ribbon-badge';
        btn.appendChild(badge);
      }
      badge.textContent = count > 99 ? '99+' : count;
    } else if (badge) {
      badge.remove();
    }
  }
}
