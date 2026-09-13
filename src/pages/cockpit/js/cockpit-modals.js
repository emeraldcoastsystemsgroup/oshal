/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted modal content rendering, auth helpers, and backend handlers from app.js to meet 1000-line cap
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Corrected fallback cockpit RAG upload routing and added structured modal error logging
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Clarified the header quick-settings modal and fixed cockpit history restores to use the live right-rail controller
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Extended Quick Settings to own heavy-tool stage defaults and custom-width reset guidance
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Replaced duplicate header login/settings/history modals with a single profile-access modal and settings handoff
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Removed the retired Presentron modal case and its generation handler (hit the dead /api/presentron/generate endpoint); presentations now open the AI Office surface
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Align Profile with portal controls and preserve verified session, explicit retry, modal focus and cancellation across late responses.
 */

// ═══ AUTH HELPERS ═══

/**
 * @description Retrieve the current authentication token.
 * @returns {string|null}
 */
export function getAuthToken() {
  return localStorage.getItem('oshal_access_token');
}

/**
 * @description Retrieve the current authenticated user identifier.
 * @returns {string|null}
 */
export function getAuthUser() {
  return localStorage.getItem('oshal_user');
}

/**
 * @description Store authentication credentials.
 * @param {string} token - The authentication token
 * @param {string} [user] - Optional user identifier
 */
export function setAuthToken(token, user) {
  localStorage.setItem('oshal_access_token', token);
  if (user) localStorage.setItem('oshal_user', user);
}

/**
 * @description Remove all authentication credentials.
 */
export function clearAuth() {
  localStorage.removeItem('oshal_access_token');
  localStorage.removeItem('oshal_user');
}

// ═══ MODAL CONTENT RENDERING ═══

/**
 * @description Render modal content based on type.
 * @param {string} modalType - The type of modal content to render
 * @param {Object} settings - Current app settings
 * @returns {{title: string, html: string, onRender?: Function}}
 */
export function renderModalContent(modalType, settings) {
  switch (modalType) {
    case 'rag':
      return {
        title: 'RAG Ingestion',
        html: `<div class="modal-content">
          <p style="margin-bottom: 16px;">Upload documents to the RAG knowledge base.</p>
          <div class="form-group"><label for="ragFileInput">Select Files:</label>
          <input type="file" id="ragFileInput" multiple accept=".pdf,.txt,.md,.doc,.docx" /></div>
          <div class="form-group"><label for="ragCollection">Collection Name:</label>
          <input type="text" id="ragCollection" value="default" placeholder="default" /></div>
          <div id="ragStatus" style="margin-top:12px;color:var(--text-muted);font-size:13px;"></div>
          <div class="modal-actions"><button class="btn-primary" id="ragUploadAction">Upload</button></div>
        </div>`,
        onRender: (app) => {
          document.getElementById('ragUploadAction')?.addEventListener('click', () => handleRAGUpload(app));
        }
      };
    case 'profile':
    case 'login':
      return renderProfileModal();
    default:
      return { title: 'Unknown', html: '<p>Unknown modal type</p>' };
  }
}

/**
 * @description Render profile/access modal content based on auth state.
 * @returns {{title: string, html: string, onRender: Function}}
 */
function renderProfileModal() {
  return {
    title: 'Profile & Access',
    html: `<section class="profile-access" id="profileModalBody" aria-busy="true">
      <p class="profile-status" id="profileStatusText" role="status" aria-live="polite">Checking sign-in...</p>
      <div class="profile-identity" id="profileIdentity"></div>
      <p class="profile-guidance">Appearance and preferences are in Settings, also available from the OSHAL menu.</p>
      <div class="profile-actions">
        <button type="button" class="profile-button profile-button-primary" id="profileSettingsAction">Settings</button>
        <button type="button" class="profile-button" id="profileRetryAction" hidden>Retry</button>
      </div>
    </section>`,
    onRender: (app) => { openProfile(app); },
  };
}

let activeProfile = null;

/** @description Apply accessible semantics to this opening only; retain the shared modal's original attributes. */
function profileSemantics(container, closeButton) {
  const attributes = [[container, 'role', 'dialog'], [container, 'aria-modal', 'true'],
    [container, 'aria-labelledby', 'modalTitle'], [closeButton, 'aria-label', 'Close Profile and Access']];
  const previous = attributes.map(([element, name]) => [element, name, element.getAttribute(name)]);
  for (const [element, name, value] of attributes) element.setAttribute(name, value);
  return () => {
    for (const [element, name, value] of previous) {
      if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
    }
  };
}

