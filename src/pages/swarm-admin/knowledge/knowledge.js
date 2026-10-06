/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment B (step B5-6): the shared-knowledge screen. Documents from GET
 *   | /api/rag/knowledge (an operator sees every scope; chunksTagged says whether a removal can take
 *   | the chunks, and the row and the confirm say so for a document stored before chunks carried an
 *   | id), collections from GET /api/rag/collections and the store's health from GET /api/rag/health
 *   | (a read that fails is said to have failed, never rendered as an empty store or an unreachable
 *   | one), bots named from GET /api/agents and private owners from GET /api/user-directory; filters
 *   | by text, scope and collection on the page; add by POST /api/rag/ingest (paste) or POST
 *   | /api/rag/upload (files; truncated and rejected files are named), which an operator's plain
 *   | write puts in the shared corpus; remove one document by DELETE /api/rag/knowledge/:id after a
 *   | confirm; delete a collection by DELETE /api/rag/collections/:name after typing its name; a
 *   | write in flight disables its button; every value is text; a failed load clears every section;
 *   | an outcome survives the reload that follows it.
 */

const COLS = 7;
const SCOPE_TEXT = { swarm: 'Shared corpus', bot: 'One bot', private: 'Private' };
const COLLECTION_NAME = /^[a-zA-Z0-9._-]{1,128}$/;

let documents = [];
let collections = [];
let collectionsFailed = false;
let health = null;
let loadFailed = false;
const names = { bots: new Map(), people: new Map() };
let pendingNotice = null;

/**
 * @description One request with the session; a 401 means the session has ended, a 403 that the
 * operator role is missing, and a non-JSON reply that the session has ended.
 * @param {string} url - The route.
 * @param {RequestInit} [init] - Method and body.
 * @returns {Promise<{status: number, body: Record<string, unknown>}>} The status and body.
 */
async function requestJson(url, init = {}) {
  const headers = { Accept: 'application/json', ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) };
  const response = await fetch(url, { ...init, credentials: 'same-origin', headers });
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

/** @description Shows a form's message line. */
function note(id, message, tone) {
  const line = document.getElementById(id);
  line.textContent = message;
  line.dataset.tone = tone;
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
    small.className = 'sk-sub';
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

/** @description ISO timestamp to a local short string. */
function when(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

/** @description Who a document answers for, in words. */
function scopeDetail(doc) {
  if (doc.scope === 'bot') return names.bots.get(doc.agentId) ?? doc.agentId ?? '';
  if (doc.scope === 'private') return doc.ownerSub ? (names.people.get(doc.ownerSub) ?? doc.ownerSub) : '';
  return 'every bot';
}

/**
 * @description Wraps a write: the given controls are disabled while it runs (a second click must
 * not start a second write), and a refusal is shown and the knowledge re-read.
 */
function guarded(controls, fn) {
  return async () => {
    for (const c of controls) c.disabled = true;
    try { await fn(); } catch (error) {
      pendingNotice = { message: error instanceof Error ? error.message : String(error), tone: 'error' };
      await load();
    } finally { for (const c of controls) c.disabled = false; }
  };
}

/** @description Renders the store posture strip; a health read that failed is said to have failed. */
function renderPosture() {
  const list = document.getElementById('posture');
  const items = [];
  if (health === 'failed') items.push({ text: 'The store health could not be read: whether retrieval works is unknown here.', state: 'unknown' });
  else if (health?.chromadb === 'connected') items.push({ text: 'Vector store connected.', state: 'on' });
  else items.push({ text: 'Vector store unreachable: retrieval answers nothing and nothing can be added until it is back.', state: 'off' });
  const counts = { swarm: 0, bot: 0, private: 0 };
  for (const doc of documents) counts[doc.scope] = (counts[doc.scope] ?? 0) + 1;
  items.push({ strong: String(documents.length), text: 'document(s)' });
  items.push({ strong: String(counts.swarm), text: 'in the shared corpus' });
  items.push({ strong: String(counts.bot), text: 'filed under one bot' });
  items.push({ strong: String(counts.private), text: 'private' });
  items.push(collectionsFailed ? { text: 'The collection list could not be read.', state: 'unknown' } : { strong: String(collections.length), text: 'collection(s) in the store' });
  list.replaceChildren(...items.map((item) => {
    const li = document.createElement('li');
    if (item.state) li.dataset.state = item.state;
    if (item.strong) { const s = document.createElement('strong'); s.textContent = item.strong; li.append(s); }
    li.append(document.createTextNode(item.text));
    return li;
  }));
}

/** @description Fills the collection filter from the documents and the store, keeping the choice when it still exists. */
function renderCollectionFilter() {
  const select = document.getElementById('collectionFilter');
  const current = select.value;
  const all = [...new Set([...documents.map((d) => d.collection), ...collections])].filter(Boolean).sort((a, b) => a.localeCompare(b));
  select.replaceChildren(...[['', 'All'], ...all.map((c) => [c, c])].map(([value, text]) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }));
  if (all.includes(current)) select.value = current;
}

/** @description The documents that pass the filters. */
function filtered() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  const scope = document.getElementById('scopeFilter').value;
  const collection = document.getElementById('collectionFilter').value;
  return documents.filter((d) => (!scope || d.scope === scope) && (!collection || d.collection === collection)
    && (!q || `${d.title} ${d.source} ${d.collection} ${scopeDetail(d)}`.toLowerCase().includes(q)));
}

