/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added standalone chat history, RAG service, and Presentron service popup modals with persisted configuration and conversation restore links
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Converted popup script to module format and extracted shared utility helpers
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fixed Presentron button icon mapping to valid Codicon glyph and added icon button aria labels
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Extracted conversation-history popup into a dedicated module to keep workspace popup controller under governance limits
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Redirected header RAG action to a knowledge-base drop window and kept RAG service settings in the core gear/settings flow
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Redirected header Presentron action to an operational studio popup and moved Presentron endpoint settings into the core MCP settings flow
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Hid workspace header buttons when their backing tools are disabled or not fully configured for the active chat agent
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Switched workspace button visibility refresh to dedicated /api/agents/:agentId/profile reads instead of global config chatAgentConfig
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Passed shared knowledge-workspace context into the header popup initializer for chat and cockpit convergence
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Added URL-driven workspace deep links so engineering surfaces can open the shared knowledge window directly
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Retired the dead Presentron studio button + Google Search MCP settings card; the header presentation control now links to the AI Office surface (?app=presentations)
 */

import { normalizeToolConfig } from '/chat-assets/chat-tool-config-auth.mjs';
import { initializeChatHistoryPopup } from '/chat-assets/chat-history-popup.mjs';
import { initializeChatRagWorkspacePopup } from '/chat-assets/chat-rag-workspace-popup.mjs';
import { initializeChatRedisSchedulerPopup } from '/chat-assets/chat-redis-scheduler-popup.mjs';
import { isWorkspaceToolVisible } from '/chat-assets/chat-tool-switch-utils.mjs';
import { requestJson } from '/chat-assets/chat-workspace-popups-utils.mjs';

