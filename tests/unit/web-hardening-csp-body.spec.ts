/**
 * Guard: the web-hardening close-out (docs/security/SECURITY-HARDENING.md §4 —
 * "Still open: a tested CSP, express.json({ limit }), and per-route throttles").
 *
 * Asserts the POLICY, not a header string: the emitted CSP is parsed into a
 * directive map and each load-bearing directive is checked by value, so a
 * reordering or a formatting change does not go red but a weakening does.
 *
 * Goes red if any of these regress:
 *  - the default posture drops back to "no CSP header at all" (the pre-2026-08-01
 *    behaviour), or the report-only default starts BLOCKING;
 *  - object-src stops being 'none', base-uri/form-action/frame-ancestors stop being
 *    'self', or script-src gains 'unsafe-inline' without a nonce;
 *  - enforce mode stops using the blocking header, or the kill switch stops working;
 *  - the global JSON body limit stops rejecting an oversized body (413), or one of
 *    the four reserved prefixes stops being reserved (which would pre-parse a signed
 *    webhook's bytes and break its HMAC verifier);
 *  - the violation collector stops deduping (report-only fires on every page load
 *    from every browser; an un-deduped collector buries real faults).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard-per-fix for the CSP default flip (report-only strict), the explicit env-tunable express.json limit, the reserved-prefix passthrough, and the report dedupe. Drives the REAL helmet + parser middleware over real HTTP.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove Alertmanager is reserved from the global parser and its route-local parser verifies a signature over the exact original JSON bytes, including insignificant whitespace.
 */

import { createHmac } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildStrictCsp,
  cspFromEnv,
  cspMode,
  createGlobalJsonParser,
  DEFAULT_JSON_BODY_LIMIT,
  isReservedBodyParserPath,
  jsonBodyLimit,
  resetCspReportDedupe,
  RESERVED_BODY_PARSER_PREFIXES,
  shouldLogCspReport,
  hmacWebhookGuard,
} from '../../src/features/security';
import { createAlertmanagerJsonParser } from '../../src/app/routes/alertmanager-routes';

const ENV_KEYS = ['OSHAL_CSP', 'OSHAL_STRICT_CSP', 'OSHAL_CSP_REPORT_ONLY', 'OSHAL_CSP_REPORT_URI', 'OSHAL_JSON_BODY_LIMIT', 'TEST_ALERT_HMAC'];
const saved: Record<string, string | undefined> = {};
const servers: Array<{ close: (cb: () => void) => void }> = [];

beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  resetCspReportDedupe();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve))));
  servers.length = 0;
});

/** Boots an express app and returns its base URL. */
async function boot(configure: (app: express.Application) => void): Promise<string> {
  const app = express();
  configure(app);
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

/** Parses a CSP header value into { directive: [sources] } so assertions are on POLICY. */
function parseCsp(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const chunk of header.split(';')) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    out[parts[0].toLowerCase()] = parts.slice(1);
  }
  return out;
}

