/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Homebase shells (Home, Little Monsters classroom, Business) over live data: the signed-in person, Little Monsters identity/classes/assignments/roster/calendar, the Purchasing list, the Finance snapshot (a calm personal picture at home, a dense account table at work), Smart Home facts, open tickets as projects, application summaries as the noticeboard, and the real Jarvis thread. The role switcher, fixture people and sample records of the prototype are gone; teacher and learner views follow the caller's actual classroom role, and display choices are saved on this device only.
 */
(() => {
  'use strict';
  const S = window.OSHAL_SHELL, LIVE = window.OSHAL_LIVE, esc = S.esc;
  const presets = window.HOMEBASE_PRESETS;
  const requested = new URLSearchParams(location.search).get('preset');
  const key = Object.prototype.hasOwnProperty.call(presets, requested) ? requested : 'family';
  const preset = presets[key], root = document.getElementById('homebase-root');
  document.body.dataset.defaultSkin = preset.skin;
  const btn = (text, action, cls = 'button', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${text}</button>`;
  const link = (text, href, cls = 'button', attrs = '') => `<a class="${cls}" href="${esc(href)}" ${attrs}>${text}</a>`;
  const pill = s => `<span class="pill">${esc(s)}</span>`;
  const head = (title, action = '') => `<div class="panel-head"><h2>${title}</h2>${action}</div>`;
  const COLORS = ['green', 'rose', 'gold', 'blue'];
  const avatar = (text, i = 0) => `<span class="avatar ${COLORS[i % COLORS.length]}" aria-hidden="true">${esc(text)}</span>`;
  const money = n => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
  const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  let snapshot, shell, data = {}, thread, dialogKind = null, opener = null, timer, config;
  const state = { page: 'home' };
  const defaultConfig = () => ({ density: 'comfortable', updates: true, week: true, revision: 1, previous: null });
  const me = () => snapshot.me;
  const app = id => shell.byId(id);
  const has = id => Boolean(app(id));
  const isTeacher = () => Boolean(data.edu && data.edu.me && ['teacher', 'admin'].includes(data.edu.me.role));
  const isLearner = () => Boolean(data.edu && data.edu.me && data.edu.me.role === 'student');
  const displayName = () => (data.edu && data.edu.me && data.edu.me.name) || me().name;
  const notice = s => { clearTimeout(timer); const t = document.getElementById('toast'); if (t) { t.textContent = s; timer = setTimeout(() => { t.textContent = ''; }, 4000); } };

  root.innerHTML = '<div class="experience"><div class="home-shell"><main class="home-main"><section class="hero"><div><div class="eyebrow">CONNECTING</div><h1>Reading your home…</h1></div></section></main></div></div>';
  LIVE.ready.then(boot).catch(err => { root.innerHTML = `<div class="experience"><main class="home-main"><section class="hero"><div><h1>This home could not load.</h1><p>${esc(err && err.message ? err.message : String(err))}</p></div></section></main></div>`; });

  async function boot(loaded) {
    snapshot = loaded;
    if (!snapshot.me.authenticated) { root.innerHTML = `<div class="experience"><main class="home-main"><section class="hero"><div><h1>Sign in to open your home.</h1><p>${link('Sign in', '/login', 'button primary')}</p></div></section></main></div>`; return; }
    shell = S.createShell({ snapshot, layoutId: key, hooks: {} });
    config = { ...defaultConfig(), ...(LIVE.prefs.get(`homebase:${key}`, {}) || {}) };
    thread = shell.createThread(LIVE.sessionId(), preset.assistantLabel);
    bind();
    render();
    await Promise.all([loadEducation(), loadShopping(), loadFinance(), loadHome(), loadDirectory(), loadUpdates()]);
    render();
  }

  /* ── live sources ────────────────────────────────────────────── */
  async function loadEducation() {
    if (!has('little-monsters')) { data.edu = { installed: false }; return; }
    const E = LIVE.packages.education, now = new Date(), next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const [meRes, classes, assignments, cal1, cal2] = await Promise.all([E.me(), E.classes(), E.assignments(), E.calendar(isoDay(now).slice(0, 7)), E.calendar(isoDay(next).slice(0, 7))]);
    const edu = { installed: true, ok: meRes.ok, status: meRes.status, me: meRes.ok ? meRes.body : null, classes: classes.ok && classes.body ? classes.body.classes || [] : [], assignments: assignments.ok && assignments.body ? assignments.body.assignments || [] : [], events: [], rosters: new Map() };
    const events = [].concat(cal1.ok && cal1.body ? cal1.body.events || [] : [], cal2.ok && cal2.body ? cal2.body.events || [] : []);
    const seen = new Set();
    edu.events = events.filter(e => e && e.event_id && !seen.has(e.event_id) && seen.add(e.event_id)).map(e => ({ ...e, when: new Date(`${String(e.event_date).slice(0, 10)}T${e.event_time || '00:00:00'}`) })).filter(e => !isNaN(e.when.getTime())).sort((a, b) => a.when - b.when);
    if (edu.me && ['teacher', 'admin'].includes(edu.me.role)) {
      const mine = edu.classes.filter(c => edu.me.role === 'admin' || c.teacher_student_id === edu.me.studentId);
      edu.classes.forEach(c => { if (!mine.includes(c)) edu.rosters.set(c.class_id, { status: 403, students: null }); });
      await Promise.all(mine.map(async c => { const r = await E.students(c.class_id); edu.rosters.set(c.class_id, { status: r.status, students: r.ok && r.body ? r.body.students || [] : null }); }));
    }
    data.edu = edu;
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
    return `<section class="panel ${state.page === 'home' ? 'quest-card' : ''}" data-module="requirements"><div class="panel-kicker">CLASSWORK / ${open.length} OPEN</div><h2>${next ? esc(next.title) : 'No open classwork.'}</h2><p style="margin:12px 0 16px">${next ? esc(next.description || `${next.class_name || 'Class'}${next.assignment_type ? ` · ${next.assignment_type}` : ''}`) : 'When a teacher publishes an assignment it appears here with its due date.'}</p>${open.length ? `<ol class="requirement-list">${open.slice(0, 4).map((a, i) => `<li><span class="step-num">${i + 1}</span><span>${esc(a.title)}${a.class_name ? ` <small class="subtle">· ${esc(a.class_name)}</small>` : ''}${a.due_date ? ` <small class="subtle">· due ${esc(new Date(a.due_date).toLocaleDateString())}</small>` : ''}</span></li>`).join('')}</ol>` : ''}<div class="quest-footer">${isTeacher() ? (lm ? link('Manage classwork in Little Monsters ↗', lm.href, 'button primary') : '') : btn('Open my checklist', 'learning', 'button primary')}${pill(`${edu.classes.length} class${edu.classes.length === 1 ? '' : 'es'} · shared with your class`)}</div></section>`;
  }
  function roster() {
    const edu = data.edu; if (!edu || !edu.ok || !isTeacher()) return '';
    return `<section class="panel" data-module="teacher-roster">${head('A moment for each learner.', pill('Teacher view'))}${edu.classes.map(c => { const r = edu.rosters.get(c.class_id); return `<div class="student-progress"><div class="member-line">${avatar(LIVE.initials(c.name), 3)}<span>${esc(c.name)}<small>${esc(c.subject || '')}${c.grade_level ? ` · ${esc(c.grade_level)}` : ''} · ${esc(c.teacher_name || '')}</small></span></div>${pill(`${c.student_count} student${Number(c.student_count) === 1 ? '' : 's'}`)}</div>${r && r.students ? `<div class="list-items" style="margin:0 0 12px 46px">${r.students.map(s => `<div class="member-line">${avatar(LIVE.initials(s.name), 0)}<span>${esc(s.name)}<small>enrolled ${esc(LIVE.relativeTime(LIVE.parseDate(s.enrolled_at)))}</small></span></div>`).join('') || '<p class="subtle">No students enrolled yet.</p>'}</div>` : `<p class="subtle" style="margin:0 0 12px 46px">${r && r.status === 403 ? 'Only this class’s teacher sees its roster.' : 'Roster unavailable.'}</p>`}`; }).join('') || '<p class="subtle">You are not attached to a class yet.</p>'}<p class="subtle" style="margin-top:16px">Rosters come from Little Monsters and are visible only to each class’s teacher. Students never see this panel.</p></section>`;
  }
  function projects() {
    const open = shell.openWork(), apps = new Set(open.map(w => w.appName));
    return `<section class="panel" data-module="projects">${head('The work we share.', pill(`${open.length} open`))}${open.slice(0, 6).map((w, i) => `<div class="project-row">${avatar(LIVE.initials(w.appName), i)}<div><strong>${esc(w.title)}</strong><small>${esc(w.appName)} · ${esc(w.typeLabel)} · ${esc(LIVE.relativeTime(w.at))}</small></div>${btn(`${esc(w.status.label)} ↗`, 'project', 'button', `data-work="${esc(w.id)}"`)}</div>`).join('') || '<p class="subtle">No open tickets or tasks. Ask the assistant for something and it lands here.</p>'}<div class="summary-line"><div><strong>${open.length}</strong><small>Open items</small></div><div><strong>${apps.size}</strong><small>Applications involved</small></div><div><strong>${snapshot.botsOnline}</strong><small>Assistants online</small></div></div></section>`;
  }
  function personal() {
    if (key === 'classroom') return learning();
    if (key === 'family') return isLearner() ? learning() : (data.fin && data.fin.installed ? finance() : learning());
    return data.fin && data.fin.installed ? finance() : `<section class="panel feature-card" data-module="personal"><div class="panel-kicker">${esc(displayName().toUpperCase())} / PERSONAL WORKSPACE</div><h2>Room for your best work.</h2><p>Your drafts and assistant conversations stay personal until you share them with the team.</p>${link('Open Jarvis ↗', '/api/jarvis/', 'button')}</section>`;
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
    const list = featuredApps().slice(0, 4);
    return `<section><div class="section-heading"><h2>${esc(preset.appsHeading)}</h2>${btn('About access', 'policy', 'text-button')}</div><div class="apps-row">${list.map(a => btn(`<span class="app-icon" aria-hidden="true">${esc(LIVE.initials(a.name))}</span><strong>${esc(a.name)}</strong><small>${esc(shell.suiteOf(a.suite).name)}${a.version ? ` · v${esc(a.version)}` : ''}</small>`, 'app', 'app-tile', `data-app="${esc(a.id)}"`)).join('') || '<p class="subtle">No applications from these suites are available in your workspace.</p>'}</div></section>`;
  }

  /* ── page composition ────────────────────────────────────────── */
  function sidebar() {
    const lm = key === 'classroom' && data.edu && data.edu.installed;
    const people = peopleList().slice(0, 6);
    return `<aside class="home-sidebar"><div><div class="wordmark ${key === 'classroom' ? 'class-brand' : ''}">${lm ? '<img class="monster-logo" src="/api/education/logo-96.png" alt="">' : `<span class="brand-glyph">${preset.mark}</span>`}${preset.short}</div><p class="workspace-label">${esc(displayName())}’s ${key === 'family' ? 'home' : key === 'classroom' ? 'classroom' : 'company swarm'} · ${snapshot.apps.length} apps</p></div><nav class="side-nav" aria-label="Homebase navigation">${preset.nav.map(([id, label], i) => btn(`<span class="nav-symbol" aria-hidden="true">${['⌂', '▦', '☷', '◎', '◇'][i]}</span>${esc(label)}`, 'page', 'nav-link', `data-page="${id}" ${id === state.page ? 'aria-current="page"' : ''}`)).join('')}</nav><div class="side-section"><div class="side-kicker">${preset.peopleKicker}</div>${people.map(memberLine).join('')}</div><div class="side-section"><div class="side-kicker">YOUR APPLICATIONS</div>${featuredApps().slice(0, 5).map(a => btn(`<span class="nav-symbol" aria-hidden="true">${esc(a.name.slice(0, 1))}</span>${esc(a.name)}`, 'app', 'nav-link', `data-app="${esc(a.id)}"`)).join('')}${btn('<span class="nav-symbol" aria-hidden="true">…</span>All applications', 'all-apps', 'nav-link')}</div><div class="sidebar-note"><strong>${esc(preset.sidebarNote[0])}</strong>${esc(preset.sidebarNote[1])}${btn('Configure this home', 'configure', 'button sidebar-config')}</div></aside>`;
  }
  function hero() {
    const learner = isLearner();
    const heading = learner ? `Ready to explore, ${displayName().split(' ')[0]}?` : preset.title;
    const badgeText = key === 'family' ? `${snapshot.apps.length} apps · ${shell.openWork().length} open items` : key === 'classroom' ? (data.edu && data.edu.ok ? `${isTeacher() ? 'Teacher' : 'Student'} · ${data.edu.classes.length} class${data.edu.classes.length === 1 ? '' : 'es'}` : 'Classroom') : `${shell.openWork().length} open items · ${snapshot.botsOnline} assistants online`;
    const art = key === 'family' ? '<div class="family-scene" role="img" aria-label="A little house among green trees"><span class="plant"></span><span class="little-house"></span><span class="plant"></span></div>' : key === 'classroom' ? (data.edu && data.edu.installed ? '<img class="hero-monster" src="/api/education/logo-256.png" alt="Little Monsters study companion">' : '') : '<div class="company-emblem" aria-hidden="true"><span></span><span></span><span></span></div>';
    return `<section class="hero ${key === 'company' ? 'professional-hero' : ''}"><div><div class="eyebrow">${esc(preset.eyebrow)}</div><h1>${esc(heading)}</h1><p>${learner ? 'Your own learning space, with the shared moments close by.' : esc(preset.subtitle)}</p><div class="hero-cta">${pill(badgeText)}</div></div>${art}</section>`;
  }
  function content() {
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
    root.innerHTML = `<div class="experience" data-skin="${esc(document.body.dataset.skin || preset.skin)}" data-density="${esc(config.density)}"><div class="preview-bar"><a href="/cockpit/">← Cockpit</a><span class="demo-tag">LIVE · ${esc(displayName().toUpperCase())}</span><div class="preview-selects"><label>Experience ${S.pickerMarkup(key)}</label><label>Style ${S.skinPicker()}</label></div></div><div class="home-shell">${sidebar()}<main class="home-main"><header class="main-top"><div class="breadcrumb">${esc(preset.name)} / ${esc((preset.nav.find(n => n[0] === state.page) || [])[1] || 'Home')}</div><div class="top-controls"><span class="date-chip">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>${btn('Configure home', 'configure')}${btn('My access', 'policy')}${avatar(me().initials, 0)}</div></header>${hero()}${content()}<footer class="page-footer"><span>One platform · ${key} preset · ${esc(document.body.dataset.skin || preset.skin)} skin · display choices saved on this device (v${config.revision})<br>Access follows this swarm’s authorization; appearance never changes it.</span>${btn('About this data', 'about', 'text-button')}</footer></main></div><div id="dialog-host"></div><div class="toast" id="toast" role="status" aria-live="polite"></div></div>`;
    if (window.OSHAL_STYLE_SWITCHER) { const exp = root.querySelector('.experience'); const def = window.OSHAL_STYLE_SWITCHER.FLAT_SKINS.find(s => s.id === (document.body.dataset.skin || preset.skin)); if (exp && def) exp.dataset.skin = def.alias || def.id; }
    if (dialogKind) openDialog(dialogKind);
  }

  /* ── dialogs ─────────────────────────────────────────────────── */
  function close() { const d = document.getElementById('homebase-dialog'); if (d) d.close(); document.getElementById('dialog-host').replaceChildren(); dialogKind = null; if (opener && opener.isConnected) opener.focus(); }
  function dialogBody(kind, id) {
    const lm = app('little-monsters');
    if (kind === 'configure') return ['Make this home your own', `<p>A preset supplies the starting point; a skin supplies the look. What you may see is decided by this swarm’s authorization, independently.</p><div class="config-flow"><span>${key} preset</span> → <span>your authorized modules</span> → <span>chosen skin</span></div><form id="config-form"><label class="field">Visual skin<select id="skin-choice">${window.OSHAL_STYLE_SWITCHER.FLAT_SKINS.map(s => `<option value="${s.id}" ${(document.body.dataset.skin || preset.skin) === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label><label class="field">Density<select id="density-choice"><option value="comfortable" ${config.density === 'comfortable' ? 'selected' : ''}>Comfortable</option><option value="compact" ${config.density === 'compact' ? 'selected' : ''}>Compact</option></select></label><label class="config-check"><input id="show-updates" type="checkbox" ${config.updates ? 'checked' : ''}>Show the activity panel</label><label class="config-check"><input id="show-week" type="checkbox" ${config.week ? 'checked' : ''}>Show the calendar week strip</label><p>Changing a skin never grants Finance, reveals student records, installs an app or enrolls anyone in anything.</p><div class="dialog-actions"><button type="submit" class="button primary">Save on this device</button>${config.previous ? btn('Restore previous', 'restore') : ''}</div></form><p>Version ${config.revision} · saved in this browser only. No server setting changes.</p>`];
    if (kind === 'event') return ['Add a shared moment', data.edu && data.edu.ok ? `<p>This adds a personal event to your Little Monsters calendar${isTeacher() ? '; class-wide events are published from a class in Little Monsters' : ''}. No invitation is sent.</p><form id="event-form"><label class="field">Event title<input id="event-title" maxlength="200" required placeholder="A moment to make time for"></label><label class="field">Date<input id="event-date" type="date" value="${isoDay(new Date())}" required></label><label class="field">Time (optional)<input id="event-time" type="time"></label><div class="dialog-actions"><button class="button primary" type="submit">Add event</button></div></form>` : '<p>No calendar source accepts events here yet.</p>'];
    if (kind === 'learning') return [`${displayName()}’s learning space`, data.edu && data.edu.ok ? `<p>Your open classwork from Little Monsters. Submitting work happens in the application itself.</p><div class="list-items">${assignmentsOpen().map(a => `<div class="list-item"><span><span class="item-title">${esc(a.title)}</span><small>${esc(a.class_name || '')}${a.due_date ? ` · due ${esc(new Date(a.due_date).toLocaleDateString())}` : ''}${a.assignment_type ? ` · ${esc(a.assignment_type)}` : ''}</small></span></div>`).join('') || '<p class="subtle">Nothing open right now.</p>'}</div><div class="dialog-actions">${lm ? link('Open Little Monsters ↗', lm.href, 'button primary') : ''}</div>` : '<p>Open Little Monsters once to create your learner profile.</p>'];
    if (kind === 'app') { const a = app(id); if (!a) return ['', '']; const sm = shell.state.summaries.get(a.id); return [a.name, `<p>${esc(a.description)}</p><p class="pill">${esc(shell.suiteOf(a.suite).name)}${a.version ? ` · v${esc(a.version)}` : ''} · ${a.navigable ? 'available to you' : 'not available in your workspace'}</p><div id="app-summary-slot">${shell.summaryMarkup(a, sm || null)}</div><div class="dialog-actions">${a.navigable ? link(`Open ${esc(a.name)} ↗`, a.href, 'button primary') : ''}${btn('Review access', 'policy', 'button')}</div>`]; }
    if (kind === 'project') { const w = snapshot.work.find(x => x.id === id); if (!w) return ['', '']; return [w.title, `<p class="pill">${esc(w.status.label)} · ${esc(w.appName)} · ${esc(w.typeLabel)}</p>${w.kind === 'task' ? S.answerHtml(w.result || w.error || '') : `<p>${esc(w.detail || 'No description recorded.')}</p>`}<div class="dialog-actions">${link('Open ↗', w.href, 'button primary')}</div>`]; }
    if (kind === 'policy') return ['The same home, different access', `<p>Signed in as ${esc(displayName())}${data.edu && data.edu.me ? ` · ${esc(data.edu.me.role)} in Little Monsters` : ''}.</p><ul class="policy-list"><li>Applications appear only when this swarm’s authorization admits you to them.</li><li>Personal records require explicit, server-enforced access; a parent, teacher or admin label alone grants nothing.</li><li>Only a swarm administrator installs applications.</li><li>Class rosters are visible to each class’s teacher; students never see them.</li><li>Skins, density and pins are saved on this device and never change permissions.</li></ul>`];
    if (kind === 'ask') return [key === 'classroom' ? 'Ask your study companion' : 'Ask your assistant', `<p>Answered by your own Jarvis, in the same thread the cockpit uses.</p><form id="ask-form"><label class="field">Your question<input id="ask-input" maxlength="600" required placeholder="What should I focus on today?"${thread.busy ? ' disabled' : ''}></label><button class="button primary" type="submit"${thread.busy ? ' disabled' : ''}>Ask</button></form><div id="ask-answer" role="status">${thread.turns.slice(-4).map(t => t.role === 'user' ? `<p><strong>${esc(t.text)}</strong></p>` : t.pending ? `<p class="subtle">${esc(t.text)}</p>` : S.answerHtml(t.text)).join('')}</div>`];
    if (kind === 'about') { const e = data.edu || {}, s = data.shop || {}, f = data.fin || {}; return ['What this home reads', `<ul class="policy-list"><li>Applications, suites and availability: your authorized home plan and installed listing (HTTP ${snapshot.sources.plan}/${snapshot.sources.apps}).</li><li>Work items: your tickets (HTTP ${snapshot.sources.tickets}) and Jarvis tasks (HTTP ${snapshot.sources.tasks}).</li><li>Calendar, classes, classwork and rosters: Little Monsters ${e.installed ? `(HTTP ${e.status})` : '(not installed)'}.</li><li>Shopping list: Purchasing ${s.installed ? `(HTTP ${s.status})` : '(not installed)'}.</li><li>Money: Finance ${f.installed ? (f.available ? `(HTTP ${f.status})` : '(not available to you)') : '(not installed)'}.</li><li>Assistant: your Jarvis thread <code>${esc(thread.sessionId.slice(0, 18))}…</code>.</li></ul><p>No check-in, location or presence source exists on this swarm, so no such module is shown.</p>`]; }
    return ['', ''];
  }
  function openDialog(kind, id) {
    const [title, body] = dialogBody(kind, id); if (!title) return;
    dialogKind = kind;
    document.getElementById('dialog-host').innerHTML = `<dialog id="homebase-dialog" class="config-dialog" aria-labelledby="dialog-title"><div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2>${btn('×', 'close', 'close', 'aria-label="Close panel"')}</div><div class="dialog-body">${body}</div></dialog>`;
    const d = document.getElementById('homebase-dialog'); d.showModal(); d.addEventListener('cancel', e => { e.preventDefault(); close(); }); d.addEventListener('click', e => { if (e.target === d) close(); });
    if (kind === 'app' && app(id)) shell.summaryFor(app(id)).then(sm => { shell.state.summaries.set(id, sm); const slot = document.getElementById('app-summary-slot'); if (slot) slot.innerHTML = shell.summaryMarkup(app(id), sm); });
  }
  function open(kind, id) { opener = document.activeElement; openDialog(kind, id); }

  /* ── events ──────────────────────────────────────────────────── */
  function saveConfig(next) { config = { ...next, revision: config.revision + 1, previous: { ...config, previous: null } }; LIVE.prefs.set(`homebase:${key}`, config); }
  function bind() {
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-action]'); if (!b) return; const a = b.dataset.action;
      if (a === 'close') return close();
      if (a === 'page') { state.page = b.dataset.page; render(); return; }
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
    root.addEventListener('submit', async e => {
      e.preventDefault();
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
    });
  }
})();
