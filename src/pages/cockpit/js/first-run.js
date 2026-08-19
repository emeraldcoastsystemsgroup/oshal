/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Appliance finish: first-run model-state banner (C1/C2) + dismissible getting-started strip (C3). Self-contained, no rebuild — refresh-hot.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guest sessions get their own strip: the standard banners pushed "Create a bot / Connect accounts / Connect a model" — all guest-blocked writes that dead-end the public demo's first click. Guests now see explore-first copy with a sign-in pointer; detection via /api/auth/user, fail-open to the normal banners.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | De-brand (visible leak): reworded the "no model connected" banner + doc comment to drop the legacy stub-name wording (now just "placeholder text"). The stub-provider detection was left matching the legacy provider id until the noop rename landed.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | De-brand final pass: the stub-provider detection now matches 'noop' (NoopProvider reports 'noop' as of the provider rename); isFreeOrStub replaces the legacy-named flag. Functional fix, not cosmetic — the old pattern would no longer match the renamed provider id.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Model-state banners are now dismissible (session-scoped, so the reminder returns next visit) and the strip wraps on narrow viewports — without flex-wrap the fixed-width buttons squeezed the text into a tall sliver that filled a phone screen with no way to close it.
 */

/**
 * First-run appliance polish for the cockpit. Two pieces, both injected as a
 * single strip ABOVE the main cockpit body (a sibling of <main>, so it survives
 * the ribbon swapping #mainContent):
 *
 *   1. Model-state banner (C1/C2) — reads /api/providers/access and tells the
 *      user, in plain words, whether a real model is connected. The zero-keys
 *      default (placeholder / free shared model) is degraded on purpose; without this
 *      it reads as "broken". Healthy + a real provider → no banner (no noise).
 *   2. Getting-started strip (C3) — three obvious first actions, dismissible and
 *      remembered. Hidden once dismissed, or when a single app is focused.
 *
 * Everything is best-effort and guarded: any failure leaves the cockpit exactly
 * as it was.
 */

const GS_DISMISS_KEY = 'oshal-getting-started-dismissed';
// Session-scoped on purpose: the model-state reminder is useful, so it comes back next
// visit — but once closed it must stay closed for the rest of the session (mobile: it
// previously filled the screen with no dismiss at all).
const MODEL_DISMISS_KEY = 'oshal-model-banner-dismissed';
const FOCUSED_APP = /[?&]app=/.test(window.location.search);
const FULL_PROFILE = /[?&]profile=oshal-framework/.test(window.location.search);

/** Inject the scoped stylesheet once. */
function injectStyles() {
  if (document.getElementById('oshalFirstRunStyles')) return;
  // Bind to the cockpit's REAL theme variables (--accent-primary / --border-color /
  // --glass-bg / --text-primary / --text-muted) so the strip matches every theme,
  // light and dark. Fallbacks are neutral grays (not white-biased) so a missing var
  // never blows out a light theme. Warn stays amber (a status color, not brand).
  const css = `
    #oshalFirstRun { flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px; padding: 10px 16px 0; }
    #oshalFirstRun:empty { display: none; padding: 0; }
    .ofr-bar { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 10px;
      flex-wrap: wrap; font-size: 13px; line-height: 1.4; border: 1px solid var(--border-color, rgba(127,127,127,.25)); }
    .ofr-bar .ofr-grow { flex: 1; min-width: 0; }
    .ofr-bar strong { font-weight: 600; }
    .ofr-warn { background: rgba(240,170,40,.12); border-color: rgba(240,170,40,.5); }
    .ofr-info { background: var(--glass-bg, var(--bg-secondary, rgba(127,127,127,.08))); border-left: 3px solid var(--accent-primary, #5b4cdb); }
    .ofr-gs { display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
      background: var(--glass-bg, var(--bg-secondary, rgba(127,127,127,.08))); }
    .ofr-gs .ofr-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .ofr-btn { flex: 0 0 auto; cursor: pointer; border: 1px solid var(--accent-primary, #5b4cdb);
      background: var(--accent-primary, #5b4cdb); color: #fff; border-radius: 8px; padding: 6px 12px;
      font-size: 12px; font-weight: 600; text-decoration: none; white-space: nowrap; }
    .ofr-btn--ghost { background: transparent; color: var(--text-primary, inherit); border-color: var(--border-color, rgba(127,127,127,.35)); }
    .ofr-x { flex: 0 0 auto; cursor: pointer; background: transparent; border: none; color: var(--text-muted, inherit);
      opacity: .7; font-size: 16px; line-height: 1; padding: 4px; }
    .ofr-x:hover { opacity: 1; }
    @media (max-width: 640px) {
      #oshalFirstRun { padding: 8px 8px 0; }
      .ofr-bar { gap: 8px; padding: 8px 10px; }
      .ofr-bar .ofr-grow { flex-basis: 100%; }
    }
  `;
  const style = document.createElement('style');
  style.id = 'oshalFirstRunStyles';
  style.textContent = css;
  document.head.appendChild(style);
}

/** Resolve (and cache) the strip host, inserted just above <main class="cockpit-body">. */
function host() {
  let el = document.getElementById('oshalFirstRun');
  if (el) return el;
  const main = document.querySelector('main.cockpit-body');
  if (!main || !main.parentNode) return null;
  el = document.createElement('div');
  el.id = 'oshalFirstRun';
  main.parentNode.insertBefore(el, main);
  return el;
}

/**
 * Focus a ribbon tool in-cockpit by clicking its button, falling back to a
 * full-page navigation only if no matching button exists. The ribbon renders
 * each item as `<button class="ribbon-btn" data-view="<id>">` (RibbonNav), and
 * the tool id differs by profile (starter uses `tool-forge`; the framework
 * default uses `forge`), so we try a list of candidate ids in order.
 */
