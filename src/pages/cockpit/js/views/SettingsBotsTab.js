/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted cockpit settings bot-tab rendering and per-bot edit bindings from SettingsView to restore file-governance compliance
 */

import { createUiLogger, serializeUiError } from '../../../shared/ui-debug.js';
import { COCKPIT_THEMES } from '../theme-manager.js';

const logger = createUiLogger('cockpit-settings-bots-tab');

/**
 * @description Controller that renders and binds the cockpit settings bot tab, including inline profile edits and tool auth/verification controls.
 */
export class SettingsBotsTab {
  /**
   * @description Create a bot-tab controller bound to one SettingsView instance and target body element.
   *
   * @param {object} view - Parent settings view that owns agent state, API helpers, and toasts.
   * @param {HTMLElement} body - Settings body element where the bot tab should render.
   * @returns {void}
   */
  constructor(view, body) {
    this.view = view;
    this.body = body;
    logger.info('Created cockpit settings bots tab', {
      hasBody: Boolean(this.body),
      agentCount: Array.isArray(this.view?.agents) ? this.view.agents.length : 0,
    });
  }

  /**
   * @description Render the bot settings tab and attach edit handlers.
   *
   * @returns {void}
   */
  render() {
    logger.info('Rendering cockpit settings bots tab', {
      agentCount: this.view.agents.length,
    });
    if (!this.view.agents.length) {
      this.body.innerHTML = '<div class="ticket-detail-empty"><i class="ph ph-robot" style="font-size:48px;opacity:0.3"></i><span>No agents loaded</span></div>';
      return;
    }

    this.body.innerHTML = `<div class="bot-settings-list">${this.view.agents.map((agent) => this.renderAgentCard(agent)).join('')}</div>`;
    this.bindEditButtons();
  }

  // Render one bot settings card.
  renderAgentCard(agent) {
    const id = agent.agent_id || agent.name || '';
    const name = (agent.name || id).replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
    const initial = name.charAt(0).toUpperCase();
    const role = agent.role || agent.specialty || 'AI Agent';
    // Surface the bot's runtime at a glance: provider/harness + online state.
    const provider = agent.provider || agent.harnessType || agent.harness_type || '';
    const online = agent.online === true || agent.status === 'online' || agent.status === 'active';
    const meta = [role, provider, online ? 'online' : (agent.status === 'offline' ? 'offline' : '')]
      .filter(Boolean).map((s) => String(s)).join(' · ');

    return `
      <div class="bot-setting-card${online ? ' is-online' : ''}" data-bot="${id}">
        <div class="bot-setting-avatar">${initial}</div>
        <div class="bot-setting-info">
          <div class="bot-setting-name">${name}</div>
          <div class="bot-setting-role">${meta}</div>
        </div>
        <a class="bot-setting-edit-btn bot-setting-chat" href="/swarmbot/chat?agentId=${encodeURIComponent(id)}" target="_top" rel="noreferrer"><i class="ph ph-chat-circle"></i> Chat</a>
        <button class="bot-setting-edit-btn" data-testid="bot-setting-edit-tools" data-bot="${id}"><i class="ph ph-pencil"></i> Edit</button>
        <a class="bot-setting-edit-btn" data-testid="bot-setting-open-config" href="/config/?agentId=${encodeURIComponent(id)}&scope=agent#agentConfigSection" target="_top" rel="noreferrer"><i class="ph ph-sliders-horizontal"></i> Config</a>
        <div class="agent-tools-section" id="agent-tools-${id}"></div>
      </div>`;
  }

  // Bind the inline edit buttons for each bot card.
  bindEditButtons() {
    this.body.querySelectorAll('.bot-setting-edit-btn').forEach((button) => {
      button.addEventListener('click', async () => {
        await this.handleEditButtonClick(button.dataset.bot);
      });
    });
  }

  // Load and render the profile/tool editor for one bot.
  async handleEditButtonClick(agentId) {
    const toolsSection = document.getElementById(`agent-tools-${agentId}`);
    if (!toolsSection) {
      return;
    }

    logger.info('Loading cockpit bot settings editor', {
      agentId,
    });
    toolsSection.innerHTML = '<div class="loading-spinner">Loading bot config...</div>';
    try {
      const [profileData, toolsData] = await Promise.all([
        this.view.api.getAgentProfile(agentId),
        this.view.api.getAgentTools(agentId),
      ]);
      const profile = profileData.profile || {};
      const tools = toolsData.tools || [];
      toolsSection.innerHTML = this.renderAgentToolsMarkup(agentId, profile, tools);
      this.bindProfileSave(toolsSection, agentId, profile);
      this.bindAuthModeControls(toolsSection, agentId);
      this.bindVerificationControls(toolsSection);
    } catch (error) {
      logger.error('Failed to load cockpit bot settings editor', {
        agentId,
        error: serializeUiError(error),
      });
      toolsSection.innerHTML = `<div class="error-message">Failed to load tools: ${error.message}</div>`;
    }
  }

