/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from TicketView.js (1000-line cap)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Session 22: Added Intake Assistant tab — conversational ticket creation with interview flow
 */

import { ApiClient } from '../api-client.js';

const api = new ApiClient();

/**
 * @description Opens the create ticket modal with two modes:
 * 1. Quick Form — title, description, priority (existing)
 * 2. Intake Assistant — conversational interview flow
 */
export function openCreateTicketModal(onSuccess) {
  const overlay = document.createElement('div');
  overlay.id = 'createTicketOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content" style="max-width:560px;max-height:85vh;display:flex;flex-direction:column">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="margin:0">Create Ticket</h2>
        <button id="ctClose" style="background:none;border:none;color:var(--text-muted);font-size:18px;cursor:pointer"><i class="ph ph-x"></i></button>
      </div>
      <div class="intake-tabs" style="display:flex;gap:0;border:1px solid var(--glass-border);border-radius:var(--radius-sm);overflow:hidden;margin-bottom:14px;flex-shrink:0">
        <button class="intake-tab active" data-tab="form" style="flex:1;padding:8px;border:none;background:var(--accent-primary);color:#fff;font-size:13px;font-weight:500;cursor:pointer"><i class="ph ph-note-pencil"></i> Quick Form</button>
        <button class="intake-tab" data-tab="assistant" style="flex:1;padding:8px;border:none;background:var(--glass-bg);color:var(--text-secondary);font-size:13px;font-weight:500;cursor:pointer"><i class="ph ph-chat-dots"></i> Intake Assistant</button>
      </div>
      <div id="ctFormTab" style="flex:1;overflow-y:auto">
        <form id="createTicketForm">
          <div class="form-group"><label for="ctTitle">Title</label><input type="text" id="ctTitle" required placeholder="Ticket title..." /></div>
          <div class="form-group"><label for="ctDescription">Description</label><textarea id="ctDescription" rows="4" placeholder="Describe the ticket..."></textarea></div>
          <div class="form-group">
            <label for="ctType">Type <span style="color:var(--text-muted);font-weight:normal;font-size:11px">(determines workflow)</span></label>
            <select id="ctType">
              <option value="build" selected>Build — software construction (7-phase swarm)</option>
              <option value="incident">Incident — investigation + RCA (2-bot pipeline)</option>
            </select>
          </div>
          <div class="form-group"><label for="ctPriority">Priority</label><select id="ctPriority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="critical">Critical</option></select></div>
          <div class="modal-actions"><button type="button" class="btn-cancel" id="ctCancel">Cancel</button><button type="submit" class="btn-primary">Create Ticket</button></div>
        </form>
      </div>
      <div id="ctAssistantTab" style="flex:1;overflow-y:auto;display:none">
        <div id="intakeChat" style="display:flex;flex-direction:column;gap:8px;min-height:200px;max-height:50vh;overflow-y:auto;padding:4px 0"></div>
        <div style="display:flex;gap:8px;margin-top:10px;flex-shrink:0">
          <input type="text" id="intakeInput" placeholder="Type your answer..." style="flex:1;padding:8px 12px;border:1px solid var(--glass-border);border-radius:var(--radius-sm);background:var(--glass-bg);color:var(--text-primary);font-size:14px" />
          <button id="intakeSend" style="padding:8px 14px;border:1px solid var(--accent-primary);border-radius:var(--radius-sm);background:rgba(99,102,241,0.15);color:var(--accent-primary);cursor:pointer;font-size:13px"><i class="ph ph-paper-plane-right"></i></button>
        </div>
        <div id="intakeActions" style="display:none;margin-top:10px;display:flex;gap:8px;justify-content:flex-end">
          <button id="intakeDone" class="btn-cancel" style="display:none">Done — Summarize</button>
          <button id="intakeSubmit" class="btn-primary" style="display:none">Create Ticket</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let intakeSessionId = null;
  let intakeDone = false;

  // Tab switching
  overlay.querySelectorAll('.intake-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      overlay.querySelectorAll('.intake-tab').forEach((t) => { t.style.background = 'var(--glass-bg)'; t.style.color = 'var(--text-secondary)'; t.classList.remove('active'); });
      tab.style.background = 'var(--accent-primary)'; tab.style.color = '#fff'; tab.classList.add('active');
      const isAssistant = tab.dataset.tab === 'assistant';
      overlay.querySelector('#ctFormTab').style.display = isAssistant ? 'none' : '';
      overlay.querySelector('#ctAssistantTab').style.display = isAssistant ? '' : 'none';
      if (isAssistant && !intakeSessionId) startIntakeSession();
    });
  });

  // Populate the ticket-type dropdown from registered swarm-app workflows.
  // Built-ins (build/incident) are seeded in markup; we extend with each
  // active app's ticketType (e.g. education from little-monsters) so the
  // operator can route to manifest-contributed pipelines too.
  (async () => {
    const sel = document.getElementById('ctType');
    if (!sel) return;
    try {
      const res = await fetch('/api/swarm/apps');
      if (!res.ok) return;
      const data = await res.json();
      // 'build' is hardcoded as the always-present option (framework-embedded).
      // Other types (incident, education, custom) only appear when an active
      // swarm-app manifest declares them — keeps the dropdown honest.
      const seen = new Set(['build']);
      for (const app of data.apps || []) {
        if (app.status !== 'active') continue;
        const t = app.manifest?.ticketType;
        if (!t || seen.has(t)) continue;
        seen.add(t);
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = `${t.charAt(0).toUpperCase() + t.slice(1)} — ${app.displayName || app.name} (${app.manifest?.workflow?.name || 'manifest workflow'})`;
        sel.appendChild(opt);
      }
    } catch { /* leave hardcoded options */ }
  })();

  // Quick form submit
  const form = document.getElementById('createTicketForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('ctTitle')?.value;
      const description = document.getElementById('ctDescription')?.value;
      const priority = document.getElementById('ctPriority')?.value;
      const ticketType = document.getElementById('ctType')?.value || 'build';
      try {
        await fetch('/api/v1/tickets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description, priority, ticketType }),
        });
        overlay.remove();
        if (onSuccess) onSuccess();
      } catch (err) { alert('Failed: ' + err.message); }
    });
  }

  // Intake assistant
  function appendMessage(role, content) {
    const chat = document.getElementById('intakeChat');
    if (!chat) return;
    const bubble = document.createElement('div');
    bubble.style.cssText = role === 'assistant'
      ? 'background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:12px 12px 12px 4px;padding:10px 14px;font-size:13px;line-height:1.5;color:var(--text-primary);max-width:90%;align-self:flex-start'
      : 'background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.2);border-radius:12px 12px 4px 12px;padding:10px 14px;font-size:13px;line-height:1.5;color:var(--text-primary);max-width:90%;align-self:flex-end';
    bubble.innerHTML = content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    chat.appendChild(bubble);
    chat.scrollTop = chat.scrollHeight;
  }

  async function startIntakeSession() {
    try {
      const res = await api.post('/api/v1/intake/start', {});
      intakeSessionId = res.sessionId;
      if (res.message) appendMessage(res.message.role, res.message.content);
      document.getElementById('intakeDone').style.display = '';
    } catch (err) { appendMessage('assistant', 'Failed to start intake session: ' + err.message); }
  }

  async function sendIntakeMessage() {
    const input = document.getElementById('intakeInput');
    const msg = input?.value?.trim();
    if (!msg || !intakeSessionId) return;
    input.value = '';
    appendMessage('user', msg);
    try {
      const res = await api.post(`/api/v1/intake/${intakeSessionId}/message`, { message: msg });
      if (res.message) appendMessage(res.message.role, res.message.content);
      if (res.done) {
        intakeDone = true;
        document.getElementById('intakeSubmit').style.display = '';
        document.getElementById('intakeDone').style.display = 'none';
      }
    } catch (err) { appendMessage('assistant', 'Error: ' + err.message); }
  }

  document.getElementById('intakeSend')?.addEventListener('click', sendIntakeMessage);
  document.getElementById('intakeInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendIntakeMessage(); } });
  document.getElementById('intakeDone')?.addEventListener('click', () => {
    const input = document.getElementById('intakeInput');
    if (input) { input.value = 'done'; sendIntakeMessage(); }
  });
  document.getElementById('intakeSubmit')?.addEventListener('click', async () => {
    if (!intakeSessionId) return;
    try {
      const res = await api.post(`/api/v1/intake/${intakeSessionId}/submit`, {});
      overlay.remove();
      if (onSuccess) onSuccess();
    } catch (err) { alert('Failed to submit: ' + err.message); }
  });

  // Close handlers
  const close = () => overlay.remove();
  document.getElementById('ctClose')?.addEventListener('click', close);
  document.getElementById('ctCancel')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function escHandler(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } });
}

