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
  // Render a placeholder, then hydrate from the REAL OIDC session (/api/auth/user).
  // The old localStorage-token check was disconnected from the actual login, which
  // is why a signed-in user still saw "not signed in".
  return {
    title: 'Profile & Access',
    html: `<div class="modal-content" id="profileModalBody">
      <p id="profileStatusText" style="margin-bottom:12px;color:var(--text-muted);">Checking sign-in…</p>
    </div>`,
    onRender: (app) => { hydrateProfileModal(app); },
  };
}

/**
 * @description Fill the profile modal from the live auth state.
 * @param {Object} app - CockpitApp instance
 * @returns {Promise<void>}
 */
async function hydrateProfileModal(app) {
  const body = document.getElementById('profileModalBody');
  if (!body) return;
  let auth = { authenticated: false, user: null };
  try {
    const r = await fetch(`${window.location.origin}/api/auth/user`, { credentials: 'include' });
    if (r.ok) auth = await r.json();
  } catch (e) { /* treat as signed out */ }

  if (auth && auth.authenticated && auth.user) {
    const u = auth.user;
    const who = u.name || u.email || u.preferred_username || 'You';
    const sub = u.email && u.email !== who ? ` <span style="color:var(--text-muted)">(${escapeHtml(u.email)})</span>` : '';
    body.innerHTML = `<div class="login-status logged-in">
      <p>Signed in as <strong>${escapeHtml(who)}</strong>${sub}.</p>
      <p style="margin-top:12px;color:var(--text-muted);">Global account access lives here. Cockpit settings and chat history stay on the ribbon.</p>
      <div class="modal-actions">
        <button class="btn-secondary" id="profileSettingsAction">Open Settings Page</button>
        <button class="btn-primary" id="profileSignOutAction">Sign Out</button>
      </div></div>`;
    document.getElementById('profileSettingsAction')?.addEventListener('click', () => { app.openCockpitSettingsPage(); app.closeModal(); });
    document.getElementById('profileSignOutAction')?.addEventListener('click', () => { window.location.href = `${window.location.origin}/logout`; });
  } else {
    body.innerHTML = `<div class="login-status logged-out">
      <p style="margin-bottom:12px;">You are not signed in.</p>
      <p style="margin-bottom:16px;color:var(--text-muted);">Sign in with your account to access your classes and data.</p>
      <div class="modal-actions" style="display:flex;flex-direction:column;gap:12px;">
        <button class="btn-secondary" id="profileSettingsAction">Open Settings Page</button>
        <button class="btn-primary" id="profileSignInAction">Sign In</button>
      </div></div>`;
    document.getElementById('profileSettingsAction')?.addEventListener('click', () => { app.openCockpitSettingsPage(); app.closeModal(); });
    document.getElementById('profileSignInAction')?.addEventListener('click', () => { window.location.href = `${window.location.origin}/login`; });
  }
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
