/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Render the governance API's actual CSP mode, rate-limit coverage, connector envelope posture, and Alertmanager HMAC state instead of obsolete binary flags.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Warn when the explicit shared-HKDF DEK-store break-glass is active instead of presenting it as normal per-user isolation.
 */
const state = {
  whoami: null,
  posture: null,
  connectors: null,
  tenants: null,
  budgets: null,
  readiness: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[char]);
}

async function getJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return response.json();
}

async function optionalJson(path) {
  try {
    return await getJson(path);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${path} returned ${response.status}`);
  return data;
}

async function deleteJson(path) {
  const response = await fetch(path, { method: 'DELETE', headers: { Accept: 'application/json' }, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${path} returned ${response.status}`);
  return data;
}

async function patchJson(path, body) {
  const response = await fetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${path} returned ${response.status}`);
  return data;
}

function actionMsg(id, text, tone = '') {
  const el = $(id);
  if (el) { el.className = `muted ${tone}`; el.textContent = text; }
}

function pill(text, tone = '') {
  return `<span class="chip ${tone}">${escapeHtml(text)}</span>`;
}

function kv(label, value, tone = '') {
  return `<div class="kv-row"><span>${escapeHtml(label)}</span><strong class="${tone}">${escapeHtml(value)}</strong></div>`;
}

function setStatus(text, tone = '') {
  const el = $('adminStatus');
  el.className = `status-strip ${tone}`;
  el.innerHTML = `${tone === 'ok' ? '<span class="codicon codicon-check"></span>' : '<span class="codicon codicon-info"></span>'}${escapeHtml(text)}`;
}

function setStatePill(id, text, tone) {
  const el = $(id);
  if (!el) return;
  el.className = `state-pill ${tone}`;
  el.textContent = text;
}

function renderIdentity() {
  const me = state.whoami || {};
  const role = me.role || 'unknown';
  $('operatorRole').textContent = role;
  $('operatorIdentity').textContent = me.email || me.sub || me.error || 'No authenticated identity returned.';
  setStatePill('rbacState', me.enforcement ? 'enforcing' : 'permissive', me.enforcement ? 'ok' : 'warn');
  const permissions = Array.isArray(me.permissions) ? me.permissions : [];
  const tokenRoles = Array.isArray(me.tokenRoles) ? me.tokenRoles : [];
  $('operatorPermissions').innerHTML = [
    ...permissions.map((item) => pill(item, 'ok')),
    ...tokenRoles.map((item) => pill(`claim:${item}`, '')),
    permissions.length === 0 && tokenRoles.length === 0 ? pill('no role claims', 'warn') : '',
  ].join('');
}

function renderControls() {
  const controls = state.posture?.controls || {};
  const cspValue = controls.cspMode || (controls.cspEnabled ? 'enabled' : 'disabled');
  const cspTone = controls.cspMode === 'enforce' ? 'ok' : (controls.cspEnabled ? 'warn' : 'bad');
  const rateComplete = controls.internalRateLimit && controls.expensiveRateLimit;
  const cryptoValue = !controls.cryptoAtRest
    ? 'SESSION_SECRET missing'
    : (!controls.envelopeCrypto
      ? 'k2 shared rollback'
      : (controls.envelopeDekFailure === 'shared-hkdf' ? 'DEK + k2 break-glass' : 'per-user DEK / deny'));
  const rows = [
    ['RBAC', controls.rbacEnforce ? 'enforcing' : 'permissive', controls.rbacEnforce ? 'ok' : 'warn'],
    ['RLS GUC', state.posture?.rls?.controls?.dbGuc ? 'on' : 'off', state.posture?.rls?.controls?.dbGuc ? 'ok' : 'bad'],
    ['Legacy unowned', controls.legacyUnownedAllowed ? 'allowed' : 'closed', controls.legacyUnownedAllowed ? 'bad' : 'ok'],
    ['CSP', cspValue, cspTone],
    ['Rate limit', rateComplete ? 'all rails' : 'external / partial', rateComplete ? 'ok' : 'warn'],
    ['Token crypto', cryptoValue, controls.cryptoAtRest && controls.envelopeCrypto && controls.envelopeDekFailure !== 'shared-hkdf' ? 'ok' : 'warn'],
    ['Alertmanager HMAC', controls.alertWebhookHmac ? 'configured' : 'bearer only', controls.alertWebhookHmac ? 'ok' : 'warn'],
    ['Mock OIDC', controls.mockOidc ? 'on' : 'off', controls.mockOidc ? 'bad' : 'ok'],
    ['Audit forwarding', controls.auditForwarding ? 'on' : 'off', controls.auditForwarding ? 'ok' : 'warn'],
  ];
  $('controlList').innerHTML = rows.map(([label, value, tone]) => kv(label, value, tone)).join('');
}

function renderRls() {
  const rls = state.posture?.rls;
  if (!rls || !rls.available) {
    setStatePill('rlsState', 'unavailable', 'bad');
    $('rlsDetails').innerHTML = kv('Posture', rls?.error || 'not available', 'bad');
    return;
  }
  setStatePill('rlsState', rls.releaseReady ? 'release ready' : rls.stage, rls.releaseReady ? 'ok' : 'warn');
  const blockers = Array.isArray(rls.blockers) ? rls.blockers : [];
  const rows = [
    ['Stage', rls.stage || 'unknown', rls.releaseReady ? 'ok' : 'warn'],
    ['DB role', rls.connection?.role || 'unknown', rls.connection?.validProofRole ? 'ok' : 'bad'],
    ['Schema mode', rls.controls?.schemaBootstrap || 'unknown', rls.controls?.schemaBootstrap === 'validate-only' ? 'ok' : 'warn'],
    ['Blockers', blockers.length ? `${blockers.length}` : '0', blockers.length ? 'warn' : 'ok'],
  ];
  const tableRows = (rls.tables || []).slice(0, 4).map((table) => kv(table.table, table.stage, table.stage === 'enforce' ? 'ok' : 'warn'));
  $('rlsDetails').innerHTML = rows.map(([label, value, tone]) => kv(label, value, tone)).join('') + tableRows.join('');
}

function renderTenants() {
  const tenants = Array.isArray(state.tenants?.tenants) ? state.tenants.tenants : [];
  if (tenants.length === 0) {
    $('tenantList').innerHTML = '<div class="list-item"><span class="codicon codicon-organization"></span><div><strong>No tenant memberships returned</strong><p>Create or join a tenant/space before public self-serve.</p></div></div>';
    return;
  }
  $('tenantList').innerHTML = tenants.slice(0, 5).map((tenant) => `
    <div class="list-item">
      <span class="codicon codicon-organization"></span>
      <div><strong>${escapeHtml(tenant.name || tenant.tenant_id)}</strong><p>${escapeHtml(tenant.kind || 'tenant')} · ${escapeHtml(tenant.role || 'member')}</p></div>
    </div>
  `).join('');
}

function renderTenantForms() {
  const tenants = Array.isArray(state.tenants?.tenants) ? state.tenants.tenants : [];
  const adminTenants = tenants.filter((tenant) => tenant.role === 'admin');
  const select = $('memberTenant');
  if (!select) return;
  select.innerHTML = adminTenants.length
    ? adminTenants.map((tenant) => `<option value="${escapeHtml(tenant.tenant_id)}">${escapeHtml(tenant.name || tenant.tenant_id)}</option>`).join('')
    : '<option value="">(create a household first)</option>';
}

async function reloadTenants() {
  state.tenants = await optionalJson('/api/tenants');
  renderTenants();
  renderTenantForms();
  renderTenantMembers();
}

async function renderTenantMembers() {
  const container = $('tenantMembers');
  const select = $('memberTenant');
  if (!container || !select) return;
  const tenantId = select.value;
  if (!tenantId) { container.innerHTML = ''; return; }
  const payload = await optionalJson(`/api/tenants/${encodeURIComponent(tenantId)}/members`);
  const members = Array.isArray(payload?.members) ? payload.members : [];
  container.innerHTML = members.length
    ? members.map((member) => `
      <div class="list-item">
        <span class="codicon codicon-account"></span>
        <div style="flex:1"><strong>${escapeHtml(member.user_sub)}</strong></div>
        <select class="audit-input" data-role="${escapeHtml(member.user_sub)}" style="width:auto" title="Member role">
          <option value="member"${member.role === 'member' ? ' selected' : ''}>member</option>
          <option value="admin"${member.role === 'admin' ? ' selected' : ''}>admin</option>
        </select>
        <button class="action-btn" data-remove="${escapeHtml(member.user_sub)}" title="Remove member"><span class="codicon codicon-trash"></span></button>
      </div>`).join('')
    : `<div class="muted">${escapeHtml(payload?.error || 'No members yet.')}</div>`;
  container.querySelectorAll('select[data-role]').forEach((select) => {
    select.addEventListener('change', async () => {
      const memberSub = select.getAttribute('data-role');
      try {
        await patchJson(`/api/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(memberSub)}`, { role: select.value });
        actionMsg('tenantActionMsg', `${memberSub} is now ${select.value}.`, 'ok');
        await renderTenantMembers();
      } catch (error) { actionMsg('tenantActionMsg', error.message, 'bad'); await renderTenantMembers(); }
    });
  });
  container.querySelectorAll('button[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const memberSub = btn.getAttribute('data-remove');
      try {
        await deleteJson(`/api/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(memberSub)}`);
        actionMsg('tenantActionMsg', `Removed ${memberSub}.`, 'ok');
        await renderTenantMembers();
      } catch (error) { actionMsg('tenantActionMsg', error.message, 'bad'); }
    });
  });
}

async function reloadConnectors() {
  state.connectors = await optionalJson('/api/connectors/marketplace');
  renderConnectors();
  renderApprovals();
}

function wireTenantControls() {
  const createForm = $('createTenantForm');
  if (createForm) createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('newTenantName').value.trim();
    if (!name) { actionMsg('tenantActionMsg', 'Household name is required.', 'bad'); return; }
    try {
      await postJson('/api/tenants', { name });
      $('newTenantName').value = '';
      actionMsg('tenantActionMsg', `Created "${name}" — you are its admin.`, 'ok');
      await reloadTenants();
    } catch (error) { actionMsg('tenantActionMsg', error.message, 'bad'); }
  });
  const memberForm = $('addMemberForm');
  if (memberForm) memberForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const tenantId = $('memberTenant').value;
    const memberSub = $('memberSub').value.trim();
    const role = $('memberRole').value;
    if (!tenantId || !memberSub) { actionMsg('tenantActionMsg', 'Pick a tenant and enter a member sub.', 'bad'); return; }
    try {
      await postJson(`/api/tenants/${encodeURIComponent(tenantId)}/members`, { memberSub, role });
      $('memberSub').value = '';
      actionMsg('tenantActionMsg', `Added ${memberSub} as ${role}.`, 'ok');
      await reloadTenants();
    } catch (error) { actionMsg('tenantActionMsg', error.message, 'bad'); }
  });
  const memberSelect = $('memberTenant');
  if (memberSelect) memberSelect.addEventListener('change', renderTenantMembers);
}

let connectorCatalog = null;

async function loadConnectorCatalog() {
  if (connectorCatalog) return connectorCatalog;
  const payload = await optionalJson('/api/connectors/marketplace?full=1');
  const data = payload?.data || payload || {};
  connectorCatalog = Array.isArray(data.entries) ? data.entries : [];
  return connectorCatalog;
}

async function toggleConnector(provider, action) {
  await postJson(`/api/connectors/marketplace/${encodeURIComponent(provider)}/${action}`, {});
  actionMsg('connectorActionMsg', `${provider} ${action}d.`, 'ok');
  connectorCatalog = null;
  await reloadConnectors();
}

async function renderConnectorSearch() {
  const input = $('connectorSearch');
  const results = $('connectorSearchResults');
  if (!input || !results) return;
  const query = input.value.trim().toLowerCase();
  if (!query) { results.innerHTML = ''; return; }
  const catalog = await loadConnectorCatalog();
  const matches = catalog
    .filter((entry) => `${entry.id} ${entry.label} ${entry.category}`.toLowerCase().includes(query))
    .slice(0, 8);
  results.innerHTML = matches.length
    ? matches.map((entry) => `
      <div class="list-item">
        <span class="codicon codicon-plug"></span>
        <div style="flex:1"><strong>${escapeHtml(entry.label || entry.id)}</strong><p>${escapeHtml(entry.category || 'connector')} · ${entry.enabled ? 'enabled' : 'disabled'}</p></div>
        <button class="action-btn" data-conn="${escapeHtml(entry.id)}" data-action="${entry.enabled ? 'disable' : 'enable'}">${entry.enabled ? 'Disable' : 'Enable'}</button>
      </div>`).join('')
    : '<div class="muted">No matching connectors.</div>';
  results.querySelectorAll('button[data-conn]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await toggleConnector(btn.getAttribute('data-conn'), btn.getAttribute('data-action'));
        await renderConnectorSearch();
      } catch (error) { actionMsg('connectorActionMsg', error.message, 'bad'); }
    });
  });
}

function wireConnectorControls() {
  const form = $('connectorToggleForm');
  const byId = async (action) => {
    const provider = $('connectorProvider').value.trim();
    if (!provider) { actionMsg('connectorActionMsg', 'Provider id is required.', 'bad'); return; }
    try { await toggleConnector(provider, action); } catch (error) { actionMsg('connectorActionMsg', error.message, 'bad'); }
  };
  if (form) form.addEventListener('submit', (event) => { event.preventDefault(); byId('enable'); });
  const disableBtn = $('connectorDisableBtn');
  if (disableBtn) disableBtn.addEventListener('click', () => byId('disable'));
  const search = $('connectorSearch');
  if (search) {
    let timer = null;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(renderConnectorSearch, 200); });
  }
}

function renderConnectors() {
  const summary = state.connectors?.data || state.connectors || {};
  const totals = summary.totals || {};
  const entries = Array.isArray(summary.entries) ? summary.entries : [];
  $('connectorMetrics').innerHTML = [
    metric('Catalog', totals.catalog ?? entries.length ?? 0),
    metric('Enabled', totals.enabled ?? 0),
    metric('High risk', totals.highRisk ?? entries.filter((entry) => entry.riskLevel === 'high').length),
    metric('Write capable', totals.writeCapable ?? entries.filter((entry) => Number(entry.writeCount || 0) > 0).length),
  ].join('');
  const highRisk = entries.filter((entry) => entry.riskLevel === 'high').slice(0, 4);
  $('connectorRisk').innerHTML = highRisk.length
    ? highRisk.map((entry) => `<div class="list-item"><span class="codicon codicon-plug"></span><div><strong>${escapeHtml(entry.label || entry.id)}</strong><p>${escapeHtml(entry.category || 'connector')} · ${escapeHtml(entry.onboarding?.mode || entry.authType || 'setup')}</p></div></div>`).join('')
    : '<div class="list-item"><span class="codicon codicon-check"></span><div><strong>No high-risk connectors in compact sample</strong><p>Open the marketplace for full connector governance.</p></div></div>';
}

function metric(label, value) {
  return `<div class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderBudgets() {
  const payload = state.budgets?.data;
  if (!payload) {
    setStatePill('budgetState', 'unavailable', 'warn');
    $('budgetList').innerHTML = kv('Status', state.budgets?.error || 'not available', 'warn');
    return;
  }
  const enforcement = payload.enforcement || {};
  setStatePill('budgetState', enforcement.on ? 'enforcing' : 'observe', enforcement.on ? 'ok' : 'warn');
  $('budgetList').innerHTML = [
    ['Budgets', enforcement.budgets ? 'on' : 'off', enforcement.budgets ? 'ok' : 'warn'],
    ['Quotas', enforcement.quotas ? 'on' : 'off', enforcement.quotas ? 'ok' : 'warn'],
    ['Routing', enforcement.routing ? 'on' : 'off', enforcement.routing ? 'ok' : 'warn'],
    ['Global daily cap', payload.budget?.globalDailyUsd ?? 'unset', payload.budget?.globalDailyUsd ? 'ok' : 'warn'],
  ].map(([label, value, tone]) => kv(label, value, tone)).join('');
}

