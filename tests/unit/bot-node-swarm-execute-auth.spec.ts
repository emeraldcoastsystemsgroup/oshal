/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Security-audit: proves the bot-node privileged endpoints (/api/swarm-execute, /api/token-chase/replay-call) enforce SWARM_SERVICE_SECRET when it is set (401 on missing/wrong X-Service-Secret, pass on correct) and are a NO-OP (fail-open, existing dispatch unaffected) when it is unset. Drives the real Express handler + the shared hasValidServiceSecret helper.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Loud fail-open posture: fail-open allows now WARN per request (backlog item named) and logBotNodeAuthPosture() WARNs at startup when the secret is unset / INFOs when set — asserted via a mocked @/shared/logger. New authorizeBotNodeInternalCall (mounted on /api/token-chase/replay-call) covered: warned fail-open when unconfigured, 401 on missing/wrong secret when configured, pass on correct.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Pin property-presence fail-closed handling so empty, whitespace, null, object, and otherwise malformed userSub assertions cannot enter the anonymous no-secret posture in either runtime.
 */

import express from 'express';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the bot-node gate's logger so the loud fail-open posture is assertable:
// every unauthenticated allow must WARN, and the startup posture log must fire.
const logSpies = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
}));

// The REAL middleware bot-node-server.ts mounts — tested directly, so there is no policy
// copy to drift. authorizeBotNodeInternalCall is what authorizeBotNodeCall aliases.
import {
  authorizeBotNodeExecutionCall as authorizeBotNodeCall,
  authorizeBotNodeInternalCall,
  logBotNodeAuthPosture,
} from '../../src/app/bot-node-request-auth';

const requireModule = createRequire(import.meta.url);
const { authorizeSwarmExecute: authorizeAnyBotCall } = requireModule(
  '../../any-bot/server/services/codebase/swarm-execute-auth.js',
) as { authorizeSwarmExecute: typeof authorizeBotNodeCall };

const SECRET = 'bot-node-test-secret';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.SWARM_SERVICE_SECRET;
  delete process.env.SWARM_SERVICE_SECRET;
  logSpies.warn.mockClear();
  logSpies.info.mockClear();
});
afterEach(() => { if (saved === undefined) delete process.env.SWARM_SERVICE_SECRET; else process.env.SWARM_SERVICE_SECRET = saved; });

