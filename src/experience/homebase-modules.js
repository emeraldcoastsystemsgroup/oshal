/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Homebase modules built from the design study over live data, rendered in the homebase's own classes: the opt-in check-in panel (the caller's own place from ADR-169 location state, household members with no check-in shown because no group presence read exists, the "share from this browser" switch and who can see the caller), the room strip (the home assistant and the household), the Family admin card with its People & roles and Devices dialogs (household members and roles from the caller's group, location devices with stop reporting), a learner's level progress and Little Monsters notices.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Routines (Jarvis briefing sources and the caller's schedules, added by asking Jarvis), search in this home (what the page read plus the caller-scoped global search), files (Jarvis task files and saved drafts), tasks (open work and open classwork), the day-grouped agenda with a read-only event dialog, the assistant bubble and inline composer, the room tabs and the "Make it yours" choices (how the assistant offers help, what greets you, what stays close at hand).
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Match shared search and assistant wording to the active home, workspace or classroom.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Name the active space in the people strip accessibility label.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Name operational panels directly while preserving data, access rules, actions and visual styles.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HOMEBASE_MODULES = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** The Settings, Location page: turning a check-in on needs its fresh sign-in and the browser's permission there. */
  const LOCATION_SETTINGS = '/cockpit/tools/location.html';
  const PRECISION = { exact: 'exact', block: 'block (about 110 m)', city: 'city (about 1 km)', 'place-only': 'place only' };

  /**
   * @description Bind the homebase's new modules to its render context. Every renderer reads the context at call time,
   * so a repaint after a load shows the latest answer; nothing here fetches.
   * @param {object} ctx The homebase context: markup helpers (esc, btn, link, pill, head, avatar), LIVE, the live `data`
   * object, `state`, `preset`, `key`, `config()` and accessors (me, displayName, snapshot, isTeacher, isLearner, toolById, app, thread, openWork, events, assignments).
   * @returns {object} The renderers.
   */
  function create(ctx) {
    const space = ctx.key === 'company' ? 'workspace' : ctx.key === 'classroom' ? 'classroom' : 'home';
    const { esc, btn, link, pill, head, avatar, LIVE } = ctx;
    const ago = d => LIVE.relativeTime(d);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
    const dayLabel = d => { const t = new Date(); t.setHours(0, 0, 0, 0); const diff = Math.round((d - t) / 86400000); return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }); };
    const members = () => (ctx.data.group && ctx.data.group.ok && ctx.data.group.members) || [];
    const memberName = m => m.self ? ctx.displayName() : (m.name || 'Household member');

    /* ── check-ins ───────────────────────────────────────────────── */
    /** @description Why the location state is not shown: the route's own message when it sent one, else the status. */
    function locationRefusal(loc) {
      // The location router answers /state or refuses with 401/403; a 404 means the route is not on this swarm.
      if (loc.status === 404) return 'Location is not set up on this swarm (HTTP 404).';
      return `${loc.message || 'Your check-in could not be read.'} (HTTP ${loc.status || 'network'}${loc.code ? `: ${loc.code}` : ''})`;
    }
    const placeText = loc => loc.current ? (loc.current.place ? `At ${loc.current.place.name}` : 'Outside your saved places') : (loc.reporting ? 'No place yet' : 'Not sharing');
    const stampText = loc => loc.current ? `Updated ${ago(new Date(Date.now() - loc.current.ageSeconds * 1000))}` : (loc.reporting ? 'Waiting for the first check-in' : 'Reporting is off');
    /** @description Who can see the caller, from "who can see me": member shares granted to groups and guardian shares naming them. */
    function visibilityText(loc) {
      const shared = loc.memberShares.map(s => s.group || 'a group you left');
      const guardian = loc.guardianShares.map(s => `${s.group || 'a group'} (${plural(s.grantees, 'person', 'people')})`);
      return [shared.length ? `You share your check-in with ${shared.join(', ')}.` : 'Nobody else can see your check-in.', guardian.length ? `A guardian share names you in ${guardian.join(', ')}.` : ''].filter(Boolean).join(' ');
    }
    /**
     * @description The opt-in check-in panel: the caller's own place (never coordinates), household members with nothing
     * shown for them (no group presence read exists), the switch for this browser's reporting and who can see the caller.
     * @returns {string} Markup.
     */
    function locations() {
      const loc = ctx.data.loc;
      const body = !loc ? '<p class="subtle">Reading your check-in…</p>' : !loc.ok ? `<p class="subtle">${esc(locationRefusal(loc))}</p>`
        : `<div class="location-grid"><article class="location-person" data-person="me"><div class="member-line">${avatar(ctx.me().initials, 0)}<strong>${esc(ctx.displayName())} · you</strong></div><p>${esc(placeText(loc))}</p><small>${esc(stampText(loc))}</small></article>${members().filter(m => !m.self).map((m, i) => `<article class="location-person" data-person="member"><div class="member-line">${avatar(LIVE.initials(memberName(m)), i + 1)}<strong>${esc(memberName(m))}</strong></div><p>Not shown</p><small>No check-in is shared with you</small></article>`).join('')}</div>`;
      const note = loc && loc.ok ? `${visibilityText(loc)} Places come from Location as names, never coordinates. Seeing each other’s check-ins needs group sharing, which this swarm does not offer yet.` : 'Each person chooses whether to share. Nothing is shared by joining a home.';
      const toggle = loc && loc.ok ? `<label class="sharing-toggle">Share my check-in from this browser<input type="checkbox" id="share-location" ${loc.thisDevice && loc.thisDevice.reporting ? 'checked' : ''}></label>` : '';
      return `<section class="panel" data-module="locations">${head('Check-ins', pill('Opt-in check-ins'))}${body}<p class="subtle location-note">${esc(note)}</p>${toggle}</section>`;
    }
    /** @description Turning a check-in on happens in Settings, Location: it needs a fresh sign-in (the step-up) and the browser's location permission. */
    function locationOnDialog() {
      return ['Turn on your check-in', `<p>Turning on needs a fresh sign-in and your browser’s permission, so it happens in Settings, Location. You choose how precise it is there, and turning it on shares it with no one.</p><div class="dialog-actions">${link('Open Settings, Location ↗', LOCATION_SETTINGS, 'button primary', 'target="_blank" rel="noopener"')}${btn('Not now', 'close')}</div><p class="subtle">This home re-reads your check-in when you come back to it.</p>`];
    }
    /** @description The caller's location devices: this browser marked, reporting state, precision and last seen, with stop reporting for each reporting device. */
    function devicesDialog() {
      const loc = ctx.data.loc;
      if (!loc || !loc.ok) return ['Devices', `<p>${esc(loc ? locationRefusal(loc) : 'Reading your devices…')}</p>`];
      const rows = loc.devices.map(d => `<div class="list-item device-row" data-device="${esc(d.id)}"><span><span class="item-title">${esc(d.thisBrowser ? 'This browser' : d.kind || 'Device')}</span><small>${d.reporting ? 'Reporting' : 'Not reporting'} · ${esc(PRECISION[d.precisionClass] || d.precisionClass)}${d.lastSeenAt ? ` · last seen ${esc(ago(new Date(d.lastSeenAt)))}` : ''}</small></span>${d.reporting ? btn('Stop reporting', 'device-stop', 'button', `data-device="${esc(d.id)}"`) : ''}</div>`).join('');
      return ['Devices', `<p>The devices that can report your check-in. Stopping one clears your current place; your history stays until you delete it in Settings, Location.</p><div class="list-items">${rows || '<p class="subtle">No device reports your check-in.</p>'}</div><p class="subtle" id="device-feedback" role="status"></p><div class="dialog-actions">${link('Open Settings, Location ↗', LOCATION_SETTINGS, 'button primary', 'target="_blank" rel="noopener"')}</div>`];
    }

    /* ── the household ───────────────────────────────────────────── */
    /** @description The room strip: the home's assistant (with the swarm's online count) and the household's people and roles; people carry no online state because no presence source exists. */
    function room() {
      const snap = ctx.snapshot(), rows = members().length ? members() : [{ self: true, role: '' }];
      const host = `<div class="room-person" data-person="assistant"><span class="room-avatar"><span class="assistant-orb" aria-hidden="true"></span>${snap.botsOnline ? '<span class="presence-dot" aria-hidden="true"></span>' : ''}</span><div><strong>${esc(ctx.preset.assistantLabel)}</strong><small>Room host · ${snap.botsOnline} of ${snap.bots.length} assistants online</small></div></div>`;
      const people = rows.slice(0, 5).map((m, i) => `<div class="room-person"><span class="room-avatar">${avatar(LIVE.initials(memberName(m)), i)}</span><div><strong>${esc(memberName(m))}${m.self ? ' · you' : ''}</strong><small>${m.role === 'admin' ? 'Admin' : m.role === 'member' ? 'Member' : 'Signed in'}</small></div></div>`).join('');
      return `<section class="room-strip" data-module="room" aria-label="People in this ${space}">${host}${people}</section>`;
    }
    /** @description The household line on the Family admin card: its name and size, or how to start one. */
    function groupLine() {
      const g = ctx.data.group;
      if (!g) return 'Reading your household…';
      if (!g.ok) return `Your household could not be read (HTTP ${g.status || 'network'}).`;
      return g.group ? `${plural(members().length, 'person', 'people')} in ${g.group.name}` : 'Set up your household';
    }
    /** @description The Family admin card: People & roles (the caller's household group) and Devices (their location devices). */
    function familyAdmin() {
      const loc = ctx.data.loc, devices = loc && loc.ok ? plural(loc.devices.length, 'device') + (loc.reporting ? ' · reporting' : '') : 'Where your check-in comes from';
      return `<section class="panel" data-module="family-admin"><div class="panel-kicker">HOUSEHOLD</div>${head('Family admin')}<button type="button" class="admin-link" data-action="people-roles"><span class="nav-symbol" aria-hidden="true">◎</span><span><strong>People & roles</strong><small>${esc(groupLine())}</small></span><span aria-hidden="true">›</span></button><button type="button" class="admin-link" data-action="devices"><span class="nav-symbol" aria-hidden="true">▢</span><span><strong>Devices</strong><small>${esc(devices)}</small></span><span aria-hidden="true">›</span></button></section>`;
    }
    /** @description People & roles: the household's members and roles, or (with none) a form that creates one with the caller as its admin. */
    function peopleRolesDialog() {
      const g = ctx.data.group;
      if (!g) return ['People & roles', '<p>Reading your household…</p>'];
      if (!g.ok) return ['People & roles', `<p>Your household could not be read (HTTP ${g.status || 'network'}${g.code ? `: ${esc(g.code)}` : ''}).</p>`];
      if (!g.group) return ['People & roles', '<p>You are not in a household yet. Create one and you become its admin; an admin adds the others.</p><form id="household-form"><label class="field">Household name<input id="household-name" maxlength="120" required placeholder="Our home"></label><div class="dialog-actions"><button class="button primary" type="submit">Create household</button></div><p class="subtle" id="household-feedback" role="status"></p></form>'];
      const rows = members().map((m, i) => `<div class="member-line people-role">${avatar(LIVE.initials(memberName(m)), i)}<span>${esc(memberName(m))}${m.self ? ' · you' : ''}<small>${m.role === 'admin' ? 'Admin' : 'Member'}</small></span></div>`).join('');
      return [`People & roles · ${g.group.name}`, `<div class="side-section">${rows || '<p class="subtle">No members could be listed.</p>'}</div><p>Names appear where this swarm’s directory shares them with you. Admins add and remove members. Managing members does not open anyone’s private calendar, files or conversations.</p>`];
    }

    /* ── routines ────────────────────────────────────────────────── */
    function briefingRow(s) {
      return `<label class="list-item routine-row"><input type="checkbox" data-briefing="${esc(s.id)}" ${s.enabled ? 'checked' : ''}><span><span class="item-title">${esc(s.title)}</span><small>${esc([s.description, s.frequency.replace(/-/g, ' '), `by ${s.channel}`].filter(Boolean).join(' · '))}</small></span></label>`;
    }
    function scheduleRow(s) {
      const at = s.nextRunAt ? new Date(s.nextRunAt) : null;
      // relativeTime reads the past only; a next run is a future moment, so it is named by its day and time.
      const next = !s.paused && at && !isNaN(at) ? ` · next ${esc(at.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : '';
      return `<div class="list-item routine-row" data-schedule="${esc(s.id)}"><span><span class="item-title">${esc(s.title)}</span><small>${esc(s.when)}${s.paused ? ' · paused' : next}${s.once ? ' · once' : ''}</small></span>${btn(s.paused ? 'Resume' : 'Pause', 'schedule-toggle', 'button', `data-schedule="${esc(s.id)}" data-paused="${s.paused}"`)}</div>`;
    }
    const refusedLine = (r, what) => `<p class="subtle">${esc(what)} could not be read (HTTP ${r.status || 'network'}${r.code ? `: ${esc(r.code)}` : ''}).</p>`;
    /** @description Routines: the briefing sources the caller may hear (on or off) and their own schedules (pause, resume), with a sentence to Jarvis to add one. */
    function routinesPage() {
      const r = ctx.data.routines;
      if (!r) return '<section class="panel" data-module="routines"><h2>Routines</h2><p class="subtle">Reading your routines…</p></section>';
      const b = r.briefings, s = r.schedules;
      const briefings = !b.ok ? refusedLine(b, 'Your briefings') : b.sources.length ? `<div class="list-items">${b.sources.map(briefingRow).join('')}</div>` : '<p class="subtle">No briefing source is available to you.</p>';
      const schedules = !s.ok ? refusedLine(s, 'Your schedules') : s.rows.length ? `<div class="list-items">${s.rows.map(scheduleRow).join('')}</div>` : '<p class="subtle">You have no schedules yet.</p>';
      return `<section class="panel" data-module="routines"><div class="panel-kicker">FOR THIS ${space.toUpperCase()}</div>${head('Routines')}<h3>Briefings</h3>${briefings}<h3>Scheduled</h3>${schedules}<form id="routine-form" class="add-form"><label class="screenreader" for="routine-input">Ask Jarvis for a routine</label><input id="routine-input" maxlength="300" required placeholder="Every Saturday at 8:30, prepare a weekend brief"${ctx.thread().busy ? ' disabled' : ''}><button class="button" type="submit" aria-label="Ask Jarvis">→</button></form><p class="subtle" id="routine-feedback" role="status">Jarvis turns a sentence with a time into one of your schedules.</p></section>`;
    }

    /* ── search, files, tasks ────────────────────────────────────── */
    const KIND_LABEL = { events: 'Calendar', items: 'Shopping list', classwork: 'Classwork', tools: 'Opens here', apps: 'Application', work: 'Work' };
    function localRow(m) {
      const attrs = m.kind === 'events' ? `data-action="event-detail" data-event="${esc(m.id)}"` : m.kind === 'items' ? 'data-action="page" data-page="shopping"' : m.kind === 'classwork' ? 'data-action="learning"'
        : m.kind === 'tools' ? `data-action="tool" data-tool="${esc(m.id)}"` : m.kind === 'apps' ? `data-action="app" data-app="${esc(m.id)}"` : `data-action="project" data-work="${esc(m.id)}"`;
      return `<button type="button" class="search-row" ${attrs}><span class="item-title">${esc(m.title)}</span><small>${esc(KIND_LABEL[m.kind] || m.kind)}${m.detail ? ` · ${esc(m.detail.slice(0, 90))}` : ''}</small></button>`;
    }
    function globalRow(h) {
      const href = h.url ? LIVE.localHref(h.url) : '';
      const inner = `<span class="item-title">${esc(h.title)}</span><small>${esc(h.kind || h.source)}${h.snippet ? ` · ${esc(h.snippet.slice(0, 120))}` : ''}${href ? '' : ' · no page to open'}</small>`;
      return href ? `<a class="search-row" href="${esc(href)}">${inner}</a>` : `<div class="search-row">${inner}</div>`;
    }
    /** @description Search results: matches in what this home read, then the caller-scoped swarm search (its refusal named). */
    function searchPage() {
      const s = ctx.state.search || { query: '', local: [], global: null };
      const g = s.global, count = s.local.length + (g && g.ok ? g.hits.length : 0);
      const swarm = !g ? '<p class="subtle">Searching the rest of your swarm…</p>' : !g.ok ? refusedLine(g, 'The swarm search') : g.hits.length ? g.hits.map(globalRow).join('') : '<p class="subtle">Nothing else in your swarm matches.</p>';
      return `<section class="panel" data-module="search"><div class="panel-kicker">SEARCH IN ${esc(ctx.preset.name.toUpperCase())}</div>${head(esc(plural(count, 'match', 'matches')))}<p class="subtle">For “${esc(s.query)}” · only your own data</p><h3>In this ${space}</h3>${s.local.length ? s.local.map(localRow).join('') : `<div class="empty">No matches in this ${space}.</div>`}<h3>Across your swarm</h3>${swarm}</section>`;
    }
    /** @description Files: every file your finished Jarvis tasks produced, newest first, and your saved drafts (filled by the drafts read). */
    function filesPage() {
      const rows = ctx.snapshot().work.filter(w => w.kind === 'task' && w.files && w.files.length).flatMap(w => w.files.map(f => ({ f, w })));
      const list = rows.map(({ f, w }) => `<div class="list-item"><span><span class="item-title">${ctx.S.fileLink(f) || esc(f.name || 'file')}</span><small>${esc(w.title)} · ${esc(w.at ? ago(w.at) : 'unknown time')}</small></span></div>`).join('');
      return `<section class="panel" data-module="files"><div class="panel-kicker">JUST FOR YOU</div>${head('Files and drafts')}<h3>Files from your assistant</h3><div class="list-items">${list || '<p class="subtle">No finished Jarvis task has produced a file yet.</p>'}</div><div id="drafts-slot">${ctx.data.draftsHtml || '<p class="subtle">Reading your drafts…</p>'}</div></section>`;
    }
    /** @description Tasks: your open tickets and assistant tasks, and open classwork when Little Monsters answers for you. */
    function tasksPage() {
      const open = ctx.openWork(), classwork = ctx.assignments();
      const work = open.slice(0, 12).map(w => `<div class="list-item"><span><span class="item-title">${esc(w.title)}</span><small>${esc(w.appName)} · ${esc(w.status.label)} · ${esc(ago(w.at))}</small></span>${btn('Open ↗', 'project', 'button', `data-work="${esc(w.id)}"`)}</div>`).join('');
      const school = classwork.map(a => `<div class="list-item"><span><span class="item-title">${esc(a.title)}</span><small>${esc(a.class_name || 'Class')}${a.due_date ? ` · due ${esc(ctx.dueOn(a.due_date))}` : ''}</small></span></div>`).join('');
      return `<section class="panel" data-module="tasks"><div class="panel-kicker">${esc(ctx.preset.name.toUpperCase())}</div>${head('Tasks', pill(`${open.length + classwork.length} open`))}<h3>Work</h3><div class="list-items">${work || '<p class="subtle">No open tickets or assistant tasks.</p>'}</div>${ctx.data.edu && ctx.data.edu.ok ? `<h3>Classwork</h3><div class="list-items">${school || '<p class="subtle">No open classwork.</p>'}</div>` : ''}</section>`;
    }

    /* ── calendar ────────────────────────────────────────────────── */
    /** @description The whole upcoming calendar grouped by day (the Calendar page), each event opening its details. */
    function dayAgenda() {
      const groups = window.HOMEBASE_DATA.dayGroups(ctx.events().slice(0, 40));
      if (!groups.length) return '';
      return `<section class="panel" data-module="agenda"><div class="panel-kicker">COMING UP</div>${head('Upcoming schedule')}${groups.map(g => `<div class="day-group"><h3>${esc(dayLabel(g.day))}</h3>${g.events.map(e => `<button type="button" class="agenda-row" data-action="event-detail" data-event="${esc(e.event_id)}"><time>${esc(e.event_time ? LIVE.clockTime(e.when) : 'All day')}</time><span>${esc(e.title)}<small>${esc(e.class_name || 'Personal')}</small></span></button>`).join('')}</div>`).join('')}</section>`;
    }
    /** @description One event's details as Little Monsters recorded them; it offers no change because the package has no event update route. */
    function eventDialog(id) {
      const e = ctx.events().find(x => String(x.event_id) === String(id)); if (!e) return ['', ''];
      const facts = [['When', `${dayLabel(e.when)}${e.event_time ? ` · ${LIVE.clockTime(e.when)}` : ' · all day'}`], ['Class', e.class_name ? `${e.class_name}${e.subject ? ` · ${e.subject}` : ''}` : 'Personal'], ['Kind', e.event_type && e.event_type !== 'custom' ? e.event_type : 'Event']];
      const myDay = ctx.toolById('tool-lm-myday'), lm = ctx.app('little-monsters');
      return [e.title, `<dl class="ticket-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl><p class="subtle">From Little Monsters. Its calendar offers no way to move an event from here.</p><div class="dialog-actions">${myDay ? btn('Open My Day here', 'tool', 'button primary', 'data-tool="tool-lm-myday"') : ''}${lm ? link('Open Little Monsters ↗', lm.href, myDay ? 'button' : 'button primary') : ''}</div>`];
    }

    /* ── learner progress and notices ────────────────────────────── */
    /** @description A learner's own progress from Little Monsters: level, XP toward the next level, streak, quizzes and flashcards. It is the learner's activity, never classwork completion. */
    function progressBlock() {
      const p = ctx.data.progress;
      if (!p) return '';
      if (!p.ok) return `<p class="subtle">Your progress could not be read (HTTP ${p.status || 'network'}).</p>`;
      const bar = p.span ? `<div class="progress-track" role="progressbar" aria-label="XP toward level ${p.span.next}" aria-valuemin="0" aria-valuemax="${p.span.need}" aria-valuenow="${p.span.into}"><span style="width:${Math.min(100, Math.round(p.span.into / p.span.need * 100))}%"></span></div><p class="subtle">${p.span.into} of ${p.span.need} XP toward level ${p.span.next}</p>` : '';
      const facts = [p.streak ? `${p.streak}-day streak` : '', p.quizCount ? `quiz average ${p.quizAverage}%` : '', p.cards ? `${plural(p.cards, 'card')} reviewed` : ''].filter(Boolean);
      return `<div class="focus-count" data-progress="level">Level ${p.level}<span class="focus-unit"> · ${p.xp} XP</span></div>${bar}${facts.length ? `<p class="subtle">${esc(facts.join(' · '))}</p>` : ''}`;
    }
    /** @description Unread Little Monsters notices as noticeboard rows, each with mark as read. */
    function notices() {
      const n = ctx.data.notices;
      if (!n || !n.ok) return '';
      return n.items.filter(x => !x.read).slice(0, 3).map(x => `<div class="update notice" data-notice="${esc(x.id)}"><strong>${esc(x.title)}</strong><p>${esc(x.body.slice(0, 200))}</p><small>${esc(x.sentAt ? ago(new Date(x.sentAt)) : 'Little Monsters')} · Little Monsters ${btn('Mark read', 'notice-read', 'text-button', `data-notice="${esc(x.id)}"`)}</small></div>`).join('');
    }

    /* ── the assistant, tabs and choices ─────────────────────────── */
    /** @description The assistant bubble: the newest answer in this home's Jarvis thread, else (unless the device chose "waiting for me to ask") a catch-up of assistant tasks that finished in the last day, dismissed on this device. */
    function bubble() {
      const replies = ctx.thread().turns.filter(t => t.role === 'jarvis'), latest = replies.slice(-1)[0], last = replies.filter(t => !t.pending).slice(-1)[0];
      if (latest && latest.pending) return `<div class="assistant-bubble" data-bubble="pending"><div class="bubble-by"><strong>${esc(ctx.preset.assistantLabel)}</strong><span class="subtle">Working</span></div><p class="subtle">${esc(latest.text)}</p></div>`;
      if (last) return `<div class="assistant-bubble" data-bubble="reply"><div class="bubble-by"><strong>${esc(ctx.preset.assistantLabel)}</strong><span class="subtle">${last.error ? 'Could not answer' : 'Latest reply'}</span></div>${last.error ? `<p class="subtle">${esc(last.text)}</p>` : ctx.S.answerHtml(String(last.text).slice(0, 600))}<div class="dialog-actions">${btn('Open the conversation', 'ask', 'button')}</div></div>`;
      const since = Date.now() - 86400000, done = ctx.snapshot().work.filter(w => w.kind === 'task' && !w.status.open && w.at && w.at.getTime() > since);
      const sig = done.map(w => w.id).join(',');
      if (!done.length || ctx.bubbleSeen() === sig || ctx.config().bot === 'ask') return '';
      const failed = done.filter(w => w.status.label === 'Failed').length;
      return `<div class="assistant-bubble" data-bubble="catch-up"><div class="bubble-by"><strong>${esc(ctx.preset.assistantLabel)}</strong><span class="subtle">Catch-up</span></div><p>While you were away: ${esc(plural(done.length - failed, 'task'))} finished${failed ? ` and ${esc(plural(failed, 'task'))} failed` : ''}.</p><div class="dialog-actions">${btn('Show files', 'page', 'button', 'data-page="files"')}${btn('Not now', 'bubble-dismiss', 'button', `data-seen="${esc(sig)}"`)}</div></div>`;
    }
    /** @description The inline composer: a question typed here goes to the same Jarvis thread the Ask dialog uses. */
    function composer() {
      const busy = ctx.thread().busy;
      return `<form id="composer-form" class="composer"><label class="screenreader" for="composer-input">Ask ${esc(ctx.preset.assistantLabel.toLowerCase())}</label><input id="composer-input" maxlength="600" autocomplete="off" placeholder="${esc(ctx.preset.assistantPrompt)}"${busy ? ' disabled' : ''}><button class="button primary" type="submit" aria-label="Send"${busy ? ' disabled' : ''}>↑</button></form>`;
    }
    /** @description The room tabs a preset declares (Room, Tasks, Files …) with "Display options" beside them. */
    function roomTabs() {
      const tabs = ctx.preset.tabs || [];
      if (!tabs.length) return '';
      return `<nav class="room-tabs" aria-label="Room sections">${tabs.map(([id, label]) => btn(esc(label), 'page', 'room-tab', `data-page="${id}" ${ctx.state.page === id ? 'aria-current="page"' : ''}`)).join('')}${ctx.canConfigure() ? btn('Display options', 'configure', 'text-button room-customize') : ''}</nav>`;
    }
    /** @description The configure dialog's layout choices, saved on this device: how the assistant offers help, what greets you first, and which modules stay on the front page. */
    function configExtras() {
      const c = ctx.config(), hide = c.hide || [];
      const lead = [['room', 'The room · the preset’s order'], ['day', 'My day · the calendar first'], ['work', 'The work · open items first']];
      const keep = [['room', `People in this ${space}`], ['calendar', 'Calendar'], ['shopping', 'Shopping list']];
      const bot = `<label class="field">Your assistant helps by<select id="bot-choice"><option value="suggest" ${c.bot !== 'ask' ? 'selected' : ''}>Offering a catch-up of finished work</option><option value="ask" ${c.bot === 'ask' ? 'selected' : ''}>Waiting for me to ask</option></select></label>`;
      return `${bot}<fieldset class="config-fieldset"><legend>What greets you?</legend>${lead.map(([v, l]) => `<label class="config-check"><input type="radio" name="lead-choice" value="${v}" ${(c.lead || 'room') === v ? 'checked' : ''}>${l}</label>`).join('')}</fieldset><fieldset class="config-fieldset"><legend>Keep close at hand</legend>${keep.map(([v, l]) => `<label class="config-check"><input type="checkbox" data-keep="${v}" ${hide.includes(v) ? '' : 'checked'}>${l}</label>`).join('')}</fieldset>`;
    }
    /**
     * @description A front-page column after the device's layout choices: modules unticked under "Keep close at hand"
     * drop out, and in the main column "My day" moves the calendar to the front and "The work" moves open work there.
     * @param {Array<string|object>} entries The preset's declared column.
     * @param {boolean} main Whether it is the main column (only the main column takes the lead choice).
     * @returns {Array<string|object>} The column to render.
     */
    function arrange(entries, main) {
      const c = ctx.config(), hide = c.hide || [];
      let list = (entries || []).filter(e => typeof e !== 'string' || !hide.includes(e));
      const lead = !main ? '' : c.lead === 'day' ? 'calendar' : c.lead === 'work' ? 'projects' : '';
      if (lead && !hide.includes(lead)) list = [lead].concat(list.filter(e => e !== lead));
      return list;
    }

    return { locations, locationOnDialog, devicesDialog, room, familyAdmin, peopleRolesDialog, routinesPage, searchPage, filesPage, tasksPage, dayAgenda, eventDialog, progressBlock, notices, bubble, composer, roomTabs, configExtras, arrange };
  }

  return { create: create, LOCATION_SETTINGS: LOCATION_SETTINGS };
});
