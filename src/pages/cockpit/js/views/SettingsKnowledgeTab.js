/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New cockpit Settings "Knowledge (RAG)" tab: a first-class ingestion tool (files or pasted text → general swarm / specific bot / private-to-me) plus permission-aware visibility (operator sees all; a user sees shared swarm + per-bot + their own private) and a retrieval test. Replaces the flaky embedded-chat RAG popup path.
 */

import { createUiLogger, serializeUiError } from '../../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-settings-knowledge-tab');

const SWARM_COLLECTION = 'swarm-knowledge';
const PRIVATE_COLLECTION = 'my-knowledge';
const AGENT_COLLECTION_PREFIX = 'agent-knowledge-';
const FILE_ACCEPT = '.pdf,.doc,.docx,.txt,.md,.html,.htm,.json,.csv';

/**
 * @description Controller that renders and binds the cockpit Settings Knowledge (RAG) tab: the
 * shared ingestion tool and the permission-aware knowledge visibility surface (general swarm,
 * per-bot, and private-to-user scopes).
 */
export class SettingsKnowledgeTab {
  /**
   * @description Create a knowledge-tab controller bound to one SettingsView instance and body element.
   *
   * @param {object} view - Parent settings view that owns shared state (agents, api, toasts).
   * @param {HTMLElement} body - Settings body element where the knowledge tab should render.
   * @returns {void}
   */
  constructor(view, body) {
    this.view = view;
    this.body = body;
    this.knowledge = { documents: [], isOperator: false };
    logger.info('Created cockpit settings knowledge tab', { hasBody: Boolean(this.body) });
  }

  /**
   * @description Render the knowledge tab, attach handlers, and load the visibility surface.
   *
   * @returns {void}
   */
  render() {
    logger.info('Rendering cockpit settings knowledge tab');
    this.body.innerHTML = this.buildMarkup();
    this.bindEvents();
    this.syncScope();
    void this.loadKnowledge();
  }

  // Build the full markup for the knowledge tab from smaller section renderers.
  buildMarkup() {
    return [this.renderIntroSection(), this.renderIngestSection(), this.renderVisibilitySection()].join('');
  }

  // Render the short intro that frames the tab as the RAG knowledge home.
  renderIntroSection() {
    return `
      <div class="setting-section">
        <div class="setting-section-title"><i class="ph ph-books"></i> Knowledge (RAG)</div>
        <div class="setting-section-desc">Add documents to the swarm's vector knowledge and see exactly what the swarm and each bot can retrieve. General swarm knowledge is shared with every bot; bot-specific knowledge stays in one member's collection; private knowledge is scoped to you.</div>
        <div id="knowledgeStatus" class="field-hint" style="min-height:16px;margin-top:6px;"></div>
      </div>`;
  }

  // Render the ingestion tool: file/text input, target scope, and actions.
  renderIngestSection() {
    return `
      <div class="setting-section">
        <div class="setting-section-title">Add Knowledge</div>
        <div class="setting-section-desc">Upload files or paste text, choose who it belongs to, then ingest. No tool toggles required.</div>

        <div class="setting-field">
          <label>Target scope</label>
          <div style="display:grid;gap:8px;margin-top:4px;">
            ${this.renderScopeOption('swarm', 'General swarm knowledge', 'Shared reference material every bot can retrieve.', true)}
            ${this.renderScopeOption('agent', 'Specific bot', "Routes into one bot's dedicated knowledge collection.", false)}
            ${this.renderScopeOption('private', 'Private to me', 'Only you (and operators) can retrieve this material.', false)}
          </div>
        </div>

        <div class="setting-field" id="knowledgeAgentField" style="display:none;">
          <label>Swarm member</label>
          <select id="knowledgeAgentSelect">${this.renderAgentOptions()}</select>
          <span class="field-hint">The document lands in <code id="knowledgeCollectionPreview">${SWARM_COLLECTION}</code>.</span>
        </div>
        <div class="setting-field" id="knowledgeCollectionHintField">
          <span class="field-hint">Target collection: <code id="knowledgeCollectionPreviewTop">${SWARM_COLLECTION}</code></span>
        </div>

        <div class="setting-field">
          <label>Files</label>
          <input type="file" id="knowledgeFileInput" multiple accept="${FILE_ACCEPT}">
          <span class="field-hint">PDF, DOC/DOCX, TXT, Markdown, HTML, JSON, or CSV. Up to 20 files, 50&nbsp;MB each.</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
          <button class="settings-save-btn" id="knowledgeUploadBtn" type="button"><i class="ph ph-upload-simple"></i> Ingest Files</button>
        </div>

        <div class="setting-field">
          <label>Or paste text</label>
          <input type="text" id="knowledgeTitleInput" placeholder="Title (optional)" style="margin-bottom:8px;">
          <textarea id="knowledgeTextInput" rows="4" placeholder="Paste notes, a runbook, an FAQ, or any reference text..." style="width:100%;min-height:88px;padding:10px 12px;border-radius:8px;border:1px solid var(--border-color, rgba(255,255,255,0.12));background:rgba(255,255,255,0.03);color:var(--text-primary);font-size:13px;"></textarea>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="settings-save-btn" id="knowledgeIngestTextBtn" type="button" style="background:var(--accent-primary);"><i class="ph ph-plus-circle"></i> Ingest Text</button>
        </div>
      </div>`;
  }

