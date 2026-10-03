/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Experience portal: the chooser for the eight experiences, rendered over the signed-in swarm (installed applications by suite, the caller's recent work) instead of the design gallery's screenshots and catalog snapshot. Selecting an experience only navigates; nothing here changes a server setting.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The demo gallery's sections over the live swarm: the suite inventory under the introduction, the central assistant as a feature (a drawn core, not a screenshot, with the assistants online and the open work), the three homebases grouped as "One swarm. Three ways to belong." (each with a drawn preview in its palette and one real fact: its home applications, Little Monsters' availability to the caller, its office applications), and the four full-swarm layouts as numbered concept cards with drawn layout previews, tags and a live fact each. The eight experience cards stay the chooser; recent work and the searchable directory follow.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Operational chooser from installed authorized experience packages; preserve preview studies in docs/assets/experience-shells.
 */
(() => {
  'use strict';
  const S = window.OSHAL_SHELL, LIVE = window.OSHAL_LIVE;
  const { esc, link } = S;
  const root = document.getElementById('portal-root');
  const state = { query: '', suite: 'all', snapshot: null };
  function appCard(app) {
    const content = `<h3>${esc(app.name)}</h3><p>${esc(app.description || '')}</p><span class="small-label">${esc(app.suite || 'Applications')}${app.version ? ' · ' + esc(app.version) : ''}</span>`;
    const href = LIVE.localHref(app.href);
    return app.navigable && href ? `<a class="gallery-app-card" href="${esc(href)}">${content}</a>` : `<article class="gallery-app-card">${content}<p class="muted">Unavailable</p></article>`;
  }
  function updateDirectory() {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const q = state.query.toLowerCase().trim();
    const apps = snapshot.apps.filter(app => (state.suite === 'all' || app.suite === state.suite)
      && `${app.name} ${app.id} ${app.description || ''}`.toLowerCase().includes(q));
    const host = document.getElementById('gallery-apps-container');
    if (host) host.innerHTML = apps.map(appCard).join('') || '<p class="empty-note">No applications match.</p>';
    const counter = document.getElementById('gallery-catalog-counter');
    if (counter) counter.textContent = `${apps.length} applications`;
    document.querySelectorAll('[data-gallery-suite]').forEach(button => {
      const selected = button.dataset.gallerySuite === state.suite;
      button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
    });
  }
  function render(snapshot, experiences) {
    state.snapshot = snapshot;
    if (!snapshot.me.authenticated) {
      root.innerHTML = `<section class="gallery-intro"><div><h1>Sign in</h1>${link('Sign in', '/login', 'action primary')}</div></section>`; return;
    }
    if (!experiences) throw new Error('Experience discovery unavailable');
    const cards = experiences.map(e => `<a class="gallery-app-card experience-card" data-experience-package="${esc(e.id)}" href="${esc(e.href)}"><span class="eyebrow">EXPERIENCE</span><h2>${esc(e.label)}</h2><p>${esc(e.tagline || 'Your applications and work')}</p><span class="quiet-link">Open ↗</span></a>`).join('');
    const work = snapshot.work.slice(0, 6).map(item => {
      const href = LIVE.localHref(item.href);
      const content = `<span class="badge neutral">${esc(item.status.label)}</span><h3>${esc(item.title)}</h3><small>${esc(item.appName)} · ${esc(LIVE.relativeTime(item.at))}</small>`;
      return href ? `<a class="gallery-app-card" href="${esc(href)}">${content}</a>` : `<article class="gallery-app-card">${content}</article>`;
    }).join('');
    root.innerHTML = `<div class="gallery-intro"><div><div class="eyebrow">${esc(snapshot.me.name)}</div><h1>Experiences</h1></div><div class="gallery-note">${link('Cockpit', '/cockpit/', 'quiet-link')} · ${link('Assistant', '/nexus', 'quiet-link')} · ${link('Simple chat', '/simple', 'quiet-link')}</div></div>
<section class="showcase-section" id="experiences"><div class="gallery-apps-grid">${cards || '<p class="empty-note">No experiences are available to this account. An administrator can install an experience and assign its access roles.</p>'}</div></section>
<section class="showcase-section" id="recent-work"><div class="showcase-header"><h2>Recent Work</h2></div><div class="gallery-apps-grid">${work || '<p class="empty-note">No recent work.</p>'}</div></section>
<section class="showcase-section" id="catalog-directory"><div class="showcase-header"><h2>Applications</h2></div><div class="catalog-search-wrap"><label class="screenreader" for="gallery-app-search">Search applications</label><input type="search" id="gallery-app-search" placeholder="Search applications" autocomplete="off"></div><nav class="catalog-suites-tabs" aria-label="Application suites"><button type="button" class="catalog-suite-btn active" data-gallery-suite="all">All applications</button>${snapshot.suites.map(suite => `<button type="button" class="catalog-suite-btn" data-gallery-suite="${esc(suite.id)}">${esc(suite.name)}</button>`).join('')}</nav><span id="gallery-catalog-counter" role="status"></span><div id="gallery-apps-container" class="gallery-apps-grid"></div></section>`;
    updateDirectory();
  }
  root.addEventListener('input', event => { if (event.target.id === 'gallery-app-search') { state.query = event.target.value; updateDirectory(); } });
  root.addEventListener('click', event => { const button = event.target.closest('[data-gallery-suite]'); if (button) { state.suite = button.dataset.gallerySuite; updateDirectory(); } });
  Promise.all([LIVE.ready, S.readyExperiences]).then(([snapshot, experiences]) => render(snapshot, experiences))
    .catch(() => { root.innerHTML = '<section class="gallery-intro"><div><h1>Experiences unavailable</h1><p>Refresh to try again.</p></div></section>'; });
})();
