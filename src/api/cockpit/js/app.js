/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

import { ThemeManager } from './theme-manager.js';
import { ApiClient } from './api-client.js';
import { formatCost, formatTime, timeAgo, getStatusClass, getStatusLabel, truncate } from './utils/formatters.js';
import { RibbonNav } from './components/RibbonNav.js';
import { TicketView } from './views/TicketView.js';
import { ChatView } from './views/ChatView.js';
import { CalendarView } from './views/CalendarView.js';
import { AddressBookView } from './views/AddressBookView.js';
import { DashboardView } from './views/DashboardView.js';
import { SettingsView } from './views/SettingsView.js';
import { AdvancedView } from './views/AdvancedView.js';

const DASHBOARD_TASK_KEY = 'cockpit-dashboard-taskId';
function saveDashboardTaskId(taskId) { try { sessionStorage.setItem(DASHBOARD_TASK_KEY, taskId); } catch(e) {} }
function loadDashboardTaskId() { try { return sessionStorage.getItem(DASHBOARD_TASK_KEY); } catch(e) { return null; } }
function clearDashboardTaskId() { try { sessionStorage.removeItem(DASHBOARD_TASK_KEY); } catch(e) {} }

class CockpitApp {
  constructor() {
    this.api = new ApiClient(); // Now includes cost tracking!
    this.theme = new ThemeManager();
    this.currentTaskId = null;
    this.currentTask = null;
    this.currentView = null;
    this.pollTimers = [];
    this.testMode = false;
    this.isProcessing = false;
    this.messageRenderer = (typeof MessageRenderer !== 'undefined') ? new MessageRenderer() : null;
    this.mockBot = (typeof MockUIBot !== 'undefined') ? new MockUIBot() : null;
    this.streamingClient = null;
    this.allMessages = [];
    this.renderedMessageTimestamps = new Set();
    this.settings = { autoApprove: false };
    this.SESSION_ID = 'cockpit-' + Date.now();
    this.totalTokensIn = 0;
    this.totalTokensOut = 0;
    this.totalCost = 0;
    this.ribbon = null;
    this.activeViewInstance = null;

    this.init();
  }

  async init() {
    this.initRibbon();
    this.bindChatEvents();
    this.initStreaming();
    this.initRAGWidget();
    this.initMeshChat();
    this.initCostIndicator();
    this.loadBots();
    this.loadMetrics();
    this.startPolling();
    this.restoreSession();
    this.initResizeHandle();
  }

  // ═══ COST INDICATOR ═══
  initCostIndicator() {
    // Listen for cost updates from ApiClient
    window.addEventListener('cost-updated', (event) => {
      this.updateCostIndicator(event.detail);
    });
    
    // Initial update
    this.updateCostIndicator(this.api.getCostStatus());
  }

  updateCostIndicator(costStatus) {
    const statusCostEl = document.getElementById('statusCost');
    if (!statusCostEl) return;
    
    // Update status bar with current costs
    const dailySpent = costStatus.dailySpent || 0;
    const dailyLimit = costStatus.dailyLimit;
    const bucketSpent = costStatus.bucketSpent || 0;
    const bucketLimit = costStatus.bucketLimit;
    
    let displayText = formatCost(dailySpent);
    let status = 'normal';
    
    // Show warning if approaching limits
    if (dailyLimit && dailySpent >= dailyLimit * 0.9) {
      status = 'warning';
      displayText += ` ⚠️`;
    } else if (bucketLimit && bucketSpent >= bucketLimit * 0.9) {
      status = 'warning';
      displayText += ` ⚠️`;
    }
    
    // Show limit reached
    if (costStatus.dailyLimitReached || costStatus.bucketLimitReached) {
      status = 'error';
      displayText += ` 🚫`;
    }
    
    statusCostEl.textContent = displayText;
    statusCostEl.className = `status-cost status-${status}`;
    statusCostEl.title = this.getCostTooltip(costStatus);
  }

  getCostTooltip(costStatus) {
    const parts = [];
    
    if (costStatus.dailyLimit) {
      parts.push(`Daily: $${costStatus.dailySpent.toFixed(4)} / $${costStatus.dailyLimit.toFixed(2)}`);
    } else {
      parts.push(`Daily: $${costStatus.dailySpent.toFixed(4)} (no limit)`);
    }
    
    if (costStatus.bucketLimit) {
      parts.push(`Bucket: $${costStatus.bucketSpent.toFixed(4)} / $${costStatus.bucketLimit.toFixed(2)}`);
    } else {
      parts.push(`Bucket: $${costStatus.bucketSpent.toFixed(4)} (no limit)`);
    }
    
    return parts.join('\n');
  }

