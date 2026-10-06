/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment B (step B5-7): the devices screen. Every remote client from GET
 *   | /api/remote-clients (an operator sees them all), the people named from GET /api/user-directory
 *   | with their email beside the name (two people can share a name); the registry never times a node
 *   | out, so a node whose last heartbeat is older than the silence threshold is called silent here
 *   | and not counted online, and 'degraded' is shown as the daemon reports it; filters by text,
 *   | binding and state on the page; bind to a person or unbind through the operator-gated POST
 *   | /:clientId/owner; rotate a node token through POST /:clientId/token/rotate (a 201) after a
 *   | confirm that says the node stops until the new token is installed on it, and show the token
 *   | once with a Copy that reports whether it copied; the route's own refusal text is shown; a
 *   | directory that cannot be read is said, not hidden; every value is text; an outcome survives
 *   | the reload that follows it.
 */

const COLS = 8;
/** A node whose last heartbeat is older than this is silent: the daemon heartbeats every 10 s by default. */
const SILENT_AFTER_MS = 90_000;
const STATE_TEXT = { online: 'online', silent: 'silent', degraded: 'degraded', offline: 'offline' };
const names = { people: new Map(), emails: new Map(), failed: false };
let devices = [];
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
  const response = await fetch(url, { ...init, credentials: 'same-origin', headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
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

/** @description A <td> with a main line and a smaller line under it. */
function twoLine(main, sub) {
  const td = document.createElement('td');
  td.append(document.createTextNode(main));
  if (sub) {
    const small = document.createElement('span');
    small.className = 'sd-sub';
    small.textContent = sub;
    td.append(small);
  }
  return td;
}

/** @description A pill with a data attribute for its colour. */
function pill(text, attr, value, title) {
  const span = document.createElement('span');
  span.className = 'pill';
  span.dataset[attr] = value;
  span.textContent = text;
  if (title) span.title = title;
  return span;
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

/** @description How long ago an ISO time was, in words. */
function ago(ts) {
  if (!ts) return 'never';
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms)) return String(ts);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** @description The device's display name: the registry stores `name`. */
const nameOf = (d) => d.name || d.clientId;
/** @description A person's label with their email when the directory has one, so namesakes can be told apart. */
const personLabel = (sub) => {
  const label = names.people.get(sub);
  if (!label) return sub;
  const email = names.emails.get(sub);
  return email && email !== label ? `${label} <${email}>` : label;
};
/** @description The person a device is bound to, by directory label, or the subject, or nobody. */
const boundTo = (d) => (d.ownerSub ? personLabel(d.ownerSub) : '');
/**
 * @description The device's state as this page tells it: the daemon's own 'offline' and 'degraded'
 * as reported; 'online' only with a fresh heartbeat, because the registry never times a node out
 * and a crashed or sleeping node keeps saying online; otherwise 'silent'.
 */
function stateOf(d) {
  if (d.status === 'offline') return 'offline';
  if (d.status === 'degraded') return 'degraded';
  const last = new Date(d.lastHeartbeatAt || d.lastSeenAt || 0).getTime();
  return Number.isFinite(last) && Date.now() - last <= SILENT_AFTER_MS ? 'online' : 'silent';
}

/**
 * @description Wraps a row action: buttons disabled while it runs; a refusal is shown and the
 * devices re-read, since the registry may have changed under the page.
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

/** @description Binds a device to a person (or to nobody) and reloads with the outcome. */
async function setOwner(device, ownerSub) {
  const { status, body } = await requestJson(`/api/remote-clients/${encodeURIComponent(device.clientId)}/owner`, { method: 'POST', body: JSON.stringify({ ownerSub }) });
  if (status < 200 || status >= 300) throw new Error(`${nameOf(device)}: ${String(body.message || body.error || `the swarm answered ${status}`)}`);
  pendingNotice = { message: ownerSub ? `${nameOf(device)}: bound to ${personLabel(ownerSub)}.` : `${nameOf(device)}: unbound; no person's own work is dispatched to it until it is bound again.`, tone: 'success' };
  await load();
}

/** @description Shows the once-returned token with a Copy that says whether it copied. */
function showToken(device, body) {
  const note = document.getElementById('tokenNote');
  note.replaceChildren();
  note.append(document.createTextNode(`New node token for ${nameOf(device)} (returned once and never again; ${Number(body.revokedCount) || 0} earlier token(s) revoked${body.expiresAt ? `, expires ${new Date(body.expiresAt).toLocaleString()}` : ''}). Install it on the node now; rotating another device replaces this note: `));
  const code = document.createElement('code');
  code.textContent = String(body.token ?? '');
  const feedback = document.createElement('span');
  feedback.className = 'sd-copy-feedback';
  note.append(code, ' ', button('Copy', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(String(body.token ?? ''));
      feedback.textContent = 'Copied.';
    } catch {
      feedback.textContent = 'Copy failed here; select the token and copy it by hand.';
    }
  }), ' ', button('Hide', () => { note.hidden = true; note.replaceChildren(); }), ' ', feedback);
  note.hidden = false;
}