function renderApprovals() {
  const controls = state.posture?.controls || {};
  const summary = state.connectors?.data || state.connectors || {};
  const totals = summary.totals || {};
  const entries = Array.isArray(summary.entries) ? summary.entries : [];
  const writeCapable = totals.writeCapable ?? entries.filter((entry) => Number(entry.writeCount || 0) > 0).length;
  const highRisk = totals.highRisk ?? entries.filter((entry) => entry.riskLevel === 'high').length;
  const dlpMode = controls.dlpMode || 'off';

  const guarded = Boolean(controls.policyEnforce) || Boolean(controls.accessAudit);
  setStatePill('approvalState', guarded ? 'guarded' : 'observe', guarded ? 'ok' : 'warn');

  $('approvalMetrics').innerHTML = [
    metric('Write-capable', writeCapable),
    metric('High risk', highRisk),
  ].join('');

  $('approvalControls').innerHTML = [
    ['Policy enforcement', controls.policyEnforce ? 'enforcing' : 'observe', controls.policyEnforce ? 'ok' : 'warn'],
    ['Access audit', controls.accessAudit ? 'on' : 'off', controls.accessAudit ? 'ok' : 'warn'],
    ['DLP mode', dlpMode, dlpMode !== 'off' ? 'ok' : 'warn'],
  ].map(([label, value, tone]) => kv(label, value, tone)).join('');
}