  // Render one target-scope radio card.
  renderScopeOption(value, title, desc, checked) {
    return `
      <label class="setting-toggle" style="cursor:pointer;align-items:flex-start;">
        <div>
          <div class="setting-toggle-label">${title}</div>
          <div class="setting-section-desc" style="margin:2px 0 0;">${desc}</div>
        </div>
        <input type="radio" name="knowledgeScope" value="${value}" ${checked ? 'checked' : ''} style="margin-top:4px;">
      </label>`;
  }

  // Render the <option> list for the bot selector from the loaded agent roster.
  renderAgentOptions() {
    const agents = Array.isArray(this.view.agents) ? this.view.agents : [];
    if (!agents.length) {
      return '<option value="">No swarm members available</option>';
    }
    const options = agents
      .map((agent) => {
        const id = agent.agent_id || agent.name || '';
        return `<option value="${escapeAttr(id)}">${escapeHtml(prettyAgentName(agent))}</option>`;
      })
      .join('');
    return `<option value="">Select a swarm member</option>${options}`;
  }

  // Render the visibility surface: summary tiles, grouped inventory, and a retrieval test.
  renderVisibilitySection() {
    return `
      <div class="setting-section">
        <div class="setting-section-title">Knowledge Visibility</div>
        <div class="setting-section-desc" id="knowledgeVisibilityDesc">What the swarm and each bot can retrieve. Private documents are scoped to their owner.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;">
          <button class="settings-cancel-btn" id="knowledgeRefreshBtn" type="button"><i class="ph ph-arrows-clockwise"></i> Refresh</button>
        </div>
        <div id="knowledgeSummary" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px;"></div>
        <div id="knowledgeGroups"></div>
      </div>

      <div class="setting-section">
        <div class="setting-section-title">Test Retrieval</div>
        <div class="setting-section-desc">Search the vector store as your permissions allow — verify what a bot or user can actually retrieve.</div>
        <div class="setting-field">
          <input type="text" id="knowledgeSearchInput" placeholder="Ask what you expect the knowledge base to answer...">
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="settings-save-btn" id="knowledgeSearchBtn" type="button"><i class="ph ph-magnifying-glass"></i> Search</button>
        </div>
        <div id="knowledgeSearchResults" style="margin-top:12px;"></div>
      </div>`;
  }

