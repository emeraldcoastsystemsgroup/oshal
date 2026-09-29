/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Homebase shells (Home, Little Monsters classroom, Business) over live data: the signed-in person, Little Monsters identity/classes/assignments/roster/calendar, the Purchasing list, the Finance snapshot (a calm personal picture at home, a dense account table at work), Smart Home facts, open tickets as projects, application summaries as the noticeboard, and the real Jarvis thread. The role switcher, fixture people and sample records of the prototype are gone; teacher and learner views follow the caller's actual classroom role, and display choices are saved on this device only.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | A preset hosts an assembly of applications: one ribbon profile per host, tools tagged with their host and grouped per host in the sidebar and the tile row, the preset's audience view requested on every hosted page (`?view=`), hidden prefixes curating off-audience tiles; teacher-only gating left the client because the profile now arrives filtered per caller.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | A preset can host its application: the classroom lists Little Monsters' admitted tools (from the same ribbon profile the cockpit renders, per-class tools kept out of the navigation, teacher-only tools shown to teachers) and opens them in place in a frame that follows the skin; the frame's navigation messages (the cockpit's own shapes) switch tools, and only admitted tools ever open. The home paints from identity and catalog (readyCore) and fills work in when it arrives.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Paint the preset skin on load when the device remembers none: the style switcher initialises before this script selects the preset, so the default was never applied to the document.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | The hosted page is asked for its audience with `?audience=` (was `?view=`): store pages and the cockpit already use `view` for their own tabs, so the audience request must not collide with them
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Close the homebase gaps over existing routes: the teacher roster shows each learner's Little Monsters activity (level, streak, quiz average, cards reviewed) and a class summary from the teacher analytics read, labelled as activity, never completion; teachers post classwork from the shell to the package route that also writes the class calendar event; a ticket's project dialog reads its current state, reason and next action and offers "Approve" (approval_required to approved) only when a human approval is what it waits for, rendering the route's refusal; the personal workspace lists the caller's saved drafts and newest finished Jarvis task; the learner checklist opens My Day in place; "Configure home" is hidden for guests. The open dialog now survives a repaint with its record id.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | The ticket action reads 'Approve': the route moves Approval Required to Approved, and what follows depends on the ticket (dispatch, resume), so the label names only the transition
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Integration review: the ticket dialog shows Reason and Next action only when metadata.lastStatusTransition describes the ticket's current status, read from that transition itself; the row-level reason/nextAction fields are written at creation and by transitions that carry them, so after a later transition without metadata they can describe an older state (an approved ticket kept its approval-gate reason), and a ticket created in its state has no mirror and shows State alone. Otherwise the dialog shows State alone. "My drafts" names what it reads: the caller's saved Content Studio drafts.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Fix round 1: row 8's reason corrected. Ticket creation also writes the row-level reason/nextAction (ticket-service createTicket, with no lastStatusTransition), so a ticket created directly in approval_required shows State alone; no dialog behaviour changed.
 * 10 | maintainer@emeraldcoastsystemsgroup.com | Acceptance fixes: the family and company homes read Little Monsters' read-only home-summary probe first and call /api/education/* only when it answers 200 (those routes can provision a learner row), and send nothing for an entry the plan does not admit; the family home's Little Monsters ribbon profile is gated the same way, because the profile asks the package's visibility route, which provisions too (proven in the acceptance sandbox). The classroom still reads them. A refusal names itself: not admitted reads "Little Monsters is not available to you", no school profile reads "Open Little Monsters once to set up your school profile", anything else shows its status. Due, event and last-active dates are read as the calendar day they name (LIVE.calendarDay). The learner card drops the classwork done/total count and progress bar (assignment status is class-wide, not per learner). Tickets awaiting approval lead the six project rows. A timed calendar event shows its day as well as its time.
 * 11 | maintainer@emeraldcoastsystemsgroup.com | A hosted tool opens in view: after the tool page renders, the tool shell is scrolled to the top of the viewport (smoothly, or at once when the reader prefers reduced motion) and the frame is then focused without a second scroll. Opening a tool from low in a long sidebar kept the old scroll offset and left the frame above the viewport (Business preset, Marketing: frame top at -908px).
 * 12 | maintainer@emeraldcoastsystemsgroup.com | Composed front pages: the home page renders the preset's declared `modules` (two ordered columns of core modules, teacher/otherwise pairs and package summary cards) instead of a fixed triple per preset. A summary card is one generic renderer over the application's own ADR-145 probe (tiles, the first three items, the probe's timestamp), shown only for an application in the caller's plan that declares a probe (nothing rendered and nothing asked otherwise, ADR-164 D10), with a refusal shown as its status and nothing assumed; its action opens the named hosted tool in place when this caller is admitted to it, else links to the application. Consecutive cards in the main column share a two-up grid. The About dialog names each card's source and status. The shopping heading follows the preset.
 * 13 | maintainer@emeraldcoastsystemsgroup.com | Home build, check-ins and people: Home shows the caller's own check-in from ADR-169 location state (a place name and age, never coordinates; household members with nothing shown because no group presence read exists; who can see the caller), a switch that stops this browser's reporting through the location route and opens Settings, Location to turn it on (fresh sign-in there), and re-reads it on return; the household group (GET /api/tenants and its members, names only where the directory already shares them) labels the home, the badge, the breadcrumb, the people lists and the room strip, and Business lists the caller's team group when the directory is not theirs; the Family admin card opens People & roles (members and roles, or creating a household with the caller as admin) and Devices (the caller's location devices, stop reporting). A learner sees their own level and XP from Little Monsters' dashboard (asked only for a learner, and outside the classroom only after the probe gate), the family learner is greeted with their day, the classwork pill names the next due day, and unread Little Monsters notices lead the noticeboard with mark read. Money shows only when Finance admits the caller (ADR-164 D10); anyone else gets the teaching card or their personal workspace. The About dialog names the new sources.
 * 14 | maintainer@emeraldcoastsystemsgroup.com | Home build, pages and choices: Routines (Jarvis briefing sources switched on or off, the caller's schedules in words with pause and resume, a routine asked of Jarvis), search in this home from the top bar (this page's reads plus the caller-scoped GET /api/search), the Room / Tasks / Files tabs, the day-by-day agenda and a read-only event dialog, View all and View list on the front page, the assistant bubble (the newest reply, or a catch-up of the day's finished tasks dismissed on this device) with an inline composer on the same Jarvis thread, and the "Make it yours" choices saved on this device (how the assistant offers help, what greets you first, what stays close at hand). A ticked shopping item stays struck through for the visit; the sidebar links the help guides.
 * 15 | maintainer@emeraldcoastsystemsgroup.com | A notice survives the repaint that follows it: adding an event or a list item showed its notice and then re-read and repainted the page, which replaced the toast element and wiped the text (and the four-second clear kept pointing at the old element). The repaint now carries the text over and the clear looks the toast up again.
 */
(() => {
  'use strict';
  const S = window.OSHAL_SHELL, LIVE = window.OSHAL_LIVE, esc = S.esc;
  const presets = window.HOMEBASE_PRESETS, HD = window.HOMEBASE_DATA.createHomebaseData(LIVE);
  const requested = new URLSearchParams(location.search).get('preset');
  const key = Object.prototype.hasOwnProperty.call(presets, requested) ? requested : 'family';
  const preset = presets[key], root = document.getElementById('homebase-root');
  document.body.dataset.defaultSkin = preset.skin;
  // The switcher initialised before this script chose the preset, so paint the preset skin now unless the device remembers one.
  if (window.OSHAL_STYLE_SWITCHER && !window.OSHAL_STYLE_SWITCHER.getStoredSkin()) window.OSHAL_STYLE_SWITCHER.applySkin(preset.skin, false);
  const btn = (text, action, cls = 'button', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${text}</button>`;
  const link = (text, href, cls = 'button', attrs = '') => `<a class="${cls}" href="${esc(href)}" ${attrs}>${text}</a>`;
  const pill = s => `<span class="pill">${esc(s)}</span>`;
  const head = (title, action = '') => `<div class="panel-head"><h2>${title}</h2>${action}</div>`;
  const COLORS = ['green', 'rose', 'gold', 'blue'];
  const avatar = (text, i = 0) => `<span class="avatar ${COLORS[i % COLORS.length]}" aria-hidden="true">${esc(text)}</span>`;
  const money = n => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
  const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  let snapshot, shell, data = {}, thread, dialogKind = null, dialogId = null, opener = null, timer, config, M, locationAsked = false;
  const state = { page: 'home', tool: null, search: null };
  const defaultConfig = () => ({ density: 'comfortable', updates: true, week: true, lead: 'room', hide: [], bot: 'suggest', revision: 1, previous: null });
  const me = () => snapshot.me;
  const app = id => shell.byId(id);
  const has = id => Boolean(app(id));
  const isTeacher = () => Boolean(data.edu && data.edu.me && ['teacher', 'admin'].includes(data.edu.me.role));
  const isLearner = () => Boolean(data.edu && data.edu.me && data.edu.me.role === 'student');
  const displayName = () => (data.edu && data.edu.me && data.edu.me.name) || me().name;
  /** Classes the caller teaches (or every class for a Little Monsters admin): the only classes whose activity is read and that the classwork picker offers. The package re-checks every request. */
  const teachableClasses = edu => edu && edu.me && ['teacher', 'admin'].includes(edu.me.role) ? edu.classes.filter(c => edu.me.role === 'admin' || c.teacher_student_id === edu.me.studentId) : [];
  const canConfigure = () => !me().guest;
  const refusal = r => r && r.body && typeof r.body.error === 'string' ? `: ${r.body.error}` : '';
  const errorOf = r => r && !r.ok && r.body && typeof r.body.error === 'string' ? r.body.error : '';
  /** The sentence for a Little Monsters read that did not answer: not admitted, no school profile yet, or the module's own wording (`other`) for any other refusal. */
  const eduRefusal = (edu, other) => edu.refusal === 'not-granted' ? 'Little Monsters is not available to you.' : edu.refusal === 'no-profile' ? 'Open Little Monsters once to set up your school profile.' : other;
  /** A Little Monsters date-only field (due_date) as the local calendar day it names, never UTC midnight shifted into the day before. */
  const dueOn = v => { const d = LIVE.calendarDay(v); return d ? d.toLocaleDateString() : String(v); };
  const human = s => String(s).replace(/_/g, ' ');
  // The package's allowed assignment types (the lm_assignments CHECK constraint), with display labels.
  const CLASSWORK_TYPES = [['homework', 'Homework'], ['reading', 'Reading'], ['project', 'Project'], ['lab', 'Lab'], ['quiz-prep', 'Quiz prep'], ['test', 'Test']];
  /** A status line for four seconds. The clear looks the toast up again, because a repaint in between replaces the element. */
  const notice = s => { clearTimeout(timer); const t = document.getElementById('toast'); if (t) { t.textContent = s; timer = setTimeout(() => { const now = document.getElementById('toast'); if (now) now.textContent = ''; }, 4000); } };

  root.innerHTML = '<div class="experience"><div class="home-shell"><main class="home-main"><section class="hero"><div><div class="eyebrow">CONNECTING</div><h1>Reading your home…</h1></div></section></main></div></div>';
  LIVE.readyCore.then(boot).catch(err => { root.innerHTML = `<div class="experience"><main class="home-main"><section class="hero"><div><h1>This home could not load.</h1><p>${esc(err && err.message ? err.message : String(err))}</p></div></section></main></div>`; });

  async function boot(loaded) {
    snapshot = loaded;
    if (!snapshot.me.authenticated) { root.innerHTML = `<div class="experience"><main class="home-main"><section class="hero"><div><h1>Sign in to open your home.</h1><p>${link('Sign in', '/login', 'button primary')}</p></div></section></main></div>`; return; }
    shell = S.createShell({ snapshot, layoutId: key, hooks: {} });
    config = { ...defaultConfig(), ...(LIVE.prefs.get(`homebase:${key}`, {}) || {}) };
    thread = shell.createThread(LIVE.sessionId(), preset.assistantLabel);
    M = window.HOMEBASE_MODULES.create(moduleContext());
    bind();
    render();
    // Work, tasks and the overview arrive in the second phase; repaint then unless a tool is open (a repaint would reload its frame).
    LIVE.ready.then(repaint).catch(() => { /* a home paints without work */ });
    thread.load().then(repaint).catch(() => { /* the bubble waits for a reply in this page */ });
    await Promise.all([loadEducation().then(loadLearner), loadTools(), loadShopping(), loadFinance(), loadHome(), loadDirectory().then(loadGroup), loadLocation(), loadUpdates(), loadCards()]);
    repaint();
  }
  /** Repaint unless a hosted tool is open: a repaint would reload its frame. */
  function repaint() { if (state.page !== 'tool') render(); }
  /**
   * @description The render context the homebase modules (homebase-modules.js) read at call time: markup helpers, the
   * live data object and accessors, so a module never holds a stale copy of an answer.
   * @returns {object} The context.
   */
  function moduleContext() {
    return {
      esc, btn, link, pill, head, avatar, LIVE, S, data, state, preset, key, dueOn,
      config: () => config, me, displayName, snapshot: () => snapshot, isTeacher, isLearner, toolById, app, canConfigure,
      thread: () => thread, openWork: () => shell.openWork(), events: () => (data.edu && data.edu.ok ? data.edu.events : []), assignments: assignmentsOpen,
      bubbleSeen: () => LIVE.prefs.get(`homebase:${key}:bubble`, '')
    };
  }

  /* ── live sources ────────────────────────────────────────────── */
  async function loadEducation() {
    const lm = app('little-monsters');
    if (!lm) { data.edu = { installed: false }; return; }
    // The classroom is Little Monsters itself and reads its routes; any other home asks the read-only probe first.
    const gate = key === 'classroom' ? null : await educationGate(lm);
    if (gate) { data.edu = gate; return; }
    const E = LIVE.packages.education, now = new Date(), next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const [meRes, classes, assignments, cal1, cal2] = await Promise.all([E.me(), E.classes(), E.assignments(), E.calendar(isoDay(now).slice(0, 7)), E.calendar(isoDay(next).slice(0, 7))]);
    const edu = { ...refusedEdu(meRes.status, errorOf(meRes), meRes.ok ? '' : undefined), ok: meRes.ok, me: meRes.ok ? meRes.body : null, classes: classes.ok && classes.body ? classes.body.classes || [] : [], assignments: assignments.ok && assignments.body ? assignments.body.assignments || [] : [] };
    const events = [].concat(cal1.ok && cal1.body ? cal1.body.events || [] : [], cal2.ok && cal2.body ? cal2.body.events || [] : []);
    const seen = new Set();
    edu.events = events.filter(e => e && e.event_id && !seen.has(e.event_id) && seen.add(e.event_id)).map(e => ({ ...e, when: LIVE.calendarDay(e.event_date, e.event_time) })).filter(e => e.when).sort((a, b) => a.when - b.when);
    if (edu.me && ['teacher', 'admin'].includes(edu.me.role)) {
      const mine = teachableClasses(edu);
      edu.classes.forEach(c => { if (!mine.includes(c)) edu.rosters.set(c.class_id, { status: 403, students: null }); });
      await Promise.all(mine.map(async c => {
        const [r, a] = await Promise.all([E.students(c.class_id), E.analytics(c.class_id)]);
        edu.rosters.set(c.class_id, { status: r.status, students: r.ok && r.body ? r.body.students || [] : null });
        edu.activity.set(c.class_id, activityOf(a));
      }));
    }
    data.edu = edu;
  }
  /**
   * @description Little Monsters state for a read that did not answer 200: its status, the route's error string and the
   * refusal kind (not admitted, no school profile yet, or '' for any other refusal), with empty class data.
   * @param {number} status HTTP status (0 when nothing was asked).
   * @param {string} error The response's `error` string, or ''.
   * @param {string} [refusal] A known kind; omitted, it is read from the status and error.
   * @returns {object} The education state the modules render.
   */
  function refusedEdu(status, error, refusal) {
    return { installed: true, ok: false, status, error, refusal: refusal === undefined ? LIVE.littleMonstersRefusal(status, error) : refusal, me: null, classes: [], assignments: [], events: [], rosters: new Map(), activity: new Map() };
  }
  /**
   * @description Family and company homes are not Little Monsters, and its /api/education/* routes can create or link a
   * learner row (and promote a role) for a caller with no school profile. So, as the Jarvis agenda does, the package's
   * read-only home-summary probe is read first and the education routes only after it answers 200. An entry the
   * authorized plan does not admit is not available to the caller: no probe and no education request.
   * @param {object} lm The Little Monsters catalog entry.
   * @returns {Promise<object|null>} The state to show instead of reading, or null when the probe answered 200.
   */
  async function educationGate(lm) {
    if (!lm.inPlan && snapshot.sources.plan === 200) return refusedEdu(0, '', 'not-granted');
    const probe = await LIVE.probeSummary(lm);
    return probe.status === 200 ? null : refusedEdu(probe.status, probe.error || '');
  }
  /** @description One class's analytics answer kept as activity per learner id plus the package's class summary; a refusal keeps only its status. */
  function activityOf(r) {
    const rows = r.ok && r.body && Array.isArray(r.body.students) ? r.body.students : null;
    return { status: r.status, byId: rows ? new Map(rows.map(s => [s.student_id, s])) : null, summary: rows && r.body.summary ? r.body.summary : null };
  }
  async function loadShopping() {
    if (!has('purchasing')) { data.shop = { installed: false }; return; }
    const lists = await LIVE.packages.purchasing.lists();
    const list = lists.ok && lists.body && Array.isArray(lists.body.lists) ? (lists.body.lists.find(l => l.status === 'active') || lists.body.lists[0]) : null;
    const items = list ? await LIVE.packages.purchasing.items(list.list_id) : { ok: false, status: lists.status, body: null };
    data.shop = { installed: true, ok: lists.ok, status: lists.status, list, items: items.ok && items.body ? (items.body.items || []).filter(i => i.status === 'pending') : [], itemsStatus: items.status };
  }
  async function loadFinance() {
    const fin = app('finance');
    if (!fin) { data.fin = { installed: false }; return; }
    if (!fin.navigable) { data.fin = { installed: true, available: false }; return; }
    const [summary, home] = await Promise.all([LIVE.packages.finance.summary(), LIVE.packages.finance.homeSummary()]);
    const agg = summary.ok && summary.body ? summary.body.aggregate : null;
    data.fin = { installed: true, available: true, status: summary.status, noData: summary.status === 404, aggregate: agg, syncedAt: summary.ok && summary.body ? summary.body.syncedAt : null, tiles: home.ok && home.body && Array.isArray(home.body.tiles) ? home.body.tiles.slice(0, 4) : [], app: fin };
  }
  async function loadHome() { const h = app('home'); data.home = h ? { installed: true, app: h, summary: await LIVE.probeSummary(h) } : { installed: false }; }
  /**
   * @description A learner's own progress (the package's dashboard) and, whenever Little Monsters answered for the caller,
   * their unread notices. Both follow loadEducation, so outside the classroom they are asked only after its probe gate.
   * @returns {Promise<void>} Resolves when both have an answer or were not asked.
   */
  async function loadLearner() {
    const edu = data.edu, ok = Boolean(edu && edu.ok && edu.me);
    const [progress, notices] = await Promise.all([ok && isLearner() ? HD.progress(edu.me.studentId) : null, ok ? HD.notifications() : null]);
    data.progress = progress; data.notices = notices;
  }
  /** The household (Home) or team (Business) group; the classroom's people are its classes. Names come from the directory only when it answers. */
  async function loadGroup() {
    const kind = key === 'family' ? 'space' : key === 'company' ? 'org' : '';
    if (!kind) { data.group = null; return; }
    data.group = await HD.household(kind, { sub: me().sub, name: displayName() }, directoryUsers);
  }
  /** Directory users this caller may see (the Business read when there is one, else a read now); a refusal names nobody. */
  async function directoryUsers() {
    if (data.dir) return data.dir.users;
    const r = await LIVE.packages.directory();
    return r.ok && r.body && Array.isArray(r.body.users) ? r.body.users : [];
  }
  /** The caller's own check-in (Home only): their place, devices and who can see them, from ADR-169 location state. */
  async function loadLocation() { data.loc = key === 'family' ? await HD.location() : null; }
  /** Briefing sources and schedules, read when the Routines page opens. */
  async function loadRoutines() { data.routines = await HD.routines(); }
  async function loadDirectory() {
    if (key !== 'company') { data.dir = null; return; }
    const r = await LIVE.packages.directory();
    const users = r.ok && r.body && Array.isArray(r.body.users) ? r.body.users : [];
    data.dir = { status: r.status, users, people: users.filter(u => u && u.sub !== me().sub).map(u => ({ name: String(u.label || 'Member').replace(/\s*\([^)]*\)\s*$/, ''), role: [u.source === 'verified-sign-in' ? 'Signed in' : u.source, u.signIn].filter(Boolean).join(' · ') })) };
  }
  async function loadUpdates() {
    const featured = featuredApps().slice(0, 4);
    const rows = await Promise.all(featured.map(async a => ({ app: a, summary: await LIVE.probeSummary(a) })));
    data.updates = rows.flatMap(({ app: a, summary }) => summary.ok ? summary.items.slice(0, 2).map(i => ({ who: a.name, what: i.text, detail: i.detail, when: summary.asOf ? LIVE.relativeTime(new Date(summary.asOf)) : 'now', tone: i.tone })) : []);
  }
  /** The front page's module entries that name a package summary card, both columns in order. */
  const cardEntries = () => ['main', 'aside'].flatMap(col => ((preset.modules || {})[col] || [])).filter(m => m && typeof m === 'object' && m.card);
  /** Whether a card applies to this caller: its application is in the caller's plan and declares a summary probe. */
  const cardApp = name => { const a = app(name); return a && a.probes.length ? a : null; };
  /**
   * @description Read each declared card's summary through the application's own probe, only for applications in the
   * caller's plan that declare one: an application the caller is not admitted to renders nothing and is asked nothing
   * (ADR-164 D10). live-data caches a probe briefly, so a card on an app the noticeboard already read costs no request.
   * @returns {Promise<void>} Resolves when every applicable card has an answer or a status.
   */
  async function loadCards() {
    const cards = new Map(), names = [...new Set(cardEntries().map(m => m.card))].filter(cardApp);
    await Promise.all(names.map(async n => cards.set(n, await LIVE.probeSummary(app(n)))));
    data.cards = cards;
  }
  function featuredApps() {
    const lead = preset.featured.map(app).filter(a => a && a.navigable);
    const fill = preset.suites.flatMap(id => (shell.suiteOf(id).apps || []).filter(a => a.navigable && !lead.includes(a)));
    return lead.concat(fill);
  }

  /** @description The hosted applications' admitted surfaces for this caller: one ribbon profile per host (the contract the cockpit renders, already filtered per caller), each tool tagged with its host and curated by the preset's hidden prefixes. */
  async function loadTools() {
    const hosts = (preset.hosts || []).filter(h => has(h.app));
    if (!hosts.length) { data.tools = null; return; }
    const results = await Promise.all(hosts.map(async h => ({ host: h, r: await hostProfile(h) })));
    const seen = new Set(), items = [];
    for (const { host, r } of results) {
      const list = r.ok && r.body && r.body.profile && r.body.profile.ribbon && Array.isArray(r.body.profile.ribbon.items) ? r.body.profile.ribbon.items : [];
      for (const i of list) {
        if (!(i && i.id && i.toolUi && typeof i.toolUi.iframeUrl === 'string' && i.toolUi.iframeUrl.startsWith('/'))) continue;
        const id = String(i.id); if (seen.has(id)) continue; seen.add(id);
        items.push({ id, host: host.app, kicker: host.kicker || app(host.app).name.toUpperCase(), hidden: (host.hiddenTools || []).some(p => id.startsWith(p)), label: String(i.label || id), href: i.toolUi.iframeUrl, section: String(i.section || 'top') });
      }
    }
    data.tools = { items, hosts: hosts.map(h => h.app), statuses: results.map(x => x.r.status) };
  }
  /**
   * @description One host's ribbon profile. Outside the classroom, Little Monsters' profile is read only after the same
   * probe gate as its education routes: the profile asks the package's visibility route, which can create a learner row
   * for a caller with no school profile. A gated host lists no tools (status 0, nothing asked).
   * @param {{app: string}} h The preset's host entry.
   * @returns {Promise<{ok: boolean, status: number, body: object|null}>} The profile answer, or an empty one when gated.
   */
  async function hostProfile(h) {
    if (h.app === 'little-monsters' && key !== 'classroom' && await educationGate(app(h.app))) return { ok: false, status: 0, body: null };
    return LIVE.packages.profile(h.app);
  }
  const admittedTools = () => data.tools ? data.tools.items : [];
  /** Tools offered in the rails: the preset's hidden prefixes stay out (per-class tools and off-audience tiles have their own place). */
  const navTools = () => admittedTools().filter(t => !t.hidden);
  const toolById = id => admittedTools().find(t => t.id === id) || null;
  /** The offered tools grouped by host, in host order. */
  const hostGroups = () => { const groups = []; navTools().forEach(t => { let g = groups.find(x => x.host === t.host); if (!g) { g = { host: t.host, kicker: t.kicker, tools: [] }; groups.push(g); } g.tools.push(t); }); return groups; };
  /** The URL a hosted tool opens with: its own surface plus this preset's audience view, as a request (a view id is never authority). */
  const hostedUrl = t => { const u = new URL(t.href, location.origin); if (preset.audience && !u.searchParams.has('audience')) u.searchParams.set('audience', preset.audience); return u.pathname + u.search + u.hash; };
  /** Whether the reader asked for reduced motion: a hosted tool then jumps into place instead of gliding there. */
  const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  /**
   * @description Open an admitted tool in place. The page scrolls so the tool shell starts at the top of the viewport
   * before the frame takes focus: opening a tool from low in a long sidebar kept the old scroll offset, which left the
   * frame above the viewport, and focusing a frame does not reliably bring it into view. Anything not admitted for this
   * caller is refused with a notice, never fetched.
   * @param {string} id The admitted tool's id.
   * @returns {void}
   */
  function openTool(id) {
    const t = toolById(id);
    if (!t) { notice('That view is not available to you here.'); return; }
    state.page = 'tool'; state.tool = t.id; render();
    const toolShell = root.querySelector('.tool-shell');
    if (toolShell) toolShell.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    const frame = document.getElementById('tool-frame'); if (frame) frame.focus({ preventScroll: true });
  }
  /** @description Navigation requests from the hosted tool, in the shapes the cockpit ribbon honours. Only the frame this home opened is heard, same origin only, and only admitted tools open. */
  function onSurfaceMessage(e) {
    const frame = document.getElementById('tool-frame');
    if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return;
    const d = e.data;
    if (d === 'lm-classes-changed' || (d && typeof d === 'object' && d.type === 'app-tools-changed')) { Promise.all([loadEducation(), loadTools()]).then(() => { if (state.page !== 'tool') render(); }); return; }
    if (!d || typeof d !== 'object') return;
    let id = null;
    if (d.type === 'app-navigate' && d.tool) id = 'tool-' + String(d.tool);
    else if (d.type === 'lm-navigate' && d.view) { const view = String(d.view); id = view.startsWith('class-') ? 'tool-lm-class-' + view.slice('class-'.length, 'class-'.length + 8) : 'tool-lm-' + view; }
    else if (d.type === 'lm-open-class' && d.classId) id = 'tool-lm-class-' + String(d.classId).slice(0, 8);
    if (id) openTool(id);
  }
  function toolPanel() {
    const t = toolById(state.tool), host = t ? app(t.host) : null;
    if (!t) return `<section class="panel" data-module="tool"><h2>That tool is not available to you here.</h2>${btn('Back to ' + esc(preset.nav[0][1].toLowerCase()), 'page', 'button', 'data-page="home"')}</section>`;
    return `<section class="tool-shell" data-module="tool"><div class="tool-head"><div><div class="panel-kicker">${esc((host ? host.name : preset.name).toUpperCase())} / ${esc(t.label.toUpperCase())}</div><h2>${esc(t.label)}</h2></div><div class="tool-actions">${host && host.navigable ? link('Open in the cockpit ↗', host.href, 'text-button', 'target="_blank" rel="noopener"') : ''}${btn('← Back to ' + esc(preset.nav[0][1].toLowerCase()), 'page', 'button', 'data-page="home"')}</div></div><iframe class="tool-frame" id="tool-frame" src="${esc(hostedUrl(t))}" title="${esc(t.label)}" allow="microphone; camera; fullscreen"></iframe></section>`;
  }

  /* ── modules ─────────────────────────────────────────────────── */
  function weekStrip() {
    const today = new Date(), start = new Date(today); start.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    return `<div class="week-strip" aria-label="This week">${['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((d, i) => { const day = new Date(start); day.setDate(start.getDate() + i); return `<div class="day ${isoDay(day) === isoDay(today) ? 'active' : ''}">${d}<strong>${day.getDate()}</strong></div>`; }).join('')}</div>`;
  }
  function upcomingEvents() {
    const edu = data.edu; if (!edu || !edu.installed || !edu.ok) return [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return edu.events.filter(e => e.when >= today).slice(0, 6);
  }
  /** Today, or the short weekday and date, for the day an event falls on. */
  const eventDay = d => isoDay(d) === isoDay(new Date()) ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  /** @description One calendar row: a timed event shows its time and, beneath it, the day it falls on; an untimed event shows its day. */
  function eventRow(e) {
    const time = e.event_time
      ? `${esc(LIVE.clockTime(e.when).replace(/\s?[AP]M$/i, ''))}<small>${e.when.getHours() >= 12 ? 'PM' : 'AM'}</small><small class="event-day">${esc(eventDay(e.when))}</small>`
      : `${esc(isoDay(e.when) === isoDay(new Date()) ? 'Today' : e.when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}<small></small>`;
    return `<div class="event"><div class="event-time">${time}</div><div><strong><button type="button" class="event-link" data-action="event-detail" data-event="${esc(e.event_id)}">${esc(e.title)}</button></strong><p>${esc(e.class_name ? `${e.class_name}${e.subject ? ` · ${e.subject}` : ''}` : 'Personal')}${e.event_type && e.event_type !== 'custom' ? ` · ${esc(e.event_type)}` : ''}</p></div>${pill(e.class_name ? 'Class' : 'Personal')}</div>`;
  }
  function calendar() {
    const edu = data.edu, events = upcomingEvents(), canAdd = Boolean(edu && edu.ok);
    const body = !edu ? '<p class="subtle">Reading the calendar…</p>' : !edu.installed ? '<p class="subtle">No application on this swarm contributes a shared calendar yet. Little Monsters adds class and personal events when it is installed.</p>' : !edu.ok ? `<p class="subtle">${esc(eduRefusal(edu, `The calendar could not be read (HTTP ${edu.status}${edu.error ? `: ${edu.error}` : ''}).`))}</p>` : events.length ? events.map(eventRow).join('') : '<p class="subtle">Nothing scheduled in the next weeks. Add a moment below or open Little Monsters.</p>';
    return `<section class="panel" data-module="calendar">${head(preset.calendarHeading, `<span class="head-actions">${state.page === 'home' ? btn('View all', 'page', 'text-button', 'data-page="calendar"') : ''}${canAdd ? btn('+ Add', 'event', 'text-button') : ''}</span>`)}${config.week ? weekStrip() : ''}${body}<p class="subtle" style="margin-top:17px">${edu && edu.ok ? `Class events from ${edu.classes.length} class${edu.classes.length === 1 ? '' : 'es'} plus your personal events, read from Little Monsters.` : 'Calendar source: Little Monsters class and personal events.'}</p></section>`;
  }
  function shopping() {
    const s = data.shop;
    const body = !s ? '<p class="subtle">Reading your list…</p>' : !s.installed ? '<p class="subtle">The Purchasing application is not installed on this swarm, so there is no shared shopping list here.</p>' : !s.ok ? `<p class="subtle">Your shopping list could not be read (HTTP ${s.status}).</p>` : !s.list ? '<p class="subtle">You have no shopping list yet. Add the first item below to create one in Purchasing.</p>' : `<div class="list-items">${s.items.map(i => `<label class="list-item"><input type="checkbox" data-shopping-item="${esc(i.item_id)}"><span><span class="item-title">${esc(i.title)}</span><small>${i.quantity > 1 ? `×${i.quantity} · ` : ''}${i.unit_price ? `${money(Number(i.unit_price))} · ` : ''}added ${esc(LIVE.relativeTime(LIVE.parseDate(i.created_at)))}</small></span></label>`).join('') || (data.shopDone && data.shopDone.length ? '' : '<p class="subtle">Nothing pending on this list.</p>')}${(data.shopDone || []).map(t => `<label class="list-item got-it"><input type="checkbox" checked disabled><span><span class="item-title">${esc(t)}</span><small>Got it · removed from your list</small></span></label>`).join('')}</div>`;
    return `<section class="panel" data-module="shopping">${head(esc(preset.shoppingHeading || 'One list. Fewer texts.'), s && s.list ? pill(`${s.items.length} to get`) : '')}${body}${s && s.installed && s.ok ? '<form id="shopping-form" class="add-form"><label class="screenreader" for="shopping-input">Add to the shopping list</label><input id="shopping-input" maxlength="100" placeholder="Anything else we need?" required><button class="button" type="submit" aria-label="Add item">+</button></form><p class="subtle">Ticking an item removes it from the list in Purchasing.</p>' : ''}${s && s.list && state.page === 'home' && preset.nav.some(n => n[0] === 'shopping') ? btn('View list', 'page', 'text-button', 'data-page="shopping"') : ''}</section>`;
  }
  function homeFacts() {
    const h = data.home; if (!h || !h.installed) return '';
    const sm = h.summary;
    return `<section class="panel" data-module="home-facts">${head('Around the house', link('Open Smart Home ↗', h.app.href, 'text-button'))}${sm && sm.ok ? `<div class="location-grid">${sm.tiles.map(t => `<article class="location-person"><strong>${esc(t.value)}</strong><p>${esc(t.label)}</p></article>`).join('')}</div>${sm.items.map(i => `<p class="subtle">${esc(i.text)}</p>`).join('')}` : `<p class="subtle">${sm && sm.none ? 'Smart Home publishes no summary.' : `Smart Home summary unavailable (HTTP ${sm ? sm.status : '…'}).`}</p>`}</section>`;
  }
  function financeBars(agg) {
    const months = Array.isArray(agg.spendByMonth) ? agg.spendByMonth.slice(-7) : [];
    const max = Math.max(...months.map(m => Number(m.spend) || 0), 1);
    return months.length ? `<div class="money-bars" role="img" aria-label="Monthly spend, last ${months.length} months">${months.map(m => `<span style="height:${Math.max(6, Math.round((Number(m.spend) || 0) / max * 56))}px" title="${esc(m.month)}: ${money(Number(m.spend) || 0)}"></span>`).join('')}</div>` : '';
  }
  function finance() {
    const f = data.fin;
    const kicker = key === 'company' ? 'RESTRICTED / OPERATIONS FINANCE' : 'JUST FOR YOU / PERSONAL FINANCE';
    if (!f) return `<section class="panel feature-card" data-module="finance"><div class="panel-kicker">${kicker}</div><p>Reading your finance snapshot…</p></section>`;
    if (!f.installed) return '';
    if (!f.available) return `<section class="panel feature-card" data-module="finance"><div class="panel-kicker">${kicker}</div><h2>Finance is not available in your workspace.</h2><p>Only granted users see account information here; an administrator manages that access. Choosing this home does not change it.</p></section>`;
    if (f.noData) return `<section class="panel feature-card" data-module="finance"><div class="panel-kicker">${kicker}</div><h2>${key === 'company' ? 'A clear view of the runway starts with linked accounts.' : 'A calmer view of money starts with linked accounts.'}</h2><p>No accounts are synced yet. Link them in Finance; nothing is shown here until you do.</p>${link('Open Finance ↗', f.app.href, 'button')}</section>`;
    if (!f.aggregate) return `<section class="panel feature-card" data-module="finance"><div class="panel-kicker">${kicker}</div><p>Finance is unavailable right now (HTTP ${f.status}).</p></section>`;
    const agg = f.aggregate, net = agg.netWorth && typeof agg.netWorth.net === 'number' ? agg.netWorth.net : null, synced = f.syncedAt ? new Date(f.syncedAt).toLocaleDateString() : 'unknown';
    if (key === 'company') {
      const accounts = Array.isArray(agg.accounts) ? agg.accounts.slice(0, 8) : [];
      return `<section class="panel feature-card" data-module="finance"><div class="panel-kicker">${kicker}</div><h2>A clear view of the runway.</h2><p>Your linked accounts, read from Finance. Visible to you because Finance is granted to you, not because of this home.</p>${net !== null ? `<div class="money-amount">${esc(money(net))}</div><div class="private-caption"><span>Net worth across ${accounts.length} account${accounts.length === 1 ? '' : 's'}</span><span>Synced ${esc(synced)}</span></div>` : ''}<table class="finance-table"><thead><tr><th>Account</th><th>Type</th><th>Balance</th></tr></thead><tbody>${accounts.map(a => `<tr><td>${esc(a.name || a.institution || 'Account')}${a.mask ? ` ···${esc(a.mask)}` : ''}</td><td>${esc(a.subtype || a.type || '')}</td><td>${typeof a.balance === 'number' ? esc(money(a.balance)) : '—'}</td></tr>`).join('')}</tbody></table>${financeBars(agg)}${link('Open Finance ↗', f.app.href, 'button')}</section>`;
    }
    return `<section class="panel feature-card" data-module="finance"><div class="panel-kicker">${kicker}</div><h2>A calmer view of money.</h2><p>${esc(displayName())}’s linked accounts, read from Finance. Nobody else in this home inherits this view.</p>${net !== null ? `<div class="money-amount">${esc(money(net))}</div>` : ''}<div class="private-caption"><span>Net worth (cached)</span><span>Synced ${esc(synced)}</span></div>${financeBars(agg)}${f.tiles.length ? `<p class="subtle">${f.tiles.map(t => `${esc(t.label)}: ${esc(t.value)}`).join(' · ')}</p>` : ''}${link('Open my finance view ↗', f.app.href, 'button')}<p class="subtle" style="margin-top:12px">Personal records require explicit sharing; a parent or admin label is not consent.</p></section>`;
  }
  function assignmentsOpen() { const edu = data.edu; return edu && edu.ok ? edu.assignments.filter(a => !/complete|done|submitted|closed|archived/i.test(String(a.status || ''))) : []; }
  function learning() {
    const edu = data.edu, lm = app('little-monsters');
    if (!edu) return `<section class="panel feature-card" data-module="learning-loading"><div class="panel-kicker">JUST FOR ${esc(displayName().toUpperCase())}</div><p>Reading your learning space…</p></section>`;
    if (!edu.installed) return `<section class="panel feature-card" data-module="learning"><div class="panel-kicker">JUST FOR ${esc(displayName().toUpperCase())}</div><h2>A little progress, every day.</h2><p>Little Monsters is not installed on this swarm, so there is no learning space to show.</p></section>`;
    if (!edu.ok) return learningRefused(edu, lm);
    if (isTeacher()) return `<section class="panel feature-card" data-module="learning"><div class="panel-kicker">JUST FOR ${esc(displayName().toUpperCase())}</div><h2>You teach ${edu.me.classCount || edu.classes.length} class${(edu.me.classCount || edu.classes.length) === 1 ? '' : 'es'}.</h2><p>${assignmentsOpen().length} open classwork item${assignmentsOpen().length === 1 ? '' : 's'} across them.</p>${lm ? link('Open Little Monsters ↗', lm.href, 'button') : ''}</section>`;
    // Open classwork only: assignment status is class-wide, and Little Monsters records no per-learner completion to count.
    const open = assignmentsOpen(), next = open[0];
    return `<section class="panel feature-card" data-module="learning"><div class="panel-kicker">JUST FOR ${esc(displayName().toUpperCase())}</div><h2>A little progress, every day.</h2><p>${edu.classes.length} class${edu.classes.length === 1 ? '' : 'es'} · ${open.length} open classwork item${open.length === 1 ? '' : 's'}.</p>${M.progressBlock()}<p>${next ? `Next: ${esc(next.title)}${next.class_name ? ` · ${esc(next.class_name)}` : ''}${next.due_date ? ` · due ${esc(dueOn(next.due_date))}` : ''}` : 'Nothing is due right now.'}</p>${btn('Open my checklist', 'learning', 'button')}</section>`;
  }
  /** @description The learning card when Little Monsters did not answer: not admitted (no way in offered), no school profile yet (open it once), or the refusal as read. */
  function learningRefused(edu, lm) {
    const kicker = `<div class="panel-kicker">JUST FOR ${esc(displayName().toUpperCase())}</div>`;
    if (edu.refusal === 'not-granted') return `<section class="panel feature-card" data-module="learning">${kicker}<h2>${esc(eduRefusal(edu, ''))}</h2><p>An administrator manages that access; choosing this home does not change it.</p></section>`;
    const text = eduRefusal(edu, `Your learning space could not be read (HTTP ${edu.status}${edu.error ? `: ${edu.error}` : ''}).`);
    return `<section class="panel feature-card" data-module="learning">${kicker}<h2>Your learning space is waiting.</h2><p>${esc(text)}${edu.refusal === 'no-profile' ? ' Your classes and classwork then appear here.' : ''}</p>${lm ? link('Open Little Monsters ↗', lm.href, 'button') : ''}</section>`;
  }
  function requirements() {
    const edu = data.edu, lm = app('little-monsters'), open = assignmentsOpen(), next = open[0];
    if (!edu) return `<section class="panel ${state.page === 'home' ? 'quest-card' : ''}" data-module="requirements-loading"><div class="panel-kicker">CLASSWORK</div><p>Reading classwork…</p></section>`;
    if (!edu.installed || !edu.ok) return `<section class="panel ${state.page === 'home' ? 'quest-card' : ''}" data-module="requirements"><div class="panel-kicker">CLASSWORK</div><h2>${esc(!edu.installed ? 'Little Monsters is not installed.' : eduRefusal(edu, 'Open Little Monsters to join a class.'))}</h2><p>${edu.refusal === 'not-granted' ? 'An administrator manages that access.' : 'Classwork appears here once you belong to a class.'}</p></section>`;
    return `<section class="panel ${state.page === 'home' ? 'quest-card' : ''}" data-module="requirements"><div class="panel-kicker">CLASSWORK / ${open.length} OPEN</div><h2>${next ? esc(next.title) : 'No open classwork.'}</h2><p style="margin:12px 0 16px">${next ? esc(next.description || `${next.class_name || 'Class'}${next.assignment_type ? ` · ${next.assignment_type}` : ''}`) : 'When a teacher publishes an assignment it appears here with its due date.'}</p>${open.length ? `<ol class="requirement-list">${open.slice(0, 4).map((a, i) => `<li><span class="step-num">${i + 1}</span><span>${esc(a.title)}${a.class_name ? ` <small class="subtle">· ${esc(a.class_name)}</small>` : ''}${a.due_date ? ` <small class="subtle">· due ${esc(dueOn(a.due_date))}</small>` : ''}</span></li>`).join('')}</ol>` : ''}<div class="quest-footer">${isTeacher() ? `${btn('Add classwork', 'classwork', 'button primary')}${lm ? link('Manage classwork in Little Monsters ↗', lm.href, 'button') : ''}` : btn('Open my checklist', 'learning', 'button primary')}${pill(next && next.due_date ? `Due ${dueOn(next.due_date)} · shared with ${next.class_name || 'your class'}` : `${edu.classes.length} class${edu.classes.length === 1 ? '' : 'es'} · shared with your class`)}</div></section>`;
  }
  /** @description One learner's activity pill from the teacher analytics row: level, daily streak, quiz average and flashcards reviewed. It is activity; Little Monsters records no per-learner classwork completion. */
  function activityPill(a) {
    const n = k => Number(a[k]) || 0, parts = [];
    if (a.level !== null && a.level !== undefined) parts.push(`Level ${n('level')}`);
    if (n('streak_days') > 0) parts.push(`${n('streak_days')}-day streak`);
    if (n('quiz_count') > 0) parts.push(`quiz avg ${n('quiz_average')}%`);
    if (n('cards_reviewed') > 0) parts.push(`${n('cards_reviewed')} card${n('cards_reviewed') === 1 ? '' : 's'} reviewed`);
    const idle = !n('streak_days') && !n('quiz_count') && !n('cards_reviewed');
    return `<span class="pill activity-pill" title="Activity, not classwork completion">${esc(parts.concat(idle ? ['no quiz or flashcard activity yet'] : []).join(' · '))}</span>`;
  }
  /** @description The class summary the analytics read computes server-side, stated as activity. */
  function activitySummary(s) {
    const count = Number(s.studentCount) || 0, avg = s.classQuizAverage === null || s.classQuizAverage === undefined ? 'no quizzes taken yet' : `class quiz average ${Number(s.classQuizAverage)}%`;
    return `Class activity: ${Number(s.studentsWithActivity) || 0} of ${count} learner${count === 1 ? '' : 's'} active in quizzes or flashcards · ${avg} · ${Number(s.totalCardsReviewed) || 0} cards reviewed`;
  }
  const activityNote = act => !act ? '' : act.status === 403 ? 'Only this class’s teacher sees its learners’ activity.' : act.status === 404 ? 'This class’s activity was not found (HTTP 404).' : !act.byId ? `Learner activity unavailable (HTTP ${act.status}).` : '';
  function learnerRow(s, act) {
    const a = act && act.byId ? act.byId.get(s.student_id) : null, last = a && a.last_active_date ? LIVE.calendarDay(a.last_active_date) : null;
    return `<div class="learner-row" data-learner="${esc(s.student_id)}"><div class="member-line">${avatar(LIVE.initials(s.name), 0)}<span>${esc(s.name)}<small>enrolled ${esc(LIVE.relativeTime(LIVE.parseDate(s.enrolled_at)))}${last ? ` · last active ${esc(last.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}` : ''}</small></span></div>${a ? activityPill(a) : ''}</div>`;
  }
  function rosterClass(c) {
    const edu = data.edu, r = edu.rosters.get(c.class_id), act = edu.activity.get(c.class_id), note = activityNote(act);
    const learners = r && r.students ? `<div class="list-items learner-list">${r.students.map(s => learnerRow(s, act)).join('') || '<p class="subtle">No students enrolled yet.</p>'}</div>` : `<p class="subtle learner-list">${r && r.status === 403 ? 'Only this class’s teacher sees its roster.' : 'Roster unavailable.'}</p>`;
    return `<div class="student-progress"><div class="member-line">${avatar(LIVE.initials(c.name), 3)}<span>${esc(c.name)}<small>${esc(c.subject || '')}${c.grade_level ? ` · ${esc(c.grade_level)}` : ''} · ${esc(c.teacher_name || '')}</small></span></div>${pill(`${c.student_count} student${Number(c.student_count) === 1 ? '' : 's'}`)}</div>${act && act.summary ? `<p class="subtle learner-list class-activity">${esc(activitySummary(act.summary))}</p>` : ''}${note ? `<p class="subtle learner-list class-activity">${esc(note)}</p>` : ''}${learners}`;
  }
  function roster() {
    const edu = data.edu; if (!edu || !edu.ok || !isTeacher()) return '';
    return `<section class="panel" data-module="teacher-roster">${head('A moment for each learner.', pill('Teacher view'))}${edu.classes.map(rosterClass).join('') || '<p class="subtle">You are not attached to a class yet.</p>'}<p class="subtle" style="margin-top:16px">Rosters and activity come from Little Monsters and are visible only to each class’s teacher. Students never see this panel. Activity (level, streak, quizzes, flashcards) is not classwork completion; Little Monsters records no per-learner completion.</p></section>`;
  }
  /** A ticket parked at approval_required: it waits on a person, so it must not fall below the newest rows. */
  const awaitsApproval = w => w.kind === 'ticket' && String(w.status.raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_') === 'approval_required';
  function projects() {
    const open = shell.openWork(), apps = new Set(open.map(w => w.appName));
    // Tickets awaiting approval lead; everything else keeps the work list's newest-first order.
    const shown = open.filter(awaitsApproval).concat(open.filter(w => !awaitsApproval(w))).slice(0, 6);
    return `<section class="panel" data-module="projects">${head('The work we share.', pill(`${open.length} open`))}${shown.map((w, i) => `<div class="project-row">${avatar(LIVE.initials(w.appName), i)}<div><strong>${esc(w.title)}</strong><small>${esc(w.appName)} · ${esc(w.typeLabel)} · ${esc(LIVE.relativeTime(w.at))}</small></div>${btn(`${esc(w.status.label)} ↗`, 'project', 'button', `data-work="${esc(w.id)}"`)}</div>`).join('') || '<p class="subtle">No open tickets or tasks. Ask the assistant for something and it lands here.</p>'}<div class="summary-line"><div><strong>${open.length}</strong><small>Open items</small></div><div><strong>${apps.size}</strong><small>Applications involved</small></div><div><strong>${snapshot.botsOnline}</strong><small>Assistants online</small></div></div></section>`;
  }
  /**
   * @description The person's own module. A learner gets their learning space; money shows only when Finance admits the
   * caller (ADR-164 D10: an application the caller is not admitted to renders nothing); otherwise a teacher at home keeps
   * the teaching card and everyone else gets the personal workspace.
   * @returns {string} Markup.
   */
  function personal() {
    if (key === 'classroom' || (key === 'family' && isLearner())) return learning();
    if (data.fin === undefined && key === 'family') return finance();
    if (data.fin && data.fin.installed && data.fin.available) return finance();
    return key === 'family' && isTeacher() ? learning() : personalWorkspace();
  }
  function personalWorkspace() {
    return `<section class="panel feature-card" data-module="personal"><div class="panel-kicker">${esc(displayName().toUpperCase())} / PERSONAL WORKSPACE</div><h2>Room for your best work.</h2><p>Your drafts and assistant conversations stay personal until you share them${key === 'company' ? ' with the team' : ''}.</p><div class="dialog-actions">${btn('My drafts', 'drafts', 'button primary')}${link('Open Jarvis ↗', '/api/jarvis/', 'button')}</div></section>`;
  }
  function updates() {
    if (!config.updates) return '';
    const rows = (data.updates || []).slice(0, 4), work = snapshot.work.slice(0, 3);
    return `<section class="panel" data-module="updates">${head(preset.updatesHeading)}${M.notices()}${rows.map(u => `<div class="update"><strong>${esc(u.who)}</strong><p>${esc(u.what)}</p><small>${esc(u.when)}${u.detail ? ` · ${esc(u.detail.slice(0, 90))}` : ''}</small></div>`).join('')}${work.map(w => `<div class="update"><strong>${esc(w.appName)}</strong><p>${esc(w.title)}</p><small>${esc(w.status.label)} · ${esc(LIVE.relativeTime(w.at))}</small></div>`).join('')}${rows.length || work.length ? '' : '<p class="subtle">Nothing new from your applications yet.</p>'}</section>`;
  }
  function peopleList() {
    const edu = data.edu, rows = [];
    rows.push({ mark: me().initials, name: `${displayName()} · you`, role: key === 'classroom' ? (isTeacher() ? 'Teacher' : isLearner() ? 'Student' : 'Not in a class yet') : groupName() ? `${(groupMembers().find(m => m.self) || {}).role === 'admin' ? 'Admin' : 'Member'} · ${groupName()}` : me().email || 'Signed in' });
    if (key === 'classroom' && edu && edu.ok) edu.classes.forEach(c => { if (c.teacher_name && !rows.some(r => r.name === c.teacher_name)) rows.push({ mark: LIVE.initials(c.teacher_name), name: c.teacher_name, role: `Teacher · ${c.name}` }); (edu.rosters.get(c.class_id) || {}).students?.forEach(s => rows.push({ mark: LIVE.initials(s.name), name: s.name, role: `Student · ${c.name}` })); });
    if (key === 'company' && data.dir && data.dir.status === 200) data.dir.people.slice(0, 12).forEach(p => rows.push({ mark: LIVE.initials(p.name), name: p.name, role: p.role || 'Member' }));
    else groupMembers().filter(m => !m.self).slice(0, 12).forEach(m => rows.push({ mark: LIVE.initials(m.name || 'Member'), name: m.name || (key === 'family' ? 'Household member' : 'Team member'), role: `${m.role === 'admin' ? 'Admin' : 'Member'} · ${groupName()}` }));
    return rows;
  }
  /** Members of the caller's household (Home) or team (Business) group, the caller first; empty when there is none or it was refused. */
  const groupMembers = () => (data.group && data.group.ok && data.group.group ? data.group.members : []);
  const groupName = () => (data.group && data.group.group ? data.group.group.name : '');
  /** @description The people page's source line: the class, the directory, the household or team group, or why there is none. */
  function peopleNote() {
    if (key === 'classroom') return 'Names come from your classes in Little Monsters. Grades and personal study records are not a class feed.';
    if (key === 'company' && data.dir && data.dir.status === 200) return 'Members come from this swarm’s user directory.';
    const g = data.group, word = key === 'family' ? 'household' : 'team';
    if (g && g.ok && g.group) return `Members of your ${word} group “${g.group.name}” (${groupMembers().length}). Names appear where this swarm’s directory shares them with you.`;
    if (g && !g.ok) return `Your ${word} group could not be read (HTTP ${g.status || 'network'}).`;
    return key === 'family' ? 'You are not in a household group yet. Family admin, People & roles, creates one.' : 'This swarm does not share a people directory or a team group with your account; teammates appear where an application publishes membership.';
  }
  const memberLine = (r, i) => `<div class="member-line">${avatar(r.mark, i)}<span>${esc(r.name)}<small>${esc(r.role)}</small></span></div>`;
  function people() {
    const rows = peopleList(), note = peopleNote();
    const count = groupMembers().length;
    return `<section class="panel" data-module="people">${head(key === 'family' ? (count > 1 ? `${count} people. One home.` : 'Our people') : key === 'classroom' ? 'Your classroom' : 'Your team')}<div class="side-section">${rows.map(memberLine).join('')}</div><p class="subtle" style="margin-top:20px">${note}</p><p class="subtle">${snapshot.botsOnline} of ${snapshot.bots.length} swarm assistants are online.</p></section>`;
  }
  function apps() {
    const groups = hostGroups();
    if (groups.length) return `<section><div class="section-heading"><h2>${esc(preset.appsHeading)}</h2>${btn('About access', 'policy', 'text-button')}</div>${groups.map(g => `<div class="tool-group"><div class="side-kicker">${esc(g.kicker)}</div><div class="apps-row tools-row">${g.tools.slice(0, 4).map(t => btn(`<span class="app-icon" aria-hidden="true">${esc(t.label.slice(0, 1))}</span><strong>${esc(t.label)}</strong><small>${esc(app(t.host).name)} · opens here</small>`, 'tool', 'app-tile', `data-tool="${esc(t.id)}"`)).join('')}</div></div>`).join('')}</section>`;
    const list = featuredApps().slice(0, 4);
    return `<section><div class="section-heading"><h2>${esc(preset.appsHeading)}</h2>${btn('About access', 'policy', 'text-button')}</div><div class="apps-row">${list.map(a => btn(`<span class="app-icon" aria-hidden="true">${esc(LIVE.initials(a.name))}</span><strong>${esc(a.name)}</strong><small>${esc(shell.suiteOf(a.suite).name)}${a.version ? ` · v${esc(a.version)}` : ''}</small>`, 'app', 'app-tile', `data-app="${esc(a.id)}"`)).join('') || '<p class="subtle">No applications from these suites are available in your workspace.</p>'}</div></section>`;
  }

  /* ── page composition ────────────────────────────────────────── */
  function sidebar() {
    const lm = key === 'classroom' && data.edu && data.edu.installed;
    const people = peopleList().slice(0, 6);
    const toolSection = hostGroups().map(g => `<div class="side-section"><div class="side-kicker">${esc(g.kicker)}</div><div class="tool-nav">${g.tools.slice(0, 6).map(t => btn(`<span class="nav-symbol" aria-hidden="true">${esc(t.label.slice(0, 1))}</span>${esc(t.label)}`, 'tool', 'nav-link', `data-tool="${esc(t.id)}" ${state.page === 'tool' && state.tool === t.id ? 'aria-current="page"' : ''}`)).join('')}</div></div>`).join('');
    return `<aside class="home-sidebar"><div><div class="wordmark ${key === 'classroom' ? 'class-brand' : ''}">${lm ? '<img class="monster-logo" src="/api/education/logo-96.png" alt="">' : `<span class="brand-glyph">${preset.mark}</span>`}${preset.short}</div><p class="workspace-label">${groupName() ? `${esc(groupName())} · ${groupMembers().length} ${groupMembers().length === 1 ? 'person' : 'people'}` : `${esc(displayName())}’s ${key === 'family' ? 'home' : key === 'classroom' ? 'classroom' : 'company swarm'}`} · ${snapshot.apps.length} apps</p></div><nav class="side-nav" aria-label="Homebase navigation">${preset.nav.map(([id, label], i) => btn(`<span class="nav-symbol" aria-hidden="true">${['⌂', '▦', '☷', '◎', '◇', '↻', '▤'][i] || '·'}</span>${esc(label)}`, 'page', 'nav-link', `data-page="${id}" ${id === state.page ? 'aria-current="page"' : ''}`)).join('')}</nav><div class="side-section"><div class="side-kicker">${preset.peopleKicker}</div>${people.map(memberLine).join('')}</div>${toolSection}<div class="side-section"><div class="side-kicker">YOUR APPLICATIONS</div>${featuredApps().slice(0, 5).map(a => btn(`<span class="nav-symbol" aria-hidden="true">${esc(a.name.slice(0, 1))}</span>${esc(a.name)}`, 'app', 'nav-link', `data-app="${esc(a.id)}"`)).join('')}${btn('<span class="nav-symbol" aria-hidden="true">…</span>All applications', 'all-apps', 'nav-link')}</div><div class="sidebar-note"><strong>${esc(preset.sidebarNote[0])}</strong>${esc(preset.sidebarNote[1])}${canConfigure() ? btn('Configure this home', 'configure', 'button sidebar-config') : ''}${link('Help and guides ↗', '/api/help', 'text-button sidebar-help', 'target="_blank" rel="noopener"')}</div></aside>`;
  }
  function hero() {
    if (state.page === 'tool') return '';
    const learner = isLearner();
    const heading = learner ? (key === 'family' ? `Your day, ${displayName().split(' ')[0]}.` : `Ready to explore, ${displayName().split(' ')[0]}?`) : preset.title;
    const admins = groupMembers().filter(m => m.role === 'admin').length;
    const badgeText = key === 'family' ? (groupName() ? `${groupMembers().length} ${groupMembers().length === 1 ? 'person' : 'people'} · ${admins} admin${admins === 1 ? '' : 's'} · ${shell.openWork().length} open items` : `${snapshot.apps.length} apps · ${shell.openWork().length} open items`) : key === 'classroom' ? (data.edu && data.edu.ok ? `${isTeacher() ? 'Teacher' : 'Student'} · ${data.edu.classes.length} class${data.edu.classes.length === 1 ? '' : 'es'}` : 'Classroom') : `${shell.openWork().length} open items · ${snapshot.botsOnline} assistants online`;
    const art = key === 'family' ? '<div class="family-scene" role="img" aria-label="A little house among green trees"><span class="plant"></span><span class="little-house"></span><span class="plant"></span></div>' : key === 'classroom' ? (data.edu && data.edu.installed ? '<img class="hero-monster" src="/api/education/logo-256.png" alt="Little Monsters study companion">' : '') : '<div class="company-emblem" aria-hidden="true"><span></span><span></span><span></span></div>';
    return `<section class="hero ${key === 'company' ? 'professional-hero' : ''}"><div><div class="eyebrow">${esc(preset.eyebrow)}</div><h1>${esc(heading)}</h1><p>${learner ? 'Your own learning space, with the shared moments close by.' : esc(preset.subtitle)}</p><div class="hero-cta">${pill(badgeText)}</div></div>${art}</section>`;
  }
  /* ── package summary cards and the declared front page ───────── */
  /** A tile row from a probe's tiles (live-data already caps them at four). */
  const cardTiles = tiles => tiles.length ? `<div class="card-tiles">${tiles.map(t => `<div class="card-tile tone-${esc(t.tone)}"><strong>${esc(t.value)}</strong><span>${esc(t.label)}</span></div>`).join('')}</div>` : '';
  /** The first three items of a probe as rows. */
  const cardItems = items => items.length ? `<div class="card-items">${items.slice(0, 3).map(i => `<div class="card-item tone-${esc(i.tone)}">${esc(i.text)}${i.detail ? `<small>${esc(i.detail)}</small>` : ''}</div>`).join('')}</div>` : '';
  /** @description The body of a summary card from the application's own probe answer: still reading, refused (its status and reason, nothing assumed in its place), empty, or tiles and items with the probe's own timestamp. */
  function cardBody(sm) {
    if (!sm) return '<p class="subtle">Reading…</p>';
    if (!sm.ok) return `<p class="subtle">${sm.status === 401 || sm.status === 403 ? 'Not available to you' : 'Unavailable right now'} (HTTP ${sm.status || 'network'}${sm.error ? `: ${esc(sm.error)}` : ''}). Nothing is shown in its place.</p>`;
    const body = cardTiles(sm.tiles) + cardItems(sm.items);
    const foot = sm.asOf ? `<p class="card-foot">As of ${esc(LIVE.relativeTime(new Date(sm.asOf)))}${sm.partial ? ' · partial' : ''}</p>` : (sm.partial ? '<p class="card-foot">Partial summary.</p>' : '');
    return (body || '<p class="subtle">Nothing to report from this application yet.</p>') + foot;
  }
  /**
   * @description One package summary card of the front page, rendered only for an application in the caller's plan that
   * declares a summary probe (otherwise nothing, and nothing asked). The action opens the named hosted tool in place when
   * this caller is admitted to it, else the application itself.
   * @param {{card: string, title?: string, kicker?: string, action?: {label: string, tool: string}}} entry The preset's module entry.
   * @returns {string} Markup, or '' when the card does not apply to this caller.
   */
  function summaryCard(entry) {
    const a = cardApp(entry.card); if (!a) return '';
    const tool = entry.action ? toolById(entry.action.tool) : null;
    const action = tool ? btn(esc(entry.action.label), 'tool', 'text-button', `data-tool="${esc(tool.id)}"`) : link(`Open ${esc(a.name)} ↗`, a.href, 'text-button');
    return `<section class="panel summary-card" data-module="card" data-card="${esc(entry.card)}"><div class="panel-kicker">${esc(entry.kicker || a.name.toUpperCase())}</div>${head(esc(entry.title || a.name), action)}${cardBody(data.cards ? data.cards.get(entry.card) : null)}</section>`;
  }
  /** The About dialog's line per applicable card: the application and the status its own probe answered. */
  const cardSources = () => cardEntries().map(m => ({ m, a: cardApp(m.card) })).filter(x => x.a).map(({ m, a }) => { const sm = data.cards && data.cards.get(m.card); return `<li>${esc(m.title || a.name)}: ${esc(a.name)}’s own summary probe ${!sm ? '(reading)' : sm.ok ? `(HTTP ${sm.status})` : sm.status === 401 || sm.status === 403 ? '(not available to you)' : `(HTTP ${sm.status || 'network'})`}.</li>`; }).join('');
  const MODULES = { calendar, shopping, 'home-facts': homeFacts, finance, learning, requirements, roster, projects, personal, updates, apps,
    locations: () => (key === 'family' ? M.locations() : ''), room: () => M.room(), 'family-admin': () => (key === 'family' ? M.familyAdmin() : '') };
  /** @description One declared module entry to markup: a named core module, a role pair ({teacher, otherwise}) or a package summary card ({card}). Anything else renders nothing. */
  function moduleHtml(entry) {
    if (typeof entry === 'string') return MODULES[entry] ? MODULES[entry]() : '';
    if (!entry || typeof entry !== 'object') return '';
    if (entry.card) return summaryCard(entry);
    if (entry.teacher || entry.otherwise) return moduleHtml(isTeacher() ? entry.teacher : entry.otherwise);
    return '';
  }
  /** @description A column of the declared front page; in the main column, consecutive cards share a two-up grid. */
  function columnHtml(entries, grid) {
    const out = []; let run = [];
    const flush = () => { if (run.length) out.push(grid && run.length > 1 ? `<div class="card-grid">${run.join('')}</div>` : run.join('')); run = []; };
    (entries || []).forEach(e => { const html = moduleHtml(e); if (!html) return; if (e && typeof e === 'object' && e.card) run.push(html); else { flush(); out.push(html); } });
    flush();
    return out.join('');
  }
  /** The calendar card the preset declares (Business: the Calendar application), for the calendar page. */
  const calendarCard = () => { const entry = cardEntries().find(m => m.card === 'calendar'); return entry ? summaryCard(entry) : ''; };
  /** @description The main and aside columns of each page; the front page is the preset's declared modules after the device's layout choices. */
  function pageColumns() {
    const p = state.page, family = key === 'family';
    if (p === 'home') { const m = preset.modules || {}; return [[columnHtml(M.arrange(m.main, true), true)], [columnHtml(M.arrange(m.aside, false), false)]]; }
    if (p === 'calendar') return [[calendarCard(), calendar(), M.dayAgenda()], [updates()]];
    if (p === 'shopping') return [[shopping()], [family ? M.locations() : '', homeFacts()]];
    if (p === 'people') return [[people(), family ? M.locations() : '', key === 'classroom' && isTeacher() ? roster() : ''], [family ? M.familyAdmin() : '', updates()]];
    if (p === 'requirements') return [[requirements()], [isTeacher() ? roster() : personal()]];
    if (p === 'projects') return [[projects(), apps()], [updates()]];
    if (p === 'routines') return [[M.routinesPage()], [calendar()]];
    if (p === 'search') return [[M.searchPage()], [updates()]];
    if (p === 'files') return [[M.filesPage()], [personal()]];
    if (p === 'tasks') return [[M.tasksPage()], [calendar()]];
    return [[personal()], [key === 'classroom' ? requirements() : calendar()]];
  }
  function content() {
    if (state.page === 'tool') return `<div class="home-content is-tool">${toolPanel()}</div>`;
    const [main, aside] = pageColumns();
    return `${M.roomTabs()}<div class="home-content"><div class="main-column">${main.join('')}<div class="assistant"><div class="assistant-line"><span class="assistant-orb" aria-hidden="true"></span><div>${esc(preset.assistantPrompt)}<small>${esc(preset.assistantLabel)} · answered by your Jarvis</small></div>${btn('Ask', 'ask', 'text-button')}</div>${M.bubble()}${M.composer()}</div></div><aside class="aside-column">${aside.join('')}</aside></div>`;
  }
  /** The breadcrumb's page name: the open tool, a nav or tab page, or Search. */
  const pageName = () => (state.page === 'tool' && toolById(state.tool) ? toolById(state.tool).label : state.page === 'search' ? 'Search' : ((preset.nav.concat(preset.tabs || [])).find(n => n[0] === state.page) || [])[1] || 'Home');
  /** The top bar's search box: it searches what this home read and the caller's own swarm data. */
  const searchBox = () => `<form id="home-search" class="home-search" role="search"><label class="screenreader" for="home-search-input">Search in this home</label><input id="home-search-input" type="search" maxlength="100" placeholder="Search in this home…" value="${esc(state.search ? state.search.query : '')}"><button class="text-button" type="submit" aria-label="Search">⌕</button></form>`;
  function render() {
    // A notice shown just before a repaint (an add, then the list re-read) stays: the new toast element takes its text.
    const shown = document.getElementById('toast') ? document.getElementById('toast').textContent : '';
    root.innerHTML = `<div class="experience" data-skin="${esc(document.body.dataset.skin || preset.skin)}" data-density="${esc(config.density)}"><div class="preview-bar"><a href="/cockpit/">← Cockpit</a><span class="demo-tag">LIVE · ${esc(displayName().toUpperCase())}</span><div class="preview-selects"><label>Experience ${S.pickerMarkup(key)}</label><label>Style ${S.skinPicker()}</label></div></div><div class="home-shell">${sidebar()}<main class="home-main"><header class="main-top"><div class="breadcrumb">${esc(groupName() || preset.name)} / ${esc(pageName())}</div><div class="top-controls">${searchBox()}<span class="date-chip">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>${canConfigure() ? btn('Configure home', 'configure') : ''}${btn('My access', 'policy')}${avatar(me().initials, 0)}</div></header>${hero()}${content()}<footer class="page-footer"><span>One platform · ${key} preset · ${esc(document.body.dataset.skin || preset.skin)} skin · display choices saved on this device (v${config.revision})<br>Access follows this swarm’s authorization; appearance never changes it.</span>${btn('About this data', 'about', 'text-button')}</footer></main></div><div id="dialog-host"></div><div class="toast" id="toast" role="status" aria-live="polite"></div></div>`;
    if (window.OSHAL_STYLE_SWITCHER) { const exp = root.querySelector('.experience'); const def = window.OSHAL_STYLE_SWITCHER.FLAT_SKINS.find(s => s.id === (document.body.dataset.skin || preset.skin)); if (exp && def) exp.dataset.skin = def.alias || def.id; }
    if (shown) document.getElementById('toast').textContent = shown;
    if (dialogKind) openDialog(dialogKind, dialogId);
  }

  /* ── dialogs ─────────────────────────────────────────────────── */
  function close() { const d = document.getElementById('homebase-dialog'); if (d) d.close(); document.getElementById('dialog-host').replaceChildren(); dialogKind = null; dialogId = null; if (opener && opener.isConnected) opener.focus(); }
  /** @description Teacher-only classwork form: the class picker offers only classes the caller teaches, and the type list is the package's own allowed set. The server still decides. */
  function classworkDialog() {
    const classes = teachableClasses(data.edu);
    if (!classes.length) return ['Add classwork', '<p>You do not teach a class in Little Monsters yet, so there is no class to post classwork to.</p>'];
    return ['Add classwork', `<p>Posted to Little Monsters for the whole class. A due date also puts it on the class calendar. Little Monsters offers no way to edit or remove classwork once it is posted.</p><form id="classwork-form"><label class="field">Class<select id="classwork-class" required>${classes.map(c => `<option value="${esc(c.class_id)}">${esc(c.name)}</option>`).join('')}</select></label><label class="field">Title<input id="classwork-title" maxlength="500" required placeholder="What should the class do?"></label><label class="field">Type<select id="classwork-type">${CLASSWORK_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label><label class="field">Due date (optional)<input id="classwork-due" type="date"></label><label class="field">Description (optional)<textarea id="classwork-description" maxlength="2000"></textarea></label><div class="dialog-actions"><button class="button primary" type="submit">Post classwork</button></div><p class="subtle" id="classwork-feedback" role="status"></p></form>`];
  }
  function draftsDialog() { return ['My drafts', `<p>Your saved Content Studio drafts and your newest finished Jarvis task, read for you alone. Nothing here is shared with the team.</p><div id="drafts-slot"><p class="subtle">Reading your drafts…</p></div><div class="dialog-actions">${link('Open Jarvis ↗', '/api/jarvis/', 'button primary')}</div>`]; }
  function projectDialog(id) {
    const w = snapshot.work.find(x => x.id === id); if (!w) return ['', ''];
    const ticket = w.kind === 'ticket' ? `<div id="ticket-slot" data-ticket="${esc(w.ref)}"><p class="subtle">Reading this ticket’s current state…</p></div>` : '';
    return [w.title, `<p class="pill">${esc(w.status.label)} · ${esc(w.appName)} · ${esc(w.typeLabel)}</p>${w.kind === 'task' ? S.answerHtml(w.result || w.error || '') : `<p>${esc(w.detail || 'No description recorded.')}</p>`}${ticket}<div class="dialog-actions">${link('Open ↗', w.href, 'button primary')}</div>`];
  }
  function dialogBody(kind, id) {
    const lm = app('little-monsters');
    if (kind === 'configure' && !canConfigure()) return ['', ''];
    if (kind === 'classwork') return isTeacher() ? classworkDialog() : ['', ''];
    if (kind === 'drafts') return draftsDialog();
    if (kind === 'event-detail') return M.eventDialog(id);
    if (kind === 'people-roles') return M.peopleRolesDialog();
    if (kind === 'devices') return key === 'family' ? M.devicesDialog() : ['', ''];
    if (kind === 'location-on') return key === 'family' ? M.locationOnDialog() : ['', ''];
    if (kind === 'configure') return ['Make this home your own', `<p>A preset supplies the starting point; a skin supplies the look. What you may see is decided by this swarm’s authorization, independently.</p><div class="config-flow"><span>${key} preset</span> → <span>your authorized modules</span> → <span>chosen skin</span></div><form id="config-form"><label class="field">Visual skin<select id="skin-choice">${window.OSHAL_STYLE_SWITCHER.FLAT_SKINS.map(s => `<option value="${s.id}" ${(document.body.dataset.skin || preset.skin) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label><label class="field">Density<select id="density-choice"><option value="comfortable" ${config.density === 'comfortable' ? 'selected' : ''}>Comfortable</option><option value="compact" ${config.density === 'compact' ? 'selected' : ''}>Compact</option></select></label><label class="config-check"><input id="show-updates" type="checkbox" ${config.updates ? 'checked' : ''}>Show the activity panel</label><label class="config-check"><input id="show-week" type="checkbox" ${config.week ? 'checked' : ''}>Show the calendar week strip</label>${M.configExtras()}<p>Changing a skin never grants Finance, reveals student records, installs an app or enrolls anyone in anything.</p><div class="dialog-actions"><button type="submit" class="button primary">Save on this device</button>${config.previous ? btn('Restore previous', 'restore') : ''}</div></form><p>Version ${config.revision} · saved in this browser only. No server setting changes.</p>`];
    if (kind === 'event') return ['Add a shared moment', data.edu && data.edu.ok ? `<p>This adds a personal event to your Little Monsters calendar${isTeacher() ? '; class-wide events are published from a class in Little Monsters' : ''}. No invitation is sent.</p><form id="event-form"><label class="field">Event title<input id="event-title" maxlength="200" required placeholder="A moment to make time for"></label><label class="field">Date<input id="event-date" type="date" value="${isoDay(new Date())}" required></label><label class="field">Time (optional)<input id="event-time" type="time"></label><div class="dialog-actions"><button class="button primary" type="submit">Add event</button></div></form>` : '<p>No calendar source accepts events here yet.</p>'];
    if (kind === 'learning') return [`${displayName()}’s learning space`, data.edu && data.edu.ok ? `<p>Your open classwork from Little Monsters. Nothing is submitted from here: Little Monsters keeps no per-learner submission record.</p><div class="list-items">${assignmentsOpen().map(a => `<div class="list-item"><span><span class="item-title">${esc(a.title)}</span><small>${esc(a.class_name || '')}${a.due_date ? ` · due ${esc(dueOn(a.due_date))}` : ''}${a.assignment_type ? ` · ${esc(a.assignment_type)}` : ''}</small></span></div>`).join('') || '<p class="subtle">Nothing open right now.</p>'}</div><div class="dialog-actions">${toolById('tool-lm-myday') ? btn('Open My Day here', 'tool', 'button primary', 'data-tool="tool-lm-myday"') : ''}${lm ? link('Open Little Monsters ↗', lm.href, toolById('tool-lm-myday') ? 'button' : 'button primary') : ''}</div>` : `<p>${esc(!data.edu ? 'Reading your learning space…' : !data.edu.installed ? 'Little Monsters is not installed on this swarm.' : eduRefusal(data.edu, `Your learning space could not be read (HTTP ${data.edu.status}).`))}</p>`];
    if (kind === 'app') { const a = app(id); if (!a) return ['', '']; const sm = shell.state.summaries.get(a.id); return [a.name, `<p>${esc(a.description)}</p><p class="pill">${esc(shell.suiteOf(a.suite).name)}${a.version ? ` · v${esc(a.version)}` : ''} · ${a.navigable ? 'available to you' : 'not available in your workspace'}</p><div id="app-summary-slot">${shell.summaryMarkup(a, sm || null)}</div><div class="dialog-actions">${a.navigable ? link(`Open ${esc(a.name)} ↗`, a.href, 'button primary') : ''}${btn('Review access', 'policy', 'button')}</div>`]; }
    if (kind === 'project') return projectDialog(id);
    if (kind === 'policy') return ['The same home, different access', `<p>Signed in as ${esc(displayName())}${data.edu && data.edu.me ? ` · ${esc(data.edu.me.role)} in Little Monsters` : ''}.</p><ul class="policy-list"><li>Applications appear only when this swarm’s authorization admits you to them.</li><li>Personal records require explicit, server-enforced access; a parent, teacher or admin label alone grants nothing.</li><li>Only a swarm administrator installs applications.</li><li>Class rosters are visible to each class’s teacher; students never see them.</li><li>Skins, density and pins are saved on this device and never change permissions.</li></ul>`];
    if (kind === 'ask') return [key === 'classroom' ? 'Ask your study companion' : 'Ask your assistant', `<p>Answered by your own Jarvis, in the same thread the cockpit uses.</p><form id="ask-form"><label class="field">Your question<input id="ask-input" maxlength="600" required placeholder="What should I focus on today?"${thread.busy ? ' disabled' : ''}></label><button class="button primary" type="submit"${thread.busy ? ' disabled' : ''}>Ask</button></form><div id="ask-answer" role="status">${thread.turns.slice(-4).map(t => t.role === 'user' ? `<p><strong>${esc(t.text)}</strong></p>` : t.pending ? `<p class="subtle">${esc(t.text)}</p>` : S.answerHtml(t.text)).join('')}</div>`];
    if (kind === 'about') { const e = data.edu || {}, s = data.shop || {}, f = data.fin || {}; return ['What this home reads', `<ul class="policy-list"><li>Applications, suites and availability: your authorized home plan and installed listing (HTTP ${snapshot.sources.plan}/${snapshot.sources.apps}).</li><li>Work items: your tickets (HTTP ${snapshot.sources.tickets}) and Jarvis tasks (HTTP ${snapshot.sources.tasks}).</li><li>Calendar, classes, classwork and rosters: Little Monsters ${e.installed ? (e.refusal === 'not-granted' && !e.status ? '(not available to you)' : `(HTTP ${e.status})`) : '(not installed)'}.</li><li>Shopping list: Purchasing ${s.installed ? `(HTTP ${s.status})` : '(not installed)'}.</li><li>Money: Finance ${f.installed ? (f.available ? `(HTTP ${f.status})` : '(not available to you)') : '(not installed)'}.</li>${cardSources()}<li>Assistant: your Jarvis thread <code>${esc(thread.sessionId.slice(0, 18))}…</code>.</li>${aboutExtras()}</ul>`]; }
    return ['', ''];
  }
  /** @description The About dialog's lines for the homebase's own sources: the household or team group, the check-in, learner progress and notices. */
  function aboutExtras() {
    const status = r => (!r ? '(reading)' : r.ok ? `(HTTP ${r.status})` : `(HTTP ${r.status || 'network'}${r.code ? `: ${esc(r.code)}` : ''})`);
    const lines = [];
    if (key !== 'classroom') lines.push(`<li>People: your ${key === 'family' ? 'household' : 'team'} group ${status(data.group)}; names only where the swarm directory shares them.</li>`);
    if (key === 'family') lines.push(`<li>Check-ins: your own place from Location ${status(data.loc)}, as a place name and never coordinates. No one else’s place is read: this swarm has no group presence read.</li>`);
    if (data.progress) lines.push(`<li>Your progress: Little Monsters’ dashboard for you ${status(data.progress)}.</li>`);
    if (data.notices) lines.push(`<li>Notices: your unread Little Monsters notices ${status(data.notices)}.</li>`);
    if (data.routines) lines.push(`<li>Routines: Jarvis briefings ${status(data.routines.briefings)} and your schedules ${status(data.routines.schedules)}.</li>`);
    return lines.join('');
  }
  function openDialog(kind, id) {
    const [title, body] = dialogBody(kind, id); if (!title) return;
    dialogKind = kind; dialogId = id === undefined ? null : id;
    document.getElementById('dialog-host').innerHTML = `<dialog id="homebase-dialog" class="config-dialog" aria-labelledby="dialog-title"><div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2>${btn('×', 'close', 'close', 'aria-label="Close panel"')}</div><div class="dialog-body">${body}</div></dialog>`;
    const d = document.getElementById('homebase-dialog'); d.showModal(); d.addEventListener('cancel', e => { e.preventDefault(); close(); }); d.addEventListener('click', e => { if (e.target === d) close(); });
    if (kind === 'app' && app(id)) shell.summaryFor(app(id)).then(sm => { shell.state.summaries.set(id, sm); const slot = document.getElementById('app-summary-slot'); if (slot) slot.innerHTML = shell.summaryMarkup(app(id), sm); });
    if (kind === 'project' && document.getElementById('ticket-slot')) fillTicketSlot(snapshot.work.find(x => x.id === id));
    if (kind === 'drafts') fillDrafts();
  }

  /* ── ticket state, drafts and classwork ──────────────────────── */
  /**
   * @description Fill the project dialog with the ticket's current state as the ticket route answers it, so the action offered matches the state the server holds now, not the list row read at load.
   * @param {object} w The ticket work item.
   * @returns {Promise<void>} Resolves once the slot is painted (or the dialog has moved on).
   */
  async function fillTicketSlot(w) {
    const r = await LIVE.packages.tickets.get(w.ref);
    const slot = document.getElementById('ticket-slot');
    if (slot && slot.dataset.ticket === w.ref) slot.innerHTML = ticketStateMarkup(w, r);
  }
  /**
   * @description The reason and next action of the transition that put the ticket in its current status, from
   * metadata.lastStatusTransition ({ status, ...metadata }, written on every transition). Only a mirror whose status is
   * the current status describes the current state; the row-level reason/nextAction fields may describe an older one.
   * @param {object} meta The ticket's metadata.
   * @param {string} status The ticket's current status.
   * @returns {{reason: string, next: string}} Both empty when the mirror is absent or describes another status.
   */
  function currentTransition(meta, status) {
    const last = meta.lastStatusTransition && typeof meta.lastStatusTransition === 'object' ? meta.lastStatusTransition : null;
    if (!last || String(last.status || '') !== status) return { reason: '', next: '' };
    const text = k => typeof last[k] === 'string' ? last[k].trim() : '';
    return { reason: text('reason') || text('message'), next: text('nextAction') };
  }
  /** @description State, and the reason and next action only when the transition mirror describes the current state; "Approve" only for approval_required when a human approval is what it waits for. */
  function ticketStateMarkup(w, r) {
    if (!r.ok || !r.body) return `<p class="subtle">This ticket’s current state could not be read (HTTP ${r.status}${esc(refusal(r))}).</p>`;
    const t = r.body, meta = t.metadata && typeof t.metadata === 'object' ? t.metadata : {}, status = String(t.status || '');
    const { reason, next } = currentTransition(meta, status);
    const facts = [['State', LIVE.statusOf(status).label], ['Reason', reason && human(reason)], ['Next action', next && human(next)]].filter(f => f[1]);
    const rows = `<dl class="ticket-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    if (status !== 'approval_required') return rows;
    if (next === 'none_children_dispatch_independently') return `${rows}<p>Nothing here waits for your approval: its child tickets dispatch on their own.</p>`;
    return `${rows}<p>Approving moves this ticket from Approval Required to Approved, where the queue picks it up on its next cycle. The server decides whether you may.</p><div class="dialog-actions">${btn('Approve', 'ticket-approve', 'button primary', `data-work="${esc(w.id)}"`)}</div><p class="subtle" id="ticket-feedback" role="status"></p>`;
  }
  /**
   * @description Ask the ticket route for approval_required → approved. The route enforces ownership and the transition table; its refusal is shown as text in the dialog.
   * @param {HTMLElement} b The approve button (carries the work item id).
   * @returns {Promise<void>} Resolves after the refusal is shown or the work list is reloaded.
   */
  async function approveTicket(b) {
    const w = snapshot.work.find(x => x.id === b.dataset.work), feedback = document.getElementById('ticket-feedback'); if (!w) return;
    b.disabled = true; if (feedback) feedback.textContent = 'Approving…';
    const r = await LIVE.packages.tickets.setStatus(w.ref, 'approved');
    if (!r.ok) { b.disabled = false; if (feedback) feedback.textContent = `Could not approve this ticket (HTTP ${r.status}${refusal(r)}).`; return; }
    close(); await LIVE.loadWork(snapshot);
    if (state.page !== 'tool') render();
    notice(`Approved: ${w.title} is now Approved; the queue picks it up on its next cycle.`);
  }
  /** @description Read the caller's saved drafts and Jarvis shelf together and paint both sections, each with its own empty and failure state. */
  async function fillDrafts() {
    const [drafts, tasks] = await Promise.all([LIVE.packages.content.drafts(), LIVE.packages.jarvis.tasks()]);
    data.draftsHtml = draftsMarkup(drafts);
    const slot = document.getElementById('drafts-slot'); if (slot) slot.innerHTML = data.draftsHtml + (dialogKind === 'drafts' ? finishedTaskMarkup(tasks) : '');
  }
  function draftRow(d) {
    const when = LIVE.parseDate(d.created_at), lines = String(d.draft || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 2).join(' ');
    return `<div class="list-item draft-row"><span><span class="item-title">${esc(d.topic || 'Untitled draft')}</span>${d.take ? `<small>Your take: ${esc(d.take)}</small>` : ''}<small class="draft-lines">${esc(lines.length > 220 ? `${lines.slice(0, 220)}…` : lines)}</small><small>Saved ${esc(when ? LIVE.relativeTime(when) : 'at an unknown time')}</small></span></div>`;
  }
  function draftsMarkup(r) {
    const list = r.ok && r.body && Array.isArray(r.body.drafts) ? r.body.drafts : null;
    const body = !list ? `<p class="subtle">Your saved Content Studio drafts could not be read (HTTP ${r.status}).</p>` : list.length ? `<div class="list-items">${list.slice(0, 10).map(draftRow).join('')}</div>` : '<p class="subtle">No Content Studio drafts saved yet.</p>';
    return `<h3>Your saved Content Studio drafts</h3>${body}`;
  }
  function finishedTaskMarkup(r) {
    const tasks = r.ok && r.body && Array.isArray(r.body.tasks) ? r.body.tasks : null, at = t => { const d = LIVE.parseDate(t.finishedAt); return d ? d.getTime() : 0; };
    const done = tasks ? tasks.filter(t => t && t.status === 'done').sort((a, b) => at(b) - at(a))[0] : null, finished = done ? LIVE.parseDate(done.finishedAt) : null, files = done && Array.isArray(done.files) ? done.files : [];
    const body = !tasks ? `<p class="subtle">Your Jarvis tasks could not be read (HTTP ${r.status}).</p>` : !done ? '<p class="subtle">No finished Jarvis task yet.</p>'
      : `<div class="list-item finished-task"><span><span class="item-title">${esc(done.title || 'Assistant task')}</span><small>Finished ${esc(finished ? LIVE.relativeTime(finished) : 'at an unknown time')}</small><small class="task-files">${files.map(f => S.fileLink(f) || esc(f.name || 'file')).join(' ') || 'No files'}</small></span></div>`;
    return `<h3>Newest finished Jarvis task</h3>${body}`;
  }
  /**
   * @description Post the teacher's classwork to the package route that also writes the class calendar event, then re-read the class data. A refusal stays in the dialog as text.
   * @param {HTMLFormElement} form The classwork form.
   * @returns {Promise<void>} Resolves after the refusal is shown or the home is repainted.
   */
  async function submitClasswork(form) {
    const val = id => document.getElementById(id).value.trim(), classId = val('classwork-class'), title = val('classwork-title'), due = val('classwork-due'), description = val('classwork-description');
    if (!classId || !title) return;
    const cls = data.edu.classes.find(c => c.class_id === classId), submit = form.querySelector('[type="submit"]'), feedback = document.getElementById('classwork-feedback');
    submit.disabled = true; feedback.textContent = 'Posting…';
    const r = await LIVE.packages.education.addClasswork({ classId, title, assignmentType: val('classwork-type'), dueDate: due || undefined, description: description || undefined });
    if (!r.ok) { submit.disabled = false; feedback.textContent = `Could not add the classwork (HTTP ${r.status}${refusal(r)}).`; return; }
    close(); await loadEducation();
    if (state.page !== 'tool') render();
    notice(`Classwork added to ${cls ? cls.name : 'the class'}${r.body && r.body.eventId ? ' and its class calendar' : ''}.`);
  }
  function open(kind, id) { opener = document.activeElement; openDialog(kind, id); }

  /* ── events ──────────────────────────────────────────────────── */
  function saveConfig(next) { config = { ...next, revision: config.revision + 1, previous: { ...config, previous: null } }; LIVE.prefs.set(`homebase:${key}`, config); }
  function bind() {
    window.addEventListener('message', onSurfaceMessage);
    // Turning a check-in on happens in Settings, Location (another tab); coming back re-reads it.
    window.addEventListener('focus', () => { if (locationAsked) { locationAsked = false; loadLocation().then(repaint); } });
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onSubmit);
  }
  /** Click actions that act on a record through its own route. */
  const ACTIONS = { 'device-stop': b => stopDevice(b), 'schedule-toggle': b => toggleSchedule(b), 'notice-read': b => markNotice(b), 'bubble-dismiss': b => { LIVE.prefs.set(`homebase:${key}:bubble`, b.dataset.seen || ''); repaint(); } };
  function onClick(e) {
    const b = e.target.closest('[data-action]'); if (!b) return; const a = b.dataset.action;
    if (a === 'close') return close();
    if (a === 'page') { goPage(b.dataset.page); return; }
    if (ACTIONS[a]) { ACTIONS[a](b); return; }
    if (a === 'tool') { if (dialogKind) close(); openTool(b.dataset.tool); return; }
    if (a === 'ticket-approve') { approveTicket(b); return; }
    if (a === 'all-apps') { location.href = '/portal#catalog-directory'; return; }
    if (a === 'restore' && config.previous) { const prev = config.previous; config = { ...prev, revision: config.revision + 1, previous: null }; LIVE.prefs.set(`homebase:${key}`, config); close(); render(); notice('Previous display choices restored.'); return; }
    if (a === 'project') return open('project', b.dataset.work);
    if (a === 'event-detail') return open('event-detail', b.dataset.event);
    open(a, b.dataset.app);
  }
  /** @description Show a page; Routines reads its sources the first time it opens and Files reads the caller's drafts. */
  function goPage(page) {
    if (dialogKind) close();
    state.page = page; state.tool = null; render();
    if (page === 'routines' && !data.routines) loadRoutines().then(repaint);
    if (page === 'files') fillDrafts();
  }
  async function onChange(e) {
    if (e.target.dataset.role === 'experience-picker') { const exp = S.experienceFor(e.target.value); if (exp) location.href = exp.href; }
    if (e.target.id === 'universal-skin-picker') { window.OSHAL_STYLE_SWITCHER.applySkin(e.target.value); render(); }
    if (e.target.id === 'share-location') { shareToggle(e.target); return; }
    if (e.target.dataset.briefing) { briefingToggle(e.target); return; }
    if (e.target.dataset.shoppingItem) {
      const itemId = e.target.dataset.shoppingItem, item = data.shop.items.find(i => i.item_id === itemId);
      e.target.disabled = true;
      const r = await LIVE.packages.purchasing.remove(data.shop.list.list_id, itemId);
      if (r.ok) { data.shopDone = (data.shopDone || []).concat(item ? [item.title] : []); notice(`Got it: ${item ? item.title : 'item'} removed from your list.`); await loadShopping(); render(); }
      else { e.target.checked = false; e.target.disabled = false; notice(`Could not update the list (HTTP ${r.status}).`); }
    }
  }

  /* ── check-ins, routines, notices, search and the household ─── */
  /**
   * @description The "share my check-in from this browser" switch. Switching off stops this browser's device through
   * the location route (no fresh sign-in: it only reduces exposure); switching on needs the step-up and the browser's
   * permission, so it opens the way to Settings, Location and leaves the switch as the server has it.
   * @param {HTMLInputElement} input The switch.
   * @returns {Promise<void>} Resolves once the state is re-read or the refusal shown.
   */
  async function shareToggle(input) {
    const dev = data.loc && data.loc.ok ? data.loc.thisDevice : null;
    if (input.checked) { input.checked = false; locationAsked = true; open('location-on'); return; }
    if (!dev) return;
    input.disabled = true;
    const r = await HD.optOut(dev.id);
    if (!r.ok) { input.checked = true; input.disabled = false; notice(`Could not stop sharing (HTTP ${r.status}${refusal(r)}).`); return; }
    await loadLocation(); repaint();
    notice('This browser no longer reports your check-in. Your current place is cleared; your history stays until you delete it.');
  }
  /** @description Stop one of the caller's devices from the Devices dialog; the dialog repaints with the state the server now holds. */
  async function stopDevice(b) {
    const feedback = document.getElementById('device-feedback'); b.disabled = true;
    const r = await HD.optOut(b.dataset.device);
    if (!r.ok) { b.disabled = false; if (feedback) feedback.textContent = `Could not stop this device (HTTP ${r.status}${refusal(r)}).`; return; }
    await loadLocation(); repaint(); notice('That device no longer reports your check-in.');
  }
  /** @description Pause or resume one of the caller's schedules through its owner-checked route, then re-read the routines. */
  async function toggleSchedule(b) {
    const pause = b.dataset.paused !== 'true'; b.disabled = true;
    const r = await HD.setSchedule(b.dataset.schedule, pause);
    if (!r.ok) { b.disabled = false; notice(`Could not ${pause ? 'pause' : 'resume'} that schedule (HTTP ${r.status}${refusal(r)}).`); return; }
    await loadRoutines(); repaint(); notice(pause ? 'Paused: it will not run until you resume it.' : 'Resumed.');
  }
  /** @description Turn one briefing source on or off, keeping its frequency and channel; the switch returns to the server's answer on a refusal. */
  async function briefingToggle(input) {
    const b = data.routines && data.routines.briefings, src = b && b.ok ? b.sources.find(x => x.id === input.dataset.briefing) : null; if (!src) return;
    const enabled = input.checked; input.disabled = true;
    const r = await HD.setBriefing(src, enabled);
    if (!r.ok) { input.checked = !enabled; input.disabled = false; notice(`Could not change ${src.title} (HTTP ${r.status}${refusal(r)}).`); return; }
    await loadRoutines(); repaint(); notice(`${src.title} is ${enabled ? 'on' : 'off'}.`);
  }
  /** @description Mark one Little Monsters notice read through the package route, then re-read the notices. */
  async function markNotice(b) {
    b.disabled = true;
    const r = await HD.markRead(b.dataset.notice);
    if (!r.ok) { b.disabled = false; notice(`Could not mark it read (HTTP ${r.status}).`); return; }
    data.notices = await HD.notifications(); repaint();
  }
  /** Everything this home already read, as rows the local search matches. */
  function searchPools() {
    return {
      events: (data.edu && data.edu.ok ? data.edu.events : []).map(e => ({ id: e.event_id, title: e.title, detail: e.class_name || 'Personal' })),
      items: data.shop && data.shop.items ? data.shop.items.map(i => ({ id: i.item_id, title: i.title })) : [],
      classwork: assignmentsOpen().map(a => ({ id: a.assignment_id, title: a.title, detail: a.class_name || '' })),
      tools: navTools().map(t => ({ id: t.id, title: t.label, detail: app(t.host) ? app(t.host).name : '' })),
      apps: snapshot.apps.filter(a => a.navigable).map(a => ({ id: a.id, title: a.name, detail: a.description })),
      work: snapshot.work.map(w => ({ id: w.id, title: w.title, detail: `${w.appName} · ${w.status.label}` }))
    };
  }
  /** @description Search this home's own reads at once, then the caller-scoped swarm search; a late answer for an older query is dropped. */
  async function runSearch(q) {
    if (dialogKind) close();
    state.search = { query: q, local: window.HOMEBASE_DATA.localMatches(q, searchPools()), global: null }; state.page = 'search'; state.tool = null; render();
    const global = await HD.search(q);
    if (state.search && state.search.query === q) { state.search.global = global; repaint(); }
  }
  /** @description Ask Jarvis for a routine in words; its answer lands in the home's thread and the schedules are re-read. */
  async function askRoutine(form) {
    const input = form.querySelector('#routine-input'), q = input.value.trim(), feedback = document.getElementById('routine-feedback'); if (!q || thread.busy) return;
    input.value = ''; if (feedback) feedback.textContent = 'Asking Jarvis…';
    const result = await thread.send(q, () => {});
    await loadRoutines(); repaint();
    notice(result && result.status === 'done' ? 'Jarvis answered; your schedules were read again.' : `Jarvis could not do that${result && result.error ? `: ${result.error}` : ''}.`);
  }
  /** @description Create the caller's household (they become its admin); the People & roles dialog repaints with it. */
  async function createHousehold(form) {
    const name = form.querySelector('#household-name').value.trim(), feedback = document.getElementById('household-feedback'), submit = form.querySelector('[type="submit"]'); if (!name) return;
    submit.disabled = true; if (feedback) feedback.textContent = 'Creating…';
    const r = await HD.createHousehold(name);
    if (!r.ok) { submit.disabled = false; if (feedback) feedback.textContent = `Could not create the household (HTTP ${r.status}${refusal(r)}).`; return; }
    await loadGroup(); repaint(); notice(`${name} is set up. You are its admin.`);
  }
  /** Submit handlers of the homebase's own forms. */
  const FORMS = { 'routine-form': f => askRoutine(f), 'household-form': f => createHousehold(f),
    'home-search': f => { const q = f.querySelector('#home-search-input').value.trim(); if (q) runSearch(q); },
    'composer-form': f => { const input = f.querySelector('#composer-input'), q = input.value.trim(); if (!q || thread.busy) return; input.value = ''; thread.send(q, repaint); } };
  async function onSubmit(e) {
    e.preventDefault();
    if (FORMS[e.target.id]) { await FORMS[e.target.id](e.target); return; }
    if (e.target.id === 'classwork-form') { await submitClasswork(e.target); return; }
    if (e.target.id === 'shopping-form') {
      const input = document.getElementById('shopping-input'), text = input.value.trim(); if (!text) return;
      input.disabled = true;
      let listId = data.shop.list ? data.shop.list.list_id : null;
      if (!listId) { const created = await LIVE.sendJson('/api/purchasing/lists', 'POST', { name: 'Shopping list' }); listId = created.ok && created.body && created.body.list ? created.body.list.list_id : null; }
      const r = listId ? await LIVE.packages.purchasing.add(listId, text, 1) : { ok: false, status: 0 };
      if (r.ok) { notice(`Added ${text} to your list.`); await loadShopping(); render(); const again = document.getElementById('shopping-input'); if (again) again.focus(); }
      else { input.disabled = false; notice(`Could not add that (HTTP ${r.status}).`); }
    }
    if (e.target.id === 'config-form') { saveConfig({ density: document.getElementById('density-choice').value, updates: document.getElementById('show-updates').checked, week: document.getElementById('show-week').checked, lead: (e.target.querySelector('input[name="lead-choice"]:checked') || { value: 'room' }).value, bot: document.getElementById('bot-choice').value === 'ask' ? 'ask' : 'suggest', hide: Array.from(e.target.querySelectorAll('input[data-keep]')).filter(i => !i.checked).map(i => i.dataset.keep) }); window.OSHAL_STYLE_SWITCHER.applySkin(document.getElementById('skin-choice').value); close(); render(); notice('Display choices saved on this device. No permissions changed.'); }
    if (e.target.id === 'event-form') {
      const title = document.getElementById('event-title').value.trim(), date = document.getElementById('event-date').value, time = document.getElementById('event-time').value;
      if (!title || !date) return;
      const r = await LIVE.packages.education.addEvent({ title, eventDate: date, eventTime: time || undefined, eventType: 'custom' });
      if (r.ok) { close(); notice('Event added to your calendar.'); await loadEducation(); render(); }
      else notice(`Could not add the event (HTTP ${r.status}${r.body && r.body.error ? `: ${r.body.error}` : ''}).`);
    }
    if (e.target.id === 'ask-form') {
      const input = document.getElementById('ask-input'), q = input.value.trim(); if (!q) return;
      input.value = '';
      thread.send(q, () => { const host = document.getElementById('ask-answer'); if (host) host.innerHTML = thread.turns.slice(-4).map(t => t.role === 'user' ? `<p><strong>${esc(t.text)}</strong></p>` : t.pending ? `<p class="subtle">${esc(t.text)}</p>` : t.error ? `<p class="subtle">${esc(t.text)}</p>` : S.answerHtml(t.text)).join(''); });
    }
  }
})();
