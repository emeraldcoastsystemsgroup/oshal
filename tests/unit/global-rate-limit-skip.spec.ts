import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { shouldSkipGlobalRateLimit } from '../../src/features/security/hardening/global-rate-limit-skip';

function req(method: string, originalUrl: string, xff = '203.0.113.10'): Request {
  return {
    method,
    originalUrl,
    url: originalUrl,
    path: originalUrl.split('?')[0],
    headers: xff ? { 'x-forwarded-for': xff } : {},
  } as unknown as Request;
}

describe('global rate-limit skip policy', () => {
  it('keeps the existing no-XFF internal/localhost skip', () => {
    expect(shouldSkipGlobalRateLimit(req('GET', '/api/jarvis/ask/result?jobId=1', ''))).toBe(true);
  });

  it('skips read-only Cockpit static and Jarvis shell loads so the UI does not brick under polling', () => {
    expect(shouldSkipGlobalRateLimit(req('GET', '/cockpit/js/app.js'))).toBe(true);
    expect(shouldSkipGlobalRateLimit(req('GET', '/api/jarvis?v=123'))).toBe(true);
    expect(shouldSkipGlobalRateLimit(req('HEAD', '/api/jarvis/ui'))).toBe(true);
  });

  it('does not skip Jarvis work-spawning or data API calls', () => {
    expect(shouldSkipGlobalRateLimit(req('POST', '/api/jarvis/ask'))).toBe(false);
    expect(shouldSkipGlobalRateLimit(req('GET', '/api/jarvis/history?sessionId=jarvis-u1'))).toBe(false);
    expect(shouldSkipGlobalRateLimit(req('GET', '/api/connectors/marketplace'))).toBe(false);
  });
});

