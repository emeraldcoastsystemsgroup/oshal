/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added standalone chat knowledge-base popup with drag/drop upload and search, separate from core RAG settings
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added live collection picker/datalist support and all-collections search for the RAG popup
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Unified chat and swarm knowledge workspace UX around one shared modal with swarm-vs-bot targeting and explicit drag/drop upload flow
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Reset knowledge opens to general swarm memory so cockpit header launches always start from the shared-memory default
 */

import { escapeHtml, requestJson, toMessage } from '/chat-assets/chat-workspace-popups-utils.mjs';

const GENERAL_SCOPE = 'swarm';
const AGENT_SCOPE = 'agent';
const GENERAL_COLLECTION = 'swarm-knowledge';
const AGENT_COLLECTION_PREFIX = 'agent-knowledge-';
const DEFAULT_FILE_ACCEPT = '.pdf,.doc,.docx,.txt,.md,.html,.htm';
const RAG_WORKSPACE_MODAL_CSS = `
  .rag-workspace-modal {
    position: fixed;
    inset: 0;
    z-index: 1400;
  }
  .rag-workspace-modal[hidden] {
    display: none;
  }
  .rag-workspace-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(6, 8, 16, 0.72);
    backdrop-filter: blur(12px);
  }
  .rag-workspace-dialog {
    position: relative;
    width: min(920px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    margin: 24px auto;
    overflow: auto;
    border-radius: 24px;
    border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, var(--glass-border, rgba(255,255,255,0.12)));
    background:
      radial-gradient(circle at top left, color-mix(in srgb, var(--accent-primary) 14%, transparent) 0%, transparent 36%),
      linear-gradient(160deg, rgba(18, 20, 34, 0.98), rgba(12, 14, 24, 0.96));
    box-shadow: 0 30px 100px rgba(0, 0, 0, 0.45);
  }
  .rag-workspace-header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 24px 24px 18px;
    border-bottom: 1px solid var(--glass-border, rgba(255,255,255,0.08));
  }
  .rag-workspace-title {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .rag-workspace-title strong {
    color: var(--text-primary);
    font-size: 20px;
    letter-spacing: -0.02em;
  }
  .rag-workspace-title span {
    color: var(--text-dim, var(--text-secondary));
    font-size: 13px;
    line-height: 1.5;
    max-width: 620px;
  }
  .rag-workspace-close {
    align-self: flex-start;
    min-width: 44px;
  }
  .rag-workspace-shell {
    padding: 20px 24px 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .rag-workspace-status {
    min-height: 18px;
    padding: 0 2px;
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
  }
  .rag-workspace-status[data-tone="error"] { color: var(--status-error, #f87171); }
  .rag-workspace-status[data-tone="success"] { color: var(--status-success, #4ade80); }
  .rag-workspace-status[data-tone="info"] { color: var(--accent-primary); }
  .rag-workspace-note {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    border-radius: 16px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: color-mix(in srgb, var(--accent-primary) 8%, var(--glass-bg-heavy, rgba(255,255,255,0.04)));
  }
  .rag-workspace-note strong {
    display: block;
    color: var(--text-primary);
    font-size: 13px;
    margin-bottom: 4px;
  }
  .rag-workspace-note span {
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.45;
  }
  .rag-workspace-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(300px, 1fr);
    gap: 16px;
  }
  .rag-workspace-panel {
    border-radius: 18px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: linear-gradient(145deg, var(--glass-bg-heavy, rgba(255,255,255,0.06)), var(--glass-bg, rgba(255,255,255,0.03)));
    padding: 18px;
    box-shadow: var(--card-shadow, 0 12px 40px rgba(0,0,0,0.2));
  }
  .rag-workspace-panel h4 {
    margin: 0 0 6px;
    color: var(--text-primary);
    font-size: 14px;
  }
  .rag-workspace-panel p {
    margin: 0;
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.5;
  }
  .rag-drop-zone {
    margin-top: 14px;
    border: 1px dashed color-mix(in srgb, var(--accent-primary) 40%, var(--glass-border, rgba(255,255,255,0.08)));
    border-radius: 18px;
    padding: 22px 18px;
    background: color-mix(in srgb, var(--accent-primary) 8%, rgba(10, 14, 24, 0.8));
    text-align: center;
    transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
  }
  .rag-drop-zone.drag-over {
    border-color: color-mix(in srgb, var(--accent-primary) 72%, white);
    background: color-mix(in srgb, var(--accent-primary) 14%, rgba(10, 14, 24, 0.86));
    transform: translateY(-1px);
  }
  .rag-drop-kicker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 42px;
    height: 42px;
    margin-bottom: 12px;
    border-radius: 14px;
    background: color-mix(in srgb, var(--accent-primary) 18%, rgba(255,255,255,0.06));
    color: var(--text-primary);
    font-size: 20px;
  }
  .rag-drop-zone strong {
    display: block;
    margin-bottom: 6px;
    color: var(--text-primary);
    font-size: 15px;
  }
  .rag-drop-zone span {
    display: block;
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.5;
  }
  .rag-workspace-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
  }
  .rag-target-grid {
    display: grid;
    gap: 10px;
    margin-top: 14px;
  }
  .rag-target-card {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 12px;
    align-items: flex-start;
    padding: 14px 14px 12px;
    border-radius: 16px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: rgba(255, 255, 255, 0.02);
    cursor: pointer;
    transition: border-color 140ms ease, background 140ms ease, transform 140ms ease;
  }
  .rag-target-card:hover,
  .rag-target-card:focus-within {
    border-color: color-mix(in srgb, var(--accent-primary) 52%, var(--glass-border, rgba(255,255,255,0.08)));
    background: color-mix(in srgb, var(--accent-primary) 10%, rgba(255,255,255,0.03));
    transform: translateY(-1px);
  }
  .rag-target-card[data-selected="true"] {
    border-color: color-mix(in srgb, var(--accent-primary) 78%, white);
    background: color-mix(in srgb, var(--accent-primary) 14%, rgba(255,255,255,0.04));
  }
  .rag-target-card input {
    margin-top: 2px;
  }
  .rag-target-card strong {
    display: block;
    color: var(--text-primary);
    font-size: 13px;
    margin-bottom: 4px;
  }
  .rag-target-card span {
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.45;
  }
  .rag-form-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 14px;
  }
  .rag-form-field label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim, var(--text-secondary));
  }
  .rag-form-field input,
  .rag-form-field select {
    width: 100%;
    min-height: 42px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-primary);
    font-size: 13px;
  }
  .rag-form-field select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .rag-form-helper {
    color: var(--text-dim, var(--text-secondary));
    font-size: 11px;
    line-height: 1.45;
  }
  .rag-target-preview {
    display: grid;
    gap: 10px;
    margin-top: 14px;
  }
  .rag-target-preview-card {
    padding: 14px;
    border-radius: 16px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: rgba(255, 255, 255, 0.03);
  }
  .rag-target-preview-card strong {
    display: block;
    color: var(--text-primary);
    font-size: 13px;
    margin-bottom: 4px;
  }
  .rag-target-preview-card span {
    display: block;
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.45;
  }
  .rag-collection-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: fit-content;
    padding: 8px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent-primary) 16%, rgba(255,255,255,0.04));
    border: 1px solid color-mix(in srgb, var(--accent-primary) 34%, var(--glass-border, rgba(255,255,255,0.08)));
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 600;
  }
  .rag-pending-list,
  .rag-results-list {
    display: grid;
    gap: 10px;
    margin-top: 14px;
  }
  .rag-pending-item,
  .rag-result-item {
    padding: 12px 14px;
    border-radius: 14px;
    border: 1px solid var(--glass-border, rgba(255,255,255,0.08));
    background: rgba(255, 255, 255, 0.03);
  }
  .rag-pending-item strong,
  .rag-result-item strong {
    display: block;
    color: var(--text-primary);
    font-size: 13px;
    margin-bottom: 4px;
  }
  .rag-pending-item span,
  .rag-result-item span {
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.45;
  }
  .rag-search-actions {
    display: flex;
    gap: 10px;
    margin-top: 14px;
  }
  .rag-search-actions button:disabled,
  .rag-workspace-actions button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .rag-empty-state {
    padding: 14px;
    border-radius: 14px;
    border: 1px dashed var(--glass-border, rgba(255,255,255,0.08));
    color: var(--text-dim, var(--text-secondary));
    font-size: 12px;
    line-height: 1.5;
  }
  @media (max-width: 840px) {
    .rag-workspace-dialog {
      width: min(100vw - 16px, 920px);
      margin: 8px auto;
      max-height: calc(100vh - 16px);
    }
    .rag-workspace-header,
    .rag-workspace-shell {
      padding-left: 16px;
      padding-right: 16px;
    }
    .rag-workspace-note,
    .rag-workspace-header,
    .rag-workspace-actions,
    .rag-search-actions {
      flex-direction: column;
      align-items: stretch;
    }
    .rag-workspace-grid {
      grid-template-columns: 1fr;
    }
  }
`;

