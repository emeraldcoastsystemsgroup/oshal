/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit main-view routing and bot handoff orchestration from app.js so the shell stays under governance caps while preserving live bot selector behavior
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add allow-top-navigation-by-user-activation to the embedded-surface iframe sandbox. Without it, a Connect button (target="_top") inside /utilities was silently swallowed — clicking did nothing while opening the same URL in a new window worked. The flag only permits top navigation on a real user gesture, and every embedded surface is first-party (allow-same-origin), so OAuth connect/login redirects now work in-frame.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Add allow-modals to the embedded-surface iframe sandbox. Without it the browser silently ignores window.confirm()/prompt()/alert() inside every ribbon surface, so core demo actions (Composer Publish, Studio Post, Codex Packer Deploy, Files Delete, Storage "+ New repo", Utilities Disconnect) appeared to do nothing on click. Surfaces are first-party (allow-same-origin); modals are safe.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | renderConnectorDiscoverView forwards the focused app's connector allow-list (profile.connectors ← manifest dependencies.connectors) so the marketplace only offers providers the app declared — inside Little Monsters the Facebook/LinkedIn catalog no longer appears.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Delegate full-screen permission to first-party packaged surfaces so games can hide cockpit chrome on request.
 */

import {
  TicketView,
  ChatView,
  CalendarView,
  AddressBookView,
  DashboardView,
  SettingsView,
  AdvancedView,
  OperationsView,
  LogsView,
  ConnectorDiscoverView,
} from './views/index.js';
import { DashboardHomeView } from './views/DashboardHomeView.js';

/**
 * @description Manage cockpit main-content view routing, ticket handoffs, and bot-to-rail context transitions.
 */
export class CockpitViewController {
  /**
   * @description Create a cockpit view controller with the shell collaborators needed to render views
   * and route operators into the correct ticket or bot workspace.
   *
   * @param {{
   *   theme: { apply: (theme: string) => string },
   *   workspaceFocus: { exit: () => void },
   *   chatPanel: Record<string, unknown>,
   *   botSelectorController: { selectAgent: (agentId: string) => string },
   *   showToast: (message: string, type?: string) => void,
   *   toggleChatPanel: (show: boolean) => void,
   *   isNativeChatWorkspaceEnabled: () => boolean,
   *   getRibbon: () => { setActive: (viewId: string) => void } | null,
   * }} options - View-controller collaborators.
   * @returns {void}
   */
  constructor(options) {
    this.theme = options.theme;
    this.workspaceFocus = options.workspaceFocus;
    this.chatPanel = options.chatPanel;
    this.botSelectorController = options.botSelectorController;
    this.showToast = options.showToast;
    this.toggleChatPanel = options.toggleChatPanel;
    this.isNativeChatWorkspaceEnabled = options.isNativeChatWorkspaceEnabled;
    this.getRibbon = options.getRibbon;
    this.currentView = '';
    this.activeViewInstance = null;
    this.pendingTicketSelection = '';
  }

  /**
   * @description Switch the cockpit main-content area to a new view and tear down the prior renderer.
   *
   * @param {string} viewId - View identifier selected from the ribbon.
   * @returns {Promise<void>} Resolves when the new view has rendered.
   */
  async switchView(viewId) {
    this.resetActiveView(viewId);
    const container = document.getElementById('mainContent');
    if (!container) {
      return;
    }

    await this.renderCurrentView(container);
  }

  /**
   * @description Open one ticket inside the Tickets workbench and preserve selection across the view switch.
   *
   * @param {string} ticketId - Target ticket identifier.
   * @returns {void}
   */
  openTicketWorkbench(ticketId) {
    const nextTicketId = typeof ticketId === 'string' ? ticketId.trim() : '';
    if (!nextTicketId) {
      this.showToast('Ticket link is unavailable for this calendar item', 'error');
      return;
    }

    this.pendingTicketSelection = nextTicketId;
    if (this.currentView === 'tickets' && typeof this.activeViewInstance?.focusTicket === 'function') {
      void this.activeViewInstance.focusTicket(nextTicketId);
      this.showToast('Ticket opened in Tickets', 'info');
      return;
    }

    this.getRibbon()?.setActive('tickets');
    this.showToast('Ticket opened in Tickets', 'info');
  }

