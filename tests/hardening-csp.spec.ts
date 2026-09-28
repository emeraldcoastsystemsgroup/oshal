/**
 * Strict-CSP hardening tests.
 *
 * Proves:
 *  - default: cspFromEnv() returns the strict directive set in REPORT-ONLY mode (a policy on
 *    every response, blocking nothing); OSHAL_STRICT_CSP=off does not change that, and only
 *    the OSHAL_CSP=off kill switch returns `false` (no header at all);
 *  - flag ON: a directive set is returned, inline scripts blocked unless nonced;
 *  - nonce mode: 'nonce-...' appears in script-src;
 *  - report-only flag toggles reportOnly without changing the directives.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — unit tests for opt-in strict CSP builder.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The two "off by default" cases asserted the posture strict-csp.ts retired on purpose (its change log seq 2: the default flipped to report-only so every response carries a policy, and OSHAL_CSP=off became the kill switch). They were the ratchet's recorded hardening-csp reds. They now pin the shipped contract instead - default report-only with the strict directives, OSHAL_STRICT_CSP=off still report-only, OSHAL_CSP=off returns false - and OSHAL_CSP is reset between cases like the other CSP variables.
 */
import { test, expect } from '@playwright/test';
import { buildStrictCsp, cspFromEnv } from '@/features/security/hardening/strict-csp';

test.beforeEach(() => {
  delete process.env.OSHAL_CSP;
  delete process.env.OSHAL_STRICT_CSP;
  delete process.env.OSHAL_CSP_REPORT_ONLY;
  delete process.env.OSHAL_CSP_REPORT_URI;
});

test('default — cspFromEnv returns the strict directive set in report-only mode', () => {
  const value = cspFromEnv();
  expect(value).not.toBe(false);
  if (value === false) throw new Error('unreachable');
  expect(value.reportOnly).toBe(true);
  expect(value.directives['default-src']).toEqual(["'self'"]);
  expect(value.directives['script-src']).not.toContain("'unsafe-inline'");
});

test('OSHAL_STRICT_CSP=off stays report-only; only the OSHAL_CSP=off kill switch returns false', () => {
  process.env.OSHAL_STRICT_CSP = 'off';
  const value = cspFromEnv();
  if (value === false) throw new Error('OSHAL_STRICT_CSP=off must not remove the report-only policy');
  expect(value.reportOnly).toBe(true);
  process.env.OSHAL_CSP = 'off';
  expect(cspFromEnv()).toBe(false);
});

test('flag on — returns a directive set with safe defaults', () => {
  process.env.OSHAL_STRICT_CSP = 'on';
  const value = cspFromEnv();
  expect(value).not.toBe(false);
  if (value === false) throw new Error('unreachable');
  expect(value.directives['default-src']).toEqual(["'self'"]);
  expect(value.directives['object-src']).toEqual(["'none'"]);
  // Without a nonce, inline scripts are NOT allowed (no 'unsafe-inline' on script-src).
  expect(value.directives['script-src']).not.toContain("'unsafe-inline'");
  expect(value.reportOnly).toBe(false);
});

test('report-only flag — sets reportOnly true without changing directives', () => {
  process.env.OSHAL_STRICT_CSP = 'on';
  process.env.OSHAL_CSP_REPORT_ONLY = 'on';
  const value = cspFromEnv();
  if (value === false) throw new Error('unreachable');
  expect(value.reportOnly).toBe(true);
  expect(value.directives['script-src']).toContain("'self'");
});

test('nonce mode — script-src carries the per-request nonce, not unsafe-inline', () => {
  const directives = buildStrictCsp({ nonce: 'abc123' });
  expect(directives['script-src']).toContain("'nonce-abc123'");
  expect(directives['script-src']).toContain("'strict-dynamic'");
  expect(directives['script-src']).not.toContain("'unsafe-inline'");
});

test('inline styles allowed by default (pragmatic), disabled when requested', () => {
  expect(buildStrictCsp()['style-src']).toContain("'unsafe-inline'");
  expect(buildStrictCsp({ allowInlineStyles: false })['style-src']).not.toContain("'unsafe-inline'");
});

test('report-uri wired from option', () => {
  const directives = buildStrictCsp({ reportUri: '/api/csp-report' });
  expect(directives['report-uri']).toEqual(['/api/csp-report']);
});
