/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-surface help affordance (BACKLOG "In-app help: per-surface affordances and first-run"). The guides existed and the ribbon carried a Help tile, but the reader still had to know to click it and then find their own screen in a list of twenty. This puts a "?" in the cockpit header that opens THIS screen's guide directly, on the sat-ops pattern. Coverage comes from GET /api/help/surfaces so the server's surface-to-guide map stays the single source of truth; on a surface no guide covers, the control says so and opens the index instead of pretending.
 */

/** The in-product guide hub (help-routes.ts). `?for=<surface>` redirects to that surface's guide. */
const HELP_ROOT = '/api/help';

/** Question-mark circle, drawn in the header's inline stroke-icon style. */
const HELP_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12" y2="17"/></svg>';

/**
 * @description Mount the per-surface help control in the cockpit header. It is a plain link, so it
 * keeps middle-click/open-in-new-tab behaviour and needs no popup permission; the shell tells it
 * which surface is active through setSurface().
 * @returns {{ setSurface: (viewId: string) => void, element: HTMLAnchorElement } | null} The
 * controller, or null when there is no header to mount into (an embedded surface, a test shell).
 */
export function mountSurfaceHelp() {
  const header = document.querySelector('.header-right');
  if (!header) return null;

  const link = document.getElementById('surfaceHelpBtn') || document.createElement('a');
  link.id = 'surfaceHelpBtn';
  link.className = 'header-btn';
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.innerHTML = HELP_ICON;
  if (!link.isConnected) header.insertBefore(link, document.getElementById('profileBtn'));

  let surface = '';
  /** @type {Set<string>|null} null until the coverage list answers — the server still decides. */
  let covered = null;

  /** Point the control at the active surface's guide, and say honestly which one it is. */
  const apply = () => {
    const known = Boolean(surface) && (covered === null || covered.has(surface));
    link.href = known ? `${HELP_ROOT}?for=${encodeURIComponent(surface)}` : HELP_ROOT;
    link.title = known ? 'Help for this screen' : 'User guides';
    link.setAttribute('aria-label', link.title);
    link.dataset.helpSurface = surface;
    link.dataset.helpCovered = String(known);
  };

  apply();

  // Best effort: a failed or absent coverage list leaves `covered` null, which keeps the ?for=
  // link — the route resolves it server-side and falls back to the index on its own.
  fetch(`${HELP_ROOT}/surfaces`, { credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (!data || !Array.isArray(data.surfaces)) return;
      covered = new Set(data.surfaces);
      apply();
    })
    .catch(() => { /* no coverage list: the ?for= link still resolves server-side */ });

  return {
    element: link,
    setSurface(viewId) {
      surface = typeof viewId === 'string' ? viewId.trim() : '';
      apply();
    },
  };
}
