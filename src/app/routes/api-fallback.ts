/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Boot-window-aware /api fallback handler. Root cause of the "sat-ops surface shows {error:'Not found',path:'/api/sat/app?...'}" report: server.ts starts listening BEFORE swarmAppService.autoLoadAllWithRetry() mounts store-package routes (18s gap on the 2026-07-24 06:31Z boot), so a cockpit surface iframe that loads during that window gets a hard 404 from the JSON catch-all and sits on it until a manual reload. Until package auto-load settles, unmatched /api paths now answer 503 + Retry-After — JSON for fetch() callers, a self-refreshing HTML splash for iframe/browser navigations so package surfaces recover on their own. After settle, behavior is exactly the prior JSON 404 (never Express's HTML "<!DOCTYPE" page).
 */

import type { Request, RequestHandler, Response } from 'express';

/**
 * Minimal self-refreshing splash served to BROWSER NAVIGATIONS (Accept: text/html — i.e. a
 * cockpit surface iframe or a direct address-bar hit) that arrive for an unmatched /api path
 * while store-package routes are still mounting. The meta refresh re-requests the same URL
 * every 3s, so the surface appears as soon as ManifestRouteMounter registers its route —
 * no manual reload needed.
 */
const STARTING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>OSHAL — starting</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center;
         font-family: system-ui, sans-serif; background: #0b0f14; color: #9fb3c8; }
  .box { text-align: center; }
  .spin { width: 28px; height: 28px; margin: 0 auto 12px; border-radius: 50%;
          border: 3px solid #22303e; border-top-color: #5ac8fa; animation: r 0.9s linear infinite; }
  @keyframes r { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="box">
  <div class="spin"></div>
  <div>OSHAL is starting &mdash; application routes are still loading. Retrying&hellip;</div>
</div>
</body>
</html>
`;

/**
 * @description Builds the LAST /api middleware: the fallback for any /api path no static or
 * package route matched. Two regimes, decided per request by `isPackageRoutesSettled`:
 * (1) BOOT WINDOW (auto-load not settled): 503 + Retry-After, because "not mounted YET" is
 * not "not found" — a store-package route (e.g. /api/sat/app) may be seconds from mounting.
 * Fetch callers (Accept: * / *) get JSON; browser navigations (Accept: text/html) get a
 * self-refreshing splash so cockpit surface iframes self-heal. (2) SETTLED: JSON 404 —
 * never Express's HTML "<!DOCTYPE" 404 page, which cockpit fetch handlers surface as
 * `SyntaxError: Unexpected token '<'`.
 * @param isPackageRoutesSettled - Returns true once swarm-app auto-load has finished
 * (successfully or exhausted its retries) and package routes that will mount have mounted.
 * @returns Express request handler to register as the final /api middleware.
 */
export function createApiFallbackHandler(isPackageRoutesSettled: () => boolean): RequestHandler {
  return (req: Request, res: Response): void => {
    if (!isPackageRoutesSettled()) {
      res.status(503).set('Retry-After', '3');
      // Order matters: with Accept: */* (fetch default) express resolves to the FIRST
      // entry ('json'), so only genuine text/html navigations get the HTML splash.
      if (req.accepts(['json', 'html']) === 'html') {
        res.type('html').send(STARTING_HTML);
        return;
      }
      res.json({
        error: 'Starting',
        detail: 'Application routes are still loading; retry shortly.',
        path: req.originalUrl,
      });
      return;
    }
    res.status(404).json({ error: 'Not found', path: req.originalUrl });
  };
}
