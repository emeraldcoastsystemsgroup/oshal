/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment B (step B5-5): the budgets screen. The caps and the enforcement trail
 *   | come from GET /api/budgets/state (operator-only; the render logic follows the cockpit
 *   | budgets tool: text only, unknown spend shown as a dash and never as zero, the unit split named
 *   | under the figure, a used bar); people and applications are named from GET /api/user-directory
 *   | and GET /api/swarm/apps; the LLM gate and the runaway thresholds are stated from
 *   | GET /api/llm-governance/status and the state. Set, edit and switch go through POST
 *   | /api/budgets; remove through POST /api/budgets/remove after a confirm. An outcome survives the
 *   | reload that follows it.
 */

const CAP_COLS = 10;
const EVENT_COLS = 7;

/** The names behind subjects and app names, read once per load. */
const names = { people: new Map(), apps: new Map() };
/** The outcome to show once the next reload has rendered. */
let pendingNotice = null;

/**
 * @description One JSON request with the session; a non-JSON reply means the session has ended.
 * @param {string} url - The route.
 * @param {RequestInit} [init] - Method and body.
 * @returns {Promise<{status: number, body: Record<string, unknown> | null}>} The status and body.
 */
async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, credentials: 'same-origin', headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (response.status === 401 || response.status === 403) throw new Error('Swarm Admin is for the operator role, and this session does not hold it.');
  if (!(response.headers.get('content-type') ?? '').includes('json')) throw new Error('Your session has ended. Sign in again.');
  return { status: response.status, body: await response.json() };
}

/**
 * @description Shows the banner.
 * @param {string} message - The text.
 * @param {'info'|'success'|'error'} tone - The tone.
 * @returns {void}
 */
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

/** @description One full-width message row inside a table body. */
function messageRow(tbody, cols, text) {
  tbody.replaceChildren();
  const tr = document.createElement('tr');
  const td = cell(text, 'empty');
  td.colSpan = cols;
  tr.append(td);
  tbody.append(tr);
}

/** @description USD with 4 decimals, or a dash for unknown (never zero). */
function usdCell(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    const td = cell('—', 'dash');
    td.title = 'Not available: the spend store could not be read. Unknown, not zero.';
    return td;
  }
  return cell(`$${Number(value).toFixed(4)}`, 'num');
}

/** @description The spend cell, with the unit split named under the figure when the API supplied one. */
function spendCell(value, byUnit) {
  const td = usdCell(value);
  if (!byUnit || td.classList.contains('dash')) return td;
  const parts = [];
  if (Number(byUnit.billed) > 0) parts.push(`billed $${Number(byUnit.billed).toFixed(4)}`);
  if (Number(byUnit.priceEquivalent) > 0) parts.push(`price-equivalent $${Number(byUnit.priceEquivalent).toFixed(4)}`);
  if (Number(byUnit.byo) > 0 || (parts.length && Number(byUnit.byo) === 0)) parts.push(`BYO $${Number(byUnit.byo || 0).toFixed(4)} (tokens only)`);
  if (!parts.length) return td;
  const split = document.createElement('div');
  split.className = 'unit-split';
  split.textContent = parts.join(' · ');
  td.append(split);
  return td;
}

/** @description A percentage-of-cap bar; a dash when either side is unknown or the cap is 0. */
function usageCell(spend, cap) {
  const td = document.createElement('td');
  const s = Number(spend);
  const c = Number(cap);
  if (spend === null || spend === undefined || !Number.isFinite(s) || !Number.isFinite(c) || c <= 0) {
    td.className = 'dash';
    td.textContent = '—';
    return td;
  }
  const pct = (s / c) * 100;
  const bar = document.createElement('span');
  bar.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = `${Math.min(100, Math.max(0, pct)).toFixed(1)}%`;
  if (pct >= 100) fill.className = 'bad'; else if (pct >= 80) fill.className = 'warn';
  bar.append(fill);
  bar.title = `${pct.toFixed(1)}% of cap`;
  const label = document.createElement('span');
  label.className = 'num';
  label.textContent = ` ${pct.toFixed(0)}%`;
  td.append(bar, label);
  return td;
}

