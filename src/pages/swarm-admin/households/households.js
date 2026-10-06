/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment B (step B5-8): the households screen. Every household from GET
 *   | /api/admin/households (members, roles, and whether this operator may manage it), people
 *   | named from GET /api/user-directory; add a member (POST /api/tenants/:id/members), change a
 *   | role (PATCH .../members/:sub) or remove one after a confirm (DELETE .../members/:sub) only on
 *   | a manageable household, the others saying who manages them; create a household (POST
 *   | /api/tenants, kinds space and org as the routes keep them); an access-review link per member;
 *   | the only admin is kept (the routes refuse demoting or removing them); external-identity members
 *   | are counted; a directory that cannot be read is said; the route's own refusal text is shown and
 *   | the households re-read; every value is text; an outcome survives the reload that follows it.
 */

const names = { people: new Map(), failed: false };
/** The real kinds (tenant-routes keeps 'org' and turns anything else into 'space'), as the shell labels them. */
const KIND_TEXT = { space: 'household', org: 'team' };
const kindOf = (h) => KIND_TEXT[h.kind] || String(h.kind || 'household');
let households = [];
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

/** @description A person's directory label, or their subject. */
const nameOf = (sub) => names.people.get(sub) ?? sub;
/** @description A household's display name. */
const titleOf = (h) => h.name || `(unnamed ${kindOf(h)})`;

/** @description A <td> carrying plain text. */
function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
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

/** @description ISO timestamp to a local date. */
function when(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleDateString();
}

/**
 * @description Wraps an action: the controls disabled while it runs; a refusal shown and the
 * households re-read, since the membership may have changed under the page.
 */
function guarded(scope, fn) {
  return async () => {
    const controls = [...scope.querySelectorAll('button, select')];
    for (const c of controls) c.disabled = true;
    try { await fn(); } catch (error) {
      pendingNotice = { message: error instanceof Error ? error.message : String(error), tone: 'error' };
      await load();
    } finally { for (const c of controls) c.disabled = false; }
  };
}

/** @description One membership write through the tenants routes, then a reload with the outcome. */
async function membershipWrite(household, url, init, done) {
  const { status, body } = await requestJson(url, init);
  if (status !== 200) throw new Error(`${titleOf(household)}: ${String(body.error || `the swarm answered ${status}`)}`);
  pendingNotice = { message: done, tone: 'success' };
  await load();
}