/**
 * @description Initialize the shared knowledge workspace popup for core chat.
 * @param {object} options - Chat-specific runtime callbacks and context getters.
 * @param {(modalId: string) => void} options.closeModal - Callback for hiding sibling modals.
 * @param {() => void} options.openCoreBotSettings - Callback that opens core bot settings.
 * @param {() => string} [options.resolveActiveAgentId] - Optional active agent resolver.
 * @param {() => string} [options.resolveActiveTaskId] - Optional active task resolver.
 * @param {() => string} [options.resolveActiveAgentLabel] - Optional active agent label resolver.
 * @param {string} [options.defaultAgentId] - Fallback agent id when resolver is absent.
 * @returns {{open: () => void, close: () => void}} Shared knowledge workspace controller.
 */
export function initializeChatRagWorkspacePopup(options = {}) {
  return initializeSharedRagWorkspacePopup({
    openButtonId: 'openRagModalBtn',
    modalId: 'ragModal',
    defaultAgentId: options.defaultAgentId || '',
    resolveActiveAgentId: options.resolveActiveAgentId,
    resolveActiveTaskId: options.resolveActiveTaskId,
    resolveActiveAgentLabel: options.resolveActiveAgentLabel,
    closePeerModals: () => {
      options.closeModal?.('historyModal');
      options.closeModal?.('redisJobsModal');
    },
    openCoreBotSettings: options.openCoreBotSettings,
    settingsButtonLabel: 'Core Bot Settings',
    workspaceLabel: 'Knowledge Base',
  });
}