/** @description A bordered pill. */
function pillCell(text, cls, title) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.className = `pill${cls ? ` ${cls}` : ''}`;
  span.textContent = text;
  if (title) span.title = title;
  td.append(span);
  return td;
}

/** @description ISO timestamp to a local short string. */
function when(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

/** @description The name behind a scope key: a person's directory label, an application's title, or the key. */
function nameFor(scopeType, scopeKey) {
  if (scopeType === 'user') return names.people.get(scopeKey) ?? scopeKey;
  if (scopeType === 'app') return names.apps.get(scopeKey) ?? scopeKey;
  return scopeKey;
}

/** @description A button. */
function button(label, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

/**
 * @description Writes a cap (set, edit or switch) and reloads with the outcome.
 * @param {object} input - scopeType, scopeKey, dailyUsd, hard, enabled.
 * @param {string} done - What to say when it worked.
 * @returns {Promise<void>}
 */
async function writeCap(input, done) {
  const { status, body } = await requestJson('/api/budgets', { method: 'POST', body: JSON.stringify(input) });
  if (status !== 200 || !body || body.success === false) throw new Error(String(body?.error || `The cap write answered ${status}.`));
  pendingNotice = { message: done, tone: 'success' };
  await load();
}

/** @description Renders the caps table with their actions. */
function renderCaps(rows) {
  const tbody = document.getElementById('caps');
  if (!rows.length) { messageRow(tbody, CAP_COLS, 'No caps are set. Use "Set a cap" below.'); return; }
  tbody.replaceChildren();
  for (const b of rows) {
    const tr = document.createElement('tr');
    tr.dataset.scope = `${b.scopeType}:${b.scopeKey}`;
    tr.append(cell(String(b.scopeType ?? '')));
    const who = cell(nameFor(b.scopeType, b.scopeKey), 'wrap-cell');
    who.title = String(b.scopeKey ?? '');
    tr.append(who);
    tr.append(usdCell(b.dailyUsd));
    tr.append(spendCell(b.spendUsd, b.spendByUnit));
    tr.append(usageCell(b.spendUsd, b.dailyUsd));
    tr.append(b.hard ? pillCell('Stops work', 'hard', 'A definitive breach halts work on this scope.') : pillCell('Warns only', '', 'A breach is recorded and alerted; work continues.'));
    tr.append(b.enabled ? pillCell('On', '', 'This cap is checked.') : pillCell('Off', 'off', 'Saved but not checked: it enforces nothing while off.'));
    tr.append(cell(b.setByOperator ? 'an administrator' : 'the person'));
    tr.append(cell(when(b.updatedAt)));
    const actions = document.createElement('td');
    const group = document.createElement('div');
    group.className = 'sb-actions';
    group.append(
      button('Edit', () => openEdit(tr, b)),
      button(b.enabled ? 'Switch off' : 'Switch on', () => writeCap({ scopeType: b.scopeType, scopeKey: b.scopeKey, dailyUsd: b.dailyUsd, hard: b.hard, enabled: !b.enabled }, `${nameFor(b.scopeType, b.scopeKey)}: cap switched ${b.enabled ? 'off' : 'on'}.`).catch((error) => say(error.message, 'error'))),
      button('Remove', async () => {
        if (!window.confirm(`Remove the cap on ${nameFor(b.scopeType, b.scopeKey)}? Spend on this scope is then uncapped here.`)) return;
        try {
          const { status, body } = await requestJson('/api/budgets/remove', { method: 'POST', body: JSON.stringify({ scopeType: b.scopeType, scopeKey: b.scopeKey }) });
          if (status !== 200) throw new Error(String(body?.error || `The remove answered ${status}.`));
          pendingNotice = { message: `${nameFor(b.scopeType, b.scopeKey)}: cap removed.`, tone: 'success' };
          await load();
        } catch (error) { say(error instanceof Error ? error.message : String(error), 'error'); }
      }),
    );
    actions.append(group);
    tr.append(actions);
    tbody.append(tr);
  }
}

/** @description Opens the inline edit form under a cap's row. */
function openEdit(row, b) {
  row.parentElement.querySelectorAll('.sb-edit-row').forEach((el) => el.remove());
  const editRow = document.getElementById('editRowTemplate').content.firstElementChild.cloneNode(true);
  const form = editRow.querySelector('form');
  form.elements.dailyUsd.value = String(b.dailyUsd);
  form.elements.hard.checked = Boolean(b.hard);
  form.elements.enabled.checked = Boolean(b.enabled);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    writeCap({ scopeType: b.scopeType, scopeKey: b.scopeKey, dailyUsd: Number(form.elements.dailyUsd.value), hard: form.elements.hard.checked, enabled: form.elements.enabled.checked },
      `${nameFor(b.scopeType, b.scopeKey)}: cap saved.`).catch((error) => say(error.message, 'error'));
  });
  editRow.querySelector('.sb-edit-cancel').addEventListener('click', () => editRow.remove());
  row.after(editRow);
  form.elements.dailyUsd.focus();
}

