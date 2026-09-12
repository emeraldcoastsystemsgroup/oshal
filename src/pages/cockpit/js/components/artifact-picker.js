/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-139 shared source picker: session-scoped listings, bounded navigation, cancellation and owner-bound handle selection.
 */
(function () {
  'use strict';
  var active = null;
  var BASE = '/api/artifacts';

  /** @description Create text-only DOM so source labels and filenames cannot inject markup. */
  function node(tag, text) {
    var element = document.createElement(tag);
    if (text) element.textContent = text;
    return element;
  }

  /** @description Accept only canonical same-origin API paths; redirects are refused by fetch. */
  function apiPath(value) {
    if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/api/') || /[\\#\s]/.test(value)) throw new Error('The source returned an invalid file link.');
    var decoded = decodeURIComponent(value.split('?')[0]);
    if (decoded.split('/').some(function (part) { return part === '..' || part === '.'; }) || /[\\\x00-\x20]/.test(decoded)) throw new Error('The source returned an invalid file link.');
    var url = new URL(value, location.origin);
    if (url.origin !== location.origin) throw new Error('The source returned an external file link.');
    return url;
  }

  /** @description Match exact or wildcard MIME types case-insensitively. */
  function matches(glob, type) {
    glob = String(glob).toLowerCase(); type = String(type).split(';')[0].trim().toLowerCase();
    return glob === '*/*' || glob === type || (glob.endsWith('/*') && type.startsWith(glob.slice(0, -1)));
  }

  /**
   * @description Choose an existing artifact. Returns {ref,name,type,expiresAt} or null on Cancel.
   * Listings use the browser session; the source and handle endpoints enforce ownership.
   */
  window.oshalPickArtifact = function (options) {
    options = options || {};
    if (active) active();
    var accept = Array.isArray(options.accept) && options.accept.length ? options.accept : ['*/*'];
    if (!document.querySelector('link[data-artifact-picker]')) {
      var style = node('link'); style.rel = 'stylesheet'; style.href = BASE + '/picker.css';
      style.dataset.artifactPicker = ''; document.head.appendChild(style);
    }
    return new Promise(function (resolve) {
      var originalFocus = document.activeElement;
      var dialog = node('dialog'); dialog.className = 'oshal-artifact-picker';
      var heading = node('h2', options.title || 'Choose from OSHAL'); heading.id = 'oshal-artifact-picker-title';
      dialog.setAttribute('aria-labelledby', heading.id);
      var top = node('div'); top.className = 'ap-heading'; top.appendChild(heading);
      var cancel = node('button', 'Cancel'); cancel.type = 'button'; top.appendChild(cancel);
      var tabs = node('div'); tabs.className = 'ap-sources'; tabs.setAttribute('aria-label', 'File sources');
      var navigation = node('div'); navigation.className = 'ap-navigation';
      var list = node('div'); list.className = 'ap-list';
      var status = node('p', 'Loading file sources…'); status.className = 'ap-status'; status.setAttribute('role', 'status');
      dialog.append(top, tabs, navigation, list, status); document.body.appendChild(dialog);
      var source = null, stack = [], generation = 0, controller = null, closed = false;

      /** @description Close and abort in-flight work; late responses cannot select a file. */
      function finish(value) {
        if (closed) return;
        closed = true; generation++;
        if (controller) controller.abort();
        dialog.close(); dialog.remove(); active = null;
        if (originalFocus && originalFocus.isConnected) originalFocus.focus();
        resolve(value || null);
      }
      active = function () { finish(null); };
      cancel.onclick = active;
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); finish(null); });
      dialog.showModal(); cancel.focus();

      /** @description Fetch bounded JSON through the caller's session with a deadline. */
      async function json(url, init) {
        if (controller) controller.abort();
        controller = new AbortController();
        var current = controller;
        var timer = setTimeout(function () { current.abort(); }, 20000);
        try {
          var response = await fetch(apiPath(url), Object.assign({ credentials: 'same-origin', redirect: 'error', signal: current.signal }, init || {}));
          if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to choose a file.' : response.status === 403 ? 'You do not have access to these files.' : 'Could not load files (' + response.status + '). Try again.');
          if (Number(response.headers.get('content-length')) > 1048576) throw new Error('The file listing is too large.');
          var text = await response.text();
          if (text.length > 1048576) throw new Error('The file listing is too large.');
          return JSON.parse(text);
        } finally { clearTimeout(timer); }
      }

      /** @description Make an accessible list/navigation action. */
      function button(label, action, parent) {
        var b = node('button', label); b.type = 'button'; b.onclick = action; parent.appendChild(b); return b;
      }

      /** @description Mint only after an explicit file choice, using the existing handle service. */
      async function choose(item) {
        var turn = ++generation;
        status.textContent = 'Selecting ' + item.name + '…';
        list.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
        try {
          apiPath(item.source);
          var handle = await json(BASE + '/handles', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: item.source, type: item.type, name: item.name }),
          });
          if (!/^art_[\w-]+$/.test(handle.ref || '')) throw new Error('The file could not be selected.');
          if (!closed && turn === generation) finish(handle);
        } catch (error) {
          if (!closed && turn === generation) {
            status.textContent = error.name === 'AbortError' ? 'Selection timed out. Try again.' : error.message;
            list.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
          }
        }
      }

      /** @description Navigate within one registered source; stale results are discarded. */
      async function load(cursor) {
        var turn = ++generation;
        list.replaceChildren(); navigation.replaceChildren(); status.textContent = 'Loading…';
        if (stack.length) button('Back', function () { load(stack.pop()); }, navigation);
        var url = apiPath(source.list);
        if (cursor) url.searchParams.set('cursor', cursor); else url.searchParams.delete('cursor');
        try {
          var page = await json(url.pathname + url.search);
          if (closed || turn !== generation) return;
          if (!Array.isArray(page.items) || page.items.length > 100 || (page.folders !== undefined && (!Array.isArray(page.folders) || page.folders.length > 100))) throw new Error('This source returned an invalid file listing.');
          var folders = page.folders || [], hidden = 0, shown = 0;
          folders.forEach(function (folder) {
            if (typeof folder.name !== 'string' || typeof folder.cursor !== 'string' || folder.cursor.length > 4096) throw new Error('Invalid folder listing.');
            button('Folder: ' + folder.name, function () { stack.push(cursor || ''); load(folder.cursor); }, list);
          });
          page.items.forEach(function (item) {
            if (!item || typeof item.name !== 'string' || typeof item.type !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(item.type)) throw new Error('Invalid file listing.');
            apiPath(item.source);
            if (!accept.some(function (glob) { return matches(glob, item.type); }) || (options.maxBytes > 0 && item.size > options.maxBytes)) { hidden++; return; }
            shown++;
            var label = item.name;
            if (['image/heic', 'image/heif', 'image/tiff'].includes(item.type)) label += ' (may not open in this browser)';
            button(label, function () { choose(item); }, list);
          });
          if (page.nextCursor) {
            if (typeof page.nextCursor !== 'string' || page.nextCursor.length > 4096 || page.nextCursor === cursor) throw new Error('Invalid next page.');
            button('Next page', function () { stack.push(cursor || ''); load(page.nextCursor); }, navigation);
          }
          status.textContent = !shown && !folders.length ? (page.emptyMessage || 'No matching files on this page.') : '';
          if (hidden) status.textContent += ' ' + hidden + ' unsupported or oversized file' + (hidden === 1 ? '' : 's') + ' hidden.';
        } catch (error) {
          if (!closed && turn === generation) {
            list.replaceChildren();
            status.textContent = error.name === 'AbortError' ? 'Loading timed out. Try again.' : error.message;
            button('Retry', function () { load(cursor); }, list);
          }
        }
      }

      json(BASE + '/sources?type=' + encodeURIComponent(accept.length === 1 ? accept[0] : '*/*')).then(function (data) {
        if (closed) return;
        if (!Array.isArray(data.sources)) throw new Error('File sources are unavailable.');
        var sources = data.sources.filter(function (entry) {
          return Array.isArray(entry.types) && entry.types.some(function (type) { return accept.some(function (glob) { return matches(type, glob) || matches(glob, type); }); });
        });
        sources.forEach(function (entry) {
          apiPath(entry.list);
          var tab = button(entry.label || entry.app, function () {
            source = entry; stack = [];
            tabs.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === tab)); });
            load('');
          }, tabs);
          tab.setAttribute('aria-pressed', 'false');
        });
        if (sources.length) tabs.firstChild.click(); else status.textContent = 'No file sources are available for this type.';
      }).catch(function (error) { if (!closed) status.textContent = error.name === 'AbortError' ? 'Loading timed out. Close and try again.' : error.message; });
    });
  };
})();