/**
 * @description Initialize the shared knowledge workspace popup for any UI surface.
 * @param {object} options - Generic workspace configuration.
 * @param {string} options.openButtonId - DOM id of the button that opens the popup.
 * @param {string} options.modalId - DOM id to assign to the popup root.
 * @param {() => void} [options.closePeerModals] - Optional callback for hiding sibling modals first.
 * @param {() => void} [options.openCoreBotSettings] - Optional callback to open runtime settings.
 * @param {() => string} [options.resolveActiveAgentId] - Optional active agent resolver.
 * @param {() => string} [options.resolveActiveTaskId] - Optional active task resolver.
 * @param {() => string} [options.resolveActiveAgentLabel] - Optional active agent label resolver.
 * @param {string} [options.defaultAgentId] - Optional fallback agent id.
 * @param {string} [options.workspaceLabel] - Optional workspace title.
 * @param {string} [options.settingsButtonLabel] - Optional settings button label.
 * @returns {{open: () => void, close: () => void}} Shared knowledge workspace controller.
 */
export function initializeSharedRagWorkspacePopup(options = {}) {
  injectWorkspaceStyles();
  const controller = createWorkspaceController(options);
  ensureWorkspaceModal(controller);
  bindWorkspaceEvents(controller);
  bindOpenButton(controller);
  bindEscapeKey(controller);
  return {
    open: () => openWorkspace(controller),
    close: () => closeWorkspace(controller),
  };
}

