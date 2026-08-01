/**
 * Connector write-action runner — the 428 needs-confirmation UX.
 *
 * The write tier answers a risky action with HTTP 428 and refuses to do anything until the caller
 * re-sends the SAME request carrying an explicit confirm. Until now nothing rendered that: the rail
 * existed and no human could ever reach it, so a "human approval gate" was a thing only a curl could
 * satisfy. This panel is that gate — run an action, see the refusal spelled out (which connector,
 * which action, what risk, the exact params), then Approve or Deny.
 *
 * Two rules the shape enforces:
 *  - The panel NEVER sends confirm on the first attempt. Approval is a separate human act; a UI that
 *    pre-confirms turns the gate back into decoration.
 *  - Approve re-sends the IDENTICAL params, plus the confirm flag. It never edits, re-reads, or
 *    re-derives them, so what the person approved is exactly what runs.
 *
 * The rail is stateless by design: there is no pending-action store, and the audit trail keeps only a
 * params HASH (never payloads, which may hold message bodies or PII). So "approve" means "approve the
 * attempt in front of you", not "approve something from yesterday" — a past 428 cannot be replayed
 * from the trail, and pretending otherwise would need raw payload retention.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — declared-action picker, params editor, 428 approve/deny prompt, and the caller's recent trail from GET /api/connectors/actions/audit.
 *
 * @module cockpit/views/ConnectorActionRunner
 */

import { createUiLogger } from '../../../shared/ui-debug.js';

const logger = createUiLogger('cockpit-connector-action-runner');

/**
 * @description Classify a write-action response into the ONE next step the panel takes. Pure and
 * exported so the gate's behaviour is testable without a DOM: 428 must always mean "ask the human",
 * never "retry with confirm".
 * @param {number} status HTTP status from POST /api/connectors/:id/actions/:action.
 * @param {object} body Parsed JSON body.
 * @returns {{state: 'needs-confirmation'|'done'|'not-connected'|'error', message: string, data?: unknown}}
 */
export function decideAfterActionResponse(status, body) {
  const payload = body && typeof body === 'object' ? body : {};
  if (status === 428) {
    return {
      state: 'needs-confirmation',
      message: String(payload.message || payload.error || 'This action needs your explicit confirmation before it runs.'),
    };
  }
  if (status === 200 && payload.ok) {
    return { state: 'done', message: 'Done. The provider accepted the request.', data: payload.data };
  }
  if (payload.code === 'not_connected') {
    return { state: 'not-connected', message: 'You have no connection for this connector — connect it at /utilities first. Nothing was sent.' };
  }
  return { state: 'error', message: String(payload.error || `The action failed (HTTP ${status}).`) };
}

/**
 * @description Build the request body for an attempt. `confirmed` is the ONLY difference between the
 * first attempt and the approved one — the params object is passed through untouched, so the approved
 * call is byte-identical to what the refusal described.
 * @param {object} params The action params.
 * @param {boolean} confirmed Whether the human has just approved this exact attempt.
 * @returns {object} The POST body.
 */
export function buildActionRequestBody(params, confirmed) {
  return confirmed ? { params, confirm: true } : { params };
}

/** Escape text for innerHTML. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Names of the params an action declares as required, for the placeholder hint. */
function requiredParamNames(action) {
  const required = action && action.requiredParams;
  return Array.isArray(required) ? required : [];
}

/**
 * @description Open the runner panel for one connector. Renders into document.body as an overlay and
 * resolves nothing — the panel owns its own lifecycle and closes on Deny/Close/backdrop click.
 * @param {object} entry A ConnectorMarketplaceEntry (needs id, label, writeActions).
 * @returns {void}
 */
