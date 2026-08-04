/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-044 Phase 1: PWA service worker — offline app shell + static-asset cache for the installable cockpit
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Stop painting a half-broken cockpit on an expired session: gated CSS/JS 302 to the OIDC IdP, and stale-while-revalidate served the cached shell while every non-precached asset died on that cross-origin redirect. Now fetch with redirect:'manual' so the logout 302 surfaces as an opaqueredirect (plus same-origin 401s), and on that signal the page restarts a clean login instead. Cache bumped to v2 to evict the masking v1 shell.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Mobile shell pass: single-pane layout (full-width main content, chat as a slide-up sheet, compact header, no status bar) in layout.css/chat.css. Cache bumped to v3 so the precached v2 layout.css is evicted and phones get the new responsive shell.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Mobile pass on the cockpit sub-views (ticket/calendar/dashboard/insights/workboard/settings/addressbook/operations/logs/advanced + shared components): added <=640px stacking rules. Cache bumped to v4 to evict cached view stylesheets so phones get them in one refresh.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Connector marketplace cockpit surface: cache bumped to v5 and connector CSS precached so authenticated live tests and users receive the new pinned item without stale service-worker assets.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Connector marketplace polish: cache bumped to v6 so featured connectors, logos, and glass card refinements are not masked by stale assets.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Connector marketplace glass alignment: cache bumped to v7 and shared glass CSS precached so connector surfaces inherit the common material/toggle system.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Shared design CSS now goes network-first and cache bumped to v8 so bad surface-glass rules cannot stay pinned behind the cockpit service worker.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v9 so the installed PWA evicts the stale (stale-while-revalidate) jarvis-orb.js and phones get the safe-area/dvh panel-fit fix in one reload instead of two.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v10 so the installed mobile PWA evicts its stale cockpit shell and picks up the new career-hunter "Mobile" swipe surface (ribbon tab + /api/career-hunter/mobile) in one reload instead of appearing unchanged.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v11 so installed PWAs evict the cached shell (index.html + app.js): the header Swarm Apps button is now super-admin-only, matching the /applications operator-console gating.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v12 to evict the precached ribbon.css: the pinned home/bottom trays are now tinted (--bg-tertiary) and the middle tray shows a thin scrollbar, so the scrollable region is visible; without the bump installed PWAs would keep the old flat rail.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v13 for ribbon.css again: collapsed-rail group headers shrink to thin dividers instead of holding invisible full-height text (the "random blank holes" between icons), growing back on hover-expand; mobile drawer now shows header text (no hover on touch).
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v14: five commits changed the cockpit shell since v13 (ADR-085 packaged skins, LM carve-out, RibbonNav app-navigate bridge) with no bump, so installed PWAs — phones especially — kept rendering the pre-carve-out shell from stale-while-revalidate cache ("it's just the website"). Evicts everything in one reload.
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v15: per-app connector allow-list honored in the shell (RibbonNav pin skip, ConnectorDiscoverView filter, view-controller pass-through) — evict so focused apps stop showing the full connector catalog on the first reload.
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v16: RibbonNav bridge maps class tiles' full-UUID lm-navigate onto the 8-char dynamic-button names and warns on missing targets — evict so installed PWAs pick up working class-card navigation in one reload.
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v18: ticket-view.css detail-pane scroll fix — the pinned header no longer eats the viewport; only .td-body scrolls (flex:1/min-height:0/overflow-y:auto) and the mobile header is compacted. Evict so phones stop rendering the stale ticket-view stylesheet from stale-while-revalidate cache and can actually scroll to the ticket text.
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v19: ADR-085 carve-parity ribbon restore (f656184e/c78a1549) — the 7 carved-app tiles (movies/spotify/rides/eats/shop/finance/lora) are back in the default framework profile. Evict so installed PWAs (phones) stop rendering the stale tile-less ribbon shell and pick up the restored toolbar in one reload.
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v20: Portrait Studio gets a default-ribbon tile (Create group) — the store-native app registered only a DYNAMIC tool tile, which the default profile's dynamicTools.allow (lm-class-* only) filters out, so it was reachable only via ?app=/store page ("I don't see it anywhere"). Same parity treatment as the carved apps; evict so phones pick it up.
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Bump the shell cache so immersive app assistant-visibility policy reaches installed cockpits immediately.
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v21: cockpit shell gains the surface-bridge relay (index.html + js/surface-bridge-relay.js, now precached) — one bump covering today's cockpit-JS additions (the connector lane's earlier change deferred its bump to this one). Evict so installed PWAs load the relay-bearing shell in one reload.
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v23: the header RAG icon now opens the new Settings → Knowledge (RAG) tab (app.js + SettingsView.js + new SettingsKnowledgeTab.js) instead of the flaky embedded-chat popup. Evict so installed PWAs pick up the repointed icon + new tab in one reload.
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Cache v24 also delivers immersive assistant suppression and prevents disabled chat frames from booting hidden tasks.
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v25: cockpit shell gains zen (full-window focus) mode (index.html buttons + layout.css rules + app.js wiring) and the login double-refresh fix (controllerchange reload now skipped on FIRST claim — a freshly-fetched page has nothing stale to reload for). Evict so installed PWAs pick both up in one (final) reload.
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v26: the index.html auth-lapse guard now carries ?returnTo=<current path+query> into /login so a session-expiry relogin returns to the same surface (?app= deep links included) instead of the bare cockpit. Evict so installed PWAs pick up the new shell.
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | Cache bumped to v27 for ribbon.css + app.js: the portrait-phone drawer kept the desktop's pinned home/bottom trays, so the pinned tray starved the scrollable app tray to about one visible row — the drawer is now one scrolling column; and tapping the already-active view now closes the drawer (setActive's no-op early return skipped switchView's close). Evict so phones stop rendering the stale drawer from stale-while-revalidate cache.
 */

