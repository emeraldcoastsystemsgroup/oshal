/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared shell kernel for every experience layout: the experience chooser bar, device-local pins, the application directory, application and work-item panels over live summaries, the people and provenance panels, and the Jarvis conversation engine (history + ask/result) that Studio, Jarvis, Orbit, Commons, the homebases and the central assistant all reuse instead of fixtures.
 */
(() => {
  'use strict';
  const LIVE = window.OSHAL_LIVE;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const button = (label, action, cls = 'action', data = '') => `<button type="button" class="${cls}" data-action="${action}" ${data}>${label}</button>`;
  const primary = (label, action, data = '') => button(label, action, 'action primary', data);
  const link = (label, href, cls = 'action', extra = '') => `<a class="${cls}" href="${esc(href)}" ${extra}>${label}</a>`;
  const avatar = (text, cls = 'bot') => `<span class="avatar ${cls}" aria-hidden="true">${esc(text)}</span>`;
  const badge = (text, neutral = false) => `<span class="badge${neutral ? ' neutral' : ''}">${esc(text)}</span>`;

  /** The selectable experiences. Order is the chooser order; `skin` is the palette each opens with. */
  const EXPERIENCES = [
    { id: 'studio', label: 'Studio', href: '/studio', skin: 'studio', family: 'full', tagline: 'Conversation first', palette: 'Graphite & mint' },
    { id: 'jarvis', label: 'Jarvis', href: '/jarvis', skin: 'jarvis', family: 'full', tagline: 'Assistant first', palette: 'Parchment & ember' },
    { id: 'orbit', label: 'Orbit', href: '/orbit', skin: 'orbit', family: 'full', tagline: 'Connections first', palette: 'Arctic & cobalt' },
    { id: 'commons', label: 'Commons', href: '/commons', skin: 'commons', family: 'full', tagline: 'People first', palette: 'Aubergine & lilac' },
    { id: 'family', label: 'Home · family homebase', href: '/homebase?preset=family', skin: 'family', family: 'homebase', tagline: 'Shared life, personal space', palette: 'Cozy sage' },
    { id: 'classroom', label: 'Little Monsters · classroom', href: '/homebase?preset=classroom', skin: 'classroom', family: 'homebase', tagline: 'Teacher and learner views', palette: 'Playful violet' },
    { id: 'company', label: 'Business · company swarm', href: '/homebase?preset=company', skin: 'company', family: 'homebase', tagline: 'Projects, people, workspace', palette: 'Slate & teal' },
    { id: 'nexus', label: 'Central assistant', href: '/nexus', skin: 'nexus', family: 'assistant', tagline: 'Intent first', palette: 'Luminous cyan' }
  ];
  const experienceFor = id => EXPERIENCES.find(e => e.id === id) || null;
  function currentExperience() {
    const preset = new URLSearchParams(location.search).get('preset');
    return experienceFor(preset || document.body.dataset.layout || '');
  }
  function pickerMarkup(currentId, id = 'experience-picker') {
    return `<label class="screenreader" for="${id}">Experience</label><select id="${id}" class="layout-picker" data-role="experience-picker">${EXPERIENCES.map(e => `<option value="${e.id}"${e.id === currentId ? ' selected' : ''}>${esc(e.label)}</option>`).join('')}</select>`;
  }
  function skinPicker(currentSkin) {
    const switcher = window.OSHAL_STYLE_SWITCHER;
    return switcher ? switcher.buildSelectMarkup(currentSkin || switcher.currentSkin()) : '';
  }
  /** @description Light, safe rendering of an assistant answer: escaped paragraphs, bullet lists and bold. */
  function answerHtml(text) {
    const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return String(text || '').trim().split(/\n{2,}/).filter(Boolean).map(block => {
      const lines = block.split('\n');
      if (lines.every(l => /^\s*[-*•]\s+/.test(l))) return `<ul class="artifact-steps">${lines.map(l => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('') || '<p class="muted">No answer text was returned.</p>';
  }
  const chip = h => h && typeof h.deepLink === 'string' && h.deepLink.startsWith('/') ? link(`Open ${esc(h.name || 'application')} ↗`, h.deepLink, 'mini-app') : '';
  const fileLink = f => { const url = f && (f.downloadUrl || f.url); return typeof url === 'string' && url.startsWith('/api/') ? link(`↓ ${esc(f.name || 'file')}`, url, 'quiet-link', 'download') : ''; };

  /** @description Create the per-page shell kernel over a loaded snapshot. */
  function createShell(options) {
    const snapshot = options.snapshot, layoutId = options.layoutId, hooks = options.hooks || {};
    const dialogClass = options.dialogClass || 'dialog-backdrop', drawerClass = options.drawerClass || 'drawer';
    const apps = snapshot.apps, suites = snapshot.suites, work = snapshot.work;
    const byId = id => apps.find(a => a.id === id) || null;
    const suiteOf = id => suites.find(s => s.id === id) || LIVE.SUITE_META[id] && Object.assign({ id, count: 0, apps: [] }, LIVE.SUITE_META[id]) || suites[suites.length - 1];
    const state = { modal: null, dirSuite: 'all', dirQuery: '', returnFocus: null, pins: null, summaries: new Map(), embed: false };
    const savedPins = LIVE.prefs.get('pins:' + layoutId, null);
    const busiest = s => s.apps.map(a => [a, work.filter(w => w.app === a.id).length]).sort((x, y) => y[1] - x[1] || Number(y[0].probes.length > 0) - Number(x[0].probes.length > 0))[0];
    const defaultPins = suites.map(s => (busiest(s) || [])[0] || s.spotlight).filter(a => a && a.navigable).map(a => a.id).slice(0, 6);
    state.pins = (Array.isArray(savedPins) ? savedPins : defaultPins).filter(byId);
    const savePins = () => LIVE.prefs.set('pins:' + layoutId, state.pins);
    const pinned = () => state.pins.map(byId).filter(Boolean);
    const isPinned = id => state.pins.includes(id);
    const workFor = appId => work.filter(w => w.app === appId);
    const openWork = () => work.filter(w => w.status.open);
    const attention = () => work.filter(w => ['Review', 'Escalated', 'Blocked', 'Failed'].includes(w.status.label)).concat(openWork().filter(w => !['Review', 'Escalated', 'Blocked', 'Failed'].includes(w.status.label)));
    const timeAgo = item => LIVE.relativeTime(item.at);
    let toastTimer = 0;

    const appMark = (app, cls = '') => `<span class="app-mark ${cls}" style="--suite-color:${suiteOf(app.suite).accent}" aria-hidden="true">${esc(LIVE.initials(app.name))}</span>`;
    const statusBadge = status => `<span class="badge neutral tone-${status.tone}">${esc(status.label)}</span>`;
    const miniApp = (app, action = 'open-app') => button(`${appMark(app)}<span><strong>${esc(app.name)}</strong><small>${esc(latestLine(app))}</small></span>`, action, 'mini-app', `data-app="${esc(app.id)}"`);
    function latestLine(app) {
      const latest = workFor(app.id)[0];
      if (latest) return `${latest.status.label} · ${latest.title}`;
      return app.navigable ? suiteOf(app.suite).name : 'Not available in this workspace';
    }
    const workRow = item => button(`${item.app && byId(item.app) ? appMark(byId(item.app)) : avatar(item.kind === 'task' ? 'J' : 'Q')}<span><strong>${esc(item.title)}</strong><small>${esc(item.appName)} · ${esc(item.typeLabel)} · ${esc(timeAgo(item))}</small></span><span class="work-status">${esc(item.status.label)}</span>`, 'work-item', 'work-item', `data-work="${esc(item.id)}"`);
    const artifactTile = item => button(`<span class="file-icon">${item.kind === 'task' ? 'TASK' : 'TKT'}</span><span><strong>${esc(item.title)}</strong><small>${esc(item.appName)} · ${esc(item.status.label)} · ${esc(timeAgo(item))}</small></span><span class="arrow">↗</span>`, 'work-item', 'file-tile', `data-work="${esc(item.id)}"`);

    function studyBar(caption = '') {
      const current = experienceFor(layoutId);
      return `<div class="study-bar"><div class="study-links"><a href="/cockpit/">← Cockpit</a>${pickerMarkup(current ? current.id : layoutId)}<span class="full-label">LIVE SWARM / ${apps.length} APPS</span></div><div class="study-caption">${caption}<span>${esc(snapshot.me.name)} · ${openWork().length} open · ${snapshot.botsOnline}/${snapshot.bots.length} assistants online</span>${skinPicker()}<a href="/portal">All experiences</a></div></div>`;
    }

    /** Summary section for an application panel; filled asynchronously from the app's own probes. */
    async function summaryFor(app) { return LIVE.probeSummary(app); }
    function summaryMarkup(app, summary) {
      if (!summary) return '<p class="note-line">Reading this application’s own summary…</p>';
      if (summary.none) return '<p class="note-line">This application publishes no summary. Open it for details.</p>';
      if (!summary.ok) return `<p class="note-line">Summary unavailable right now (HTTP ${summary.status || 'network'}). Nothing is assumed in its place.</p>`;
      const tiles = summary.tiles.length ? `<div class="run-strip">${summary.tiles.map(t => `<span class="tone-${t.tone}"><strong>${esc(t.value)}</strong> ${esc(t.label)}</span>`).join('')}</div>` : '';
      const items = summary.items.length ? `<ul class="artifact-steps">${summary.items.map(i => `<li class="tone-${i.tone}">${esc(i.text)}${i.detail ? `<small class="muted" style="display:block">${esc(i.detail)}</small>` : ''}</li>`).join('')}</ul>` : '';
      const foot = summary.asOf ? `<p class="note-line">As of ${esc(new Date(summary.asOf).toLocaleString())}${summary.partial ? ' · partial' : ''}</p>` : (summary.partial ? '<p class="note-line">Partial summary.</p>' : '');
      return tiles + items + foot || '<p class="note-line">Nothing to report from this application yet.</p>';
    }
    function fillSummary(app) {
      summaryFor(app).then(summary => {
        state.summaries.set(app.id, summary);
        document.querySelectorAll(`[data-summary-slot="${CSS.escape(app.id)}"]`).forEach(slot => { slot.innerHTML = summaryMarkup(app, summary); });
      });
    }

    function appPanel(id) {
      const app = byId(id); if (!app) return '<p>That application is not in your catalog.</p>';
      const suite = suiteOf(app.suite), related = app.related.map(byId).filter(Boolean), items = workFor(app.id).slice(0, 4);
      const availability = app.navigable ? 'Available in your workspace.' : app.inPlan ? 'Installed; opens through the cockpit.' : 'Installed, but not available to you in this workspace.';
      return `<div class="app-detail-header">${appMark(app)}<div><span class="eyebrow muted">${esc(suite.name)}</span><p class="app-package">${esc(app.id)}${app.version ? ` · v${esc(app.version)}` : ''}</p></div>${button(isPinned(app.id) ? '★ Pinned' : '☆ Pin app', 'pin', 'action', `data-app="${esc(app.id)}" aria-pressed="${isPinned(app.id)}"`)}</div>
<p class="app-description">${esc(app.description)}</p>
<div class="scope-callout">${availability}<small>${app.botCount} assistant${app.botCount === 1 ? '' : 's'} · ${app.toolCount} tool${app.toolCount === 1 ? '' : 's'} declared${app.theme ? ` · ${esc(app.theme)} skin` : ''}</small></div>
<h3>From the application</h3><div data-summary-slot="${esc(app.id)}">${summaryMarkup(app, state.summaries.get(app.id) || null)}</div>
${app.todos.length ? `<h3>Setup steps</h3><ol class="artifact-steps">${app.todos.map(t => `<li>${esc(t.label)}</li>`).join('')}</ol>` : ''}
${items.length ? `<h3>Recent work</h3>${items.map(workRow).join('')}` : ''}
<div class="drawer-actions">${app.navigable ? link('Open ↗', app.href, 'action primary') : ''}${app.surface && hooks.allowEmbed ? button('Open here', 'embed', 'action', `data-app="${esc(app.id)}"`) : ''}${hooks.contextAction ? button(hooks.contextAction, 'use-context', 'action', `data-app="${esc(app.id)}"`) : ''}</div>
<h3>Declared application relationships</h3><div class="dependency-list">${related.map(dep => button(`${appMark(dep)}<span>${esc(dep.name)}</span><small>Integration source</small>`, 'open-app', 'dependency-row', `data-app="${esc(dep.id)}"`)).join('') || '<p>No integration sources declared by other packages.</p>'}</div>
${(app.connectors.required || []).length || (app.connectors.optional || []).length ? `<h3>Providers</h3><p class="bot-identifiers">${esc([...(app.connectors.required || []).map(c => `${c} (required)`), ...(app.connectors.optional || [])].join(' · '))}</p>` : ''}`;
    }
    function embedPanel(id) {
      const app = byId(id); if (!app || !app.surface) return '<p>This application has no embeddable surface.</p>';
      return `<p class="note-line">${esc(app.name)} running in place. It keeps its own navigation; use Open ↗ for the full cockpit view.</p><iframe class="embed-frame" src="${esc(app.surface)}" title="${esc(app.name)}" loading="lazy"></iframe><div class="drawer-actions">${link('Open ↗', app.href, 'action primary')}</div>`;
    }
    function workPanel(id) {
      const item = work.find(w => w.id === id); if (!item) return '<p>That item is no longer in your recent work.</p>';
      const app = item.app ? byId(item.app) : null;
      const body = item.kind === 'task' ? (item.error ? `<p class="tone-warn">${esc(item.error)}</p>` : answerHtml(item.result)) : `<p>${esc(item.detail || 'No description was recorded on this ticket.')}</p>`;
      return `<div class="row between">${statusBadge(item.status)}<span class="small-label">${esc(item.appName)} · ${esc(item.typeLabel)} · ${esc(item.at ? item.at.toLocaleString() : '')}</span></div>
<h2 class="artifact-title">${esc(item.title)}</h2>${body}
${item.files.length ? `<h3>Files</h3><ul class="artifact-steps">${item.files.map(f => `<li>${fileLink(f) || esc(f.name || 'file')}</li>`).join('')}</ul>` : ''}
<div class="drawer-actions">${link(item.kind === 'task' && !item.ticketId ? 'Open in Jarvis ↗' : 'Open in cockpit ↗', item.href, 'action primary')}${app ? button(`About ${esc(app.name)}`, 'open-app', 'action', `data-app="${esc(app.id)}"`) : ''}${button('Ask Jarvis about this', 'prompt', 'action', `data-prompt="${esc(`Tell me about ${item.kind === 'task' ? 'the task' : 'ticket'} “${item.title}” (${item.ref}).`)}"`)}</div>
<p class="note-line">${item.kind === 'task' ? 'Recorded on your Jarvis shelf' : 'Recorded in the swarm ticket queue'} · ${esc(item.ref)}</p>`;
    }
    function filtered() {
      const q = state.dirQuery.toLowerCase().trim();
      return apps.filter(a => (state.dirSuite === 'all' || (state.dirSuite === 'pinned' ? isPinned(a.id) : a.suite === state.dirSuite)) && `${a.name} ${a.id} ${a.description} ${suiteOf(a.suite).name}`.toLowerCase().includes(q));
    }
    const appCard = a => `<article class="catalog-card" data-catalog-app="${esc(a.id)}"><div class="row between">${appMark(a)}${button(isPinned(a.id) ? '★' : '☆', 'pin', 'pin-button', `data-app="${esc(a.id)}" aria-label="${isPinned(a.id) ? 'Unpin' : 'Pin'} ${esc(a.name)}" aria-pressed="${isPinned(a.id)}"`)}</div>${button(`<h3>${esc(a.name)}</h3><span class="app-package">${esc(a.id)}</span><p>${esc(a.description)}</p>`, 'open-app', 'catalog-main', `data-app="${esc(a.id)}"`)}<div class="catalog-card-foot"><span>${esc(suiteOf(a.suite).name)}</span><span>${a.navigable ? (workFor(a.id)[0] ? `Latest: ${esc(workFor(a.id)[0].status.label.toLowerCase())}` : 'Available') : 'Not available here'}</span></div></article>`;
    function directoryPanel() {
      const filters = [['all', 'All apps', apps.length], ...suites.map(s => [s.id, s.name, s.count]), ['pinned', 'Pinned', state.pins.length]];
      return `<div class="directory-intro"><p>Every application installed on this swarm that you can see, with its declared suite, version and current availability to you.</p><span>${apps.length} applications · ${suites.length} suites</span></div><div class="directory-search"><span aria-hidden="true">⌕</span><label class="screenreader" for="app-search">Search all applications</label><input id="app-search" type="search" placeholder="Find an application or capability…" value="${esc(state.dirQuery)}" autocomplete="off"></div><nav class="directory-filters" aria-label="Filter applications">${filters.map(([k, n, c]) => button(`${esc(n)}<span>${c}</span>`, 'filter', 'filter-chip', `data-suite="${k}" aria-pressed="${state.dirSuite === k}"`)).join('')}</nav><div class="directory-results-head"><span id="catalog-result-count" role="status"></span><span>★ Pins are saved on this device only</span></div><div id="catalog-results" class="catalog-grid"></div><footer class="directory-foot">Membership, availability and versions come from your installed swarm. Nothing here installs, enables or grants an application. ${button('What is live here?', 'provenance', 'quiet-link')}</footer>`;
    }
    function updateDirectory() {
      const result = filtered(), host = document.getElementById('catalog-results');
      if (!host) return;
      host.innerHTML = result.map(appCard).join('') || '<p class="empty-note">No matching applications. Try another name or clear the filter.</p>';
      document.getElementById('catalog-result-count').textContent = `${result.length} of ${apps.length} applications`;
      document.querySelectorAll('[data-action="filter"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.suite === state.dirSuite)));
    }
    function workListPanel() {
      const grouped = suites.map(s => [s, work.filter(w => w.app && byId(w.app) && byId(w.app).suite === s.id)]).filter(([, items]) => items.length);
      const rest = work.filter(w => !w.app || !byId(w.app));
      return `<div class="directory-intro"><p>Your tickets in the swarm queue and the tasks on your Jarvis shelf, newest first.</p><span>${work.length} items · ${openWork().length} open</span></div><div class="work-by-suite">${grouped.map(([s, items]) => `<section><div class="section-head"><h3>${esc(s.name)}</h3><span class="small-label">${items.length} items</span></div>${items.slice(0, 12).map(workRow).join('')}</section>`).join('')}${rest.length ? `<section><div class="section-head"><h3>Assistant & queue</h3><span class="small-label">${rest.length} items</span></div>${rest.slice(0, 20).map(workRow).join('')}</section>` : ''}${work.length ? '' : '<p class="empty-note">No tickets or assistant tasks yet. Ask Jarvis for something and it will appear here.</p>'}</div>`;
    }
    function peoplePanel() {
      const bots = [...snapshot.bots].sort((a, b) => Number(b.active) - Number(a.active) || Number(b.online) - Number(a.online)).slice(0, 14);
      return `<p>People appear here when an installed application publishes membership you belong to (a classroom roster, a team workspace). This deployment does not expose a general people directory to this view.</p><h3>You</h3>${personRow(snapshot.me.initials, snapshot.me.name, snapshot.me.email || (snapshot.me.authenticated ? 'Signed in' : 'Not signed in'), 'person')}<hr class="rule"><h3>Assistants in this swarm</h3><p class="note-line">${snapshot.botsOnline} of ${snapshot.bots.length} registered assistants are online${bots.some(b => b.active) ? '; highlighted ones worked in the last two minutes' : ''}.</p>${bots.map(b => personRow(LIVE.initials(b.name), b.name, `${b.role || 'assistant'}${b.active ? ' · working now' : b.online ? ' · online' : ' · offline'}`, b.active ? 'bot active' : 'bot')).join('') || '<p class="note-line">The assistant roster is unavailable right now.</p>'}`;
    }
    const personRow = (mark, name, status, cls = 'bot') => `<div class="person-row">${avatar(mark, cls)}<span><strong>${esc(name)}</strong><small>${esc(status)}</small></span></div>`;
    function provenancePanel() {
      const s = snapshot.sources, rows = [['Signed-in identity', '/api/auth/user', s.auth], ['Authorized home plan', '/api/swarm/apps/home-plan', s.plan], ['Installed applications', '/api/swarm/apps', s.apps], ['Admitted navigation', '/api/ui/workspaces', s.workspaces], ['Your Jarvis shelf', '/api/jarvis/tasks', s.tasks], ['Your tickets', '/api/tickets', s.tickets], ['Swarm overview', '/api/jarvis/overview', s.overview]];
      return `<h3>What this screen reads</h3><dl class="provenance-facts">${rows.map(([label, path, status]) => `<dt>${esc(label)}</dt><dd><code>${esc(path)}</code> · ${status === 200 ? 'live' : `HTTP ${status || 'unreachable'}`}</dd>`).join('')}</dl><h3>What is live</h3><p>Application names, suites, versions, availability and summaries come from the packages installed on this swarm and their own summary routes, read in your session. Work items are your real tickets and Jarvis tasks. Conversations go to the same Jarvis thread the cockpit uses and are answered by the accountable assistant, not a script.</p><h3>What is not available on this deployment</h3><p>${snapshot.calendarEvents.length ? 'A shared calendar feed is present.' : 'No application contributes a shared calendar feed yet, so calendar modules show only what a package (such as a classroom) publishes.'} People appear only where an application publishes membership. Pins, skin and density choices are saved on this device and never change permissions.</p><p class="note-line">Loaded ${esc(snapshot.loadedAt.toLocaleTimeString())}${snapshot.unavailable.length ? ` · unavailable: ${esc(snapshot.unavailable.join(', '))}` : ''}</p>`;
    }

    function open(kind, id = '') {
      state.returnFocus = document.activeElement; state.modal = { kind, id }; renderModal();
    }
    function close() {
      const d = document.getElementById('full-dialog'); if (d && d.open) d.close();
      const host = document.getElementById('modal-host'); if (host) host.replaceChildren();
      const wasOpen = Boolean(state.modal); state.modal = null;
      if (wasOpen && hooks.afterClose) hooks.afterClose();
      if (state.returnFocus && state.returnFocus.isConnected) state.returnFocus.focus();
    }
    function titleFor(kind, id) {
      const titles = { directory: 'Your application swarm', app: byId(id) ? byId(id).name : 'Application', embed: byId(id) ? byId(id).name : 'Application', work: (work.find(w => w.id === id) || {}).title || 'Work item', 'work-list': 'Work across the swarm', people: 'People & assistants', provenance: 'What is live in this view' };
      return titles[kind] || (hooks.modalTitle ? hooks.modalTitle(kind, id) : '');
    }
    function contentFor(kind, id) {
      if (kind === 'directory') return directoryPanel();
      if (kind === 'app') return appPanel(id);
      if (kind === 'embed') return embedPanel(id);
      if (kind === 'work') return workPanel(id);
      if (kind === 'work-list') return workListPanel();
      if (kind === 'people') return peoplePanel();
      if (kind === 'provenance') return provenancePanel();
      return hooks.modalContent ? hooks.modalContent(kind, id) : '';
    }
    function renderModal() {
      if (!state.modal) return;
      const { kind, id } = state.modal, wide = ['directory', 'work-list', 'embed'].includes(kind);
      const host = document.getElementById('modal-host'); if (!host) return;
      host.innerHTML = `<dialog id="full-dialog" class="${dialogClass}" aria-labelledby="full-dialog-title"><section class="${drawerClass}${wide ? ' directory-panel' : ''}"><div class="drawer-head"><div><h2 id="full-dialog-title">${esc(titleFor(kind, id))}</h2>${wide ? '<p class="panel-kicker">LIVE SWARM / YOUR WORKSPACE</p>' : ''}</div>${button('×', 'close', 'icon-button', 'aria-label="Close panel"')}</div>${contentFor(kind, id)}</section></dialog>`;
      const dialog = document.getElementById('full-dialog');
      dialog.showModal();
      dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
      if (kind === 'directory') { updateDirectory(); document.getElementById('app-search').focus(); }
      if (kind === 'app' && byId(id)) fillSummary(byId(id));
    }
    function togglePin(id) {
      state.pins = isPinned(id) ? state.pins.filter(x => x !== id) : [...state.pins, id];
      savePins();
      if (state.modal && state.modal.kind === 'directory') { updateDirectory(); const chip = document.querySelector('[data-action="filter"][data-suite="pinned"] span'); if (chip) chip.textContent = state.pins.length; }
      else if (state.modal) renderModal();
      if (hooks.onPinsChanged) hooks.onPinsChanged();
    }
    /** @description Handle the actions every layout shares. Returns true when consumed. */
    function handle(action, target) {
      const id = target.dataset.app, suite = target.dataset.suite;
      if (action === 'close') { close(); return true; }
      if (action === 'directory' || action === 'suite') { state.dirSuite = suite || 'all'; state.dirQuery = ''; open('directory'); return true; }
      if (action === 'filter') { state.dirSuite = suite; updateDirectory(); return true; }
      if (action === 'pin') { togglePin(id); return true; }
      if (action === 'open-app') { open('app', id); return true; }
      if (action === 'embed') { open('embed', id); return true; }
      if (action === 'work-item') { open('work', target.dataset.work); return true; }
      if (action === 'all-work') { open('work-list'); return true; }
      if (action === 'people' || action === 'provenance') { open(action); return true; }
      return false;
    }
    function bind(root) {
      root.addEventListener('input', e => { if (e.target.id === 'app-search') { state.dirQuery = e.target.value; updateDirectory(); } });
      root.addEventListener('change', e => {
        if (e.target.dataset.role === 'experience-picker') { const exp = experienceFor(e.target.value); if (exp) location.href = exp.href; }
        if (e.target.id === 'universal-skin-picker' && window.OSHAL_STYLE_SWITCHER) window.OSHAL_STYLE_SWITCHER.applySkin(e.target.value);
      });
      document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); state.dirSuite = 'all'; state.dirQuery = ''; open('directory'); } });
    }
    function toast(text) {
      const el = document.getElementById('toast'); if (!el) return;
      el.textContent = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.textContent = ''; }, 4200);
    }

    /** Conversation engine: one thread per context, persisted on the server, rendered by the layout. */
    function createThread(sessionId, label) {
      const thread = { sessionId, label, turns: [], loaded: false, busy: false };
      thread.load = async () => {
        const r = await LIVE.packages.jarvis.history(sessionId);
        thread.turns = r.ok && r.body && Array.isArray(r.body.turns) ? r.body.turns.map(t => ({ role: t.role === 'user' ? 'user' : 'jarvis', text: t.text })) : [];
        thread.unavailable = !r.ok; thread.loaded = true; return thread;
      };
      thread.send = async (prompt, onUpdate) => {
        const text = String(prompt || '').trim(); if (!text || thread.busy) return null;
        thread.busy = true;
        thread.turns.push({ role: 'user', text });
        const pending = { role: 'jarvis', text: 'Sending to Jarvis…', pending: true }; thread.turns.push(pending); onUpdate();
        const result = await LIVE.ask(text, { sessionId: thread.explicit ? sessionId : undefined, onPhase: p => {
          if (p.phase === 'accepted') pending.text = 'Jarvis accepted the request and is working…';
          if (p.phase === 'waiting' && p.poll % 8 === 0) pending.text = `Still working (${Math.round(p.poll * 1.5)} s). Tool-using answers can take a minute.`;
          if (p.phase === 'rolled') pending.text = 'Your previous thread was not available under this sign-in; continuing in a fresh one.';
          onUpdate();
        } });
        Object.assign(pending, { pending: false, error: result.status !== 'done', text: result.status === 'done' ? (result.answer || '') : result.error, handoffs: result.handoffs || [], files: result.files || [], taskId: result.taskId || '' });
        thread.busy = false; onUpdate(); return result;
      };
      return thread;
    }
    const threadHtml = thread => thread.turns.map(t => t.role === 'user'
      ? `<div class="user-message">${esc(t.text)}</div>`
      : `<div><div class="message-header">${avatar('J')}Jarvis ${t.pending ? badge('Working', true) : t.error ? badge('Could not answer', true) : ''}</div><div class="message-content">${t.pending ? `<p class="muted">${esc(t.text)}</p>` : t.error ? `<p class="tone-warn">${esc(t.text)}</p>` : answerHtml(t.text)}${(t.handoffs || []).map(chip).join('')}${(t.files || []).map(fileLink).join('')}</div></div>`).join('');
    const threadNote = thread => thread.unavailable ? 'Earlier turns could not be loaded.' : thread.turns.length ? `${thread.turns.length} turns in this thread` : 'A new conversation. Ask anything across your swarm.';

    return { state, apps, suites, work, byId, suiteOf, pinned, isPinned, togglePin, workFor, openWork, attention, timeAgo, appMark, statusBadge, miniApp, workRow, artifactTile, personRow, studyBar, appPanel, workPanel, open, close, renderModal, handle, bind, toast, createThread, threadHtml, threadNote, summaryFor, summaryMarkup, fillSummary };
  }

  window.OSHAL_SHELL = { esc, button, primary, link, avatar, badge, chip, fileLink, answerHtml, EXPERIENCES, experienceFor, currentExperience, pickerMarkup, skinPicker, createShell };
})();
