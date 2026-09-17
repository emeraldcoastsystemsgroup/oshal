/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The applications catalog decided openability from a hand-typed WORKING array plus "the manifestPath contains deployed-apps". A store package passed on the path; a CORE manifest could only pass by being typed into the literal, so five shipped apps with real rail surfaces — security-center, workflow-studio, intelligent-processing, person-model, oshal-engineering — rendered a disabled "Coming soon" button in the one screen that is supposed to be the inventory of truth, while the Security Center sat on the operator's own rail. The decision now reads the summary's manifest-derived `hasSurface`, and an app that genuinely declares no surface says so instead of claiming it is unfinished. Lives in its own module, not inline in the page, so the guard can drive the real rendering decision.
 */

/**
 * @description Can this app be opened into a cockpit? True exactly when its manifest declares a
 * surface to open — `ui.static` tiles, a `ui.dynamic` row source, or (ADR-141) a group's borrowed
 * `toolbar`. The server derives that into the listing summary; the catalog never re-reads a
 * manifest and never consults a name list, so shipping an app with a rail is all it takes to be
 * openable here. An app's lifecycle `status` is deliberately NOT part of this: the row already
 * shows active/inactive, and an operator toggling an app off does not turn it into a different
 * kind of app.
 * @param {{hasSurface?: boolean}} app - One entry from GET /api/swarm/apps.
 * @returns {boolean} True when the catalog may offer an Open button.
 */
export function isOpenable(app) {
  return app?.hasSurface === true;
}

/**
 * @description The open button for one catalog row. An openable app gets the live Open action; an
 * app with no surface gets a disabled button that states the true reason — it has no screen and
 * works through its queue — rather than "Coming soon", which asserts the app is unfinished and is
 * false for every shipped headless app.
 * @param {{hasSurface?: boolean, displayName?: string, name?: string, ticketType?: string|null}} app
 * - One entry from GET /api/swarm/apps.
 * @returns {{openable: boolean, label: string, title: string}} What the row should render.
 */
export function openControl(app) {
  const label = app?.displayName || app?.name || 'this app';
  if (isOpenable(app)) {
    return { openable: true, label: 'Open →', title: `Open ${label} in the cockpit` };
  }
  return {
    openable: false,
    label: 'No surface',
    title: app?.ticketType
      ? `${label} has no cockpit surface — it runs through tickets on its "${app.ticketType}" queue.`
      : `${label} has no cockpit surface — it contributes bots and tools rather than a screen.`,
  };
}

/**
 * @description Sort key for the catalog: apps you can open first, headless apps after them. The
 * caller breaks ties on display name, so the order is fully determined by what the manifests
 * declare and never by the order someone typed names into an array.
 * @param {{hasSurface?: boolean}} app - One entry from GET /api/swarm/apps.
 * @returns {number} 0 for an openable app, 1 for one with no surface.
 */
export function catalogRank(app) {
  return isOpenable(app) ? 0 : 1;
}
