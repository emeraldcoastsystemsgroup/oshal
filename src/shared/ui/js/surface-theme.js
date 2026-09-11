/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Canonical theme bootstrap for standalone surfaces. 28 of 37 surfaces hardcoded a dark palette and consumed ZERO framework tokens, so they only "worked" in dark by accident. Several DID read the saved theme and set data-theme — then overrode every token with hardcoded hex, so the attribute did nothing. Also adds LIVE switching, which no surface had: they read the theme once at load, so changing it in the cockpit left every open surface stale until reload.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | An EMBEDDED surface now wears what the surrounding cockpit wears. The cockpit applies a focused app's skin transiently on its own <html data-theme> (a per-app core theme, or an ADR-085 package-bundled skin injected as #app-package-theme-css) and never persists it — so every iframed surface kept rendering the operator's SAVED theme and an app's chrome and its content disagreed (a light studio skin around a dark studio). Same-origin parent only, observed live; a packaged skin's stylesheet is copied in and applied once it loads; any failure — cross-origin parent, no parent theme, stylesheet error — falls back to the saved theme exactly as before.
 */

/**
 * @description Apply the operator's chosen OSHAL theme to a standalone surface, and keep it live.
 *
 * Surfaces run in same-origin iframes, so they can read the cockpit's saved choice straight from
 * `localStorage` — an iframe does NOT inherit the parent's `data-theme`, which is why every surface
 * must set its own.
 *
 * Three things happen here:
 *  1. **At load** — apply the theme immediately (before paint, if this runs in <head>) so the
 *     surface never flashes the wrong palette.
 *  2. **On change** — the `storage` event fires in OTHER same-origin documents when the cockpit
 *     writes a new theme, so an open surface re-themes instantly. No reload, no postMessage bridge.
 *  3. **When embedded** — the surrounding cockpit's `<html data-theme>` wins over the saved theme,
 *     because the cockpit applies a focused app's skin THERE and only there (transiently, never
 *     saved). A per-app core theme is applied by id; an ADR-085 package-bundled skin is recognised
 *     by the cockpit's `#app-package-theme-css` link, copied into this document, and applied once
 *     its stylesheet has loaded so the surface never paints without tokens. The parent is observed
 *     live, so a skin applied after this frame loaded is still followed.
 *
 * Pair with `/shared/ui/css/surface-themes.css`, which carries the token sets. Theme files scope to
 * `[data-theme="<id>"]` with NO bare `:root` fallback, so an unset/unknown theme would leave the
 * surface with no tokens at all — hence the hard fallback to `midnight`.
 *
 * Usage (in <head>, before your own <style>):
 *   <link rel="stylesheet" href="/shared/ui/css/surface-themes.css" />
 *   <script src="/shared/ui/js/surface-theme.js"></script>
 */
(function () {
  var SUPPORTED = [
    'midnight', 'daylight', 'ocean', 'sakura', 'forest', 'gray',
    'black', 'light-blue', 'aurora', 'graphite', 'amber',
  ];
  var FALLBACK = 'midnight';
  /** The cockpit's element id for an injected package-bundled skin (theme-manager.js). */
  var PACKAGE_LINK_ID = 'app-package-theme-css';
  var SKIN_ID = /^[a-z0-9-]+$/i;

  /**
   * @description Resolve a candidate theme id to a supported one.
   * @param {string|null} id - Candidate.
   * @returns {string} A supported theme id.
   */
  function resolve(id) {
    return SUPPORTED.indexOf(id) !== -1 ? id : FALLBACK;
  }

  /**
   * @description Read the operator's saved cockpit theme. Never throws — a surface must render even
   * when storage is unavailable (private mode, blocked cookies, sandboxed frame).
   * @returns {string} The saved theme, or the fallback.
   */
  function saved() {
    try {
      return resolve(localStorage.getItem('cockpit-theme'));
    } catch (_) {
      return FALLBACK;
    }
  }

  /**
   * @description Apply a theme id to this document.
   * @param {string} id - Theme id.
   * @returns {void}
   */
  function apply(id) {
    document.documentElement.setAttribute('data-theme', resolve(id));
  }

  /**
   * @description The theme the surrounding cockpit is wearing, when this surface is embedded in a
   * same-origin parent that has one. A core id comes back alone; a package-bundled skin comes back
   * with the stylesheet the cockpit injected for it. Never throws — a cross-origin parent, a
   * sandboxed frame, or a parent with no theme all answer null, which means "use the saved theme".
   * @returns {{id: string, href: string|null}|null} The parent's theme, or null.
   */
  function parentTheme() {
    try {
      if (!window.parent || window.parent === window) return null;
      var doc = window.parent.document;
      var id = doc.documentElement.getAttribute('data-theme');
      if (!id || !SKIN_ID.test(id)) return null;
      if (SUPPORTED.indexOf(id) !== -1) return { id: id, href: null };
      var link = doc.getElementById(PACKAGE_LINK_ID);
      var href = link && link.getAttribute('href');
      return href ? { id: id, href: href } : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * @description Wear a package-bundled skin: copy the cockpit's stylesheet into this document and
   * apply the skin's id once it has loaded (a surface must never paint with no tokens at all). A
   * stylesheet that fails to load drops back to the saved theme.
   * @param {string} id - The skin id (validated).
   * @param {string} href - The stylesheet the cockpit injected for it.
   * @returns {void}
   */
  function applyPackaged(id, href) {
    var link = document.getElementById(PACKAGE_LINK_ID);
    if (link && link.getAttribute('href') === href) {
      document.documentElement.setAttribute('data-theme', id);
      return;
    }
    if (!link) {
      link = document.createElement('link');
      link.id = PACKAGE_LINK_ID;
      link.rel = 'stylesheet';
      (document.head || document.documentElement).appendChild(link);
    }
    link.addEventListener('load', function () { document.documentElement.setAttribute('data-theme', id); });
    link.addEventListener('error', function () { apply(saved()); });
    link.setAttribute('href', href);
  }

  /**
   * @description Apply whatever is authoritative right now: the embedding cockpit's theme when there
   * is one, else the operator's saved theme.
   * @returns {void}
   */
  function sync() {
    var parent = parentTheme();
    if (!parent) { apply(saved()); return; }
    if (parent.href) applyPackaged(parent.id, parent.href);
    else apply(parent.id);
  }

  sync();

  // Live-follow the cockpit. `storage` fires in every OTHER same-origin document when the value
  // changes — so switching theme in the cockpit re-themes every open surface immediately.
  window.addEventListener('storage', function (e) {
    if (e.key === 'cockpit-theme') sync();
  });

  // Some surfaces are opened standalone (not in the cockpit) and the operator may switch themes in
  // another tab; re-checking on focus covers the case where the storage event was missed.
  window.addEventListener('focus', function () {
    sync();
  });

  // Embedded: follow the cockpit's transient per-app skin as it is applied (it can land after this
  // frame has loaded) and as the operator moves between apps. Same-origin only; a cross-origin
  // parent throws here and is simply not observed.
  try {
    if (window.parent && window.parent !== window && typeof MutationObserver === 'function') {
      new MutationObserver(function () { sync(); })
        .observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
  } catch (_) {
    /* not same-origin — the saved theme stays authoritative */
  }
})();
