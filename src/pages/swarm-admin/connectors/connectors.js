/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment B (step B5-5): the connectors screen. The catalog comes from GET
 *   | /api/connectors/marketplace (the compact summary: counts, not action lists), filtered on the
 *   | page by text (name, id, category and the descriptive tags; the machine tags such as action:*
 *   | and the HTTP methods are not searched, they match everything), state, risk and category;
 *   | enable, disable, remove and re-audit go through the operator-gated marketplace routes and
 *   | quote the tools registered or deregistered only when the connector was enabled (the route
 *   | deregisters by spec, so it names tools a never-enabled connector never had); a connector that
 *   | failed its audit gets no Enable button and its audit reasons inline (errors first, with how
 *   | many more the compact reply left out); the route's own error text is shown when it refuses
 *   | and the row is re-read, since the service writes its state before the tool step can fail; a
 *   | failed load clears the table rather than leaving stale rows behind an error banner; every
 *   | value is inserted as text; an outcome survives the reload that follows it.
 */

const COLS = 8;
const STATE_TEXT = { enabled: 'Enabled', available: 'Available', disabled: 'Disabled', removed: 'Removed', blocked: 'Blocked' };
const SCOPE_TEXT = { 'per-user': 'each person signs in', operator: 'operator-held credential', deployment: 'deployment credential', hybrid: 'deployment credential or own sign-in', none: 'no sign-in' };
/** Tags that describe every connector's mechanics rather than what it is; searching them matches the whole shelf. */
const MACHINE_TAG = /^(action|onboarding|setup|auth|method):|^(get|post|put|patch|delete|head|options)$/i;

let entries = [];
let loadFailed = false;
let pendingNotice = null;

/**
 * @description One JSON request with the session; a 401 means the session has ended, a 403 that
 * the operator role is missing, and a non-JSON reply that the session has ended.
 * @param {string} url - The route.
 * @param {RequestInit} [init] - Method and body.
 * @returns {Promise<{status: number, body: Record<string, unknown>}>} The status and body.
 */
async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (response.status === 401) throw new Error('Your session has ended. Sign in again.');
  if (response.status === 403) throw new Error('Swarm Admin is for the operator role, and this session does not hold it.');
  if (!(response.headers.get('content-type') ?? '').includes('json')) throw new Error('Your session has ended. Sign in again.');
  return { status: response.status, body: await response.json() };
}

/** @description Shows the banner. */
function say(message, tone) {
  const banner = document.getElementById('statusBanner');
  banner.textContent = message;
  banner.dataset.tone = tone;
}

/** @description A <td> carrying plain text. */
function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

/** @description A pill with a data attribute for its colour. */
function pill(text, attr, value) {
  const span = document.createElement('span');
  span.className = 'pill';
  span.dataset[attr] = value;
  span.textContent = text;
  return span;
}

/** @description A <td> with a main line and a smaller line under it. */
function twoLine(main, sub, subClass) {
  const td = document.createElement('td');
  td.append(document.createTextNode(main));
  if (sub) {
    const small = document.createElement('span');
    small.className = subClass;
    small.textContent = sub;
    td.append(small);
  }
  return td;
}

