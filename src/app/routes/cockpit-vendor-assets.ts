/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serve only locked Markdown and regular icon assets through the existing authenticated Cockpit boundary.
 */
import type express from 'express';
import path from 'node:path';

/** @description Map fixed public asset names to installed dependency files, never to caller-selected filesystem paths. */
function vendorAssets(): Array<[string, string]> {
  const marked = path.dirname(require.resolve('marked/package.json'));
  const phosphor = path.dirname(require.resolve('@phosphor-icons/web/regular'));
  return [
    ['/cockpit/vendor/marked.umd.js', path.join(marked, 'lib/marked.umd.js')],
    ...['style.css', 'Phosphor.woff2', 'Phosphor.woff', 'Phosphor.ttf', 'Phosphor.svg']
      .map((name): [string, string] => [`/cockpit/vendor/phosphor/${name}`, path.join(phosphor, name)]),
  ];
}

/** @description Mount the complete fixed asset allowlist behind the same authentication and cache policy as the shell. */
export function registerCockpitVendorAssets(app: Pick<express.Application, 'get'>,
  requiresAuth: express.RequestHandler, noCache: express.RequestHandler): void {
  for (const [url, filename] of vendorAssets()) {
    app.get(url, requiresAuth, noCache, (_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(filename, error => { if (error) next(error); });
    });
  }
}
