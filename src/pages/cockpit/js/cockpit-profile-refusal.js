/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Render a refused focused profile without opening a default framework workbench.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | One shared PROFILE_UNAVAILABLE name for the producer (RibbonNav's closed fallback) and this renderer: two separate literals let a rename on one side silently boot the default workbench for every refusal. bootInitialView is the cockpit's ribbon-ready step, moved here from app.js so it runs (and is tested) without the whole shell: a refusal renders and stops; otherwise the initial view opens, and a ?ticket= deep link is honoured only when Tickets is a registered view.
 */

/** The name of the closed profile every refused, unreadable or timed-out profile answer becomes. */
export const PROFILE_UNAVAILABLE = 'profile-unavailable';

/**
 * @description Show the closed focused-profile state before cockpit default navigation.
 * @param {HTMLElement|null} container Main content container.
 * @param {object|undefined} profile Current server profile or closed client fallback.
 * @returns {boolean} Whether normal initial navigation must stop.
 */
export function renderProfileRefusal(container, profile) {
  if (profile?.name !== PROFILE_UNAVAILABLE) return false;
  if (container) {
    container.innerHTML = '<section role="status" style="padding:24px"><h1>Application unavailable</h1>'
      + '<p>Reload to check again, or ask an administrator to review your access.</p>'
      + '<button type="button" data-profile-retry>Reload</button></section>';
    container.querySelector('[data-profile-retry]')?.addEventListener('click', () => window.location.reload());
  }
  return true;
}

/**
 * @description The cockpit's first navigation once the ribbon has resolved its profile. A refused
 * profile renders the refusal and nothing else opens; a view already chosen (a click while the
 * profile loaded) is kept; otherwise the ribbon's active view opens. A `?ticket=` deep link opens
 * the Tickets workbench only when Tickets is a registered view of this ribbon, so it cannot boot a
 * workbench the profile never admitted.
 * @param {object} boot - The step's inputs.
 * @param {{profile?: object, views?: Array<{id: string}>, getActive?: () => string|null}} boot.ribbon - The resolved ribbon.
 * @param {HTMLElement|null} boot.container - The main content container.
 * @param {{pendingTicketSelection?: string}} boot.viewController - Receives the ticket to preselect.
 * @param {() => boolean} boot.isBusy - Whether a view was already chosen.
 * @param {(viewId: string) => unknown} boot.switchView - Opens a view.
 * @param {string} boot.ticketId - The `?ticket=` value ('' when absent).
 * @returns {string} 'refused', 'busy', or the view that was opened.
 */
export function bootInitialView({ ribbon, container, viewController, isBusy, switchView, ticketId }) {
  if (renderProfileRefusal(container, ribbon?.profile)) return 'refused';
  if (isBusy()) return 'busy';
  const ticketsRegistered = Array.isArray(ribbon?.views) && ribbon.views.some((view) => view.id === 'tickets');
  const deepLink = ticketId && ticketsRegistered ? ticketId : '';
  const initialView = deepLink ? 'tickets' : (ribbon?.getActive?.() || 'home');
  // Seed the selection BEFORE the first render so TicketView picks it up from
  // initialSelectedTicketId on its own load pass. Calling focusTicket AFTER switchView races
  // the list fetch and selects nothing.
  if (deepLink) viewController.pendingTicketSelection = deepLink;
  void switchView(initialView);
  return initialView;
}