(() => {
  const DEFAULT_CHAT_AGENT_ID = '00000000-0000-4000-8000-000000000032';
  const HISTORY_LIMIT = 150;
  const WORKSPACE_POPUP_CSS = `
    .panel-icon-btn.alt {
      background: color-mix(in srgb, var(--accent-primary) 16%, var(--glass-bg));
      border-color: color-mix(in srgb, var(--accent-primary) 34%, var(--glass-border));
    }
    .panel-icon-btn.alt:hover {
      background: color-mix(in srgb, var(--accent-primary) 24%, var(--glass-bg-heavy));
      border-color: color-mix(in srgb, var(--accent-primary) 44%, var(--border-color-hover));
    }
    .service-status { min-height: 18px; margin-bottom: 12px; color: var(--text-dim); font-size: 12px; }
    .service-status[data-tone="error"] { color: var(--status-error); }
    .service-status[data-tone="success"] { color: var(--status-success); }
    .mini-btn {
      border: 1px solid var(--glass-border);
      background: var(--glass-bg);
      color: var(--text-primary);
      border-radius: 10px;
      padding: 8px 12px;
      font-size: 12px;
      cursor: pointer;
      box-shadow: var(--card-shadow);
    }
    .mini-btn:hover {
      background: var(--glass-bg-heavy);
      border-color: var(--border-color-hover);
      color: var(--text-primary);
    }
  `;

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    ensureHeaderButtons();
    bindCloseEvents();
    void refreshWorkspaceButtons();
    initializeChatHistoryPopup({
      defaultAgentId: DEFAULT_CHAT_AGENT_ID,
      historyLimit: HISTORY_LIMIT,
      closeModal: hideModal,
    });
    const ragWorkspace = initializeChatRagWorkspacePopup({
      closeModal: hideModal,
      openCoreBotSettings: openRagSettingsFromHeader,
      defaultAgentId: DEFAULT_CHAT_AGENT_ID,
    });
    const redisWorkspace = initializeChatRedisSchedulerPopup({
      defaultAgentId: DEFAULT_CHAT_AGENT_ID,
      closeModal: hideModal,
      openCoreBotSettings: openRedisSettingsFromHeader,
    });
    window.addEventListener('focus', () => { void refreshWorkspaceButtons(); });
    document.addEventListener('oshal:tool-config-changed', () => { void refreshWorkspaceButtons(); });
    openRequestedWorkspace({ ragWorkspace, redisWorkspace });
  });

  function injectStyles() {
    if (document.getElementById('chatWorkspacePopupsStyle')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'chatWorkspacePopupsStyle';
    style.textContent = WORKSPACE_POPUP_CSS;
    document.head.appendChild(style);
  }

  function ensureHeaderButtons() {
    const actions = document.querySelector('.panel-actions');
    const settingsBtn = document.getElementById('openToolsConfigBtn');
    if (!(actions instanceof HTMLElement) || !(settingsBtn instanceof HTMLButtonElement)) {
      return;
    }

    ensureIconButton(actions, settingsBtn, 'openHistoryModalBtn', 'codicon-history', 'Conversation History');
    ensureIconButton(actions, settingsBtn, 'openAiOfficeBtn', 'codicon-files', 'AI Office — decks, docs & sheets');
    ensureIconButton(actions, settingsBtn, 'openRagModalBtn', 'codicon-database', 'Knowledge Base');
    ensureIconButton(actions, settingsBtn, 'openRedisJobsModalBtn', 'codicon-calendar', 'Redis Jobs');
    bindAiOfficeButton();
  }

  function ensureIconButton(parent, anchor, id, iconClass, title) {
    if (document.getElementById(id)) {
      return;
    }

    const button = document.createElement('button');
    button.id = id;
    button.className = 'panel-icon-btn alt';
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = `<span class="codicon ${iconClass}"></span>`;
    parent.insertBefore(button, anchor);
  }

  function bindCloseEvents() {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') {
        return;
      }
      hideModal('historyModal');
      hideModal('ragModal');
      hideModal('redisJobsModal');
    });
  }

  // The AI Office surface is the office-suite presentation/document/spreadsheet engine.
  // It is a ribbon app opened via the canonical ?app= deep link (mirrors the /applications
  // page and welcome onboarding), so from the chat header we simply navigate to it.
  function bindAiOfficeButton() {
    const button = document.getElementById('openAiOfficeBtn');
    if (button instanceof HTMLButtonElement) {
      button.addEventListener('click', openAiOffice);
    }
  }

  function openAiOffice() {
    const target = '/cockpit?app=presentations';
    try {
      if (window.top && window.top !== window) {
        window.top.location.href = target;
        return;
      }
    } catch (error) {
      // A cross-origin top window can't be navigated directly; fall back to this frame.
    }
    window.location.href = target;
  }

  function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal instanceof HTMLElement) {
      modal.hidden = true;
    }
  }

  function openRagSettingsFromHeader() {
    hideModal('ragModal');
    openConfigSection('tools');
  }

  function openRedisSettingsFromHeader() {
    hideModal('redisJobsModal');
    openConfigSection('tools');
  }

  function openConfigSection(sectionName) {
    const openSettingsButton = document.getElementById('openToolsConfigBtn');
    if (!(openSettingsButton instanceof HTMLButtonElement)) {
      return;
    }

    openSettingsButton.click();
    window.setTimeout(() => {
      const sectionButton = document.querySelector(`[data-config-section="${sectionName}"]`);
      if (sectionButton instanceof HTMLButtonElement) {
        sectionButton.click();
      }
    }, 0);
  }

  async function refreshWorkspaceButtons() {
    try {
      const [profileResult, toolsResult] = await Promise.all([
        requestJson(`/api/agents/${DEFAULT_CHAT_AGENT_ID}/profile`),
        requestJson(`/api/agents/${DEFAULT_CHAT_AGENT_ID}/tools`),
      ]);
      const agentConfig = profileResult?.profile && typeof profileResult.profile === 'object' ? profileResult.profile : {};
      const tools = Array.isArray(toolsResult?.tools) ? toolsResult.tools : [];
      applyWorkspaceToolVisibility('openRagModalBtn', findToolVisibility(tools, 'rag-ingestion', agentConfig));
      applyWorkspaceToolVisibility('openRedisJobsModalBtn', findToolVisibility(tools, 'agent-scheduler', agentConfig));
    } catch (error) {
      console.warn('[chat-workspace-popups] workspace button refresh failed', error);
      applyWorkspaceToolVisibility('openRagModalBtn', false);
      applyWorkspaceToolVisibility('openRedisJobsModalBtn', false);
    }
  }

  function findToolVisibility(tools, toolName, agentConfig) {
    const tool = tools.find((entry) => entry?.tool?.name === toolName);
    if (!tool) {
      return false;
    }

    const toolConfig = normalizeToolConfig(tool, tool.toolConfig);
    return isWorkspaceToolVisible(tool, toolConfig, agentConfig);
  }

  function applyWorkspaceToolVisibility(buttonId, visible) {
    const button = document.getElementById(buttonId);
    if (button instanceof HTMLButtonElement) {
      button.hidden = !visible;
      button.style.display = visible ? '' : 'none';
    }
  }

  function openRequestedWorkspace(workspaces) {
    const requestedWorkspace = readRequestedWorkspace();
    if (!requestedWorkspace) {
      return;
    }

    consumeRequestedWorkspace();
    if (requestedWorkspace === 'rag') {
      window.setTimeout(() => workspaces.ragWorkspace?.open?.(), 0);
      return;
    }
    if (requestedWorkspace === 'presentron') {
      // Legacy deep link — the Presentron studio is retired; send callers to AI Office.
      openAiOffice();
      return;
    }
    if (requestedWorkspace === 'redis-jobs') {
      window.setTimeout(() => workspaces.redisWorkspace?.open?.(), 0);
    }
  }

  function readRequestedWorkspace() {
    const value = new URLSearchParams(window.location.search).get('openWorkspace') || '';
    return value.trim().toLowerCase();
  }

  function consumeRequestedWorkspace() {
    const url = new URL(window.location.href);
    url.searchParams.delete('openWorkspace');
    url.searchParams.delete('source');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }
})();