function injectWorkspaceStyles() {
  if (document.getElementById('sharedRagWorkspaceStyle')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'sharedRagWorkspaceStyle';
  style.textContent = RAG_WORKSPACE_MODAL_CSS;
  document.head.appendChild(style);
}

function createWorkspaceController(options) {
  return {
    modalId: options.modalId || 'ragModal',
    openButtonId: options.openButtonId || 'openRagModalBtn',
    workspaceLabel: options.workspaceLabel || 'Knowledge Base',
    settingsButtonLabel: options.settingsButtonLabel || 'Core Bot Settings',
    closePeerModals: typeof options.closePeerModals === 'function' ? options.closePeerModals : () => {},
    openCoreBotSettings: typeof options.openCoreBotSettings === 'function' ? options.openCoreBotSettings : null,
    resolveActiveAgentId: typeof options.resolveActiveAgentId === 'function'
      ? options.resolveActiveAgentId
      : () => options.defaultAgentId || readEmbeddedAgentId(),
    resolveActiveTaskId: typeof options.resolveActiveTaskId === 'function' ? options.resolveActiveTaskId : () => '',
    resolveActiveAgentLabel: typeof options.resolveActiveAgentLabel === 'function'
      ? options.resolveActiveAgentLabel
      : () => '',
    agents: [],
  };
}

function ensureWorkspaceModal(controller) {
  let modal = document.getElementById(controller.modalId);
  if (!(modal instanceof HTMLElement)) {
    modal = document.createElement('div');
    modal.id = controller.modalId;
    document.body.appendChild(modal);
  }

  modal.className = 'rag-workspace-modal';
  modal.hidden = true;
  modal.innerHTML = buildWorkspaceMarkup(controller);
}

function buildWorkspaceMarkup(controller) {
  return [
    '<div class="rag-workspace-backdrop" data-rag-close></div>',
    `<section class="rag-workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="${controller.modalId}Title">`,
    buildWorkspaceHeader(controller),
    '<div class="rag-workspace-shell">',
    '<div class="rag-workspace-status" id="ragStatus"></div>',
    buildWorkspaceNote(controller),
    '<div class="rag-workspace-grid">',
    buildUploadPanel(),
    buildTargetPanel(),
    '</div>',
    buildSearchPanel(),
    '</div>',
    '</section>',
  ].join('');
}

function buildWorkspaceHeader(controller) {
  return `
    <div class="rag-workspace-header">
      <div class="rag-workspace-title">
        <strong id="${controller.modalId}Title">${escapeHtml(controller.workspaceLabel)}</strong>
        <span>Drag and drop documents into shared swarm knowledge or route them into one swarm member's vector memory area. Search works against the currently selected target.</span>
      </div>
      <button class="mini-btn rag-workspace-close" type="button" data-rag-close>Close</button>
    </div>
  `;
}

function buildWorkspaceNote(controller) {
  return `
    <div class="rag-workspace-note">
      <div>
        <strong>Use this window for knowledge operations, not runtime setup</strong>
        <span>Drop files here for general swarm retrieval or choose one bot and load that material into its dedicated knowledge collection.</span>
      </div>
      ${buildSettingsButton(controller)}
    </div>
  `;
}

function buildUploadPanel() {
  return `
    <div class="rag-workspace-panel">
      <h4>Upload Knowledge</h4>
      <p>Add files once, then choose whether that knowledge belongs to the whole swarm or one specific swarm member.</p>
      <div class="rag-drop-zone" id="ragDropZone">
        <div class="rag-drop-kicker">KB</div>
        <strong>Drop files here or browse from disk</strong>
        <span>Supports PDF, DOC, DOCX, TXT, Markdown, and HTML. Files stay queued until you click Upload.</span>
        <input id="ragFileInput" type="file" multiple accept="${DEFAULT_FILE_ACCEPT}" hidden />
      </div>
      <div class="rag-workspace-actions">
        <button class="mini-btn" type="button" id="browseRagFilesBtn">Browse Files</button>
        <button class="mini-btn" type="button" id="clearRagFilesBtn">Clear Queue</button>
        <button class="mini-btn" type="button" id="ragUploadAction" disabled>Upload To Target</button>
      </div>
      <div class="rag-pending-list" id="ragPendingList">
        <div class="rag-empty-state">No files queued yet. Browse or drag documents into the workspace first.</div>
      </div>
    </div>
  `;
}

function buildTargetPanel() {
  return `
    <div class="rag-workspace-panel">
      <h4>Target Knowledge Scope</h4>
      <p>Pick whether these documents should support the whole swarm or only one bot's vector-backed memory area.</p>
      <div class="rag-target-grid">
        <label class="rag-target-card" id="ragScopeSwarmCard" data-selected="true">
          <input id="ragScopeSwarm" type="radio" name="ragScope" value="${GENERAL_SCOPE}" checked />
          <span>
            <strong>General Swarm Knowledge</strong>
            Shared documents for cross-swarm retrieval, onboarding material, reference docs, and reusable playbooks.
          </span>
        </label>
        <label class="rag-target-card" id="ragScopeAgentCard" data-selected="false">
          <input id="ragScopeAgent" type="radio" name="ragScope" value="${AGENT_SCOPE}" />
          <span>
            <strong>Specific Swarm Member</strong>
            Route knowledge into one bot's dedicated vector index and memory collection.
          </span>
        </label>
      </div>
      <div class="rag-form-field">
        <label for="ragAgentSelect">Swarm Member</label>
        <select id="ragAgentSelect" disabled>
          <option value="">Loading swarm members...</option>
        </select>
        <span class="rag-form-helper" id="ragAgentHelper">Choose a specific bot when you want targeted memory instead of shared swarm knowledge.</span>
      </div>
      <div class="rag-target-preview">
        <div class="rag-target-preview-card">
          <strong>Resolved Target</strong>
          <span id="ragTargetSummary">General swarm knowledge will be updated.</span>
        </div>
        <div class="rag-target-preview-card">
          <strong>Resolved Collection</strong>
          <span class="rag-collection-chip" id="ragCollectionPreview">${GENERAL_COLLECTION}</span>
        </div>
      </div>
    </div>
  `;
}

function buildSearchPanel() {
  return `
    <div class="rag-workspace-panel">
      <h4>Search Current Target</h4>
      <p>Search the active knowledge target to verify ingestion or inspect what one bot can retrieve.</p>
      <div class="rag-form-field">
        <label for="ragSearchInput">Search Query</label>
        <input id="ragSearchInput" type="text" placeholder="Search the current knowledge target" />
        <span class="rag-form-helper">Search runs against the currently selected scope and collection preview above.</span>
      </div>
      <div class="rag-search-actions">
        <button class="mini-btn" type="button" id="searchRagBtn">Search Knowledge</button>
      </div>
      <div class="rag-results-list" id="ragResultsList">
        <div class="rag-empty-state">No search results yet. Search after upload to confirm the target contains the right material.</div>
      </div>
    </div>
  `;
}

function buildSettingsButton(controller) {
  if (!controller.openCoreBotSettings) {
    return '';
  }

  return `<button class="mini-btn" type="button" id="openRagSettingsBtn">${escapeHtml(controller.settingsButtonLabel)}</button>`;
}

function bindWorkspaceEvents(controller) {
  bindCloseButtons(controller);
  bindSettingsButton(controller);
  bindBrowseButton();
  bindClearButton();
  bindDropZone();
  bindFileInput();
  bindScopeInputs();
  bindAgentSelect();
  bindUploadButton(controller);
  bindSearchButton(controller);
}

function bindOpenButton(controller) {
  const button = document.getElementById(controller.openButtonId);
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  button.addEventListener('click', () => openWorkspace(controller));
}

function bindEscapeKey(controller) {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeWorkspace(controller);
    }
  });
}