  // Reset shell-level state before another cockpit workbench renders.
  resetActiveView(viewId) {
    this.workspaceFocus.exit();
    if (this.activeViewInstance?.destroy) {
      this.activeViewInstance.destroy();
    }
    this.activeViewInstance = null;
    this.currentView = viewId;
  }

  // Render the selected cockpit main-content view into the shared container.
  async renderCurrentView(container) {
    switch (this.currentView) {
      case 'tickets':
        await this.renderTicketsView(container);
        break;
      case 'chat':
        await this.renderChatView(container);
        break;
      case 'calendar':
        await this.renderCalendarView(container);
        break;
      case 'addressbook':
        await this.renderAddressBookView(container);
        break;
      case 'dashboard':
        await this.renderDashboardView(container);
        break;
      case 'settings':
        await this.renderSettingsView(container);
        break;
      case 'operations':
        await this.renderOperationsView(container);
        break;
      case 'connectors':
        await this.renderConnectorDiscoverView(container);
        break;
      case 'logs':
        await this.renderLogsView(container);
        break;
      case 'forge':
        this.renderForgeView(container);
        break;
      case 'advanced':
        await this.renderAdvancedView(container);
        break;
      default:
        // Tool UI views — render iframe for tools registered with ui config
        if (this.currentView.startsWith('tool-')) {
          this.renderToolView(container, this.currentView);
        }
        break;
    }
  }

  // Route one cockpit surface handoff into the selected bot lane and legacy placeholder input if needed.
  chatWithBot(botId, ticketInfo) {
    this.toggleChatPanel(true);
    const selectedAgentId = botId
      ? this.botSelectorController.selectAgent(botId)
      : (document.getElementById('botSelector')?.value || '').trim();
    if (!botId) {
      this.chatPanel.setSelectedAgentId?.(selectedAgentId);
    }

    if (this.isNativeChatWorkspaceEnabled()) {
      this.chatPanel.focus?.();
      return;
    }

    this.seedLegacyChatInput(ticketInfo);
  }

  // Render the cockpit Tickets workbench with pending selection state.
  async renderTicketsView(container) {
    const view = new TicketView(container, {
      onChatWithBot: (botId, ticketInfo) => this.chatWithBot(botId, ticketInfo),
      onToast: (message, type) => this.showToast(message, type),
      initialSelectedTicketId: this.pendingTicketSelection,
    });
    this.activeViewInstance = view;
    await view.render();
    this.pendingTicketSelection = '';
  }

  // Render the cockpit Chat conversation browser.
  async renderChatView(container) {
    const view = new ChatView(container, {
      onSelectConversation: (taskId) => this.chatPanel.loadTask(taskId),
      onNewChat: () => this.chatPanel.newChat(),
    });
    this.activeViewInstance = view;
    await view.render();
  }

  // Render the cockpit Calendar workbench.
  async renderCalendarView(container) {
    const view = new CalendarView(container, {
      onNavigateToTicket: (ticketId) => this.openTicketWorkbench(ticketId),
      onToast: (message, type) => this.showToast(message, type),
    });
    this.activeViewInstance = view;
    await view.render();
  }

  // Render the cockpit Address Book workbench.
  async renderAddressBookView(container) {
    const view = new AddressBookView(container, {
      onMessageBot: (botId) => this.chatWithBot(botId),
      onCreateTicket: (botId) => this.chatWithBot(botId),
      onViewActivity: () => this.getRibbon()?.setActive('calendar'),
    });
    this.activeViewInstance = view;
    await view.render();
  }

  // Render the cockpit Dashboard workbench with homepage summary.
  async renderDashboardView(container) {
    const homeView = new DashboardHomeView({
      api: { get: (url) => fetch(url) },
      showToast: this.showToast,
      navigateToView: (viewId) => this.getRibbon()?.setActive(viewId),
    });
    await homeView.render(container);

    // Append the existing operational dashboard below the homepage summary
    const opsSection = document.createElement('div');
    opsSection.id = 'dashboardOpsSection';
    container.appendChild(opsSection);
    const view = new DashboardView(opsSection);
    this.activeViewInstance = view;
    await view.render();
  }

