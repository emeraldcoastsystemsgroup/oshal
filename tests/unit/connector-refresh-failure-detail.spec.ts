/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A failed token refresh says why. On the DGX Spark move (2026-10-05) Schwab's lapsed 7-day login reached the futures capture as a bare "refresh 400", which the capture then swallowed into a generic failure. The refresh error now carries the provider and its OAuth error code and description (never a token), the connection health check still maps it to needs_reconnect, and the capture logs and returns the reason.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/app/routes/connectors-routes', () => ({
  getValidAccessToken: vi.fn(async () => { throw new Error('schwab refresh 400 invalid_grant: Refresh token expired'); }),
}));

import { describeRefreshFailure } from '@/app/routes/connector-account-operations';
import { dispatchSchwabFuturesCapture, schwabFuturesCaptureTaskType } from '@/app/trading-futures-schwab-capture';

afterEach(() => { vi.clearAllMocks(); });

describe('a failed token refresh names its reason', () => {
  it('carries the provider and the OAuth error code and description', () => {
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token expired' });
    expect(describeRefreshFailure('schwab', 400, body)).toBe('schwab refresh 400 invalid_grant: Refresh token expired');
  });

  it('reports the status alone for a body that is not an OAuth error', () => {
    expect(describeRefreshFailure('schwab', 502, '<html>Bad gateway</html>')).toBe('schwab refresh 502');
  });

  it('never echoes token fields and caps what it does echo', () => {
    const body = JSON.stringify({ error: 'invalid_grant', error_description: 'x'.repeat(500), access_token: 'placeholder-access-value', refresh_token: 'placeholder-refresh-value' });
    const message = describeRefreshFailure('schwab', 400, body);
    expect(message).not.toMatch(/placeholder-access-value|placeholder-refresh-value/);
    expect(message.length).toBeLessThan(260);
  });

  it('still reads as a rejected grant to the connection health check', () => {
    // connector-liveness.ts maps /refresh 4\d\d/ to needs_reconnect.
    expect(/refresh 4\d\d/.test(describeRefreshFailure('schwab', 400, '{"error":"invalid_grant"}'))).toBe(true);
  });
});

describe('the Schwab futures capture reports why it failed', () => {
  it('returns the refresh reason instead of a generic failure', async () => {
    const sub = 'fixture-owner';
    const result = await dispatchSchwabFuturesCapture({ pool: {} } as never, {
      id: 'schedule-1', ownerSub: sub, taskType: schwabFuturesCaptureTaskType(sub), taskData: { roots: ['ES'] },
    } as never);
    expect(result.success).toBe(false);
    expect(result.error).toContain('schwab refresh 400 invalid_grant');
  });
});
