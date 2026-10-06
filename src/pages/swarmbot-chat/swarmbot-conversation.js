/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Recover unavailable bot conversations with explicit fresh-thread creation while preserving stored history and the unsent draft.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Trace conversation outcomes and caught failures without retaining private API text, request data or stack URLs.
 */
import { createUiLogger } from '../shared/ui-debug.js';

const logger = createUiLogger('swarmbot-conversation');
const nativeErrorStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
let operationSequence = 0;
/** @description Keep the existing API error-message fallback unchanged.
 * @param {unknown} value Possible API text.
 * @returns {string} Trimmed text, or an empty fallback.
 */
const readString = value => typeof value === 'string' ? value.trim() : '';

/** @description Retain useful native source locations while excluding error text and URL credentials.
 * @param {unknown} error The caught value, never passed directly to the debug store.
 * @returns {{name: string, stack: string}} A bounded diagnostic projection.
 */
function safeConversationError(error) {
  if (!(error instanceof Error)) return { name: 'NonError', stack: '' };
  const candidateName = Object.getOwnPropertyDescriptor(error, 'name')?.value
    || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error), 'name')?.value;
  const names = ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError'];
  const name = names.includes(candidateName) ? candidateName : 'Error';
  const stackDescriptor = Object.getOwnPropertyDescriptor(error, 'stack');
  const safeText = ['name', 'message'].every(field => {
    const descriptor = Object.getOwnPropertyDescriptor(error, field)
      || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error), field);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string';
  });
  const formatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  // Chromium uses its native accessor; arbitrary getters and stack formatters must not execute during logging.
  const stack = stackDescriptor && 'value' in stackDescriptor ? stackDescriptor.value
    : nativeErrorStackGetter && stackDescriptor?.get === nativeErrorStackGetter && safeText
      && (!formatter || 'value' in formatter && formatter.value === undefined) ? nativeErrorStackGetter.call(error) : '';
  // Stack URLs and function names can contain private text; retain only known module coordinates.
  const frames = typeof stack === 'string' ? stack.slice(0, 16384).split('\n').slice(0, 64).flatMap(line => {
    const match = /\b(swarmbot-conversation\.js|swarmbot-chat\.js|ui-debug\.js)(?:[?#][^\s)]*)?:(\d{1,6}):(\d{1,6})(?:\)|$)/.exec(line);
    return match ? [`at ${match[1]}:${match[2]}:${match[3]}`] : [];
  }).slice(0, 12) : [];
  return { name, stack: frames.join('\n') };
}

/** @description Pair every operation with a terminal timing record, including early returns and failures.
 * @param {string} operation Code-owned operation name.
 * @param {object} fields Allowlisted route/method/status metadata only.
 * @returns {{error: Function, finish: Function}} Safe error and terminal observers.
 */
function observeOperation(operation, fields = {}) {
  const operationId = ++operationSequence;
  const startedAt = performance.now();
  logger.debug('Conversation operation entered', { operation, operationId, phase: 'entry', ...fields });
  return {
    error(error, context = {}) {
      logger.error('Conversation operation failed', {
        operation, operationId, phase: 'error', outcome: 'failed', durationMs: Math.max(0, performance.now() - startedAt),
        ...fields, ...context, err: safeConversationError(error),
      });
    },
    finish(outcome, context = {}) {
      logger.debug('Conversation operation exited', {
        operation, operationId, phase: 'exit', outcome, durationMs: Math.max(0, performance.now() - startedAt),
        ...fields, ...context,
      });
    },
  };
}

/** @description Open the actual selected-bot conversation and render an actionable failure instead of leaving Booting.
 * @param {object} app Native workspace and its existing canonical API methods.
 * @returns {Promise<void>} Completion after the normal view or explicit recovery action is rendered.
 */
export async function bootstrapConversation(app) {
  const observation = observeOperation('bootstrapConversation');
  let outcome = 'failed';
  try {
    if (!app.state.agentId) {
      app.renderAwaitingAgentSelectionState();
      app.setStatus(document.documentElement.dataset.embedded === 'cockpit'
        ? 'Select a swarm bot to load this workspace.' : 'Choose a swarm bot to begin.', 'info');
      outcome = 'awaiting-agent'; return;
    }
    if (await app.resolveGuestMode()) {
      await loadGuestProfile(app);
      app.renderGuestReadOnlyState(); outcome = 'guest-read-only'; return;
    }
    await app.loadProfile();
    await app.ensureTask();
    await app.loadMessages();
    app.connectStream();
    app.openInitialWorkspaceAction();
    app.elements.messageInput.disabled = false;
    app.elements.sendBtn.disabled = false;
    outcome = 'ready';
  } catch (error) { observation.error(error); showConversationFailure(app, error); }
  finally { observation.finish(outcome); }
}

/** @description A guest profile is optional; its failure must not enable conversation creation or recovery.
 * @param {object} app Native workspace with the existing profile loader.
 * @returns {Promise<void>} Completion even when the optional profile is unavailable.
 */
async function loadGuestProfile(app) {
  const observation = observeOperation('loadGuestProfile');
  let outcome = 'failed';
  try { await app.loadProfile(); outcome = 'loaded'; }
  catch (error) { observation.error(error); }
  finally { observation.finish(outcome); }
}

/** @description Show a safe recovery action without claiming unavailable history has been loaded.
 * @param {object} app Native workspace.
 * @param {unknown} error Actual failed API or initialization outcome.
 * @returns {void} The synchronous recovery view; stored history and the draft are retained.
 */
export function showConversationFailure(app, error) {
  const observation = observeOperation('showConversationFailure');
  let outcome = 'failed';
  observation.error(error);
  try {
    app.disconnectStream(); app.setTyping(false);
    app.elements.messageInput.disabled = true;
    app.elements.sendBtn.disabled = true;
    app.setStatus('This conversation is unavailable. Start a new conversation to continue.', 'error');
    if (app.state.guestMode || !app.state.agentId) { outcome = 'recovery-unavailable'; return; }
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Start new conversation';
    button.dataset.action = 'new-conversation';
    button.addEventListener('click', async () => {
      button.disabled = true;
      await restartConversation(app);
    });
    app.elements.statusBanner.append(' ', button);
    outcome = 'recovery-offered';
  } finally { observation.finish(outcome); }
}

/** @description Explicitly create a new owned thread; retain the previous stored conversation and local draft.
 * @param {object} app Native workspace using unchanged task creation and history endpoints.
 * @returns {Promise<void>} Completion after a usable new thread or another explicit retry action.
 */
async function restartConversation(app) {
  const observation = observeOperation('restartConversation');
  let outcome = 'failed';
  try {
    app.state.taskId = '';
    await app.ensureTask();
    await app.loadMessages();
    app.connectStream();
    app.elements.messageInput.disabled = false;
    app.elements.sendBtn.disabled = false;
    app.setStatus('New conversation ready.', 'success');
    app.elements.messageInput.focus();
    outcome = 'ready';
  } catch (error) { observation.error(error); showConversationFailure(app, error); }
  finally { observation.finish(outcome); }
}

/** @description Report code-owned route shapes rather than private task identifiers, hosts or URL queries.
 * @param {unknown} url The actual fetch target, used only for route classification.
 * @returns {string} A canonical route label or the bounded unknown label.
 */
function canonicalRequestPath(url) {
  if (typeof url !== 'string') return 'other';
  const path = url.split(/[?#]/, 1)[0];
  if (['/api/auth/user', '/api/tasks', '/api/send-message'].includes(path)) return path;
  if (/^\/api\/agents\/[^/]+\/profile$/.test(path)) return '/api/agents/:agentId/profile';
  if (/^\/api\/[^/]+\/messages$/.test(path)) return '/api/:taskId/messages';
  return 'other';
}

/** @description Read the canonical conversation API with its existing credentials and error contract.
 * @param {string} url Canonical route; private identifiers and queries are excluded from diagnostics.
 * @param {object} options Existing request options, never retained in the debug store.
 * @returns {Promise<unknown>} Actual response, or the unchanged thrown API error on refusal.
 */
export async function requestJson(url, options = {}) {
  const method = options.method || 'GET';
  const safeMethod = typeof method === 'string' && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
    ? method.toUpperCase() : 'other';
  const observation = observeOperation('requestJson', { method: safeMethod, path: canonicalRequestPath(url) });
  let outcome = 'failed', status;
  try {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    status = response.status;
    const payload = await parseResponseJson(response);
    if (!response.ok) {
      const errorMessage = readString(payload?.message || payload?.error) || `${response.status} ${response.statusText}`;
      throw new Error(errorMessage);
    }
    outcome = 'success'; return payload;
  } catch (error) { observation.error(error, { status }); throw error; }
  finally { observation.finish(outcome, { status }); }
}

/** @description Preserve the existing null fallback while recording malformed JSON without its private contents.
 * @param {Response} response Actual fetch response.
 * @returns {Promise<unknown>} Parsed JSON, or null when decoding fails.
 */
async function parseResponseJson(response) {
  const observation = observeOperation('parseResponseJson', { status: response.status });
  let outcome = 'failed';
  try { const payload = await response.json(); outcome = 'parsed'; return payload; }
  catch (error) { observation.error(error); return null; }
  finally { observation.finish(outcome); }
}
