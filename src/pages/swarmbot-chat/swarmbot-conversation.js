/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Recover unavailable bot conversations with explicit fresh-thread creation while preserving stored history and the unsent draft.
 */
import { createUiLogger, serializeUiError } from '../shared/ui-debug.js';

const logger = createUiLogger('swarmbot-conversation');
const readString = value => typeof value === 'string' ? value.trim() : '';

/** @description Open the actual selected-bot conversation and render an actionable failure instead of leaving Booting.
 * @param {object} app Native workspace and its existing canonical API methods.
 */
export async function bootstrapConversation(app) {
  if (!app.state.agentId) {
    app.renderAwaitingAgentSelectionState();
    app.setStatus(document.documentElement.dataset.embedded === 'cockpit'
      ? 'Select a swarm bot to load this workspace.' : 'Choose a swarm bot to begin.', 'info');
    return;
  }
  try {
    if (await app.resolveGuestMode()) {
      await app.loadProfile().catch(() => {});
      app.renderGuestReadOnlyState(); return;
    }
    await app.loadProfile();
    await app.ensureTask();
    await app.loadMessages();
    app.connectStream();
    app.openInitialWorkspaceAction();
    app.elements.messageInput.disabled = false;
    app.elements.sendBtn.disabled = false;
  } catch (error) { showConversationFailure(app, error); }
}

/** @description Show a safe recovery action without claiming unavailable history has been loaded.
 * @param {object} app Native workspace. @param {unknown} error Actual failed API or initialization outcome.
 */
export function showConversationFailure(app, error) {
  logger.error('Conversation unavailable', { error: serializeUiError(error) });
  app.disconnectStream(); app.setTyping(false);
  app.elements.messageInput.disabled = true;
  app.elements.sendBtn.disabled = true;
  app.setStatus('This conversation is unavailable. Start a new conversation to continue.', 'error');
  if (app.state.guestMode || !app.state.agentId) return;
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = 'Start new conversation';
  button.dataset.action = 'new-conversation';
  button.addEventListener('click', async () => {
    button.disabled = true;
    await restartConversation(app);
  });
  app.elements.statusBanner.append(' ', button);
}

/** @description Explicitly create a new owned thread; retain the previous stored conversation and local draft.
 * @param {object} app Native workspace using unchanged task creation and history endpoints.
 */
async function restartConversation(app) {
  try {
    app.state.taskId = '';
    await app.ensureTask();
    await app.loadMessages();
    app.connectStream();
    app.elements.messageInput.disabled = false;
    app.elements.sendBtn.disabled = false;
    app.setStatus('New conversation ready.', 'success');
    app.elements.messageInput.focus();
  } catch (error) { showConversationFailure(app, error); }
}

/** @description Read the canonical conversation API with its existing credentials and error contract.
 * @param {string} url Canonical route. @param {object} options Existing request options. @returns {Promise<unknown>} Actual response.
 */
export async function requestJson(url, options = {}) {
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