/** @description A button. */
function button(label, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

/** @description One full-width message row. */
function messageRow(tbody, text) {
  tbody.replaceChildren();
  const tr = document.createElement('tr');
  const td = cell(text, 'empty');
  td.colSpan = COLS;
  tr.append(td);
  tbody.append(tr);
}

/**
 * @description Runs one marketplace action and reloads with its outcome. The tools registered or
 * deregistered are quoted only when they were real: the route deregisters by spec, so a remove or a
 * re-audit of a connector that was never enabled names tools it never had.
 * @param {object} entry - The connector as the row showed it.
 * @param {'enable'|'disable'|'remove'|'audit-refresh'} action - The route's action.
 * @returns {Promise<void>}
 */
async function act(entry, action) {
  const name = entry.label || entry.id;
  const wasEnabled = Boolean(entry.enabled);
  say(`${name}: ${action === 'audit-refresh' ? 're-auditing' : `${action.replace(/e$/, '')}ing`}…`, 'info');
  const { status, body } = await requestJson(`/api/connectors/marketplace/${encodeURIComponent(entry.id)}/${action}`, { method: 'POST' });
  if (status !== 200 || !body || body.success === false) throw new Error(`${name}: ${String(body?.error || `the marketplace answered ${status}`)}`);
  const data = body.data ?? {};
  const registered = Array.isArray(data.registeredTools) ? data.registeredTools.length : 0;
  const deregistered = Array.isArray(data.deregisteredTools) ? data.deregisteredTools.length : 0;
  const parts = [];
  if (action === 'enable' && registered) parts.push(`${registered} tool(s) registered`);
  if (action === 'disable' && deregistered) parts.push(`${deregistered} tool(s) deregistered`);
  if ((action === 'remove' || action === 'audit-refresh') && wasEnabled && deregistered) parts.push(`${deregistered} tool(s) deregistered`);
  if (action === 'audit-refresh' && wasEnabled && registered) parts.push(`${registered} tool(s) re-registered`);
  const verb = { enable: 'enabled', disable: 'disabled', remove: 'removed from the shelf', 'audit-refresh': `re-audited: ${data.entry?.audit?.pass ? 'passes' : 'fails, so it is not enabled'}` }[action];
  pendingNotice = { message: `${name}: ${verb}${parts.length ? ` (${parts.join(', ')})` : ''}.`, tone: 'success' };
  await load();
}

/**
 * @description Wraps a row action: the row's buttons are disabled while it runs, and a refusal is
 * shown AND the catalog re-read, because the service writes its state before the tool step that
 * can fail, so the row may already be in a different state than it shows.
 * @param {HTMLElement} group - The row's button group.
 * @param {() => Promise<void>} fn - The action.
 * @returns {() => Promise<void>} The handler.
 */
function guarded(group, fn) {
  return async () => {
    const buttons = [...group.querySelectorAll('button')];
    for (const b of buttons) b.disabled = true;
    try { await fn(); } catch (error) {
      pendingNotice = { message: error instanceof Error ? error.message : String(error), tone: 'error' };
      await load();
    } finally { for (const b of buttons) b.disabled = false; }
  };
}

/** @description The totals strip: the server's state counts, and the write and tool counts computed from the rows (the summary's own are not those). */
function renderTotals(summary) {
  const totals = summary.totals ?? {};
  const writeCapable = entries.filter((e) => (Number(e.writeCount) || 0) + (Number(e.destructiveCount) || 0) > 0).length;
  const tools = entries.reduce((sum, e) => sum + (Number(e.toolCount) || 0), 0);
  const items = [
    ['entries', totals.entries ?? entries.length, 'in the catalog'], ['enabled', totals.enabled, 'enabled'], ['available', totals.available, 'available'],
    ['disabled', totals.disabled, 'disabled'], ['removed', totals.removed, 'removed'], ['blocked', totals.blocked, 'blocked by audit'],
    ['highRisk', totals.highRisk, 'high risk'], ['writeCapable', writeCapable, 'with write actions'], ['tools', tools, 'tools in all'],
  ];
  const list = document.getElementById('totals');
  list.replaceChildren(...items.map(([key, value, label]) => {
    const li = document.createElement('li');
    li.dataset.key = key;
    const strong = document.createElement('strong');
    strong.textContent = String(value ?? 0);
    li.append(strong, document.createTextNode(label));
    return li;
  }));
  const when = summary.generatedAt ? new Date(summary.generatedAt) : null;
  if (when && !Number.isNaN(when.getTime())) {
    const li = document.createElement('li');
    li.dataset.key = 'generatedAt';
    li.textContent = `catalog read ${when.toLocaleString()}`;
    list.append(li);
  }
}

/** @description Fills the category picker from the entries, keeping the current choice when it still exists. */
function renderCategories() {
  const select = document.getElementById('categoryFilter');
  const current = select.value;
  const categories = [...new Set(entries.map((e) => e.category || 'Uncategorized'))].sort((a, b) => a.localeCompare(b));
  select.replaceChildren(...[['', 'All'], ...categories.map((c) => [c, c])].map(([value, text]) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }));
  if (categories.includes(current)) select.value = current;
}

/** @description The searchable text of one entry: name, id, category and its descriptive tags. */
function searchText(e) {
  const tags = (Array.isArray(e.tags) ? e.tags : []).filter((t) => !MACHINE_TAG.test(String(t)));
  return `${e.id} ${e.label} ${e.category} ${tags.join(' ')}`.toLowerCase();
}

/** @description The entries that pass the filters. */
function filtered() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  const state = document.getElementById('stateFilter').value;
  const risk = document.getElementById('riskFilter').value;
  const category = document.getElementById('categoryFilter').value;
  return entries.filter((e) => (!state || e.installState === state) && (!risk || e.riskLevel === risk) && (!category || (e.category || 'Uncategorized') === category) && (!q || searchText(e).includes(q)));
}