  // ═══ RIBBON NAVIGATION ═══
  initRibbon() {
    this.ribbon = new RibbonNav('ribbonContainer', (viewId) => this.switchView(viewId));
    this.switchView('tickets');
  }

  async switchView(viewId) {
    if (this.activeViewInstance?.destroy) this.activeViewInstance.destroy();
    this.activeViewInstance = null;
    const container = document.getElementById('mainContent');
    if (!container) return;

const chatWithBot = (botId, ticketInfo) => {
  // Ensure chat panel is visible
  this.toggleChatPanel(true);
  // Set bot selector
  const sel = document.getElementById('botSelector');
  if (sel && botId) {
    // Try to select the bot
    const opt = Array.from(sel.options).find(o => o.value === botId);
    if (opt) sel.value = botId;
  }
  // Preload message with ticket context
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  if (input && ticketInfo) {
    // Accepts either string (legacy) or object (new)
    let ticketStr = '';
    if (typeof ticketInfo === 'object' && ticketInfo !== null) {
      const seq = ticketInfo.sequenceId || ticketInfo.ticketId || ticketInfo.uuid || '';
      const name = ticketInfo.name || '';
      const folder = ticketInfo.folder || '';
      ticketStr = `#${seq}${name ? ` — ${name}` : ''}${folder ? ` (folder: ${folder})` : ''}`;
    } else if (typeof ticketInfo === 'string' || typeof ticketInfo === 'number') {
      ticketStr = `#${ticketInfo}`;
    } else {
      ticketStr = '';
    }
    input.value = `Let's discuss ticket ${ticketStr} `;
    setTimeout(() => input.focus(), 0); // Ensure focus after panel expands
    if (sendBtn) sendBtn.disabled = false;
  } else if (input) {
    setTimeout(() => input.focus(), 0);
  }
};

    switch (viewId) {
      case 'tickets': {
        const view = new TicketView(container, { onChatWithBot: chatWithBot });
        this.activeViewInstance = view;
        await view.render();
        break;
      }
      case 'chat': {
        const view = new ChatView(container, {
          onSelectConversation: (taskId) => this.loadTask(taskId),
          onNewChat: () => this.newChat()
        });
        this.activeViewInstance = view;
        await view.render();
        break;
      }
      case 'calendar': {
        const view = new CalendarView(container);
        this.activeViewInstance = view;
        await view.render();
        break;
      }
      case 'addressbook': {
        const view = new AddressBookView(container, {
          onMessageBot: (botId) => chatWithBot(botId),
          onCreateTicket: (botId) => chatWithBot(botId),
          onViewActivity: (botId) => {
            this.ribbon.setActive('calendar');
          }
        });
        this.activeViewInstance = view;
        await view.render();
        break;
      }
      case 'dashboard': {
        const view = new DashboardView(container);
        this.activeViewInstance = view;
        await view.render();
        break;
      }
      case 'settings': {
        const view = new SettingsView(container, {
          onThemeChange: (t) => this.theme.apply(t)
        });
        this.activeViewInstance = view;
        await view.render();
        break;
      }
      case 'advanced': {
        const view = new AdvancedView(container);
        this.activeViewInstance = view;
        await view.render();
        break;
      }
    }
  }

