/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Studio, Jarvis, Orbit and Commons shells rendered over the live swarm: installed applications and suites, the caller's tickets and Jarvis tasks, per-app summaries, device-local pins and the real Jarvis thread (Commons keeps one thread per room). The prototype's scene picker, example people, sample replies and hardcoded launch map are gone; every count, name and status on screen comes from the signed-in session.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Each layout hosts applications with its audience (studio, orbit and commons ask for company, Jarvis for family) through the shell's shared helper and Summary view / Full application switch; the Studio selected-workspace aside and the Orbit inspector list declared assistants and member / Required / Optional relationships from the package record instead of calling everything an integration source; the Commons Game room uses the shell's shared games predicate; Commons shows the swarm roster (or the caller alone when the directory refuses) as a roster, not room membership; the Jarvis aside renders agenda rows from the overview calendar feed plus the caller's Little Monsters calendar when that package is installed, naming each source and its empty or refused state.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Integration review: the Jarvis agenda no longer provisions a Little Monsters learner. The calendar route resolves the caller without readOnly (it can create or link a learner row), so the package's read-only home-summary probe is read first and the calendar only when that probe answers 200; a 403/404 probe says to open Little Monsters once and sends no /api/education request. Agenda copy names the source as the Little Monsters calendar (classes and personal events) and an absent package as not in your catalog. The Orbit inspector lists the declared assistants beside its relationships, as the Studio aside does.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Acceptance fixes: a Little Monsters entry the caller's plan does not admit is not available to them, so the agenda sends neither the probe nor a calendar read and says so, instead of "could not be checked (HTTP unreachable)" (a listed-only entry has no probe). A probe refusal is named from its code: an application-authorization refusal reads "not available to you", the package's no-school-profile refusal says to open Little Monsters once to set up the profile, anything else could not be checked. Class event dates come through LIVE.calendarDay (they were already read as local days; the helper is now the one rule for date-only fields).
 * 5 | maintainer@emeraldcoastsystemsgroup.com | The briefing sentence and the Commons work board read the shared status groups: approval gates and customer actions count as needing you and sit in Review, every in_process_* phase and an approved ticket waiting for the queue sit in Working (they had no column and vanished from the board).
 * 6 | maintainer@emeraldcoastsystemsgroup.com | The four layouts opt in to the shell's work panels (workflow progress and stages, Approve, Cancel) and re-render when an action changes the caller's work; Studio's running rows carry the indeterminate bar for Working items.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | The Jarvis rail's Routines opens the Routines panel in place (the caller's schedules with their switches and the Workflow Studio definitions) instead of leaving for Workflow Studio, which the panel links.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Day focus across the four layouts (the demo's workday / evening selector over real data): work, briefings and streams list the focus's suites first and drop nothing; the headings, the Studio opening question and the Jarvis briefing speak to the part of the day; in the evening Jarvis offers 'What can I play tonight?' naming the installed games; Orbit rings the focus's suites; a change selects an application of the focus and moves Commons to the Game room (or Home & life) and back. A notice now survives the re-render an async read triggers right after it.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Visual cards in place of the demo's mini visuals: Studio's selected workspace (unless the application runs in place), Orbit's inspector and the Commons Game room picture the application with its latest work; Finance draws the caller's monthly spend.
 * 10 | maintainer@emeraldcoastsystemsgroup.com | A related application in Studio's selected workspace becomes the context, and in Orbit's inspector it opens its own suite and inspector (the demo's cross-suite follow). Orbit seats six suites at the demo's positions, clear of the legend the computed circle covered. The Commons Applications tab uses the shared catalog card with its pin; a pin changed there re-renders at once and keeps focus.
 * 11 | maintainer@emeraldcoastsystemsgroup.com | Commons names the caller's team or household as its workspace (else '<name>'s swarm'), seats up to three fellow members beside the caller and Jarvis in the room header, and lists the members by role, the caller with their own place, above the swarm roster. Membership, not presence: nobody else's availability or place is shown.
 * 12 | maintainer@emeraldcoastsystemsgroup.com | Commons' Room details button, its 'What is shared here?' link and the Private rail button open their panels: the panel content was defined but no handler opened it, so all three did nothing.
 * 13 | maintainer@emeraldcoastsystemsgroup.com | Derive tenant roster member initials honestly in roomAvatars from initials or name instead of displaying a static bullet for known peers.
 * 14 | maintainer@emeraldcoastsystemsgroup.com | Accept package-owned display labels and audience hints while retaining the dynamic caller catalog and shared engines.
 * 15 | maintainer@emeraldcoastsystemsgroup.com | Name operational panels directly while preserving data, access rules, actions and visual styles.
 * 16 | maintainer@emeraldcoastsystemsgroup.com | Distinguish loading, partial and unavailable work from successful empty reads; preserve admitted rows and unknown counts with accessible retry.
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Qualify the Jarvis agenda from its own overview calendar field while global assistant status remains private or unknown.
 * 18 | maintainer@emeraldcoastsystemsgroup.com | Send selected admitted member context, scope saved drafts/tool references by principal, recheck reopened tools, and preserve foreground frames and backward draft selection during asynchronous updates.
 * 19 | maintainer@emeraldcoastsystemsgroup.com | Preserve the visible semantic modal opener across late and after-close repaint so Escape returns keyboard focus to the same control.
 * 20 | maintainer@emeraldcoastsystemsgroup.com | Use native application chrome, actual-work briefings and local Settings for appearance and day focus instead of the showcase bar and fabricated conversation.
 * 21 | maintainer@emeraldcoastsystemsgroup.com | Retain factual assistant availability in Jarvis and Orbit content when the overview source is loading or unavailable.
 */