  // Render the cockpit Settings workbench.
  async renderSettingsView(container) {
    const view = new SettingsView(container, {
      onThemeChange: (theme) => {
        const nextTheme = this.theme.apply(theme);
        this.chatPanel.syncTheme?.(nextTheme);
        return nextTheme;
      },
      onToast: (message, type) => this.showToast(message, type),
    });
    this.activeViewInstance = view;
    await view.render();
  }

  // Render the searchable structured log viewer.
  async renderLogsView(container) {
    const view = new LogsView(container);
    this.activeViewInstance = view;
    await view.render();
  }

  // Render the consolidated Operations view (replaces 6 iframe engineering screens).
  async renderOperationsView(container) {
    const view = new OperationsView(container);
    this.activeViewInstance = view;
    await view.render();
  }

  // Render the ADR-067 connector marketplace and enablement surface. A focused app
  // that declared its connector needs (profile.connectors) restricts the catalog to
  // that allow-list; the framework default (no declaration) shows everything.
  async renderConnectorDiscoverView(container) {
    const allow = this.getRibbon()?.profile?.connectors;
    const view = new ConnectorDiscoverView(container, { allow: Array.isArray(allow) ? allow : null });
    this.activeViewInstance = view;
    await view.render();
  }

  /**
   * @description Renders the Bot Forge front door inline on the framework-default
   * cockpit (the agentic-swarm-injection engine: gallery + Ready-to-inject tray).
   * Same first-party sandbox as tool surfaces so its fetches + inject modals work.
   * For the full authoring experience (the packer chat in the right rail) the
   * surface's "Build a new bot" CTA links to /cockpit/?app=codex-packer.
   * @param {HTMLElement} container - Main content container
   */
  renderForgeView(container) {
    container.innerHTML = `
      <div class="tool-view-container" style="display:flex;flex-direction:column;height:100%;width:100%;">
        <iframe src="/api/forge" style="flex:1;border:none;width:100%;height:100%;" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-top-navigation-by-user-activation"></iframe>
      </div>`;
  }

  // Render the cockpit Advanced workbench (legacy — kept for direct-route access).
  async renderAdvancedView(container) {
    const view = new AdvancedView(container);
    this.activeViewInstance = view;
    await view.render();
  }

