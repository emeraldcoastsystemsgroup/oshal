/**
 * Strict-CSP hardening tests (additive, off-by-default).
 *
 * Proves:
 *  - flag OFF (default): cspFromEnv() returns `false` (helmet CSP stays disabled,
 *    today's behavior unchanged);
 *  - flag ON: a directive set is returned, inline scripts blocked unless nonced;
 *  - nonce mode: 'nonce-...' appears in script-src;
 *  - report-only flag toggles reportOnly without changing the directives.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — unit tests for opt-in strict CSP builder.
 */
import { test, expect } from '@playwright/test';
import { buildStrictCsp, cspFromEnv } from '@/features/security/hardening/strict-csp';

test.beforeEach(() => {
  delete process.env.OSHAL_STRICT_CSP;
  delete process.env.OSHAL_CSP_REPORT_ONLY;
  delete process.env.OSHAL_CSP_REPORT_URI;
});

test('off by default — cspFromEnv returns false (helmet CSP stays disabled)', () => {
  expect(cspFromEnv()).toBe(false);
});

test('off by default — explicit "off" also returns false', () => {
  process.env.OSHAL_STRICT_CSP = 'off';
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