(() => {
  'use strict';
  const S = window.OSHAL_SHELL, LIVE = window.OSHAL_LIVE, PANELS = () => window.OSHAL_SHELL_PANELS;
  const { esc, button, primary, link, avatar, badge } = S;
  const root = document.getElementById('app');
  const layout = document.body.dataset.layout;
  const display = window.OSHAL_EXPERIENCE_CONFIG || {};
  const LABELS = { studio: 'Studio', jarvis: 'Jarvis', orbit: 'Orbit', commons: 'Commons', ...display.labels };
  /** The audience each layout asks a hosted page for (ADR-164 D4: Commons pairs with a company experience; the Jarvis briefing is the warm home layout). */
  const AUDIENCE = { studio: 'company', jarvis: 'family', orbit: 'company', commons: 'company', ...display.audiences };
  /** Where Orbit seats six suites around the hub (the demo's layout): the bottom pair stays above the legend. */
  const ORBIT_SIX = [[22, 16], [78, 16], [87, 50], [78, 84], [22, 84], [13, 50]];
  document.body.classList.add('full-swarm');
  root.innerHTML = '<div class="app-shell"><section class="loading-shell"><div class="eyebrow mono muted">Connecting to your swarm</div><h1>Reading your applications, work and assistants…</h1></section></div>';

  let shell, snapshot, state, thread, roomThreads = new Map(), dirty = false, agendaClass = null;
  let storageKey;
  const defaults = () => ({ selected: '', orbitSuite: '', room: '', roomTab: 'conversation', navOpen: false, drafts: {}, askDrafts: {}, memberTools: {}, embed: false });
  const save = () => { if (!storageKey) return; try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch (_) { /* session storage unavailable */ } };
  const me = () => snapshot.me;
  const selected = () => shell.byId(state.selected);
  const gameApps = () => shell.gameApps();
  const roomIds = () => snapshot.suites.map(s => s.id).concat(gameApps().length ? ['games'] : []);
  const roomName = () => state.room === 'games' ? 'Game room' : `${shell.suiteOf(state.room).name} room`;
  const roomApps = () => state.room === 'games' ? gameApps() : shell.suiteOf(state.room).apps;
  const roomWork = () => snapshot.work.filter(w => roomApps().some(a => a.id === w.app));
  const contextKey = () => layout === 'commons' ? `room:${state.room}:app:${roomApps().some(a => a.id === state.selected) ? state.selected : ''}` : state.selected;
  const selectedContext = () => layout === 'commons' && !roomApps().some(a => a.id === state.selected) ? undefined : shell.contextFor(selected());
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
  const firstName = () => me().name.split(/[\s.@_-]+/)[0] || me().name;
  const VIEWS = () => window.OSHAL_LIVE_VIEWS;
  const evening = () => shell.scene() === 'evening';
  const suiteOfWork = w => w.app && shell.byId(w.app) ? shell.byId(w.app).suite : null;
  /** Work and attention lists in the day focus order: the focus's suites first, nothing dropped. */
  const inFocus = items => VIEWS().sceneOrder(items, shell.scene(), suiteOfWork);
  /** @description Preserve unknown assistant status without inferring a count from an incomplete overview. @returns {string} Native source-status markup or nothing on a complete read. */
  const assistantStatus = () => shell.workState(['overview']).complete ? '' : `<p class="note-line" role="status">${esc(shell.overviewCount(''))}</p>`;

  LIVE.ready.then(boot).catch(err => { root.innerHTML = `<div class="app-shell"><section class="loading-shell"><h1>This experience could not load.</h1><p class="note-line">${esc(err && err.message ? err.message : String(err))}</p><p>${link('Return to the cockpit', '/cockpit/', 'action primary')}</p></section></div>`; });

  function boot(loaded) {
    snapshot = loaded;
    if (!snapshot.me.authenticated) { root.innerHTML = `<div class="app-shell"><section class="loading-shell"><h1>Sign in to see your swarm.</h1><p class="note-line">This experience reads your own applications, tickets and conversations, so it needs your session.</p><p>${link('Sign in', '/login', 'action primary')}</p></section></div>`; return; }
    storageKey = snapshot.me.issuer && snapshot.me.sub ? `oshal-live-${layout}:${encodeURIComponent(JSON.stringify([snapshot.me.issuer, snapshot.me.sub]))}` : null;
    shell = S.createShell({ snapshot, layoutId: layout, audience: AUDIENCE[layout], hooks: { allowEmbed: true, contextAction: layout === 'commons' ? 'Go to its room' : 'Use as my context', modalContent, modalTitle, afterClose: () => { if (dirty) { dirty = false; render(); } }, onPinsChanged, onEmbedViewChanged, memberToolFor: app => state.memberTools[app], onMemberNavigation: (app, tool) => { state.memberTools[app] = tool; save(); }, peopleDirectory: layout === 'commons', workActions: true, onWorkChanged: () => render(), canRetryWork: () => !state || !state.embed, scenes: true, onSceneChanged } });
    state = defaults();
    try { const saved = storageKey && JSON.parse(sessionStorage.getItem(storageKey) || 'null'); if (saved && typeof saved === 'object') state = { ...state, ...saved, navOpen: false }; } catch (_) { /* fresh state */ }
    if (!shell.contextFor(selected())) state.selected = (shell.pinned().find(a => shell.contextFor(a)) || snapshot.apps.find(a => shell.contextFor(a)) || { id: '' }).id;
    if (!roomIds().includes(state.room)) state.room = roomIds()[0] || '';
    thread = shell.createThread(LIVE.sessionId(), 'Jarvis');
    shell.bind(root); bindEvents();
    render();
    thread.load().then(render);
    if (layout === 'commons') { roomThread().load().then(render); shell.fillPeople().then(render); }
    if (selected()) shell.summaryFor(selected()).then(render);
    if (layout === 'jarvis') loadAgenda();
  }

  /**
   * @description Jarvis agenda: the caller's Little Monsters calendar, read without provisioning anyone. The calendar route
   * resolves the caller as a learner (it can create or link a learner row), so the package's own read-only home-summary
   * probe goes first and the calendar is read only when that probe answers 200; otherwise no /api/education request is sent.
   * An entry the authorized plan does not admit (listed, not in the plan) is not available to the caller: no probe either.
   * @returns {Promise<void>} Resolves once the agenda slot is painted.
   */
  async function loadAgenda() {
    const lm = shell.byId('little-monsters');
    if (!lm) { agendaClass = { installed: false }; paintAgenda(); return; }
    if (!lm.inPlan && snapshot.sources.plan === 200) { agendaClass = { installed: true, refusal: 'not-granted', ok: false, status: 0, events: [] }; paintAgenda(); return; }
    const probe = await shell.summaryFor(lm);
    if (probe.status !== 200) { agendaClass = { installed: true, probe: probe.status || 0, refusal: LIVE.littleMonstersRefusal(probe.status, probe.error), ok: false, status: 0, events: [] }; paintAgenda(); return; }
    const r = await LIVE.packages.education.agenda(new Date());
    agendaClass = Object.assign({ installed: true, probe: 200 }, r); paintAgenda();
  }
  const paintAgenda = () => document.querySelectorAll('[data-agenda-slot]').forEach(slot => { slot.innerHTML = agendaMarkup(); });
  /** @description Pins changed: behind a panel, re-render when it closes; in the page (the Commons room grid), re-render now and refocus the pin. */
  function onPinsChanged() {
    if (shell.state.modal) { dirty = true; return; }
    const id = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.app : '';
    render();
    const again = id && root.querySelector(`.room-app-grid [data-catalog-app="${CSS.escape(id)}"] [data-action="pin"]`); if (again) again.focus();
  }
  function onEmbedViewChanged() {
    if (shell.state.modal) { dirty = true; return; }
    render(true);
    const pressed = root.querySelector(`.full-context [data-action="embed-view"][data-view="${shell.state.embedView}"]`); if (pressed) pressed.focus();
  }

  /** The Jarvis briefing heading for the focus: what waits on the person, in words for the part of the day. */
  function briefingHeading(attention) {
    if (!shell.workState().complete) return shell.workState().kind === 'partial' ? 'Available work to review' : 'Work ' + (shell.workState().kind === 'loading' ? 'loading' : 'unavailable');
    const n = Math.min(attention.length, 3), things = `${n} item${n === 1 ? '' : 's'}`;
    if (evening()) return attention.length ? `${things} to review this evening.` : 'No review items listed.';
    return attention.length ? `${things} to review.` : 'No review items listed.';
  }
  /**
   * @description The day focus changed (device-local): select an application of the focus (a pin first), move Commons to the
   * focus's room (evening: the Game room when there is one, else Home & life), re-render and say that nothing was hidden.
   * @param {string} scene The new focus id.
   * @returns {void}
   */
  function onSceneChanged(scene) {
    const suites = VIEWS().sceneOf(scene).suites;
    const pick = shell.pinned().find(a => suites.includes(a.suite)) || snapshot.apps.find(a => a.navigable && suites.includes(a.suite));
    if (pick) { state.selected = pick.id; state.embed = false; if (layout === 'orbit') state.orbitSuite = ''; }
    if (layout === 'commons') { state.room = scene === 'evening' ? (roomIds().includes('games') ? 'games' : 'ai-home') : (roomIds().find(id => suites.includes(id)) || roomIds()[0]); state.roomTab = 'conversation'; }
    save(); render();
    if (layout === 'commons') { const t = roomThread(); if (!t.loaded) t.load().then(render); }
    if (selected()) shell.summaryFor(selected()).then(render);
    shell.toast(scene === 'evening' ? 'Evening focus: home, creative and games come first. Nothing is hidden.' : 'Workday focus: finance, engineering, productivity and knowledge come first. Nothing is hidden.');
  }
  /** The caller's household or team once read, when they belong to one (GET /api/tenants); null otherwise. */
  const team = () => { const m = shell.membership(); return m && m.ok && m.tenant && m.membersStatus === 200 ? m : null; };
  /** @description The room header's faces: the caller, up to three fellow members of their household or team, and Jarvis. */
  function roomAvatars() {
    const m = team(), others = m ? m.members.filter(x => !x.self).slice(0, 3) : [];
    const label = m ? `${m.members.length} member${m.members.length === 1 ? '' : 's'} of ${m.tenant.name}, and Jarvis` : 'You and Jarvis';
    const peerInitials = o => o.initials || (o.name ? o.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase() : '·');
    return `<div class="avatars" role="img" aria-label="${esc(label)}" title="${esc(label)}">${avatar(me().initials, 'person')}${others.map(o => avatar(peerInitials(o), 'person blue')).join('')}${avatar('J')}</div>`;
  }
  function roomThread() {
    if (!roomThreads.has(state.room)) {
      const gen = LIVE.prefs.get(`room-thread:${state.room}`, 0);
      const t = shell.createThread(`jarvis-room-${state.room}-${me().sub}${gen ? `-${gen}` : ''}`.replace(/[^\w.-]/g, '-'), roomName());
      t.explicit = true; roomThreads.set(state.room, t);
    }
    return roomThreads.get(state.room);
  }
  const activeThread = () => layout === 'commons' ? roomThread() : thread;

  /* ── shared fragments ─────────────────────────────────────────── */
  const settingsButton = (cls = 'action') => button('Settings', 'settings', cls, 'aria-label="Settings"');
  const suiteButton = (s, action = 'suite', active = false) => button(`<span class="suite-symbol" aria-hidden="true">${s.symbol}</span><span>${esc(s.name)}</span><span class="nav-count">${s.count}</span>`, action, `nav-button${active ? ' active' : ''}`, `data-suite="${s.id}"`);
  const suiteTiles = () => `<div class="suite-grid">${snapshot.suites.map(s => button(`<div class="row between"><span class="suite-symbol">${s.symbol}</span><span class="small-label">${s.count} apps</span></div><h3>${esc(s.name)}</h3><p>${esc(s.line)}</p><div class="suite-apps">${s.apps.slice(0, 3).map(a => `<span>${esc(a.name)}</span>`).join('') || '<span>No applications installed</span>'}</div>`, 'suite', 'suite-tile', `data-suite="${s.id}"`)).join('')}</div>`;
  const runningRow = item => button(`${item.app && shell.byId(item.app) ? shell.appMark(shell.byId(item.app)) : avatar(item.kind === 'task' ? 'J' : 'Q')}<span><strong>${esc(item.appName)}</strong><small>${esc(item.title)}</small></span><span class="small-label">${esc(item.status.label)} · ${esc(shell.timeAgo(item))}</span>${PANELS().movingBar(item)}`, 'work-item', 'running-row', `data-work="${esc(item.id)}"`);
  function briefingSentence() {
    if (!shell.workState().complete) return shell.workState().message;
    const waiting = shell.attention().filter(w => LIVE.STATUS_GROUPS.attention.includes(w.status.label));
    const working = shell.openWork().length, done = snapshot.work.filter(w => w.status.label === 'Ready').length;
    if (waiting.length) return `${waiting.length} item${waiting.length === 1 ? '' : 's'} need${waiting.length === 1 ? 's' : ''} you: ${waiting.slice(0, 3).map(w => w.title).join('; ')}.`;
    if (working) return `${working} item${working === 1 ? ' is' : 's are'} in progress. No items need your review.`;
    return done ? `Nothing is waiting on you. ${done} item${done === 1 ? '' : 's'} finished recently.` : 'No work items yet.';
  }
  function composer() {
    const t = activeThread(), room = layout === 'commons';
    const note = t.unavailable ? 'Earlier messages are unavailable.' : !t.loaded ? 'Loading conversation…' : t.turns.length ? `${t.turns.length} messages` : 'New conversation';
    return `<div class="composer-wrap"><form id="message-form" class="composer"><label class="screenreader" for="message-input">Message ${room ? 'this room' : 'Jarvis'}</label><textarea id="message-input" rows="2" maxlength="1200" placeholder="${room ? 'Message this room…' : 'Message Jarvis…'}"${t.busy ? ' disabled' : ''}>${esc(state.drafts[contextKey()] || '')}</textarea><div class="composer-bottom"><div class="composer-options">${button('+', 'directory', 'icon-button', 'aria-label="Choose an application"')}<span class="context-token">${room ? esc(roomName()) : esc(selected() ? selected().name : 'Whole swarm')}</span>${button('Change context', 'directory', 'quiet-link')}</div><button type="submit" class="send-button" aria-label="Send to Jarvis"${t.busy ? ' disabled' : ''}>↑</button></div></form><div class="composer-hint">${esc(note)}</div></div>`;
  }
  function intro() {
    if (activeThread().turns.length) return '';
    return `<section class="work-briefing" aria-label="Work briefing"><div class="section-head"><span class="eyebrow">Briefing</span>${badge(evening() ? 'Evening' : 'Today', true)}</div><p>${esc(briefingSentence())}</p><div class="cross-work-grid">${inFocus(layout === 'commons' ? roomWork() : shell.attention()).slice(0, 3).map(shell.artifactTile).join('') || (shell.workState().complete ? shell.workEmpty('No recorded work to show yet.') : '')}</div></section>`;
  }
  function contextAside(kicker, cls) {
    const app = selected(); if (!app) return `<aside class="${cls}"><p class="note-line">No application selected.</p></aside>`;
    const latest = shell.workFor(app.id)[0];
    return `<aside class="${cls}"><div class="section-head"><span class="eyebrow mono">${kicker}</span>${button('↗', 'open-app', 'icon-button', `data-app="${esc(app.id)}" aria-label="Open ${esc(app.name)} details"`)}</div><div class="context-app">${shell.appMark(app)}<div><h2>${esc(app.name)}</h2><small>${esc(shell.suiteOf(app.suite).name)}${app.version ? ` · v${esc(app.version)}` : ''}</small></div></div>${state.embed && app.surface ? '' : shell.visualFor(app)}${state.embed && app.surface ? `${shell.embedControls(app)}${shell.embedFrame(app, 'compact')}` : `<div class="context-summary" data-summary-slot="${esc(app.id)}">${shell.summaryMarkup(app, null)}</div>`}${latest ? `<h3>${esc(latest.title)}</h3><p class="context-description">${esc(latest.appName)} · ${esc(latest.status.label)} · ${esc(shell.timeAgo(latest))}</p>${primary('Open this work ↗', 'work-item', `data-work="${esc(latest.id)}"`)}` : shell.workEmpty(`No tickets or tasks recorded for ${app.name} yet.`)}<div class="drawer-actions">${app.navigable ? link('Open ↗', app.href, 'action') : ''}${app.surface ? button(state.embed ? 'Close in-place view' : 'Open here', 'toggle-embed', 'action') : ''}</div><hr class="rule"><span class="eyebrow mono muted">Declared assistants</span>${shell.detailSlot(app, 'assistants')}<span class="eyebrow mono muted">Relationships</span>${shell.detailSlot(app, 'relations', 'select-app')}${button('Inspect this application →', 'open-app', 'action text', `data-app="${esc(app.id)}"`)}</aside>`;
  }
  /** Agenda rows: the overview calendar feed (the {title, when} shape the cockpit Jarvis page reads) plus the caller's Little Monsters events, each row naming its source. */
  function agendaMarkup() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const feed = snapshot.calendarEvents.filter(e => e && typeof e.title === 'string' && e.title).map(e => ({ title: e.title, when: LIVE.parseDate(e.when), timed: /T\d/.test(String(e.when)), source: 'Swarm calendar' }));
    const classwork = agendaClass && Array.isArray(agendaClass.events) ? agendaClass.events.map(e => ({ title: e.title, when: e.when, timed: e.timed, source: `Little Monsters · ${e.className || 'personal'}` })) : [];
    const rows = feed.concat(classwork).filter(r => r.when && r.when >= today).sort((a, b) => a.when - b.when).slice(0, 5);
    const dayLabel = d => d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const list = rows.map(r => `<div class="agenda-row"><time>${esc(dayLabel(r.when))}</time><div class="agenda-detail">${esc(r.title)}<small>${esc(`${r.timed ? LIVE.clockTime(r.when) : 'All day'} · ${r.source}`)}</small></div></div>`).join('');
    const calendar = shell.workState(['overviewCalendar']);
    const empty = calendar.complete ? 'Nothing on your agenda from the sources below.' : 'No readable agenda events from the sources below.';
    return `${list || `<p class="note-line">${esc(empty)}</p>`}<p class="note-line agenda-sources">${esc(agendaSources(feed.length))}</p>`;
  }
  function agendaSources(feedCount) {
    const read = shell.workState(['overviewCalendar']);
    const feed = !read.complete ? read.message : feedCount ? 'Swarm calendar feed from the overview.' : 'No application contributes events to the swarm calendar feed yet.';
    return `${feed} ${classSource(agendaClass)}`;
  }
  const CLASS_SOURCE = 'Little Monsters calendar (classes and personal events)';
  /** The Little Monsters half of the agenda's source line: not in the catalog, not admitted, no school profile yet, probe failed, calendar refused, empty or read. */
  function classSource(c) {
    if (!c) return 'Reading your Little Monsters calendar…';
    if (!c.installed) return 'Little Monsters is not in your catalog, so its calendar is not read.';
    if (c.refusal === 'not-granted') return 'Little Monsters is not available to you, so its calendar is not read.';
    if (c.refusal === 'no-profile') return 'Open Little Monsters once to set up your school profile; its calendar then shows here.';
    if (c.probe !== 200) return `Little Monsters could not be checked (HTTP ${c.probe || 'unreachable'}), so its calendar is not read.`;
    if (!c.ok) return `${CLASS_SOURCE} ${[401, 403, 404].includes(c.status) ? 'refused' : 'unavailable'} (HTTP ${c.status || 'unreachable'}).`;
    return c.events.length ? `${CLASS_SOURCE}, this month and next.` : `${CLASS_SOURCE}: nothing this month or next.`;
  }

  /* ── layouts ──────────────────────────────────────────────────── */
  function studio() {
    const apps = snapshot.apps, suites = snapshot.suites;
    return `<div class="app-shell studio-shell full-studio${state.navOpen ? ' nav-open' : ''}"><aside class="studio-sidebar"><a class="brand" href="/portal"><span class="brand-mark" aria-hidden="true"></span>oshal ${badge('STUDIO', true)}</a>${primary('＋ New conversation', 'new')}<nav class="side-navigation" aria-label="Workspace navigation">${button('<span>⌕ Search all applications</span>', 'directory', 'nav-button')}${button(`<span>◫ Work across the swarm</span><span class="nav-count">${shell.workValue(shell.openWork().length)}</span>`, 'all-work', 'nav-button')}${button('<span>◎ People & assistants</span>', 'people', 'nav-button')}</nav><div class="sidebar-section">Your suites / ${apps.length} apps</div><nav class="side-navigation" aria-label="Application suites">${suites.map(s => suiteButton(s)).join('')}</nav><div class="sidebar-section">Pinned to your workspace</div><nav class="side-navigation pinned-nav" aria-label="Pinned applications">${shell.pinned().map(a => button(`${shell.appMark(a)}<span>${esc(a.name)}</span>`, 'select-app', `nav-button${state.selected === a.id ? ' active' : ''}`, `data-app="${esc(a.id)}"`)).join('') || '<p class="note-line">Pin applications from the directory.</p>'}</nav><div class="sidebar-bottom">${button('Manage all applications ↗', 'directory', 'nav-button')}<div class="sidebar-profile">${avatar(me().initials, 'person')}<span><strong>${esc(me().name)}</strong><small>${esc(me().email || 'My swarm')}</small></span></div></div></aside><main class="studio-main"><header class="app-top studio-top"><div class="row">${button('☰', 'menu', 'icon-button mobile-nav-toggle', `aria-label="Open navigation" aria-expanded="${state.navOpen}"`)}<span class="crumb">My swarm <span>/</span><span class="title">${esc(selected() ? selected().name : 'Whole swarm')}</span></span></div><div class="top-actions">${button(`All ${apps.length} apps`, 'directory', 'action')}${settingsButton()}<span class="pill">${suites.length} suites · ${esc(shell.workCount(shell.openWork().length, 'open'))}</span></div></header><div class="studio-workspace"><section class="studio-conversation"><div><div class="eyebrow mono muted">Workspace</div><h1>${esc(display.headings?.[layout]?.[evening() ? 'evening' : 'workday'] || (evening() ? 'Evening Work' : 'Recent Work'))}</h1><div class="run-strip"><span>${apps.length} apps installed</span><span>${esc(shell.workCount(snapshot.work.length, 'recorded work items'))}</span><span>${esc(shell.overviewCount(`${snapshot.botsOnline} assistants online`))}</span></div></div><div class="studio-suite-strip">${suites.map(s => button(`${esc(s.name)}<span>${s.count}</span>`, 'suite', 'suite-chip', `data-suite="${s.id}"`)).join('')}</div><div class="conversation-list">${intro()}${shell.threadHtml(thread)}</div><div class="running-work"><div class="section-head"><span class="eyebrow mono">Recent activity</span>${button('See all activity →', 'all-work', 'quiet-link')}</div>${inFocus(snapshot.work).slice(0, 4).map(runningRow).join('') || shell.workEmpty('No tickets or tasks yet.')}</div>${composer()}</section>${contextAside('Selected workspace', 'artifact-sidebar full-context')}</div></main></div>`;
  }

  function jarvis() {
    const apps = snapshot.apps, attention = inFocus(shell.attention());
    return `<div class="app-shell jarvis-shell full-jarvis"><nav class="jarvis-rail" aria-label="Jarvis navigation"><a href="/portal" aria-label="Applications"><span class="brand-mark" aria-hidden="true"></span></a>${button('<span class="rail-symbol">◉</span>Today', 'home', 'rail-button active')}${button('<span class="rail-symbol">▦</span>All apps', 'directory', 'rail-button')}${button('<span class="rail-symbol">◫</span>My work', 'all-work', 'rail-button')}${button('<span class="rail-symbol">◎</span>People', 'people', 'rail-button')}<div class="rail-bottom">${button('<span class="rail-symbol">⚙</span>Routines', 'routines', 'rail-button')}</div></nav><main class="jarvis-main"><header class="jarvis-top"><div><div class="brand">Jarvis</div><div class="jarvis-date">${esc(greeting())}, ${esc(firstName())} · ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · across ${apps.length} applications</div></div><div class="top-actions">${button('⌕ Find an app', 'directory', 'action')}${settingsButton()}${avatar(me().initials, 'person')}</div></header><div class="jarvis-layout"><section class="jarvis-center"><div class="jarvis-greeting"><div><div class="eyebrow">Daily overview</div><h1>${display.headings?.[layout] ? esc(display.headings[layout][evening() ? 'evening' : 'workday']) : evening() ? 'Evening<br><em>Work overview</em>' : 'Today<br><em>Work overview</em>'}</h1><p>${esc(briefingSentence())}</p>${assistantStatus()}</div><div class="orb-wrap"><div class="jarvis-orb" role="img" aria-label="Jarvis"></div></div></div><div class="briefing-card full-brief"><div class="row between"><span class="eyebrow">Your briefing</span>${badge(evening() ? 'This evening · from your queue' : 'From your queue', true)}</div><h2>${briefingHeading(attention)}</h2><div class="briefing-items">${attention.slice(0, 3).map(w => button(`${w.app && shell.byId(w.app) ? shell.appMark(shell.byId(w.app)) : avatar(w.kind === 'task' ? 'J' : 'Q')}<span><strong>${esc(w.title)}</strong><small>${esc(w.appName)} · ${esc(w.status.label)} · ${esc(shell.timeAgo(w))}</small></span><span>↗</span>`, 'work-item', 'briefing-item', `data-work="${esc(w.id)}"`)).join('') || shell.workEmpty('Your tickets and assistant tasks will appear here as they arrive.')}</div></div><div class="jarvis-suggestions">${button('Give me the whole picture', 'prompt', '', 'data-prompt="Give me a briefing across my whole swarm: what is waiting on me, what is in progress, and what finished today."')}${button('What needs my review?', 'all-work')}${evening() && gameApps().length ? button('What can I play tonight?', 'prompt', '', `data-prompt="${esc(`Which of my games could we play tonight: ${gameApps().map(a => a.name).join(', ')}? Suggest one and what it needs.`)}"`) : button('What can my swarm do?', 'prompt', '', 'data-prompt="Which applications do I have installed and what can each of them do for me today?"')}</div>${thread.turns.length ? `<div class="conversation-list full-messages">${shell.threadHtml(thread)}</div>` : ''}${composer()}<section class="jarvis-domains"><div class="section-head"><div><div class="eyebrow muted">Applications</div><h2>${snapshot.suites.length} application suites</h2></div>${button(`All ${apps.length} apps ↗`, 'directory', 'quiet-link')}</div>${suiteTiles()}</section></section><aside class="jarvis-aside full-jarvis-aside"><div><div class="section-head"><span class="eyebrow">Recent activity</span></div>${inFocus(snapshot.work).slice(0, 6).map(w => button(`<span class="row between">${badge(w.status.label, true)}<span class="small-label">${esc(LIVE.clockTime(w.at))}</span></span><div class="attention-heading"><h3>${esc(w.title)}</h3><span class="arrow">↗</span></div><small>${esc(w.appName)} · ${esc(w.typeLabel)}</small>`, 'work-item', 'attention-card', `data-work="${esc(w.id)}"`)).join('') || shell.workEmpty('Nothing recorded yet.')}</div><div class="jarvis-agenda live-agenda"><div class="section-head"><span class="eyebrow">Your agenda</span></div><div data-agenda-slot>${agendaMarkup()}</div></div><div class="jarvis-agenda"><div class="eyebrow">Pinned applications</div>${shell.pinned().slice(0, 4).map(a => shell.miniApp(a)).join('')}${button('Manage pinned apps →', 'directory', 'action text', 'data-suite="pinned"')}</div></aside></div><footer class="jarvis-footer">${button('About this data', 'provenance', 'quiet-link')}</footer></main></div>`;
  }

  function orbit() {
    const apps = snapshot.apps, suites = snapshot.suites, s = suites.find(x => x.id === state.orbitSuite) || null, app = selected();
    const positions = suites.length === 6 ? ORBIT_SIX : suites.map((_, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / suites.length; return [50 + 37 * Math.cos(a), 50 + 34 * Math.sin(a)]; });
    const map = `<div class="orbit-canvas full-orbit-canvas" aria-label="${suites.length} suites connected through Jarvis"><div class="orbit-rings" aria-hidden="true"></div><svg class="orbit-connections" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${positions.map(([x, y]) => `<line x1="50" y1="50" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`).join('')}</svg>${button(`<span class="hub-core"></span><strong>Jarvis</strong><small>${apps.length} apps in reach</small>`, 'ask', 'orbit-hub', 'aria-label="Ask Jarvis"')}${suites.map((item, i) => button(`<div class="row between"><span class="node-symbol">${item.symbol}</span><span class="suite-node-count">${item.count}</span></div><strong>${esc(item.name)}</strong><small>${esc(item.apps.slice(0, 2).map(a => a.name).join(' · ') || 'Nothing installed')}</small><span class="suite-drill">Explore suite →</span>`, 'orbit-suite', `orbit-node suite-node${VIEWS().sceneOf(shell.scene()).suites.includes(item.id) ? ' in-focus' : ''}`, `data-suite="${item.id}" style="--node-x:${positions[i][0].toFixed(1)}%;--node-y:${positions[i][1].toFixed(1)}%"`)).join('')}</div><div class="map-legend"><span>Application suites</span><span>${suites.length} suites · ${apps.length} applications</span></div>`;
    const grid = s ? `<div class="orbit-suite-toolbar"><span>${esc(s.line)}</span>${button('Open searchable list', 'directory', 'quiet-link', `data-suite="${s.id}"`)}</div><div class="orbit-app-grid">${s.apps.map(a => button(`${shell.appMark(a)}<span><strong>${esc(a.name)}</strong><small>${esc(shell.workFor(a.id)[0] ? shell.workFor(a.id)[0].title : a.navigable ? a.id : 'Not available here')}</small></span>${shell.isPinned(a.id) ? '<span class="pin-dot" aria-label="Pinned">★</span>' : ''}`, 'select-app', `orbit-app${state.selected === a.id ? ' selected' : ''}`, `data-app="${esc(a.id)}" aria-pressed="${state.selected === a.id}"`)).join('') || '<p class="note-line">No applications in this suite are installed.</p>'}</div>` : map;
    const stream = inFocus(s ? snapshot.work.filter(w => w.app && shell.byId(w.app) && shell.byId(w.app).suite === s.id) : snapshot.work).slice(0, 3);
    return `<div class="app-shell full-orbit"><header class="app-top orbit-top"><a class="brand" href="/portal"><span class="brand-mark" aria-hidden="true"></span>oshal<span class="brand-divider"></span><span class="eyebrow">Orbit</span></a><div class="top-actions">${button(`⌕ Find any of ${apps.length} apps`, 'directory')}${settingsButton()}${avatar(me().initials, 'person')}</div></header><main class="orbit-content"><section class="orbit-map-area"><div class="orbit-map-heading"><div><div class="eyebrow muted">${s ? `My swarm / ${esc(s.name)}` : `${suites.length} application suites · ${esc(VIEWS().sceneOf(shell.scene()).label.toLowerCase())}`}</div><h1>${s ? esc(s.name) : esc(display.headings?.[layout]?.workday || 'Applications')}</h1><p>${s ? `${s.count} installed application${s.count === 1 ? '' : 's'}. Select one to follow its work.` : 'Select an application suite.'}</p>${assistantStatus()}</div>${s ? button('← Whole swarm', 'orbit-back', 'action') : badge(`${apps.length} apps · ${suites.length} suites`, true)}</div>${grid}<div class="orbit-stream"><div class="section-head"><span class="eyebrow muted">Recent work</span>${button('All work →', 'all-work', 'quiet-link')}</div>${stream.map(shell.workRow).join('') || shell.workEmpty('No recorded work here yet.')}</div></section>${app ? `<aside class="orbit-inspector full-orbit-inspector"><div class="row between"><span class="eyebrow muted">${s ? 'Selected application' : 'A closer look'}</span>${shell.workFor(app.id)[0] ? shell.statusBadge(shell.workFor(app.id)[0].status) : badge(app.navigable ? 'Available' : 'Unavailable', true)}</div><div class="inspector-title">${shell.appMark(app)}<div><h2>${esc(app.name)}</h2><small class="muted">${esc(shell.suiteOf(app.suite).name)}</small></div></div><p>${esc(app.description)}</p>${shell.visualFor(app)}<div class="context-summary" data-summary-slot="${esc(app.id)}">${shell.summaryMarkup(app, null)}</div>${app.navigable ? link('Open workspace ↗', app.href, 'action primary') : ''}${app.surface ? button('Open here', 'embed', 'action', `data-app="${esc(app.id)}"`) : ''}<div class="inspector-detail"><h3>Work in context</h3>${shell.workFor(app.id).slice(0, 2).map(shell.artifactTile).join('') || shell.workEmpty('No tickets or tasks recorded for this application.')}</div><div class="inspector-detail"><h3>Declared assistants</h3>${shell.detailSlot(app, 'assistants')}</div><div class="inspector-detail"><h3>Declared app connections</h3>${shell.detailSlot(app, 'relations', 'select-app')}</div></aside>` : ''}</main><footer class="orbit-bottom">${button('About this data', 'provenance', 'quiet-link')}</footer></div>`;
  }

  function commons() {
    const apps = snapshot.apps, suites = snapshot.suites, rApps = roomApps(), rWork = roomWork(), t = roomThread();
    const groups = LIVE.STATUS_GROUPS, columns = [['Review', groups.attention], ['Working', groups.moving], ['Ready', groups.done]];
    const feed = state.roomTab === 'apps'
      ? `<div class="section-head"><div><h2>Room applications</h2><p class="small-label">Installed applications in ${esc(roomName())}</p></div>${button(`All ${apps.length} apps`, 'directory', 'quiet-link')}</div><div class="room-app-grid">${rApps.map(shell.appCard).join('') || '<p class="note-line">No applications installed in this room.</p>'}</div>`
      : state.roomTab === 'board'
        ? `<div class="section-head"><h2>Work board</h2><span class="small-label">${esc(shell.workCount(rWork.length, 'items'))} from this room’s applications</span></div><div class="full-board">${columns.map(([name, labels]) => `<section class="board-column"><h3>${name}</h3>${rWork.filter(w => labels.includes(w.status.label)).slice(0, 8).map(w => `<div class="board-card"><h3>${esc(w.title)}</h3><small>${esc(w.appName)} · ${esc(shell.timeAgo(w))}</small>${button('Open ↗', 'work-item', '', `data-work="${esc(w.id)}"`)}</div>`).join('') || shell.workEmpty('Nothing in this stage.')}</section>`).join('')}</div>`
        : `<div class="room-welcome"><div class="eyebrow">${state.room === 'games' ? 'Games' : 'Room applications'}</div><h2>${esc(state.room === 'games' ? 'Game room' : shell.suiteOf(state.room).line)}</h2><p>${rApps.length} application${rApps.length === 1 ? '' : 's'} · ${esc(shell.workCount(rWork.length, 'recorded work items'))} · ${rApps.reduce((n, a) => n + a.botCount, 0)} declared assistants</p></div><div class="room-app-strip">${rApps.slice(0, 4).map(a => button(`${shell.appMark(a)}<span>${esc(a.name)}</span>`, 'open-app', 'room-app-link', `data-app="${esc(a.id)}"`)).join('')}${button(`All ${rApps.length} →`, 'room-tab', 'quiet-link', 'data-tab="apps"')}</div>${state.room === 'games' && rApps[0] ? shell.visualFor(rApps[0]) : ''}<div class="day-divider">RECENT ACTIVITY IN THIS ROOM</div><div class="room-messages">${rWork.slice(0, 3).map(w => `<div><div class="message-header">${w.app && shell.byId(w.app) ? shell.appMark(shell.byId(w.app)) : avatar('Q')}${esc(w.appName)} ${badge(w.status.label, true)}<time>${esc(shell.timeAgo(w))}</time></div><div class="message-content">${shell.artifactTile(w)}</div></div>`).join('') || shell.workEmpty('No tickets or tasks from this room’s applications yet.')}${intro()}${shell.threadHtml(t)}</div>${composer()}`;
    return `<div class="app-shell full-commons"><header class="commons-top"><a class="brand" href="/portal"><span class="brand-mark" aria-hidden="true"></span>oshal <span class="commons-brand-label">commons</span></a>${button(`<span>⌕ Find rooms or any of ${apps.length} apps</span><kbd>Ctrl K</kbd>`, 'directory', 'commons-search')}<div class="top-actions"><span class="small-label">${esc(me().name)}</span>${avatar(me().initials, 'person')}</div></header><div class="commons-shell${state.navOpen ? ' nav-open' : ''}"><nav class="commons-rail" aria-label="Commons navigation">${button('<span class="rail-symbol">◫</span>Rooms', 'menu', 'rail-button active')}${button('<span class="rail-symbol">▦</span>Apps', 'directory', 'rail-button')}${button('<span class="rail-symbol">◷</span>Activity', 'all-work', 'rail-button')}${button('<span class="rail-symbol">◎</span>People', 'people', 'rail-button')}<div class="rail-bottom">${button('<span class="rail-symbol">◉</span>Private', 'private', 'rail-button')}${settingsButton('rail-button')}</div></nav><aside class="commons-sidebar"><div class="workspace-name"><h2>${esc(team() ? team().tenant.name : `${me().name}’s swarm`)}</h2><small>${team() ? `Your ${team().tenant.kind === 'org' ? 'team' : 'household'} · ` : ''}${apps.length} applications · ${suites.length} suites</small></div><div class="sidebar-section">Rooms across your swarm</div><nav class="side-navigation" aria-label="Swarm rooms">${suites.map(s => suiteButton(s, 'room', state.room === s.id)).join('')}${gameApps().length ? button(`<span class="suite-symbol">♧</span><span>Game room</span><span class="nav-count">${gameApps().length}</span>`, 'room', `nav-button${state.room === 'games' ? ' active' : ''}`, 'data-suite="games"') : ''}</nav><div class="sidebar-section">Your pinned applications</div><nav class="side-navigation">${shell.pinned().slice(0, 5).map(a => button(`${shell.appMark(a)}<span>${esc(a.name)}</span>`, 'open-app', 'nav-button', `data-app="${esc(a.id)}"`)).join('')}</nav><div class="sidebar-section">Direct conversation</div>${link(`${avatar('J')}<span>Jarvis</span>`, '/api/jarvis/', 'nav-button')}<div class="shared-scope">Rooms group applications by suite. Each room thread is your own Jarvis conversation; nobody else’s private data is read here.</div></aside><main class="commons-main"><header class="room-header"><div class="room-title"><div><h1><span class="muted">#</span> ${esc(roomName())}</h1><p>${rApps.length} applications · ${esc(shell.workCount(rWork.length, 'work items'))} · ${esc(shell.overviewCount(`${snapshot.botsOnline} assistants online in the swarm`))}</p></div><div class="row">${roomAvatars()}${button('Room details', 'room-details')}</div></div><div class="room-tabs" role="tablist" aria-label="Room view">${[['conversation', 'Conversation'], ['apps', `Applications · ${rApps.length}`], ['board', 'Work board']].map(([k, v]) => button(v, 'room-tab', '', `id="full-tab-${k}" data-tab="${k}" role="tab" aria-selected="${state.roomTab === k}" aria-controls="full-room-content"`)).join('')}</div></header><div class="commons-room"><section class="room-feed" id="full-room-content" role="tabpanel" aria-labelledby="full-tab-${state.roomTab}">${feed}</section><aside class="presence-panel">${team() ? `<div class="eyebrow">Your ${team().tenant.kind === 'org' ? 'team' : 'household'}</div>${shell.membershipSlot('room')}<hr class="rule">` : ''}<div class="eyebrow">People on this swarm</div>${shell.rosterSlot('room')}<hr class="rule"><div class="eyebrow">Application assistants</div>${rApps.filter(a => a.botCount).slice(0, 5).map(a => shell.personRow(LIVE.initials(a.name), a.name, `${a.botCount} declared assistant${a.botCount === 1 ? '' : 's'}`)).join('') || '<p class="note-line">No assistants declared by this room’s packages.</p>'}<hr class="rule"><div class="eyebrow">Pinned work</div>${rWork.slice(0, 3).map(shell.artifactTile).join('') || shell.workEmpty('Nothing recorded yet.')}<hr class="rule">${button('See every application', 'directory', 'action')}${button('What is shared here?', 'room-details', 'action text')}</aside></div></main></div></div>`;
  }

  /* ── layout-specific modal content ─────────────────────────────── */
  function modalTitle(kind) { return { settings: 'Settings', 'room-details': roomName(), private: 'Your private space', ask: 'Ask Jarvis' }[kind] || ''; }
  function settingsPanel() {
    const scenes = Object.values(VIEWS().SCENES).map(scene => `<option value="${esc(scene.id)}"${shell.scene() === scene.id ? ' selected' : ''}>${esc(scene.label)}</option>`).join('');
    return `<div class="application-settings"><div class="settings-field"><span class="field-label">Visual style</span>${S.skinPicker()}</div><div class="settings-field"><label class="field-label" for="scene-picker">Day focus</label><select id="scene-picker" class="layout-picker scene-picker">${scenes}</select></div><p class="note-line">Preferences are saved on this device.</p></div>`;
  }
  function modalContent(kind) {
    if (kind === 'settings') return settingsPanel();
    if (kind === 'room-details') return `${badge('Suite room', true)}<p>${esc(state.room === 'games' ? 'Games and playful applications installed on your swarm.' : shell.suiteOf(state.room).line)}</p><h3>${roomApps().length} applications in this room</h3><div class="room-detail-apps">${roomApps().map(a => shell.miniApp(a)).join('') || '<p class="note-line">None installed.</p>'}</div><hr class="rule"><h3>Shared here</h3><p>The room groups applications by their declared suite and shows your tickets and tasks from them. The room thread is answered by your own Jarvis; no other person’s accounts or conversations are read.</p>`;
    if (kind === 'private') return `${badge('Your personal space', true)}<p>Your money, career, preferences and direct conversations stay in their own applications and your own Jarvis thread.</p>${snapshot.apps.filter(a => ['ai-finance', 'ai-knowledge', 'ai-home'].includes(a.suite) && a.navigable).slice(0, 6).map(a => shell.miniApp(a)).join('') || '<p class="note-line">No personal applications are available in this workspace.</p>'}${link('Open the cockpit ↗', '/cockpit/', 'action')}`;
    if (kind === 'ask') return `<p>Ask about ${esc(selectedContext() ? selected().name : 'your applications')}.</p><form id="ask-form"><label class="field-label" for="ask-input">Ask Jarvis</label><input id="ask-input" type="text" value="${esc(state.askDrafts[contextKey()] || '')}" maxlength="1000" placeholder="What needs my attention today?" required><div class="drawer-actions"><button type="submit" class="action primary">Ask</button></div></form><div id="ask-response" role="status">${shell.threadHtml(thread)}</div>`;
    return '';
  }

  /* ── render + events ───────────────────────────────────────────── */
  /** Replace a detached modal opener with its visible equivalent; the shell restores focus when the panel closes. */
  function preserveModalOpener(opener) {
    if (!opener || opener.isConnected) return;
    const attributes = ['id', 'data-action', 'data-app', 'data-suite', 'data-room', 'data-work', 'data-tab', 'data-tool', 'data-view', 'aria-label']
      .filter(name => opener.hasAttribute(name));
    const candidates = attributes.length ? Array.from(root.querySelectorAll(opener.tagName)).filter(node =>
      attributes.every(name => node.getAttribute(name) === opener.getAttribute(name)) &&
      !node.disabled && !node.closest('[hidden], [inert]') && node.getClientRects().length && getComputedStyle(node).visibility === 'visible') : [];
    const sameClass = node => node.className === opener.className, sameText = node => node.textContent === opener.textContent;
    shell.state.returnFocus = candidates.find(node => sameClass(node) && sameText(node)) || candidates.find(sameClass) || candidates.find(sameText) || candidates[0] || null;
  }
  function render(force = false) {
    const frame = shell.activeMemberFrame() || root.querySelector('.full-context iframe[data-hosted-app]');
    if (force !== true && frame && (shell.state.modal?.kind === 'embed' || (state.embed && frame.dataset.hostedApp === state.selected))) { dirty = true; return; }
    const editing = document.activeElement, edit = editing && ['message-input', 'ask-input'].includes(editing.id)
      ? { id: editing.id, value: editing.value, start: editing.selectionStart, end: editing.selectionEnd, direction: editing.selectionDirection } : null;
    // A notice survives the re-render an async read triggers right after it (the shell clears it on its own timer).
    const notice = (document.getElementById('toast') || {}).textContent || '';
    const opener = shell.state.returnFocus;
    root.innerHTML = shell.workNotice() + ({ studio, jarvis, orbit, commons }[layout])() + `<div class="toast" id="toast" role="status" aria-live="polite">${esc(notice)}</div><div id="modal-host"></div>`;
    preserveModalOpener(opener);
    if (shell.state.modal) shell.renderModal();
    const app = selected(); if (app && !state.embed) shell.fillSummary(app);
    if (app && (layout === 'studio' || layout === 'orbit')) shell.fillDetail(app);
    if (layout === 'commons') shell.fillRoster();
    shell.fillVisuals();
    const current = edit && document.getElementById(edit.id);
    if (current && !current.disabled && current.value === edit.value) { current.focus(); current.setSelectionRange(edit.start, edit.end, edit.direction); }
    if (state.embed && app) shell.restoreMemberTool(app, state.memberTools[app.id]);
  }
  function chooseApp(id) { if (!shell.contextFor(shell.byId(id))) return; state.selected = id; state.navOpen = false; state.embed = false; if (layout === 'orbit') state.orbitSuite = shell.byId(id).suite; save(); render(); }
  async function send(prompt) {
    const t = activeThread(); if (t.busy) { shell.toast('Jarvis is still answering the last message.'); return; }
    state.drafts[contextKey()] = ''; save();
    const result = await t.send(prompt, render, selectedContext());
    if (result && result.status === 'done') { shell.toast('Jarvis answered.'); const input = document.getElementById('message-input'); if (input) input.focus(); }
  }
  function bindEvents() {
    root.addEventListener('click', e => {
      const target = e.target.closest('[data-action]'); if (!target) return;
      const a = target.dataset.action, id = target.dataset.app, suite = target.dataset.suite;
      if (a === 'settings') { shell.open('settings'); return; }
      if (shell.handle(a, target)) return;
      if (a === 'select-app') return chooseApp(id);
      if (a === 'use-context') { const app = shell.byId(id); if (!shell.contextFor(app)) { shell.toast('That application is not available as your context.'); return; } shell.close(); if (layout === 'commons') { state.room = gameApps().some(g => g.id === id) ? 'games' : app.suite; state.roomTab = 'conversation'; } chooseApp(id); shell.toast(layout === 'commons' ? `Opened the room for ${app.name}.` : `${app.name} is now your context.`); return; }
      if (a === 'toggle-embed') { state.embed = !state.embed; save(); render(); return; }
      if (a === 'orbit-suite') { state.orbitSuite = suite; const s = shell.suiteOf(suite); if (s.spotlight) state.selected = s.spotlight.id; save(); render(); return; }
      if (a === 'orbit-back') { state.orbitSuite = ''; save(); render(); return; }
      if (a === 'room') { state.room = suite; state.roomTab = 'conversation'; state.navOpen = false; save(); render(); const t = roomThread(); if (!t.loaded) t.load().then(render); return; }
      if (a === 'room-tab') { state.roomTab = target.dataset.tab; save(); render(); const tab = root.querySelector(`[data-tab="${state.roomTab}"]`); if (tab) tab.focus(); return; }
      if (a === 'menu') { state.navOpen = !state.navOpen; render(); return; }
      if (a === 'prompt') { shell.close(); return send(target.dataset.prompt); }
      if (a === 'ask') { shell.open('ask'); return; }
      // Commons' Room details and Private rail open their panels (the content existed; the buttons opened nothing).
      if (a === 'room-details' || a === 'private') { shell.open(a); return; }
      if (a === 'new') { if (layout === 'commons') { LIVE.prefs.set(`room-thread:${state.room}`, LIVE.prefs.get(`room-thread:${state.room}`, 0) + 1); roomThreads.delete(state.room); } else { thread = shell.createThread(LIVE.rollSession(), 'Jarvis'); thread.loaded = true; } state.drafts[contextKey()] = ''; save(); render(); const input = document.getElementById('message-input'); if (input) input.focus(); shell.toast('Started a fresh conversation.'); return; }
      if (a === 'home') { window.scrollTo({ top: 0, behavior: 'auto' }); }
    });
    root.addEventListener('input', e => { if (e.target.id === 'ask-input') { state.askDrafts[contextKey()] = e.target.value; save(); } if (e.target.id === 'message-input') { state.drafts[contextKey()] = e.target.value; save(); } });
    root.addEventListener('submit', e => {
      e.preventDefault();
      if (e.target.id === 'message-form') send(document.getElementById('message-input').value);
      if (e.target.id === 'ask-form') { const input = document.getElementById('ask-input'); const q = input.value; if (!q.trim() || thread.busy) return; input.value = ''; state.askDrafts[contextKey()] = ''; save(); thread.send(q, () => { const host = document.getElementById('ask-response'); if (host) host.innerHTML = shell.threadHtml(thread); if (!shell.state.modal) render(); }, selectedContext()); }
    });
    root.addEventListener('keydown', e => {
      if (e.target.id === 'message-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.target.value); }
      if (e.target.getAttribute('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { const tabs = ['conversation', 'apps', 'board'], i = tabs.indexOf(state.roomTab); state.roomTab = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[2] : tabs[(i + (e.key === 'ArrowRight' ? 1 : 2)) % 3]; e.preventDefault(); save(); render(); const tab = root.querySelector(`[data-tab="${state.roomTab}"]`); if (tab) tab.focus(); }
    });
  }
})();