  // Attach all knowledge-tab interaction handlers.
  bindEvents() {
    this.body.querySelectorAll('input[name="knowledgeScope"]').forEach((node) => {
      node.addEventListener('change', () => this.syncScope());
    });
    this.body.querySelector('#knowledgeAgentSelect')?.addEventListener('change', () => this.syncScope());
    this.body.querySelector('#knowledgeUploadBtn')?.addEventListener('click', () => this.handleUpload());
    this.body.querySelector('#knowledgeIngestTextBtn')?.addEventListener('click', () => this.handleIngestText());
    this.body.querySelector('#knowledgeRefreshBtn')?.addEventListener('click', () => this.loadKnowledge());
    this.body.querySelector('#knowledgeSearchBtn')?.addEventListener('click', () => this.handleSearch());
    this.body.querySelector('#knowledgeSearchInput')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        this.handleSearch();
      }
    });
  }

  // Reflect the selected scope in the bot-field visibility and collection preview.
  syncScope() {
    const scope = this.readScope();
    const agentField = this.body.querySelector('#knowledgeAgentField');
    if (agentField) {
      agentField.style.display = scope === 'agent' ? '' : 'none';
    }
    const collection = this.resolveTarget().collection;
    const top = this.body.querySelector('#knowledgeCollectionPreviewTop');
    const inline = this.body.querySelector('#knowledgeCollectionPreview');
    if (top) top.textContent = collection;
    if (inline) inline.textContent = collection;
  }

  // Read the selected target scope value.
  readScope() {
    const checked = this.body.querySelector('input[name="knowledgeScope"]:checked');
    return checked instanceof HTMLInputElement ? checked.value : 'swarm';
  }

  // Resolve the concrete ingestion target (collection + agent + privacy) from the selected scope.
  resolveTarget() {
    const scope = this.readScope();
    if (scope === 'agent') {
      const agentId = this.body.querySelector('#knowledgeAgentSelect')?.value || '';
      return {
        scope,
        agentId,
        collection: agentId ? `${AGENT_COLLECTION_PREFIX}${agentId}` : `${AGENT_COLLECTION_PREFIX}<choose-bot>`,
        isPrivate: false,
      };
    }
    if (scope === 'private') {
      return { scope, agentId: '', collection: PRIVATE_COLLECTION, isPrivate: true };
    }
    return { scope, agentId: '', collection: SWARM_COLLECTION, isPrivate: false };
  }

  // Upload the queued files into the resolved target.
  async handleUpload() {
    const input = this.body.querySelector('#knowledgeFileInput');
    if (!(input instanceof HTMLInputElement) || !input.files || input.files.length === 0) {
      this.setStatus('Choose at least one file to ingest.', 'error');
      return;
    }
    const target = this.resolveTarget();
    if (target.scope === 'agent' && !target.agentId) {
      this.setStatus('Choose a swarm member before ingesting bot-specific knowledge.', 'error');
      return;
    }
    const formData = new FormData();
    Array.from(input.files).forEach((file) => formData.append('files', file));
    formData.append('collection', target.collection);
    if (target.agentId) formData.append('agentId', target.agentId);
    if (target.isPrivate) formData.append('private', 'true');
    this.setStatus(`Ingesting ${input.files.length} file(s) into ${target.collection}...`, 'info');
    try {
      const payload = await postForm('/api/rag/upload', formData);
      this.setStatus(`Ingested ${payload.count || input.files.length} file(s) into ${payload.collection || target.collection}.`, 'success');
      input.value = '';
      await this.loadKnowledge();
    } catch (error) {
      logger.error('Knowledge file ingest failed', { error: serializeUiError(error) });
      this.setStatus(`Ingest failed: ${errorMessage(error)}`, 'error');
    }
  }

  // Ingest pasted text into the resolved target.
  async handleIngestText() {
    const content = this.body.querySelector('#knowledgeTextInput')?.value?.trim() || '';
    if (!content) {
      this.setStatus('Paste some text to ingest.', 'error');
      return;
    }
    const target = this.resolveTarget();
    if (target.scope === 'agent' && !target.agentId) {
      this.setStatus('Choose a swarm member before ingesting bot-specific knowledge.', 'error');
      return;
    }
    const title = this.body.querySelector('#knowledgeTitleInput')?.value?.trim() || '';
    this.setStatus(`Ingesting text into ${target.collection}...`, 'info');
    try {
      const payload = await postJson('/api/rag/ingest', {
        format: 'text',
        content,
        title: title || undefined,
        collection: target.collection,
        agentId: target.agentId || undefined,
        visibility: target.isPrivate ? 'private' : 'shared',
      });
      this.setStatus(`Ingested ${payload.chunkCount ?? 1} chunk(s) into ${target.collection}.`, 'success');
      const textInput = this.body.querySelector('#knowledgeTextInput');
      const titleInput = this.body.querySelector('#knowledgeTitleInput');
      if (textInput) textInput.value = '';
      if (titleInput) titleInput.value = '';
      await this.loadKnowledge();
    } catch (error) {
      logger.error('Knowledge text ingest failed', { error: serializeUiError(error) });
      this.setStatus(`Ingest failed: ${errorMessage(error)}`, 'error');
    }
  }

  // Load the permission-aware knowledge inventory and render summary + groups.
  async loadKnowledge() {
    const summary = this.body.querySelector('#knowledgeSummary');
    if (summary) summary.innerHTML = '<div class="field-hint">Loading knowledge inventory...</div>';
    try {
      const payload = await this.view.api.getSafe('/api/rag/knowledge', { documents: [], isOperator: false });
      this.knowledge = {
        documents: Array.isArray(payload.documents) ? payload.documents : [],
        isOperator: Boolean(payload.isOperator),
      };
      this.renderSummary();
      this.renderGroups();
      this.updateVisibilityDesc();
    } catch (error) {
      logger.error('Failed to load knowledge inventory', { error: serializeUiError(error) });
      if (summary) summary.innerHTML = '<div class="field-hint">Could not load knowledge inventory.</div>';
    }
  }

  // Update the visibility description to reflect the caller's scope.
  updateVisibilityDesc() {
    const node = this.body.querySelector('#knowledgeVisibilityDesc');
    if (!node) return;
    node.textContent = this.knowledge.isOperator
      ? 'Operator view: every collection, every bot, and every owner across the swarm.'
      : 'Your view: shared swarm knowledge, each bot’s knowledge, and the private documents you own.';
  }

  // Render the summary tiles from the loaded documents.
  renderSummary() {
    const docs = this.knowledge.documents;
    const collections = new Set(docs.map((doc) => doc.collection));
    const chunks = docs.reduce((sum, doc) => sum + (Number(doc.chunkCount) || 0), 0);
    const counts = { swarm: 0, bot: 0, private: 0 };
    docs.forEach((doc) => { counts[doc.scope] = (counts[doc.scope] || 0) + 1; });
    const tiles = [
      ['Documents', docs.length],
      ['Collections', collections.size],
      ['Chunks', chunks],
      ['Swarm', counts.swarm],
      ['Per-bot', counts.bot],
      [this.knowledge.isOperator ? 'Private' : 'Yours', counts.private],
    ];
    const node = this.body.querySelector('#knowledgeSummary');
    if (node) {
      node.innerHTML = tiles.map(([label, value]) => `
        <div style="padding:12px;border:1px solid var(--border-color, rgba(255,255,255,0.12));border-radius:12px;background:rgba(255,255,255,0.02);">
          <div class="setting-section-desc" style="margin:0;">${label}</div>
          <div style="font-size:22px;font-weight:600;margin-top:4px;">${value}</div>
        </div>`).join('');
    }
  }

  // Render the grouped inventory: general swarm, per-bot, and private documents.
  renderGroups() {
    const docs = this.knowledge.documents;
    const node = this.body.querySelector('#knowledgeGroups');
    if (!node) return;
    if (!docs.length) {
      node.innerHTML = '<div class="field-hint">No knowledge ingested yet. Add files or text above.</div>';
      return;
    }
    const swarm = docs.filter((doc) => doc.scope === 'swarm');
    const privateDocs = docs.filter((doc) => doc.scope === 'private');
    const byBot = new Map();
    docs.filter((doc) => doc.scope === 'bot').forEach((doc) => {
      const key = doc.agentId || 'unknown';
      if (!byBot.has(key)) byBot.set(key, []);
      byBot.get(key).push(doc);
    });

    const blocks = [];
    blocks.push(this.renderGroupBlock('General swarm knowledge', 'Shared with every bot.', swarm));
    for (const [agentId, botDocs] of byBot.entries()) {
      blocks.push(this.renderGroupBlock(`Bot: ${escapeHtml(this.agentName(agentId))}`, `Retrievable in ${escapeHtml(`${AGENT_COLLECTION_PREFIX}${agentId}`)}.`, botDocs));
    }
    const privateLabel = this.knowledge.isOperator ? 'Private (per user)' : 'Private (yours)';
    blocks.push(this.renderGroupBlock(privateLabel, 'Owner-scoped documents.', privateDocs));
    node.innerHTML = blocks.join('');
  }

  // Render one collapsible group of documents; omitted entirely when empty.
  renderGroupBlock(title, subtitle, docs) {
    if (!docs.length) {
      return '';
    }
    const rows = docs.map((doc) => this.renderDocumentRow(doc)).join('');
    return `
      <details style="margin-bottom:10px;border:1px solid var(--border-color, rgba(255,255,255,0.12));border-radius:12px;background:rgba(255,255,255,0.02);" open>
        <summary style="cursor:pointer;padding:10px 12px;font-weight:600;">${escapeHtml(title)} <span class="field-hint" style="font-weight:400;">(${docs.length})</span></summary>
        <div class="setting-section-desc" style="padding:0 12px 6px;">${subtitle}</div>
        <div style="padding:0 12px 12px;">${rows}</div>
      </details>`;
  }

  // Render one document row with title, collection, owner (operator only), and counts.
  renderDocumentRow(doc) {
    const owner = this.knowledge.isOperator && doc.ownerSub
      ? `<span class="field-hint"> · owner ${escapeHtml(doc.ownerSub)}</span>`
      : '';
    const created = doc.createdAt ? new Date(doc.createdAt).toLocaleString() : '';
    return `
      <div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--border-color, rgba(255,255,255,0.08));">
        <div style="min-width:0;">
          <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(doc.title || 'Untitled')}</div>
          <div class="field-hint"><code>${escapeHtml(doc.collection)}</code> · ${escapeHtml(doc.source || 'ingest')}${owner}</div>
        </div>
        <div class="field-hint" style="text-align:right;white-space:nowrap;">${Number(doc.chunkCount) || 0} chunk(s)<br>${escapeHtml(created)}</div>
      </div>`;
  }

  // Run a permission-aware retrieval test and render hits.
  async handleSearch() {
    const query = this.body.querySelector('#knowledgeSearchInput')?.value?.trim() || '';
    const results = this.body.querySelector('#knowledgeSearchResults');
    if (!query) {
      if (results) results.innerHTML = '<div class="field-hint">Enter a query to test retrieval.</div>';
      return;
    }
    if (results) results.innerHTML = '<div class="field-hint">Searching...</div>';
    try {
      const payload = await this.view.api.getSafe(`/api/rag/search?q=${encodeURIComponent(query)}&topK=6`, { results: [] });
      const hits = Array.isArray(payload.results) ? payload.results : [];
      if (results) {
        results.innerHTML = hits.length
          ? hits.map((hit) => this.renderSearchHit(hit)).join('')
          : '<div class="field-hint">No results. Try a broader query, or ingest matching material first.</div>';
      }
    } catch (error) {
      logger.error('Knowledge retrieval test failed', { error: serializeUiError(error) });
      if (results) results.innerHTML = '<div class="field-hint">Search failed.</div>';
    }
  }

  // Render one retrieval hit.
  renderSearchHit(hit) {
    const score = typeof hit.score === 'number' ? hit.score.toFixed(3) : 'n/a';
    const collection = hit.collection ? ` · ${escapeHtml(hit.collection)}` : '';
    const preview = escapeHtml(String(hit.text || '').slice(0, 260) || 'No preview.');
    return `
      <div style="padding:10px 12px;margin-bottom:8px;border:1px solid var(--border-color, rgba(255,255,255,0.1));border-radius:10px;background:rgba(255,255,255,0.02);">
        <div class="field-hint">Score ${score}${collection}</div>
        <div style="font-size:13px;margin-top:4px;">${preview}</div>
      </div>`;
  }

  // Resolve a display name for one agent id from the loaded roster.
  agentName(agentId) {
    const agents = Array.isArray(this.view.agents) ? this.view.agents : [];
    const match = agents.find((agent) => (agent.agent_id || agent.name) === agentId);
    return match ? prettyAgentName(match) : agentId;
  }

  // Set the ingestion status line with an optional tone.
  setStatus(message, tone) {
    const node = this.body.querySelector('#knowledgeStatus');
    if (!node) return;
    node.textContent = message || '';
    node.style.color = tone === 'error'
      ? 'var(--status-error, #f87171)'
      : tone === 'success'
        ? 'var(--status-success, #4ade80)'
        : 'var(--text-dim, var(--text-secondary))';
  }
}

// Build a human-friendly agent name from a raw agent record.
function prettyAgentName(agent) {
  const raw = agent.name || agent.agent_id || 'bot';
  return String(raw).replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

// POST multipart form data and return the parsed JSON, throwing on non-OK.
async function postForm(endpoint, formData) {
  const response = await fetch(endpoint, { method: 'POST', credentials: 'include', body: formData });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

// POST a JSON body and return the parsed JSON, throwing on non-OK.
async function postJson(endpoint, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

// Extract a readable message from an error value.
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// Escape HTML before rendering into element content.
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Escape HTML before rendering into an attribute.
function escapeAttr(value) {
  return escapeHtml(value);
}