function renderReadiness() {
  const grid = $('readinessGrid');
  if (!grid) return;
  const payload = state.readiness || {};
  const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
  if (payload.available === false || tracks.length === 0) {
    grid.innerHTML = `<article class="readiness-card"><h3>Readiness</h3><p>${escapeHtml(
      payload.note || payload.error || 'Run npm run evidence:procurement-saas to generate the readiness artifact.',
    )}</p></article>`;
    return;
  }
  grid.innerHTML = tracks.map((item) => {
    const blockers = Array.isArray(item.blockers) ? item.blockers : [];
    return `
    <article class="readiness-card">
      <h3>${escapeHtml(item.title)}</h3>
      <div class="metric-row">${metric('Score', `${item.score}/100`)}${metric('Status', item.status)}</div>
      <ul>${blockers.length
        ? blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join('')
        : '<li>No open blockers.</li>'}</ul>
    </article>
  `;
  }).join('');
}

const AUDIT_PAGE = 50;
let auditLimit = AUDIT_PAGE;

function auditQuery() {
  const params = new URLSearchParams();
  const text = {
    action: $('auditAction').value.trim(),
    resourceType: $('auditResourceType').value.trim(),
    actorSub: $('auditActor').value.trim(),
    decision: $('auditDecision').value.trim(),
  };
  for (const [key, value] of Object.entries(text)) {
    if (value) params.set(key, value);
  }
  if ($('auditSince').value) params.set('since', new Date($('auditSince').value).toISOString());
  if ($('auditUntil').value) params.set('until', new Date($('auditUntil').value).toISOString());
  return params;
}

