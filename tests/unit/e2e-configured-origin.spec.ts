/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New. Every Playwright spec takes the server origin from tests/helpers/test-origins.ts (or a relative path on the config's baseURL). Scans every spec the default config discovers for an origin the spec builds itself - a PLAYWRIGHT_PORT/PORT read, a loopback URL with a fixed port, or a loopback URL with a made-up port - and fails on any that is not on the reviewed list below of ephemeral self-hosted servers and semantic literals. The list cannot go stale: an entry that no longer matches is a failure too. A planted `http://localhost:${process.env.PLAYWRIGHT_PORT||3456}` proves the scan goes red.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { listE2eSpecFiles } from '../helpers/e2e-dispositions';
import { auditSpecOrigins, type OriginFinding } from '../helpers/e2e-origin-audit';

const ROOT = path.resolve(__dirname, '..', '..');

/** A reviewed exception: this exact finding in this file is not the server origin. */
interface OriginException {
  file: string;
  rule: OriginFinding['rule'];
  text: string;
  reason: string;
}

const EXCEPTIONS: OriginException[] = [
  {
    file: 'tests/session-140-runtime-usability.spec.ts',
    rule: 'literal-port',
    text: 'http://localhost:3456/cockpit/',
    reason: 'Asserts the docs advertise the canonical operator URL; the literal is the assertion subject (tests/helpers/test-origins.ts names it as deliberately not parameterized).',
  },
  {
    file: 'tests/session-140-runtime-usability.spec.ts',
    rule: 'literal-port',
    text: '`http://localhost:51455/auth/callback`',
    reason: 'Asserts the README documents the OAuth callback URL; the literal is the assertion subject.',
  },
  {
    file: 'tests/openai-codex-oauth-service.spec.ts',
    rule: 'literal-port',
    text: 'http://localhost:1455/auth/callback',
    reason: 'The OpenAI Codex OAuth redirect_uri is a product constant registered with the provider, not the harness origin.',
  },
  {
    file: 'tests/cockpit-ui.spec.ts',
    rule: 'literal-port',
    text: 'http://localhost:80/session-72-functional',
    reason: 'A Plane URL typed into the config form and read back as a saved value; nothing connects to it.',
  },
  {
    file: 'tests/cockpit-ui.spec.ts',
    rule: 'literal-port',
    text: 'http://localhost:80/session-72-reload',
    reason: 'A Plane URL seeded into saved config to prove it survives a reload; nothing connects to it.',
  },
  {
    file: 'tests/alert-intake-rls-live.spec.ts',
    rule: 'literal-port',
    text: 'http://127.0.0.1:9091/graph',
    reason: 'An Alertmanager generatorURL value inside the alert payload fixture; nothing connects to it.',
  },
  {
    file: 'tests/dynamic-agent-live-e2e.spec.ts',
    rule: 'literal-port',
    text: 'http://127.0.0.1:5000/health',
    reason: 'Probed with docker exec INSIDE the launched bot-node container (its own loopback), not from the host.',
  },
  {
    file: 'tests/a2a-gateway-e2e.spec.ts',
    rule: 'template-port',
    text: 'http://127.0.0.1:${…}/a2a',
    reason: 'The standalone tools/a2a-sample-agent the spec spawns as a child process on a random port in 41300-41799; not the harness server.',
  },
  {
    file: 'tests/a2a-gateway-e2e.spec.ts',
    rule: 'template-port',
    text: 'http://127.0.0.1:${…}/.well-known/agent-card.json',
    reason: 'Readiness probe of the same spawned sample agent.',
  },
];

const key = (file: string, f: Pick<OriginFinding, 'rule' | 'text'>): string => `${file} | ${f.rule} | ${f.text}`;

describe('every Playwright spec uses the configured origin', () => {
  it('no spec outside the reviewed exceptions builds the server origin itself', () => {
    const allowed = new Set(EXCEPTIONS.map((e) => key(e.file, e)));
    const found: string[] = [];
    const unexpected: string[] = [];
    const files = listE2eSpecFiles(ROOT);
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      for (const finding of auditSpecOrigins(file, readFileSync(path.join(ROOT, file), 'utf8'))) {
        found.push(key(file, finding));
        if (!allowed.has(key(file, finding))) unexpected.push(`${file}:${finding.line} ${finding.rule} ${finding.text}`);
      }
    }
    expect(unexpected, 'take the origin from tests/helpers (baseOrigin/baseHost/apiOrigin) or a relative path on the config baseURL').toEqual([]);
    const stale = EXCEPTIONS.filter((e) => !found.includes(key(e.file, e))).map((e) => key(e.file, e));
    expect(stale, 'an exception that no longer matches must be removed').toEqual([]);
  });

  it('every exception says why the literal is not the server origin', () => {
    for (const e of EXCEPTIONS) expect(e.reason.length, key(e.file, e)).toBeGreaterThan(30);
  });
});

describe('the origin scan goes red on each self-built shape', () => {
  const audit = (source: string, file = 'tests/planted.spec.ts'): string[] => auditSpecOrigins(file, source).map((f) => `${f.rule} ${f.text}`);

  it('flags the shape the thirteen migrated specs used', () => {
    const planted = 'const BASE = `http://localhost:${process.env.PLAYWRIGHT_PORT||3456}`;';
    expect(audit(planted)).toEqual(['template-port http://localhost:${…}', 'env-port process.env.PLAYWRIGHT_PORT']);
  });

  it('flags a generic PORT fallback, an element-access read and a fixed-port literal', () => {
    expect(audit("const P = process.env.PLAYWRIGHT_PORT ?? process.env['PORT'] ?? '3456';")).toEqual([
      'env-port process.env.PLAYWRIGHT_PORT',
      'env-port process.env.PORT',
    ]);
    expect(audit("await page.goto('http://127.0.0.1:4458/cockpit/');")).toEqual(['literal-port http://127.0.0.1:4458/cockpit/']);
    expect(audit('fetch(`http://[::1]:3456/health`);')).toEqual(['literal-port http://[::1]:3456/health']);
  });

  it('flags a made-up port even when it is a named constant', () => {
    expect(audit('const AUTH_PORT = 3457;\nconst URL = `http://localhost:${AUTH_PORT}`;')).toEqual(['template-port http://localhost:${…}']);
  });

  it('accepts the helper, relative paths, ephemeral servers, comments and regexes', () => {
    const clean = [
      "import { baseOrigin } from './helpers';",
      '// the old code used http://localhost:3456 and process.env.PLAYWRIGHT_PORT',
      'const BASE = process.env.APP_URL ?? baseOrigin();',
      "await page.goto('/cockpit/');",
      'await page.waitForURL(/localhost:8080.*openid-connect/);',
      "new URL(req.url, 'http://127.0.0.1');",
      'const port = (server.address() as AddressInfo).port;',
      'const base = `http://127.0.0.1:${port}`;',
    ].join('\n');
    expect(audit(clean)).toEqual([]);
  });

  it('parses JavaScript specs too', () => {
    expect(audit("const u = 'http://localhost:3456/x';", 'tests/planted.test.js')).toEqual(['literal-port http://localhost:3456/x']);
  });
});
