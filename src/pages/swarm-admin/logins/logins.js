/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment B (step B5-4): the swarm logins screen. Status from GET
 *   | /api/admin/swarm-logins (no identity, no token); one card per login; import a pushed login
 *   | file (file or paste) through the vendor's own import route, sign in here for Claude Code
 *   | (start, open the link the start reply carries, paste the code), sign out with a confirm and
 *   | then say what the swarm's status really is (a sign-out can leave a login another operator
 *   | pushed, or another credential lane, in place). Every value is inserted as text; an outcome
 *   | survives the card rebuild that follows it; a refusal to adopt is said per login, exactly as
 *   | that vendor's import route decides it; a vendor's error shows its hint in plain words.
 */

const ADOPTION_NOTES = {
  'not-demo': 'Importing a login pushed from a computer is off for Claude Code, Gemini and Antigravity: this swarm is not in DEMO_MODE. Codex still imports, and Claude Code can sign in here.',
  'not-operator-subject': 'Importing a login pushed from a computer is allowed only for the subject named on OSHAL_OPERATOR_SUBS; this session is not it. Codex still imports, and Claude Code can sign in here.',
};

const ERROR_TEXT = {
  credential_distribution_disabled_pending_versioned_revocation_rail: 'This swarm refuses pushed logins: DEMO_MODE is off, or this session is not the operator subject.',
  claude_login_file_invalid: 'That is not a Claude Code login file.',
  gemini_credentials_path_read_only: 'The Gemini login location is read-only on this swarm.',
};

/**
 * @description One JSON request with the session; a non-JSON reply means the session has ended;
 * a vendor's error is shown in plain words with its hint when it carries one.
 * @param {string} url - The route.
 * @param {RequestInit} [init] - Method and body.
 * @returns {Promise<Record<string, unknown>>} The reply.
 */
async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, credentials: 'same-origin', headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (response.status === 401 || response.status === 403) throw new Error('Swarm Admin is for the operator role, and this session does not hold it.');
  if (!(response.headers.get('content-type') ?? '').includes('json')) throw new Error('Your session has ended. Sign in again.');
  const body = await response.json();
  if (!response.ok || body.success === false) {
    const code = String(body.error || '');
    const text = ERROR_TEXT[code] || code || `${url} answered ${response.status}`;
    throw new Error(body.hint ? `${text} ${String(body.hint)}` : text);
  }
  return body;
}

/**
 * @description Reads the file the operator chose, or the pasted text.
 * @param {HTMLElement} card - The card.
 * @returns {Promise<string>} The login file's contents, or ''.
 */
function readLoginFile(card) {
  const file = card.querySelector('.sl-file').files?.[0];
  if (!file) return Promise.resolve(card.querySelector('.sl-paste').value.trim());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').trim());
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}

/**
 * @description The import body the vendor's route expects: Codex reads authJson, the others credentials.
 * @param {string} id - The login id.
 * @param {string} text - The login file's contents.
 * @returns {string} The JSON body.
 */
function importBody(id, text) {
  return JSON.stringify(id === 'openai-codex' ? { authJson: text } : { credentials: text });
}

/**
 * @description Shows a message on one card.
 * @param {HTMLElement} card - The card.
 * @param {string} message - The text.
 * @param {'info'|'success'|'error'} tone - The tone.
 * @returns {void}
 */
function say(card, message, tone) {
  const line = card.querySelector('.sl-message');
  line.textContent = message;
  line.dataset.tone = tone;
}

/** @description The message to show on a login's card after the next rebuild, keyed by login id. */
const pendingNotices = new Map();

/**
 * @description Rebuilds every card from a fresh status and shows the notice saved for one of them.
 * @param {string} id - The login that acted.
 * @param {string} message - Its outcome.
 * @param {'success'|'error'|'info'} tone - The tone.
 * @returns {Promise<void>}
 */
async function refreshWithNotice(id, message, tone) {
  pendingNotices.set(id, { message, tone });
  await refresh();
}

/**
 * @description Renders one login card and wires its actions.
 * @param {object} login - One status from the API, with its own adoption standing.
 * @returns {HTMLElement} The card.
 */