function syncAuditCsv() {
  const params = auditQuery();
  params.set('format', 'csv');
  params.set('limit', '5000');
  $('auditCsv').href = `/api/governance/audit/export?${params.toString()}`;
}

function decisionTone(decision) {
  if (decision === 'deny') return 'bad';
  if (decision === 'allow') return 'ok';
  return '';
}

function renderAuditRows(events) {
  const body = $('auditRows');
  if (!events.length) {
    body.innerHTML = '<tr><td colspan="5" class="audit-empty">No audit events match these filters.</td></tr>';
    return;
  }
  body.innerHTML = events.map((row) => {
    const when = row.created_at ? new Date(row.created_at).toLocaleString() : '—';
    const resource = [row.resource_type, row.resource_id].filter(Boolean).map(escapeHtml).join(' · ') || '—';
    return `<tr>
      <td>${escapeHtml(when)}</td>
      <td>${escapeHtml(row.actor_sub || 'anonymous')}</td>
      <td>${escapeHtml(row.action || '—')}</td>
      <td>${resource}</td>
      <td>${pill(row.decision || 'info', decisionTone(row.decision))}</td>
    </tr>`;
  }).join('');
}

async function runAuditSearch(reset = true) {
  if (reset) auditLimit = AUDIT_PAGE;
  syncAuditCsv();
  setStatePill('auditState', 'searching', 'warn');
  const params = auditQuery();
  params.set('format', 'json');
  params.set('limit', String(auditLimit));
  const payload = await optionalJson(`/api/governance/audit/export?${params.toString()}`);
  if (payload?.error) {
    setStatePill('auditState', 'error', 'bad');
    $('auditRows').innerHTML = `<tr><td colspan="5" class="audit-empty">${escapeHtml(payload.error)}</td></tr>`;
    $('auditCount').textContent = 'Audit query failed (storage may be unavailable).';
    $('auditMore').hidden = true;
    return;
  }
  const events = Array.isArray(payload?.events) ? payload.events : [];
  renderAuditRows(events);
  const capped = events.length >= auditLimit;
  setStatePill('auditState', String(events.length), events.length ? 'ok' : '');
  $('auditCount').textContent = `Showing ${events.length} event${events.length === 1 ? '' : 's'}${capped ? ` (capped at ${auditLimit})` : ''}.`;
  $('auditMore').hidden = !capped;
}