/** @description Rotates a device's node token after a confirm and shows the new token once. The route answers 201. */
async function rotateToken(device) {
  if (!window.confirm(`Rotate the node token of ${nameOf(device)}? Every earlier token stops working at once, and the node stops working until someone installs the new token on it.`)) return;
  const { status, body } = await requestJson(`/api/remote-clients/${encodeURIComponent(device.clientId)}/token/rotate`, { method: 'POST' });
  if (status < 200 || status >= 300) throw new Error(`${nameOf(device)}: ${String(body.message || body.error || `the swarm answered ${status}`)}`);
  showToken(device, body);
  pendingNotice = { message: `${nameOf(device)}: node token rotated; the new token is shown below once.`, tone: 'success' };
  await load();
}

/** @description Opens the inline bind form under a device's row. */
function openBind(row, device) {
  row.parentElement.querySelectorAll('.sd-bind-row').forEach((el) => el.remove());
  const bindRow = document.getElementById('bindRowTemplate').content.firstElementChild.cloneNode(true);
  const form = bindRow.querySelector('form');
  const select = form.elements.ownerSub;
  if (names.failed) {
    select.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'The directory could not be read; reload to try again' }));
  } else {
    for (const [sub] of names.people) { const o = document.createElement('option'); o.value = sub; o.textContent = personLabel(sub); select.append(o); }
    if (device.ownerSub) select.value = device.ownerSub;
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!select.value) { say('Choose a person to bind to.', 'error'); return; }
    guarded(form, () => setOwner(device, select.value))();
  });
  bindRow.querySelector('.sd-bind-cancel').addEventListener('click', () => bindRow.remove());
  row.after(bindRow);
  select.focus();
}

/** @description The fleet strip. */
function renderPosture() {
  const list = document.getElementById('posture');
  const counts = { online: 0, silent: 0, degraded: 0, offline: 0 };
  for (const d of devices) counts[stateOf(d)] += 1;
  const unbound = devices.filter((d) => !d.ownerSub).length;
  const items = [['devices', String(devices.length), 'device(s) joined'], ['online', String(counts.online), 'online (fresh heartbeat)'], ['silent', String(counts.silent + counts.degraded + counts.offline), 'silent, degraded or offline'], ['bound', String(devices.length - unbound), 'bound to a person'], ['unbound', String(unbound), "unbound (no person's work runs there)"]];
  list.replaceChildren(...items.map(([key, value, label]) => {
    const li = document.createElement('li');
    li.dataset.key = key;
    const strong = document.createElement('strong');
    strong.textContent = value;
    li.append(strong, document.createTextNode(label));
    return li;
  }));
  const note = document.createElement('li');
  note.dataset.key = 'note';
  note.textContent = `This list is what the api holds since it last started; a node reappears within a minute of its next heartbeat. The registry never times a node out: a node that crashed or is asleep keeps reporting online, so this page calls a node silent once its last heartbeat is older than ${Math.round(SILENT_AFTER_MS / 1000)} s and does not count it online.`;
  list.append(note);
}

/** @description The devices that pass the filters. */
function filtered() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  const bound = document.getElementById('boundFilter').value;
  const state = document.getElementById('stateFilter').value;
  return devices.filter((d) => (!bound || (bound === 'bound') === Boolean(d.ownerSub)) && (!state || stateOf(d) === state)
    && (!q || `${nameOf(d)} ${d.clientId} ${d.platform ?? ''} ${boundTo(d)}`.toLowerCase().includes(q)));
}