/** @description Give one Profile opening its own request, event and focus lifecycle without replacing shell handlers. */
function openProfile(app) {
  activeProfile?.dispose(false);
  const body = document.getElementById('profileModalBody'), overlay = document.getElementById('modalOverlay');
  const container = document.getElementById('modalContainer'), close = document.getElementById('modalCloseBtn');
  if (!body || !overlay || !container || !close) return;
  const returnFocus = document.activeElement, events = new AbortController();
  const restoreSemantics = profileSemantics(container, close);
  const state = { app, body, overlay, container, request: null, disposed: false, accountAction: null,
    current: () => activeProfile === state && body.isConnected && document.getElementById('profileModalBody') === body
      && !overlay.classList.contains('hidden'),
    dispose: (restoreFocus) => {
      if (state.disposed) return;
      state.disposed = true; state.request?.abort(); events.abort(); observer.disconnect();
      container.classList.remove('profile-dialog'); restoreSemantics();
      if (activeProfile === state) activeProfile = null;
      if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
    } };
  const observer = new MutationObserver(() => {
    if (!state.current()) state.dispose(overlay.classList.contains('hidden'));
  });
  activeProfile = state; container.classList.add('profile-dialog');
  observer.observe(overlay, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
  body.addEventListener('click', event => profileAction(state, event), { signal: events.signal });
  overlay.addEventListener('keydown', event => profileKey(state, event), { signal: events.signal });
  close.focus(); void hydrateProfile(state);
}

/** @description Keep keyboard navigation inside the current Profile dialog and return Escape to its opener. */
function profileKey(state, event) {
  if (!state.current()) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); state.app.closeModal(); state.dispose(true); return;
  }
  if (event.key !== 'Tab') return;
  const controls = [...state.container.querySelectorAll('button:not(:disabled), [href], [tabindex="0"]')]
    .filter(element => element.getClientRects().length > 0);
  const first = controls[0], last = controls.at(-1);
  if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
    event.preventDefault(); (event.shiftKey ? last : first)?.focus();
  }
}

/** @description Delegate only the existing explicit account and Settings actions; Retry only repeats the session GET. */
function profileAction(state, event) {
  if (!state.current()) return;
  const id = event.target.closest('button')?.id;
  if (id === 'profileSettingsAction') {
    state.dispose(false); state.app.openCockpitSettingsPage(); state.app.closeModal();
  } else if (id === 'profileRetryAction') {
    void hydrateProfile(state);
  } else if ((id === 'profileSignInAction' && state.accountAction === 'login')
    || (id === 'profileSignOutAction' && state.accountAction === 'logout')) {
    window.location.href = `${window.location.origin}/${state.accountAction}`;
  }
}

/** @description Accept only an explicit session result, never a transient failure as signed out. */
async function readProfileSession(signal) {
  const response = await fetch(`${window.location.origin}/api/auth/user`, { credentials: 'include', signal });
  if (response.status === 401) return { authenticated: false };
  if (!response.ok) throw new Error(`Profile session check returned HTTP ${response.status}`);
  const auth = await response.json();
  if (auth?.authenticated === false) return auth;
  if (auth?.authenticated === true && auth.user && typeof auth.user === 'object' && !Array.isArray(auth.user)) return auth;
  throw new Error('Profile session response was invalid');
}

/** @description Bound the current session read; closing, replacement or another attempt retires its result. */
async function hydrateProfile(state) {
  state.request?.abort();
  const request = new AbortController(); state.request = request;
  profilePending(state);
  const timer = setTimeout(() => request.abort(new DOMException('Profile session check timed out', 'TimeoutError')), 10000);
  try {
    const auth = await readProfileSession(request.signal);
    if (state.current() && state.request === request) profileReady(state, auth);
  } catch {
    if (state.current() && state.request === request) {
      logCockpitModalError('profile-session-unavailable', new Error('Profile session check failed'));
      state.body.querySelector('#profileStatusText').textContent = 'Could not check sign-in. Please try again.';
      state.body.querySelector('#profileRetryAction').hidden = false;
    }
  } finally {
    clearTimeout(timer);
    if (state.current() && state.request === request) {
      state.body.setAttribute('aria-busy', 'false'); state.body.querySelector('#profileRetryAction').disabled = false;
    }
  }
}

/** @description Clear previously verified identity/actions while a new session check is pending. */
function profilePending(state) {
  state.accountAction = null; state.body.setAttribute('aria-busy', 'true');
  state.body.querySelector('#profileStatusText').textContent = 'Checking sign-in...';
  state.body.querySelector('#profileIdentity').replaceChildren();
  state.body.querySelector('[data-profile-account]')?.remove();
  state.body.querySelector('#profileRetryAction').disabled = true;
}