function bindCloseButtons(controller) {
  document.querySelectorAll('[data-rag-close]').forEach((node) => {
    node.addEventListener('click', () => closeWorkspace(controller));
  });
}

function bindSettingsButton(controller) {
  const button = document.getElementById('openRagSettingsBtn');
  if (!(button instanceof HTMLButtonElement) || !controller.openCoreBotSettings) {
    return;
  }

  button.addEventListener('click', () => controller.openCoreBotSettings());
}

function bindBrowseButton() {
  const browseButton = document.getElementById('browseRagFilesBtn');
  const input = document.getElementById('ragFileInput');
  if (!(browseButton instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)) {
    return;
  }

  browseButton.addEventListener('click', () => input.click());
}

function bindClearButton() {
  const clearButton = document.getElementById('clearRagFilesBtn');
  if (!(clearButton instanceof HTMLButtonElement)) {
    return;
  }

  clearButton.addEventListener('click', () => {
    setQueuedFiles([]);
    renderPendingFiles([]);
    updateUploadButtonState();
    setStatus('Knowledge file queue cleared.', 'info');
  });
}

function bindDropZone() {
  const dropZone = document.getElementById('ragDropZone');
  if (!(dropZone instanceof HTMLElement)) {
    return;
  }

  dropZone.addEventListener('click', () => document.getElementById('ragFileInput')?.click());
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = Array.from(event.dataTransfer?.files || []);
    queueFiles(files);
  });
}

function bindFileInput() {
  const input = document.getElementById('ragFileInput');
  if (!(input instanceof HTMLInputElement)) {
    return;
  }

  input.addEventListener('change', () => {
    queueFiles(Array.from(input.files || []));
  });
}

function bindScopeInputs() {
  document.querySelectorAll('input[name="ragScope"]').forEach((node) => {
    node.addEventListener('change', () => {
      syncScopeCards();
      syncTargetPreview();
      updateUploadButtonState();
      clearResults();
    });
  });
}

function bindAgentSelect() {
  const select = document.getElementById('ragAgentSelect');
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }

  select.addEventListener('change', () => {
    syncTargetPreview();
    updateUploadButtonState();
    clearResults();
  });
}

function bindUploadButton(controller) {
  const button = document.getElementById('ragUploadAction');
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  button.addEventListener('click', () => {
    void uploadQueuedFiles(controller);
  });
}

function bindSearchButton(controller) {
  const button = document.getElementById('searchRagBtn');
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  button.addEventListener('click', () => {
    void searchKnowledgeBase(controller);
  });
}

function openWorkspace(controller) {
  controller.closePeerModals();
  const modal = document.getElementById(controller.modalId);
  if (modal instanceof HTMLElement) {
    modal.hidden = false;
  }
  resetWorkspaceTarget();
  setStatus('Knowledge workspace ready. Choose a target, queue files, or search current knowledge.', 'success');
  syncScopeCards();
  void hydrateWorkspace(controller);
}