/** @description Renders the enforcement trail. */
function renderEvents(rows) {
  const tbody = document.getElementById('events');
  if (!rows.length) { messageRow(tbody, EVENT_COLS, 'No enforcement events: nothing has breached a cap, or no cap has been checked yet.'); return; }
  tbody.replaceChildren();
  for (const e of rows) {
    const tr = document.createElement('tr');
    tr.append(cell(when(e.ts)), cell(String(e.action ?? '')), cell(String(e.scopeType ?? '')), cell(nameFor(e.scopeType, e.scopeKey), 'wrap-cell'), usdCell(e.spendUsd), usdCell(e.capUsd), cell(e.detail ? JSON.stringify(e.detail) : '—', 'wrap-cell'));
    tbody.append(tr);
  }
}

/** @description The enforcement posture strip: the env-only LLM gate and the runaway thresholds. */
function renderPosture(state, governance) {
  const list = document.getElementById('posture');
  const items = [];
  const gate = governance?.enforcement;
  if (gate) {
    items.push({ text: gate.budgets ? `Spend caps are enforced (${gate.envFlag} is on).` : `Spend caps are NOT enforced: ${gate.envFlag} is off. Caps here are recorded but no call is stopped until an operator turns that env switch on and recreates the api. This screen cannot change it.`, state: gate.budgets ? 'on' : 'off' });
  } else {
    items.push({ text: 'The LLM gate status could not be read; whether caps are enforced is unknown here.', state: 'off' });
  }
  if (state.runaway) items.push({ text: `Runaway kill switch: more than ${state.runaway.max} events in ${state.runaway.windowMin} min halts the scope (env-only).`, state: 'on' });
  if (Number.isFinite(Number(state.eventCooldownMin))) items.push({ text: `A scope's breach is reported at most once per ${state.eventCooldownMin} min.`, state: 'on' });
  list.replaceChildren(...items.map((item) => { const li = document.createElement('li'); li.textContent = item.text; li.dataset.state = item.state; return li; }));
}