/** @description Renders the devices table. */
function renderDevices() {
  const tbody = document.getElementById('devices');
  if (loadFailed) { document.getElementById('count').textContent = ''; messageRow(tbody, 'The devices could not be read.'); return; }
  const rows = filtered();
  document.getElementById('count').textContent = `${rows.length} of ${devices.length} device(s) shown.`;
  if (!rows.length) { messageRow(tbody, devices.length ? 'No device matches these filters.' : 'No device has joined this swarm since the api last started.'); return; }
  tbody.replaceChildren();
  for (const d of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = d.clientId;
    tr.append(twoLine(nameOf(d), d.clientId));
    tr.append(cell(String(d.platform || 'unknown')));
    const boundTd = document.createElement('td');
    boundTd.append(d.ownerSub ? pill(boundTo(d), 'bound', 'yes', d.ownerSub) : pill('Nobody', 'bound', 'no', "Unbound: no person's own work is dispatched here; operators and platform jobs can still reach it."));
    tr.append(boundTd);
    const stateTd = document.createElement('td');
    const state = stateOf(d);
    stateTd.append(pill(STATE_TEXT[state], 'state', state, state === 'silent' ? 'Still reports online, but its last heartbeat is older than the silence threshold.' : state === 'degraded' ? 'The node reported a failed task settlement or callback; dispatchers do not use a degraded node.' : undefined));
    tr.append(stateTd);
    tr.append(cell(ago(d.lastHeartbeatAt || d.lastSeenAt)));
    tr.append(twoLine(`${Number(d.taskQueueDepth) || 0} queued`, d.activeTaskId ? `running ${d.activeTaskId}` : ''));
    tr.append(cell(String(Number(d.mcpToolCount) || 0), 'num'));
    const actions = document.createElement('td');
    const group = document.createElement('div');
    group.className = 'sd-actions';
    group.append(button(d.ownerSub ? 'Rebind' : 'Bind', () => openBind(tr, d)));
    if (d.ownerSub) {
      group.append(button('Unbind', guarded(group, async () => {
        if (!window.confirm(`Unbind ${nameOf(d)} from ${boundTo(d)}? No person's own work is dispatched to it until it is bound again; operators and platform jobs can still reach it.`)) return;
        await setOwner(d, '');
      })));
      group.append(button('Rotate token', guarded(group, () => rotateToken(d))));
    }
    actions.append(group);
    tr.append(actions);
    tbody.append(tr);
  }
}

/** @description Reads the people on every load, with their emails, and remembers when the directory could not be read. */
async function loadNames() {
  try {
    const { status, body } = await requestJson('/api/user-directory');
    if (status !== 200) throw new Error(String(body?.error || status));
    const users = Array.isArray(body?.users) ? body.users : [];
    names.people = new Map(users.map((u) => [u.sub, u.label || u.email || u.sub]));
    names.emails = new Map(users.filter((u) => u.email).map((u) => [u.sub, u.email]));
    names.failed = false;
  } catch { names.people = new Map(); names.emails = new Map(); names.failed = true; }
}

/** @description Loads the people and the devices and renders everything; a failed load clears the rows. */
async function load() {
  await loadNames();
  try {
    const { status, body } = await requestJson('/api/remote-clients');
    if (status !== 200) throw new Error(String(body?.error || `The devices listing answered ${status}.`));
    devices = Array.isArray(body.clients) ? body.clients : [];
    loadFailed = false;
    renderPosture();
    renderDevices();
    const directory = names.failed ? ' The directory could not be read, so people show by subject and binding must wait for a reload.' : '';
    if (pendingNotice) { say(`${pendingNotice.message}${directory}`, pendingNotice.tone); pendingNotice = null; }
    else say(`${devices.length} device(s), ${devices.filter((d) => stateOf(d) === 'online').length} online, ${devices.filter((d) => !d.ownerSub).length} unbound.${directory}`, names.failed ? 'error' : 'success');
  } catch (error) {
    devices = [];
    loadFailed = true;
    document.getElementById('posture').replaceChildren();
    renderDevices();
    const failure = error instanceof Error ? error.message : String(error);
    say(pendingNotice ? `${pendingNotice.message} The devices could not be re-read: ${failure}` : failure, 'error');
    pendingNotice = null;
  }
}

/** @description Wires the filters and the reload. */
function bind() {
  let timer = null;
  document.getElementById('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(renderDevices, 150); });
  for (const id of ['boundFilter', 'stateFilter']) document.getElementById(id).addEventListener('change', renderDevices);
  document.getElementById('reload').addEventListener('click', () => { void load(); });
}

bind();
void load();
