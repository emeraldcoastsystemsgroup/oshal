/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Migrated cockpit UI to modal-based top-right icons, removed ribbon/dashboard
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Restored full CockpitApp class, integrated backend API for RAG, Presentron, Login, History, Settings modals via ModalManager
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Restored full 3-column layout with RibbonNav, all 7 views, inline modals, resize handle, chat panel toggle, RAG widget, mesh chat
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Defaulted cockpit to collapsed chat on cold start for image parity; preserved expand/collapse + theme behavior
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Passed toast callbacks into the cockpit settings view for Session 69 bot-tool stabilization
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Extracted right-rail chat task/session behavior into CockpitChatPanelController for Session 74 cockpit chat consolidation
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Switched the cockpit right rail to an embedded native /chat workspace so the panel exposes the real OSHAL chat surface instead of a placeholder shell
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added selected-bot context sync from cockpit into the embedded native chat workspace
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added cockpit-side workspace action buttons so key chat controls are directly reachable from the right rail
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Switched the cockpit bot selector to persisted agent UUIDs so embedded chat/settings/config flows target real bots instead of legacy name aliases
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Awaited bot-selector hydration before restoring the embedded rail so cockpit boots the native chat workspace against a real bot instead of the legacy assistant placeholder
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Routed cockpit settings action to top-level bot-scoped /config navigation and kept other workspace actions in-rail
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Restored in-rail settings action, deduped bot selector IDs, and persisted selected bot identity across cockpit reloads
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log attribution for governance compliance during engineering-screen retrofit work
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Removed the dead header search shortcut during the header-audit pass so cockpit only advertises working top-bar controls
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Routed the cockpit header knowledge button into the embedded swarm workspace so cockpit reuses the shared RAG flow
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Routed the cockpit header Presentron action into the embedded shared studio so cockpit no longer owns a separate presentation modal
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Aligned cockpit header RAG and Presentron handlers so both reveal the right rail before opening shared workspaces
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Persisted header quick settings, clarified the gear action as Quick Settings, and hardened header history/theme feedback flows
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | The right-rail chat panel starts collapsed on every viewport (operator directive 2026-08-13). Desktop auto-opened whenever restoreSession() found a live task, so a days-old thread reopened the rail on each load and covered the surface the operator navigated to; Jarvis and the app-embedded concierges are the paths in normal use. Explicit chat actions still open it, so nothing became unreachable.
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Apply the focused app's declarative global-assistant visibility policy independent of script load order.
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Added cockpit workspace-focus mode so header RAG and Presentron launches can expand the embedded bot workspace instead of using the cramped default rail width
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Added a persistent workspace-focus width toggle so operators can widen heavy tool surfaces on demand
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Added draggable workspace-focus resizing and folded heavy-tool stage defaults into Quick Settings
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Simplified the header to global tools plus profile access by removing duplicate settings/history actions
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | Switched cockpit shell view imports to the views barrel to align the directory with FSD barrel-export governance
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | Extracted workspace-focus and cockpit-persistence helpers out of app.js so the shell controller returns under the file-governance cap
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | Fixed shared resize-handle logic so the right rail owns the explicit width while main content reclaims remaining space without leaving dead layout gaps
 * 28 | maintainer@emeraldcoastsystemsgroup.com   | Wired calendar ticket drill-ins into the ticket workbench and carried pending ticket selection across view switches
 * 29 | maintainer@emeraldcoastsystemsgroup.com   | Switched cockpit bot selector hydration to the live swarm registry so dead persisted profiles do not appear in the active chat lane
 * 30 | maintainer@emeraldcoastsystemsgroup.com   | Refreshed the cockpit bot selector from the live swarm registry on focus and polling so stale dead-bot options self-heal without a full page reload
 * 31 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed cockpit shell bot-selector and status-bar orchestration into dedicated controllers so app.js returns under file and function governance caps while preserving live-bot filtering
 * 32 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit main-view routing into a dedicated controller and removed duplicate cost/status helpers so app.js falls back under the 800-line governance trigger
 * 33 | maintainer@emeraldcoastsystemsgroup.com   | preselectActiveAppBot now applies the focused app's per-app identity: transient skin (profile.theme) so each app looks distinct without clobbering the global theme, and renders the chat selector from the app's own declared bots (profile.chatBots) before preselecting the app's primary bot.
 * 34 | maintainer@emeraldcoastsystemsgroup.com   | Header Swarm Apps button (/applications operator console) is now hidden by default and revealed only for super-admins via the /api/dev-console/access probe (same cosmetic reveal the jarvis orb uses) — normal users kept landing on operator chrome.
 * 35 | maintainer@emeraldcoastsystemsgroup.com   | Dropped the right-edge chat-expand tab and its listener — the bottom-right Jarvis orb is the single standing assistant affordance, so the collapsed rail no longer advertises itself.
 * 36 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 D9: renderAppAssistant() — the cockpit builds an app's floating assistant bubble from its manifest (profile.assistant), lazily loading its same-origin iframe on first open. Restores the little-monsters tutor bubble WITHOUT any package JS executing in this origin.
 * 37 | maintainer@emeraldcoastsystemsgroup.com   | Removed the retired Presentron header button + its click handler; the AI Office ribbon tile is the presentation entry point. Workspace-focus is now RAG-only.
 * 38 | maintainer@emeraldcoastsystemsgroup.com   | Removed the Swarm Apps grid header button (#appsBtn) + its super-admin dev-console probe — apps launch from the left ribbon; the operator app-admin console now lives at /applications, reached via the Settings "Manage swarm apps" link.
 * 39 | maintainer@emeraldcoastsystemsgroup.com   | Repointed the header RAG icon (#ragBtn) to open Settings → Knowledge (openCockpitSettingsPage('knowledge')) instead of bouncing a workspace action into the tool-gated embedded-chat RAG button that silently no-op'd; openCockpitSettingsPage now accepts a target tab.
 * 40 | maintainer@emeraldcoastsystemsgroup.com   | Prevented immersive profiles from restoring disabled hidden chat sessions or creating background tasks.
 * 41 | maintainer@emeraldcoastsystemsgroup.com   | Zen (full-window focus) mode wiring: header arrows-out button + floating exit button toggle body.zen-mode (all cockpit chrome hidden, surface gets the whole window); Esc exits when no modal is open; state survives same-tab reloads via sessionStorage so the once-per-deploy service-worker reload doesn't kick the operator back to chrome.
 * 42 | maintainer@emeraldcoastsystemsgroup.com   | Mobile drawer closes on ANY ribbon-item tap: tapping the already-active view hit setActive's no-op early return, so switchView (and its drawer close) never ran and the drawer stayed open. Delegated listener on #ribbonContainer so it survives ribbon re-renders.
 * 43 | maintainer@emeraldcoastsystemsgroup.com   | Honor `?ticket=<id>` on load: seed CockpitViewController.pendingTicketSelection and open the Tickets view so a global-search ticket hit lands on the RECORD. Every ticket hit previously linked to bare /cockpit/ - the right screen, the wrong (or no) row - and that is the half of the deep-link contract the API cannot fix by itself. Seeded before the first render rather than via focusTicket after it, because the post-render call races TicketView's list fetch and selects nothing.
 * 44 | maintainer@emeraldcoastsystemsgroup.com   | Keep the full-screen mobile chat sheet collapsed on cold start so a background-created chat task cannot cover the phone's primary surface controls
 */

import { ThemeManager } from './theme-manager.js';
import { ApiClient } from './api-client.js';
import { RibbonNav } from './components/RibbonNav.js';
import { renderModalContent, getAuthToken } from './cockpit-modals.js';
import { CockpitBotSelectorController } from './cockpit-bot-selector-controller.js';
// CM-7: Legacy CockpitChatPanelController removed — cockpit always uses embedded iframe
import { CockpitEmbeddedChatPanelController } from './embedded-chat-panel-controller.js';
import { CockpitStatusController } from './cockpit-status-controller.js';
import { CockpitViewController } from './cockpit-view-controller.js';
import { CockpitWorkspaceFocusController } from './cockpit-workspace-focus-controller.js';
import {
  bindWorkspaceActionButton,
  formatThemeLabel,
  getSelectedBotLabel,
  persistQuickSettings,
  readPersistedQuickSettings,
} from './cockpit-persistence.js';

const ASSISTANT_HIDDEN_ATTR = 'data-oshal-assistant-hidden';
const ASSISTANT_VISIBILITY_EVENT = 'oshal:assistant-visibility';

/**
 * Apply the focused app's global-assistant policy. The document attribute is
 * durable across script load order; the event updates an orb that already
 * booted. Removing existing nodes also makes the policy effective against a
 * cached pre-policy jarvis-orb.js during a hot deployment.
 * @param {boolean} hidden - Whether the global assistant is suppressed.
 */
function applyGlobalAssistantPolicy(hidden) {
  const root = document.documentElement;
  if (hidden) root?.setAttribute(ASSISTANT_HIDDEN_ATTR, 'true');
  else root?.removeAttribute(ASSISTANT_HIDDEN_ATTR);

  if (hidden) {
    document.getElementById('jarvisOrbFab')?.remove();
    document.getElementById('jarvisOrbPanel')?.remove();
  }
  window.dispatchEvent(new CustomEvent(ASSISTANT_VISIBILITY_EVENT, { detail: { hidden } }));
}

/**
 * @description Read the `?ticket=<id>` deep-link parameter. This is the cockpit end of the global
 * search deep-link contract (features/global-search/services/deep-link.ts): a search hit for a
 * ticket must open THAT ticket's detail pane, not the unfiltered board. `?app=` remains the
 * authoritative app selector - this parameter only preselects a row inside the Tickets view, and it
 * is never cached, so a plain /cockpit/ visit is unaffected.
 * @returns {string} The requested ticket id, or '' when the parameter is absent or unreadable.
 */
function readRequestedTicketId() {
  try {
    return (new URLSearchParams(window.location.search).get('ticket') || '').trim();
  } catch {
    return '';
  }
}

/**
 * @description Main cockpit UI application class.
 * Manages the 3-column layout (ribbon + main content + chat panel),
 * view switching, modal popups, streaming, and task management.
 */
class CockpitApp {
  /**
   * @description Construct the CockpitApp and initialize state.
   */
  constructor() {
    this.api = new ApiClient();
    this.theme = new ThemeManager();
    this.pollTimers = [];
    this.testMode = false;
    this.messageRenderer = (typeof MessageRenderer !== 'undefined') ? new MessageRenderer() : null;
    this.mockBot = (typeof MockUIBot !== 'undefined') ? new MockUIBot() : null;
    this.streamingClient = null;
    this.settings = readPersistedQuickSettings();
    this.SESSION_ID = 'cockpit-' + Date.now();
    this.totalTokensIn = 0;
    this.totalTokensOut = 0;
    this.totalCost = 0;
    this.ribbon = null;
    this.pendingView = null;
    this.workspaceFocus = new CockpitWorkspaceFocusController({
      showToast: (message, type) => this.showToast(message, type),
    });
    this.chatPanel = this.createChatPanelController();
    this.botSelectorController = new CockpitBotSelectorController({
      api: this.api,
      showToast: (message, type) => this.showToast(message, type),
      onSelectionChange: (selectedAgentId) => this.chatPanel.setSelectedAgentId?.(selectedAgentId),
    });
    this.statusController = new CockpitStatusController({ api: this.api });
    this.viewController = new CockpitViewController({
      theme: this.theme,
      workspaceFocus: this.workspaceFocus,
      chatPanel: this.chatPanel,
      botSelectorController: this.botSelectorController,
      showToast: (message, type) => this.showToast(message, type),
      toggleChatPanel: (show) => this.toggleChatPanel(show),
      isNativeChatWorkspaceEnabled: () => this.isNativeChatWorkspaceEnabled(),
      getRibbon: () => this.ribbon,
    });

    this.init();
  }

  /**
   * @description Initialize the cockpit UI and bind all events.
   * @returns {Promise<void>}
   */
  async init() {
    this.initRibbon();
    this.bindChatEvents();
    this.initModals();
    this.initZenMode();
    if (!this.isNativeChatWorkspaceEnabled()) {
      this.initStreaming();
      this.initRAGWidget();
      this.initMeshChat();
    }
    this.statusController.initCostIndicator();
    await this.botSelectorController.loadBots();
    await this.preselectActiveAppBot();
    this.statusController.loadMetrics();
    this.startPolling();
    if (!this.chatDisabled) {
      await this.chatPanel.restoreSession();
    }
    this.initResizeHandle();
    // The right-rail chat panel starts COLLAPSED everywhere (operator directive 2026-08-13).
    // Desktop used to auto-open whenever restoreSession() found a live task, so a thread from
    // days ago reopened the rail on every load and covered the surface the operator actually
    // came for — Jarvis and the app-embedded concierges are the paths in normal use. Every
    // explicit chat action (a bot card, an Agents tap, openWorkspaceAction) still opens it, so
    // nothing becomes unreachable; only the unrequested auto-open is gone.
    this.toggleChatPanel(false);
  }

  /**
   * @description When a swarm app is focused (?app=<name>), point the chat panel
   * at that app's primary bot (its workflow workerBot) instead of the operator's
   * last-used bot — so "what you see is who you're talking to." No-ops gracefully
   * when no app is focused or the app's bot isn't a live selectable agent.
   * @returns {Promise<void>}
   */
  async preselectActiveAppBot() {
    try {
      await this.ribbon?.ready;
      const profile = this.ribbon?.profile;
      applyGlobalAssistantPolicy(profile?.hideAssistant === true);
      if (!profile) return;

      // Per-app skin: apply the focused app's theme for this page-load only, so each
      // app looks distinct without overwriting the operator's saved global theme.
      // themeCssUrl = an ADR-085 package-bundled skin (a store-installed app brings
      // its own stylesheet; core doesn't register it).
      if (profile.theme) {
        this.theme.applyTransient(profile.theme, profile.themeCssUrl);
      }

      // Apps that are themselves the chat surface (e.g. Jarvis) ask us to drop the
      // generic right-rail chat panel. Set the flag before init()'s own
      // toggleChatPanel() call so the panel never flashes in. We honor the explicit
      // profile.hideChatPanel flag (set once the controller image is rebuilt) AND match
      // the jarvis app by name, so the hide works on a hot-swap before any TS recompile.
      this.chatDisabled = profile.hideChatPanel === true || profile.name === 'jarvis';
      this.chatPanel.setEnabled?.(!this.chatDisabled);
      if (this.chatDisabled) {
        this.toggleChatPanel(false);
        // The right-rail chat iframe (/swarmbot/chat) isn't used by chat-surface apps like Jarvis;
        // stop it loading so it doesn't pull /fonts/codicon.css etc. into a hidden frame.
        const cf = document.getElementById('chatWorkspaceFrame');
        if (cf) cf.setAttribute('src', 'about:blank');
      }

      // Render the chat selector from this app's OWN declared bots (they run
      // inline on chat, so they need not be Redis-live), then re-hydrate — loadBots()
      // already ran once at init, before the profile was available.
      if (Array.isArray(profile.chatBots) && profile.chatBots.length) {
        this.botSelectorController.setAppBots(profile.chatBots);
        await this.botSelectorController.loadBots({ suppressOfflineToast: true });
      }

      // Point the chat at the app's primary bot — "what you see is who you're talking to."
      const chatAgent = profile.chatAgent;
      if (chatAgent?.agentId) {
        this.botSelectorController.selectAgent(chatAgent.agentId);
      }

      // ADR-085 D9: the app's declarative assistant bubble. The FRAMEWORK renders it from the
      // manifest — a package never injects JS into this (authenticated) origin.
      if (profile.assistant) this.renderAppAssistant(profile.assistant);
    } catch {
      // Non-fatal: leave the persisted/default selection + global theme in place.
    }
  }

  /**
   * @description Render an app's declarative assistant bubble (ADR-085 D9).
   *
   * A floating button that opens the app's own surface in an iframe — Little Monsters' tutor, for
   * instance. This exists so a package never has to inject JavaScript into the cockpit shell:
   * package script would run in THIS origin, authenticated as the operator, free to read any DOM
   * content and call any API as them. The manifest declares what it wants; the framework builds it.
   *
   * The iframeUrl is validated same-origin and root-relative at manifest load (readManifest), so it
   * cannot be turned into a cross-origin embed. The iframe is sandboxed the same way every packaged
   * surface already is.
   *
   * @param {{label: string, icon: string, iframeUrl: string, title?: string}} assistant - Manifest declaration.
   * @returns {void}
   */
  renderAppAssistant(assistant) {
    if (document.getElementById('appAssistantFab')) return; // idempotent

    // Defence in depth: readManifest already rejects anything not root-relative, but the cockpit
    // must not depend on the server having validated. Same rule, enforced again at the point of use.
    if (typeof assistant.iframeUrl !== 'string' || !/^\/(?!\/)/.test(assistant.iframeUrl)) {
      console.warn('[assistant] refusing non-same-origin iframeUrl', assistant.iframeUrl);
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'appAssistantPanel';
    panel.hidden = true;
    panel.className = 'app-assistant-panel';

    const frame = document.createElement('iframe');
    frame.title = assistant.title || assistant.label;
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    panel.appendChild(frame);

    const fab = document.createElement('button');
    fab.id = 'appAssistantFab';
    fab.className = 'app-assistant-fab';
    fab.type = 'button';
    fab.title = assistant.label;
    fab.setAttribute('aria-label', assistant.label);
    fab.innerHTML = `<i class="${String(assistant.icon).replace(/"/g, '')}"></i>`;

    fab.addEventListener('click', () => {
      const opening = panel.hidden;
      // Load lazily on first open — an app's assistant should cost nothing until it's wanted.
      if (opening && !frame.getAttribute('src')) frame.setAttribute('src', assistant.iframeUrl);
      panel.hidden = !opening;
      fab.classList.toggle('is-open', opening);
    });

    document.body.appendChild(panel);
    document.body.appendChild(fab);
  }

  /**
   * @description Create the cockpit chat controller for the embedded native workspace.
   * CM-7: Legacy CockpitChatPanelController removed — cockpit always uses the iframe.
   * @returns {CockpitEmbeddedChatPanelController} Embedded chat controller.
   */
  createChatPanelController() {
    return new CockpitEmbeddedChatPanelController({
      getSelectedAgentId: () => document.getElementById('botSelector')?.value || '',
      getSelectedAgentLabel: () => getSelectedBotLabel(),
      getCurrentTheme: () => this.theme.getCurrent(),
    });
  }

  /**
   * @description Detect whether cockpit is using the embedded native chat workspace.
   * @returns {boolean} True when the right rail hosts the real `/chat` surface in an iframe.
   */
  isNativeChatWorkspaceEnabled() {
    return this.chatPanel.supportsNativeWorkspace?.() === true;
  }

  // ═══ RIBBON NAVIGATION ═══

  /**
   * @description Initialize the ribbon navigation and switch to default view.
   */
  initRibbon() {
    this.ribbon = new RibbonNav('ribbonContainer', (viewId) => this.switchView(viewId));
    void this.ribbon.ready.then(() => {
      if (this.pendingView || this.viewController.currentView) return;
      const requestedTicketId = readRequestedTicketId();
      const initialView = requestedTicketId ? 'tickets' : (this.ribbon?.getActive?.() || 'tickets');
      // Seed the selection BEFORE the first render so TicketView picks it up from
      // initialSelectedTicketId on its own load pass. Calling focusTicket AFTER switchView races
      // the list fetch and selects nothing.
      if (requestedTicketId) this.viewController.pendingTicketSelection = requestedTicketId;
      void this.switchView(initialView);
    });
  }

  /**
   * @description Switch the main content area to a new view.
   * @param {string} viewId - The view to switch to
   * @returns {Promise<void>}
   */
  async switchView(viewId) {
    this.pendingView = viewId;
    this.ribbon?.setActive?.(viewId, { notify: false });
    // Picking an item from the mobile drawer should close it.
    this.toggleMobileMenu(false);
    // Jarvis IS the chat surface — hide the redundant right-rail chat panel whenever its view is
    // active, even in the unified cockpit home (where profile.name isn't 'jarvis'). Restore it on
    // other views, unless the whole profile is a chat-surface app.
    const isJarvisView = typeof viewId === 'string' && viewId.toLowerCase().includes('jarvis');
    const profile = this.ribbon?.profile;
    const profileIsChatSurface = profile?.hideChatPanel === true || profile?.name === 'jarvis';
    if (isJarvisView) {
      this.chatDisabled = true;
      this.chatPanel.setEnabled?.(false);
      this.toggleChatPanel(false);
      const cf = document.getElementById('chatWorkspaceFrame');
      if (cf && cf.getAttribute('src') !== 'about:blank') cf.setAttribute('src', 'about:blank');
    } else if (this.chatDisabled && !profileIsChatSurface) {
      this.chatDisabled = false;   // leaving Jarvis in a multi-app profile — allow the panel again
      this.chatPanel.setEnabled?.(true);
      void this.chatPanel.restoreSession();
    }
    try {
      await this.viewController.switchView(viewId);
    } finally {
      if (this.pendingView === viewId) this.pendingView = null;
    }
  }

  // ═══ RESIZE HANDLE ═══

  /**
   * @description Initialize the resize handle between main content and chat.
   */
  initResizeHandle() {
    const handle = document.getElementById('resizeChat');
    const mainContent = document.getElementById('mainContent');
    const chatPanel = document.getElementById('chatPanel');
    const cockpitBody = document.querySelector('.cockpit-body');
    if (!handle || !mainContent || !chatPanel) return;

    mainContent.style.removeProperty('width');
    mainContent.style.removeProperty('flex');
    chatPanel.style.removeProperty('flex');

    let startX, startChatW;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startChatW = chatPanel.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.classList.add('resizing');

      let raf = null;
      const onMove = (ev) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          const dx = ev.clientX - startX;
          const availableWidth = cockpitBody?.getBoundingClientRect().width || window.innerWidth;
          const minChat = 280;
          const maxChat = Math.max(minChat, Math.min(720, availableWidth - 420));
          const newChat = Math.min(Math.max(startChatW - dx, minChat), maxChat);

          mainContent.style.removeProperty('width');
          mainContent.style.flex = '1 1 auto';
          chatPanel.style.width = newChat + 'px';
          chatPanel.style.flex = '0 0 auto';
          raf = null;
        });
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        mainContent.style.removeProperty('width');
        mainContent.style.flex = '1 1 auto';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ═══ MODAL MANAGEMENT ═══

  /**
   * @description Initialize the modal system and bind header icon buttons.
   */
  initModals() {
    const overlay = document.getElementById('modalOverlay');
    const closeBtn = document.getElementById('modalCloseBtn');
    closeBtn?.addEventListener('click', () => this.closeModal());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) {
        this.closeModal();
      }
    });
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeModal();
    });
    // The RAG icon now opens the first-class Knowledge surface in Settings (ingestion tool +
    // permission-aware visibility). The old path bounced a workspace action into the embedded chat
    // iframe and clicked a tool-gated, often-hidden button there — so it silently did nothing.
    document.getElementById('ragBtn')?.addEventListener('click', () => this.openCockpitSettingsPage('knowledge'));
    document.getElementById('profileBtn')?.addEventListener('click', () => this.openModal('profile'));
    // (The Swarm Apps grid icon was removed — apps launch from the left ribbon; the operator
    //  app-admin console lives at /applications, reached via the Settings "Manage swarm apps" link.)
    // Mobile: the chat panel (and its bot selector) is a hidden slide-up sheet, so give the
    // operator a one-tap way to open it and pick any agent. Opens the sheet, then focuses the picker.
    document.getElementById('agentsBtn')?.addEventListener('click', () => {
      this.toggleChatPanel(true);
      setTimeout(() => { try { document.getElementById('botSelector')?.focus(); } catch (e) {} }, 250);
    });

    // Mobile: hamburger opens the ribbon as a slide-in drawer; backdrop closes it.
    document.getElementById('mobileMenuBtn')?.addEventListener('click', () => this.toggleMobileMenu());
    document.getElementById('ribbonBackdrop')?.addEventListener('click', () => this.toggleMobileMenu(false));
    // Any ribbon-item tap closes the drawer — including a tap on the ALREADY-ACTIVE
    // view, which RibbonNav.setActive treats as a no-op (so switchView, which owns
    // the usual drawer close, never runs). Delegated on the container so it keeps
    // working across ribbon re-renders.
    document.getElementById('ribbonContainer')?.addEventListener('click', (e) => {
      if (e.target?.closest?.('.ribbon-btn')) this.toggleMobileMenu(false);
    });
  }

  // ═══ ZEN (FULL-WINDOW FOCUS) MODE ═══

  /**
   * @description Bind the zen-mode controls: the header arrows-out button enters,
   * the floating exit button or Esc (when no modal is open) leaves, and the state
   * is restored from sessionStorage so the once-per-deploy service-worker reload
   * doesn't kick the operator back into full chrome mid-session.
   * @returns {void}
   */
  initZenMode() {
    document.getElementById('zenModeBtn')?.addEventListener('click', () => this.setZenMode(true));
    document.getElementById('zenExitBtn')?.addEventListener('click', () => this.setZenMode(false));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !document.body.classList.contains('zen-mode')) return;
      // A visible modal owns Esc (initModals closes it) — don't also drop the chrome back in.
      const overlay = document.getElementById('modalOverlay');
      if (overlay && !overlay.classList.contains('hidden')) return;
      this.setZenMode(false);
    });
    try {
      if (window.sessionStorage.getItem('oshal-zen-mode') === '1') this.setZenMode(true);
    } catch (e) { /* storage blocked — zen just starts off */ }
  }

  /**
   * @description Enter or leave zen (full-window focus) mode: body.zen-mode hides all
   * cockpit chrome via layout.css so the active surface gets the whole window.
   * @param {boolean} on - true to hide the cockpit chrome, false to restore it
   * @returns {void}
   */
  setZenMode(on) {
    document.body.classList.toggle('zen-mode', on);
    document.getElementById('zenExitBtn')?.classList.toggle('hidden', !on);
    try { window.sessionStorage.setItem('oshal-zen-mode', on ? '1' : '0'); } catch (e) { /* non-fatal */ }
  }

  /**
   * @description Open/close the mobile ribbon drawer (and its backdrop). Pass a
   * boolean to force a state, or omit to toggle.
   * @param {boolean} [open] - desired open state
   * @returns {void}
   */
  toggleMobileMenu(open) {
    const nav = document.querySelector('.ribbon-nav');
    const backdrop = document.getElementById('ribbonBackdrop');
    if (!nav) return;
    const next = open === undefined ? !nav.classList.contains('mobile-open') : open;
    nav.classList.toggle('mobile-open', next);
    backdrop?.classList.toggle('show', next);
  }

  /**
   * @description Open a modal with dynamically rendered content.
   * @param {string} modalType - The type of modal to open
   */
  openModal(modalType) {
    const overlay = document.getElementById('modalOverlay');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!overlay || !title || !body) return;
    const content = renderModalContent(modalType, {
      ...this.settings,
      workspaceFocusWide: this.workspaceFocus.getIsWide(),
      workspaceFocusHasCustomWidth: this.workspaceFocus.getCustomWidth() !== null,
    });
    title.textContent = content.title;
    body.innerHTML = content.html;
    overlay.classList.remove('hidden');
    if (content.onRender) content.onRender(this);
  }

  /**
   * @description Persist lightweight cockpit quick settings used by the header modal and right rail.
   * @param {{ autoApprove?: boolean, workspaceFocusWide?: boolean }} nextSettings - Partial quick-setting state to merge and persist.
   */
  saveQuickSettings(nextSettings) {
    if (Object.prototype.hasOwnProperty.call(nextSettings, 'workspaceFocusWide')) {
      this.workspaceFocus.setWidePreference(nextSettings.workspaceFocusWide === true);
    }

    this.settings = {
      ...this.settings,
      ...nextSettings,
    };
    delete this.settings.workspaceFocusWide;
    persistQuickSettings(this.settings);
  }

  /**
   * @description Open the fuller cockpit Settings ribbon screen from a lightweight header handoff.
   *
   * @param {string} [tab] - Optional settings tab id (e.g. 'knowledge') to land on. Passed to the
   *   SettingsView via a one-shot sessionStorage hint so the fresh render selects it.
   * @returns {void}
   */
  openCockpitSettingsPage(tab) {
    if (typeof tab === 'string' && tab) {
      try {
        sessionStorage.setItem('cockpit-settings-tab', tab);
      } catch (error) {
        /* private-mode / storage-disabled — the tab hint is best-effort; default tab still opens */
      }
    }
    this.ribbon?.setActive('settings');
    void this.switchView('settings');
  }

  /**
   * @description Open one ticket in the Tickets workbench and preserve the selection across the view switch.
   * @param {string} ticketId - Ticket identifier selected from another cockpit surface.
   * @returns {void}
   */
  openTicketWorkbench(ticketId) {
    this.viewController.openTicketWorkbench(ticketId);
  }

  /**
   * @description Restore one historical task into the active right rail and bring that workspace into focus.
   * @param {string} taskId - Historical task identifier chosen from the header history modal.
   */
  openHistoryTask(taskId) {
    const nextTaskId = typeof taskId === 'string' ? taskId.trim() : '';
    if (!nextTaskId) {
      return;
    }

    this.workspaceFocus.exit();
    this.toggleChatPanel(true);
    this.chatPanel.loadTask?.(nextTaskId);
    this.chatPanel.focus?.();
  }

  /**
   * @description Open one heavy workspace action from the header using the dedicated cockpit focus mode.
   * @param {'rag'} action - Header workspace action to foreground.
   */
  openHeaderWorkspace(action) {
    this.workspaceFocus.openHeaderWorkspace(action, {
      toggleChatPanel: (show) => this.toggleChatPanel(show),
      openWorkspaceAction: (nextAction) => this.chatPanel.openWorkspaceAction?.(nextAction),
    });
  }

  /**
   * @description Exit cockpit workspace-focus mode through the extracted controller.
   * @returns {void}
   */
  exitWorkspaceFocus() {
    this.workspaceFocus.exit();
  }

  /**
   * @description Toggle workspace-focus width through the extracted controller.
   * @returns {void}
   */
  toggleWorkspaceFocusWidth() {
    this.workspaceFocus.toggleWidth();
  }

  /**
   * @description Persist a custom workspace-focus width through the extracted controller.
   * @param {number | null} width - Width in pixels or null to clear the custom width.
   * @returns {void}
   */
  setWorkspaceFocusCustomWidth(width) {
    this.workspaceFocus.setCustomWidth(width);
  }

  /**
   * @description Close the currently open modal.
   */
  closeModal() {
    const overlay = document.getElementById('modalOverlay');
    if (overlay) overlay.classList.add('hidden');
  }
  // ═══ CHAT EVENTS ═══

  /**
   * @description Bind all chat-related DOM events.
   */
  bindChatEvents() {
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      const nextTheme = this.theme.cycle();
      this.chatPanel.syncTheme?.(nextTheme);
      this.showToast(`Theme: ${formatThemeLabel(nextTheme)}`, 'info');
    });
    document.getElementById('toggleChat')?.addEventListener('click', () => this.toggleChatPanel(false));
    document.getElementById('exitWorkspaceFocusBtn')?.addEventListener('click', () => this.workspaceFocus.exit());
    document.getElementById('toggleWorkspaceFocusWidthBtn')?.addEventListener('click', () => this.workspaceFocus.toggleWidth());
    document.getElementById('workspaceFocusResizeHandle')?.addEventListener('mousedown', (event) => this.workspaceFocus.startResize(event));
    document.getElementById('newChatBtn')?.addEventListener('click', () => {
      this.workspaceFocus.exit();
      this.chatPanel.newChat();
      this.toggleChatPanel(true);
    });
    this.botSelectorController.bindSelectorEvents();

    if (this.isNativeChatWorkspaceEnabled()) {
      this.bindNativeWorkspaceButtons();
      return;
    }

    this.bindLegacyPlaceholderChatEvents();
    document.getElementById('testModeBtn')?.addEventListener('click', () => this.toggleTestMode());
  }

  /**
   * @description Bind the legacy placeholder chat input events when cockpit is not using the embedded native rail.
   */
  bindLegacyPlaceholderChatEvents() {
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    if (!chatInput || !sendBtn) {
      return;
    }

    chatInput.addEventListener('input', () => {
      sendBtn.disabled = !chatInput.value.trim();
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.chatPanel.sendMessage({
          targetBot: document.getElementById('botSelector')?.value || 'assistant',
        });
      }
    });
    sendBtn.addEventListener('click', () => this.chatPanel.sendMessage({
      targetBot: document.getElementById('botSelector')?.value || 'assistant',
    }));
    document.querySelectorAll('.quick-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        chatInput.value = btn.dataset.msg;
        sendBtn.disabled = false;
        this.chatPanel.sendMessage({
          targetBot: document.getElementById('botSelector')?.value || 'assistant',
        });
      });
    });
  }

  /**
   * @description Bind cockpit-side workspace buttons to actions inside the embedded native chat rail.
   * CM-4: Workspace action buttons removed from cockpit rail — in-chat workspace controls are canonical.
   */
  bindNativeWorkspaceButtons() {
    // Buttons removed from cockpit rail to eliminate duplicate UI (CM-4).
    // Workspace actions (settings, tools, history, RAG) are accessible
    // directly within the embedded swarmbot-chat iframe.
  }

  /**
   * @description Toggle the chat panel visibility. The rail has no standing reopen
   * affordance of its own (the Jarvis orb is the persistent assistant entry point) —
   * callers such as `chatWithBot` and workspace focus open it contextually.
   * @param {boolean} show - Whether to show or hide the panel
   */
  toggleChatPanel(show) {
    const el = document.getElementById('chatPanel');
    const handle = document.getElementById('resizeChat');
    // Some apps (e.g. Jarvis) ARE the chat surface — the profile asks us to drop
    // the right-rail panel entirely. Force-hide and ignore any later show requests
    // so the redundant panel stays gone.
    if (this.chatDisabled) {
      this.workspaceFocus.exit();
      if (el) { el.classList.add('collapsed'); el.style.display = 'none'; }
      if (handle) handle.style.display = 'none';
      return;
    }
    if (!show) {
      this.workspaceFocus.exit();
    }
    if (el) el.classList.toggle('collapsed', !show);
    if (handle) handle.style.display = show ? '' : 'none';
  }

  // ═══ STREAMING ═══

  /**
   * @description Initialize streaming client if available.
   */
  initStreaming() {
    if (this.isNativeChatWorkspaceEnabled()) return;
    if (typeof CockpitStreamingClient === 'undefined') return;
    const API_URL = window.location.origin;
    this.streamingClient = new CockpitStreamingClient(API_URL, this.SESSION_ID);
    this.streamingClient.currentTaskId = null;
    this.streamingClient.connect();
    window.renderedMessageTimestamps = this.chatPanel.renderedMessageTimestamps;
    this._patchStreamingForCockpit();
  }

  /**
   * @description Patch streaming client callbacks for cockpit UI.
   */
  _patchStreamingForCockpit() {
    if (!this.streamingClient) return;
    const sc = this.streamingClient;
    const self = this;
    sc.onMessage = (message) => {
      if (!message) return;
      const say = message.say || message.type;
      if (['text', 'completion_result', 'reasoning', 'tool', 'tool_use', 'error'].includes(say)) {
        self.chatPanel.addRenderedMessage(message);
      }
      if (['text', 'completion_result', 'error'].includes(say)) {
        self.chatPanel.markIdle();
      }
    };
    sc.scrollToBottom = () => {
      const c = document.getElementById('chatMessages');
      if (c) c.scrollTop = c.scrollHeight;
    };
    sc.handleTextResponse = (event) => {
      if (event.text) {
        self.chatPanel.addRenderedMessage({ ts: String(Date.now()), type: 'say', say: 'text', text: event.text });
      }
      self.chatPanel.markIdle();
    };
    sc.handleReasoningText = (event) => {
      self.chatPanel.addRenderedMessage({ ts: String(event.ts || Date.now()), type: 'say', say: 'reasoning', text: event.text || '' });
    };
    sc.handleToolUse = (event) => {
      self.chatPanel.addRenderedMessage({
        ts: String(event.ts || Date.now()), type: 'say', say: 'tool',
        text: JSON.stringify({ tool: event.tool || 'unknown', path: event.input?.path || '' })
      });
    };
    sc.handleToolResult = (event) => {
      if (event.tokensUsed || event.cost) {
        self.totalTokensIn += event.tokensUsed || 0;
        self.totalCost += event.cost || 0;
      }
    };
    sc.handleCompletionResult = (event) => {
      self.chatPanel.addRenderedMessage({ ts: String(event.ts || Date.now()), type: 'say', say: 'completion_result', text: event.text || 'Task completed.' });
      self.chatPanel.markIdle();
    };
    sc.handleErrorResponse = (event) => {
      self.chatPanel.addRenderedMessage({ ts: String(Date.now()), type: 'say', say: 'error', text: event.text || event.message || 'Unknown error' });
      self.chatPanel.markIdle();
    };
    sc.handleTaskCompletionStream = () => {
      self.chatPanel.markIdle();
    };
  }

  // ═══ RAG WIDGET ═══

  /**
   * @description Initialize the in-panel RAG upload widget.
   */
  initRAGWidget() {
    if (typeof FileUploadWidget === 'undefined') return;
    try {
      let ragUrl = window.location.hostname === 'localhost'
        ? `${window.location.protocol}//${window.location.hostname}:8000`
        : `${window.location.protocol}//${window.location.hostname}`;
      this.ragWidget = new FileUploadWidget('ragUploadWidget', ragUrl, 'dev-key');
    } catch (error) {
      console.warn(JSON.stringify({
        level: 'warn',
        module: 'cockpit-app',
        action: 'init-rag-widget',
        message: 'Failed to initialize cockpit RAG widget',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    document.getElementById('ragUploadBtn')?.addEventListener('click', () => {
      const w = document.getElementById('ragUploadWidget');
      if (w) w.style.display = w.style.display === 'none' ? 'block' : 'none';
    });
  }

  // ═══ MESH CHAT ═══

  /**
   * @description Initialize the mesh group chat overlay toggle.
   */
  initMeshChat() {
    const meshBtn = document.getElementById('meshChatBtn');
    const meshOverlay = document.getElementById('meshOverlay');
    const closeMesh = document.getElementById('closeMeshOverlay');
    if (meshBtn && meshOverlay) meshBtn.addEventListener('click', () => meshOverlay.classList.toggle('hidden'));
    if (closeMesh && meshOverlay) closeMesh.addEventListener('click', () => meshOverlay.classList.add('hidden'));
    if (meshOverlay) {
      meshOverlay.addEventListener('click', (e) => {
        if (e.target === meshOverlay) meshOverlay.classList.add('hidden');
      });
    }
  }

  // ═══ METRICS & STATUS BAR ═══

  /**
   * @description Start polling for metrics updates.
   */
  startPolling() {
    this.pollTimers = this.statusController.startPolling({
      refreshBots: () => this.botSelectorController.loadBots({
        preserveCurrentSelection: true,
        suppressOfflineToast: true,
      }),
    });
  }

  // ═══ TEST MODE ═══

  /**
   * @description Toggle test mode on/off.
   */
  toggleTestMode() {
    this.testMode = !this.testMode;
    const btn = document.getElementById('testModeBtn');
    if (btn) btn.classList.toggle('active', this.testMode);
    if (this.testMode) {
      this.showToast('🧪 Test Mode ON', 'info');
      this.runMockBot();
    } else {
      this.showToast('Test Mode OFF', 'info');
    }
  }

  /**
   * @description Run mock bot simulation in test mode.
   * @returns {Promise<void>}
   */
  async runMockBot() {
    if (!this.mockBot || !this.messageRenderer) return;
    const container = document.getElementById('chatMessages');
    if (!container) return;
    container.innerHTML = '';
    this.messageRenderer.clearState();
    this.chatPanel.renderedMessageTimestamps.clear();

    const banner = document.createElement('div');
    banner.className = 'test-mode-banner';
    banner.innerHTML = '<i class="ph ph-flask"></i> Mock Bot Simulation';
    container.appendChild(banner);

    for await (const msg of this.mockBot.simulateTaskStream(800)) {
      if (!this.testMode) break;
      this.chatPanel.addRenderedMessage(msg, { testMode: true });
    }

    if (this.testMode) {
      await new Promise(r => setTimeout(r, 600));
      this.chatPanel.addRenderedMessage(this.mockBot.getUserFeedback(), { testMode: true });
      await new Promise(r => setTimeout(r, 600));
      this.chatPanel.addRenderedMessage(this.mockBot.getFollowup(), { testMode: true });
      await new Promise(r => setTimeout(r, 600));
      this.chatPanel.addRenderedMessage(this.mockBot.getErrorMessage(), { testMode: true });
    }
  }

  // ═══ TOAST ═══

  /**
   * @description Show a toast notification.
   * @param {string} message - Toast message text
   * @param {string} type - Toast type (info, success, error)
   */
  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }
}

const app = new CockpitApp();
window.__cockpit = app;
