/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Verify the legacy /cockpit/css/themes/<id>.css contract for packaged skins (ADR-085): a static miss serves the ACTIVE package's bundled ui/<id>.css; unknown ids and non-slug names fall through; traversal is confined.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import { createPackagedThemeCssFallback } from '../../src/app/routes/swarm-app-routes';
import type { SwarmAppService } from '../../src/features/swarm-apps';

const THEME_CSS = '[data-theme="lm-test"] { --status-error: #ff6b8b; }';

let pkgDir: string;
let server: Server;
let base: string;

/** Only findActiveAppByTheme is exercised by the fallback — fake the service around it. */
function fakeService(theme: string | null): SwarmAppService {
  return {
    findActiveAppByTheme: async (id: string) =>
      theme && id === theme
        ? { name: 'lm-test-app', manifestPath: join(pkgDir, 'oshal-app.yaml'), manifest: { theme } }
        : null,
  } as unknown as SwarmAppService;
}

beforeAll(async () => {
  pkgDir = mkdtempSync(join(tmpdir(), 'oshal-theme-'));
  mkdirSync(join(pkgDir, 'ui'));
  writeFileSync(join(pkgDir, 'ui', 'lm-test.css'), THEME_CSS, 'utf8');
  writeFileSync(join(pkgDir, 'oshal-app.yaml'), 'name: lm-test-app\n', 'utf8');

  const app = express();
  app.get('/cockpit/css/themes/:file', createPackagedThemeCssFallback(fakeService('lm-test')));
  app.use((_req, res) => res.status(404).json({ notFound: true }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(pkgDir, { recursive: true, force: true });
});

describe('createPackagedThemeCssFallback (ADR-085 packaged skins)', () => {
  it('serves the active package bundled skin at the legacy themes path', async () => {
    const res = await fetch(`${base}/cockpit/css/themes/lm-test.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(await res.text()).toBe(THEME_CSS);
  });

  it('falls through to 404 when no active app bundles the requested skin', async () => {
    const res = await fetch(`${base}/cockpit/css/themes/no-such-theme.css`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ notFound: true });
  });

  it('falls through for non-slug/non-css names (no traversal into the package)', async () => {
    // Express collapses raw ../ before routing, so attack via an encoded name — the
    // slug regex must reject anything that is not <slug>.css.
    expect((await fetch(`${base}/cockpit/css/themes/${encodeURIComponent('..%2Foshal-app.yaml')}`)).status).toBe(404);
    expect((await fetch(`${base}/cockpit/css/themes/lm-test.css.map`)).status).toBe(404);
  });
});