/** @description Removes one document after a confirm that says what will go, and reloads with what happened. */
async function removeDocument(doc) {
  const who = doc.scope === 'swarm' ? 'the shared corpus' : doc.scope === 'bot' ? `the bot ${scopeDetail(doc)}` : `${scopeDetail(doc)}'s private knowledge`;
  const tagged = doc.chunksTagged !== false;
  if (!window.confirm(tagged
    ? `Remove "${doc.title}" from ${who}? Its chunks and its record go; this cannot be undone.`
    : `Remove the record of "${doc.title}" from ${who}? It was stored before chunks carried an id, so its chunks STAY in "${doc.collection}" until that collection is deleted; only the record goes.`)) return;
  say(`Removing "${doc.title}"…`, 'info');
  const { status, body } = await requestJson(`/api/rag/knowledge/${encodeURIComponent(doc.knowledgeId)}`, { method: 'DELETE' });
  if (status !== 200) throw new Error(`"${doc.title}": ${String(body.message || body.error || `the store answered ${status}`)}`);
  const chunks = body.chunksTagged ? (typeof body.chunksRemoved === 'number' ? `${body.chunksRemoved} chunk(s) removed` : 'chunks removed') : `its record removed; its chunks stay in "${doc.collection}" until that collection is deleted`;
  pendingNotice = { message: `"${doc.title}" removed: ${chunks}.`, tone: body.chunksTagged ? 'success' : 'warning' };
  await load();
}

/** @description Renders the documents table. */
function renderDocuments() {
  const tbody = document.getElementById('docs');
  if (loadFailed) { document.getElementById('count').textContent = ''; messageRow(tbody, 'The knowledge could not be read.'); return; }
  const rows = filtered();
  document.getElementById('count').textContent = `${rows.length} of ${documents.length} document(s) shown.`;
  if (!rows.length) { messageRow(tbody, documents.length ? 'No document matches these filters.' : 'No knowledge documents yet. Add to the shared corpus below.'); return; }
  tbody.replaceChildren();
  for (const doc of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = doc.knowledgeId;
    tr.append(twoLine(doc.title || '(untitled)', doc.knowledgeId));
    const scopeTd = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.dataset.scope = doc.scope;
    pill.textContent = SCOPE_TEXT[doc.scope] || String(doc.scope);
    scopeTd.append(pill);
    const detail = scopeDetail(doc);
    if (detail) { const small = document.createElement('span'); small.className = 'sk-sub'; small.textContent = detail; scopeTd.append(small); }
    tr.append(scopeTd);
    tr.append(cell(doc.collection));
    const chunksTd = twoLine(String(doc.chunkCount ?? 0), doc.chunksTagged === false ? 'stored before ids: not removable one by one' : '');
    chunksTd.className = 'num';
    if (doc.chunksTagged === false) chunksTd.dataset.untagged = 'true';
    tr.append(chunksTd);
    tr.append(cell([doc.source, doc.format].filter(Boolean).join(' · ') || '—'));
    tr.append(cell(when(doc.createdAt)));
    const actions = document.createElement('td');
    const group = document.createElement('div');
    group.className = 'sk-actions';
    const remove = button('Remove', () => undefined);
    remove.addEventListener('click', guarded([remove], () => removeDocument(doc)));
    group.append(remove);
    actions.append(group);
    tr.append(actions);
    tbody.append(tr);
  }
}

