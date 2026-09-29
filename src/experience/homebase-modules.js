/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Homebase modules built from the design study over live data, rendered in the homebase's own classes: the opt-in check-in panel (the caller's own place from ADR-169 location state, household members with no check-in shown because no group presence read exists, the "share from this browser" switch and who can see the caller), the room strip (the home assistant and the household), the Family admin card with its People & roles and Devices dialogs (household members and roles from the caller's group, location devices with stop reporting), a learner's level progress and Little Monsters notices.
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
    const { esc, btn, link, pill, head, avatar, LIVE } = ctx;
    const ago = d => LIVE.relativeTime(d);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
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
      return `<section class="panel" data-module="locations">${head('A little peace of mind.', pill('Opt-in check-ins'))}${body}<p class="subtle location-note">${esc(note)}</p>${toggle}</section>`;
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
      return `<section class="room-strip" data-module="room" aria-label="People in this home">${host}${people}</section>`;
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

    return { locations, locationOnDialog, devicesDialog, room, familyAdmin, peopleRolesDialog, progressBlock, notices };
  }

  return { create: create, LOCATION_SETTINGS: LOCATION_SETTINGS };
});
