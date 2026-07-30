/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the agent-profile and avatar handling of the chat config modal — profile form rendering, the avatar preview and file status, the pending-avatar lifecycle, the profile save payload, the avatar upload, and the profile input bindings — out of chat-config-modal.mjs to bring that file back under the 1000-code-line cap.
 */

// Bodies below were MOVED verbatim out of chat-config-modal.mjs, including their original
// four-space indentation: the source file kept that indentation at module top level (a leftover
// from an IIFE removed long ago), and re-indenting would rewrite whitespace inside the HTML
// template literals. Exports are declared in one `export { ... }` list at the end so no moved
// line changed at all.

import { escapeHtml } from '/chat-assets/chat-workspace-popups-utils.mjs';
import {
  DEFAULT_CHAT_AGENT_NAME,
  elements,
  getActiveAgentId,
  getChatAgentConfig,
  getCurrentAvatarValue,
  readNonEmptyString,
  renderProviderStatus,
  uiState,
} from '/chat-assets/chat-config-modal-state.mjs';

/**
 * @description Re-render the agent profile form from the effective profile, including the avatar
 * preview and the avatar file status line.
 * @returns {void}
 */
    function renderAgentProfile() {
      const agentConfig = getChatAgentConfig();
      elements.agentNameInput.value = agentConfig.name;
      if (elements.agentAvatarFileInput) {
        elements.agentAvatarFileInput.value = '';
      }
      elements.projectUrlInput.value = agentConfig.projectUrl;
      elements.selectorSkillsInput.value = agentConfig.selectorSkillsText;
      elements.agentDisplayName.textContent = agentConfig.name;
      renderAvatarPreview(getCurrentAvatarValue());
      renderAvatarFileStatus();
    }

    function renderAvatarPreview(avatarUrl) {
      const resolvedUrl = readNonEmptyString(avatarUrl);
      if (resolvedUrl) {
        elements.agentAvatarPreview.innerHTML = `<img src="${escapeHtml(resolvedUrl)}" alt="Agent avatar">`;
      } else {
        elements.agentAvatarPreview.innerHTML = '<span class="codicon codicon-hubot"></span>';
      }
    }

    function renderAvatarFileStatus() {
      if (!elements.agentAvatarFileStatus) {
        return;
      }

      if (uiState.avatarRemoved) {
        elements.agentAvatarFileStatus.textContent = 'Picture will be removed from the bot profile when you save.';
        return;
      }

      if (uiState.pendingAvatarFile) {
        elements.agentAvatarFileStatus.textContent = `${uiState.pendingAvatarFile.name} selected. Saving uploads it into the database for this bot.`;
        return;
      }

      if (readNonEmptyString(uiState.agentProfile?.avatarUrl)) {
        elements.agentAvatarFileStatus.textContent = 'Current picture is stored in the bot profile record.';
        return;
      }

      elements.agentAvatarFileStatus.textContent = 'Upload an image and it will be stored in the bot profile record.';
    }

/**
 * @description Drop any pending avatar upload or removal. Called after a successful save and on
 * every state reload so a stale pending file cannot be re-uploaded.
 * @returns {void}
 */
    function resetPendingAvatarState() {
      uiState.pendingAvatarFile = null;
      uiState.pendingAvatarPreviewUrl = '';
      uiState.avatarRemoved = false;
    }

/**
 * @description Build the profile payload to persist. avatarUrl is only included when there is an
 * uploaded URL or an explicit removal, so an untouched avatar is never overwritten.
 * @param {string} [uploadedAvatarUrl] - URL returned by the avatar upload, if one ran.
 * @returns {object} Profile payload for PUT /api/agents/:id/profile.
 */
    function buildNextChatProfilePayload(uploadedAvatarUrl = '') {
      const payload = {
        name: readNonEmptyString(elements.agentNameInput.value) || DEFAULT_CHAT_AGENT_NAME,
        projectUrl: readNonEmptyString(elements.projectUrlInput.value),
        selectorSkillsText: readNonEmptyString(elements.selectorSkillsInput.value),
        themePreference: uiState.theme,
      };

      if (readNonEmptyString(uploadedAvatarUrl)) {
        payload.avatarUrl = readNonEmptyString(uploadedAvatarUrl);
      } else if (uiState.avatarRemoved) {
        payload.avatarUrl = '';
      }

      return payload;
    }

/**
 * @description Upload a pending avatar file, if one is selected, and adopt the returned profile.
 * @returns {Promise<string>} The stored avatar URL, or empty when nothing was pending.
 */
    async function uploadPendingAvatarIfNeeded() {
      if (!uiState.pendingAvatarFile) {
        return '';
      }

      const formData = new FormData();
      formData.append('avatar', uiState.pendingAvatarFile);

      const response = await fetch(`/api/agents/${getActiveAgentId()}/profile/avatar`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || payload?.message || `${response.status} ${response.statusText}`);
      }

      if (payload?.profile && typeof payload.profile === 'object') {
        uiState.agentProfile = payload.profile;
      }

      return readNonEmptyString(payload?.profile?.avatarUrl);
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error || new Error('Failed to read avatar file'));
        reader.readAsDataURL(file);
      });
    }

/**
 * @description Bind the agent profile inputs: name/project/selector-skills live summary updates, the
 * avatar file picker, and the clear-avatar button.
 * @returns {void}
 */
    function bindAgentProfileInputs() {
      elements.agentNameInput.addEventListener('input', () => {
        elements.agentDisplayName.textContent = readNonEmptyString(elements.agentNameInput.value) || DEFAULT_CHAT_AGENT_NAME;
        renderProviderStatus();
      });
      elements.projectUrlInput.addEventListener('input', renderProviderStatus);
      elements.selectorSkillsInput.addEventListener('input', renderProviderStatus);
      elements.agentAvatarFileInput?.addEventListener('change', async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) {
          return;
        }

        const file = target.files?.[0];
        if (!file) {
          return;
        }

        uiState.pendingAvatarFile = file;
        uiState.pendingAvatarPreviewUrl = await readFileAsDataUrl(file);
        uiState.avatarRemoved = false;
        renderAgentProfile();
      });
      elements.clearAgentAvatarBtn?.addEventListener('click', () => {
        resetPendingAvatarState();
        uiState.avatarRemoved = true;
        renderAgentProfile();
      });
    }

export {
  bindAgentProfileInputs,
  buildNextChatProfilePayload,
  renderAgentProfile,
  resetPendingAvatarState,
  uploadPendingAvatarIfNeeded,
};
