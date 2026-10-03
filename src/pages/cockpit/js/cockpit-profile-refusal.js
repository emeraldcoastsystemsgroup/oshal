/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Render a refused focused profile without opening a default framework workbench.
 */

/**
 * @description Show the closed focused-profile state before cockpit default navigation.
 * @param {HTMLElement|null} container Main content container.
 * @param {object|undefined} profile Current server profile or closed client fallback.
 * @returns {boolean} Whether normal initial navigation must stop.
 */
export function renderProfileRefusal(container, profile) {
  if (profile?.name !== 'profile-unavailable') return false;
  if (container) {
    container.innerHTML = '<section role="status" style="padding:24px"><h1>Application unavailable</h1>'
      + '<p>Reload to check again, or ask an administrator to review your access.</p>'
      + '<button type="button" data-profile-retry>Reload</button></section>';
    container.querySelector('[data-profile-retry]')?.addEventListener('click', () => window.location.reload());
  }
  return true;
}
