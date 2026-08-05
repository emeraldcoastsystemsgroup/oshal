/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CM-6: Extracted agent panel, auth state management, renderers from config-admin.js (1277 → <1000 decomposition)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Made provider controls honor server-resolved precedence and push runtime changes before recording profile state
 */

import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';
import { COCKPIT_THEMES } from '../cockpit/js/theme-manager.js';
import { loadAgentRuntimeConfig, renderRuntimeConfigSection } from './agent-runtime-config.js';
import {
  fetchJson, putJson, postJson, requestJson,
  readString, escapeHtml, escapeHtmlAttribute, toErrorMessage, delay,
  getAgentId, readAgentName, findSelectedAgent, writeSelectedAgentIdToUrl, readSelectedAgentIdFromUrl,
} from './config-admin-utils.js';

const logger = createUiLogger('config-admin-agent-panel');

// ── Provider Auth Config ────────────────────────────────────────────────────

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
    signInLabel: 'Sign In',
    signOutLabel: 'Sign Out',
    infoText: 'This bot uses OpenAI Codex OAuth. Sign in here to unlock Codex-backed swarm runs.',
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

/**
 * @description Look up the auth config for a given provider ID.
 */
export function getProviderAuthConfig(providerId) {
  return PROVIDER_AUTH_CONFIG[readString(providerId)] || null;
}

// ── Auth State Factories ────────────────────────────────────────────────────

/** @description Create a pending auth state with default messaging. */
export function createPendingAuthState(infoText = 'Checking whether this bot needs provider sign-in.', label = 'Checking authentication...') {
  return { authenticated: false, canSignIn: false, canSignOut: false, infoText, label, tone: 'info' };
}

function createLoadingAuthState(infoText) {
  return createPendingAuthState(infoText, 'Checking authentication...');
}

function createUnsupportedAuthState(providerId) {
  const providerLabel = getProviderLabel(providerId);
  return {
    authenticated: false, canSignIn: false, canSignOut: false,
    infoText: `This bot uses ${providerLabel}. Configure runtime details in the bot config workspace if needed.`,
    label: `No inline auth flow for ${providerLabel}`, tone: 'muted',
  };
}

function createErrorAuthState(infoText, message) {
  return {
    authenticated: false, canSignIn: true, canSignOut: false,
    infoText, label: readString(message) || 'Unable to read auth status', tone: 'error',
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
    authenticated, canSignIn: !authenticated, canSignOut: authenticated, infoText,
    label: authenticated ? `Signed in${readString(payload?.email) ? ` as ${readString(payload.email)}` : ''}` : 'Not signed in',
    tone: authenticated ? 'success' : 'info',
  };
}