  // Render the inline profile editor and tool list for one bot.
  renderAgentToolsMarkup(agentId, profile, tools) {
    return `
      <div class="setting-section" data-testid="bot-profile-section">
        <div class="setting-section-title">Bot Profile</div>
        <div class="setting-field">
          <label>Name</label>
          <input class="agent-profile-name" type="text" value="${escapeHtmlAttribute(profile.name || '')}">
        </div>
        <div class="setting-field">
          <label>Project URL</label>
          <input class="agent-profile-project-url" type="url" value="${escapeHtmlAttribute(profile.projectUrl || '')}" placeholder="https://github.com/...">
        </div>
        <div class="setting-field">
          <label>Theme Preference</label>
          <select class="agent-profile-theme">${renderThemeOptions(profile.themePreference || 'midnight')}</select>
        </div>
        <div class="setting-field">
          <label>Selector Skills</label>
          <textarea class="agent-profile-selector-skills" rows="4">${escapeHtml(profile.selectorSkillsText || '')}</textarea>
          <span class="field-hint">This is the narrow per-bot profile layer. Full bot config continues in the native <code>/config/</code> screen.</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="settings-save-btn agent-profile-save-btn" data-agent="${agentId}"><i class="ph ph-floppy-disk"></i> Save Profile</button>
          <a class="settings-cancel-btn" href="/config/?agentId=${encodeURIComponent(agentId)}&scope=agent#agentConfigSection" target="_top" rel="noreferrer"><i class="ph ph-sliders-horizontal"></i> Open Full Config</a>
        </div>
      </div>
      <div class="agent-tools-list">${tools.map((tool) => this.renderToolRow(tool)).join('')}</div>`;
  }

  // Render one tool row inside the expanded bot editor.
  renderToolRow(tool) {
    return `
      <div class="agent-tool-row">
        <span class="agent-tool-name">${tool.name}</span>
        <select class="agent-tool-auth-mode" data-tool="${tool.id}">
          <option value="auto"${tool.authMode === 'auto' ? ' selected' : ''}>Auto</option>
          <option value="ask"${tool.authMode === 'ask' ? ' selected' : ''}>Ask</option>
          <option value="off"${tool.authMode === 'off' ? ' selected' : ''}>Off</option>
        </select>
        <button class="agent-tool-verify-btn" data-tool="${tool.id}">Verify</button>
        <span class="agent-tool-verification-status" id="tool-verification-${tool.id}"></span>
      </div>`;
  }

  // Bind the inline profile save button.
  bindProfileSave(toolsSection, agentId, profile) {
    toolsSection.querySelector('.agent-profile-save-btn')?.addEventListener('click', async () => {
      const payload = this.collectProfilePayload(toolsSection, profile);
      logger.info('Saving cockpit bot profile', {
        agentId,
      });
      try {
        const saveResult = await this.view.api.updateAgentProfile(agentId, payload);
        profile.name = saveResult.profile?.name || payload.name;
        logger.info('Saved cockpit bot profile', {
          agentId,
          profileName: profile.name || payload.name || null,
        });
        this.view.showToast(`Saved bot profile for ${profile.name || agentId}`, 'success');
      } catch (error) {
        logger.error('Failed to save cockpit bot profile', {
          agentId,
          error: serializeUiError(error),
        });
        this.view.showToast(`Failed to save bot profile: ${error.message}`, 'error');
      }
    });
  }

  // Collect the edited bot-profile payload from the expanded editor.
  collectProfilePayload(toolsSection, profile) {
    return {
      name: toolsSection.querySelector('.agent-profile-name')?.value.trim() || profile.name || '',
      projectUrl: toolsSection.querySelector('.agent-profile-project-url')?.value.trim() || '',
      themePreference: toolsSection.querySelector('.agent-profile-theme')?.value || 'midnight',
      selectorSkillsText: toolsSection.querySelector('.agent-profile-selector-skills')?.value || '',
    };
  }

  // Bind tool auth-mode selectors.
  bindAuthModeControls(toolsSection, agentId) {
    toolsSection.querySelectorAll('.agent-tool-auth-mode').forEach((select) => {
      select.addEventListener('change', async () => {
        const toolId = select.dataset.tool;
        const authMode = select.value;
        logger.info('Updating cockpit bot tool auth mode', {
          agentId,
          toolId,
          authMode,
        });
        try {
          await this.view.api.setAgentToolAuthMode(agentId, toolId, authMode);
          this.view.showToast(`Auth mode updated for ${toolId}: ${authMode}`, 'info');
        } catch (error) {
          logger.error('Failed to update cockpit bot tool auth mode', {
            agentId,
            toolId,
            authMode,
            error: serializeUiError(error),
          });
          this.view.showToast(`Failed to update auth mode: ${error.message}`, 'error');
        }
      });
    });
  }

  // Bind tool verification buttons.
  bindVerificationControls(toolsSection) {
    toolsSection.querySelectorAll('.agent-tool-verify-btn').forEach((button) => {
      button.addEventListener('click', async () => {
        const toolId = button.dataset.tool;
        const statusSpan = document.getElementById(`tool-verification-${toolId}`);
        if (!statusSpan) {
          return;
        }
        logger.info('Verifying cockpit bot tool', {
          toolId,
        });
        statusSpan.textContent = 'Verifying...';
        try {
          await this.view.api.verifyTool(toolId);
          const status = await this.view.api.getToolVerificationStatus(toolId);
          logger.info('Verified cockpit bot tool', {
            toolId,
            status: status.status || 'Verified',
          });
          statusSpan.textContent = status.status || 'Verified';
        } catch (error) {
          logger.error('Failed to verify cockpit bot tool', {
            toolId,
            error: serializeUiError(error),
          });
          statusSpan.textContent = `Error: ${error.message}`;
        }
      });
    });
  }
}

// Render static cockpit theme options for the inline bot-profile editor.
function renderThemeOptions(selectedTheme) {
  return COCKPIT_THEMES
    .map((theme) => {
      const label = theme
        .split('-')
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(' ');
      return `<option value="${theme}"${theme === selectedTheme ? ' selected' : ''}>${label}</option>`;
    })
    .join('');
}

// Escape HTML before rendering profile text into an attribute.
function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Escape HTML before rendering profile text into element content.
function escapeHtml(value) {
  return escapeHtmlAttribute(value);
}