function renderCard(login) {
  const card = document.getElementById('loginCardTemplate').content.firstElementChild.cloneNode(true);
  card.dataset.login = login.id;
  card.querySelector('.sl-title').textContent = login.title;
  const state = card.querySelector('.sl-state');
  const stateName = login.connected ? 'connected' : login.expired ? 'expired' : 'absent';
  state.dataset.state = stateName;
  state.textContent = stateName === 'connected' ? 'Connected' : stateName === 'expired' ? 'Expired' : 'Not connected';
  card.querySelector('.sl-detail').textContent = login.detail;
  card.querySelector('.sl-expiry').textContent = login.expiresAt ? `Expires ${new Date(login.expiresAt).toLocaleString()}.` : '';

  const actions = card.querySelector('.sl-actions');
  const importPanel = card.querySelector('.sl-import');
  const signInPanel = card.querySelector('.sl-signin');
  const button = (label, onClick) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.addEventListener('click', onClick);
    actions.append(el);
    return el;
  };

  if (login.rails.start && login.rails.submitCode) {
    button('Sign in here', async () => {
      say(card, 'Starting the sign-in…', 'info');
      try {
        const started = await requestJson(login.rails.start);
        if (started.alreadyAuthenticated) { await refreshWithNotice(login.id, 'Already signed in.', 'success'); return; }
        const link = card.querySelector('.sl-signin-link');
        if (started.authUrl) { link.href = String(started.authUrl); link.hidden = false; } else { link.hidden = true; }
        signInPanel.hidden = false;
        say(card, started.authUrl ? 'Open the sign-in link, finish there, then paste the code it gives you.' : 'The sign-in started on the server; paste the code it gives you.', 'info');
      } catch (error) { say(card, error instanceof Error ? error.message : String(error), 'error'); }
    });
    card.querySelector('.sl-code-send').addEventListener('click', async () => {
      const code = card.querySelector('.sl-code').value.trim();
      if (!code) { say(card, 'Paste the code first.', 'error'); return; }
      say(card, 'Finishing the sign-in…', 'info');
      try {
        await requestJson(login.rails.submitCode, { method: 'POST', body: JSON.stringify({ code }) });
        await refreshWithNotice(login.id, 'Signed in. Bots on this login use it from their next turn.', 'success');
      } catch (error) { say(card, error instanceof Error ? error.message : String(error), 'error'); }
    });
    card.querySelector('.sl-signin-cancel').addEventListener('click', () => { signInPanel.hidden = true; });
  }

  if (login.rails.import && login.adoption?.allowed) {
    button('Import a pushed login', () => { importPanel.hidden = false; });
    card.querySelector('.sl-import-send').addEventListener('click', async () => {
      try {
        const text = await readLoginFile(card);
        if (!text) { say(card, 'Choose the login file or paste its contents.', 'error'); return; }
        say(card, 'Importing…', 'info');
        await requestJson(login.rails.import, { method: 'POST', body: importBody(login.id, text) });
        await refreshWithNotice(login.id, 'Imported. Bots on this login use it from their next turn.', 'success');
      } catch (error) { say(card, error instanceof Error ? error.message : String(error), 'error'); }
    });
    card.querySelector('.sl-import-cancel').addEventListener('click', () => { importPanel.hidden = true; });
  } else if (login.rails.import && login.adoption && !login.adoption.allowed) {
    say(card, ADOPTION_NOTES[login.adoption.reason] ? 'Importing a pushed login is not available to this session; see the note above.' : '', 'info');
  }

  if (login.rails.signout && (login.connected || login.expired)) {
    button('Sign out', async () => {
      if (!window.confirm(`Sign out of ${login.title} for the whole swarm? Bots on this login stop working until someone signs in again.`)) return;
      say(card, 'Signing out…', 'info');
      try {
        await requestJson(login.rails.signout, { method: 'POST' });
        const after = await requestJson('/api/admin/swarm-logins');
        const still = after.logins.find((item) => item.id === login.id);
        const present = Boolean(still?.connected || still?.expired);
        await refreshWithNotice(login.id, present
          ? 'The sign-out ran, but a login is still present: it was pushed by someone else, or another credential lane is still connected.'
          : 'Signed out.', present ? 'error' : 'success');
      } catch (error) { say(card, error instanceof Error ? error.message : String(error), 'error'); }
    });
  }
  return card;
}

/**
 * @description Loads the statuses and renders the cards; a failure is shown in the banner. A notice
 * saved for a card before the rebuild is shown on its new card.
 * @returns {Promise<void>}
 */
async function refresh() {
  const banner = document.getElementById('statusBanner');
  const host = document.getElementById('loginCards');
  const note = document.getElementById('adoptionNote');
  try {
    const body = await requestJson('/api/admin/swarm-logins');
    host.replaceChildren(...body.logins.map(renderCard));
    for (const [id, notice] of pendingNotices) {
      const card = host.querySelector(`[data-login="${id}"]`);
      if (card) say(card, notice.message, notice.tone);
    }
    pendingNotices.clear();
    const refusal = body.logins.map((login) => login.adoption?.reason).find((reason) => ADOPTION_NOTES[reason]);
    note.hidden = !refusal;
    note.textContent = ADOPTION_NOTES[refusal] ?? '';
    const connected = body.logins.filter((login) => login.connected).length;
    banner.textContent = `${connected} of ${body.logins.length} swarm logins connected.`;
    banner.dataset.tone = 'success';
  } catch (error) {
    banner.textContent = error instanceof Error ? error.message : String(error);
    banner.dataset.tone = 'error';
  }
}

void refresh();