  // ═══ RESIZE HANDLE ═══
  initResizeHandle() {
    const handle = document.getElementById('resizeChat');
    const mainContent = document.getElementById('mainContent');
    const chatPanel = document.getElementById('chatPanel');
    if (!handle || !mainContent || !chatPanel) return;

    let startX, startMainW, startChatW;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startMainW = mainContent.getBoundingClientRect().width;
      startChatW = chatPanel.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.classList.add('resizing');

      let raf = null;
      const onMove = (e) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          const dx = e.clientX - startX;
          const newMain = Math.max(300, startMainW + dx);
          const newChat = Math.max(240, startChatW - dx);
          mainContent.style.width = newMain + 'px';
          mainContent.style.flex = 'none';
          chatPanel.style.width = newChat + 'px';
          chatPanel.style.flex = 'none';
          raf = null;
        });
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ═══ CHAT EVENTS ═══
  bindChatEvents() {
    // Theme toggle
    document.getElementById('themeToggle')?.addEventListener('click', () => this.theme.cycle());

    // Chat panel toggle
    document.getElementById('toggleChat')?.addEventListener('click', () => this.toggleChatPanel(false));
    document.getElementById('chatExpandBtn')?.addEventListener('click', () => this.toggleChatPanel(true));

    // Chat input
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    if (chatInput && sendBtn) {
      chatInput.addEventListener('input', () => {
        sendBtn.disabled = !chatInput.value.trim();
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
      });
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); }
      });
      sendBtn.addEventListener('click', () => this.sendMessage());
    }

    // New chat
    document.getElementById('newChatBtn')?.addEventListener('click', () => this.newChat());

    // Quick actions
    document.querySelectorAll('.quick-action').forEach(btn => {
      btn.addEventListener('click', () => {
        if (chatInput) chatInput.value = btn.dataset.msg;
        if (sendBtn) sendBtn.disabled = false;
        this.sendMessage();
      });
    });

    // Test mode
    document.getElementById('testModeBtn')?.addEventListener('click', () => this.toggleTestMode());

    // Search
    document.getElementById('searchInput')?.addEventListener('focus', () => {});

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('searchInput')?.focus();
      }
    });
  }

  toggleChatPanel(show) {
    const el = document.getElementById('chatPanel');
    const btn = document.getElementById('chatExpandBtn');
    if (el) el.classList.toggle('collapsed', !show);
    if (btn) btn.classList.toggle('hidden', show);
  }

  // ═══ STREAMING ═══
  initStreaming() {
    if (typeof CockpitStreamingClient === 'undefined') return;
    const API_URL = window.location.origin;
    this.streamingClient = new CockpitStreamingClient(API_URL, this.SESSION_ID);
    this.streamingClient.currentTaskId = null;
    this.streamingClient.connect();
    window.renderedMessageTimestamps = this.renderedMessageTimestamps;
    this._patchStreamingForCockpit();
  }

  _patchStreamingForCockpit() {
    if (!this.streamingClient) return;
    const sc = this.streamingClient;
    const self = this;

    // ⭐ SESSION_06 FIX: CockpitStreamingClient._emit() calls this.onMessage — wire it up.
    // Without this, all SSE events are emitted but never displayed in the UI.
    sc.onMessage = (message) => {
      if (!message) return;
      const say = message.say || message.type;
      switch (say) {
        case 'text':
          if (message.text) self.addRenderedMessage(message);
          self.hideTypingIndicator();
          self.isProcessing = false;
          break;
        case 'completion_result':
          self.addRenderedMessage(message);
          self.hideTypingIndicator();
          self.isProcessing = false;
          break;
        case 'reasoning':
          self.addRenderedMessage(message);
          break;
        case 'tool':
        case 'tool_use':
          self.addRenderedMessage(message);
          break;
        case 'error':
          self.addRenderedMessage(message);
          self.hideTypingIndicator();
          self.isProcessing = false;
          break;
        case 'api_req_started':
        case 'api_req_finished':
          // Handled by handleApiReqStarted/Finished below
          break;
        default:
          break;
      }
    };

    sc.scrollToBottom = () => {
      const c = document.getElementById('chatMessages');
      if (c) c.scrollTop = c.scrollHeight;
    };

    sc.handleTextResponse = (event, taskId) => {
      const container = document.getElementById('chatMessages');
      if (!container) return;
      container.querySelectorAll(`.api-request-card[data-task-id="${taskId}"] .codicon-loading`).forEach(spinner => {
        const card = spinner.closest('.api-request-card');
        spinner.classList.remove('codicon-loading', 'codicon-modifier-spin');
        spinner.classList.add('codicon-check');
        spinner.style.color = '#4ec9b0';
        if (card) card.style.borderColor = 'rgba(76, 201, 176, 0.3)';
      });
      if (event.text) {
        self.addRenderedMessage({ ts: String(Date.now()), type: 'say', say: 'text', text: event.text });
      }
      self.hideTypingIndicator();
      self.isProcessing = false;
    };

    sc.handleReasoningText = (event) => {
      self.addRenderedMessage({ ts: String(event.ts || Date.now()), type: 'say', say: 'reasoning', text: event.text || '' });
    };

    sc.handleToolUse = (event) => {
      self.addRenderedMessage({
        ts: String(event.ts || Date.now()), type: 'say', say: 'tool',
        text: JSON.stringify({ tool: event.tool || 'unknown', path: event.input?.path || '', content: event.input?.content || '', command: event.input?.command || '' })
      });
    };

    sc.handleToolResult = (event) => {
      if (event.tokensUsed || event.cost) { self.totalTokensIn += event.tokensUsed || 0; self.totalCost += event.cost || 0; }
    };

    sc.handleApiReqStarted = (event, taskId) => {
      const container = document.getElementById('chatMessages');
      if (!container) return;
      const card = document.createElement('div');
      card.className = 'api-request-card glass-card';
      card.dataset.taskId = taskId;
      card.id = `api-req-${taskId}-${event.turn || 1}`;
      card.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:10px"><span class="codicon codicon-loading codicon-modifier-spin"></span><div><span style="font-weight:bold">Processing</span><br><span style="font-size:11px;color:var(--text-muted)">Turn ${event.turn || 1}</span></div></div>`;
      container.appendChild(card);
      sc.scrollToBottom();
    };

    sc.handleApiReqFinished = (event, taskId) => {
      if (event.tokensUsed || event.cost) { self.totalTokensIn += event.tokensUsed || 0; self.totalCost += event.cost || 0; }
      const card = document.getElementById(`api-req-${taskId}-${event.turn || 1}`);
      if (card) {
        const spinner = card.querySelector('.codicon-loading');
        if (spinner) { spinner.classList.remove('codicon-loading', 'codicon-modifier-spin'); spinner.classList.add('codicon-check'); spinner.style.color = '#4ec9b0'; }
      }
    };

    sc.handleCompletionResult = (event) => {
      self.addRenderedMessage({ ts: String(event.ts || Date.now()), type: 'say', say: 'completion_result', text: event.text || 'Task completed.' });
      self.hideTypingIndicator();
      self.isProcessing = false;
    };

    sc.handleErrorResponse = (event) => {
      self.addRenderedMessage({ ts: String(Date.now()), type: 'say', say: 'error', text: event.text || event.message || 'Unknown error' });
      self.hideTypingIndicator();
      self.isProcessing = false;
    };

    sc.handleTaskCompletionStream = () => { self.hideTypingIndicator(); self.isProcessing = false; };
  }

  // ═══ SESSION RESTORE ═══
  async restoreSession() {
    const savedTaskId = loadDashboardTaskId();
    if (savedTaskId) {
      try { await this.loadTask(savedTaskId); } catch (e) { clearDashboardTaskId(); }
    }
  }

  // ═══ RAG WIDGET ═══
  initRAGWidget() {
    if (typeof FileUploadWidget === 'undefined') return;
    try {
      let ragUrl = window.location.hostname === 'localhost' ? `${window.location.protocol}//${window.location.hostname}:8000` : `${window.location.protocol}//${window.location.hostname}`;
      this.ragWidget = new FileUploadWidget('ragUploadWidget', ragUrl, 'dev-key');
    } catch (e) {}
    document.getElementById('ragUploadBtn')?.addEventListener('click', () => {
      const w = document.getElementById('ragUploadWidget');
      if (w) w.style.display = w.style.display === 'none' ? 'block' : 'none';
    });
  }

  // ═══ MESH CHAT ═══
  initMeshChat() {
    const meshBtn = document.getElementById('meshChatBtn');
    const meshOverlay = document.getElementById('meshOverlay');
    const closeMesh = document.getElementById('closeMeshOverlay');
    if (meshBtn && meshOverlay) meshBtn.addEventListener('click', () => meshOverlay.classList.toggle('hidden'));
    if (closeMesh && meshOverlay) closeMesh.addEventListener('click', () => meshOverlay.classList.add('hidden'));
    if (meshOverlay) meshOverlay.addEventListener('click', (e) => { if (e.target === meshOverlay) meshOverlay.classList.add('hidden'); });
  }

  // ═══ BOT LOADING ═══
  async loadBots() {
    try {
      const data = await this.api.getAgents();
      const agents = data.agents || data || [];
      const select = document.getElementById('botSelector');
      if (!select) return;
      select.innerHTML = '<option value="assistant">Personal Assistant</option>';
      agents.forEach(a => {
        const id = a.agent_id || a.name || '';
        if (!id) return;
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        select.appendChild(opt);
      });
    } catch (e) {}
  }

  // ═══ METRICS & STATUS BAR ═══
  async loadMetrics() {
    const resp = await this.api.getSafe('/api/v1/metrics/summary', null);
    if (resp) {
      const d = resp.data || resp;
      this.updateStatusBar({
        agents: d.agents?.total || d.agents || 0,
        tickets: d.total || 0,
        cost: d.estimatedTotalCost || 0,
        queue: d.queue || 0
      });
    }
  }

  updateStatusBar(d) {
    const el = (id, text) => { const e = document.getElementById(id); if (e) e.textContent = text; };
    el('statusBots', `${d.agents || '--'} bots`);
    el('statusTickets', `${d.tickets || '--'} tickets`);
    el('statusCost', formatCost(d.cost));
    el('statusQueue', `Q: ${d.queue || '--'}`);
  }

  startPolling() {
    this.pollTimers.push(setInterval(() => this.loadMetrics(), 30000));
  }

  // ═══ CHAT — SEND MESSAGE ═══
  async sendMessage() {
    if (this.isProcessing) return;
    const input = document.getElementById('chatInput');
    const text = input?.value.trim();
    if (!text) return;

    if (this.streamingClient) this.streamingClient.resetTaskMetrics();
    this.totalTokensIn = 0; this.totalCost = 0;

    input.value = '';
    input.style.height = 'auto';
    document.getElementById('sendBtn').disabled = true;

    const welcome = document.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    this.addRenderedMessage({ ts: String(Date.now()), type: 'say', say: 'user_feedback', text });
    this.showTypingIndicator();
    this.isProcessing = true;

    const API_URL = window.location.origin;
    try {
      if (!this.currentTaskId) {
        clearDashboardTaskId();
        const taskResp = await fetch(`${API_URL}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, mode: 'act' }) });
        if (!taskResp.ok) throw new Error(`Create task failed: ${taskResp.statusText}`);
        const taskData = await taskResp.json();
        this.currentTask = taskData.task;
        this.currentTaskId = this.currentTask?.id || taskData.taskId || taskData.id;
        saveDashboardTaskId(this.currentTaskId);
        if (this.streamingClient) this.streamingClient.currentTaskId = this.currentTaskId;
      }

      const msgResp = await fetch(`${API_URL}/api/tasks/${this.currentTaskId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, images: [], files: [], autoApprove: this.settings.autoApprove, agenticMode: true, source: 'dashboard', targetBot: document.getElementById('botSelector')?.value || 'assistant' })
      });
      if (!msgResp.ok) {
        // Extract actual error message from response body
        let errMsg = msgResp.statusText;
        try {
          const errBody = await msgResp.json();
          errMsg = errBody.error || errBody.message || errMsg;
        } catch (e2) {}
        throw new Error(errMsg);
      }

      this.hideTypingIndicator();
      this.isProcessing = false;
    } catch (e) {
      this.addRenderedMessage({ ts: String(Date.now()), type: 'say', say: 'error', text: `Error: ${e.message}` });
      this.hideTypingIndicator();
      this.isProcessing = false;
    }
  }

  // ═══ TASK MANAGEMENT ═══
  async loadTask(taskId) {
    try {
      const res = await fetch(`/api/tasks/${taskId}`);
      if (!res.ok) {
        // Task no longer exists (container restart, etc.) — clear stale ID and start fresh
        clearDashboardTaskId();
        this.currentTaskId = null;
        this.currentTask = null;
        if (this.streamingClient) this.streamingClient.currentTaskId = null;
        this.newChat();
        return;
      }
      const data = await res.json();
      if (!data.success || !data.task) {
        clearDashboardTaskId();
        this.currentTaskId = null;
        this.currentTask = null;
        if (this.streamingClient) this.streamingClient.currentTaskId = null;
        this.newChat();
        return;
      }

      const container = document.getElementById('chatMessages');
      if (container) container.innerHTML = '';
      this.currentTask = data.task;
      this.currentTaskId = taskId;
      saveDashboardTaskId(taskId);
      if (this.streamingClient) this.streamingClient.currentTaskId = taskId;

      if (data.task.messages?.length) {
        this.renderedMessageTimestamps.clear();
        for (const msg of data.task.messages) {
          if (this.messageRenderer) {
            const elem = this.messageRenderer.render(msg, { isExpanded: false, onToggleExpand: () => {} });
            if (elem && container) container.appendChild(elem);
          }
        }
        if (container) container.scrollTop = container.scrollHeight;
      }
    } catch (e) {
      // Network error or other failure — clear stale state and start fresh
      clearDashboardTaskId();
      this.currentTaskId = null;
      this.currentTask = null;
      if (this.streamingClient) this.streamingClient.currentTaskId = null;
      this.newChat();
    }
  }

  newChat() {
    this.currentTaskId = null;
    this.currentTask = null;
    this.isProcessing = false;
    this.allMessages = [];
    this.renderedMessageTimestamps.clear();
    this.totalTokensIn = 0; this.totalCost = 0;
    clearDashboardTaskId();
    if (this.streamingClient) { this.streamingClient.resetTaskMetrics(); this.streamingClient.currentTaskId = null; }

    const container = document.getElementById('chatMessages');
    if (container) {
      container.innerHTML = `<div class="chat-welcome">
        <div class="welcome-icon"><i class="ph ph-robot"></i></div>
        <h3>Hi! I'm your AI assistant.</h3>
        <p>Tell me what you'd like to build, fix, or explore.</p>
        <div class="quick-actions">
          <button class="quick-action" data-msg="What tickets are currently in progress?"><i class="ph ph-list-checks"></i> Active tickets</button>
          <button class="quick-action" data-msg="Show me the cost summary for today"><i class="ph ph-currency-dollar"></i> Today's costs</button>
          <button class="quick-action" data-msg="Which bots are available right now?"><i class="ph ph-robot"></i> Available bots</button>
        </div>
      </div>`;
      container.querySelectorAll('.quick-action').forEach(btn => {
        btn.addEventListener('click', () => {
          document.getElementById('chatInput').value = btn.dataset.msg;
          document.getElementById('sendBtn').disabled = false;
          this.sendMessage();
        });
      });
    }
  }

  // ═══ MESSAGE RENDERING ═══
  addRenderedMessage(message) {
    const container = document.getElementById('chatMessages');
    if (!container) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'chat-message bot rendered-message';

    const sender = document.createElement('span');
    sender.className = 'msg-sender';
    const isUser = message.say === 'user_feedback';
    sender.innerHTML = isUser ? 'You' : (this.testMode ? '<i class="ph ph-flask"></i> Mock Bot' : '<i class="ph ph-robot"></i> Assistant');
    wrapper.appendChild(sender);

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble rendered-bubble';

    if (this.messageRenderer) {
      const rendered = this.messageRenderer.render(message, {
        isLast: false, isExpanded: false,
        onToggleExpand: (id, exp) => { this.messageRenderer.setExpanded(id, exp); }
      });
      if (rendered) bubble.appendChild(rendered);
    }

    wrapper.appendChild(bubble);
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  }

  showTypingIndicator() {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'chat-message bot';
    div.id = 'typingIndicator';
    div.innerHTML = `<span class="msg-sender"><i class="ph ph-robot"></i> Assistant</span><div class="typing-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  hideTypingIndicator() {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
  }

  // ═══ TEST MODE ═══
  toggleTestMode() {
    this.testMode = !this.testMode;
    const btn = document.getElementById('testModeBtn');
    if (btn) btn.classList.toggle('active', this.testMode);
    if (this.testMode) { this.showToast('🧪 Test Mode ON', 'info'); this.runMockBot(); }
    else this.showToast('Test Mode OFF', 'info');
  }

  async runMockBot() {
    if (!this.mockBot || !this.messageRenderer) return;
    const container = document.getElementById('chatMessages');
    if (!container) return;
    container.innerHTML = '';
    this.messageRenderer.clearState();

    const banner = document.createElement('div');
    banner.className = 'test-mode-banner';
    banner.innerHTML = '<i class="ph ph-flask"></i> Mock Bot Simulation';
    container.appendChild(banner);

    for await (const msg of this.mockBot.simulateTaskStream(800)) {
      if (!this.testMode) break;
      this.addRenderedMessage(msg);
    }

    if (this.testMode) {
      await new Promise(r => setTimeout(r, 600));
      this.addRenderedMessage(this.mockBot.getUserFeedback());
      await new Promise(r => setTimeout(r, 600));
      this.addRenderedMessage(this.mockBot.getFollowup());
      await new Promise(r => setTimeout(r, 600));
      this.addRenderedMessage(this.mockBot.getErrorMessage());
    }
  }

  // ═══ TOAST ═══
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