function openTool(candidateIds, fallbackUrl) {
  try {
    for (const id of candidateIds) {
      const node = document.querySelector(`.ribbon-btn[data-view="${id}"]`);
      if (node) { node.click(); return; }
    }
  } catch { /* fall through to navigation */ }
  window.location.href = fallbackUrl;
}

/**
 * Append a dismiss control to a model-state banner. Closing remembers for the
 * SESSION only (sessionStorage): the reminder stays valuable, so it returns on
 * the next visit, but never re-blocks the screen after the user closed it.
 */
function dismissible(bar) {
  const x = document.createElement('button');
  x.className = 'ofr-x';
  x.title = 'Dismiss';
  x.setAttribute('aria-label', 'Dismiss');
  x.innerHTML = '&times;';
  x.addEventListener('click', () => {
    try { sessionStorage.setItem(MODEL_DISMISS_KEY, '1'); } catch { /* no storage */ }
    bar.remove();
  });
  bar.appendChild(x);
  return bar;
}

/** Banner explaining the connected-model state (C1/C2). Returns an element or null. */
async function modelBanner() {
  try { if (sessionStorage.getItem(MODEL_DISMISS_KEY)) return null; } catch { /* no storage */ }
  let data;
  try {
    data = await (await fetch('/api/providers/access', { credentials: 'include' })).json();
  } catch { return null; }

  const providers = data.providers || [];
  const active = providers.find((p) => p.active);
  const free = data.freeModel || null;
  const isFreeOrStub = !!active && (
    /noop/i.test(`${active.id} ${active.label || ''}`) ||
    (free && active.id === free.provider)
  );

  const bar = document.createElement('div');
  bar.className = 'ofr-bar';

  if (!data.hasActive) {
    bar.classList.add('ofr-warn');
    bar.innerHTML = `
      <span class="ofr-grow"><strong>No AI model connected.</strong> Bots will reply with placeholder
        text until you connect one. It takes about a minute — no credit card needed.</span>
      <a class="ofr-btn" href="/welcome">Connect a model</a>`;
    return dismissible(bar);
  }
  if (isFreeOrStub) {
    bar.classList.add('ofr-info');
    bar.innerHTML = `
      <span class="ofr-grow">You're on the <strong>free shared model</strong>. Great for trying things
        out — connect your own free AI tokens for higher limits (a few clicks, still $0), or your own
        paid provider for full speed and private data.</span>
      <a class="ofr-btn" href="/free-models">Get free AI credits</a>
      <a class="ofr-btn ofr-btn--ghost" href="/welcome">Use my own model</a>`;
    return dismissible(bar);
  }
  return null; // real provider connected → stay quiet
}

/** Getting-started strip with three first actions (C3). Returns an element or null. */
function gettingStartedStrip() {
  if (FOCUSED_APP || FULL_PROFILE) return null; // only on the clean starter home
  try { if (localStorage.getItem(GS_DISMISS_KEY)) return null; } catch { /* no storage */ }

  const bar = document.createElement('div');
  bar.className = 'ofr-bar ofr-gs';
  bar.innerHTML = `
    <span class="ofr-grow"><strong>New here?</strong> Three ways to start:</span>
    <span class="ofr-actions">
      <button class="ofr-btn" data-act="forge">Create a bot</button>
      <button class="ofr-btn ofr-btn--ghost" data-act="connect">Connect accounts</button>
      <button class="ofr-btn ofr-btn--ghost" data-act="explore">Explore apps</button>
    </span>
    <button class="ofr-x" title="Dismiss" aria-label="Dismiss">&times;</button>`;

  bar.querySelector('[data-act="forge"]').addEventListener('click', () => openTool(['tool-forge', 'forge'], '/api/forge'));
  bar.querySelector('[data-act="connect"]').addEventListener('click', () => { window.location.href = '/utilities'; });
  bar.querySelector('[data-act="explore"]').addEventListener('click', () => openTool(['tool-explore-apps'], '/applications'));
  bar.querySelector('.ofr-x').addEventListener('click', () => {
    try { localStorage.setItem(GS_DISMISS_KEY, '1'); } catch { /* no storage */ }
    bar.remove();
  });
  return bar;
}

/** Guest strip: explore-first actions — the standard ones are guest-blocked writes. */
function guestStrip() {
  const bar = document.createElement('div');
  bar.className = 'ofr-bar ofr-gs';
  bar.innerHTML = `
    <span class="ofr-grow"><strong>You're exploring as a guest.</strong> Everything is read-only and
      nothing you do touches real accounts. Sign in with Google and your own workspace is created instantly.</span>
    <span class="ofr-actions">
      <button class="ofr-btn" data-act="explore">Explore apps</button>
      <a class="ofr-btn ofr-btn--ghost" href="/login">Sign in</a>
    </span>`;
  bar.querySelector('[data-act="explore"]').addEventListener('click', () => openTool(['tool-explore-apps'], '/applications'));
  return bar;
}

/** True when the session is an anonymous guest. Fail-open: errors mean "not a guest". */
async function isGuestSession() {
  try {
    const data = await (await fetch('/api/auth/user', { credentials: 'include' })).json();
    return data?.guestMode === true || data?.user?.is_guest === true;
  } catch { return false; }
}

async function init() {
  if (window.top !== window.self) return; // never inside an embedded surface
  const mount = host();
  if (!mount) return;
  injectStyles();

  if (await isGuestSession()) {
    mount.appendChild(guestStrip());
    return; // model/provider banners push guest-blocked writes — skip them
  }

  const model = await modelBanner();
  if (model) mount.appendChild(model);
  const gs = gettingStartedStrip();
  if (gs) mount.appendChild(gs);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
