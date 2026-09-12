/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Dismiss relocated secondary controls without replacing their existing application handlers.
 */

const initialized = new WeakSet();

/** @description Close the action's current disclosure while retaining keyboard focus when requested. */
function closeDisclosure(details, restoreFocus = false) {
  if (!details?.open) return;
  details.open = false;
  if (restoreFocus) details.querySelector(':scope > summary')?.focus();
}

/**
 * @description Bind once to the original utilities node, which moves between More and the sidebar fallback.
 * @returns {void} Existing button IDs and handlers continue to own application actions.
 */
export function initHeaderOptions() {
  const fallback = document.getElementById('cockpitHeaderOptions');
  const utilities = document.getElementById('cockpitHeaderUtilities');
  if (!fallback || !utilities || initialized.has(utilities)) return;
  initialized.add(utilities);
  utilities.addEventListener('click', event => {
    const action = event.target.closest?.('[data-header-action]');
    if (action) closeDisclosure(utilities.closest('details'), action.id === 'themeToggle');
  });
  document.addEventListener('pointerdown', event => {
    if (!fallback.contains(event.target)) closeDisclosure(fallback);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.target.closest?.('.workspace-navigation-control')) return;
    if (fallback.open) {
      closeDisclosure(fallback, true);
      event.preventDefault();
    }
  });
  window.addEventListener('blur', () => {
    // Iframe focus does not bubble a pointer event into the parent document.
    setTimeout(() => {
      if (document.activeElement?.tagName === 'IFRAME') closeDisclosure(fallback);
    }, 0);
  });
}