/** @description Renders one household card. */
function renderHousehold(h) {
  const card = document.getElementById('householdTemplate').content.firstElementChild.cloneNode(true);
  card.dataset.id = h.tenantId;
  card.querySelector('.sh-name').textContent = titleOf(h);
  card.querySelector('.sh-kind').textContent = kindOf(h);
  const admins = h.members.filter((m) => m.role === 'admin').map((m) => nameOf(m.sub));
  const manage = card.querySelector('.sh-manage');
  manage.dataset.manage = h.manageable ? 'yes' : 'no';
  manage.textContent = h.manageable ? 'you manage it' : h.myRole ? 'you are a member' : admins.length ? 'managed by its admins' : 'no admin';
  const external = Number(h.externalMembers) || 0;
  card.querySelector('.sh-meta').textContent = `Created ${when(h.createdAt)}${h.createdBySub ? ` by ${nameOf(h.createdBySub)}` : ''} · ${h.members.length} member(s)${external ? ` + ${external} from an external identity provider (managed on the access screen)` : ''} · admins: ${admins.length ? admins.join(', ') : 'none'}`;
  const onlyAdmin = h.members.filter((m) => m.role === 'admin').length === 1 ? h.members.find((m) => m.role === 'admin')?.sub : null;
  const tbody = card.querySelector('tbody');
  if (!h.members.length) {
    const tr = document.createElement('tr');
    const td = cell('No members yet.', 'empty');
    td.colSpan = 4;
    tr.append(td);
    tbody.append(tr);
  }
  for (const m of h.members) {
    const tr = document.createElement('tr');
    tr.dataset.sub = m.sub;
    const who = document.createElement('td');
    who.append(document.createTextNode(nameOf(m.sub)));
    if (nameOf(m.sub) !== m.sub) { const small = document.createElement('span'); small.className = 'sh-sub'; small.textContent = m.sub; who.append(small); }
    tr.append(who);
    const roleTd = document.createElement('td');
    if (h.manageable && m.sub === onlyAdmin) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.dataset.role = 'admin';
      pill.textContent = 'admin (the only one)';
      pill.title = 'The only admin cannot be demoted or removed; make someone else admin first.';
      roleTd.append(pill);
    } else if (h.manageable) {
      const select = document.createElement('select');
      for (const role of ['admin', 'member']) { const o = document.createElement('option'); o.value = role; o.textContent = role; select.append(o); }
      select.value = m.role;
      select.addEventListener('change', guarded(card, () => membershipWrite(h, `/api/tenants/${encodeURIComponent(h.tenantId)}/members/${encodeURIComponent(m.sub)}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) }, `${titleOf(h)}: ${nameOf(m.sub)} is now ${select.value}.`)));
      roleTd.append(select);
    } else {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.dataset.role = m.role;
      pill.textContent = m.role;
      roleTd.append(pill);
    }
    tr.append(roleTd);
    tr.append(cell(when(m.joinedAt)));
    const actions = document.createElement('td');
    const group = document.createElement('div');
    group.className = 'sh-actions';
    const review = document.createElement('a');
    review.href = `/access-review?sub=${encodeURIComponent(m.sub)}`;
    review.textContent = 'Access review';
    group.append(review);
    if (h.manageable && m.sub !== onlyAdmin) {
      group.append(button('Remove', guarded(card, async () => {
        if (!window.confirm(`Remove ${nameOf(m.sub)} from ${titleOf(h)}? They lose what this household shares with its members.`)) return;
        await membershipWrite(h, `/api/tenants/${encodeURIComponent(h.tenantId)}/members/${encodeURIComponent(m.sub)}`, { method: 'DELETE' }, `${titleOf(h)}: ${nameOf(m.sub)} removed.`);
      })));
    }
    actions.append(group);
    tr.append(actions);
    tbody.append(tr);
  }
  const add = card.querySelector('.sh-add');
  const note = card.querySelector('.sh-note');
  if (h.manageable) {
    add.hidden = false;
    const select = add.elements.memberSub;
    const present = new Set(h.members.map((m) => m.sub));
    if (names.failed) select.replaceChildren(Object.assign(document.createElement('option'), { value: '', textContent: 'The directory could not be read; reload to try again' }));
    for (const [sub, label] of names.people) { if (!present.has(sub)) { const o = document.createElement('option'); o.value = sub; o.textContent = label; select.append(o); } }
    add.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!select.value) { say('Choose a person to add.', 'error'); return; }
      const role = add.elements.role.value;
      guarded(card, () => membershipWrite(h, `/api/tenants/${encodeURIComponent(h.tenantId)}/members`, { method: 'POST', body: JSON.stringify({ memberSub: select.value, role }) }, `${titleOf(h)}: ${nameOf(select.value)} added as ${role}.`))();
    });
  } else {
    note.hidden = false;
    note.textContent = admins.length ? `Managed by ${admins.join(', ')}: only a household's own admin may add or change its members from this swarm's directory.` : "This household has no admin among this swarm's members, so its directory members cannot be changed here; external-identity members are managed on the access screen.";
  }
  return card;
}

/** @description The households that pass the search. */
function filtered() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  return households.filter((h) => !q || `${titleOf(h)} ${h.members.map((m) => `${nameOf(m.sub)} ${m.sub}`).join(' ')}`.toLowerCase().includes(q));
}

/** @description Renders the overview strip and the cards. */
function render() {
  const host = document.getElementById('households');
  const posture = document.getElementById('posture');
  if (loadFailed) { posture.replaceChildren(); document.getElementById('count').textContent = ''; const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'The households could not be read.'; host.replaceChildren(p); return; }
  const items = [[String(households.length), 'household(s)'], [String(households.filter((h) => h.manageable).length), 'you manage'], [String(households.reduce((n, h) => n + h.members.length, 0)), 'membership(s) in all']];
  posture.replaceChildren(...items.map(([value, label]) => { const li = document.createElement('li'); const s = document.createElement('strong'); s.textContent = value; li.append(s, document.createTextNode(label)); return li; }));
  const rows = filtered();
  document.getElementById('count').textContent = `${rows.length} of ${households.length} household(s) shown.`;
  if (!rows.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = households.length ? 'No household matches the search.' : 'No households yet. Create one below.'; host.replaceChildren(p); return; }
  host.replaceChildren(...rows.map(renderHousehold));
}

/** @description Reads the people on every load, and remembers when the directory could not be read. */
async function loadNames() {
  try {
    const { status, body } = await requestJson('/api/user-directory');
    if (status !== 200) throw new Error(String(body?.error || status));
    const users = Array.isArray(body?.users) ? body.users : [];
    names.people = new Map(users.map((u) => [u.sub, u.label || u.email || u.sub]));
    names.failed = false;
  } catch { names.people = new Map(); names.failed = true; }
}

/** @description Loads the people and the households and renders everything; a failed load clears the cards. */
async function load() {
  await loadNames();
  try {
    const { status, body } = await requestJson('/api/admin/households');
    if (status === 403) throw new Error('Swarm Admin is for the operator role, and this session does not hold it.');
    if (status !== 200) throw new Error(String(body?.message || body?.error || `The households listing answered ${status}.`));
    households = Array.isArray(body.households) ? body.households : [];
    loadFailed = false;
    render();
    const directory = names.failed ? ' The directory could not be read, so people show by subject and adding must wait for a reload.' : '';
    if (pendingNotice) { say(`${pendingNotice.message}${directory}`, pendingNotice.tone); pendingNotice = null; }
    else say(`${households.length} household(s), ${households.filter((h) => h.manageable).length} you manage.${directory}`, names.failed ? 'error' : 'success');
  } catch (error) {
    households = [];
    loadFailed = true;
    render();
    const failure = error instanceof Error ? error.message : String(error);
    say(pendingNotice ? `${pendingNotice.message} The households could not be re-read: ${failure}` : failure, 'error');
    pendingNotice = null;
  }
}

/** @description Wires the search, the reload and the create form. */
function bind() {
  let timer = null;
  document.getElementById('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 150); });
  document.getElementById('reload').addEventListener('click', () => { void load(); });
  const form = document.getElementById('createForm');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = document.getElementById('createMessage');
    const name = document.getElementById('createName').value.trim();
    const kind = document.getElementById('createKind').value;
    if (!name) { message.textContent = 'Give the household a name.'; message.dataset.tone = 'error'; return; }
    try {
      const { status, body } = await requestJson('/api/tenants', { method: 'POST', body: JSON.stringify({ name, kind }) });
      if (status !== 200) throw new Error(String(body.error || `the swarm answered ${status}`));
      message.textContent = '';
      form.reset();
      pendingNotice = { message: `Created "${name}"; you are its admin.`, tone: 'success' };
      await load();
    } catch (error) { message.textContent = error instanceof Error ? error.message : String(error); message.dataset.tone = 'error'; }
  });
}

bind();
void load();
