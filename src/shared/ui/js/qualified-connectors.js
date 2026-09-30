/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Separate personal SmartThings qualified-grant metadata/consent UI; same-origin requests, fresh secret clearing, exact revision writes and no action activation or legacy fallback.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Use the established top-level OAuth navigation rail from embedded Utilities; retain native top targets without a child-frame fallback.
 */
(function () {
  'use strict';
  var root = document.getElementById('qualifiedConnectorsPanel');
  if (!root || root.dataset.qualifiedMounted) return;
  root.dataset.qualifiedMounted = 'true';
  var BASE = '/api/connect/qualified', PAGE_SIZE = 50;
  var pending = false, available = false, nextCursor = null;
  var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** @description Build text-only nodes, never interpret provider labels as markup.
   * @param {string} tag Element tag. @param {string} text Visible text. @param {string} className Styling.
   * @returns {HTMLElement} A detached element. */
  function node(tag, text, className) {
    var element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  var message = node('p', 'Loading qualified grants…', 'meta');
  message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  var refresh = node('button', 'Refresh qualified grants', 'btn ghost');
  refresh.type = 'button'; refresh.dataset.qualifiedRefresh = 'true';
  var grants = node('div'), next = node('button', 'Next page', 'btn ghost');
  next.type = 'button'; next.hidden = true;
  root.replaceChildren(message, freshForm(null), oauth(null), refresh, grants, next);

  /** @description Keep every operation single-flight, including stale-status refreshes.
   * @param {boolean} value Whether an operation is pending. @returns {void} Updates scoped controls only. */
  function setPending(value) {
    pending = value; root.setAttribute('aria-busy', String(value));
    root.querySelectorAll('button, input').forEach(function (element) {
      element.disabled = value || (!available && !element.dataset.qualifiedRefresh);
    });
    root.querySelectorAll('a[data-qualified-oauth]').forEach(function (link) {
      var disabled = value || !available;
      link.setAttribute('aria-disabled', String(disabled)); link.tabIndex = disabled ? -1 : 0;
      if (disabled) link.removeAttribute('href'); else link.setAttribute('href', link.dataset.qualifiedOauth);
    });
  }
  /** @description Remove all visible fresh secrets, including cancelled/failed navigation.
   * @returns {void} No storage or logging. */
  function clearSecrets() { root.querySelectorAll('input').forEach(function (input) { input.value = ''; }); }
  /** @description Convert response status to fixed messages without echoing raw provider/body errors.
   * @param {number} status HTTP status, or zero for unknown transport failure. @returns {string} Safe visible diagnostic. */
  function failureMessage(status) {
    if (status === 503) return 'Qualified service unavailable (503). No legacy fallback; refresh when available.';
    if (status === 401 || status === 403) return 'A verified personal sign-in is required. Qualified access is unavailable for this session.';
    if (status === 404) return 'Qualified grant or endpoint is unavailable (404). No legacy fallback.';
    if (status === 400 || status === 422) return 'The fresh token or request could not be verified. Review it before submitting again.';
    return 'Qualified request could not be confirmed. Refresh status before deciding whether to submit again.';
  }
  /** @description Use only same-origin authenticated qualified API paths, refusing redirected requests.
   * @param {string} path Internal qualified path. @param {object} options Request method/body/headers.
   * @returns {Promise<Response>} A successful response; failures expose only numeric HTTP status. */
  async function request(path, options) {
    var response = await window.fetch(path, Object.assign({}, options, {
      credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
    }));
    if (!response.ok) throw { status: response.status };
    return response;
  }
  /** @description Validate transport metadata before it can select a write URL/revision.
   * @param {object} row Server metadata. @returns {object} An explicit, credential-free snapshot. */
  function metadata(row) {
    if (!row || typeof row !== 'object' || !uuid.test(row.connectionId)
      || typeof row.provider !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(row.provider)
      || typeof row.accountKey !== 'string' || !row.accountKey || row.accountKey.length > 2048
      || /[\u0000-\u001f\u007f]/u.test(row.accountKey)
      || typeof row.revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.revision)
      || BigInt(row.revision) > 9223372036854775807n
      || !['connected', 'needs_reconnect', 'revoked'].includes(row.status)
      || (row.expiresAt !== null && (typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))))) throw { status: 0 };
    if (row.provider === 'smartthings' && (!row.accountKey.startsWith('smartthings-location:') || row.accountKey === 'smartthings-location:')) throw { status: 0 };
    return Object.freeze({ connectionId: row.connectionId, provider: row.provider, accountKey: row.accountKey,
      revision: row.revision, status: row.status, expiresAt: row.expiresAt });
  }
  /** @description Load one bounded UUID page; unrelated qualified providers never become SmartThings actions.
   * @param {string|null} after Last UUID of preceding page. @returns {Promise<void>} Rendered metadata only. */
  async function reload(after) {
    var path = BASE + '?limit=' + PAGE_SIZE + (after ? '&afterConnectionId=' + encodeURIComponent(after) : '');
    var response = await request(path, { method: 'GET', headers: { Accept: 'application/json' } });
    var data = await response.json();
    if (!data || !Array.isArray(data.connections) || data.connections.length > PAGE_SIZE) throw { status: 0 };
    var rows = data.connections.map(metadata);
    if (new Set(rows.map(function (row) { return row.connectionId.toLowerCase(); })).size !== rows.length) throw { status: 0 };
    if (after && rows.some(function (row) { return row.connectionId.toLowerCase() <= after.toLowerCase(); })) throw { status: 0 };
    nextCursor = rows.length === PAGE_SIZE ? rows[rows.length - 1].connectionId : null;
    next.hidden = nextCursor === null;
    var personal = rows.filter(function (row) { return row.provider === 'smartthings'; });
    grants.replaceChildren(); personal.forEach(function (row) { grants.appendChild(grantCard(row)); });
    if (!personal.length) grants.appendChild(node('p', 'No personal SmartThings qualified grants on this page.', 'meta'));
    available = true;
  }
  /** @description Refresh without converting absent/unavailable qualified data into legacy state.
   * @param {string|null} after Page cursor. @returns {Promise<void>} Completes one bounded read. */
  async function loadPage(after) {
    if (pending) return;
    clearSecrets(); setPending(true); message.textContent = 'Loading qualified grants…';
    try { await reload(after); message.textContent = 'Personal qualified metadata loaded. This panel does not enable or send device actions.'; }
    catch (error) { unavailable(error); }
    finally { setPending(false); }
  }
  /** @description Disable cached writes after an unavailable or invalid metadata response.
   * @param {object} error Status-only failure; no raw message is displayed. @returns {void} Visible refusal. */
  function unavailable(error) {
    available = false; nextCursor = null; next.hidden = true; grants.replaceChildren();
    message.textContent = failureMessage(error && error.status);
  }
  /** @description Persist once with the revision the human saw; stale targets are refreshed, never retried.
   * @param {string} path Qualified target. @param {object} options Exact mutation. @returns {Promise<void>} Updated metadata or refusal. */
  async function mutate(path, options) {
    if (pending || !available) return;
    clearSecrets(); setPending(true); message.textContent = 'Submitting qualified request…';
    var saved = false;
    try {
      await request(path, options); saved = true;
      await reload(null); message.textContent = 'Qualified grant updated. This panel did not enable or send device actions.';
    } catch (error) {
      if (!saved && error && (error.status === 404 || error.status === 409)) {
        try { await reload(null); message.textContent = 'Grant changed or is missing. Metadata refreshed; review and explicitly submit again. No write was retried.'; }
        catch (refreshError) { unavailable(refreshError); }
      } else if (saved) {
        unavailable(error); message.textContent = 'Request accepted, but metadata refresh is unavailable. Refresh status; do not repeat the write automatically.';
      } else {
        if (!error || ![400, 422].includes(error.status)) unavailable(error);
        else message.textContent = failureMessage(error.status);
      }
    } finally { clearSecrets(); setPending(false); }
  }
  /** @description Fresh PAT form, with no reuse, labels, account selection, storage or secret-bearing errors.
   * @param {object|null} row Stored reconnect snapshot, or null to create. @returns {HTMLFormElement} Password-only credential form. */
  function freshForm(row) {
    var form = node('form'), label = node('label', row ? 'Fresh PAT for this verified location' : 'Fresh personal SmartThings access token', 'meta');
    var input = node('input', undefined, 'tokin');
    input.id = 'qualified-pat-' + (row ? row.connectionId : 'new'); label.htmlFor = input.id;
    input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 65536;
    input.setAttribute('aria-label', label.textContent);
    var submit = node('button', row ? 'Reconnect with fresh PAT' : 'Connect fresh PAT', 'btn connect'); submit.type = 'submit';
    var fields = node('div', undefined, 'tokrow'); fields.append(input, submit); form.append(label, fields);
    form.addEventListener('submit', function (event) {
      event.preventDefault(); var token = input.value; input.value = '';
      if (pending || !available) return;
      if (!token || !token.trim() || new TextEncoder().encode(token).length > 65536) { message.textContent = 'Enter a fresh personal token (at most 65536 UTF-8 bytes).'; return; }
      var headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (row) headers['If-Match'] = '"' + row.revision + '"';
      var path = BASE + '/smartthings/' + (row ? encodeURIComponent(row.connectionId) + '/' : '') + 'token';
      var body = JSON.stringify({ token: token }); token = '';
      return mutate(path, { method: 'POST', headers: headers, body: body });
    });
    return form;
  }
  /** @description Navigate once through the server-owned browser ceremony; no fetch preflight/double ceremony.
   * @param {object|null} row Stored UUID snapshot for reconnect. @returns {HTMLAnchorElement} Same-origin authorization link. */
  function oauth(row) {
    var link = node('a', row ? 'Reconnect via OAuth' : 'Connect via OAuth', 'back');
    var path = BASE + '/smartthings/start' + (row ? '?reconnect=' + encodeURIComponent(row.connectionId) : '');
    link.dataset.qualifiedOauth = path; link.href = path; link.target = '_top';
    link.addEventListener('click', function (event) {
      event.preventDefault(); if (pending || !available) return;
      clearSecrets(); setPending(true);
      message.textContent = 'Opening registered-client OAuth. If the server returns 503, authorization is unavailable; return here. No legacy fallback.';
      try { window.top.location.href = path; }
      catch (_) { message.textContent = 'OAuth navigation could not start. No request was retried.'; setPending(false); }
    });
    return link;
  }
  /** @description Show actual metadata and exact-target repair/revoke controls, never arming a provider action.
   * @param {object} row Validated metadata snapshot. @returns {HTMLElement} Text-only grant card. */
  function grantCard(row) {
    var card = node('article', undefined, 'card col'); card.dataset.qualifiedId = row.connectionId;
    card.append(node('div', 'Verified location: ' + row.accountKey, 'name'), node('div', 'Connection: ' + row.connectionId, 'meta'),
      node('div', 'Status: ' + row.status + ' · Revision: ' + row.revision, 'meta'),
      node('div', row.expiresAt === null ? 'Expiry: unknown (not proof of validity)' : 'Expiry: ' + row.expiresAt
        + (Date.parse(row.expiresAt) <= Date.now() ? ' (expired)' : ''), 'meta'), freshForm(row), oauth(row));
    var remove = node('button', 'Revoke local grant', 'btn disconnect'); remove.type = 'button';
    remove.addEventListener('click', function () {
      if (pending || !available) return;
      clearSecrets();
      if (!window.confirm('Revoke this personal local grant for ' + row.accountKey + '? This does not revoke the token at SmartThings or send a device action.')) return;
      return mutate(BASE + '/' + encodeURIComponent(row.connectionId), { method: 'DELETE',
        headers: { Accept: 'application/json', 'If-Match': '"' + row.revision + '"' } });
    });
    card.appendChild(remove); return card;
  }
  refresh.addEventListener('click', function () { return loadPage(null); });
  next.addEventListener('click', function () { if (nextCursor) return loadPage(nextCursor); });
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) { pending = false; clearSecrets(); return loadPage(null); }
  });
  void loadPage(null);
}());