export function openConnectorActionRunner(entry) {
  const actions = Array.isArray(entry?.writeActions) ? entry.writeActions : [];
  if (!actions.length) return;
  const overlay = document.createElement('div');
  overlay.className = 'connector-runner-overlay';
  overlay.innerHTML = `
    <div class="connector-runner" role="dialog" aria-modal="true" aria-label="Run a ${esc(entry.label)} write action">
      <header>
        <b>${esc(entry.label)} — write actions</b>
        <button type="button" class="connector-runner-close" aria-label="Close">&times;</button>
      </header>
      <label>Action
        <select class="connector-runner-action">
          ${actions.map((a) => `<option value="${esc(a.name)}">${esc(a.name)} — ${esc(a.method)} ${esc(a.urlTemplate)} (${esc(a.riskLevel)} risk)</option>`).join('')}
        </select>
      </label>
      <p class="connector-runner-desc"></p>
      <label>Parameters (JSON)
        <textarea class="connector-runner-params" rows="7" spellcheck="false"></textarea>
      </label>
      <div class="connector-runner-state" role="status"></div>
      <div class="connector-runner-buttons">
        <button type="button" class="connector-runner-run">Run</button>
        <button type="button" class="connector-runner-approve" hidden>Approve &amp; run</button>
        <button type="button" class="connector-runner-deny" hidden>Deny</button>
      </div>
      <details class="connector-runner-trail"><summary>Recent activity on your account</summary><div class="connector-runner-trail-body">Loading…</div></details>
    </div>`;
  document.body.appendChild(overlay);

  const q = (sel) => overlay.querySelector(sel);
  const select = q('.connector-runner-action');
  const desc = q('.connector-runner-desc');
  const paramsBox = q('.connector-runner-params');
  const state = q('.connector-runner-state');
  const runBtn = q('.connector-runner-run');
  const approveBtn = q('.connector-runner-approve');
  const denyBtn = q('.connector-runner-deny');
  /** The exact params the pending 428 refers to — approve re-sends THESE, never a re-read. */
  let pending = null;

  const currentAction = () => actions.find((a) => a.name === select.value) || actions[0];
  const syncAction = () => {
    const action = currentAction();
    desc.textContent = `${action.description || ''}${action.requiresConfirmation ? ' This action always asks for confirmation before it runs.' : ''}`;
    const hint = requiredParamNames(action).reduce((acc, name) => Object.assign(acc, { [name]: '' }), {});
    if (!paramsBox.value.trim()) paramsBox.value = JSON.stringify(hint, null, 2);
    setPrompt(false, '');
  };
  const setPrompt = (needsConfirm, message) => {
    pending = needsConfirm ? pending : null;
    state.textContent = message;
    state.className = `connector-runner-state${needsConfirm ? ' needs-confirm' : ''}`;
    approveBtn.hidden = !needsConfirm;
    denyBtn.hidden = !needsConfirm;
    runBtn.hidden = needsConfirm;
  };

  async function attempt(params, confirmed) {
    const action = currentAction();
    const response = await fetch(`/api/connectors/${encodeURIComponent(entry.id)}/actions/${encodeURIComponent(action.name)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildActionRequestBody(params, confirmed)),
    });
    const body = await response.json().catch(() => ({}));
    const decision = decideAfterActionResponse(response.status, body);
    if (decision.state === 'needs-confirmation') {
      pending = params;
      setPrompt(true, `${decision.message} — ${action.name} (${action.riskLevel} risk) on ${entry.label}, with the parameters above. Nothing has been sent.`);
    } else {
      setPrompt(false, decision.message);
      void loadTrail();
    }
    logger.info('connector action attempt', { provider: entry.id, action: action.name, status: response.status, state: decision.state, confirmed });
  }

  async function loadTrail() {
    const body = q('.connector-runner-trail-body');
    try {
      const res = await fetch(`/api/connectors/actions/audit?connector=${encodeURIComponent(entry.id)}&limit=10`, { credentials: 'include' });
      const json = await res.json();
      const rows = (json && json.entries) || [];
      body.innerHTML = rows.length
        ? `<ul>${rows.map((r) => `<li><code>${esc(r.action)}</code> — ${esc(r.status)}${r.httpStatus ? ` (${esc(r.httpStatus)})` : ''} — ${esc(r.ts)}</li>`).join('')}</ul>`
        : 'Nothing yet.';
    } catch (err) {
      logger.warn('connector action trail unavailable', { err: String(err) });
      body.textContent = 'The activity trail could not be read.';
    }
  }

  select.addEventListener('change', syncAction);
  runBtn.addEventListener('click', async () => {
    let params;
    try {
      params = JSON.parse(paramsBox.value || '{}');
    } catch {
      setPrompt(false, 'Parameters must be valid JSON. Nothing was sent.');
      return;
    }
    // Deliberately NOT confirmed: the first attempt must be able to be refused.
    await attempt(params, false);
  });
  approveBtn.addEventListener('click', async () => {
    if (pending === null) return;
    await attempt(pending, true);
  });
  denyBtn.addEventListener('click', () => setPrompt(false, 'Denied. Nothing was sent.'));
  q('.connector-runner-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });

  syncAction();
  void loadTrail();
}
