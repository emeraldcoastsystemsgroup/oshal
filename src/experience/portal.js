/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Experience portal: the chooser for the eight experiences, rendered over the signed-in swarm (installed applications by suite, the caller's recent work) instead of the design gallery's screenshots and catalog snapshot. Selecting an experience only navigates; nothing here changes a server setting.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The demo gallery's sections over the live swarm: the suite inventory under the introduction, the central assistant as a feature (a drawn core, not a screenshot, with the assistants online and the open work), the three homebases grouped as "One swarm. Three ways to belong." (each with a drawn preview in its palette and one real fact: its home applications, Little Monsters' availability to the caller, its office applications), and the four full-swarm layouts as numbered concept cards with drawn layout previews, tags and a live fact each. The eight experience cards stay the chooser; recent work and the searchable directory follow.
 */
(() => {
  'use strict';
  const S = window.OSHAL_SHELL, LIVE = window.OSHAL_LIVE;
  const { esc, link } = S;
  const root = document.getElementById('portal-root');
  const SWATCHES = {
    studio: ['#181b1b', '#202424', '#323b37', '#b9dfb2'], jarvis: ['#f8f5ee', '#fffdf8', '#e6dfd0', '#b94e2d'], orbit: ['#f1f5fb', '#ffffff', '#d9e2f2', '#3568d4'],
    commons: ['#f6f4f9', '#ffffff', '#e3dbea', '#725191'], family: ['#f6f5f0', '#fffefa', '#dce1d6', '#3e6854'], classroom: ['#f7f3fb', '#ffffff', '#e4d9ee', '#8952a5'],
    company: ['#f2f5f6', '#ffffff', '#d7dfe2', '#256c78'], nexus: ['#07131a', '#0f2029', '#1e3a46', '#9bdfd0']
  };
  const DESCRIPTIONS = {
    studio: 'A quiet workbench: suites and pinned apps beside one Jarvis conversation, with the selected application’s summary or its live surface alongside.',
    jarvis: 'One trusted assistant with your briefing from the real queue, your recent work, and your suites below.',
    orbit: 'Your suites as connected worlds around Jarvis; drill into a suite, follow an application, inspect its work and relationships.',
    commons: 'Suite rooms with the applications, assistants and work that belong together, each with its own Jarvis thread.',
    family: 'A shared home: calendar, shopping list and people, with personal finance and learning kept in their own space.',
    classroom: 'Teacher and learner views over real classes, assignments, rosters and the class calendar.',
    company: 'Projects, the team calendar, people and a restricted finance view for a working team.',
    nexus: 'Start with an intent. Watch the swarm assemble the answer, tools and handoffs around one conversation, with a speaking core.'
  };
  /** The four full-swarm layouts as the demo numbers them: what each puts first and what it is made of. */
  const CONCEPTS = {
    studio: { n: '01', first: 'CONVERSATION FIRST', line: 'A quiet place to think, build and review.', tags: 'Chat · suites · work' },
    jarvis: { n: '02', first: 'ASSISTANT FIRST', line: 'One trusted assistant, the whole picture.', tags: 'Brief · delegate · follow through' },
    orbit: { n: '03', first: 'CONNECTIONS FIRST', line: 'See the system. Follow the work.', tags: 'Swarm map · apps · relationships' },
    commons: { n: '04', first: 'PEOPLE FIRST', line: 'Your people and your assistants, in the same rooms.', tags: 'Rooms · people · shared work' }
  };
  const HOMES = {
    family: { eyebrow: 'HOMEBASE / FAMILY', title: 'A home for everyone in it.', line: 'Shared calendars and lists, with each person’s own world alongside.' },
    classroom: { eyebrow: 'LITTLE MONSTERS / CLASSROOM', title: 'Small steps. Big discoveries.', line: 'Teachers and learners share a class, not the same permissions or private records.' },
    company: { eyebrow: 'BUSINESS / COMPANY', title: 'A shared place to do good work.', line: 'Projects and people together. Private work and restricted apps stay scoped.' }
  };
  let state = { query: '', suite: 'all' };

  root.innerHTML = '<div class="gallery-intro"><div><div class="eyebrow">Connecting to your swarm</div><h1>Reading your applications…</h1></div></div>';
  LIVE.ready.then(render).catch(err => { root.innerHTML = `<div class="gallery-intro"><div><h1>The portal could not load.</h1><p>${esc(err && err.message ? err.message : String(err))}</p></div></div>`; });

  const exp = id => S.EXPERIENCES.find(e => e.id === id);
  const swatchStyle = id => { const c = SWATCHES[id] || SWATCHES.studio; return `--swatch-bg:${c[0]};--swatch-surface:${c[1]};--swatch-line:${c[2]};--swatch-accent:${c[3]}`; };
  /** A drawn, data-free preview of a layout's shape in its palette (the demo used screenshots of fixture data). */
  const PREVIEWS = {
    studio: '<i class="m-side"></i><i class="m-main"><b></b><b></b><b class="m-accent"></b></i><i class="m-aside"></i>',
    jarvis: '<i class="m-rail"></i><i class="m-main"><b class="m-orb"></b><b></b><b></b></i><i class="m-aside"></i>',
    orbit: '<i class="m-hub"></i><b class="m-node n1"></b><b class="m-node n2"></b><b class="m-node n3"></b><b class="m-node n4"></b><b class="m-node n5"></b><b class="m-node n6"></b>',
    commons: '<i class="m-top"></i><i class="m-rail"></i><i class="m-main"><b></b><b></b></i><i class="m-aside"></i>',
    home: '<i class="m-top"></i><i class="m-main"><b class="m-grid"></b><b></b></i><i class="m-aside"></i>'
  };
  const preview = (id, shape) => `<div class="live-mock mock-${shape}" style="${swatchStyle(id)}" aria-hidden="true">${PREVIEWS[shape]}</div>`;

  /** @description The central assistant as the gallery's feature: its promise, a drawn core, and how many assistants are online now. */
  function centralFeature(snapshot) {
    const e = exp('nexus'), open = snapshot.work.filter(w => w.status.open).length;
    return `<a class="experience-card central-feature live-central" href="${esc(e.href)}"><div class="central-copy"><span class="eyebrow">The central assistant</span><h2>A little ambition.<br>A whole swarm behind you.</h2><p>${esc(DESCRIPTIONS.nexus)}</p><span class="central-cta">Meet your swarm’s center ↗</span><small>${snapshot.botsOnline} of ${snapshot.bots.length} assistants online · ${open} open work item${open === 1 ? '' : 's'}</small></div><div class="central-stage" aria-hidden="true"><div class="central-orb"></div></div></a>`;
  }
  /** @description One real fact per homebase: what that home is made of on this swarm, for this caller. */
  function homeFact(id, snapshot) {
    const count = suite => (snapshot.suites.find(s => s.id === suite) || { count: 0 }).count;
    if (id === 'family') return `${count('ai-home')} Home & life application${count('ai-home') === 1 ? '' : 's'}`;
    if (id === 'company') return `${count('ai-productivity')} Productivity application${count('ai-productivity') === 1 ? '' : 's'}`;
    const lm = snapshot.apps.find(a => a.id === 'little-monsters');
    return !lm ? 'Little Monsters is not in your catalog' : lm.inPlan ? 'Little Monsters is available to you' : 'Little Monsters is listed, not admitted for you';
  }
  function homebaseSection(snapshot) {
    const cards = ['family', 'classroom', 'company'].map(id => {
      const e = exp(id), h = HOMES[id];
      return `<a class="experience-card homebase-card" href="${esc(e.href)}" style="${swatchStyle(id)}">${preview(id, 'home')}<div><span class="eyebrow">${esc(h.eyebrow)}</span><h3>${esc(h.title)} <span aria-hidden="true">↗</span></h3><p>${esc(h.line)}</p><div class="card-meta"><span>${esc(homeFact(id, snapshot))}</span><span>${esc(e.palette)}</span></div></div></a>`;
    }).join('');
    return `<section class="homebase-studies live-homebases"><div class="homebase-heading"><div><div class="eyebrow">Configured around your people</div><h2>One swarm. Three ways to belong.</h2><p>Family, classroom and company homes over the same applications. What each person sees follows their own access, never the home they open.</p></div></div><div class="homebase-grid">${cards}</div></section>`;
  }
  /** @description One live fact per full-swarm layout, from the same snapshot every layout reads. */
  function conceptFact(id, snapshot) {
    const open = snapshot.work.filter(w => w.status.open).length;
    const waiting = snapshot.work.filter(w => LIVE.STATUS_GROUPS.attention.includes(w.status.label)).length;
    if (id === 'studio') return `${open} open work item${open === 1 ? '' : 's'}`;
    if (id === 'jarvis') return `${waiting} item${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} you`;
    if (id === 'orbit') return `${snapshot.suites.length} suites · ${snapshot.apps.length} apps`;
    const rooms = snapshot.suites.length + (snapshot.apps.some(S.isGameApp) ? 1 : 0);
    return `${rooms} rooms`;
  }
  function conceptSection(snapshot) {
    const cards = ['studio', 'jarvis', 'orbit', 'commons'].map(id => {
      const e = exp(id), c = CONCEPTS[id];
      return `<a class="experience-card concept-card" href="${esc(e.href)}" style="${swatchStyle(id)}"><div class="concept-preview preview-${id}">${preview(id, id)}</div><div class="concept-info"><span class="concept-number">${c.n} / ${c.first}</span><h2>${esc(e.label)} <span aria-hidden="true">↗</span></h2><p>${esc(c.line)} ${esc(DESCRIPTIONS[id])}</p><div class="concept-tags"><span>${esc(e.palette)}</span><span>${esc(c.tags)}</span><span class="live-fact">${esc(conceptFact(id, snapshot))}</span></div></div></a>`;
    }).join('');
    return `<section class="showcase-section" id="experiences"><div class="showcase-header"><div class="eyebrow" style="color:var(--accent)">Four ways to see the whole swarm</div><h2>Conversation, assistant, connections or people first.</h2></div><div class="concept-grid experience-cards">${cards}</div></section>`;
  }
  function appCard(a, snapshot) {
    const suite = snapshot.suites.find(s => s.id === a.suite) || { name: 'Platform' };
    const inner = `<div class="row between"><span class="badge neutral" style="font-size:9px">${esc(suite.name)}</span><span class="small-label" style="font-size:10px">${a.version ? `v${esc(a.version)}` : ''}</span></div><h4>${esc(a.name)}</h4><small class="pkg-id">${esc(a.id)}</small><p>${esc(a.description)}</p><div class="gallery-app-card-foot"><span>${a.botCount} assistant${a.botCount === 1 ? '' : 's'}</span><span>${a.navigable ? 'Open ↗' : 'Not available here'}</span></div>`;
    return a.navigable ? `<a class="gallery-app-card" href="${esc(a.href)}">${inner}</a>` : `<article class="gallery-app-card">${inner}</article>`;
  }
  function filtered(snapshot) {
    const q = state.query.toLowerCase().trim();
    return snapshot.apps.filter(a => (state.suite === 'all' || a.suite === state.suite) && `${a.name} ${a.id} ${a.description}`.toLowerCase().includes(q));
  }
  function updateDirectory(snapshot) {
    const host = document.getElementById('gallery-apps-container'), counter = document.getElementById('gallery-catalog-counter');
    if (!host) return;
    const list = filtered(snapshot);
    host.innerHTML = list.map(a => appCard(a, snapshot)).join('') || '<p class="empty-note" style="grid-column:1/-1;padding:28px;text-align:center">No applications match. Try another word or reset the suite filter.</p>';
    if (counter) counter.textContent = `Showing ${list.length} of ${snapshot.apps.length} applications`;
    document.querySelectorAll('[data-gallery-suite]').forEach(b => b.classList.toggle('active', b.dataset.gallerySuite === state.suite));
  }
  function recentWork(snapshot) {
    return `<section class="showcase-section" id="recent-work"><div class="showcase-header"><div class="eyebrow" style="color:var(--accent)">Recent work</div><h2>${snapshot.work.length ? 'Where you left off.' : 'Nothing recorded yet.'}</h2><p>${snapshot.work.length ? 'Your newest tickets and assistant tasks. Each opens where the work lives.' : 'Tickets and assistant tasks appear here once you ask the swarm for something.'}</p></div><div class="gallery-apps-grid">${snapshot.work.slice(0, 6).map(w => `<a class="gallery-app-card" href="${esc(w.href)}"><div class="row between"><span class="badge neutral" style="font-size:9px">${esc(w.status.label)}</span><span class="small-label" style="font-size:10px">${esc(LIVE.relativeTime(w.at))}</span></div><h4>${esc(w.title)}</h4><small class="pkg-id">${esc(w.appName)} · ${esc(w.typeLabel)}</small><p>${esc(w.detail || '')}</p></a>`).join('')}</div></section>`;
  }
  function directorySection(snapshot) {
    return `<section class="showcase-section" id="catalog-directory"><div class="showcase-header"><div class="eyebrow" style="color:var(--accent)">Installed applications</div><h2>Search and open any application.</h2><p>Installed on this swarm and visible to you. Availability reflects your current authorization; nothing here installs or grants access.</p></div><div class="catalog-search-wrap"><label class="screenreader" for="gallery-app-search">Search applications</label><input type="search" id="gallery-app-search" placeholder="Search your ${snapshot.apps.length} applications…" autocomplete="off"></div><nav class="catalog-suites-tabs" aria-label="Filter applications by suite"><button type="button" class="catalog-suite-btn active" data-gallery-suite="all">All apps (${snapshot.apps.length})</button>${snapshot.suites.map(s => `<button type="button" class="catalog-suite-btn" data-gallery-suite="${s.id}">${esc(s.name)} (${s.count})</button>`).join('')}</nav><span id="gallery-catalog-counter" class="small-label" style="display:block;margin-bottom:14px;color:var(--muted)" role="status"></span><div id="gallery-apps-container" class="gallery-apps-grid"></div></section>`;
  }
  function intro(snapshot) {
    const open = snapshot.work.filter(w => w.status.open).length;
    return `<div class="gallery-intro"><div><div class="eyebrow">Your swarm. Eight ways to feel at home.</div><h1>${snapshot.apps.length} applications.<br><em>Choose how you want to work with them.</em></h1></div><div class="gallery-note"><p>Every experience below reads the same installed applications, your own tickets and tasks, and answers through your own Jarvis. Pick one; you can switch from any of them.</p><span class="muted">Skins, pins, focus and density are remembered on this device only and never change permissions.</span></div></div>
<div class="portal-status"><span>Signed in as <strong>${esc(snapshot.me.name)}</strong></span><span><strong>${snapshot.apps.length}</strong> installed applications</span><span><strong>${open}</strong> open work items</span><span><strong>${snapshot.botsOnline}/${snapshot.bots.length}</strong> assistants online</span><span>${link('Return to the cockpit', '/cockpit/', 'quiet-link')}</span></div>
<div class="gallery-inventory" aria-label="Your suites">${snapshot.suites.map(s => `<span><strong>${s.count}</strong> ${esc(s.name)}</span>`).join('')}</div>`;
  }
  function render(snapshot) {
    if (!snapshot.me.authenticated) { root.innerHTML = `<div class="gallery-intro"><div><h1>Sign in to choose an experience.</h1><p>${link('Sign in', '/login', 'action primary')}</p></div></div>`; return; }
    root.innerHTML = intro(snapshot) + centralFeature(snapshot) + homebaseSection(snapshot) + conceptSection(snapshot) + recentWork(snapshot) + directorySection(snapshot);
    updateDirectory(snapshot);
    root.addEventListener('input', e => { if (e.target.id === 'gallery-app-search') { state.query = e.target.value; updateDirectory(snapshot); } });
    root.addEventListener('click', e => { const b = e.target.closest('[data-gallery-suite]'); if (b) { state.suite = b.dataset.gallerySuite; updateDirectory(snapshot); } });
  }
})();