describe('cspMode — the three-way posture', () => {
  it('DEFAULTS to report-only (a policy on every response, blocking nothing)', () => {
    expect(cspMode({} as NodeJS.ProcessEnv)).toBe('report-only');
  });

  it('enforces only on an explicit OSHAL_STRICT_CSP=on', () => {
    expect(cspMode({ OSHAL_STRICT_CSP: 'on' } as NodeJS.ProcessEnv)).toBe('enforce');
    expect(cspMode({ OSHAL_STRICT_CSP: 'true' } as NodeJS.ProcessEnv)).toBe('enforce');
    // report-only can be pinned even with the enforce flag set (staged rollout).
    expect(cspMode({ OSHAL_STRICT_CSP: 'on', OSHAL_CSP_REPORT_ONLY: 'on' } as NodeJS.ProcessEnv)).toBe('report-only');
  });

  it('honours OSHAL_CSP=off as the kill switch', () => {
    expect(cspMode({ OSHAL_CSP: 'off' } as NodeJS.ProcessEnv)).toBe('disabled');
    expect(cspFromEnv({}, { OSHAL_CSP: 'off' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('an unknown value does NOT disable the policy (a typo must not remove the header)', () => {
    expect(cspMode({ OSHAL_STRICT_CSP: 'yess' } as NodeJS.ProcessEnv)).toBe('report-only');
    expect(cspMode({ OSHAL_CSP: 'onn' } as NodeJS.ProcessEnv)).toBe('report-only');
  });
});

describe('the strict directive set is actually restrictive', () => {
  it('pins the directives that carry the security value', () => {
    const d = buildStrictCsp();
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['base-uri']).toEqual(["'self'"]);
    expect(d['form-action']).toEqual(["'self'"]);
    expect(d['frame-ancestors']).toEqual(["'self'"]);
    expect(d['frame-src']).toEqual(["'self'"]);
    expect(d).toHaveProperty('upgrade-insecure-requests');
  });

  it('never allows inline SCRIPT without a nonce', () => {
    expect(buildStrictCsp()['script-src']).toEqual(["'self'"]);
    const nonced = buildStrictCsp({ nonce: 'abc123' })['script-src'];
    expect(nonced).toContain("'nonce-abc123'");
    expect(nonced).not.toContain("'unsafe-inline'");
  });

  it('allows inline STYLE only, and only while that compromise is asked for', () => {
    // Styles cannot exfiltrate the way scripts can; this is the documented pragmatic step.
    expect(buildStrictCsp()['style-src']).toContain("'unsafe-inline'");
    expect(buildStrictCsp({ allowInlineStyles: false })['style-src']).not.toContain("'unsafe-inline'");
  });

  it('supplies a full set rather than merging helmet defaults on top', () => {
    const value = cspFromEnv({}, {} as NodeJS.ProcessEnv);
    expect(value).not.toBe(false);
    expect(value).toMatchObject({ reportOnly: true, useDefaults: false });
  });
});

describe('CSP over real HTTP', () => {
  it('DEFAULT: the report-only header is present and restrictive; the blocking one is not', async () => {
    const base = await boot((app) => {
      app.use(helmet({ contentSecurityPolicy: cspFromEnv() }));
      app.get('/', (_req, res) => res.send('ok'));
    });
    const res = await fetch(`${base}/`);
    const reportOnly = res.headers.get('content-security-policy-report-only');
    expect(reportOnly, 'the default posture must ship a policy, not nothing').toBeTruthy();
    expect(res.headers.get('content-security-policy')).toBeNull();

    const policy = parseCsp(reportOnly as string);
    expect(policy['object-src']).toEqual(["'none'"]);
    expect(policy['base-uri']).toEqual(["'self'"]);
    expect(policy['frame-ancestors']).toEqual(["'self'"]);
    expect(policy['script-src']).not.toContain("'unsafe-inline'");
    // The collector is wired so report-only actually teaches us something.
    expect(policy['report-uri']).toEqual(['/api/security/csp-report']);
  });

  it('ENFORCE: the same policy moves onto the BLOCKING header', async () => {
    process.env.OSHAL_STRICT_CSP = 'on';
    const base = await boot((app) => {
      app.use(helmet({ contentSecurityPolicy: cspFromEnv() }));
      app.get('/', (_req, res) => res.send('ok'));
    });
    const res = await fetch(`${base}/`);
    const blocking = res.headers.get('content-security-policy');
    expect(blocking).toBeTruthy();
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
    expect(parseCsp(blocking as string)['object-src']).toEqual(["'none'"]);
  });

  it('KILL SWITCH: OSHAL_CSP=off emits neither header', async () => {
    process.env.OSHAL_CSP = 'off';
    const base = await boot((app) => {
      app.use(helmet({ contentSecurityPolicy: cspFromEnv() }));
      app.get('/', (_req, res) => res.send('ok'));
    });
    const res = await fetch(`${base}/`);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
  });
});

describe('violation-report dedupe', () => {
  it('logs each distinct finding once and drops the repeats', () => {
    expect(shouldLogCspReport("script-src|inline|https://host/cockpit/")).toBe(true);
    expect(shouldLogCspReport("script-src|inline|https://host/cockpit/")).toBe(false);
    expect(shouldLogCspReport("style-src|inline|https://host/cockpit/")).toBe(true);
  });

  it('is bounded — a report flood cannot grow the process memory without limit', () => {
    for (let i = 0; i < 500; i += 1) shouldLogCspReport(`d${i}|b|u`);
    // Past the cap it stops admitting new signatures rather than allocating forever.
    expect(shouldLogCspReport('past-the-cap|b|u')).toBe(false);
  });
});

describe('global JSON body limit', () => {
  it('is explicit and env-tunable, defaulting tight', () => {
    expect(jsonBodyLimit({} as NodeJS.ProcessEnv)).toBe(DEFAULT_JSON_BODY_LIMIT);
    expect(DEFAULT_JSON_BODY_LIMIT).toBe('100kb');
    expect(jsonBodyLimit({ OSHAL_JSON_BODY_LIMIT: '2mb' } as NodeJS.ProcessEnv)).toBe('2mb');
    expect(jsonBodyLimit({ OSHAL_JSON_BODY_LIMIT: '  ' } as NodeJS.ProcessEnv)).toBe(DEFAULT_JSON_BODY_LIMIT);
  });

  it('reserves exactly the four mounts that own their own parser', () => {
    expect([...RESERVED_BODY_PARSER_PREFIXES].sort())
      .toEqual(['/api/alerts/alertmanager', '/api/hooks', '/api/remote-clients', '/api/vision']);
    expect(isReservedBodyParserPath('/api/alerts/alertmanager')).toBe(true);
    expect(isReservedBodyParserPath('/api/hooks/github/push')).toBe(true);
    expect(isReservedBodyParserPath('/api/tickets')).toBe(false);
  });

  it('accepts a small body and REJECTS an oversized one with 413', async () => {
    process.env.OSHAL_JSON_BODY_LIMIT = '1kb';
    const base = await boot((app) => {
      app.use(createGlobalJsonParser());
      app.post('/api/echo', (req, res) => res.json({ keys: Object.keys(req.body ?? {}) }));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(err?.status ?? 500).json({ type: err?.type ?? 'unknown' });
      });
    });

    const small = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(small.status).toBe(200);
    expect(await small.json()).toEqual({ keys: ['hello'] });

    const oversized = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(4096) }),
    });
    expect(oversized.status, 'an oversized body must be refused, not parsed').toBe(413);
    expect(await oversized.json()).toEqual({ type: 'entity.too.large' });
  });

  it('leaves a reserved-prefix body UNPARSED so its route-local parser (and HMAC verifier) can act', async () => {
    process.env.OSHAL_JSON_BODY_LIMIT = '1kb';
    const base = await boot((app) => {
      app.use(createGlobalJsonParser());
      app.post('/api/hooks/:provider', (req, res) => res.json({ parsed: req.body !== undefined }));
    });
    // Deliberately bigger than the global limit: if the global parser touched it, this 413s.
    const res = await fetch(`${base}/api/hooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(4096) }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ parsed: false });
  });

  it('captures and verifies the exact Alertmanager JSON bytes after the global-parser reservation', async () => {
    process.env.TEST_ALERT_HMAC = 'alert-hmac-test-secret';
    const raw = '{\n  "alerts": [ { "labels": { "alertname": "ApiDown" } } ]\n}';
    const signature = 'sha256=' + createHmac('sha256', process.env.TEST_ALERT_HMAC).update(raw, 'utf8').digest('hex');
    const base = await boot((app) => {
      app.use(createGlobalJsonParser());
      app.post(
        '/api/alerts/alertmanager',
        createAlertmanagerJsonParser(),
        hmacWebhookGuard({
          secretEnv: 'TEST_ALERT_HMAC',
          header: 'x-alert-signature-256',
          prefix: 'sha256=',
        }),
        (req, res) => res.json({
          alertname: req.body?.alerts?.[0]?.labels?.alertname,
          raw: (req as express.Request & { rawBody?: Buffer }).rawBody?.toString('utf8'),
        }),
      );
    });

    const accepted = await fetch(`${base}/api/alerts/alertmanager`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alert-signature-256': signature },
      body: raw,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ alertname: 'ApiDown', raw });

    const rejected = await fetch(`${base}/api/alerts/alertmanager`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alert-signature-256': signature },
      body: raw.replace('ApiDown', 'ApiUp'),
    });
    expect(rejected.status).toBe(401);
  });
});
