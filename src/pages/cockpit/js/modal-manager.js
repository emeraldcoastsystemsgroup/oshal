/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of ModalManager with backend API integration for RAG, Presentron, Login, History, Settings modals
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed the dead Presentron modal methods (openPresentron/_bindPresentron/_loadPresentations — no callers, hit retired /api/presentations endpoints)
 */

import { createUiLogger, serializeUiError } from '../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-modal-manager');

/**
 * @description Manages the shared modal overlay for cockpit UI popups.
 * Provides openModal/closeModal utility and content builders for each modal type.
 */
export class ModalManager {
  /**
   * @description Construct the ModalManager and bind close events.
   */
  constructor() {
    this.overlay = document.getElementById('modalOverlay');
    this.container = document.getElementById('modalContainer');
    this.titleEl = document.getElementById('modalTitle');
    this.bodyEl = document.getElementById('modalBody');
    this.closeBtn = document.getElementById('modalCloseBtn');
    logger.info('Created cockpit modal manager', {
      hasOverlay: Boolean(this.overlay),
      hasContainer: Boolean(this.container),
    });
    this._bindClose();
  }

  /**
   * @description Bind close button and overlay click to dismiss modal.
   */
  _bindClose() {
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.close());
    }
    if (this.overlay) {
      this.overlay.addEventListener('click', (e) => {
        if (e.target === this.overlay) this.close();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  /**
   * @description Open the modal with a title and HTML content.
   * @param {string} title - Modal title text
   * @param {string} html - HTML content for the modal body
   */
  open(title, html) {
    if (!this.overlay || !this.titleEl || !this.bodyEl) return;
    logger.info('Opening cockpit modal', {
      title,
    });
    this.titleEl.textContent = title;
    this.bodyEl.innerHTML = html;
    this.overlay.classList.remove('hidden');
  }

  /**
   * @description Close the modal and clear content.
   */
  close() {
    logger.debug('Closing cockpit modal');
    if (this.overlay) this.overlay.classList.add('hidden');
    if (this.bodyEl) this.bodyEl.innerHTML = '';
  }

  /**
   * @description Build and show the RAG Ingestion modal with file upload.
   * @param {string} apiBase - Base URL for API calls
   */
  openRAG(apiBase) {
    logger.info('Opening cockpit RAG modal', {
      apiBase,
    });
    const html = `
      <div class="form-group">
        <label>Upload documents for RAG ingestion</label>
        <input type="file" id="ragFileInput" multiple accept=".pdf,.txt,.md,.docx,.csv,.json" />
      </div>
      <div class="form-group">
        <label>Collection Name</label>
        <input type="text" id="ragCollection" placeholder="default" value="default" />
      </div>
      <button class="btn-action" id="ragUploadAction">Upload &amp; Ingest</button>
      <div id="ragStatus"></div>
    `;
    this.open('RAG Ingestion', html);
    this._bindRAGUpload(apiBase);
  }

  /**
   * @description Bind RAG upload button to backend API.
   * @param {string} apiBase - Base URL for API calls
   */
  _bindRAGUpload(apiBase) {
    const btn = document.getElementById('ragUploadAction');
    const statusEl = document.getElementById('ragStatus');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const fileInput = document.getElementById('ragFileInput');
      const collection = document.getElementById('ragCollection')?.value || 'default';
      const files = fileInput?.files;
      if (!files || files.length === 0) {
        this._showStatus(statusEl, 'Please select at least one file.', 'error');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Uploading...';
      try {
        const formData = new FormData();
        for (const file of files) formData.append('files', file);
        formData.append('collection', collection);
        const resp = await fetch(`${apiBase}/api/rag/upload`, {
          method: 'POST',
          body: formData,
          headers: this._authHeaders()
        });
        if (!resp.ok) throw new Error(`Upload failed: ${resp.statusText}`);
        const data = await resp.json();
        const count = data.processed || files.length;
        this._showStatus(statusEl, `✅ ${count} file(s) ingested into "${collection}"`, 'success');
        logger.info('Completed cockpit RAG upload', {
          collection,
          processedCount: count,
        });
      } catch (err) {
        logger.error('Cockpit RAG upload failed', {
          error: serializeUiError(err),
          collection,
        });
        this._showStatus(statusEl, `❌ ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Upload & Ingest';
      }
    });
  }

  /**
   * @description Build and show the Login modal with OIDC/mock support.
   * @param {string} apiBase - Base URL for API calls
   */
  openLogin(apiBase) {
    const token = localStorage.getItem('oshal_access_token');
    const user = localStorage.getItem('oshal_user') || 'Unknown';
    const mockOidc = this._isMockOidc();
    const loggedIn = !!token;
    logger.info('Opening cockpit login modal', {
      apiBase,
      loggedIn,
      mockOidc,
    });

    let html = '';
    if (loggedIn) {
      html = this._buildLoggedInView(user, mockOidc);
    } else {
      html = this._buildLoginForm(mockOidc, apiBase);
    }
    this.open('Login', html);
    this._bindLoginActions(apiBase);
  }

  /**
   * @description Build HTML for logged-in state.
   * @param {string} user - Current user display name
   * @param {boolean} mockOidc - Whether mock OIDC is enabled
   * @returns {string} HTML string
   */
  _buildLoggedInView(user, mockOidc) {
    return `
      <div class="login-status logged-in">
        <i class="ph ph-check-circle"></i>
        Logged in as <strong>${user}</strong>
        ${mockOidc ? '<span style="opacity:0.6">(Mock Mode)</span>' : ''}
      </div>
      <button class="btn-action" id="logoutAction" style="background:#ef4444;">Logout</button>
    `;
  }

  /**
   * @description Build HTML for login form.
   * @param {boolean} mockOidc - Whether mock OIDC is enabled
   * @param {string} apiBase - Base URL for API calls
   * @returns {string} HTML string
   */
  _buildLoginForm(mockOidc, apiBase) {
    if (mockOidc) {
      return `
        <div class="status-message info">
          <i class="ph ph-info"></i> Mock OIDC mode is enabled for local development.
        </div>
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="mockUsername" value="dev-admin" />
        </div>
        <button class="btn-action" id="mockLoginAction">Login (Mock)</button>
        <div id="loginStatus"></div>
      `;
    }
    return `
      <div class="status-message info">
        <i class="ph ph-info"></i> Login via Keycloak OIDC
      </div>
      <button class="btn-action" id="oidcLoginAction">Login with Keycloak</button>
      <div id="loginStatus"></div>
    `;
  }

  /**
   * @description Bind login/logout button actions.
   * @param {string} apiBase - Base URL for API calls
   */
  _bindLoginActions(apiBase) {
    const logoutBtn = document.getElementById('logoutAction');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        logger.info('Signing out cockpit modal session');
        localStorage.removeItem('oshal_access_token');
        localStorage.removeItem('oshal_refresh_token');
        localStorage.removeItem('oshal_user');
        this.close();
        window.dispatchEvent(new CustomEvent('auth-changed', { detail: { loggedIn: false } }));
      });
    }
    const mockLoginBtn = document.getElementById('mockLoginAction');
    if (mockLoginBtn) {
      mockLoginBtn.addEventListener('click', () => {
        const username = document.getElementById('mockUsername')?.value || 'dev-admin';
        logger.info('Starting cockpit mock login', {
          username,
        });
        localStorage.setItem('oshal_access_token', 'mock-token-' + Date.now());
        localStorage.setItem('oshal_user', username);
        this.close();
        window.dispatchEvent(new CustomEvent('auth-changed', { detail: { loggedIn: true, user: username } }));
      });
    }
    const oidcBtn = document.getElementById('oidcLoginAction');
    if (oidcBtn) {
      oidcBtn.addEventListener('click', () => {
        const kcBase = window.KEYCLOAK_URL || `${window.location.protocol}//${window.location.hostname}:8080`;
        const realm = 'oshal';
        const clientId = 'oshal-ui';
        const redirectUri = encodeURIComponent(window.location.origin + '/auth/callback');
        const authUrl = `${kcBase}/realms/${realm}/protocol/openid-connect/auth?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=openid`;
        logger.info('Redirecting cockpit login to OIDC provider', {
          kcBase,
          realm,
          clientId,
        });
        window.location.href = authUrl;
      });
    }
  }

  /**
   * @description Build and show the History modal with task list.
   * @param {string} apiBase - Base URL for API calls
   * @param {Function} onSelectTask - Callback when a task is selected
   */
  openHistory(apiBase, onSelectTask) {
    logger.info('Opening cockpit history modal', {
      apiBase,
      hasOnSelectTask: typeof onSelectTask === 'function',
    });
    const html = `
      <div id="historyLoading" class="status-message info">Loading history...</div>
      <div class="history-list" id="historyList"></div>
    `;
    this.open('Chat History', html);
    this._loadHistory(apiBase, onSelectTask);
  }

  /**
   * @description Load task history from API.
   * @param {string} apiBase - Base URL for API calls
   * @param {Function} onSelectTask - Callback when a task is selected
   */
  async _loadHistory(apiBase, onSelectTask) {
    const listEl = document.getElementById('historyList');
    const loadingEl = document.getElementById('historyLoading');
    if (!listEl) return;
    logger.debug('Loading cockpit history', {
      apiBase,
    });
    try {
      const resp = await fetch(`${apiBase}/api/tasks`, {
        headers: this._authHeaders()
      });
      if (!resp.ok) throw new Error(`Failed to load: ${resp.statusText}`);
      const data = await resp.json();
      const tasks = data.tasks || data || [];
      logger.debug('Loaded cockpit history', {
        taskCount: tasks.length,
      });
      if (loadingEl) loadingEl.style.display = 'none';
      if (tasks.length === 0) {
        listEl.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">No chat history.</p>';
        return;
      }
      listEl.innerHTML = tasks.slice(0, 50).map(t => `
        <div class="history-item" data-task-id="${t.id || ''}">
          <div class="history-item-title">${this._truncate(t.text || t.name || 'Untitled', 60)}</div>
          <div class="history-item-meta">${t.status || 'unknown'} · ${this._timeAgo(t.createdAt || t.ts)}</div>
        </div>
      `).join('');
      listEl.querySelectorAll('.history-item').forEach(item => {
        item.addEventListener('click', () => {
          const taskId = item.dataset.taskId;
          if (taskId && onSelectTask) {
            logger.info('Selected cockpit history task', {
              taskId,
            });
            onSelectTask(taskId);
            this.close();
          }
        });
      });
    } catch (err) {
      logger.error('Failed to load cockpit history', {
        error: serializeUiError(err),
      });
      if (loadingEl) loadingEl.style.display = 'none';
      listEl.innerHTML = `<p style="color:#ef4444;font-size:12px;">❌ ${err.message}</p>`;
    }
  }

  /**
   * @description Build and show the Settings modal.
   * @param {Object} settings - Current settings object
   * @param {Function} onSave - Callback when settings are saved
   */
  openSettings(settings, onSave) {
    logger.info('Opening cockpit settings modal');
    const html = `
      <div class="setting-toggles">
        <label class="toggle-row">
          <input type="checkbox" id="settAutoApprove" ${settings.autoApprove ? 'checked' : ''} />
          <span>Auto-approve tool use</span>
        </label>
      </div>
      <button class="btn-action" id="settSaveAction">Save Settings</button>
    `;
    this.open('Settings', html);
    const saveBtn = document.getElementById('settSaveAction');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const autoApprove = document.getElementById('settAutoApprove')?.checked || false;
        logger.info('Saving cockpit modal settings', {
          autoApprove,
        });
        if (onSave) onSave({ autoApprove });
        this.close();
      });
    }
  }

  /**
   * @description Check if mock OIDC mode is enabled.
   * @returns {boolean} True if MOCK_OIDC is enabled
   */
  _isMockOidc() {
    return window.MOCK_OIDC === true || window.MOCK_OIDC === 'true' || localStorage.getItem('MOCK_OIDC') === 'true';
  }

  /**
   * @description Get authorization headers if a token exists.
   * @returns {Object} Headers object with Authorization if available
   */
  _authHeaders() {
    const token = localStorage.getItem('oshal_access_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  /**
   * @description Show a status message in an element.
   * @param {HTMLElement|null} el - Target element
   * @param {string} msg - Message text
   * @param {string} type - Message type (success, error, info)
   */
  _showStatus(el, msg, type) {
    if (!el) return;
    el.innerHTML = `<div class="status-message ${type}">${msg}</div>`;
  }

  /**
   * @description Truncate text to a max length.
   * @param {string} text - Text to truncate
   * @param {number} max - Max length
   * @returns {string} Truncated text
   */
  _truncate(text, max) {
    if (!text) return '';
    return text.length > max ? text.substring(0, max) + '…' : text;
  }

  /**
   * @description Format a timestamp as relative time ago.
   * @param {string|number} ts - Timestamp
   * @returns {string} Relative time string
   */
  _timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }
}
