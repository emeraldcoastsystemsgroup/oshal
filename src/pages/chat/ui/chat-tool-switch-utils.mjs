/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted standalone chat tool switch rendering and activation guardrails from the oversized chat config modal controller
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed tool guardrails so endpoint-only tools do not require auth credentials and repo-token tests can run against isolated tool state
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Replaced hidden endpoint-only validation with shared runtime field specs so required tool fields stay visible and repeatable
 */

import { getToolAuthSummary, normalizeToolConfig } from '/chat-assets/chat-tool-config-auth.mjs';
import { getMissingRequiredToolRuntimeFields } from '/chat-assets/chat-tool-config-specs.mjs';

const REPO_AUTH_GROUPS = new Set(['github', 'gitlab']);
const REPO_TOOL_NAMES = new Set(['git', 'gh', 'glab']);
const AUTH_REQUIRED_GROUPS = new Set(['github', 'gitlab', 'aws', 'gcp', 'azure', 'kubernetes', 'vault', 'terraform']);

/**
 * @description Returns the pending-or-persisted auth mode for a tool row.
 * @param {Record<string, unknown>} tool Agent tool row.
 * @param {Map<string, string>} pendingToolModes Pending auth mode overrides.
 * @returns {string} Effective auth mode.
 */
export function getEffectiveAuthMode(tool, pendingToolModes) {
  return pendingToolModes.get(tool.toolId) || tool.authMode || 'off';
}

/**
 * @description Returns the pending-or-persisted normalized tool config for a tool row.
 * @param {Record<string, unknown>} tool Agent tool row.
 * @param {Map<string, Record<string, unknown>>} pendingToolConfigs Pending tool config overrides.
 * @returns {Record<string, unknown>} Effective normalized tool config.
 */
export function getEffectiveToolConfig(tool, pendingToolConfigs) {
  if (pendingToolConfigs.has(tool.toolId)) {
    return pendingToolConfigs.get(tool.toolId);
  }

  return normalizeToolConfig(tool, tool.toolConfig);
}

/**
 * @description Filters enabled tool rows based on effective auth mode.
 * @param {Array<Record<string, unknown>>} agentTools Agent tool rows.
 * @param {Map<string, string>} pendingToolModes Pending auth mode overrides.
 * @returns {Array<Record<string, unknown>>} Enabled tool rows.
 */
export function getEnabledAgentTools(agentTools, pendingToolModes) {
  return agentTools.filter((tool) => getEffectiveAuthMode(tool, pendingToolModes) !== 'off');
}

/**
 * @description Aggregates generated skill chips from enabled tools.
 * @param {Array<Record<string, unknown>>} agentTools Agent tool rows.
 * @param {Map<string, string>} pendingToolModes Pending auth mode overrides.
 * @returns {string[]} Sorted unique skill names.
 */
export function getGeneratedSkills(agentTools, pendingToolModes) {
  const skills = new Set();
  getEnabledAgentTools(agentTools, pendingToolModes).forEach((tool) => {
    const toolSkills = Array.isArray(tool.tool?.skills) ? tool.tool.skills : [];
    toolSkills.forEach((skill) => {
      if (typeof skill === 'string' && skill.trim()) {
        skills.add(skill.trim());
      }
    });
  });
  return Array.from(skills).sort((left, right) => left.localeCompare(right));
}

/**
 * @description Sorts tool rows by display name.
 * @param {Array<Record<string, unknown>>} tools Agent tool rows.
 * @returns {Array<Record<string, unknown>>} Sorted copy.
 */
export function sortToolsByName(tools) {
  return tools.slice().sort((left, right) => {
    const leftName = getToolLabel(left);
    const rightName = getToolLabel(right);
    return leftName.localeCompare(rightName);
  });
}

/**
 * @description Computes whether a tool has enough runtime configuration to be activated.
 * @param {Record<string, unknown>} tool Agent tool row.
 * @param {Record<string, unknown>} toolConfig Effective normalized tool config.
 * @param {Record<string, unknown>} agentConfig Effective chat agent config.
 * @returns {{ configured: boolean, reasons: string[] }} Configuration result.
 */