/** @description Render escaped current-session identity and the corresponding existing account destination. */
function profileReady(state, auth) {
  const { body } = state, retry = body.querySelector('#profileRetryAction');
  if (document.activeElement === retry) body.querySelector('#profileSettingsAction').focus();
  retry.hidden = true;
  body.querySelector('#profileStatusText').textContent = auth.authenticated ? 'Signed in' : 'You are not signed in.';
  if (auth.authenticated) {
    const user = auth.user, who = [user.name, user.email, user.preferred_username].find(value => typeof value === 'string' && value.trim()) || 'You';
    const email = typeof user.email === 'string' && user.email !== who ? `<p>${escapeHtml(user.email)}</p>` : '';
    body.querySelector('#profileIdentity').innerHTML = `<p class="profile-name">${escapeHtml(who)}</p>${email}`;
  }
  state.accountAction = auth.authenticated ? 'logout' : 'login';
  const action = document.createElement('button'); action.type = 'button'; action.className = 'profile-button';
  action.dataset.profileAccount = ''; action.id = auth.authenticated ? 'profileSignOutAction' : 'profileSignInAction';
  action.textContent = auth.authenticated ? 'Sign Out' : 'Sign In'; body.querySelector('.profile-actions').append(action);
}

/**
 * @description Escape text for safe inline modal rendering.
 * @param {string} value - Plain text value.
 * @returns {string} HTML-escaped text.
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ═══ BACKEND HANDLERS ═══

/**
 * @description Handle RAG ingestion file upload from modal.
 * @param {Object} app - CockpitApp instance
 * @returns {Promise<void>}
 */
async function handleRAGUpload(app) {
  const fileInput = document.getElementById('ragFileInput');
  const collection = document.getElementById('ragCollection')?.value || 'default';
  const status = document.getElementById('ragStatus');
  if (!fileInput?.files?.length) {
    if (status) status.textContent = 'Please select at least one file to upload.';
    return;
  }
  const formData = new FormData();
  Array.from(fileInput.files).forEach(file => formData.append('files', file));
  formData.append('collection', collection);
  if (status) status.textContent = 'Uploading...';
  try {
    const response = await fetch(`${window.location.origin}/api/rag/upload`, {
      method: 'POST', body: formData,
      headers: { 'Authorization': `Bearer ${getAuthToken()}` }
    });
    if (!response.ok) throw new Error(`Upload failed: ${response.statusText}`);
    if (status) status.textContent = `✓ Uploaded ${fileInput.files.length} file(s) successfully.`;
    app.showToast('Documents uploaded to RAG', 'success');
    setTimeout(() => app.closeModal(), 2000);
  } catch (error) {
    logCockpitModalError('rag-upload-failed', error, { collection });
    if (status) status.textContent = `✗ Error: ${error.message}`;
    app.showToast('RAG upload failed', 'error');
  }
}

/**
 * @description Redirect to OIDC login endpoint.
 */
function handleOIDCLogin() {
  window.location.href = `${window.location.origin}/api/auth/login`;
}

/**
 * @description Perform mock login for local dev.
 * @param {Object} app - CockpitApp instance
 */
function handleMockLogin(app) {
  setAuthToken(`mock-token-${Date.now()}`, 'dev-user');
  app.showToast('Mock login successful', 'success');
  app.closeModal();
  setTimeout(() => app.openModal('login'), 500);
}

/**
 * @description Handle user logout.
 * @param {Object} app - CockpitApp instance
 */
function handleLogout(app) {
  clearAuth();
  app.showToast('Logged out', 'info');
  app.closeModal();
}

/**
 * @description Load chat history from API and render in history modal.
 * @param {Object} app - CockpitApp instance
 * @returns {Promise<void>}
 */
async function loadChatHistory(app) {
  const container = document.getElementById('historyList');
  if (!container) return;
  try {
    const response = await fetch(`${window.location.origin}/api/tasks`, {
      headers: { 'Authorization': `Bearer ${getAuthToken()}` }
    });
    if (!response.ok) throw new Error(`Failed to load history: ${response.statusText}`);
    const data = await response.json();
    const tasks = data.tasks || data || [];
    if (tasks.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);">No chat history found.</p>';
      return;
    }
    container.innerHTML = tasks.map(task => `
      <div class="history-item" data-task-id="${task.id}" style="padding:12px;border-bottom:1px solid var(--border);cursor:pointer;">
        <div style="font-weight:500;">${task.title || 'Untitled Conversation'}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
          ${new Date(task.created_at || task.createdAt).toLocaleString()}
        </div>
      </div>`).join('');
    container.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', () => {
        app.openHistoryTask(item.dataset.taskId || '');
        app.closeModal();
      });
    });
  } catch (error) {
    logCockpitModalError('chat-history-load-failed', error);
    container.innerHTML = `<p style="color:var(--error);">Error loading history: ${error.message}</p>`;
  }
}

/**
 * @description Emit one structured modal error log entry for fallback cockpit modal flows.
 * @param {string} event - Stable event name.
 * @param {unknown} error - Original thrown value.
 * @param {Record<string, unknown>} [context] - Safe diagnostic context.
 */
function logCockpitModalError(event, error, context = {}) {
  const payload = {
    level: 'error',
    module: 'cockpit-modals',
    event,
    context,
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack || '' : '',
    },
    ts: new Date().toISOString(),
  };
  console.error(JSON.stringify(payload));
}
