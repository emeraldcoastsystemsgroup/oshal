/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for two env-delta classes that redded the first trunk ci-local --head run (2026-07-23) on a healthy tree — a gate that reds without a real defect trains everyone to ignore red. (1) CRLF: the pre-recreation repo's committed blobs carried CRLF while working trees were LF, so the one multi-line toContain in app-immersive-chrome.spec.ts passed in the repo and failed in the git-archive export; b8e43f8 pinned `* text=auto eol=lf` in .gitattributes and this spec keeps the pin AND the actual bytes honest. (2) ::1 loopback: Playwright clients resolving localhost→::1 hit the stale-wslrelay squatter and died ECONNREFUSED ::1:3456 (258 hits) while the webServer served IPv4; the harness now pins http://127.0.0.1 and this spec goes red if the ::1-prone hostname default returns (the origin helpers are pinned by test-origins.spec.ts).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Require hosted CI to enable the explicit mock-header identity switch so its database-backed two-user privacy/isolation proofs execute rather than fail at their anti-skip guard.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Source files that source-reading unit specs assert MULTI-LINE content on (\n-joined
 * toContain in app-immersive-chrome.spec.ts and siblings). A CRLF checkout or export flips
 * those assertions red with zero product defect — the exact 2026-07-23 --head failure.
 */
const MULTILINE_ASSERTED_SOURCES = [
  'src/pages/cockpit/js/app.js',
  'src/pages/cockpit/js/embedded-chat-panel-controller.js',
  'src/pages/cockpit/js/jarvis-orb.js',
  'src/pages/cockpit/index.html',
  'src/pages/cockpit/service-worker.js',
];

describe('ci-local gate reliability — CRLF class (b8e43f8 eol=lf pin)', () => {
  it('.gitattributes keeps the line-ending pin that renormalized the CRLF blobs', () => {
    const attrs = readFileSync(resolve(REPO_ROOT, '.gitattributes'), 'utf8');
    expect(attrs).toContain('* text=auto eol=lf');
  });

  it('sources under multi-line assertions contain no \\r — red in a CRLF checkout AND a CRLF export', () => {
    // Env-independent by design: this reads the same bytes the source-reading specs read, in
    // whatever tree the suite runs in (working repo or GATE_SRC export). If autocrlf ever
    // reintroduces CRLF on either side, this test names the file instead of a downstream
    // toContain failing with an inscrutable diff.
    for (const relPath of MULTILINE_ASSERTED_SOURCES) {
      const content = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
      expect(content.includes('\r'), `${relPath} contains CRLF line endings — the .gitattributes eol=lf pin is not being honored (see 2026-07-23 ci-local --head red)`).toBe(false);
    }
  });
});

describe('ci-local gate reliability — e2e loopback host (wslrelay ::1 class)', () => {
  it('playwright.config.ts pins the IPv4 loopback and never templates a localhost base URL', () => {
    const config = readFileSync(resolve(REPO_ROOT, 'playwright.config.ts'), 'utf8');
    expect(config).toContain('http://127.0.0.1:${PLAYWRIGHT_PORT}');
    // A localhost-hostname template is the ::1-prone default that produced 258
    // ECONNREFUSED ::1:3456 hits in the 2026-07-23 --head run. Comments may say
    // "localhost"; a URL template must not.
    expect(config).not.toMatch(/http:\/\/localhost:\$\{/);
  });

  it('the green-set specs that build their own base URLs pin 127.0.0.1 too', () => {
    // These three green-set files construct BASE_URL/API_BASE themselves (deliberate env
    // overrides preserved) instead of using tests/helpers/test-origins.ts — so the helper
    // guard (test-origins.spec.ts) does not cover them.
    const selfBuilt = [
      'tests/live/privacy-export-delete.live.spec.ts',
      'tests/live/two-user-isolation.live.spec.ts',
      'tests/swarm-apps-framework.spec.ts',
    ];
    for (const relPath of selfBuilt) {
      const src = readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
      expect(src, `${relPath} templates a localhost base URL — the ::1-prone hostname (wslrelay wedge class)`).not.toMatch(/http:\/\/localhost:\$\{/);
    }
  });
});

describe('hosted CI own-data evidence identity gate', () => {
  it('runs the two-user live specs with explicit mock-header identities over provisioned Postgres', () => {
    const workflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const greenSuite = readFileSync(resolve(REPO_ROOT, 'tests/e2e-green-suite.txt'), 'utf8');

    expect(greenSuite).toContain('tests/live/privacy-export-delete.live.spec.ts');
    expect(greenSuite).toContain('tests/live/two-user-isolation.live.spec.ts');
    expect(workflow).toMatch(/MOCK_OIDC:\s*["']?true["']?/);
    expect(workflow).toMatch(/MOCK_OIDC_ALLOW_HEADER:\s*["']?true["']?/);
    expect(workflow).toContain('DATABASE_URL: postgresql://oshal:oshal@localhost:5432/oshal');
  });
});