/** @description Renders the collections list with a delete per collection that asks for the name to be typed. */
function renderCollections() {
  const list = document.getElementById('collections');
  if (collectionsFailed || loadFailed) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'The collection list could not be read.';
    list.replaceChildren(li);
    return;
  }
  if (!collections.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'The store holds no collections.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...collections.map((name) => {
    const li = document.createElement('li');
    li.dataset.collection = name;
    const label = document.createElement('span');
    const inIt = documents.filter((d) => d.collection === name).length;
    label.textContent = `${name} · ${inIt} document record(s)`;
    const del = button('Delete the collection', () => undefined);
    del.addEventListener('click', guarded([del], async () => {
      const typed = window.prompt(`Delete the collection "${name}"? Every chunk in it goes, for every bot and person whose documents are in it, including chunks of documents stored before ids (a swarm-* or ambient-recall collection is the platform's own). This cannot be undone. Type the collection's name to confirm.`);
      if (typed === null) return;
      if (typed.trim() !== name) { say(`Not deleted: the name typed did not match "${name}".`, 'error'); return; }
      say(`Deleting "${name}"…`, 'info');
      const { status, body } = await requestJson(`/api/rag/collections/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (status !== 200) throw new Error(`"${name}": ${String(body.error || `the store answered ${status}`)}`);
      pendingNotice = { message: `Collection "${name}" deleted: its chunks are gone; ${inIt} document record(s) still list it and can be removed one by one.`, tone: 'success' };
      await load();
    }));
    li.append(label, del);
    return li;
  }));
}

/** @description Reads the bot and people names once per load; a failure leaves raw ids, which the banner says. */
async function loadNames() {
  const failures = [];
  try {
    const { status, body } = await requestJson('/api/agents');
    if (status !== 200) throw new Error(String(status));
    const agents = Array.isArray(body?.agents) ? body.agents : [];
    names.bots = new Map(agents.map((a) => [String(a.agentId || a.agent_id || ''), String(a.name || a.agentId || a.agent_id || '')]));
  } catch { names.bots = new Map(); failures.push('bot names'); }
  try {
    const { status, body } = await requestJson('/api/user-directory');
    if (status !== 200) throw new Error(String(status));
    const users = Array.isArray(body?.users) ? body.users : [];
    names.people = new Map(users.map((u) => [u.sub, u.label || u.email || u.sub]));
  } catch { names.people = new Map(); failures.push('the directory'); }
  return failures;
}

/** @description Loads the documents, the collections and the health, and renders everything; a failed document read clears every section. */
async function load() {
  const nameFailures = await loadNames();
  try {
    const [docs, cols, healthRes] = await Promise.all([
      requestJson('/api/rag/knowledge?limit=500'),
      requestJson('/api/rag/collections').catch(() => null),
      requestJson('/api/rag/health').catch(() => null),
    ]);
    if (docs.status !== 200) throw new Error(String(docs.body?.error || `The knowledge listing answered ${docs.status}.`));
    documents = Array.isArray(docs.body.documents) ? docs.body.documents : [];
    collectionsFailed = !cols || cols.status !== 200 || !Array.isArray(cols.body?.collections);
    collections = collectionsFailed ? [] : cols.body.collections.map(String);
    health = healthRes && healthRes.status === 200 ? healthRes.body : 'failed';
    loadFailed = false;
    renderPosture();
    renderCollectionFilter();
    renderDocuments();
    renderCollections();
    const extra = nameFailures.length ? ` Could not read ${nameFailures.join(' and ')}, so ids show instead of names.` : '';
    if (pendingNotice) { say(`${pendingNotice.message}${extra}`, pendingNotice.tone); pendingNotice = null; }
    else say(`${documents.length} document(s), ${documents.filter((d) => d.scope === 'swarm').length} in the shared corpus.${extra}`, nameFailures.length ? 'error' : 'success');
  } catch (error) {
    documents = [];
    collections = [];
    collectionsFailed = true;
    loadFailed = true;
    document.getElementById('posture').replaceChildren();
    renderCollectionFilter();
    renderDocuments();
    renderCollections();
    const failure = error instanceof Error ? error.message : String(error);
    say(pendingNotice ? `${pendingNotice.message} The knowledge could not be re-read: ${failure}` : failure, 'error');
    pendingNotice = null;
  }
}

/** @description Wires the filters, the reload and the two add forms. */
function bind() {
  let timer = null;
  document.getElementById('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(renderDocuments, 150); });
  for (const id of ['scopeFilter', 'collectionFilter']) document.getElementById(id).addEventListener('change', renderDocuments);
  document.getElementById('reload').addEventListener('click', () => { void load(); });

  const pasteForm = document.getElementById('pasteForm');
  const pasteButton = pasteForm.querySelector('button[type="submit"]');
  pasteForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pasteButton.disabled) return;
    const content = document.getElementById('pasteContent').value;
    const collection = document.getElementById('pasteCollection').value.trim();
    if (!content.trim()) { note('pasteMessage', 'Paste some text first.', 'error'); return; }
    if (!COLLECTION_NAME.test(collection)) { note('pasteMessage', 'A collection name is letters, digits, dots, dashes or underscores.', 'error'); return; }
    note('pasteMessage', 'Adding…', 'info');
    pasteButton.disabled = true;
    (async () => {
      try {
        const title = document.getElementById('pasteTitle').value.trim();
        const { status, body } = await requestJson('/api/rag/ingest', { method: 'POST', body: JSON.stringify({ format: document.getElementById('pasteFormat').value, content, collection, ...(title ? { title } : {}) }) });
        if (status !== 200) throw new Error(String(body.error || `the store answered ${status}`));
        note('pasteMessage', '', 'info');
        document.getElementById('pasteContent').value = '';
        document.getElementById('pasteTitle').value = '';
        pendingNotice = { message: `Added to the shared corpus: ${body.chunkCount ?? 0} chunk(s) in "${collection}".`, tone: 'success' };
        await load();
      } catch (error) { note('pasteMessage', error instanceof Error ? error.message : String(error), 'error'); } finally { pasteButton.disabled = false; }
    })();
  });

  const uploadForm = document.getElementById('uploadForm');
  const uploadButton = uploadForm.querySelector('button[type="submit"]');
  uploadForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (uploadButton.disabled) return;
    const input = document.getElementById('uploadFiles');
    const collection = document.getElementById('uploadCollection').value.trim();
    if (!input.files || !input.files.length) { note('uploadMessage', 'Choose at least one file.', 'error'); return; }
    if (input.files.length > 20) { note('uploadMessage', 'At most 20 files at a time.', 'error'); return; }
    if (!COLLECTION_NAME.test(collection)) { note('uploadMessage', 'A collection name is letters, digits, dots, dashes or underscores.', 'error'); return; }
    note('uploadMessage', 'Uploading…', 'info');
    uploadButton.disabled = true;
    (async () => {
      try {
        const form = new FormData();
        form.append('collection', collection);
        for (const file of input.files) form.append('files', file, file.name);
        const { status, body } = await requestJson('/api/rag/upload', { method: 'POST', body: form });
        const rejected = Array.isArray(body.rejected) ? body.rejected : [];
        const rejectedText = rejected.length ? `Not read: ${rejected.map((r) => `${r.name} (${r.reason || r.format || 'unreadable'})`).join(', ')}.` : '';
        if (status !== 200) throw new Error(`${String(body.error || `the store answered ${status}`)}${rejectedText ? ` ${rejectedText}` : ''}`);
        const truncated = Array.isArray(body.truncated) ? body.truncated : [];
        const truncatedText = truncated.length ? `Cut short (too long to store whole): ${truncated.join(', ')}.` : '';
        note('uploadMessage', [rejectedText, truncatedText].filter(Boolean).join(' '), rejectedText || truncatedText ? 'error' : 'info');
        input.value = '';
        pendingNotice = { message: `Uploaded ${Array.isArray(body.accepted) ? body.accepted.length : 0} file(s) into "${collection}": ${body.chunks ?? 0} chunk(s).${truncatedText ? ` ${truncatedText}` : ''}`, tone: truncatedText ? 'warning' : 'success' };
        await load();
      } catch (error) { note('uploadMessage', error instanceof Error ? error.message : String(error), 'error'); } finally { uploadButton.disabled = false; }
    })();
  });
}

bind();
void load();