function closeWorkspace(controller) {
  const modal = document.getElementById(controller.modalId);
  if (modal instanceof HTMLElement) {
    modal.hidden = true;
  }
}

async function hydrateWorkspace(controller) {
  await loadAgents(controller);
  syncTargetPreview();
  updateUploadButtonState();
}

function resetWorkspaceTarget() {
  const swarmInput = document.getElementById('ragScopeSwarm');
  const agentInput = document.getElementById('ragScopeAgent');
  const agentSelect = document.getElementById('ragAgentSelect');

  if (swarmInput instanceof HTMLInputElement) {
    swarmInput.checked = true;
  }
  if (agentInput instanceof HTMLInputElement) {
    agentInput.checked = false;
  }
  if (agentSelect instanceof HTMLSelectElement) {
    agentSelect.value = '';
    agentSelect.disabled = true;
  }

  clearResults();
}

async function loadAgents(controller) {
  setAgentLoadingState();
  try {
    const payload = await requestJson('/api/agents');
    controller.agents = normalizeAgents(payload?.agents);
    renderAgentOptions(controller.agents, controller.resolveActiveAgentId(), controller.resolveActiveAgentLabel());
    syncTargetPreview();
  } catch (error) {
    logWorkspaceError('rag-agents-load-failed', error);
    renderAgentOptions([], controller.resolveActiveAgentId(), controller.resolveActiveAgentLabel());
    setStatus(`Failed to load swarm members: ${toMessage(error)}`, 'error');
  }
}

function normalizeAgents(agents) {
  if (!Array.isArray(agents)) {
    return [];
  }

  return agents
    .map((agent) => normalizeAgent(agent))
    .filter((agent) => agent !== null);
}

function normalizeAgent(agent) {
  if (!agent || typeof agent !== 'object') {
    return null;
  }

  const agentId = readString(agent.agentId || agent.agent_id || agent.id || agent.slug || agent.name);
  if (!agentId) {
    return null;
  }

  const label = readString(agent.name || agent.displayName || agent.agentName || agentId);
  return { agentId, label };
}

function renderAgentOptions(agents, preferredAgentId, preferredAgentLabel) {
  const select = document.getElementById('ragAgentSelect');
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }

  const resolvedPreferred = preferredAgentId || '';
  const currentValue = select.value;
  const chosenValue = resolvePreferredAgentValue(agents, currentValue, resolvedPreferred);
  const optionsMarkup = buildAgentOptionMarkup(agents, preferredAgentLabel);

  select.innerHTML = optionsMarkup;
  if (chosenValue) {
    select.value = chosenValue;
  }

  const hasAgents = agents.length > 0;
  select.disabled = !isAgentScopeSelected() || !hasAgents;
  setAgentHelperText(hasAgents);
}

function resolvePreferredAgentValue(agents, currentValue, preferredAgentId) {
  const knownIds = new Set(agents.map((agent) => agent.agentId));
  if (knownIds.has(currentValue)) {
    return currentValue;
  }
  if (knownIds.has(preferredAgentId)) {
    return preferredAgentId;
  }
  return agents[0]?.agentId || '';
}

function buildAgentOptionMarkup(agents, preferredAgentLabel) {
  if (agents.length === 0) {
    return '<option value="">No swarm members available</option>';
  }

  const preferredText = preferredAgentLabel ? `Current context: ${preferredAgentLabel}` : 'Select a swarm member';
  const options = agents
    .map((agent) => `<option value="${escapeHtml(agent.agentId)}">${escapeHtml(agent.label)}</option>`)
    .join('');

  return `<option value="">${escapeHtml(preferredText)}</option>${options}`;
}

function setAgentLoadingState() {
  const select = document.getElementById('ragAgentSelect');
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }

  select.innerHTML = '<option value="">Loading swarm members...</option>';
  select.disabled = true;
}

function setAgentHelperText(hasAgents) {
  const helper = document.getElementById('ragAgentHelper');
  if (!(helper instanceof HTMLElement)) {
    return;
  }

  helper.textContent = hasAgents
    ? 'Choose a specific bot when you want targeted memory instead of shared swarm knowledge.'
    : 'No swarm members are currently available. General swarm knowledge is still available.';
}

