/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Canonical theme bootstrap for standalone surfaces. 28 of 37 surfaces hardcoded a dark palette and consumed ZERO framework tokens, so they only "worked" in dark by accident. Several DID read the saved theme and set data-theme — then overrode every token with hardcoded hex, so the attribute did nothing. Also adds LIVE switching, which no surface had: they read the theme once at load, so changing it in the cockpit left every open surface stale until reload.
 */

/**
 * @description Apply the operator's chosen OSHAL theme to a standalone surface, and keep it live.
 *
 * Surfaces run in same-origin iframes, so they can read the cockpit's saved choice straight from
 * `localStorage` — an iframe does NOT inherit the parent's `data-theme`, which is why every surface
 * must set its own.
 *
 * Two things happen here:
 *  1. **At load** — apply the saved theme immediately (before paint, if this runs in <head>) so the
 *     surface never flashes the wrong palette.
 *  2. **On change** — the `storage` event fires in OTHER same-origin documents when the cockpit
 *     writes a new theme, so an open surface re-themes instantly. No reload, no postMessage bridge.
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

  apply(saved());

  // Live-follow the cockpit. `storage` fires in every OTHER same-origin document when the value
  // changes — so switching theme in the cockpit re-themes every open surface immediately.
  window.addEventListener('storage', function (e) {
    if (e.key === 'cockpit-theme') apply(e.newValue);
  });

  // Some surfaces are opened standalone (not in the cockpit) and the operator may switch themes in
  // another tab; re-checking on focus covers the case where the storage event was missed.
  window.addEventListener('focus', function () {
    apply(saved());
  });
})();
