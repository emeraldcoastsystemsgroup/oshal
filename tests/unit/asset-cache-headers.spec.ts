/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the deploy-visibility cache contract. A day was lost to shipped-and-verified UI changes that never reached a browser: the origin sent `no-cache`, and Cloudflare's default 4-hour Browser Cache TTL rewrote it to `max-age=14400` on the way out, pinning freshly deployed assets in every user's browser. `no-cache` is still cacheable-with-revalidation, so it stays in the set that setting applies to; `no-store` is not. These cases pin the stronger header on the three mounts that serve deployable code.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8');

const COCKPIT_ROUTES = 'src/app/routes/cockpit-static-routes.ts';
const SERVER = 'src/app/server.ts';

describe('deployable assets are not cacheable by an intermediary', () => {
  it('serves the cockpit with no-store, because no-cache was measurably not enough', () => {
    const src = read(COCKPIT_ROUTES);

    // The original code used `no-cache, must-revalidate` and a comment asserting that this made
    // Cloudflare revalidate. It does not: measured on the hosted deployment, the origin sent
    // `no-cache, must-revalidate` and the browser received `max-age=14400, must-revalidate`.
    // A regression to no-cache reinstates a four-hour window in which a correct deploy is
    // invisible — which is indistinguishable, from the user's seat, from a broken one.
    const handler = /const noCache: express\.RequestHandler[\s\S]{0,300}?\}\;/.exec(src)?.[0] ?? '';
    expect(handler).toContain('no-store');
    expect(handler).not.toMatch(/'no-cache/);
  });

  it('serves the shared design CSS and surface JS with no-store', () => {
    const src = read(SERVER);

    // surface-reading.js rides the /shared/ui/js mount. Standalone surfaces (Jarvis) are outside
    // the cockpit service worker's scope, so the HTTP cache is the ONLY layer in front of them —
    // a stale copy there is exactly the "the answer is still too small to read" report.
    for (const mount of ['/shared/ui/css', '/shared/ui/js']) {
      const block = new RegExp(
        `app\\.use\\('${mount}', express\\.static\\([\\s\\S]{0,900}?\\}\\)\\);`,
      ).exec(src)?.[0];
      expect(block, `${mount} must be mounted with explicit headers`).toBeTruthy();
      expect(block).toContain("'no-store, must-revalidate'");
      expect(block).not.toMatch(/'no-cache,/);
    }
  });
});
