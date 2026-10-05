/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The user agent the node's windows present, as a pure function. main.ts stripped only `Electron/…` and a hard-coded `oshal-chat/…`, but Chromium inserts the app's own name, which for the npm install the Linux and macOS one-click installers use is `@oshal/chat/0.5.2`. That token survived, Google's OAuth page refused the window as an embedded browser ("disallowed_useragent"), and the swarm sign-in never completed on the DGX Spark (2026-10-05). The app's own name is now removed whatever it is.
 */

/**
 * @description Returns the Chrome user agent the node's windows present: the Electron token and the
 * app's own `<name>/<version>` token removed, so Google's OAuth page sees an ordinary Chrome.
 * @param raw - Electron's default user agent (`app.userAgentFallback`).
 * @param appName - The app's name as Chromium inserted it (`app.getName()`): `@oshal/chat` for the
 *   npm install, a product name for a packaged build.
 * @returns The user agent with both tokens removed.
 */
export function presentableUserAgent(raw: string, appName: string): string {
  const names = [appName, 'oshal-chat'].filter(Boolean).map(escapeRegExp);
  const ownToken = new RegExp(`\\s(?:${names.join('|')})\\/\\S+`, 'gi');
  return raw.replace(/\sElectron\/\S+/gi, '').replace(ownToken, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
