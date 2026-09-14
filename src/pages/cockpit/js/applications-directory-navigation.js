/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Open the authorized Home directory from the OSHAL menu without recreating an active Home composer.
 */

/**
 * Bind menu intent to the existing Home lifecycle. A focused application returns
 * through ordinary top-level navigation; a late Home render cannot open over a
 * newer view. This bridge carries no application data or authorization decisions.
 * @param {object} options Window, current controller, normal navigation and error callback.
 * @returns {{homeReady: Function, open: Function, destroy: Function}} Lifecycle hooks.
 */
export function bindApplicationsDirectory({ win = window, getController, navigateHome, onError }) {
  let requested = new URLSearchParams(win.location.search).get('directory') === '1';
  let ready = null;
  let requestedView = null;
  let active = true;

  /** Open only the currently mounted Home; remove the one-shot URL after success. */
  function flush() {
    const controller = getController();
    if (!active || !requested || controller?.currentView !== 'home'
      || !ready || controller.activeViewInstance !== ready) return;
    requested = false;
    ready.openDirectory();
    const url = new URL(win.location.href);
    if (url.searchParams.has('directory')) {
      url.searchParams.delete('directory');
      win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
    }
  }

  /** Follow existing navigation; a focused profile must not supply the global directory. */
  async function open() {
    if (!active) return;
    const params = new URLSearchParams(win.location.search);
    if (params.has('app') || params.has('profile')) {
      win.location.assign('/cockpit/?view=home&directory=1');
      return;
    }
    requested = true;
    requestedView = getController()?.currentView === 'home' ? getController().activeViewInstance : null;
    if (getController()?.currentView !== 'home') await navigateHome();
    if (getController()?.currentView !== 'home') { requested = false; return; }
    flush();
  }

  const listener = () => { void open().catch(error => { requested = false; onError?.(error); }); };
  win.addEventListener('oshal:open-applications', listener);
  return {
    open,
    homeReady(view) {
      if (requestedView && requestedView !== view) requested = false;
      ready = view; flush();
    },
    destroy() { active = false; requested = false; ready = null; win.removeEventListener('oshal:open-applications', listener); },
  };
}