function resetAuditFilters() {
  ['auditAction', 'auditResourceType', 'auditActor', 'auditSince', 'auditUntil'].forEach((id) => {
    $(id).value = '';
  });
  $('auditDecision').value = '';
  runAuditSearch(true);
}

function wireAuditControls() {
  $('auditFilters').addEventListener('submit', (event) => {
    event.preventDefault();
    runAuditSearch(true);
  });
  $('auditReset').addEventListener('click', resetAuditFilters);
  $('auditMore').addEventListener('click', () => {
    auditLimit += AUDIT_PAGE;
    runAuditSearch(false);
  });
  ['auditAction', 'auditResourceType', 'auditActor', 'auditDecision', 'auditSince', 'auditUntil'].forEach((id) => {
    $(id).addEventListener('change', syncAuditCsv);
  });
}

function renderAll() {
  renderIdentity();
  renderControls();
  renderRls();
  renderTenants();
  renderTenantForms();
  renderTenantMembers();
  renderConnectors();
  renderApprovals();
  renderBudgets();
  renderReadiness();
}

async function loadAdmin() {
  setStatus('Loading admin posture...');
  const [whoami, posture, connectors, tenants, budgets, readiness] = await Promise.all([
    optionalJson('/api/governance/whoami'),
    optionalJson('/api/governance/posture'),
    optionalJson('/api/connectors/marketplace'),
    optionalJson('/api/tenants'),
    optionalJson('/api/llm-governance/status'),
    optionalJson('/api/governance/readiness'),
  ]);
  Object.assign(state, { whoami, posture, connectors, tenants, budgets, readiness });
  renderAll();
  const hardErrors = [whoami, posture].filter((payload) => payload?.error);
  setStatus(hardErrors.length ? 'Admin console loaded with posture warnings.' : 'Admin console ready.', hardErrors.length ? 'warn' : 'ok');
}

$('refreshAdmin').addEventListener('click', () => {
  loadAdmin();
  runAuditSearch(true);
});
wireAuditControls();
wireTenantControls();
wireConnectorControls();
loadAdmin();
runAuditSearch(true);