/**
 * @description Opens the project manager modal to view existing projects
 * and create new ones.
 * @param {Function} onSuccess - Callback invoked after successful project creation
 */
export function openProjectManagerModal(onSuccess) {
  const overlay = document.createElement('div');
  overlay.id = 'projectManagerOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content modal-wide">
      <h2>Project Manager</h2>
      <div id="pmProjectList" class="project-list">
        <p class="loading-text">Loading projects...</p>
      </div>
      <hr />
      <h3>Create New Project</h3>
      <form id="pmCreateForm">
        <div class="form-group"><label for="pmName">Project Name</label><input type="text" id="pmName" required placeholder="Project name..." /></div>
        <div class="form-group"><label for="pmDescription">Description</label><textarea id="pmDescription" rows="3" placeholder="Project description..."></textarea></div>
        <div class="modal-actions"><button type="button" class="btn-cancel" id="pmCancel">Cancel</button><button type="submit" class="btn-primary">Create Project</button></div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = document.getElementById('pmProjectList');
  fetch('/api/v1/projects')
    .then(r => r.json())
    .then(projects => {
      if (!listEl) return;
      if (!Array.isArray(projects) || projects.length === 0) { listEl.innerHTML = '<p class="empty-text">No projects yet.</p>'; return; }
      listEl.innerHTML = projects.map(p => `<div class="project-card"><strong>${p.name}</strong><p>${p.description || 'No description'}</p></div>`).join('');
    })
    .catch(err => { if (listEl) listEl.innerHTML = '<p class="error-text">Failed to load projects.</p>'; });

  const form = document.getElementById('pmCreateForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('pmName')?.value;
      const description = document.getElementById('pmDescription')?.value;
      try {
        const resp = await fetch('/api/v1/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description }) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        overlay.remove();
        if (onSuccess) onSuccess();
      } catch (err) { alert('Failed to create project: ' + err.message); }
    });
  }

  document.getElementById('pmCancel')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function escHandler(e) { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); } });
}
