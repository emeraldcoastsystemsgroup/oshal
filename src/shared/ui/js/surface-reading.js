/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Persist and apply the reader's chosen text size across every surface. Reported by a user who could not read an assistant answer: the product had no text-size control at all, so the only remedy was browser zoom — which does not work for the embedded assistant panel, because that panel is sized by the PARENT document and does not scale with the iframe's content. Built as a structural sibling of surface-theme.js so it inherits the same proven live-follow mechanism.
 */

/**
 * @description Apply the reader's chosen reading scale to a standalone surface, and keep it live.
 *
 * Surfaces run in same-origin iframes, so they read the saved choice straight from `localStorage` —
 * an iframe does NOT inherit the parent's `data-reading`, which is why every surface sets its own.
 *
 * Two things happen here, mirroring `surface-theme.js` exactly:
 *  1. **At load** — apply the saved level immediately (before paint, if this runs in <head>) so the
 *     surface never flashes at the wrong size and then reflows under the reader.
 *  2. **On change** — the `storage` event fires in OTHER same-origin documents, so stepping the size
 *     in the cockpit re-scales an open assistant panel instantly. No reload, no postMessage bridge.
 *
 * Pair with `/shared/ui/css/surface-reading.css`, which carries the tokens.
 *
 * CLIENT-ONLY, ALWAYS. This file is mounted before the OIDC middleware, so it must never fetch:
 * a request past auth would 302 to /login and the browser would reject the HTML as a script. The
 * preference is device-local by design — text size is a property of the screen you are reading on,
 * not of the account, so a reader who moves between a laptop and a wall-mounted display wants a
 * different answer on each.
 *
 * Usage (in <head>, immediately after surface-theme.js):
 *   <link rel="stylesheet" href="/shared/ui/css/surface-reading.css" />
 *   <script src="/shared/ui/js/surface-reading.js"></script>
 */
(function () {
  // Ordered smallest to largest: `step()` walks this array, so order is behaviour, not cosmetics.
  var LEVELS = ['cozy', 'comfortable', 'large', 'xlarge'];

  // The default is 'comfortable', NOT the historical 'cozy'. The report that prompted this rail was
  // "I get a response which is awesome, but I can't read the outcome — can you enlarge the print?"
  // Shipping a stepper that starts at the size being complained about answers nobody: the surface
  // looks byte-for-byte unchanged until the reader finds a control they have no reason to look for,
  // and the reader who could not read the answer is exactly the reader least likely to go hunting.
  // 'cozy' remains one step DOWN for anyone who wants the old density back, and a saved preference
  // always wins over this default.
  var FALLBACK = 'comfortable';
  var KEY = 'oshal-reading-scale';

  /**
   * @description Resolve a candidate level id to a supported one.
   * @param {string|null} id - Candidate, possibly absent or stale from an older build.
   * @returns {string} A supported level id.
   */
  function resolve(id) {
    return LEVELS.indexOf(id) !== -1 ? id : FALLBACK;
  }

  /**
   * @description Read the saved reading level. Never throws — a surface must render even when
   * storage is unavailable (private mode, blocked cookies, sandboxed frame).
   * @returns {string} The saved level, or the fallback.
   */
  function saved() {
    try {
      return resolve(localStorage.getItem(KEY));
    } catch (_) {
      return FALLBACK;
    }
  }

  /**
   * @description Apply a level to this document.
   * @param {string} id - Level id.
   * @returns {void}
   */
  function apply(id) {
    document.documentElement.setAttribute('data-reading', resolve(id));
  }

  /**
   * @description Persist a level and apply it here. Writing to storage is what notifies every OTHER
   * open same-origin surface, so this is the single write path.
   * @param {string} id - Level id.
   * @returns {string} The level actually applied, after resolution.
   */
  function set(id) {
    var next = resolve(id);
    try {
      localStorage.setItem(KEY, next);
    } catch (_) {
      // Storage unavailable — still apply for this document so the control responds to the click.
    }
    apply(next);
    return next;
  }

  /**
   * @description Step the reading level, wrapping at the top back to the smallest. A single
   * always-available button is easier to find than a settings screen for the reader who needs it.
   * @param {number} [delta] - Steps to move; defaults to one larger.
   * @returns {string} The level now applied.
   */
  function step(delta) {
    var move = typeof delta === 'number' ? delta : 1;
    var at = LEVELS.indexOf(saved());
    var next = (at + move) % LEVELS.length;
    while (next < 0) next += LEVELS.length;
    return set(LEVELS[next]);
  }

  apply(saved());

  // Live-follow every other surface. `storage` fires in every OTHER same-origin document when the
  // value changes — so stepping the size in the cockpit re-scales the open assistant immediately.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) apply(e.newValue);
  });

  // Some surfaces are opened standalone and the reader may change the size in another tab;
  // re-checking on focus covers the case where the storage event was missed.
  window.addEventListener('focus', function () {
    apply(saved());
  });

  // Exposed so a surface can render its own control without duplicating the level list or the
  // storage key — the guard asserts this is the only definition of either.
  window.OshalReading = {
    levels: LEVELS.slice(),
    get: saved,
    set: set,
    step: step,
  };
})();