  /**
   * @description Renders a tool UI view as an iframe in the main content area.
   * The tool's iframeUrl is fetched from the ribbon nav's view config.
   * @param {HTMLElement} container - Main content container
   * @param {string} viewId - Tool view ID (e.g. 'tool-graph-query')
   */
  renderToolView(container, viewId) {
    const ribbon = this.getRibbon();
    const viewDef = ribbon?.views?.find(v => v.id === viewId);
    const iframeUrl = viewDef?.toolUi?.iframeUrl;
    const label = viewDef?.toolUi?.sidebarLabel || viewDef?.label || viewId;

    if (iframeUrl) {
      // The Jarvis surface needs the microphone (getUserMedia), which Chrome refuses inside a
      // sandboxed iframe even with allow="microphone". It's our own first-party same-origin page,
      // so drop the sandbox for it (keep it for third-party/tool surfaces). Other surfaces stay sandboxed.
      const isVoiceSurface = /\/api\/jarvis(\/|$|\?)/.test(String(iframeUrl));
      // Cache-bust the surface so UI edits always load fresh (no stale iframe/CDN copy).
      const bustedUrl = String(iframeUrl) + (iframeUrl.includes('?') ? '&' : '?') + 'v=' + Date.now();
      const sandboxAttr = isVoiceSurface
        ? ''
        : 'sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-top-navigation-by-user-activation"';

      // Guest read-only treatment: for Tier-B apps (open but not interactive), show a
      // banner and dim/disable data-entry controls inside the surface. The server already
      // 403s any mutation — this is the matching UX so a guest sees WHY a control is dead.
      const guestTier = ribbon?.guestTierForView?.(viewDef) || null;
      const isGuestReadonly = guestTier === 'B';
      const notation = ribbon?.guestNotationForView?.(viewDef) || null;
      const banner = isGuestReadonly
        ? `<div class="guest-readonly-banner" style="padding:6px 16px;background:#2a2018;border-bottom:1px solid #6b4f1d;color:#e8c98a;font-size:12.5px;display:flex;align-items:center;gap:8px;">
             <i class="codicon codicon-eye"></i><span>${notation || 'Read-only preview — sign in to make changes.'}</span>
           </div>`
        : '';

      container.innerHTML = `
        <div class="tool-view-container" style="display:flex;flex-direction:column;height:100%;width:100%;">
          <div class="tool-view-header" style="padding:8px 16px;border-bottom:1px solid var(--vscode-panel-border,#333);display:flex;align-items:center;gap:8px;">
            <i class="${viewDef?.icon || 'codicon codicon-extensions'}"></i>
            <span style="font-weight:600;">${label}</span>
          </div>
          ${banner}
          <iframe src="${bustedUrl}" allow="microphone; fullscreen" style="flex:1;border:none;width:100%;height:100%;" ${sandboxAttr}></iframe>
        </div>`;

      if (isGuestReadonly) {
        const iframeEl = container.querySelector('iframe');
        if (iframeEl) iframeEl.addEventListener('load', () => this._applyGuestReadonly(iframeEl));
      }
    } else {
      container.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--vscode-descriptionForeground,#999);">
          <div style="text-align:center;">
            <i class="${viewDef?.icon || 'codicon codicon-extensions'}" style="font-size:48px;margin-bottom:16px;display:block;"></i>
            <h3>${label}</h3>
            <p>No viewer URL configured for this tool. Set <code>iframeUrl</code> in the tool's UI config.</p>
          </div>
        </div>`;
    }
  }

  /**
   * @description Applies a read-only treatment inside a same-origin guest surface
   * iframe: dims and disables data-entry controls (inputs, textareas, selects,
   * contenteditable) and form submit buttons, while leaving navigation and reading
   * intact. The server already blocks the mutations (403); this just makes the dead
   * controls look dead. Best-effort — silently no-ops if the iframe is cross-origin.
   * @param {HTMLIFrameElement} iframeEl
   */
  _applyGuestReadonly(iframeEl) {
    try {
      const doc = iframeEl.contentDocument;
      if (!doc) return; // cross-origin / not ready
      // Explicit browser-local demos can accept taps without gaining any server capability. The
      // Tier-B guard still rejects every API mutation; this marker changes UX only.
      if (doc.body?.dataset?.guestLocalDemo === 'true') return;
      if (doc.getElementById('oshal-guest-readonly-style')) return; // already applied
      const style = doc.createElement('style');
      style.id = 'oshal-guest-readonly-style';
      style.textContent = `
        input:not([type=search]):not([type=hidden]), textarea, select,
        [contenteditable="true"], button[type="submit"], .btn-primary, [data-guest-block] {
          pointer-events: none !important;
          opacity: 0.5 !important;
          cursor: not-allowed !important;
        }`;
      (doc.head || doc.documentElement).appendChild(style);
    } catch {
      // Cross-origin surface — can't reach in; the banner + server 403 still cover it.
    }
  }

  // Seed the legacy placeholder composer when a bot handoff occurs outside the native embedded rail.
  seedLegacyChatInput(ticketInfo) {
    const input = document.getElementById('chatInput');
    const sendButton = document.getElementById('sendBtn');
    if (!(input instanceof HTMLTextAreaElement)) {
      return;
    }

    if (ticketInfo) {
      input.value = `Let's discuss ticket ${this.formatTicketSeed(ticketInfo)} `;
      window.setTimeout(() => input.focus(), 0);
      if (sendButton instanceof HTMLButtonElement) {
        sendButton.disabled = false;
      }
      return;
    }

    window.setTimeout(() => input.focus(), 0);
  }

  // Format one operator-facing ticket label for legacy placeholder prefills.
  formatTicketSeed(ticketInfo) {
    if (typeof ticketInfo === 'object' && ticketInfo !== null) {
      const sequenceId = ticketInfo.sequenceId || ticketInfo.ticketId || ticketInfo.uuid || '';
      const name = ticketInfo.name || '';
      const folder = ticketInfo.folder || '';
      return `#${sequenceId}${name ? ` — ${name}` : ''}${folder ? ` (folder: ${folder})` : ''}`;
    }

    if (typeof ticketInfo === 'string' || typeof ticketInfo === 'number') {
      return `#${ticketInfo}`;
    }

    return '#';
  }
}