function buildClaudeCodeAuthState(payload, infoText) {
  const authenticated = !!payload?.authenticated;
  const email = readString(payload?.email);
  const authMethod = readString(payload?.authMethod);
  const canSignIn = !authenticated || authMethod === 'api_key';
  return {
    authenticated, canSignIn, canSignOut: authenticated, infoText,
    label: authenticated ? buildClaudeCodeAuthLabel(authenticated, email, authMethod) : 'Not signed in',
    tone: authenticated ? 'success' : 'info',
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

// ── Agent Panel Actions ─────────────────────────────────────────────────────

/**
 * @description Load the selected agent's profile, tools, and auth status.
 */
export async function loadSelectedAgentDetails(app, agentId) {
  if (!agentId) {
    return;
  }
  app.state.selectedAgentId = agentId;
  app.state.selectedAgentRuntimeConfig = null;
  writeSelectedAgentIdToUrl(agentId);
  app.elements.selectedAgentPanel.innerHTML = '<div class="empty-state">Loading bot configuration...</div>';
  app.elements.agentConfigHeading.textContent = `Bot Config — ${readAgentName(findSelectedAgent(app.state.agents, agentId)) || 'Loading...'}`;

  try {
    const [profileResponse, toolResponse, runtimeConfig] = await Promise.all([
      fetchJson(`/api/agents/${encodeURIComponent(agentId)}/profile`),
      fetchJson(`/api/agents/${encodeURIComponent(agentId)}/tools`).catch((error) => {
        logger.warn('Failed to load tools for selected bot', {
          agentId,
          error: serializeUiError(error),
        });
        return { tools: [] };
      }),
      loadAgentRuntimeConfig(agentId).catch((error) => {
        logger.warn('Failed to load runtime config for selected bot', {
          agentId,
          error: serializeUiError(error),
        });
        return null;
      }),
    ]);
    app.state.selectedAgentProfile = profileResponse.profile || null;
    app.state.selectedAgentTools = Array.isArray(toolResponse.tools) ? toolResponse.tools : [];
    app.state.selectedAgentRuntimeConfig = runtimeConfig;
    app.state.selectedAgentAuth = createPendingAuthState();
    app.render();
    await refreshSelectedAgentAuthStatus(app);
    app.setStatus(`Loaded bot config for ${readAgentName(app.state.selectedAgentProfile)}.`, 'success');
  } catch (error) {
    app.elements.selectedAgentPanel.innerHTML = `<div class="empty-state">Failed to load bot configuration: ${escapeHtml(toErrorMessage(error))}. Click the bot card again to retry.</div>`;
    app.setStatus(`Failed to load bot config: ${toErrorMessage(error)}`, 'error');
  }
}

/**
 * @description Save the selected agent's profile from the form.
 */
export async function saveSelectedAgentProfile(app) {
  if (!app.state.selectedAgentProfile) {
    return;
  }
  const payload = buildSelectedAgentProfilePayload(app.elements.selectedAgentPanel);
  const agent = findSelectedAgent(app.state.agents, app.state.selectedAgentProfile.agentId);
  const runtimePayload = buildSelectedAgentRuntimePayload(
    app.elements.selectedAgentPanel,
    agent,
    app.state.selectedAgentProfile,
  );
  let runtimeApplied = false;
  app.setStatus(`Saving bot profile for ${app.state.selectedAgentProfile.name}...`, 'info');
  try {
    if (runtimePayload) {
      app.setStatus(`Pushing runtime settings to ${app.state.selectedAgentProfile.name}...`, 'info');
      await putJson(
        `/api/agents/${encodeURIComponent(app.state.selectedAgentProfile.agentId)}/runtime`,
        runtimePayload,
      );
      runtimeApplied = true;
    }
    const response = await putJson(`/api/agents/${encodeURIComponent(app.state.selectedAgentProfile.agentId)}/profile`, { profile: payload });
    app.state.selectedAgentProfile = response.profile || app.state.selectedAgentProfile;
    app.state.agents = app.state.agents.map((agent) => (
      getAgentId(agent) === app.state.selectedAgentProfile.agentId
        ? { ...agent, ...app.state.selectedAgentProfile, agent_id: app.state.selectedAgentProfile.agentId }
        : agent
    ));
    app.render();
    await refreshSelectedAgentAuthStatus(app);
    app.setStatus(`Saved bot profile for ${app.state.selectedAgentProfile.name}.`, 'success');
  } catch (error) {
    if (runtimePayload && !runtimeApplied) {
      app.setStatus(`Not applied — the bot did not accept its runtime settings (${toErrorMessage(error)}). Nothing was recorded.`, 'error');
      return;
    }
    if (runtimeApplied) {
      app.setStatus(`Runtime settings were applied, but profile metadata was not saved: ${toErrorMessage(error)}`, 'error');
      return;
    }
    app.setStatus(`Failed to save bot profile: ${toErrorMessage(error)}`, 'error');
  }
}

/**
 * @description Apply a bulk template from the selected bot to other agents.
 */
export async function applyBulkTemplate(app, mode) {
  if (!app.state.selectedAgentProfile) {
    return;
  }
  const payload = buildBulkTemplatePayload(app.elements.selectedAgentPanel);
  const endpoint = mode === 'unset' ? '/api/agents/bulk/configure-all-unset' : '/api/agents/bulk/configure-all';
  const modeLabel = mode === 'unset' ? 'unset-only' : 'overwrite';
  app.setStatus(`Applying ${modeLabel} bulk config from ${app.state.selectedAgentProfile.name}...`, 'info');
  try {
    const response = await postJson(endpoint, { profile: payload });
    const result = response.result || {};
    const updatedCount = Array.isArray(result.updatedAgents) ? result.updatedAgents.length : 0;
    const skippedCount = Array.isArray(result.skippedAgents) ? result.skippedAgents.length : 0;
    await app.loadAll();
    await loadSelectedAgentDetails(app, app.state.selectedAgentId);
    app.setStatus(`Bulk config complete: updated ${updatedCount} bot(s), skipped ${skippedCount}.`, 'success');
  } catch (error) {
    app.setStatus(`Bulk config failed: ${toErrorMessage(error)}`, 'error');
  }
}

/**
 * @description Update a single tool's auth mode for the selected agent.
 */
export async function updateSelectedToolAuthMode(app, toolId, authMode) {
  if (!app.state.selectedAgentProfile || !toolId) {
    return;
  }
  app.setStatus(`Updating ${toolId} to ${authMode}...`, 'info');
  try {
    await putJson(
      `/api/agents/${encodeURIComponent(app.state.selectedAgentProfile.agentId)}/tools/${encodeURIComponent(toolId)}`,
      { authMode },
    );
    app.state.selectedAgentTools = app.state.selectedAgentTools.map((tool) => (
      tool.id === toolId ? { ...tool, authMode } : tool
    ));
    renderSelectedAgentPanelMarkup(app);
    renderSelectedAgentAuthState(app);
    app.setStatus(`Updated ${toolId} to ${authMode}.`, 'success');
  } catch (error) {
    app.setStatus(`Failed to update ${toolId}: ${toErrorMessage(error)}`, 'error');
  }
}

// ── Auth Status ─────────────────────────────────────────────────────────────

/**
 * @description Render the auth state badges and buttons in the selected agent panel.
 */
export function renderSelectedAgentAuthState(app) {
  const titleNode = app.elements.selectedAgentPanel.querySelector('#selectedAgentAuthTitle');
  const infoNode = app.elements.selectedAgentPanel.querySelector('#selectedAgentAuthInfo');
  const badgeNode = app.elements.selectedAgentPanel.querySelector('#selectedAgentAuthStatusBadge');
  const signInButton = app.elements.selectedAgentPanel.querySelector('#selectedAgentAuthSignInButton');
  const signOutButton = app.elements.selectedAgentPanel.querySelector('#selectedAgentAuthSignOutButton');
  if (!titleNode || !infoNode || !badgeNode || !signInButton || !signOutButton) {
    return;
  }
  const providerId = getSelectedProviderId(app);
  const authConfig = getProviderAuthConfig(providerId);
  const authState = app.state.selectedAgentAuth || createPendingAuthState();
  titleNode.textContent = authConfig?.title || 'Provider Authentication Unavailable';
  infoNode.textContent = authState.infoText || authConfig?.infoText || 'This bot does not currently expose provider auth controls here.';
  badgeNode.textContent = authState.label;
  badgeNode.dataset.tone = authState.tone;
  signInButton.hidden = !authState.canSignIn;
  signOutButton.hidden = !authState.canSignOut;
  signInButton.textContent = authConfig?.signInLabel || 'Sign In';
  signOutButton.textContent = authConfig?.signOutLabel || 'Sign Out';
}

/**
 * @description Refresh the auth status for the currently selected provider.
 */
export async function refreshSelectedAgentAuthStatus(app) {
  const providerId = getSelectedProviderId(app);
  const authConfig = getProviderAuthConfig(providerId);
  if (!authConfig) {
    app.state.selectedAgentAuth = createUnsupportedAuthState(providerId);
    renderSelectedAgentAuthState(app);
    return;
  }
  // Config-only providers (auto) — no OAuth flow, just show info
  if (authConfig.configOnly) {
    app.state.selectedAgentAuth = {
      authenticated: true, canSignIn: false, canSignOut: false,
      infoText: authConfig.infoText, label: authConfig.title, tone: 'info',
    };
    renderSelectedAgentAuthState(app);
    return;
  }
  app.state.selectedAgentAuth = createLoadingAuthState(authConfig.infoText);
  renderSelectedAgentAuthState(app);
  try {
    const payload = await requestJson(authConfig.statusEndpoint);
    app.state.selectedAgentAuth = normalizeProviderAuthState(providerId, payload, authConfig.infoText);
  } catch (error) {
    app.state.selectedAgentAuth = createErrorAuthState(authConfig.infoText, toErrorMessage(error));
    app.setStatus(`Failed to read ${getProviderLabel(providerId)} auth status.`, 'error');
  }
  renderSelectedAgentAuthState(app);
}

/**
 * @description Start the provider auth flow (popup or redirect).
 */
export async function startSelectedAgentAuth(app) {
  const providerId = getSelectedProviderId(app);
  const authConfig = getProviderAuthConfig(providerId);
  if (!authConfig) {
    return;
  }
  try {
    const result = await requestJson(authConfig.startEndpoint);
    const authUrl = readString(result?.authUrl);
    if (authUrl) {
      const popup = window.open(authUrl, `${providerId}-auth`, 'width=620,height=780');
      if (!popup) {
        window.location.assign(authUrl);
        return;
      }
    }
    app.setStatus(`${getProviderLabel(providerId)} sign-in started.`, 'info');
    app.state.selectedAgentAuth = createPendingAuthState(authConfig.infoText, 'Waiting for sign-in to finish...');
    renderSelectedAgentAuthState(app);
    await pollSelectedAgentAuthStatus(app);
  } catch (error) {
    app.state.selectedAgentAuth = createErrorAuthState(authConfig.infoText, toErrorMessage(error));
    renderSelectedAgentAuthState(app);
    app.setStatus(`Failed to start ${getProviderLabel(providerId)} sign-in.`, 'error');
  }
}

/**
 * @description Sign out of the current provider.
 */
export async function signOutSelectedAgentAuth(app) {
  const providerId = getSelectedProviderId(app);
  const authConfig = getProviderAuthConfig(providerId);
  if (!authConfig) {
    return;
  }
  try {
    await requestJson(authConfig.signOutEndpoint, { method: 'POST', body: JSON.stringify({}) });
    app.setStatus(`${getProviderLabel(providerId)} credentials removed.`, 'success');
    await refreshSelectedAgentAuthStatus(app);
  } catch (error) {
    app.state.selectedAgentAuth = createErrorAuthState(authConfig.infoText, toErrorMessage(error));
    renderSelectedAgentAuthState(app);
    app.setStatus(`Failed to sign out ${getProviderLabel(providerId)}.`, 'error');
  }
}

async function pollSelectedAgentAuthStatus(app) {
  const providerId = getSelectedProviderId(app);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 180000) {
    await delay(2000);
    await refreshSelectedAgentAuthStatus(app);
    if (app.state.selectedAgentAuth?.authenticated) {
      app.setStatus(`${getProviderLabel(providerId)} sign-in complete.`, 'success');
      return;
    }
  }
  app.setStatus(`${getProviderLabel(providerId)} sign-in timed out.`, 'error');
}

function getSelectedProviderId(app) {
  const selectedValue = app.elements.selectedAgentPanel.querySelector('#agentProviderInput')?.value;
  return readString(selectedValue) || readString(app.state.selectedAgentProfile?.providerId);
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * @description Render the selected agent panel markup into the container.
 */
export function renderSelectedAgentPanelMarkup(app) {
  const agent = findSelectedAgent(app.state.agents, app.state.selectedAgentId);
  app.elements.agentConfigHeading.textContent = agent
    ? `Bot Config — ${readAgentName(agent)}`
    : 'Choose an Agent';

  if (!agent || !app.state.selectedAgentProfile) {
    app.elements.selectedAgentPanel.innerHTML = '<div class="empty-state">Select a bot below to load its native OSHAL profile and tool settings.</div>';
    return;
  }

  const profile = app.state.selectedAgentProfile;
  const tools = Array.isArray(app.state.selectedAgentTools) ? app.state.selectedAgentTools : [];
  const runtimeConfigMarkup = renderRuntimeConfigSection(app.state.selectedAgentRuntimeConfig);
  app.elements.selectedAgentPanel.innerHTML = `
    <div class="agent-config-summary" data-testid="selected-agent-summary">
      ${renderAgentMetric('Agent Id', profile.agentId)}
      ${profile.harnessType ? renderAgentMetric('Harness', profile.harnessType) : ''}
      ${renderAgentMetric('API', profile.apiType || profile.providerId)}
      ${renderAgentMetric('Model', profile.modelId || 'Inherited')}
      ${renderAgentMetric('Project URL', profile.projectUrl || 'Not set')}
    </div>
    <div class="agent-config-grid">
      <form id="agentProfileForm" class="agent-config-form" data-testid="agent-profile-form">
        <label class="field"><span>Name</span><input id="agentNameInput" type="text" value="${escapeHtmlAttribute(profile.name)}"></label>
        <label class="field"><span>Project URL</span><input id="agentProjectUrlInput" type="url" value="${escapeHtmlAttribute(profile.projectUrl || '')}" placeholder="https://github.com/..."></label>
        <label class="field"><span>Theme Preference</span><select id="agentThemeInput">${renderThemeOptions(profile.themePreference)}</select></label>
        ${renderProviderFieldMarkup(app.state.providers, agent, profile)}
        ${renderModelFieldMarkup(app.state.providers, agent, profile)}
        <label class="field"><span>Status</span><select id="agentStatusInput">${renderStatusOptions(profile.status)}</select></label>
        <label class="field field-wide"><span>Selector Skills</span><textarea id="agentSelectorSkillsInput" placeholder="Describe the routing and skills this bot should advertise.">${escapeHtml(profile.selectorSkillsText || '')}</textarea><span class="field-copy">This persists through the narrow OSHAL profile route and feeds selector composition.</span></label>
        <div class="field field-wide checkbox-field"><span>Bulk Config Controls</span><label class="checkbox-row" for="agentExcludeFromBulkInput"><input id="agentExcludeFromBulkInput" type="checkbox"${profile.excludeFromBulkConfig ? ' checked' : ''}><span>Exclude this bot from bulk configure actions unless the caller explicitly includes excluded bots.</span></label></div>
        <div class="agent-config-actions"><button id="saveAgentProfileButton" type="submit">Save Bot Profile</button><a class="ghost-link" href="/cockpit/" target="_top" rel="noreferrer">Back to Cockpit</a></div>
      </form>
      <section>
        <section class="provider-auth-card" aria-labelledby="selectedAgentAuthTitle">
          <div class="provider-auth-copy"><p class="panel-eyebrow">Provider Authentication</p><h3 id="selectedAgentAuthTitle">Checking provider authentication...</h3><p id="selectedAgentAuthInfo" class="field-copy">This bot uses provider credentials managed through the same popup auth flow as the dedicated bot workspace.</p></div>
          <div class="provider-auth-actions"><span id="selectedAgentAuthStatusBadge" class="auth-status-badge" data-tone="info">Checking authentication...</span><div class="agent-config-actions"><button id="selectedAgentAuthSignInButton" type="button" data-provider-auth-action="signin" hidden>Sign In</button><button id="selectedAgentAuthSignOutButton" type="button" data-provider-auth-action="signout" hidden>Sign Out</button></div></div>
        </section>
        <div class="panel-eyebrow">Tool Auth Modes</div>
        <div class="agent-tools-list" data-testid="agent-tools-config-list">${tools.length ? tools.map((tool) => renderSelectedAgentToolCard(tool)).join('') : '<div class="empty-state">No tool switches are registered for this agent yet.</div>'}</div>
      </section>
    </div>
    <section class="bulk-config-card" data-testid="bulk-config-card">
      <div class="panel-eyebrow">Bulk Swarm Profile</div>
      <h3>Use ${escapeHtml(profile.name)} as the template</h3>
      <p class="field-copy">Bulk actions propagate provider, model, status, project URL, selector skills, and theme from the selected bot. They never rename other bots, and they skip bots marked with the exclude checkbox above.</p>
      <div class="chip-list"><span class="chip">Eligible bot count: ${app.state.agents.filter((a) => a.excludeFromBulkConfig !== true).length}</span><span class="chip">Selected bot excluded: ${profile.excludeFromBulkConfig ? 'yes' : 'no'}</span></div>
      <div class="agent-config-actions"><button type="button" data-bulk-profile-mode="unset">Configure All Unset Bots</button><button type="button" data-bulk-profile-mode="all">Configure All Eligible Bots</button></div>
    </section>
    <section class="runtime-config-card" data-testid="runtime-config-card">
      ${runtimeConfigMarkup}
    </section>`;
}

/**
 * @description Render agent cards in the agent list container.
 */
export function renderAgentCards(elements, agents) {
  if (!agents.length) {
    elements.agentList.innerHTML = '<div class="empty-state">No persisted agents found.</div>';
    return;
  }
  elements.agentList.innerHTML = agents.map((agent) => renderAgentCard(agent)).join('');
}

/**
 * @description Render one persisted agent card.
 */
function renderAgentCard(agent) {
  const agentId = getAgentId(agent);
  const name = readAgentName(agent) || 'Unnamed Agent';
  const profileRoute = `/api/agents/${agentId}/profile`;
  const toolRoute = `/api/agents/${agentId}/tools`;
  const selectedClass = agentId === readSelectedAgentIdFromUrl() ? ' is-selected' : '';
  return `
    <article class="agent-card${selectedClass}" data-testid="agent-card-${escapeHtmlAttribute(agentId)}">
      <div class="agent-meta"><span class="agent-name">${escapeHtml(name)}</span><span class="agent-id">${escapeHtml(agentId)}</span></div>
      <p class="agent-copy">Bot-specific identity and personalization stay under the profile route, while tool runtime state stays under the tool route.</p>
      <div class="chip-list"><span class="chip">${escapeHtml(profileRoute)}</span><span class="chip">${escapeHtml(toolRoute)}</span></div>
      <div class="agent-card-actions"><button type="button" data-agent-config-id="${escapeHtmlAttribute(agentId)}">Configure Bot</button><a class="ghost-link" href="/cockpit/" target="_top" rel="noreferrer">Open Cockpit</a></div>
    </article>`;
}

function renderAgentMetric(label, value) {
  return `<article class="agent-config-metric"><span class="agent-config-metric-label">${escapeHtml(label)}</span><div class="agent-config-metric-value">${escapeHtml(readString(value) || 'Not set')}</div></article>`;
}

function renderSelectedAgentToolCard(tool) {
  const toolId = readString(tool.id);
  const toolName = readString(tool.name) || toolId || 'Unnamed Tool';
  const authMode = readString(tool.authMode) || 'off';
  return `
    <article class="agent-tool-card">
      <div class="agent-tool-card-top"><div class="agent-tool-card-name">${escapeHtml(toolName)}</div><code>${escapeHtml(toolId)}</code></div>
      <div class="field-copy">Per-tool runtime config remains tool-specific, but auth mode stays editable here so each bot keeps an understandable config surface.</div>
      <div class="tool-auth-row"><select class="tool-auth-select" data-tool-id="${escapeHtmlAttribute(toolId)}">${renderAuthModeOptions(authMode)}</select><span class="tool-auth-status">Current mode: ${escapeHtml(authMode)}</span></div>
    </article>`;
}

// ── Option Renderers ────────────────────────────────────────────────────────

function renderThemeOptions(selectedTheme) {
  return COCKPIT_THEMES.map((theme) => {
    const label = theme.split('-').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
    return `<option value="${escapeHtml(theme)}"${theme === selectedTheme ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

/**
 * @description Render model options for the selected bot profile form.
 */
export function renderModelOptionMarkup(providers, providerId, selectedModelId) {
  const preferredModelId = resolvePreferredModelId(providers, providerId, selectedModelId);
  if (!Array.isArray(providers) || providers.length === 0) {
    return preferredModelId ? `<option value="${escapeHtml(preferredModelId)}" selected>${escapeHtml(preferredModelId)}</option>` : '<option value="">No models available</option>';
  }
  const providerMeta = providers.find((p) => p.id === providerId);
  const models = Array.isArray(providerMeta?.models) ? providerMeta.models : [];
  if (models.length === 0) {
    return preferredModelId ? `<option value="${escapeHtml(preferredModelId)}" selected>${escapeHtml(preferredModelId)}</option>` : '<option value="">No models available</option>';
  }
  const options = models.map((model) => {
    const modelId = readString(model.id);
    const modelLabel = readString(model.name || model.id) || 'Unnamed Model';
    const selected = modelId === preferredModelId ? ' selected' : '';
    return `<option value="${escapeHtml(modelId)}"${selected}>${escapeHtml(modelLabel)}</option>`;
  }).join('');
  const selectedKnown = models.some((model) => readString(model.id) === preferredModelId);
  return preferredModelId && !selectedKnown
    ? `<option value="${escapeHtml(preferredModelId)}" selected>${escapeHtml(preferredModelId)}</option>${options}`
    : options;
}

function renderProviderOptionMarkup(providers, selectedValue) {
  if (!Array.isArray(providers) || providers.length === 0) {
    return `<option value="${escapeHtml(selectedValue || 'anthropic')}">${escapeHtml(selectedValue || 'anthropic')}</option>`;
  }
  const options = providers.map((provider) => {
    const selected = provider.id === selectedValue ? ' selected' : '';
    const label = readString(provider.displayName || provider.name || provider.id);
    return `<option value="${escapeHtml(provider.id)}"${selected}>${escapeHtml(label)}</option>`;
  }).join('');
  const selectedKnown = providers.some((provider) => provider.id === selectedValue);
  return selectedValue && !selectedKnown
    ? `<option value="${escapeHtml(selectedValue)}" selected>${escapeHtml(selectedValue)}</option>${options}`
    : options;
}

function resolvePreferredModelId(providers, providerId, selectedModelId) {
  const selected = readString(selectedModelId);
  if (selected) return selected;
  const providerMeta = Array.isArray(providers) ? providers.find((p) => p.id === providerId) : null;
  return readString(providerMeta?.defaultModelId || providerMeta?.models?.[0]?.id);
}

/**
 * @description Render the provider picker from the server-resolved precedence policy.
 * The API's precedence note is displayed verbatim; the browser never re-derives the rule.
 */
function renderProviderFieldMarkup(providers, agent, profile) {
  const providerPinned = agent.providerOverridable === false;
  const savedProvider = readString(profile.providerId).toLowerCase() === 'auto'
    ? ''
    : readString(profile.providerId);
  const selectedProvider = providerPinned
    ? readString(agent.effectiveProvider) || savedProvider
    : savedProvider || readString(agent.effectiveProvider);
  const precedenceNote = readString(agent.precedenceNote);
  return `
    <label class="field"><span>Provider</span>
      <select id="agentProviderInput" data-original-value="${escapeHtmlAttribute(selectedProvider)}" aria-describedby="agentProviderPrecedence"${providerPinned ? ' disabled' : ''}>${renderProviderOptionMarkup(providers, selectedProvider)}</select>
      <span id="agentProviderPrecedence" class="field-copy" data-provider-source="${escapeHtmlAttribute(agent.providerSource || 'unknown')}">${escapeHtml(precedenceNote)}</span>
    </label>`;
}

/** @description Render the model picker, which can remain writable under a pinned harness. */
function renderModelFieldMarkup(providers, agent, profile) {
  const modelPinned = agent.modelOverridable === false;
  const providerId = readString(agent.effectiveProvider) || readString(profile.providerId);
  const modelId = resolvePreferredModelId(providers, providerId, profile.modelId || agent.effectiveModel);
  return `<label class="field"><span>Model</span><select id="agentModelInput" data-original-value="${escapeHtmlAttribute(modelId)}"${modelPinned ? ' disabled' : ''}>${renderModelOptionMarkup(providers, providerId, modelId)}</select></label>`;
}

function renderStatusOptions(selectedStatus) {
  const normalized = readString(selectedStatus) || 'active';
  return ['active', 'paused', 'disabled']
    .map((status) => `<option value="${status}"${status === normalized ? ' selected' : ''}>${status}</option>`)
    .join('');
}

function renderAuthModeOptions(selectedValue) {
  return ['auto', 'ask', 'off']
    .map((mode) => `<option value="${mode}"${mode === selectedValue ? ' selected' : ''}>${mode}</option>`)
    .join('');
}

// ── Payload Builders ────────────────────────────────────────────────────────

function buildSelectedAgentProfilePayload(container) {
  const providerInput = container.querySelector('#agentProviderInput');
  const modelInput = container.querySelector('#agentModelInput');
  const payload = {
    name: container.querySelector('#agentNameInput')?.value.trim() || '',
    status: container.querySelector('#agentStatusInput')?.value || 'active',
    projectUrl: container.querySelector('#agentProjectUrlInput')?.value.trim() || '',
    selectorSkillsText: container.querySelector('#agentSelectorSkillsInput')?.value || '',
    themePreference: container.querySelector('#agentThemeInput')?.value || 'midnight',
    excludeFromBulkConfig: container.querySelector('#agentExcludeFromBulkInput')?.checked === true,
  };
  // Disabled precedence-bound inputs are display-only and must never contribute persisted values.
  if (providerInput && !providerInput.disabled) payload.providerId = providerInput.value || 'anthropic';
  if (modelInput && !modelInput.disabled) payload.modelId = modelInput.value.trim();
  return payload;
}

/**
 * @description Build an authoritative runtime update only when provider/model values changed.
 * A pinned provider select never contributes its DOM value; model-only changes carry the API's
 * effective provider so bot-node's provider-required switch endpoint remains internally coherent.
 */
function buildSelectedAgentRuntimePayload(container, agent, profile) {
  const providerInput = container.querySelector('#agentProviderInput');
  const modelInput = container.querySelector('#agentModelInput');
  const providerId = readString(providerInput?.value);
  const modelId = readString(modelInput?.value);
  const currentProvider = readString(profile.providerId).toLowerCase() === 'auto'
    ? readString(agent?.effectiveProvider)
    : readString(profile.providerId) || readString(agent?.effectiveProvider);
  const originalProvider = readOriginalInputValue(providerInput, currentProvider);
  const originalModel = readOriginalInputValue(modelInput, profile.modelId || agent?.effectiveModel);
  const providerChanged = !!providerInput && !providerInput.disabled
    && providerId !== originalProvider;
  const modelChanged = !!modelInput && !modelInput.disabled
    && modelId !== originalModel;
  if (!providerChanged && !modelChanged) return null;

  const effectiveProvider = providerChanged
    ? providerId
    : readString(agent?.effectiveProvider) || readString(profile.providerId);
  return {
    ...(effectiveProvider ? { providerId: effectiveProvider } : {}),
    ...(modelChanged ? { modelId } : {}),
  };
}

function readOriginalInputValue(input, fallback) {
  if (input?.dataset && Object.prototype.hasOwnProperty.call(input.dataset, 'originalValue')) {
    return readString(input.dataset.originalValue);
  }
  return readString(fallback);
}

function buildBulkTemplatePayload(container) {
  const payload = {
    status: container.querySelector('#agentStatusInput')?.value || '',
    providerId: container.querySelector('#agentProviderInput')?.value || '',
    modelId: container.querySelector('#agentModelInput')?.value.trim() || '',
    projectUrl: container.querySelector('#agentProjectUrlInput')?.value.trim() || '',
    selectorSkillsText: container.querySelector('#agentSelectorSkillsInput')?.value || '',
    themePreference: container.querySelector('#agentThemeInput')?.value || '',
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => readString(value).length > 0));
}

/**
 * @description Render ownership cards in the ownership grid container.
 */
export function renderOwnershipCards(elements, ownership) {
  const cards = [
    renderOwnershipCard('Shared OSHAL Config', ownership?.globalConfig),
    renderOwnershipCard('Per-Agent Profile', ownership?.perAgentProfile),
    renderOwnershipCard('Per-Agent Tools', ownership?.perAgentTools),
    renderLegacyCard(ownership?.legacyCompatibility),
  ];
  elements.ownershipGrid.innerHTML = cards.join('');
}

function renderOwnershipCard(label, section) {
  const examples = Array.isArray(section?.examples) ? section.examples : [];
  return `
    <article class="ownership-card">
      <h3>${escapeHtml(label)}</h3>
      <div class="route-code">${escapeHtml(readString(section?.routeBase))}</div>
      <p class="ownership-copy">${escapeHtml(readString(section?.summary))}</p>
      <div class="chip-list">${examples.map((example) => `<span class="chip">${escapeHtml(example)}</span>`).join('')}</div>
    </article>`;
}

function renderLegacyCard(section) {
  const guidance = Array.isArray(section?.guidance) ? section.guidance : [];
  return `
    <article class="ownership-card">
      <h3>Legacy Compatibility</h3>
      <div class="route-code">${(section?.routes || []).map((route) => escapeHtml(route)).join(' · ')}</div>
      <p class="ownership-copy">${escapeHtml(readString(section?.summary))}</p>
      <div class="chip-list">${guidance.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join('')}</div>
    </article>`;
}