function syncScopeCards() {
  const swarmCard = document.getElementById('ragScopeSwarmCard');
  const agentCard = document.getElementById('ragScopeAgentCard');
  const agentSelect = document.getElementById('ragAgentSelect');
  const hasAgentOptions = agentSelect instanceof HTMLSelectElement && agentSelect.options.length > 0 && agentSelect.value !== 'loading';

  if (swarmCard instanceof HTMLElement) {
    swarmCard.dataset.selected = String(!isAgentScopeSelected());
  }
  if (agentCard instanceof HTMLElement) {
    agentCard.dataset.selected = String(isAgentScopeSelected());
  }
  if (agentSelect instanceof HTMLSelectElement) {
    agentSelect.disabled = !isAgentScopeSelected() || !hasAgentOptions;
  }
}

function syncTargetPreview() {
  const context = resolveKnowledgeTarget();
  const summary = document.getElementById('ragTargetSummary');
  const preview = document.getElementById('ragCollectionPreview');
  if (summary instanceof HTMLElement) {
    summary.textContent = context.targetSummary;
  }
  if (preview instanceof HTMLElement) {
    preview.textContent = context.collection;
  }
}

function resolveKnowledgeTarget() {
  if (!isAgentScopeSelected()) {
    return {
      collection: GENERAL_COLLECTION,
      agentId: '',
      agentLabel: '',
      targetSummary: 'General swarm knowledge will be updated and searched.',
    };
  }

  const select = document.getElementById('ragAgentSelect');
  const selectedOption = select instanceof HTMLSelectElement
    ? select.options[select.selectedIndex]
    : null;
  const agentId = select instanceof HTMLSelectElement ? readString(select.value) : '';
  const agentLabel = selectedOption ? readString(selectedOption.textContent) : '';
  const label = agentLabel || 'selected swarm member';

  return {
    collection: buildAgentCollection(agentId),
    agentId,
    agentLabel: label,
    targetSummary: agentId
      ? `${label} will receive targeted knowledge in its dedicated vector memory area.`
      : 'Choose a swarm member to target one bot-specific knowledge collection.',
  };
}

function buildAgentCollection(agentId) {
  return agentId ? `${AGENT_COLLECTION_PREFIX}${agentId}` : `${AGENT_COLLECTION_PREFIX}<choose-agent>`;
}

function isAgentScopeSelected() {
  const input = document.getElementById('ragScopeAgent');
  return input instanceof HTMLInputElement ? input.checked : false;
}

function queueFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return;
  }

  setQueuedFiles(files);
  renderPendingFiles(files);
  updateUploadButtonState();
  setStatus(`Queued ${files.length} knowledge document(s).`, 'info');
}

function setQueuedFiles(files) {
  const input = document.getElementById('ragFileInput');
  if (!(input instanceof HTMLInputElement)) {
    return;
  }

  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
}

function renderPendingFiles(files) {
  const list = document.getElementById('ragPendingList');
  if (!(list instanceof HTMLElement)) {
    return;
  }

  if (!Array.isArray(files) || files.length === 0) {
    list.innerHTML = '<div class="rag-empty-state">No files queued yet. Browse or drag documents into the workspace first.</div>';
    return;
  }

  list.innerHTML = files.map((file) => buildPendingItemMarkup(file)).join('');
}

function buildPendingItemMarkup(file) {
  const sizeKb = Math.max(1, Math.round((file.size || 0) / 1024));
  return `
    <div class="rag-pending-item">
      <strong>${escapeHtml(file.name)}</strong>
      <span>${escapeHtml(String(sizeKb))} KB queued for ${escapeHtml(resolveKnowledgeTarget().collection)}</span>
    </div>
  `;
}

function updateUploadButtonState() {
  const button = document.getElementById('ragUploadAction');
  const input = document.getElementById('ragFileInput');
  if (!(button instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)) {
    return;
  }

  const hasFiles = input.files instanceof FileList && input.files.length > 0;
  const target = resolveKnowledgeTarget();
  const hasTarget = !isAgentScopeSelected() || Boolean(target.agentId);
  button.disabled = !hasFiles || !hasTarget;
}

async function uploadQueuedFiles(controller) {
  const input = document.getElementById('ragFileInput');
  if (!(input instanceof HTMLInputElement) || !input.files || input.files.length === 0) {
    setStatus('Queue at least one file before uploading.', 'error');
    return;
  }

  const target = resolveKnowledgeTarget();
  if (isAgentScopeSelected() && !target.agentId) {
    setStatus('Choose a swarm member before uploading targeted knowledge.', 'error');
    return;
  }

  const formData = buildUploadPayload(input.files, target, controller.resolveActiveTaskId());
  const documentCount = input.files.length;
  setStatus(`Uploading ${documentCount} document(s) into ${target.collection}...`, 'info');

  try {
    const response = await fetch('/api/rag/upload', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(readString(payload?.error) || 'RAG upload failed');
    }
    renderUploadResults(Array.from(input.files), payload, target);
    setQueuedFiles([]);
    renderPendingFiles([]);
    updateUploadButtonState();
    setStatus(`Uploaded ${payload.count || documentCount} document(s) into ${payload.collection || target.collection}.`, 'success');
  } catch (error) {
    logWorkspaceError('rag-upload-failed', error, { collection: target.collection, agentId: target.agentId });
    setStatus(`Upload failed: ${toMessage(error)}`, 'error');
  }
}

