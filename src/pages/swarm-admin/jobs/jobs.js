/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment B (step B5-9): the jobs screen. Everything from GET /api/admin/jobs:
 *   | an overview line (scheduled, running, skipped awaiting activation, paused, and the runner's
 *   | gate); one card per package service not activated, with Activate as the application (POST
 *   | /api/swarm/apps/:name/services/:id/activate, runsAs system) then a re-read, the 409
 *   | authorization_service_catalog_required refusal said in plain words, any other refusal named
 *   | by its code, and a package without a catalog said up front with the button disabled; the
 *   | scheduler's records as a table, a service route with no live activation marked skipped, a
 *   | manifest schedule (app:{app}-{id} or app-route:{app}-{id}, no per-user suffix) with Pause or
 *   | Resume through the operator's own PATCH /api/swarm/apps/:name/schedules/:id ({enabled}), its
 *   | standing override said as "paused by the operator"; the built-in timers with their gates.
 *   | Times in the viewer's locale; every value is text;
 *   | a 401 says the session ended, a 403 that the operator role is missing; a failed load clears
 *   | every section; an outcome survives the reload that follows it.
 */

const CATALOG_SENTENCE = 'This package has no authorization catalog, so its system job cannot be activated under the enforce posture.';
const EMPTY = { schedules: [], services: [], timers: [], warnings: [], scheduler: { enabled: false, pollIntervalMs: 0 } };
let data = EMPTY;
let loadFailed = false;
let pendingNotice = null;
/** Refusal text per service, kept across the re-read that follows a refusal; keyed app/scheduleId. */
const refusals = new Map();

/**
 * @description One JSON request with the session; a 401 means the session has ended, a 403 that
 * the operator role is missing, and a non-JSON reply that the session has ended.
 * @param {string} url - The route.
 * @param {RequestInit} [init] - Method and body.
 * @returns {Promise<{status: number, body: Record<string, unknown>}>} The status and body.
 */
async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, credentials: 'same-origin', headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (response.status === 401) throw new Error('Your session has ended. Sign in again.');
  if (response.status === 403 && !(response.headers.get('content-type') ?? '').includes('json')) throw new Error('Swarm Admin is for the operator role, and this session does not hold it.');
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

/** @description A <td> carrying the text in a <code>. */
function codeCell(text) {
  const td = document.createElement('td');
  const code = document.createElement('code');
  code.textContent = text;
  td.append(code);
  return td;
}

/** @description A pill with a state for the theme's tokens. */
function pill(text, state) {
  const el = document.createElement('span');
  el.className = 'pill';
  el.dataset.state = state;
  el.textContent = text;
  return el;
}

