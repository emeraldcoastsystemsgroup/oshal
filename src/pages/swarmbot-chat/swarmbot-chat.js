/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Clarified OpenAI Codex auth as one shared Docker-runtime sign-in for all Codex bots in the swarm workspace
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added a dedicated bot-scoped swarm workspace controller for cockpit and direct swarm-bot chat usage
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added provider auth status and sign-in/sign-out controls to the dedicated swarm-bot workspace
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Wired dedicated RAG and Presentron workspace actions so cockpit right-rail buttons no longer redirect to generic settings
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added native switch-framework modal wiring so cockpit tools action edits per-tool auth modes in-rail
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Routed settings action to a native quick-settings workspace with profile save and optional advanced-config jump
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Removed duplicated local history handlers now owned by the workspace-actions controller to keep chat app under the file-size trigger
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Routed advanced bot settings handoff to top-level bot-scoped /config navigation rather than in-frame takeover
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added pop-out button handler for iframe embed mode
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log attribution for governance compliance during engineering-screen retrofit work
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Wired the swarm-bot workspace to the shared knowledge popup used by cockpit and chat
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Added URL-driven workspace deep links so external surfaces can open the shared knowledge modal on arrival
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Reused the shared Presentron studio inside swarm-bot chat and routed service configuration to shared swarm config admin
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Switched PM ticket-intake chats onto the new ticket-linked task returned by the server so direct swarmbot chat stops writing queue work into one generic PM thread
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Replaced missing-agent bootstrap failure with a waiting state so the embedded swarmbot panel can recover after bot selection
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Synced embedded swarmbot theme changes with cockpit so the right rail follows the shared shell theme without a reload mismatch
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Guest-aware bootstrap: anonymous guest sessions (public demo) get a stable read-only shell instead of minting a chat task — POST /api/tasks is Tier-B-blocked for guests, so the old path 403'd and the embed retried the failed bootstrap forever. Guest state resolves once from /api/auth/user (fail-open so a hiccup never costs a real user chat); composer disabled with a sign-in pointer.
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Bubble rendering (appendMessage, read-aloud, escapeHtml) extracted to swarmbot-messages.js — this file was past the 800 code-line trigger. Assistant bubbles now render through the shared response renderer there (parseResponse + renderBlocks via /dist/response-renderer.js) with the escaped plain-text bubble as the always-present graceful fallback.
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Retired the Presentron studio popup (deleted upstream); the toolbar presentation button (#openAiOfficeBtn) now opens the office-suite AI Office surface. Dropped the orphaned openSharedRuntimeConfig helper (pointed at the removed Presentron config section).
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Wired the surface-bridge producer: live assistant replies run through relayReply (parses the reply's oshal:surface fence → posts validated bot→surface ops to the shell relay; the bubble shows the fence-stripped text), history replay runs stripDirectives (strip-only, no re-emit), and a relayed inbound surface→bot op (select/field_change/submit/event) is turned into a chat message and dispatched to the bot — closing the chat↔surface loop. Extracted dispatchMessage from sendMessage so the composer and inbound selections share one send path.
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Import the surface-bridge producer from its new SHARED home (/shared/ui/js/, next to surface-bridge-client.js) — it moved out of this pages slice so an app surface (workflow-studio talk-to-build) can share it without a pages→pages cross-slice import. No behaviour change here; default postTarget stays the chat-rail (parent/shell-relay) path.
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | CORE-05: render the server's honest ai_disabled state in chat instead of leaving an unhandled send error or noop-looking reply.
 */

import { initializeSharedRagWorkspacePopup } from '/chat-assets/chat-rag-workspace-popup.mjs';
import { SwarmBotWorkspaceActions } from '/swarmbot/chat/swarmbot-workspace-actions.js';
import { appendMessage } from '/swarmbot/chat/swarmbot-messages.js';
import { createSurfaceProducer } from '/shared/ui/js/surface-bridge-producer.js';
import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('swarmbot-chat');
const COCKPIT_CONTEXT_EVENT = 'oshal-cockpit-context';
const COCKPIT_WORKSPACE_ACTION_EVENT = 'oshal-cockpit-workspace-action';
const COCKPIT_WORKSPACE_ACTION_ACK_EVENT = 'oshal-cockpit-workspace-action-ack';
const COCKPIT_WORKSPACE_READY_EVENT = 'oshal-cockpit-workspace-ready';
const COCKPIT_LOAD_TASK_EVENT = 'oshal-cockpit-load-task';
const COCKPIT_THEME_EVENT = 'oshal-cockpit-theme';
const SUPPORTED_THEMES = ['midnight', 'daylight', 'ocean', 'sakura', 'forest', 'gray', 'black', 'light-blue', 'aurora', 'graphite', 'amber'];
const PROVIDER_AUTH_CONFIG = {
  'auto': {
    configOnly: true,
    title: 'Auto (Global Config)',
    infoText: 'This bot inherits the provider from the global configuration set in Settings.',
  },
  'openai-codex': {
    statusEndpoint: '/api/openai-codex/oauth/status',
    startEndpoint: '/api/openai-codex/oauth/start',
    signOutEndpoint: '/api/openai-codex/oauth/signout',
    title: 'OpenAI Codex Authentication',
    signInLabel: 'Sign In For All Codex Bots',
    signOutLabel: 'Sign Out Shared Codex Session',
    infoText: 'OpenAI Codex sign-in is shared across every Codex-configured bot in this OSHAL Docker runtime. You only need to complete this once.',
  },
  'claude-code': {
    statusEndpoint: '/api/claude-code/auth/status',
    startEndpoint: '/api/claude-code/auth/start',
    signOutEndpoint: '/api/claude-code/auth/signout',
    title: 'Claude Code Authentication',
    signInLabel: 'Sign In',
    signOutLabel: 'Sign Out',
    infoText: 'This bot uses Claude Code CLI auth. Sign in here to unlock Claude-backed swarm runs.',
  },
};

class SwarmBotWorkspaceApp {
  constructor() {
    this.state = {
      agentId: readQueryValue('agentId'),
      agentLabel: readQueryValue('agentLabel'),
      initialWorkspaceAction: readQueryValue('openWorkspace').toLowerCase(),
      taskId: readQueryValue('taskId'),
      connected: false,
      eventSource: null,
      profile: null,
      typing: false,
      auth: createPendingAuthState(),
    };

    this.elements = {
      agentSummary: document.getElementById('agentSummary'),
      authInfoText: document.getElementById('authInfoText'),
      authPanelTitle: document.getElementById('authPanelTitle'),
      authSignInBtn: document.getElementById('authSignInBtn'),
      authSignOutBtn: document.getElementById('authSignOutBtn'),
      authStatusBadge: document.getElementById('authStatusBadge'),
      closeHistoryBtn: document.getElementById('closeHistoryBtn'),
      closeQuickSettingsBtn: document.getElementById('closeQuickSettingsBtn'),
      closeToolsConfigBtn: document.getElementById('closeToolsConfigBtn'),
      composerForm: document.getElementById('composerForm'),
      cockpitContextSummary: document.getElementById('cockpitContextSummary'),
      connectionStatus: document.getElementById('connectionStatus'),
      historyList: document.getElementById('historyList'),
      historyModal: document.getElementById('historyModal'),
      messageArea: document.getElementById('messageArea'),
      messageInput: document.getElementById('messageInput'),
      modelSummary: document.getElementById('modelSummary'),
      openAiOfficeBtn: document.getElementById('openAiOfficeBtn'),
      openRagBtn: document.getElementById('openRagBtn'),
      openHistoryBtn: document.getElementById('openHistoryBtn'),
      openSettingsBtn: document.getElementById('openSettingsBtn'),
      openAdvancedConfigBtn: document.getElementById('openAdvancedConfigBtn'),
      openToolsBtn: document.getElementById('openToolsBtn'),
      providerSummary: document.getElementById('providerSummary'),
      ragCollectionInput: document.getElementById('ragCollectionInput'),
      ragCollectionsList: document.getElementById('ragCollectionsList'),
      ragFileInput: document.getElementById('ragFileInput'),
      ragHealthBtn: document.getElementById('ragHealthBtn'),
      ragModal: document.getElementById('ragModal'),
      ragResults: document.getElementById('ragResults'),
      ragSearchBtn: document.getElementById('ragSearchBtn'),
      ragSearchInput: document.getElementById('ragSearchInput'),
      ragStatus: document.getElementById('ragStatus'),
      ragUploadBtn: document.getElementById('ragUploadBtn'),
      sendBtn: document.getElementById('sendBtn'),
      saveQuickSettingsBtn: document.getElementById('saveQuickSettingsBtn'),
      statusBanner: document.getElementById('statusBanner'),
      taskId: document.getElementById('taskId'),
      quickSettingsModal: document.getElementById('quickSettingsModal'),
      quickSettingsNameInput: document.getElementById('quickSettingsNameInput'),
      quickSettingsProjectUrlInput: document.getElementById('quickSettingsProjectUrlInput'),
      quickSettingsProviderSelect: document.getElementById('quickSettingsProviderSelect'),
      quickSettingsStatusSelect: document.getElementById('quickSettingsStatusSelect'),
      quickSettingsModelInput: document.getElementById('quickSettingsModelInput'),
      quickSettingsSkillsInput: document.getElementById('quickSettingsSkillsInput'),
      quickSettingsThemeSelect: document.getElementById('quickSettingsThemeSelect'),
      quickSettingsRuntimeInput: document.getElementById('quickSettingsRuntimeInput'),
      quickSettingsExcludeBulkInput: document.getElementById('quickSettingsExcludeBulkInput'),
      quickSettingsStatus: document.getElementById('quickSettingsStatus'),
      configureAllUnsetQuickSettingsBtn: document.getElementById('configureAllUnsetQuickSettingsBtn'),
      configureAllQuickSettingsBtn: document.getElementById('configureAllQuickSettingsBtn'),
      switchFrameworkList: document.getElementById('switchFrameworkList'),
      switchFrameworkModal: document.getElementById('switchFrameworkModal'),
      switchFrameworkStatus: document.getElementById('switchFrameworkStatus'),
      closeSwitchFrameworkBtn: document.getElementById('closeSwitchFrameworkBtn'),
      refreshSwitchFrameworkBtn: document.getElementById('refreshSwitchFrameworkBtn'),
      toolsConfigFrame: document.getElementById('toolsConfigFrame'),
      toolsConfigModal: document.getElementById('toolsConfigModal'),
      workspaceSubtitle: document.getElementById('workspaceSubtitle'),
      workspaceTitle: document.getElementById('workspaceTitle'),
      closeRagBtn: document.getElementById('closeRagBtn'),
    };

    this.ragWorkspace = initializeSharedRagWorkspacePopup({
      openButtonId: 'openRagBtn',
      modalId: 'ragModal',
      workspaceLabel: 'Knowledge Base',
      settingsButtonLabel: 'Bot Settings',
      closePeerModals: () => this.closeSiblingWorkspaceModals(),
      openCoreBotSettings: () => this.openBotScopedConfig(),
      resolveActiveAgentId: () => this.state.agentId,
      resolveActiveTaskId: () => this.state.taskId,
      resolveActiveAgentLabel: () => this.state.agentLabel || readString(this.state.profile?.name),
    });
    this.workspaceActions = new SwarmBotWorkspaceActions({
      elements: this.elements,
      requestJson,
      setStatus: (message, tone) => this.setStatus(message, tone),
      getAgentId: () => this.state.agentId,
      getTaskId: () => this.state.taskId,
      openAdvancedConfig: () => this.openBotScopedConfig(),
      onProfileUpdated: (profile) => this.applyUpdatedProfile(profile),
      ragWorkspace: this.ragWorkspace,
    });
    // Surface-bridge producer: emits bot→surface ops parsed from assistant replies to the focused
    // app's surface (via the cockpit relay), and turns relayed surface→bot selections into messages.
    this.surfaceProducer = createSurfaceProducer({ win: window });
  }

  async init() {
    logger.info('Initializing swarmbot workspace', {
      agentId: this.state.agentId || null,
      taskId: this.state.taskId || null,
      embedded: isEmbedded(),
    });
    this.bindEvents();
    this.notifyParentWorkspaceReady();
    this.renderStaticShell();
    await this.bootstrapWorkspace();
  }

  bindEvents() {
    this.elements.composerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await this.sendMessage();
    });
    this.elements.authSignInBtn.addEventListener('click', async () => {
      await this.startProviderAuth();
    });
    this.elements.authSignOutBtn.addEventListener('click', async () => {
      await this.signOutProviderAuth();
    });
    this.workspaceActions.bindEvents();
    document.getElementById('popOutBtn')?.addEventListener('click', () => {
      const url = new URL(window.location.href);
      url.searchParams.delete('embed');
      window.open(url.toString(), '_blank', 'noopener');
    });
    window.addEventListener('message', (event) => this.handleParentMessage(event));
  }

  async bootstrapWorkspace() {
    if (!this.state.agentId) {
      logger.info('Swarmbot workspace waiting for bot selection');
      this.renderAwaitingAgentSelectionState();
      this.setStatus(isEmbedded()
        ? 'Select a swarm bot to load this workspace.'
        : 'Choose a swarm bot to begin.', 'info');
      return;
    }

    const startedAt = Date.now();
    logger.info('Bootstrapping swarmbot workspace', {
      agentId: this.state.agentId,
      taskId: this.state.taskId || null,
    });
    if (await this.resolveGuestMode()) {
      // Guests cannot mint chat tasks (guest tier blocks POST /api/tasks) — render a
      // stable read-only shell instead of failing bootstrap into a retry loop.
      await this.loadProfile().catch(() => {});
      this.renderGuestReadOnlyState();
      return;
    }
    await this.loadProfile();
    await this.ensureTask();
    await this.loadMessages();
    this.connectStream();
    this.openInitialWorkspaceAction();
    logger.info('Swarmbot workspace bootstrap complete', {
      agentId: this.state.agentId,
      taskId: this.state.taskId || null,
      durationMs: Date.now() - startedAt,
    });
  }

  async loadProfile() {
    logger.debug('Loading swarmbot profile', {
      agentId: this.state.agentId,
    });
    const payload = await requestJson(`/api/agents/${encodeURIComponent(this.state.agentId)}/profile`);
    this.state.profile = payload?.profile || null;
    if (this.state.profile?.themePreference) {
      this.applyTheme(this.state.profile.themePreference);
    }
    this.renderAgentState();
    await this.refreshProviderAuthStatus();
    logger.info('Loaded swarmbot profile', {
      agentId: this.state.agentId,
      providerId: readString(this.state.profile?.providerId) || null,
      modelId: readString(this.state.profile?.modelId) || null,
    });
  }

  async ensureTask() {
    if (this.state.taskId) {
      logger.debug('Reusing existing swarmbot task', {
        taskId: this.state.taskId,
      });
      this.renderTaskId();
      return;
    }

    logger.info('Creating swarmbot task', {
      agentId: this.state.agentId,
    });
    const task = await requestJson('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: '',
        processingMode: 'agentic',
        agentId: this.state.agentId,
        metadata: { source: 'swarmbot-chat' },
      }),
    });
    this.state.taskId = readString(task?.taskId);
    this.renderTaskId();
    this.syncParentTask();
    syncUrlState(this.state);
    logger.info('Created swarmbot task', {
      taskId: this.state.taskId || null,
      agentId: this.state.agentId,
    });
  }

  async loadMessages() {
    if (!this.state.taskId) {
      return;
    }

    logger.debug('Loading swarmbot messages', {
      taskId: this.state.taskId,
    });
    const payload = await requestJson(`/api/${encodeURIComponent(this.state.taskId)}/messages`);
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    this.renderMessages(messages);
    logger.info('Loaded swarmbot messages', {
      taskId: this.state.taskId,
      count: messages.length,
    });
  }

  connectStream() {
    if (!this.state.taskId) {
      return;
    }

    this.disconnectStream();
    logger.info('Connecting swarmbot event stream', {
      taskId: this.state.taskId,
    });
    this.state.eventSource = new EventSource(`/api/stream/${encodeURIComponent(this.state.taskId)}`);
    this.state.eventSource.addEventListener('streaming-event', (event) => this.handleStreamEvent(event));
    this.state.eventSource.onerror = () => {
      logger.warn('Swarmbot event stream disconnected', {
        taskId: this.state.taskId || null,
      });
      this.state.connected = false;
      this.renderConnection();
      this.setStatus('Live stream disconnected. The page will keep polling task history on refresh.', 'error');
    };
  }

  disconnectStream() {
    if (this.state.eventSource) {
      this.state.eventSource.close();
      this.state.eventSource = null;
    }
  }

  /**
   * @description Resolves (once) whether this session is an anonymous guest. Fails
   * open to non-guest so an /api/auth/user hiccup never costs a real user their chat.
   * @returns {Promise<boolean>} True when browsing as a guest.
   */
  async resolveGuestMode() {
    if (typeof this.state.guestMode === 'boolean') {
      return this.state.guestMode;
    }
    try {
      const payload = await requestJson('/api/auth/user');
      this.state.guestMode = payload?.guestMode === true || payload?.user?.is_guest === true;
    } catch {
      this.state.guestMode = false;
    }
    return this.state.guestMode;
  }

  /**
   * @description Stable guest shell: no task mint, no stream, composer disabled —
   * the honest read-only state the public demo promises, with a sign-in pointer.
   */
  renderGuestReadOnlyState() {
    this.elements.connectionStatus.textContent = 'Guest';
    this.elements.messageInput.disabled = true;
    this.elements.messageInput.placeholder = 'Guest sessions are read-only';
    this.elements.sendBtn.disabled = true;
    this.elements.messageArea.innerHTML = '<div class="empty-state">You are browsing as a guest &mdash; the cockpit is open to explore, but chatting with the swarm needs an account. <a href="/login">Sign in with Google</a> and your workspace is created instantly.</div>';
    this.setStatus('Guest session: this workspace is read-only.', 'info');
  }

  async sendMessage() {
    if (this.state.guestMode) {
      this.setStatus('Guest session: chat is read-only. Sign in to talk to the swarm.', 'info');
      return;
    }
    const text = readString(this.elements.messageInput.value);
    if (!text || !this.state.taskId) {
      return;
    }

    this.elements.messageInput.value = '';
    await this.dispatchMessage(text);
  }

  /**
   * @description Sends one message to the active bot. Shared by the composer and by inbound
   * surface-bridge selections (consumeInbound) so both hit the same accountable send path.
   * @param {string} text - The message text to send.
   */
  async dispatchMessage(text) {
    const body = readString(text);
    if (this.state.guestMode || !body || !this.state.taskId) {
      return;
    }

    appendMessage(this.elements.messageArea, 'user', 'You', body);
    this.setTyping(true);
    this.setStatus(`Sending message through ${this.getDisplayName()}...`, 'info');

    try {
      const payload = await requestJson('/api/send-message', {
        method: 'POST',
        body: JSON.stringify({
          taskId: this.state.taskId,
          text: body,
          agenticMode: true,
          source: 'swarmbot-chat',
          agentId: this.state.agentId,
        }),
      });
      await this.syncTaskContextFromSendResponse(payload);
    } catch (error) {
      const message = toErrorMessage(error);
      this.setTyping(false);
      appendMessage(this.elements.messageArea, 'assistant', 'AI unavailable', message);
      this.setStatus(message, 'error');
    }
  }

  openConfigModal() {
    const href = buildBotConfigUrl(this.state.agentId);
    this.elements.toolsConfigFrame.setAttribute('src', href);
    this.elements.toolsConfigModal.hidden = false;
  }

  openBotScopedConfig() {
    const href = buildBotConfigUrl(this.state.agentId);
    window.location.assign(href);
  }

  closeConfigModal() {
    this.elements.toolsConfigModal.hidden = true;
    this.elements.toolsConfigFrame.setAttribute('src', 'about:blank');
  }

  closeSiblingWorkspaceModals() {
    this.elements.historyModal.hidden = true;
    this.elements.quickSettingsModal.hidden = true;
    this.elements.switchFrameworkModal.hidden = true;
    this.closeConfigModal();
  }

  handleParentMessage(event) {
    if (event.origin !== window.location.origin || !event.data) {
      return;
    }

    if (event.data.type === COCKPIT_CONTEXT_EVENT) {
      this.updateContext(event.data.agentId, event.data.agentLabel);
      return;
    }

    if (event.data.type === COCKPIT_THEME_EVENT) {
      this.applyTheme(event.data.theme);
      return;
    }

    if (event.data.type === COCKPIT_WORKSPACE_ACTION_EVENT) {
      const action = readString(event.data.action);
      this.handleWorkspaceAction(action);
      window.parent?.postMessage(
        { type: COCKPIT_WORKSPACE_ACTION_ACK_EVENT, action },
        window.location.origin,
      );
      return;
    }

    // Inbound surface-bridge op (a selection/edit/confirmation the focused app's surface emitted,
    // relayed here by the cockpit). Turn it into a chat message so the selection reaches the bot.
    const bridgeMessage = this.surfaceProducer.consumeInbound(event.data);
    if (bridgeMessage) {
      void this.dispatchMessage(bridgeMessage);
    }
  }

  updateContext(agentId, agentLabel) {
    const nextAgentId = readString(agentId);
    const nextAgentLabel = readString(agentLabel);
    if (!nextAgentId || nextAgentId === this.state.agentId) {
      this.state.agentLabel = nextAgentLabel || this.state.agentLabel;
      this.renderAgentState();
      return;
    }

    this.state.agentId = nextAgentId;
    this.state.agentLabel = nextAgentLabel;
    this.state.taskId = '';
    this.state.auth = createPendingAuthState();
    this.disconnectStream();
    this.workspaceActions.closeAll();
    this.elements.messageArea.innerHTML = '';
    this.renderStaticShell();
    void this.bootstrapWorkspace();
  }

  handleWorkspaceAction(action) {
    if (this.workspaceActions.handleWorkspaceAction(action)) {
      this.setStatus(`Opened ${action.toUpperCase()} workspace for ${this.getDisplayName()}.`, 'info');
    }
  }

  openInitialWorkspaceAction() {
    if (!this.state.initialWorkspaceAction) {
      return;
    }

    const action = this.state.initialWorkspaceAction;
    this.state.initialWorkspaceAction = '';
    consumeWorkspaceActionQuery();
    this.handleWorkspaceAction(action);
  }

  handleStreamEvent(event) {
    const payload = parseJson(event.data);
    if (!payload) {
      return;
    }

    if (payload.type === 'connection') {
      this.state.connected = true;
      this.renderConnection();
      this.setStatus(`Connected to ${this.getDisplayName()}.`, 'success');
      return;
    }

    if (payload.type === 'heartbeat') {
      this.state.connected = true;
      this.renderConnection();
      return;
    }

    if (payload.type === 'task_update') {
      const nextStatus = readString(payload?.task?.status) || readString(payload?.task?.taskSnapshot?.status) || 'active';
      this.setStatus(`Task status: ${nextStatus.replaceAll('_', ' ')}.`, 'info');
      return;
    }

    if (payload.type === 'message') {
      const message = payload.message || {};
      // relayReply emits any bot→surface ops declared in the reply, and returns the fence-stripped
      // text so the bubble shows the human answer without the control syntax.
      const shown = this.surfaceProducer.relayReply(readString(message.text));
      appendMessage(this.elements.messageArea, 'assistant', this.getDisplayName(), shown);
      this.setTyping(false);
      return;
    }

    if (payload.type === 'error') {
      this.setTyping(false);
      this.setStatus(readString(payload.error) || 'Chat stream failed.', 'error');
    }
  }

  renderMessages(messages) {
    this.elements.messageArea.innerHTML = '';
    if (!messages.length) {
      this.elements.messageArea.innerHTML = '<div class="empty-state">This bot is ready. Start the next swarm conversation from here.</div>';
      return;
    }

    messages.forEach((message) => {
      const role = readString(message.role) || 'assistant';
      const author = role === 'user' ? 'You' : this.getDisplayName();
      const raw = readString(message.text);
      // History replay: strip the surface fence WITHOUT re-emitting — these ops already drove the
      // surface when they were live, so re-posting them would double-apply on reload.
      const text = role === 'assistant' ? this.surfaceProducer.stripDirectives(raw) : raw;
      appendMessage(this.elements.messageArea, role, author, text);
    });
    this.scrollMessages();
  }

  syncParentTask() {
    if (!isEmbedded() || !this.state.taskId) {
      return;
    }

    window.parent.postMessage({ type: COCKPIT_LOAD_TASK_EVENT, taskId: this.state.taskId }, window.location.origin);
  }

  notifyParentWorkspaceReady() {
    if (!isEmbedded()) {
      return;
    }

    window.parent.postMessage({ type: COCKPIT_WORKSPACE_READY_EVENT }, window.location.origin);
  }

  renderStaticShell() {
    this.renderAgentState();
    this.renderTaskId();
    this.renderConnection();
    this.renderAuthState();
  }

  renderAwaitingAgentSelectionState() {
    this.elements.workspaceTitle.textContent = 'Swarm Bot Workspace';
    this.elements.workspaceSubtitle.textContent = isEmbedded()
      ? 'Waiting for cockpit bot selection.'
      : 'Waiting for bot selection.';
    this.elements.agentSummary.textContent = 'No swarm bot selected';
    this.elements.providerSummary.textContent = 'Awaiting bot';
    this.elements.modelSummary.textContent = 'Awaiting bot';
    this.elements.connectionStatus.textContent = 'Idle';
    this.state.auth = createPendingAuthState(
      'Select a swarm bot to inspect provider authentication.',
      'Awaiting bot selection...',
    );
    this.renderAuthState();
    this.elements.messageArea.innerHTML = '<div class="empty-state">Select a swarm bot from the cockpit and this workspace will hydrate automatically.</div>';
  }

  renderAgentState() {
    const displayName = this.getDisplayName();
    const providerLabel = readString(this.state.profile?.providerId) || 'Inherited runtime';
    const modelLabel = readString(this.state.profile?.modelId) || 'Inherited model';
    this.elements.workspaceTitle.textContent = displayName;
    this.elements.workspaceSubtitle.textContent = '';
    this.elements.agentSummary.textContent = '';
    this.elements.providerSummary.textContent = providerLabel;
    this.elements.modelSummary.textContent = modelLabel;
    this.elements.cockpitContextSummary.hidden = true;
  }

  renderAuthState() {
    const authConfig = getProviderAuthConfig(this.state.profile?.providerId);
    const authState = this.state.auth;
    this.elements.authPanelTitle.textContent = authConfig?.title || 'Provider Authentication Unavailable';
    this.elements.authInfoText.textContent = authState.infoText || authConfig?.infoText || 'This bot does not currently expose provider auth controls here.';
    this.elements.authStatusBadge.textContent = authState.label;
    this.elements.authStatusBadge.dataset.tone = authState.tone;
    this.elements.authSignInBtn.hidden = !authState.canSignIn;
    this.elements.authSignOutBtn.hidden = !authState.canSignOut;
    this.elements.authSignInBtn.title = authConfig?.signInLabel || 'Sign In';
    this.elements.authSignOutBtn.title = authConfig?.signOutLabel || 'Sign Out';
  }

  async refreshProviderAuthStatus() {
    const authConfig = getProviderAuthConfig(this.state.profile?.providerId);
    if (!authConfig) {
      this.state.auth = createUnsupportedAuthState(this.state.profile?.providerId);
      this.renderAuthState();
      return;
    }

    // Config-only providers (auto) — no OAuth flow, just show info
    if (authConfig.configOnly) {
      this.state.auth = {
        authenticated: true, canSignIn: false, canSignOut: false,
        infoText: authConfig.infoText, label: authConfig.title, tone: 'info',
      };
      this.renderAuthState();
      return;
    }

    this.state.auth = createLoadingAuthState(authConfig.infoText);
    this.renderAuthState();
    try {
      const payload = await requestJson(authConfig.statusEndpoint);
      this.state.auth = normalizeProviderAuthState(this.state.profile?.providerId, payload, authConfig.infoText);
    } catch (error) {
      this.state.auth = createErrorAuthState(authConfig.infoText, toErrorMessage(error));
      this.setStatus(`Failed to read ${getProviderLabel(this.state.profile?.providerId)} auth status.`, 'error');
    }
    this.renderAuthState();
  }

  async startProviderAuth() {
    const authConfig = getProviderAuthConfig(this.state.profile?.providerId);
    if (!authConfig) {
      return;
    }

    try {
      const result = await requestJson(authConfig.startEndpoint);
      const authUrl = readString(result?.authUrl);
      if (authUrl) {
        const popup = window.open(authUrl, `${readString(this.state.profile?.providerId)}-auth`, 'width=620,height=780');
        if (!popup) {
          window.location.assign(authUrl);
          return;
        }
      }
      this.setStatus(buildProviderSignInStartedMessage(this.state.profile?.providerId), 'info');
      this.state.auth = createPendingAuthState(authConfig.infoText, 'Waiting for sign-in to finish...');
      this.renderAuthState();
      await this.pollProviderAuthStatus();
    } catch (error) {
      this.state.auth = createErrorAuthState(authConfig.infoText, toErrorMessage(error));
      this.renderAuthState();
      this.setStatus(`Failed to start ${getProviderLabel(this.state.profile?.providerId)} sign-in.`, 'error');
    }
  }

  async signOutProviderAuth() {
    const authConfig = getProviderAuthConfig(this.state.profile?.providerId);
    if (!authConfig) {
      return;
    }

    try {
      await requestJson(authConfig.signOutEndpoint, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      this.setStatus(`${getProviderLabel(this.state.profile?.providerId)} credentials removed.`, 'success');
      await this.refreshProviderAuthStatus();
    } catch (error) {
      this.state.auth = createErrorAuthState(authConfig.infoText, toErrorMessage(error));
      this.renderAuthState();
      this.setStatus(`Failed to sign out ${getProviderLabel(this.state.profile?.providerId)}.`, 'error');
    }
  }

  async pollProviderAuthStatus() {
    const authConfig = getProviderAuthConfig(this.state.profile?.providerId);
    if (!authConfig) {
      return;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 180000) {
      await delay(2000);
      await this.refreshProviderAuthStatus();
      if (this.state.auth.authenticated) {
        this.setStatus(buildProviderSignInCompleteMessage(this.state.profile?.providerId), 'success');
        return;
      }
    }
    this.setStatus(buildProviderSignInTimeoutMessage(this.state.profile?.providerId), 'error');
  }

  renderTaskId() {
    this.elements.taskId.textContent = this.state.taskId || 'Creating task...';
  }

  renderConnection() {
    this.elements.connectionStatus.textContent = this.state.connected ? 'Connected' : 'Connecting...';
  }

  setTyping(active) {
    this.state.typing = active;
    this.removeTypingIndicator();
    if (active) {
      const indicator = document.createElement('div');
      indicator.id = 'typingIndicator';
      indicator.className = 'typing-indicator';
      indicator.textContent = `${this.getDisplayName()} is thinking...`;
      this.elements.messageArea.appendChild(indicator);
      this.scrollMessages();
    }
  }

  removeTypingIndicator() {
    document.getElementById('typingIndicator')?.remove();
  }

  setStatus(message, tone) {
    this.elements.statusBanner.textContent = message;
    this.elements.statusBanner.dataset.tone = tone;
  }

  applyTheme(theme) {
    const nextTheme = resolveTheme(theme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    try {
      window.localStorage.setItem('cockpit-theme', nextTheme);
    } catch (_error) {
      // Ignore storage failures so the workspace can still repaint in restricted contexts.
    }
  }

  async syncTaskContextFromSendResponse(payload) {
    const nextTaskId = readString(payload?.taskIdUsed || payload?.taskId);
    if (!nextTaskId || nextTaskId === this.state.taskId) {
      return;
    }

    this.state.taskId = nextTaskId;
    this.renderTaskId();
    syncUrlState(this.state);
    this.syncParentTask();
    this.disconnectStream();
    this.elements.messageArea.innerHTML = '';
    await this.loadMessages();
    this.connectStream();
    this.setTyping(false);

    const ticketId = readString(payload?.ticketId);
    if (ticketId) {
      this.setStatus(`Ticket ${ticketId.slice(0, 8)} created and linked to a dedicated PM thread.`, 'success');
    }
  }

  scrollMessages() {
    this.elements.messageArea.scrollTop = this.elements.messageArea.scrollHeight;
  }

  getDisplayName() {
    return readString(this.state.profile?.name) || this.state.agentLabel || this.state.agentId || 'Swarm Bot';
  }

  /**
   * @description Apply one updated selected-bot profile returned by quick-settings save.
   * @param {Record<string, unknown> | null} profile - Updated profile payload.
   */
  applyUpdatedProfile(profile) {
    if (!profile || typeof profile !== 'object') {
      return;
    }

    this.state.profile = {
      ...(this.state.profile || {}),
      ...profile,
    };
    if (profile.themePreference) {
      this.applyTheme(profile.themePreference);
    }
    this.renderAgentState();
    void this.refreshProviderAuthStatus();
  }
}

function readQueryValue(key) {
  return readString(new URLSearchParams(window.location.search).get(key));
}

function resolveTheme(theme) {
  return SUPPORTED_THEMES.includes(readString(theme)) ? readString(theme) : 'midnight';
}

function consumeWorkspaceActionQuery() {
  const url = new URL(window.location.href);
  url.searchParams.delete('openWorkspace');
  url.searchParams.delete('source');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function getProviderAuthConfig(providerId) {
  return PROVIDER_AUTH_CONFIG[readString(providerId)] || null;
}

function createPendingAuthState(infoText = 'Checking whether this swarm bot needs provider sign-in.', label = 'Checking authentication...') {
  return {
    authenticated: false,
    canSignIn: false,
    canSignOut: false,
    infoText,
    label,
    tone: 'info',
  };
}

function createLoadingAuthState(infoText) {
  return createPendingAuthState(infoText, 'Checking authentication...');
}

function createUnsupportedAuthState(providerId) {
  const providerLabel = getProviderLabel(providerId);
  return {
    authenticated: false,
    canSignIn: false,
    canSignOut: false,
    infoText: `This bot uses ${providerLabel}. Configure runtime details in the bot config workspace if needed.`,
    label: `No inline auth flow for ${providerLabel}`,
    tone: 'muted',
  };
}

function createErrorAuthState(infoText, message) {
  return {
    authenticated: false,
    canSignIn: true,
    canSignOut: false,
    infoText,
    label: readString(message) || 'Unable to read auth status',
    tone: 'error',
  };
}

function normalizeProviderAuthState(providerId, payload, infoText) {
  if (providerId === 'openai-codex') {
    return buildOpenAiCodexAuthState(payload, infoText);
  }

  if (providerId === 'claude-code') {
    return buildClaudeCodeAuthState(payload, infoText);
  }

  return createUnsupportedAuthState(providerId);
}

function buildOpenAiCodexAuthState(payload, infoText) {
  const authenticated = !!payload?.authenticated;
  return {
    authenticated,
    canSignIn: !authenticated,
    canSignOut: authenticated,
    infoText,
    label: authenticated ? `Signed in${readString(payload?.email) ? ` as ${readString(payload.email)}` : ''}` : 'Not signed in',
    tone: authenticated ? 'success' : 'info',
  };
}

function buildClaudeCodeAuthState(payload, infoText) {
  const available = payload?.available !== false;
  const authenticated = !!payload?.authenticated;
  const email = readString(payload?.email);
  const authMethod = readString(payload?.authMethod);
  return {
    authenticated,
    canSignIn: !authenticated && available,
    canSignOut: authenticated,
    infoText: available ? infoText : 'Claude CLI is unavailable on this machine. Install it before authenticating this bot.',
    label: !available ? 'Claude CLI unavailable' : buildClaudeCodeAuthLabel(authenticated, email, authMethod),
    tone: authenticated ? 'success' : (available ? 'info' : 'error'),
  };
}

function buildClaudeCodeAuthLabel(authenticated, email, authMethod) {
  if (!authenticated) {
    return 'Not signed in';
  }

  const emailSuffix = email ? ` as ${email}` : '';
  const methodSuffix = authMethod ? ` via ${authMethod}` : '';
  return `Signed in${emailSuffix}${methodSuffix}`;
}

function getProviderLabel(providerId) {
  return readString(providerId) || 'this provider';
}

function buildProviderSignInStartedMessage(providerId) {
  if (providerId === 'openai-codex') {
    return 'OpenAI Codex shared sign-in started for all Codex bots.';
  }
  return `${getProviderLabel(providerId)} sign-in started.`;
}

function buildProviderSignInCompleteMessage(providerId) {
  if (providerId === 'openai-codex') {
    return 'OpenAI Codex shared sign-in complete for all Codex bots.';
  }
  return `${getProviderLabel(providerId)} sign-in complete.`;
}

function buildProviderSignInTimeoutMessage(providerId) {
  if (providerId === 'openai-codex') {
    return 'OpenAI Codex shared sign-in timed out before the shared runtime reported success.';
  }
  return `${getProviderLabel(providerId)} sign-in timed out.`;
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

async function requestJson(url, options = {}) {
  const method = options.method || 'GET';
  const startedAt = Date.now();
  logger.debug('Swarmbot request started', {
    url,
    method,
  });
  const response = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await parseResponseJson(response);
  if (!response.ok) {
    const errorMessage = readString(payload?.message || payload?.error) || `${response.status} ${response.statusText}`;
    logger.warn('Swarmbot request failed', {
      url,
      method,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorMessage,
    });
    throw new Error(errorMessage);
  }
  logger.info('Swarmbot request completed', {
    url,
    method,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return payload;
}

async function parseResponseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    logger.warn('Swarmbot response parsing failed', {
      status: response.status,
      error: serializeUiError(error),
    });
    return null;
  }
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(durationMs) {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function syncUrlState(state) {
  const params = new URLSearchParams(window.location.search);
  writeQueryValue(params, 'agentId', state.agentId);
  writeQueryValue(params, 'agentLabel', state.agentLabel);
  writeQueryValue(params, 'taskId', state.taskId);
  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

function writeQueryValue(params, key, value) {
  const nextValue = readString(value);
  if (!nextValue) {
    params.delete(key);
    return;
  }
  params.set(key, nextValue);
}

function buildBotConfigUrl(agentId) {
  const normalizedAgentId = readString(agentId);
  const params = new URLSearchParams();
  if (normalizedAgentId) {
    params.set('agentId', normalizedAgentId);
  }
  params.set('scope', 'agent');
  return `/config/?${params.toString()}#agentConfigSection`;
}

function isEmbedded() {
  return document.documentElement.getAttribute('data-embedded') === 'cockpit';
}

const app = new SwarmBotWorkspaceApp();
void app.init().catch((error) => {
  logger.error('Swarmbot workspace bootstrap failed', {
    error: serializeUiError(error),
  });
});