function buildUploadPayload(files, target, taskId) {
  const formData = new FormData();
  Array.from(files).forEach((file) => formData.append('files', file));
  formData.append('collection', target.collection);
  if (target.agentId) {
    formData.append('agentId', target.agentId);
  }
  if (taskId) {
    formData.append('taskId', taskId);
  }
  return formData;
}

function renderUploadResults(files, payload, target) {
  const list = document.getElementById('ragResultsList');
  if (!(list instanceof HTMLElement)) {
    return;
  }

  list.innerHTML = files.map((file) => {
    return `
      <div class="rag-result-item">
        <strong>${escapeHtml(file.name)}</strong>
        <span>Uploaded to ${escapeHtml(payload.collection || target.collection)}${target.agentLabel ? ` for ${escapeHtml(target.agentLabel)}` : ''}.</span>
      </div>
    `;
  }).join('');
}

async function searchKnowledgeBase(controller) {
  const query = readInputValue('ragSearchInput');
  if (!query) {
    setStatus('Enter a search query first.', 'error');
    return;
  }

  const target = resolveKnowledgeTarget();
  if (isAgentScopeSelected() && !target.agentId) {
    setStatus('Choose a swarm member before running a targeted search.', 'error');
    return;
  }

  setStatus(`Searching ${target.collection}...`, 'info');
  try {
    const payload = await requestJson(buildSearchUrl(query, target.collection));
    const results = Array.isArray(payload?.results) ? payload.results : [];
    renderSearchResults(results);
    setStatus(`Found ${results.length} result(s) in ${target.collection}.`, 'success');
  } catch (error) {
    logWorkspaceError('rag-search-failed', error, { collection: target.collection, query });
    setStatus(`Search failed: ${toMessage(error)}`, 'error');
  }
}

function buildSearchUrl(query, collection) {
  return `/api/rag/search?q=${encodeURIComponent(query)}&collection=${encodeURIComponent(collection)}&topK=5`;
}

function renderSearchResults(results) {
  const list = document.getElementById('ragResultsList');
  if (!(list instanceof HTMLElement)) {
    return;
  }

  if (!Array.isArray(results) || results.length === 0) {
    list.innerHTML = '<div class="rag-empty-state">No results found for this target. Try a broader search or a different knowledge scope.</div>';
    return;
  }

  list.innerHTML = results.map((result) => buildResultItemMarkup(result)).join('');
}

function buildResultItemMarkup(result) {
  const score = typeof result?.score === 'number' ? result.score.toFixed(4) : 'n/a';
  const preview = readString(result?.text).slice(0, 260) || 'No preview returned.';
  const collection = readString(result?.collection);
  const prefix = collection ? `Score ${score} in ${collection}` : `Score ${score}`;
  return `
    <div class="rag-result-item">
      <strong>${escapeHtml(prefix)}</strong>
      <span>${escapeHtml(preview)}</span>
    </div>
  `;
}

function clearResults() {
  const list = document.getElementById('ragResultsList');
  if (!(list instanceof HTMLElement)) {
    return;
  }

  list.innerHTML = '<div class="rag-empty-state">No search results yet. Search after upload to confirm the target contains the right material.</div>';
}

function readInputValue(id) {
  const node = document.getElementById(id);
  return node instanceof HTMLInputElement ? node.value.trim() : '';
}

function setStatus(message, tone) {
  const node = document.getElementById('ragStatus');
  if (!(node instanceof HTMLElement)) {
    return;
  }

  node.textContent = message || '';
  if (tone) {
    node.dataset.tone = tone;
    return;
  }
  delete node.dataset.tone;
}

function logWorkspaceError(eventName, error, context = {}) {
  const payload = {
    level: 'error',
    module: 'shared-rag-workspace-popup',
    event: eventName,
    context,
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack || '' : '',
    },
    ts: new Date().toISOString(),
  };
  console.error(JSON.stringify(payload));
}

function readEmbeddedAgentId() {
  return readString(document.documentElement.dataset.cockpitAgentId || '');
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