/** @description Fills the person and application pickers from the directory and the app list. */
async function loadNames() {
  const person = document.getElementById('personSelect');
  const app = document.getElementById('appSelect');
  try {
    const { body } = await requestJson('/api/user-directory');
    const users = Array.isArray(body?.users) ? body.users : [];
    names.people = new Map(users.map((u) => [u.sub, u.label || u.email || u.sub]));
    person.replaceChildren(...[['', 'Choose a person'], ...users.map((u) => [u.sub, `${u.label || u.email || u.sub}`])].map(([value, text]) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }));
  } catch { person.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'The directory could not be read' })); }
  try {
    const { body } = await requestJson('/api/swarm/apps');
    const apps = Array.isArray(body?.apps) ? body.apps : [];
    names.apps = new Map(apps.map((a) => [a.name, a.displayName || a.name]));
    app.replaceChildren(...[['', 'Choose an application'], ...apps.map((a) => [a.name, `${a.displayName || a.name}${a.status ? ` (${a.status})` : ''}`])].map(([value, text]) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }));
  } catch { app.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'The applications could not be read' })); }
}

/** @description Loads the state and the governance status and renders everything. */
async function load() {
  const hours = Number(document.getElementById('windowHours').value) || 24;
  try {
    const [state, governance] = await Promise.all([
      requestJson(`/api/budgets/state?${new URLSearchParams({ windowHours: String(hours), eventLimit: '50' })}`),
      requestJson('/api/llm-governance/status').catch(() => ({ status: 0, body: null })),
    ]);
    if (state.status !== 200 || !state.body) throw new Error(String(state.body?.error || `The budget state answered ${state.status}.`));
    const budgets = Array.isArray(state.body.budgets) ? state.body.budgets : [];
    const events = Array.isArray(state.body.events) ? state.body.events : [];
    renderPosture(state.body, governance.body);
    renderCaps(budgets);
    renderEvents(events);
    const unknown = budgets.filter((b) => b.spendUsd === null || b.spendUsd === undefined).length;
    if (pendingNotice) { say(pendingNotice.message, pendingNotice.tone); pendingNotice = null; }
    else say(`${budgets.length} cap(s), ${events.length} enforcement event(s), window ${state.body.windowHours ?? hours} h${unknown ? `; spend unreadable for ${unknown} cap(s)` : ''}.`, 'success');
  } catch (error) {
    messageRow(document.getElementById('caps'), CAP_COLS, 'The caps could not be read.');
    say(error instanceof Error ? error.message : String(error), 'error');
  }
}

/** @description Wires the set-a-cap form and the toolbar. */
function bind() {
  const form = document.getElementById('setCapForm');
  const scopeType = document.getElementById('scopeType');
  const fields = { user: document.getElementById('personField'), app: document.getElementById('appField'), ticket: document.getElementById('ticketField') };
  const showScope = () => { for (const [type, field] of Object.entries(fields)) field.hidden = type !== scopeType.value; };
  scopeType.addEventListener('change', showScope);
  showScope();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = document.getElementById('setMessage');
    const type = scopeType.value;
    const scopeKey = type === 'user' ? document.getElementById('personSelect').value : type === 'app' ? document.getElementById('appSelect').value : document.getElementById('ticketInput').value.trim();
    const dailyUsd = Number(document.getElementById('dailyUsd').value);
    if (!scopeKey) { message.textContent = type === 'ticket' ? 'Enter the ticket id.' : `Choose ${type === 'user' ? 'a person' : 'an application'}.`; message.dataset.tone = 'error'; return; }
    if (!Number.isFinite(dailyUsd) || dailyUsd < 0) { message.textContent = 'Enter a cap of 0 or more USD per day.'; message.dataset.tone = 'error'; return; }
    try {
      await writeCap({ scopeType: type, scopeKey, dailyUsd, hard: document.getElementById('hard').checked, enabled: document.getElementById('enabled').checked }, `${nameFor(type, scopeKey)}: cap set to $${dailyUsd.toFixed(2)} per day.`);
      message.textContent = '';
      form.reset();
      showScope();
    } catch (error) { message.textContent = error instanceof Error ? error.message : String(error); message.dataset.tone = 'error'; }
  });
  document.getElementById('reload').addEventListener('click', () => { void load(); });
  document.getElementById('windowHours').addEventListener('change', () => { void load(); });
}

bind();
void loadNames().then(load);
