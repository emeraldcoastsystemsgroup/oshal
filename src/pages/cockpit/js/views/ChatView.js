/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Normalized cockpit chat task identifiers, added user-visible action feedback, and hardened button-audit behaviors against real OSHAL task payloads
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Simplified the cockpit Chat surface by removing decorative/dead controls and making right-rail handoff actions explicit
 */

import { ApiClient } from '../api-client.js';
import { timeAgo, truncate } from '../utils/formatters.js';

/**
 * @description Conversation manager for cockpit chat history, including task selection,
 * deletion, and mesh handoff actions backed by real OSHAL task data.
 */
export class ChatView {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.getElementById(container) : container;
    this.api = new ApiClient();
    this.conversations = [];
    this.agents = [];
    this.selectedTaskId = null;
    this.onSelectConversation = options.onSelectConversation || null;
    this.onNewChat = options.onNewChat || null;
    this.showToast = options.onToast || ((message, type) => this._showToast(message, type));
  }

  async render() {
    if (!this.container) return;
    this.container.innerHTML = this._renderShell();
    this._bindEvents();
    await this._loadData();
  }

  _renderShell() {
    return `
      <div class="ticket-view">
        <div class="ticket-list-pane">
          <div class="ticket-list-toolbar">
            <input class="search-input" placeholder="Search conversations..." id="cvSearch">
            <button class="td-action-btn" id="cvNewBtn" style="white-space:nowrap"><i class="ph ph-plus"></i> New</button>
          </div>
          <div class="ticket-list-scroll" id="cvList"></div>
        </div>
        <div class="ticket-detail-pane" id="cvDetailPane">
          <div class="ticket-detail-empty">
            <i class="ph ph-chat-circle-dots" style="font-size:48px;opacity:0.3"></i>
            <span>Select a conversation or start a new one</span>
            <p style="font-size:12px;color:var(--text-muted);max-width:300px;text-align:center;margin-top:8px">
              Conversations here mirror the chat panel on the right.
              Use this view to browse conversation history and invite multiple bots.
            </p>
          </div>
        </div>
      </div>`;
  }

  _bindEvents() {
    const search = this.container.querySelector('#cvSearch');
    if (search) {
      let debounce;
      search.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => this._renderList(search.value.trim().toLowerCase()), 200);
      });
    }

    this.container.querySelector('#cvNewBtn')?.addEventListener('click', () => {
      if (this.onNewChat) this.onNewChat();
      this.showToast('New chat opened in the right rail', 'info');
    });
  }

  async _loadData() {
    const [taskData, agentData] = await Promise.allSettled([
      this.api.getTasks(),
      this.api.getAgents(),
    ]);

    this.conversations = this._readFulfilled(taskData, 'tasks', []);
    this.agents = this._readFulfilled(agentData, 'agents', []);
    this._renderList();
  }

  _readFulfilled(result, label, fallback) {
    if (result.status === 'fulfilled') {
      const value = result.value;
      if (label === 'tasks') return value.tasks || value || fallback;
      if (label === 'agents') return value.agents || value || fallback;
    }

    this._logError('load-data', result.reason || new Error(`Failed to load ${label}`), { label });
    return fallback;
  }

  _renderList(query = '') {
    const list = this.container.querySelector('#cvList');
    if (!list) return;

    const conversations = this._filterConversations(query).sort((left, right) => {
      const leftTime = new Date(left.updatedAt || left.ts || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.ts || 0).getTime();
      return rightTime - leftTime;
    });

    if (!conversations.length) {
      list.innerHTML = this._renderEmptyList();
      return;
    }

    list.innerHTML = conversations.map((conversation) => this._renderConversationRow(conversation)).join('');
    this._bindConversationRows(list);
  }

  _filterConversations(query) {
    if (!query) return [...this.conversations];

    return this.conversations.filter((conversation) => {
      const summary = [
        conversation.title,
        conversation.text,
        conversation.name,
        conversation.metadata?.source,
      ].map((value) => this._readString(value).toLowerCase()).join(' ');
      const botName = this._resolveConversationBotName(conversation).toLowerCase();
      return summary.includes(query) || botName.includes(query);
    });
  }

  _renderEmptyList() {
    return '<div class="ticket-detail-empty" style="padding:40px 0"><i class="ph ph-chat-circle" style="font-size:32px;opacity:0.3"></i><span>No conversations yet</span></div>';
  }

  _renderConversationRow(conversation) {
    const taskId = this._normalizeConversationId(conversation);
    const selected = taskId === this.selectedTaskId ? ' selected' : '';
    const botName = this._resolveConversationBotName(conversation);
    const preview = this._getConversationPreview(conversation);
    const time = conversation.updatedAt || conversation.ts || conversation.createdAt || '';

    return `<div class="ticket-row${selected}" data-id="${taskId}" style="grid-template-columns:40px 1fr 90px">
      <div style="display:flex;align-items:center;justify-content:center">
        <div class="ab-avatar" style="width:32px;height:32px;font-size:14px">${botName.charAt(0).toUpperCase()}</div>
      </div>
      <div class="ticket-subject">
        <div class="ticket-subject-title">${botName}</div>
        <div class="ticket-subject-meta">${preview}</div>
      </div>
      <div class="ticket-date-cell">${timeAgo(time)}</div>
    </div>`;
  }

  _bindConversationRows(list) {
    list.querySelectorAll('.ticket-row').forEach((row) => {
      row.addEventListener('click', () => {
        const taskId = row.dataset.id;
        this.selectedTaskId = taskId;
        list.querySelectorAll('.ticket-row').forEach((candidate) => candidate.classList.remove('selected'));
        row.classList.add('selected');
        this._showConversationDetail(taskId);
        if (this.onSelectConversation) this.onSelectConversation(taskId);
      });
    });
  }

  _getConversationPreview(conversation) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const lastMessage = messages.length ? messages[messages.length - 1] : null;
    const preview = lastMessage?.text || lastMessage?.content || conversation.title || conversation.text || conversation.name || 'Untitled conversation';
    return truncate(preview, 60);
  }

  async _showConversationDetail(taskId) {
    const pane = this.container.querySelector('#cvDetailPane');
    if (!pane) return;

    const conversation = this._findConversation(taskId);
    if (!conversation) {
      pane.innerHTML = '<div class="ticket-detail-empty"><span>Conversation not found</span></div>';
      return;
    }

    pane.innerHTML = this._renderConversationDetail(conversation, taskId);
    this._bindDetailActions(pane, taskId);
  }

  _findConversation(taskId) {
    return this.conversations.find((conversation) => this._normalizeConversationId(conversation) === taskId);
  }

  _renderConversationDetail(conversation, taskId) {
    const botName = this._resolveConversationBotName(conversation);
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const messageCount = messages.length || Number(conversation.messageCount || 0);
    const status = conversation.status || 'active';
    const updatedAt = conversation.updatedAt || conversation.ts || conversation.createdAt;

    return `
      <div class="td-header">
        <div class="td-title">Conversation with ${botName}</div>
        <div class="td-meta-row">
          <span class="td-meta-item"><i class="ph ph-hash"></i> ${taskId.slice(0, 8)}</span>
          <span class="td-meta-item"><i class="ph ph-chat-circle"></i> ${messageCount} messages</span>
          <span class="td-meta-item"><i class="ph ph-clock"></i> ${timeAgo(updatedAt)}</span>
          <span class="td-meta-item"><i class="ph ph-tag"></i> ${status}</span>
        </div>
      </div>
      <div class="td-actions">
        <button class="td-action-btn" id="cvFocusInRail"><i class="ph ph-arrow-square-out"></i> Focus in Right Rail</button>
        <button class="td-action-btn danger" id="cvDeleteConv" data-task-id="${taskId}"><i class="ph ph-trash"></i> Delete</button>
      </div>
      <div class="td-body" style="padding:16px 20px">
        ${this._renderMessages(messages, botName)}
      </div>`;
  }

  _renderMessages(messages, botName) {
    if (!messages.length) {
      return '<p style="color:var(--text-muted);font-size:13px">No messages in this conversation yet</p>';
    }

    return messages.slice(-20).map((message) => {
      const isUser = message.type === 'say' && message.say === 'user_feedback';
      const author = isUser ? 'You' : botName;
      const text = truncate(message.text || message.content || '', 200) || 'No message text';
      return `<div style="margin-bottom:12px">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">${author} · ${timeAgo(message.ts)}</div>
        <div style="font-size:13px;color:var(--text-primary);padding:8px 12px;background:var(--glass-bg);border-radius:var(--radius-sm)">${text}</div>
      </div>`;
    }).join('');
  }

  _bindDetailActions(pane, taskId) {
    pane.querySelector('#cvFocusInRail')?.addEventListener('click', () => {
      if (this.onSelectConversation) this.onSelectConversation(taskId);
      this.showToast('Conversation focused in the right rail', 'info');
    });

    pane.querySelector('#cvDeleteConv')?.addEventListener('click', async () => {
      await this._deleteConversation(taskId);
    });
  }

  async _deleteConversation(taskId) {
    const pane = this.container.querySelector('#cvDetailPane');

    try {
      await this.api.deleteTask(taskId);
      this.conversations = this.conversations.filter((conversation) => this._normalizeConversationId(conversation) !== taskId);
      this.selectedTaskId = null;
      this._renderList();
      if (pane) pane.innerHTML = '<div class="ticket-detail-empty"><span>Conversation deleted</span></div>';
      this.showToast('Conversation deleted', 'success');
    } catch (error) {
      this._logError('delete-conversation', error, { taskId });
      this.showToast(`Failed to delete conversation: ${this._errorMessage(error)}`, 'error');
    }
  }

  destroy() {
    if (this.container) this.container.innerHTML = '';
  }

  _resolveConversationBotName(conversation) {
    const directName = this._readString(conversation?.targetBot) || this._readString(conversation?.assignedBot);
    const agentId = this._readString(conversation?.agentId) || directName;
    const agent = this.agents.find((candidate) => this._candidateAgentId(candidate) === agentId);

    if (agent) {
      return this._readString(agent.name) || this._readString(agent.displayName) || agentId;
    }
    if (directName && !this._looksLikeAgentId(directName)) return directName;
    if (agentId) return this._looksLikeAgentId(agentId) ? `bot ${agentId.slice(0, 8)}` : agentId;
    return 'assistant';
  }

  _candidateAgentId(candidate) {
    return this._readString(candidate?.agentId) || this._readString(candidate?.agent_id) || this._readString(candidate?.id);
  }

  _normalizeConversationId(conversation) {
    return this._readString(conversation?.taskId) || this._readString(conversation?.id);
  }

  _looksLikeAgentId(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(this._readString(value));
  }

  _showToast(message, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  _logError(action, error, context = {}) {
    const payload = {
      level: 'error',
      module: 'cockpit-chat-view',
      action,
      ...context,
      message: this._errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    console.error(JSON.stringify(payload));
  }

  _errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  _readString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }
}