/** @description ISO timestamp to the viewer's locale with the date. */
function when(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

/** @description The owner column: the system, or a shortened subject. */
const ownerOf = (sub) => (sub ? `${String(sub).slice(0, 8)}…` : 'system');
/** @description The key a service's card and refusal are kept under. */
const keyOf = (s) => `${s.app}/${s.scheduleId}`;
/** @description The scheduler record's taskType for a service: app-route:{scheduleId}. */
const taskTypeOf = (s) => `app-route:${s.scheduleId}`;

/**
 * @description The manifest's own schedule id of a record the operator may pause or resume: a
 * service or prompt record whose taskType is app-route:{app}-{id} or app:{app}-{id} with no
 * per-user suffix, and whose app is known. Null for every other record.
 */
function manifestLocalId(j) {
  if ((j.kind !== 'service' && j.kind !== 'prompt') || !j.app) return null;
  const key = j.taskType.slice(j.taskType.indexOf(':') + 1);
  if (!key || key.includes(':') || !key.startsWith(`${j.app}-`)) return null;
  const localId = key.slice(j.app.length + 1);
  return localId || null;
}

/** @description Services by the taskType their scheduler record carries. */
function servicesByTaskType() {
  const map = new Map();
  for (const s of data.services) map.set(taskTypeOf(s), s);
  return map;
}

/** @description True when a service-kind record's app holds no live activation, so the runner skips it. */
function isSkipped(job, byTaskType) {
  const service = byTaskType.get(job.taskType);
  return Boolean(service) && service.state !== 'active';
}

/** @description The four counts of the overview. */
function counts() {
  const byTaskType = servicesByTaskType();
  const skipped = data.schedules.filter((j) => j.kind === 'service' && j.status === 'active' && isSkipped(j, byTaskType)).length;
  const paused = data.schedules.filter((j) => j.status === 'paused').length;
  const running = data.schedules.filter((j) => j.status === 'active').length - skipped;
  return { scheduled: data.schedules.length, running, skipped, paused };
}

/** @description The overview as one sentence, for the banner. */
function summaryLine() {
  const c = counts();
  return `${c.scheduled} job(s) scheduled, ${c.running} running, ${c.skipped} skipped awaiting activation, ${c.paused} paused.`;
}

/** @description A refusal in plain words: the catalog refusal by its sentence, any other by its code. */
function refusalText(status, body) {
  const code = String(body?.error || '');
  if (status === 409 && code === 'authorization_service_catalog_required') return CATALOG_SENTENCE;
  if (code) return `The swarm refused the activation: ${code.replace(/_/g, ' ')} (HTTP ${status}).`;
  return `The swarm answered ${status}.`;
}

/**
 * @description Wraps an action: the controls disabled while it runs; a refusal shown and the jobs
 * re-read, since an activation may have changed under the page.
 */
function guarded(scope, fn) {
  return async () => {
    const controls = [...scope.querySelectorAll('button')];
    for (const c of controls) c.disabled = true;
    try { await fn(); } catch (error) {
      pendingNotice = { message: error instanceof Error ? error.message : String(error), tone: 'error' };
      await load();
    } finally { for (const c of controls) c.disabled = false; }
  };
}

/** @description Activates one service as the application, then re-reads; a refusal is kept for its card. */
async function activate(service) {
  const url = `/api/swarm/apps/${encodeURIComponent(service.app)}/services/${encodeURIComponent(service.id)}/activate`;
  const { status, body } = await requestJson(url, { method: 'POST', body: JSON.stringify({ runsAs: 'system' }) });
  if (status !== 200) {
    const text = refusalText(status, body);
    refusals.set(keyOf(service), text);
    throw new Error(`${service.scheduleId}: ${text}`);
  }
  refusals.delete(keyOf(service));
  pendingNotice = { message: `${service.scheduleId} is activated as the application; the scheduler runs it from its next tick.`, tone: 'success' };
  await load();
}

/**
 * @description Turns one manifest schedule off or on through the operator's control route, which
 * stores the standing override and moves the live record at once; then re-reads.
 * @param {object} j - The scheduler record.
 * @param {string} localId - The manifest's own schedule id.
 * @param {boolean} enabled - False pauses, true resumes.
 */
async function control(j, localId, enabled) {
  const url = `/api/swarm/apps/${encodeURIComponent(j.app)}/schedules/${encodeURIComponent(localId)}`;
  const { status, body } = await requestJson(url, { method: 'PATCH', body: JSON.stringify({ enabled }) });
  if (status !== 200) {
    const code = String(body?.error || '');
    throw new Error(code ? `${j.taskType}: the swarm refused the change: ${code.replace(/_/g, ' ')} (HTTP ${status}).` : `${j.taskType}: the swarm answered ${status}.`);
  }
  pendingNotice = { message: enabled ? `${j.taskType} resumed; the scheduler runs it from its next tick.` : `${j.taskType} paused by you; the scheduler skips it until it is resumed.`, tone: 'success' };
  await load();
}

/** @description Renders one service awaiting activation. */
function renderService(s) {
  const card = document.getElementById('serviceTemplate').content.firstElementChild.cloneNode(true);
  card.dataset.key = keyOf(s);
  card.querySelector('.sj-app').textContent = s.app;
  card.querySelector('.sj-state').replaceWith(pill(s.state, s.state));
  card.querySelector('.sj-meta').textContent = `Job ${s.scheduleId} · cron ${s.cron} · proposed to run as ${s.runsAs ?? 'unclassified'}`;
  card.querySelector('.sj-requires').textContent = s.requires.length ? `Requires: ${s.requires.join(', ')}` : 'Requires no permissions.';
  const note = card.querySelector('.sj-note');
  const button = card.querySelector('.sj-activate');
  if (!s.catalog) {
    note.hidden = false;
    note.dataset.tone = 'warning';
    note.textContent = CATALOG_SENTENCE;
    button.disabled = true;
  } else if (refusals.has(keyOf(s))) {
    note.hidden = false;
    note.dataset.tone = 'error';
    note.textContent = refusals.get(keyOf(s));
  }
  button.addEventListener('click', guarded(card, () => activate(s)));
  return card;
}

/** @description Renders the overview strip. */
function renderPosture() {
  const posture = document.getElementById('posture');
  if (loadFailed) { posture.replaceChildren(); return; }
  const c = counts();
  const items = [[String(c.scheduled), 'job(s) scheduled', ''], [String(c.running), 'running', ''], [String(c.skipped), 'skipped awaiting activation', c.skipped ? 'warning' : ''], [String(c.paused), 'paused', ''], [data.scheduler.enabled ? 'on' : 'off', `scheduler runner (ENABLE_AGENT_SCHEDULER), polling every ${data.scheduler.pollIntervalMs} ms`, data.scheduler.enabled ? '' : 'warning']];
  posture.replaceChildren(...items.map(([value, label, tone]) => {
    const li = document.createElement('li');
    if (tone) li.dataset.tone = tone;
    const s = document.createElement('strong');
    s.textContent = value;
    li.append(s, document.createTextNode(label));
    return li;
  }));
}

/** @description Renders the cards of the services not activated. */
function renderActivation() {
  const host = document.getElementById('activation');
  const p = document.createElement('p');
  p.className = 'empty';
  if (loadFailed) { p.textContent = 'The jobs could not be read.'; host.replaceChildren(p); return; }
  const waiting = data.services.filter((s) => s.state !== 'active').sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  if (!waiting.length) { p.textContent = data.services.length ? 'Every declared service is activated.' : 'No active package declares a service.'; host.replaceChildren(p); return; }
  host.replaceChildren(...waiting.map(renderService));
}

/** @description Renders one scheduler record. */
function renderSchedule(j, byTaskType) {
  const tr = document.createElement('tr');
  tr.dataset.id = j.id;
  const skipped = j.kind === 'service' && isSkipped(j, byTaskType);
  tr.dataset.skipped = skipped ? 'yes' : 'no';
  tr.append(cell(j.app ?? '—'), codeCell(j.taskType), cell(j.kind), codeCell(j.cron), cell(j.timezone || 'server clock (UTC)'));
  const status = document.createElement('td');
  const group = document.createElement('span');
  group.className = 'sj-status';
  const byOperator = j.status === 'paused' && j.override && j.override.enabled === false;
  group.append(pill(byOperator ? 'paused by the operator' : j.once ? `${j.status}, once` : j.status, j.status));
  if (skipped) group.append(pill('skipped: not activated', 'skipped'));
  status.append(group);
  tr.append(status, cell(when(j.lastRunAt)), cell(when(j.nextRunAt)), cell(String(j.executionCount ?? 0), 'sj-num'), cell(ownerOf(j.ownerSub)));
  const actions = document.createElement('td');
  const localId = manifestLocalId(j);
  if (localId) {
    const paused = j.status === 'paused';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sj-control';
    button.textContent = paused ? 'Resume' : 'Pause';
    button.addEventListener('click', guarded(tr, () => control(j, localId, paused)));
    actions.append(button);
  } else {
    actions.textContent = '—';
  }
  tr.append(actions);
  return tr;
}

/** @description Renders the scheduled jobs table and its count line. */
function renderSchedules() {
  const tbody = document.querySelector('#schedules tbody');
  const count = document.getElementById('scheduleCount');
  if (loadFailed) { tbody.replaceChildren(); count.textContent = ''; return; }
  const warnings = data.warnings.length ? ` ${data.warnings.length} part(s) could not be read: ${data.warnings.map((w) => `${w.app} (${w.error})`).join(', ')}.` : '';
  count.textContent = `${data.schedules.length} job(s) in the scheduler.${warnings}`;
  if (!data.schedules.length) {
    const tr = document.createElement('tr');
    const td = cell('The scheduler holds no jobs.', 'empty');
    td.colSpan = 11;
    tr.append(td);
    tbody.replaceChildren(tr);
    return;
  }
  const byTaskType = servicesByTaskType();
  const rows = [...data.schedules].sort((a, b) => `${a.app ?? ''}/${a.taskType}`.localeCompare(`${b.app ?? ''}/${b.taskType}`));
  tbody.replaceChildren(...rows.map((j) => renderSchedule(j, byTaskType)));
}

/** @description Renders the built-in timers table. */
function renderTimers() {
  const tbody = document.querySelector('#timers tbody');
  if (loadFailed) { tbody.replaceChildren(); return; }
  tbody.replaceChildren(...data.timers.map((t) => {
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    const name = cell(t.name);
    name.title = t.description;
    const state = document.createElement('td');
    state.append(pill(t.enabled ? 'on' : 'off', t.enabled ? 'on' : 'off'));
    tr.append(name, cell(t.cadence), state, codeCell(t.flag));
    return tr;
  }));
}

/** @description Renders every section; a failed load clears them all. */
function render() {
  renderPosture();
  renderActivation();
  renderSchedules();
  renderTimers();
}

/** @description Loads the jobs and renders everything; a failed load clears every section. */
async function load() {
  try {
    const { status, body } = await requestJson('/api/admin/jobs');
    if (status === 403) throw new Error('Swarm Admin is for the operator role, and this session does not hold it.');
    if (status !== 200) throw new Error(String(body?.message || body?.error || `The jobs listing answered ${status}.`));
    const list = (value) => (Array.isArray(value) ? value : []);
    data = { schedules: list(body.schedules), services: list(body.services), timers: list(body.timers), warnings: list(body.warnings), scheduler: body.scheduler && typeof body.scheduler === 'object' ? body.scheduler : EMPTY.scheduler };
    loadFailed = false;
    render();
    if (pendingNotice) { say(pendingNotice.message, pendingNotice.tone); pendingNotice = null; }
    else say(summaryLine(), data.warnings.length ? 'error' : 'success');
  } catch (error) {
    data = EMPTY;
    loadFailed = true;
    render();
    const failure = error instanceof Error ? error.message : String(error);
    say(pendingNotice ? `${pendingNotice.message} The jobs could not be re-read: ${failure}` : failure, 'error');
    pendingNotice = null;
  }
}

/** @description Wires the reload. */
function bind() {
  document.getElementById('reload').addEventListener('click', () => { void load(); });
}

bind();
void load();