/** @description The audit cell: a pill, then the reasons inline (errors first) and how many the compact reply left out. */
function auditCell(audit) {
  const td = document.createElement('td');
  const errors = Number(audit.errors) || 0;
  const warnings = Number(audit.warnings) || 0;
  const state = audit.pass === false ? 'fail' : warnings > 0 ? 'warn' : 'pass';
  td.append(pill(state === 'fail' ? `fails (${errors} error(s))` : state === 'warn' ? `passes, ${warnings} warning(s)` : 'passes', 'audit', state));
  const issues = (Array.isArray(audit.issues) ? audit.issues : []).map((i) => (typeof i === 'string' ? { level: 'warn', message: i } : { level: String(i?.level || i?.severity || 'warn'), message: String(i?.message || i?.code || JSON.stringify(i)) }));
  issues.sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1));
  if (issues.length) {
    const list = document.createElement('ul');
    list.className = 'sc-issues';
    list.replaceChildren(...issues.map((i) => { const li = document.createElement('li'); li.dataset.level = i.level; li.textContent = `${i.level}: ${i.message}`; return li; }));
    const more = errors + warnings - issues.length;
    if (more > 0) { const li = document.createElement('li'); li.className = 'sc-more'; li.textContent = `+${more} more`; list.append(li); }
    td.append(list);
  }
  return td;
}

/** @description Renders the catalog table from the filtered entries. */
function renderCatalog() {
  const tbody = document.getElementById('catalog');
  if (loadFailed) { document.getElementById('count').textContent = ''; messageRow(tbody, 'The catalog could not be read.'); return; }
  const rows = filtered();
  document.getElementById('count').textContent = `${rows.length} of ${entries.length} connector(s) shown.`;
  if (!rows.length) { messageRow(tbody, entries.length ? 'No connector matches these filters.' : 'The catalog is empty: no connector specs are installed.'); return; }
  tbody.replaceChildren();
  for (const e of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = e.id;
    tr.append(twoLine(e.label || e.id, e.id, 'sc-id'));
    tr.append(cell(e.category || 'Uncategorized'));
    tr.append(twoLine(e.onboarding?.label || e.authType || '—', SCOPE_TEXT[e.onboarding?.credentialScope] || e.onboarding?.credentialScope || '', 'sc-sub'));
    const riskTd = document.createElement('td');
    riskTd.append(pill(e.riskLevel || 'unknown', 'risk', e.riskLevel || 'unknown'));
    tr.append(riskTd);
    tr.append(twoLine(String(e.toolCount ?? 0), `${e.readCount ?? 0} read · ${e.writeCount ?? 0} write · ${e.destructiveCount ?? 0} destructive`, 'sc-sub'));
    const audit = e.audit ?? {};
    tr.append(auditCell(audit));
    const stateTd = document.createElement('td');
    stateTd.append(pill(STATE_TEXT[e.installState] || String(e.installState || 'unknown'), 'state', e.installState || 'unknown'));
    tr.append(stateTd);
    const actions = document.createElement('td');
    const group = document.createElement('div');
    group.className = 'sc-actions';
    if (e.enabled) group.append(button('Disable', guarded(group, () => act(e, 'disable'))));
    else if (audit.pass === false) { const why = document.createElement('span'); why.className = 'sc-why'; why.textContent = 'Fix the audit before enabling.'; group.append(why); }
    else group.append(button('Enable', guarded(group, () => act(e, 'enable'))));
    if (e.installState !== 'removed') group.append(button('Remove', guarded(group, async () => {
      if (!window.confirm(`Remove ${e.label || e.id} from the shelf? Its tools are deregistered and no one here can use it until an operator enables it again.`)) return;
      await act(e, 'remove');
    })));
    group.append(button('Re-audit', guarded(group, () => act(e, 'audit-refresh'))));
    actions.append(group);
    tr.append(actions);
    tbody.append(tr);
  }
}

/** @description Loads the catalog and renders everything; a failed load clears the rows rather than leaving stale ones. */
async function load() {
  try {
    const { status, body } = await requestJson('/api/connectors/marketplace');
    if (status !== 200 || !body || body.success === false) throw new Error(String(body?.error || `The marketplace answered ${status}.`));
    const summary = body.data ?? {};
    entries = Array.isArray(summary.entries) ? summary.entries : [];
    loadFailed = false;
    renderTotals(summary);
    renderCategories();
    renderCatalog();
    if (pendingNotice) { say(pendingNotice.message, pendingNotice.tone); pendingNotice = null; }
    else say(`${summary.totals?.enabled ?? 0} of ${entries.length} connector(s) enabled.`, 'success');
  } catch (error) {
    entries = [];
    loadFailed = true;
    document.getElementById('totals').replaceChildren();
    renderCatalog();
    const failure = error instanceof Error ? error.message : String(error);
    say(pendingNotice ? `${pendingNotice.message} The catalog could not be re-read: ${failure}` : failure, 'error');
    pendingNotice = null;
  }
}

/** @description Wires the filters and the reload. */
function bind() {
  let timer = null;
  document.getElementById('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(renderCatalog, 150); });
  for (const id of ['stateFilter', 'riskFilter', 'categoryFilter']) document.getElementById(id).addEventListener('change', renderCatalog);
  document.getElementById('reload').addEventListener('click', () => { void load(); });
}

bind();
void load();