describe('bot-node /api/swarm-execute shared-secret gate', () => {
  const servers: Array<{ close: (cb: () => void) => void }> = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(r))));
    servers.length = 0;
  });

  async function boot(middleware = authorizeBotNodeCall): Promise<string> {
    const app = express();
    app.use(express.json());
    app.post('/api/swarm-execute', middleware, (_req, res) => res.json({ success: true }));
    const server = app.listen(0);
    servers.push(server);
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    return `http://127.0.0.1:${addr.port}/api/swarm-execute`;
  }

  const post = (url: string, headers: Record<string, string> = {}, body: Record<string, unknown> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('is fail-open when SWARM_SERVICE_SECRET is unset (dispatch unaffected) but WARNs per allowed request', async () => {
    const url = await boot();
    expect((await post(url)).status).toBe(200);                                   // no header
    expect((await post(url, { 'x-service-secret': 'anything' })).status).toBe(200); // stray header ignored
    // Loud posture: each unauthenticated allow logs a WARN naming the backlog item.
    expect(logSpies.warn).toHaveBeenCalledTimes(2);
    const [meta, message] = logSpies.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(String(meta.backlogItem)).toContain('security audit 2026-06-16');
    expect(message).toContain('SWARM_SERVICE_SECRET is unset');
  });

  it('401s a missing or wrong secret once SWARM_SERVICE_SECRET is set', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    const url = await boot();
    expect((await post(url)).status).toBe(401);
    expect((await post(url, { 'x-service-secret': 'nope' })).status).toBe(401);
    expect((await post(url, { 'x-service-secret': 'nope' }, {
      byoLlmConnection: { baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'model' },
    })).status).toBe(401);
  });

  it('fails closed for identity or credential-bearing work when no secret is configured', async () => {
    const url = await boot();
    for (const userSub of ['owner-123', '', '   ', null, { sub: 'owner-123' }]) {
      expect((await post(url, {}, { userSub })).status, JSON.stringify(userSub)).toBe(401);
    }
    expect((await post(url, {}, { creds: { OSHAL_CRED_GOOGLE: 'token' } })).status).toBe(401);
    expect((await post(url, {}, {
      byoLlmConnection: { baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'model' },
    })).status).toBe(401);
    expect((await post(url, {}, {
      providerIntent: { schemaVersion: 1, kind: 'weather', operation: 'current-forecast', location: 'Chicago, IL' },
    })).status).toBe(401);
  });

  it('passes the correct secret once configured (controller traffic)', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    const url = await boot();
    expect((await post(url, { 'x-service-secret': SECRET })).status).toBe(200);
    expect((await post(
      url,
      { 'x-service-secret': SECRET },
      { userSub: 'owner-123', creds: { OSHAL_CRED_GOOGLE: 'token' } },
    )).status).toBe(200);
  });

  it('rejects a length-mismatched secret without throwing (constant-time compare guard)', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    const url = await boot();
    expect((await post(url, { 'x-service-secret': SECRET + 'x' })).status).toBe(401);
    expect((await post(url, { 'x-service-secret': '' })).status).toBe(401);
  });

  it('applies the same fail-closed sensitive-payload policy on the canonical any-bot runtime', async () => {
    const url = await boot(authorizeAnyBotCall);
    expect((await post(url)).status).toBe(200);
    for (const userSub of ['', '   ', null, { sub: 'owner-123' }]) {
      expect((await post(url, {}, { userSub })).status, JSON.stringify(userSub)).toBe(401);
    }
    expect((await post(url, {}, {
      byoLlmConnection: { baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'model' },
    })).status).toBe(401);
    expect((await post(url, {}, {
      providerIntent: { schemaVersion: 1, kind: 'priority-email', operation: 'priority-summary' },
    })).status).toBe(401);
    process.env.SWARM_SERVICE_SECRET = SECRET;
    expect((await post(url, {}, { userSub: 'owner-123' })).status).toBe(401);
    expect((await post(url, { 'x-service-secret': 'wrong' }, {
      byoLlmConnection: { baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'model' },
    })).status).toBe(401);
    expect((await post(url, { 'x-service-secret': SECRET }, { userSub: 'owner-123' })).status).toBe(200);
  });

  it('does not WARN once the secret is configured and presented (fail-closed steady state)', async () => {
    process.env.SWARM_SERVICE_SECRET = SECRET;
    const url = await boot();
    expect((await post(url, { 'x-service-secret': SECRET })).status).toBe(200);
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  describe('authorizeBotNodeInternalCall (sibling execution endpoints, e.g. /api/token-chase/replay-call)', () => {
    it('allows with a per-request WARN when SWARM_SERVICE_SECRET is unset', async () => {
      const url = await boot(authorizeBotNodeInternalCall);
      expect((await post(url)).status).toBe(200);
      expect(logSpies.warn).toHaveBeenCalledTimes(1);
      const [meta] = logSpies.warn.mock.calls[0] as [Record<string, unknown>];
      expect(String(meta.backlogItem)).toContain('security audit 2026-06-16');
    });

    it('401s a missing or wrong secret once configured, passes the correct one', async () => {
      process.env.SWARM_SERVICE_SECRET = SECRET;
      const url = await boot(authorizeBotNodeInternalCall);
      expect((await post(url)).status).toBe(401);
      expect((await post(url, { 'x-service-secret': 'nope' })).status).toBe(401);
      expect((await post(url, { 'x-service-secret': SECRET })).status).toBe(200);
      expect(logSpies.warn).not.toHaveBeenCalled();
    });
  });

  describe('logBotNodeAuthPosture (startup log)', () => {
    it('WARNs loudly (backlog item named) when the secret is unconfigured', () => {
      logBotNodeAuthPosture();
      expect(logSpies.warn).toHaveBeenCalledTimes(1);
      const [meta, message] = logSpies.warn.mock.calls[0] as [Record<string, unknown>, string];
      expect(String(meta.backlogItem)).toContain('Bot-node /api/swarm-execute');
      expect(message).toContain('SWARM_SERVICE_SECRET is NOT set');
    });

    it('logs INFO fail-closed when the secret is configured', () => {
      process.env.SWARM_SERVICE_SECRET = SECRET;
      logBotNodeAuthPosture();
      expect(logSpies.warn).not.toHaveBeenCalled();
      expect(logSpies.info).toHaveBeenCalledTimes(1);
      expect(String(logSpies.info.mock.calls[0][0])).toContain('FAIL-CLOSED');
    });
  });
});