export function getToolConfigurationState(tool, toolConfig, agentConfig) {
  const reasons = [];
  const auth = asRecord(toolConfig?.auth);
  const metadata = asRecord(toolConfig?.metadata);
  const authType = readString(auth.type) || 'none';
  const toolName = readString(tool?.tool?.name || tool?.name);
  const authGroup = readString(tool?.tool?.authGroup || tool?.authGroup);
  const projectUrl = readString(agentConfig?.projectUrl) || readString(metadata.projectUrl);

  if ((REPO_TOOL_NAMES.has(toolName) || REPO_AUTH_GROUPS.has(authGroup)) && !projectUrl) {
    reasons.push('project URL');
  }

  // Some tools only need a runtime endpoint. They should not be blocked on auth.enable
  // unless their auth profile or group explicitly requires credentials.
  if (requiresCredential(authType, authGroup, toolName)) {
    if (!Boolean(auth.enabled)) {
      reasons.push('credentials enabled');
    }
    if (!hasCredential(authType, auth)) {
      reasons.push(getCredentialLabel(authType, toolName));
    }
  }

  reasons.push(...getMissingRequiredToolRuntimeFields(tool, toolConfig));

  return {
    configured: reasons.length === 0,
    reasons,
  };
}

/**
 * @description Collects blocking tool activation errors for all tool rows being saved.
 * @param {Array<Record<string, unknown>>} agentTools Agent tool rows.
 * @param {Map<string, string>} pendingToolModes Pending auth mode overrides.
 * @param {Map<string, Record<string, unknown>>} pendingToolConfigs Pending tool config overrides.
 * @param {Record<string, unknown>} agentConfig Effective agent config.
 * @returns {Array<{ toolId: string, name: string, reasons: string[] }>} Blocking activation issues.
 */
export function collectToolActivationErrors(agentTools, pendingToolModes, pendingToolConfigs, agentConfig) {
  return agentTools
    .filter((tool) => getEffectiveAuthMode(tool, pendingToolModes) !== 'off')
    .map((tool) => {
      const config = getEffectiveToolConfig(tool, pendingToolConfigs);
      const state = getToolConfigurationState(tool, config, agentConfig);
      return {
        toolId: String(tool.toolId || ''),
        name: getToolLabel(tool),
        reasons: state.reasons,
        configured: state.configured,
      };
    })
    .filter((entry) => !entry.configured)
    .map(({ toolId, name, reasons }) => ({ toolId, name, reasons }));
}

/**
 * @description Determines whether a workspace header button should be shown for a tool.
 * @param {Record<string, unknown>} tool Agent tool row.
 * @param {Record<string, unknown>} toolConfig Effective normalized tool config.
 * @param {Record<string, unknown>} agentConfig Effective agent config.
 * @returns {boolean} True when the tool is active and configured.
 */
export function isWorkspaceToolVisible(tool, toolConfig, agentConfig) {
  if ((tool.authMode || 'off') === 'off') {
    return false;
  }
  return getToolConfigurationState(tool, toolConfig, agentConfig).configured;
}

/**
 * @description Builds the HTML card for a tool row in the switch framework panel.
 * @param {object} params Render parameters.
 * @param {Record<string, unknown>} params.tool Tool row.
 * @param {string} params.effectiveAuthMode Effective auth mode.
 * @param {Record<string, unknown>} params.toolConfig Effective normalized config.
 * @param {Record<string, unknown>} params.agentConfig Effective agent config.
 * @param {(value: string) => string} params.escapeHtml HTML escape helper.
 * @param {(input: { tool: Record<string, unknown>, config: Record<string, unknown>, escapeHtml: (value: string) => string }) => string} params.getToolAuthFields Tool auth field renderer.
 * @returns {string} HTML card.
 */
export function buildToolSwitchCard(params) {
  const { tool, effectiveAuthMode, toolConfig, agentConfig, escapeHtml, getToolAuthFields } = params;
  const configState = getToolConfigurationState(tool, toolConfig, agentConfig);
  const skills = Array.isArray(tool.tool?.skills) ? tool.tool.skills : [];
  const tags = Array.isArray(tool.tool?.routingTags) ? tool.tool.routingTags : [];
  const name = getToolLabel(tool);
  const category = tool.tool?.category || 'uncategorized';
  const type = tool.tool?.type || 'tool';
  const description = tool.tool?.description || 'No description available.';
  const configStateText = configState.configured ? 'ready' : `missing ${configState.reasons.join(', ')}`;

  return `
    <div class="tool-switch-row" data-tool-name="${escapeHtml(readString(tool.tool?.name || tool.toolId))}" data-tool-configured="${configState.configured ? 'true' : 'false'}">
      <div class="tool-switch-header">
        <div>
          <strong>${escapeHtml(name)}</strong>
          <div class="tool-switch-meta">${escapeHtml(category)} · ${escapeHtml(type)}</div>
        </div>
        <div class="auth-toggle-group">${buildAuthModeButtons(tool.toolId, effectiveAuthMode, escapeHtml)}</div>
      </div>
      <div class="tool-switch-description">${escapeHtml(description)}</div>
      <div class="tool-switch-status">${buildToolStatusChips(effectiveAuthMode, tool, toolConfig, configStateText, escapeHtml)}</div>
      <div class="chip-list">${buildToolSkillChips(skills, tags, escapeHtml)}</div>
      <div class="tool-config-shell">
        <div class="tool-switch-description">Tool credentials/auth configuration. This drives runtime access for tool execution and Layer-1 capability context.</div>
        <div class="tool-config-grid">${getToolAuthFields({ tool, config: toolConfig, escapeHtml })}</div>
      </div>
    </div>
  `;
}

