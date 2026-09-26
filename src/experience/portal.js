/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Experience portal: the chooser for the eight experiences, rendered over the signed-in swarm (installed applications by suite, the caller's recent work) instead of the design gallery's screenshots and catalog snapshot. Selecting an experience only navigates; nothing here changes a server setting.
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
  let state = { query: '', suite: 'all' };

  root.innerHTML = '<div class="gallery-intro"><div><div class="eyebrow">Connecting to your swarm</div><h1>Reading your applications…</h1></div></div>';
  LIVE.ready.then(render).catch(err => { root.innerHTML = `<div class="gallery-intro"><div><h1>The portal could not load.</h1><p>${esc(err && err.message ? err.message : String(err))}</p></div></div>`; });

  function card(exp, snapshot) {
    const c = SWATCHES[exp.id] || SWATCHES.studio;
    return `<a class="experience-card" href="${esc(exp.href)}" style="--swatch-bg:${c[0]};--swatch-surface:${c[1]};--swatch-line:${c[2]};--swatch-accent:${c[3]}"><div class="swatch" aria-hidden="true"><span></span><span></span><span></span></div><h3>${esc(exp.label)} <span aria-hidden="true">↗</span></h3><p>${esc(DESCRIPTIONS[exp.id] || '')}</p><div class="card-meta"><span>${esc(exp.tagline)}</span><span>${esc(exp.palette)}</span></div></a>`;
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
  function render(snapshot) {
    if (!snapshot.me.authenticated) { root.innerHTML = `<div class="gallery-intro"><div><h1>Sign in to choose an experience.</h1><p>${link('Sign in', '/login', 'action primary')}</p></div></div>`; return; }
    const open = snapshot.work.filter(w => w.status.open).length;
    root.innerHTML = `<div class="gallery-intro"><div><div class="eyebrow">Your swarm. Eight ways to feel at home.</div><h1>${snapshot.apps.length} applications.<br><em>Choose how you want to work with them.</em></h1></div><div class="gallery-note"><p>Every experience below reads the same installed applications, your own tickets and tasks, and answers through your own Jarvis. Pick one; you can switch from any of them.</p><span class="muted">Skins, pins and density are remembered on this device only and never change permissions.</span></div></div>
<div class="portal-status"><span>Signed in as <strong>${esc(snapshot.me.name)}</strong></span><span><strong>${snapshot.apps.length}</strong> installed applications</span><span><strong>${open}</strong> open work items</span><span><strong>${snapshot.botsOnline}/${snapshot.bots.length}</strong> assistants online</span><span>${link('Return to the cockpit', '/cockpit/', 'quiet-link')}</span></div>
<section class="showcase-section" id="experiences"><div class="showcase-header"><div class="eyebrow" style="color:var(--accent)">Experiences</div><h2>Business, home, classroom, and four ways to see the whole swarm.</h2></div><div class="experience-cards">${S.EXPERIENCES.map(e => card(e, snapshot)).join('')}</div></section>
<div class="gallery-inventory" aria-label="Your suites">${snapshot.suites.map(s => `<span><strong>${s.count}</strong> ${esc(s.name)}</span>`).join('')}</div>
<section class="showcase-section" id="recent-work"><div class="showcase-header"><div class="eyebrow" style="color:var(--accent)">Recent work</div><h2>${snapshot.work.length ? 'Where you left off.' : 'Nothing recorded yet.'}</h2><p>${snapshot.work.length ? 'Your newest tickets and assistant tasks. Each opens where the work lives.' : 'Tickets and assistant tasks appear here once you ask the swarm for something.'}</p></div><div class="gallery-apps-grid">${snapshot.work.slice(0, 6).map(w => `<a class="gallery-app-card" href="${esc(w.href)}"><div class="row between"><span class="badge neutral" style="font-size:9px">${esc(w.status.label)}</span><span class="small-label" style="font-size:10px">${esc(LIVE.relativeTime(w.at))}</span></div><h4>${esc(w.title)}</h4><small class="pkg-id">${esc(w.appName)} · ${esc(w.typeLabel)}</small><p>${esc(w.detail || '')}</p></a>`).join('')}</div></section>
<section class="showcase-section" id="catalog-directory"><div class="showcase-header"><div class="eyebrow" style="color:var(--accent)">Installed applications</div><h2>Search and open any application.</h2><p>Installed on this swarm and visible to you. Availability reflects your current authorization; nothing here installs or grants access.</p></div><div class="catalog-search-wrap"><label class="screenreader" for="gallery-app-search">Search applications</label><input type="search" id="gallery-app-search" placeholder="Search your ${snapshot.apps.length} applications…" autocomplete="off"></div><nav class="catalog-suites-tabs" aria-label="Filter applications by suite"><button type="button" class="catalog-suite-btn active" data-gallery-suite="all">All apps (${snapshot.apps.length})</button>${snapshot.suites.map(s => `<button type="button" class="catalog-suite-btn" data-gallery-suite="${s.id}">${esc(s.name)} (${s.count})</button>`).join('')}</nav><span id="gallery-catalog-counter" class="small-label" style="display:block;margin-bottom:14px;color:var(--muted)" role="status"></span><div id="gallery-apps-container" class="gallery-apps-grid"></div></section>`;
    updateDirectory(snapshot);
    root.addEventListener('input', e => { if (e.target.id === 'gallery-app-search') { state.query = e.target.value; updateDirectory(snapshot); } });
    root.addEventListener('click', e => { const b = e.target.closest('[data-gallery-suite]'); if (b) { state.suite = b.dataset.gallerySuite; updateDirectory(snapshot); } });
  }
})();
