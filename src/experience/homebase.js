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
 */
(() => {
  'use strict';
  const S = window.OSHAL_SHELL, LIVE = window.OSHAL_LIVE, esc = S.esc;
  const presets = window.HOMEBASE_PRESETS;
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

  let snapshot, shell, data = {}, thread, dialogKind = null, dialogId = null, opener = null, timer, config;
  const state = { page: 'home', tool: null };
  const defaultConfig = () => ({ density: 'comfortable', updates: true, week: true, revision: 1, previous: null });
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
  const human = s => String(s).replace(/_/g, ' ');
  // The package's allowed assignment types (the lm_assignments CHECK constraint), with display labels.
  const CLASSWORK_TYPES = [['homework', 'Homework'], ['reading', 'Reading'], ['project', 'Project'], ['lab', 'Lab'], ['quiz-prep', 'Quiz prep'], ['test', 'Test']];
  const notice = s => { clearTimeout(timer); const t = document.getElementById('toast'); if (t) { t.textContent = s; timer = setTimeout(() => { t.textContent = ''; }, 4000); } };

  root.innerHTML = '<div class="experience"><div class="home-shell"><main class="home-main"><section class="hero"><div><div class="eyebrow">CONNECTING</div><h1>Reading your home…</h1></div></section></main></div></div>';
  LIVE.readyCore.then(boot).catch(err => { root.innerHTML = `<div class="experience"><main class="home-main"><section class="hero"><div><h1>This home could not load.</h1><p>${esc(err && err.message ? err.message : String(err))}</p></div></section></main></div>`; });

  async function boot(loaded) {
    snapshot = loaded;
    if (!snapshot.me.authenticated) { root.innerHTML = `<div class="experience"><main class="home-main"><section class="hero"><div><h1>Sign in to open your home.</h1><p>${link('Sign in', '/login', 'button primary')}</p></div></section></main></div>`; return; }
    shell = S.createShell({ snapshot, layoutId: key, hooks: {} });
    config = { ...defaultConfig(), ...(LIVE.prefs.get(`homebase:${key}`, {}) || {}) };
    thread = shell.createThread(LIVE.sessionId(), preset.assistantLabel);
    bind();
    render();
    // Work, tasks and the overview arrive in the second phase; repaint then unless a tool is open (a repaint would reload its frame).
    LIVE.ready.then(() => { if (state.page !== 'tool') render(); }).catch(() => { /* a home paints without work */ });
    await Promise.all([loadEducation(), loadTools(), loadShopping(), loadFinance(), loadHome(), loadDirectory(), loadUpdates()]);
    if (state.page !== 'tool') render();
  }

  /* ── live sources ────────────────────────────────────────────── */
  async function loadEducation() {
    if (!has('little-monsters')) { data.edu = { installed: false }; return; }
    const E = LIVE.packages.education, now = new Date(), next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const [meRes, classes, assignments, cal1, cal2] = await Promise.all([E.me(), E.classes(), E.assignments(), E.calendar(isoDay(now).slice(0, 7)), E.calendar(isoDay(next).slice(0, 7))]);
    const edu = { installed: true, ok: meRes.ok, status: meRes.status, me: meRes.ok ? meRes.body : null, classes: classes.ok && classes.body ? classes.body.classes || [] : [], assignments: assignments.ok && assignments.body ? assignments.body.assignments || [] : [], events: [], rosters: new Map(), activity: new Map() };
    const events = [].concat(cal1.ok && cal1.body ? cal1.body.events || [] : [], cal2.ok && cal2.body ? cal2.body.events || [] : []);
    const seen = new Set();
    edu.events = events.filter(e => e && e.event_id && !seen.has(e.event_id) && seen.add(e.event_id)).map(e => ({ ...e, when: new Date(`${String(e.event_date).slice(0, 10)}T${e.event_time || '00:00:00'}`) })).filter(e => !isNaN(e.when.getTime())).sort((a, b) => a.when - b.when);
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
  async function loadDirectory() {
    if (key !== 'company') { data.dir = null; return; }
    const r = await LIVE.packages.directory();
    const users = r.ok && r.body && Array.isArray(r.body.users) ? r.body.users : [];
    data.dir = { status: r.status, people: users.filter(u => u && u.sub !== me().sub).map(u => ({ name: String(u.label || 'Member').replace(/\s*\([^)]*\)\s*$/, ''), role: [u.source === 'verified-sign-in' ? 'Signed in' : u.source, u.signIn].filter(Boolean).join(' · ') })) };
  }
  async function loadUpdates() {
    const featured = featuredApps().slice(0, 4);
    const rows = await Promise.all(featured.map(async a => ({ app: a, summary: await LIVE.probeSummary(a) })));
    data.updates = rows.flatMap(({ app: a, summary }) => summary.ok ? summary.items.slice(0, 2).map(i => ({ who: a.name, what: i.text, detail: i.detail, when: summary.asOf ? LIVE.relativeTime(new Date(summary.asOf)) : 'now', tone: i.tone })) : []);
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
    const results = await Promise.all(hosts.map(async h => ({ host: h, r: await LIVE.packages.profile(h.app) })));
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
  const admittedTools = () => data.tools ? data.tools.items : [];
  /** Tools offered in the rails: the preset's hidden prefixes stay out (per-class tools and off-audience tiles have their own place). */
  const navTools = () => admittedTools().filter(t => !t.hidden);
  const toolById = id => admittedTools().find(t => t.id === id) || null;
  /** The offered tools grouped by host, in host order. */
  const hostGroups = () => { const groups = []; navTools().forEach(t => { let g = groups.find(x => x.host === t.host); if (!g) { g = { host: t.host, kicker: t.kicker, tools: [] }; groups.push(g); } g.tools.push(t); }); return groups; };
  /** The URL a hosted tool opens with: its own surface plus this preset's audience view, as a request (a view id is never authority). */
  const hostedUrl = t => { const u = new URL(t.href, location.origin); if (preset.audience && !u.searchParams.has('audience')) u.searchParams.set('audience', preset.audience); return u.pathname + u.search + u.hash; };
  /** @description Open an admitted tool in place. Anything not admitted for this caller is refused with a notice, never fetched. */
  function openTool(id) {
    const t = toolById(id);
    if (!t) { notice('That view is not available to you here.'); return; }
    state.page = 'tool'; state.tool = t.id; render();
    const frame = document.getElementById('tool-frame'); if (frame) frame.focus();
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
  function calendar() {
    const edu = data.edu, events = upcomingEvents(), canAdd = Boolean(edu && edu.ok);
    const body = !edu ? '<p class="subtle">Reading the calendar…</p>' : !edu.installed ? '<p class="subtle">No application on this swarm contributes a shared calendar yet. Little Monsters adds class and personal events when it is installed.</p>' : !edu.ok ? `<p class="subtle">The calendar could not be read (HTTP ${edu.status}). ${edu.status === 403 || edu.status === 404 ? 'Open Little Monsters once to create your learner profile.' : ''}</p>` : events.length ? events.map(e => `<div class="event"><div class="event-time">${esc(e.event_time ? LIVE.clockTime(e.when).replace(/\s?[AP]M$/i, '') : isoDay(e.when) === isoDay(new Date()) ? 'Today' : e.when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}<small>${esc(e.event_time ? (e.when.getHours() >= 12 ? 'PM' : 'AM') : '')}</small></div><div><strong>${esc(e.title)}</strong><p>${esc(e.class_name ? `${e.class_name}${e.subject ? ` · ${e.subject}` : ''}` : 'Personal')}${e.event_type && e.event_type !== 'custom' ? ` · ${esc(e.event_type)}` : ''}</p></div>${pill(e.class_name ? 'Class' : 'Personal')}</div>`).join('') : '<p class="subtle">Nothing scheduled in the next weeks. Add a moment below or open Little Monsters.</p>';
    return `<section class="panel" data-module="calendar">${head(preset.calendarHeading, canAdd ? btn('+ Add', 'event', 'text-button') : '')}${config.week ? weekStrip() : ''}${body}<p class="subtle" style="margin-top:17px">${edu && edu.ok ? `Class events from ${edu.classes.length} class${edu.classes.length === 1 ? '' : 'es'} plus your personal events, read from Little Monsters.` : 'Calendar source: Little Monsters class and personal events.'}</p></section>`;
  }
  function shopping() {
    const s = data.shop;
    const body = !s ? '<p class="subtle">Reading your list…</p>' : !s.installed ? '<p class="subtle">The Purchasing application is not installed on this swarm, so there is no shared shopping list here.</p>' : !s.ok ? `<p class="subtle">Your shopping list could not be read (HTTP ${s.status}).</p>` : !s.list ? '<p class="subtle">You have no shopping list yet. Add the first item below to create one in Purchasing.</p>' : `<div class="list-items">${s.items.map(i => `<label class="list-item"><input type="checkbox" data-shopping-item="${esc(i.item_id)}"><span><span class="item-title">${esc(i.title)}</span><small>${i.quantity > 1 ? `×${i.quantity} · ` : ''}${i.unit_price ? `${money(Number(i.unit_price))} · ` : ''}added ${esc(LIVE.relativeTime(LIVE.parseDate(i.created_at)))}</small></span></label>`).join('') || '<p class="subtle">Nothing pending on this list.</p>'}</div>`;
    return `<section class="panel" data-module="shopping">${head('One list. Fewer texts.', s && s.list ? pill(`${s.items.length} to get`) : '')}${body}${s && s.installed && s.ok ? '<form id="shopping-form" class="add-form"><label class="screenreader" for="shopping-input">Add to the shopping list</label><input id="shopping-input" maxlength="100" placeholder="Anything else we need?" required><button class="button" type="submit" aria-label="Add item">+</button></form><p class="subtle">Ticking an item removes it from the list in Purchasing.</p>' : ''}</section>`;
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
    if (!edu.ok) return `<section class="panel feature-card" data-module="learning"><div class="panel-kicker">JUST FOR ${esc(displayName().toUpperCase())}</div><h2>Your learning space is waiting.</h2><p>Open Little Monsters once to create your learner profile; your classes and classwork will appear here.</p>${lm ? link('Open Little Monsters ↗', lm.href, 'button') : ''}</section>`;
    if (isTeacher()) return `<section class="panel feature-card" data-module="learning"><div class="panel-kicker">JUST FOR ${esc(displayName().toUpperCase())}</div><h2>You teach ${edu.me.classCount || edu.classes.length} class${(edu.me.classCount || edu.classes.length) === 1 ? '' : 'es'}.</h2><p>${assignmentsOpen().length} open classwork item${assignmentsOpen().length === 1 ? '' : 's'} across them.</p>${lm ? link('Open Little Monsters ↗', lm.href, 'button') : ''}</section>`;
    const open = assignmentsOpen(), total = edu.assignments.length, done = total - open.length, next = open[0];
    return `<section class="panel feature-card" data-module="learning"><div class="panel-kicker">JUST FOR ${esc(displayName().toUpperCase())}</div><h2>A little progress, every day.</h2><p>${edu.classes.length} class${edu.classes.length === 1 ? '' : 'es'} · ${open.length} open classwork item${open.length === 1 ? '' : 's'}.</p><div class="focus-count">${done}<span style="font:13px 'Segoe UI',sans-serif"> / ${total} classwork done</span></div><div class="progress-track" role="progressbar" aria-label="Classwork completed" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="width:${total ? done / total * 100 : 0}%"></span></div><p>${next ? `Next: ${esc(next.title)}${next.class_name ? ` · ${esc(next.class_name)}` : ''}${next.due_date ? ` · due ${esc(new Date(next.due_date).toLocaleDateString())}` : ''}` : 'Nothing is due right now.'}</p>${btn('Open my checklist', 'learning', 'button')}</section>`;
  }
  function requirements() {
    const edu = data.edu, lm = app('little-monsters'), open = assignmentsOpen(), next = open[0];
    if (!edu) return `<section class="panel ${state.page === 'home' ? 'quest-card' : ''}" data-module="requirements-loading"><div class="panel-kicker">CLASSWORK</div><p>Reading classwork…</p></section>`;
    if (!edu.installed || !edu.ok) return `<section class="panel ${state.page === 'home' ? 'quest-card' : ''}" data-module="requirements"><div class="panel-kicker">CLASSWORK</div><h2>${!edu || !edu.installed ? 'Little Monsters is not installed.' : 'Open Little Monsters to join a class.'}</h2><p>Classwork appears here once you belong to a class.</p></section>`;
    return `<section class="panel ${state.page === 'home' ? 'quest-card' : ''}" data-module="requirements"><div class="panel-kicker">CLASSWORK / ${open.length} OPEN</div><h2>${next ? esc(next.title) : 'No open classwork.'}</h2><p style="margin:12px 0 16px">${next ? esc(next.description || `${next.class_name || 'Class'}${next.assignment_type ? ` · ${next.assignment_type}` : ''}`) : 'When a teacher publishes an assignment it appears here with its due date.'}</p>${open.length ? `<ol class="requirement-list">${open.slice(0, 4).map((a, i) => `<li><span class="step-num">${i + 1}</span><span>${esc(a.title)}${a.class_name ? ` <small class="subtle">· ${esc(a.class_name)}</small>` : ''}${a.due_date ? ` <small class="subtle">· due ${esc(new Date(a.due_date).toLocaleDateString())}</small>` : ''}</span></li>`).join('')}</ol>` : ''}<div class="quest-footer">${isTeacher() ? `${btn('Add classwork', 'classwork', 'button primary')}${lm ? link('Manage classwork in Little Monsters ↗', lm.href, 'button') : ''}` : btn('Open my checklist', 'learning', 'button primary')}${pill(`${edu.classes.length} class${edu.classes.length === 1 ? '' : 'es'} · shared with your class`)}</div></section>`;
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
    const a = act && act.byId ? act.byId.get(s.student_id) : null, last = a && a.last_active_date ? new Date(`${String(a.last_active_date).slice(0, 10)}T00:00:00`) : null;
    return `<div class="learner-row" data-learner="${esc(s.student_id)}"><div class="member-line">${avatar(LIVE.initials(s.name), 0)}<span>${esc(s.name)}<small>enrolled ${esc(LIVE.relativeTime(LIVE.parseDate(s.enrolled_at)))}${last && !isNaN(last.getTime()) ? ` · last active ${esc(last.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}` : ''}</small></span></div>${a ? activityPill(a) : ''}</div>`;
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
  function projects() {
    const open = shell.openWork(), apps = new Set(open.map(w => w.appName));
    return `<section class="panel" data-module="projects">${head('The work we share.', pill(`${open.length} open`))}${open.slice(0, 6).map((w, i) => `<div class="project-row">${avatar(LIVE.initials(w.appName), i)}<div><strong>${esc(w.title)}</strong><small>${esc(w.appName)} · ${esc(w.typeLabel)} · ${esc(LIVE.relativeTime(w.at))}</small></div>${btn(`${esc(w.status.label)} ↗`, 'project', 'button', `data-work="${esc(w.id)}"`)}</div>`).join('') || '<p class="subtle">No open tickets or tasks. Ask the assistant for something and it lands here.</p>'}<div class="summary-line"><div><strong>${open.length}</strong><small>Open items</small></div><div><strong>${apps.size}</strong><small>Applications involved</small></div><div><strong>${snapshot.botsOnline}</strong><small>Assistants online</small></div></div></section>`;
  }
  function personal() {
    if (key === 'classroom') return learning();
    if (key === 'family') return isLearner() ? learning() : (data.fin && data.fin.installed ? finance() : learning());
    return data.fin && data.fin.installed ? finance() : `<section class="panel feature-card" data-module="personal"><div class="panel-kicker">${esc(displayName().toUpperCase())} / PERSONAL WORKSPACE</div><h2>Room for your best work.</h2><p>Your drafts and assistant conversations stay personal until you share them with the team.</p><div class="dialog-actions">${btn('My drafts', 'drafts', 'button primary')}${link('Open Jarvis ↗', '/api/jarvis/', 'button')}</div></section>`;
  }
  function updates() {
    if (!config.updates) return '';
    const rows = (data.updates || []).slice(0, 4), work = snapshot.work.slice(0, 3);
    return `<section class="panel" data-module="updates">${head(preset.updatesHeading)}${rows.map(u => `<div class="update"><strong>${esc(u.who)}</strong><p>${esc(u.what)}</p><small>${esc(u.when)}${u.detail ? ` · ${esc(u.detail.slice(0, 90))}` : ''}</small></div>`).join('')}${work.map(w => `<div class="update"><strong>${esc(w.appName)}</strong><p>${esc(w.title)}</p><small>${esc(w.status.label)} · ${esc(LIVE.relativeTime(w.at))}</small></div>`).join('')}${rows.length || work.length ? '' : '<p class="subtle">Nothing new from your applications yet.</p>'}</section>`;
  }
  function peopleList() {
    const edu = data.edu, rows = [];
    rows.push({ mark: me().initials, name: `${displayName()} · you`, role: key === 'classroom' ? (isTeacher() ? 'Teacher' : isLearner() ? 'Student' : 'Not in a class yet') : me().email || 'Signed in' });
    if (key === 'classroom' && edu && edu.ok) edu.classes.forEach(c => { if (c.teacher_name && !rows.some(r => r.name === c.teacher_name)) rows.push({ mark: LIVE.initials(c.teacher_name), name: c.teacher_name, role: `Teacher · ${c.name}` }); (edu.rosters.get(c.class_id) || {}).students?.forEach(s => rows.push({ mark: LIVE.initials(s.name), name: s.name, role: `Student · ${c.name}` })); });
    if (key === 'company' && data.dir && data.dir.status === 200) data.dir.people.slice(0, 12).forEach(p => rows.push({ mark: LIVE.initials(p.name), name: p.name, role: p.role || 'Member' }));
    return rows;
  }
  const memberLine = (r, i) => `<div class="member-line">${avatar(r.mark, i)}<span>${esc(r.name)}<small>${esc(r.role)}</small></span></div>`;
  function people() {
    const rows = peopleList();
    const note = key === 'classroom' ? 'Names come from your classes in Little Monsters. Grades and personal study records are not a class feed.' : key === 'company' ? (data.dir && data.dir.status === 200 ? 'Members come from this swarm’s user directory.' : 'This swarm does not share a people directory with your account; teammates appear where an application publishes membership.') : 'This swarm has no household directory yet. People appear where an application shares membership with you.';
    return `<section class="panel">${head(key === 'family' ? 'Our people' : key === 'classroom' ? 'Your classroom' : 'Your team')}<div class="side-section">${rows.map(memberLine).join('')}</div><p class="subtle" style="margin-top:20px">${note}</p><p class="subtle">${snapshot.botsOnline} of ${snapshot.bots.length} swarm assistants are online.</p></section>`;
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
    return `<aside class="home-sidebar"><div><div class="wordmark ${key === 'classroom' ? 'class-brand' : ''}">${lm ? '<img class="monster-logo" src="/api/education/logo-96.png" alt="">' : `<span class="brand-glyph">${preset.mark}</span>`}${preset.short}</div><p class="workspace-label">${esc(displayName())}’s ${key === 'family' ? 'home' : key === 'classroom' ? 'classroom' : 'company swarm'} · ${snapshot.apps.length} apps</p></div><nav class="side-nav" aria-label="Homebase navigation">${preset.nav.map(([id, label], i) => btn(`<span class="nav-symbol" aria-hidden="true">${['⌂', '▦', '☷', '◎', '◇'][i]}</span>${esc(label)}`, 'page', 'nav-link', `data-page="${id}" ${id === state.page ? 'aria-current="page"' : ''}`)).join('')}</nav><div class="side-section"><div class="side-kicker">${preset.peopleKicker}</div>${people.map(memberLine).join('')}</div>${toolSection}<div class="side-section"><div class="side-kicker">YOUR APPLICATIONS</div>${featuredApps().slice(0, 5).map(a => btn(`<span class="nav-symbol" aria-hidden="true">${esc(a.name.slice(0, 1))}</span>${esc(a.name)}`, 'app', 'nav-link', `data-app="${esc(a.id)}"`)).join('')}${btn('<span class="nav-symbol" aria-hidden="true">…</span>All applications', 'all-apps', 'nav-link')}</div><div class="sidebar-note"><strong>${esc(preset.sidebarNote[0])}</strong>${esc(preset.sidebarNote[1])}${canConfigure() ? btn('Configure this home', 'configure', 'button sidebar-config') : ''}</div></aside>`;
  }
  function hero() {
    if (state.page === 'tool') return '';
    const learner = isLearner();
    const heading = learner ? `Ready to explore, ${displayName().split(' ')[0]}?` : preset.title;
    const badgeText = key === 'family' ? `${snapshot.apps.length} apps · ${shell.openWork().length} open items` : key === 'classroom' ? (data.edu && data.edu.ok ? `${isTeacher() ? 'Teacher' : 'Student'} · ${data.edu.classes.length} class${data.edu.classes.length === 1 ? '' : 'es'}` : 'Classroom') : `${shell.openWork().length} open items · ${snapshot.botsOnline} assistants online`;
    const art = key === 'family' ? '<div class="family-scene" role="img" aria-label="A little house among green trees"><span class="plant"></span><span class="little-house"></span><span class="plant"></span></div>' : key === 'classroom' ? (data.edu && data.edu.installed ? '<img class="hero-monster" src="/api/education/logo-256.png" alt="Little Monsters study companion">' : '') : '<div class="company-emblem" aria-hidden="true"><span></span><span></span><span></span></div>';
    return `<section class="hero ${key === 'company' ? 'professional-hero' : ''}"><div><div class="eyebrow">${esc(preset.eyebrow)}</div><h1>${esc(heading)}</h1><p>${learner ? 'Your own learning space, with the shared moments close by.' : esc(preset.subtitle)}</p><div class="hero-cta">${pill(badgeText)}</div></div>${art}</section>`;
  }
  function content() {
    if (state.page === 'tool') return `<div class="home-content is-tool">${toolPanel()}</div>`;
    let main = [], aside = [];
    if (state.page === 'home') {
      if (key === 'family') { main = [calendar(), homeFacts(), apps()]; aside = [personal(), shopping(), updates()]; }
      else if (key === 'classroom') { main = [requirements(), isTeacher() ? roster() : calendar(), apps()]; aside = [isTeacher() ? calendar() : personal(), updates()]; }
      else { main = [projects(), calendar(), apps()]; aside = [personal(), updates()]; }
    } else if (state.page === 'calendar') { main = [calendar()]; aside = [updates()]; }
    else if (state.page === 'shopping') { main = [shopping()]; aside = [homeFacts()]; }
    else if (state.page === 'people') { main = [people(), key === 'classroom' && isTeacher() ? roster() : ''].filter(Boolean); aside = [updates()]; }
    else if (state.page === 'requirements') { main = [requirements()]; aside = [isTeacher() ? roster() : personal()]; }
    else if (state.page === 'projects') { main = [projects(), apps()]; aside = [updates()]; }
    else { main = [personal()]; aside = [key === 'classroom' ? requirements() : calendar()]; }
    const last = thread.turns.filter(t => t.role === 'jarvis' && !t.pending).slice(-1)[0];
    return `<div class="home-content"><div class="main-column">${main.join('')}<div class="assistant"><span class="assistant-orb" aria-hidden="true"></span><div>${esc(preset.assistantPrompt)}<small>${esc(preset.assistantLabel)} · answered by your Jarvis${last ? ` · last reply ${esc(String(last.text).slice(0, 60))}…` : ''}</small></div>${btn('Ask', 'ask', 'text-button')}</div></div><aside class="aside-column">${aside.join('')}</aside></div>`;
  }
  function render() {
    root.innerHTML = `<div class="experience" data-skin="${esc(document.body.dataset.skin || preset.skin)}" data-density="${esc(config.density)}"><div class="preview-bar"><a href="/cockpit/">← Cockpit</a><span class="demo-tag">LIVE · ${esc(displayName().toUpperCase())}</span><div class="preview-selects"><label>Experience ${S.pickerMarkup(key)}</label><label>Style ${S.skinPicker()}</label></div></div><div class="home-shell">${sidebar()}<main class="home-main"><header class="main-top"><div class="breadcrumb">${esc(preset.name)} / ${esc(state.page === 'tool' && toolById(state.tool) ? toolById(state.tool).label : (preset.nav.find(n => n[0] === state.page) || [])[1] || 'Home')}</div><div class="top-controls"><span class="date-chip">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>${canConfigure() ? btn('Configure home', 'configure') : ''}${btn('My access', 'policy')}${avatar(me().initials, 0)}</div></header>${hero()}${content()}<footer class="page-footer"><span>One platform · ${key} preset · ${esc(document.body.dataset.skin || preset.skin)} skin · display choices saved on this device (v${config.revision})<br>Access follows this swarm’s authorization; appearance never changes it.</span>${btn('About this data', 'about', 'text-button')}</footer></main></div><div id="dialog-host"></div><div class="toast" id="toast" role="status" aria-live="polite"></div></div>`;
    if (window.OSHAL_STYLE_SWITCHER) { const exp = root.querySelector('.experience'); const def = window.OSHAL_STYLE_SWITCHER.FLAT_SKINS.find(s => s.id === (document.body.dataset.skin || preset.skin)); if (exp && def) exp.dataset.skin = def.alias || def.id; }
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
    if (kind === 'configure') return ['Make this home your own', `<p>A preset supplies the starting point; a skin supplies the look. What you may see is decided by this swarm’s authorization, independently.</p><div class="config-flow"><span>${key} preset</span> → <span>your authorized modules</span> → <span>chosen skin</span></div><form id="config-form"><label class="field">Visual skin<select id="skin-choice">${window.OSHAL_STYLE_SWITCHER.FLAT_SKINS.map(s => `<option value="${s.id}" ${(document.body.dataset.skin || preset.skin) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label><label class="field">Density<select id="density-choice"><option value="comfortable" ${config.density === 'comfortable' ? 'selected' : ''}>Comfortable</option><option value="compact" ${config.density === 'compact' ? 'selected' : ''}>Compact</option></select></label><label class="config-check"><input id="show-updates" type="checkbox" ${config.updates ? 'checked' : ''}>Show the activity panel</label><label class="config-check"><input id="show-week" type="checkbox" ${config.week ? 'checked' : ''}>Show the calendar week strip</label><p>Changing a skin never grants Finance, reveals student records, installs an app or enrolls anyone in anything.</p><div class="dialog-actions"><button type="submit" class="button primary">Save on this device</button>${config.previous ? btn('Restore previous', 'restore') : ''}</div></form><p>Version ${config.revision} · saved in this browser only. No server setting changes.</p>`];
    if (kind === 'event') return ['Add a shared moment', data.edu && data.edu.ok ? `<p>This adds a personal event to your Little Monsters calendar${isTeacher() ? '; class-wide events are published from a class in Little Monsters' : ''}. No invitation is sent.</p><form id="event-form"><label class="field">Event title<input id="event-title" maxlength="200" required placeholder="A moment to make time for"></label><label class="field">Date<input id="event-date" type="date" value="${isoDay(new Date())}" required></label><label class="field">Time (optional)<input id="event-time" type="time"></label><div class="dialog-actions"><button class="button primary" type="submit">Add event</button></div></form>` : '<p>No calendar source accepts events here yet.</p>'];
    if (kind === 'learning') return [`${displayName()}’s learning space`, data.edu && data.edu.ok ? `<p>Your open classwork from Little Monsters. Nothing is submitted from here: Little Monsters keeps no per-learner submission record.</p><div class="list-items">${assignmentsOpen().map(a => `<div class="list-item"><span><span class="item-title">${esc(a.title)}</span><small>${esc(a.class_name || '')}${a.due_date ? ` · due ${esc(new Date(a.due_date).toLocaleDateString())}` : ''}${a.assignment_type ? ` · ${esc(a.assignment_type)}` : ''}</small></span></div>`).join('') || '<p class="subtle">Nothing open right now.</p>'}</div><div class="dialog-actions">${toolById('tool-lm-myday') ? btn('Open My Day here', 'tool', 'button primary', 'data-tool="tool-lm-myday"') : ''}${lm ? link('Open Little Monsters ↗', lm.href, toolById('tool-lm-myday') ? 'button' : 'button primary') : ''}</div>` : '<p>Open Little Monsters once to create your learner profile.</p>'];
    if (kind === 'app') { const a = app(id); if (!a) return ['', '']; const sm = shell.state.summaries.get(a.id); return [a.name, `<p>${esc(a.description)}</p><p class="pill">${esc(shell.suiteOf(a.suite).name)}${a.version ? ` · v${esc(a.version)}` : ''} · ${a.navigable ? 'available to you' : 'not available in your workspace'}</p><div id="app-summary-slot">${shell.summaryMarkup(a, sm || null)}</div><div class="dialog-actions">${a.navigable ? link(`Open ${esc(a.name)} ↗`, a.href, 'button primary') : ''}${btn('Review access', 'policy', 'button')}</div>`]; }
    if (kind === 'project') return projectDialog(id);
    if (kind === 'policy') return ['The same home, different access', `<p>Signed in as ${esc(displayName())}${data.edu && data.edu.me ? ` · ${esc(data.edu.me.role)} in Little Monsters` : ''}.</p><ul class="policy-list"><li>Applications appear only when this swarm’s authorization admits you to them.</li><li>Personal records require explicit, server-enforced access; a parent, teacher or admin label alone grants nothing.</li><li>Only a swarm administrator installs applications.</li><li>Class rosters are visible to each class’s teacher; students never see them.</li><li>Skins, density and pins are saved on this device and never change permissions.</li></ul>`];
    if (kind === 'ask') return [key === 'classroom' ? 'Ask your study companion' : 'Ask your assistant', `<p>Answered by your own Jarvis, in the same thread the cockpit uses.</p><form id="ask-form"><label class="field">Your question<input id="ask-input" maxlength="600" required placeholder="What should I focus on today?"${thread.busy ? ' disabled' : ''}></label><button class="button primary" type="submit"${thread.busy ? ' disabled' : ''}>Ask</button></form><div id="ask-answer" role="status">${thread.turns.slice(-4).map(t => t.role === 'user' ? `<p><strong>${esc(t.text)}</strong></p>` : t.pending ? `<p class="subtle">${esc(t.text)}</p>` : S.answerHtml(t.text)).join('')}</div>`];
    if (kind === 'about') { const e = data.edu || {}, s = data.shop || {}, f = data.fin || {}; return ['What this home reads', `<ul class="policy-list"><li>Applications, suites and availability: your authorized home plan and installed listing (HTTP ${snapshot.sources.plan}/${snapshot.sources.apps}).</li><li>Work items: your tickets (HTTP ${snapshot.sources.tickets}) and Jarvis tasks (HTTP ${snapshot.sources.tasks}).</li><li>Calendar, classes, classwork and rosters: Little Monsters ${e.installed ? `(HTTP ${e.status})` : '(not installed)'}.</li><li>Shopping list: Purchasing ${s.installed ? `(HTTP ${s.status})` : '(not installed)'}.</li><li>Money: Finance ${f.installed ? (f.available ? `(HTTP ${f.status})` : '(not available to you)') : '(not installed)'}.</li><li>Assistant: your Jarvis thread <code>${esc(thread.sessionId.slice(0, 18))}…</code>.</li></ul><p>No check-in, location or presence source exists on this swarm, so no such module is shown.</p>`]; }
    return ['', ''];
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
    const slot = document.getElementById('drafts-slot'); if (slot) slot.innerHTML = draftsMarkup(drafts) + finishedTaskMarkup(tasks);
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
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-action]'); if (!b) return; const a = b.dataset.action;
      if (a === 'close') return close();
      if (a === 'page') { state.page = b.dataset.page; state.tool = null; render(); return; }
      if (a === 'tool') { if (dialogKind) close(); openTool(b.dataset.tool); return; }
      if (a === 'ticket-approve') { approveTicket(b); return; }
      if (a === 'all-apps') { location.href = '/portal#catalog-directory'; return; }
      if (a === 'restore' && config.previous) { const prev = config.previous; config = { ...prev, revision: config.revision + 1, previous: null }; LIVE.prefs.set(`homebase:${key}`, config); close(); render(); notice('Previous display choices restored.'); return; }
      if (a === 'project') return open('project', b.dataset.work);
      open(a, b.dataset.app);
    });
    root.addEventListener('change', async e => {
      if (e.target.dataset.role === 'experience-picker') { const exp = S.experienceFor(e.target.value); if (exp) location.href = exp.href; }
      if (e.target.id === 'universal-skin-picker') { window.OSHAL_STYLE_SWITCHER.applySkin(e.target.value); render(); }
      if (e.target.dataset.shoppingItem) {
        const itemId = e.target.dataset.shoppingItem, item = data.shop.items.find(i => i.item_id === itemId);
        e.target.disabled = true;
        const r = await LIVE.packages.purchasing.remove(data.shop.list.list_id, itemId);
        if (r.ok) { notice(`Got it: ${item ? item.title : 'item'} removed from your list.`); await loadShopping(); render(); }
        else { e.target.checked = false; e.target.disabled = false; notice(`Could not update the list (HTTP ${r.status}).`); }
      }
    });
    root.addEventListener('submit', onSubmit);
  }
  async function onSubmit(e) {
    e.preventDefault();
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
    if (e.target.id === 'config-form') { saveConfig({ density: document.getElementById('density-choice').value, updates: document.getElementById('show-updates').checked, week: document.getElementById('show-week').checked }); window.OSHAL_STYLE_SWITCHER.applySkin(document.getElementById('skin-choice').value); close(); render(); notice('Display choices saved on this device. No permissions changed.'); }
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