function getToolLabel(tool) {
  return tool.tool?.displayName || tool.tool?.name || tool.toolId || 'Tool';
}

function buildAuthModeButtons(toolId, effectiveAuthMode, escapeHtml) {
  return ['off', 'ask', 'auto'].map((mode) => `
    <button
      type="button"
      class="auth-toggle ${effectiveAuthMode === mode ? 'active' : ''}"
      data-tool-id="${escapeHtml(String(toolId || ''))}"
      data-auth-mode="${escapeHtml(mode)}"
    >${escapeHtml(mode)}</button>
  `).join('');
}

function buildToolStatusChips(effectiveAuthMode, tool, toolConfig, configStateText, escapeHtml) {
  const verifiedChip = tool.installVerified ? '<span class="auth-chip">verified</span>' : '';
  return [
    `<span class="auth-chip">auth: ${escapeHtml(effectiveAuthMode)}</span>`,
    `<span class="auth-chip">installed: ${tool.installed ? 'yes' : 'no'}</span>`,
    `<span class="auth-chip">config: ${escapeHtml(getToolAuthSummary(toolConfig))}</span>`,
    `<span class="auth-chip">state: ${escapeHtml(configStateText)}</span>`,
    verifiedChip,
  ].join('');
}

function buildToolSkillChips(skills, tags, escapeHtml) {
  const skillChips = skills.map((skill) => `<span class="chip">${escapeHtml(String(skill))}</span>`);
  const tagChips = tags.slice(0, 5).map((tag) => `<span class="chip chip-muted">${escapeHtml(String(tag))}</span>`);
  return [...skillChips, ...tagChips].join('');
}

function requiresCredential(authType, authGroup, toolName) {
  return authType !== 'none'
    || AUTH_REQUIRED_GROUPS.has(authGroup)
    || REPO_TOOL_NAMES.has(toolName);
}

function hasCredential(authType, auth) {
  switch (authType) {
    case 'api_key':
      return Boolean(readString(auth.apiKey));
    case 'bearer':
      return Boolean(readString(auth.bearerToken));
    case 'basic':
      return Boolean(readString(auth.basic?.username) && readString(auth.basic?.password));
    case 'oauth2':
      return Boolean(
        readString(auth.oauth2?.accessToken)
        || readString(auth.oauth2?.clientSecret)
        || (readString(auth.oauth2?.clientId) && readString(auth.oauth2?.tokenUrl)),
      );
    case 'certificate':
      return Boolean(readString(auth.certificate?.certPem) && readString(auth.certificate?.keyPem));
    case 'vault':
      return Boolean(readString(auth.vault?.roleId) && readString(auth.vault?.secretId));
    case 'aws':
      return Boolean(readString(auth.aws?.profile) || (readString(auth.aws?.accessKeyId) && readString(auth.aws?.secretAccessKey)));
    case 'gcp':
      return Boolean(readString(auth.gcp?.serviceAccountJson));
    case 'azure':
      return Boolean(readString(auth.azure?.tenantId) && readString(auth.azure?.clientId) && readString(auth.azure?.clientSecret));
    case 'kubeconfig':
      return Boolean(readString(auth.kubeconfig?.path));
    case 'none':
      return true;
    default:
      return false;
  }
}

function getCredentialLabel(authType, toolName) {
  if (REPO_TOOL_NAMES.has(toolName)) {
    return 'repository token';
  }

  const labels = {
    api_key: 'API key',
    bearer: 'bearer token',
    basic: 'username/password',
    oauth2: 'OAuth token or client credentials',
    certificate: 'client certificate',
    vault: 'Vault AppRole credentials',
    aws: 'AWS credentials',
    gcp: 'GCP service account',
    azure: 'Azure credentials',
    kubeconfig: 'kubeconfig path',
    none: 'runtime configuration',
  };
  return labels[authType] || 'runtime configuration';
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