/* global self, caches, fetch, Response */

// Bump CACHE_VERSION on any change to the precached shell list so old caches are evicted.
const CACHE_VERSION = 'oshal-cockpit-v29';
const STATIC_CACHE = `${CACHE_VERSION}-static`;

// The minimal app shell precached at install so the cockpit boots offline. Live data
// (everything under /api/) is intentionally NOT precached — it must hit the network.
const APP_SHELL = [
  '/cockpit/',
  '/cockpit/index.html',
  '/cockpit/manifest.webmanifest',
  '/cockpit/css/base.css',
  '/cockpit/css/layout.css',
  '/cockpit/css/ribbon.css',
  '/cockpit/css/connector-discover.css',
  '/shared/ui/css/surface-glass.css',
  '/cockpit/css/themes/midnight.css',
  '/cockpit/js/app.js',
  '/cockpit/js/surface-bridge-relay.js',
  '/cockpit/js/first-run.js',
  '/cockpit/icons/icon-192.png',
  '/cockpit/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // Precache the shell, then take over without waiting for old tabs to close.
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      // addAll is atomic — if one asset 404s the whole install fails, so cache
      // each entry independently and tolerate misses (e.g. theme renamed).
      .then((cache) => Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Evict caches from older versions, then claim open clients immediately.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * A network response that means "the session is gone": gated cockpit assets are served behind
 * OIDC, so a logged-out request 302s to the IdP (a cross-origin host). We fetch with
 * redirect:'manual' so that 302 surfaces as an `opaqueredirect` (status 0) instead of silently
 * chasing the IdP and returning HTML the browser then can't use as CSS/JS. A 401 is the same
 * signal for fetch-mode requests the auth layer answers directly.
 */
function isAuthLapse(response) {
  return !!response && (response.type === 'opaqueredirect' || response.status === 401);
}

/** Tell every open cockpit tab to restart a clean login (the client guard navigates to /login). */
async function notifyAuthRequired() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) { c.postMessage({ type: 'oshal-auth-required' }); }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GETs. Cross-origin (CDN scripts) and non-GET pass through
  // untouched so we never cache opaque/3rd-party or mutating requests.
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Live data is never served from cache — always go to the network.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Shared design CSS must be fresh. These files are theme/system contracts, not
  // bulky offline assets; serving a stale copy can corrupt every embedded
  // surface while the route itself looks healthy in a direct HTTP probe.
  if (url.pathname.startsWith('/shared/ui/css/')) {
    event.respondWith(
      fetch(request, { redirect: 'manual', cache: 'reload' })
        .then((response) => {
          if (isAuthLapse(response)) {
            notifyAuthRequired();
            return response;
          }
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Navigations: network-first so a logged-in user always gets fresh HTML. If the session lapsed,
  // send the tab through /login (which re-runs the OIDC dance) rather than falling back to a cached
  // shell that can't load its own assets. Offline (network throws) still falls back to the shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { redirect: 'manual' })
        .then((response) => {
          if (isAuthLapse(response)) {
            notifyAuthRequired();
            return Response.redirect(`${self.location.origin}/login`, 302);
          }
          return response;
        })
        .catch(() => caches.match('/cockpit/index.html').then((r) => r || caches.match('/cockpit/'))),
    );
    return;
  }

  // Static assets: stale-while-revalidate — serve cache instantly, refresh in the background. A
  // logged-out revalidation (opaqueredirect/401) signals the page to re-login instead of leaving
  // half the UI unstyled; we keep serving whatever we had cached for this request meanwhile.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request, { redirect: 'manual' })
        .then((response) => {
          if (isAuthLapse(response)) {
            notifyAuthRequired();
            return cached || response;
          }
          // Only cache a genuine same-origin 200 (type 'basic'); never an opaqueredirect.
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
