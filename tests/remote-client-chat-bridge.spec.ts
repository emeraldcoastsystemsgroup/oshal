/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added coverage for the remote-client chat bridge: unit reply shaping + route round-trip + auth gating
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Control-plane URL fixtures follow PLAYWRIGHT_PORT via the shared apiOrigin() helper instead of hardcoded localhost:35457 literals (byte-identical under the default env)
 */

import { test, expect } from '@playwright/test';
import express from 'express';
import type { AddressInfo } from 'net';
import { runRemoteChatTurn, type RemoteChatOrchestrator } from '@/features/remote-client';
import { createRemoteClientRoutes } from '@/app/routes';
import { apiOrigin } from './helpers';

const SECRET = 'chat-bridge-test-secret';

/** Orchestrator stub that mirrors the prompt as the bot reply. */
const mirrorOrchestrator: RemoteChatOrchestrator = {
  async processMessage(_taskId, text) {
    return { success: true, response: `mirror:${text}` };
  },
};

/** Orchestrator stub that always throws to exercise the failure path. */
const throwingOrchestrator: RemoteChatOrchestrator = {
  async processMessage() {
    throw new Error('provider exploded');
  },
};

test.describe('remote-client chat bridge — unit', () => {
  test('shapes a successful turn into a chat.reply payload', async () => {
    const reply = await runRemoteChatTurn(mirrorOrchestrator, {
      clientId: 'client-unit',
      agentId: 'agent-x',
      taskId: 'task-unit',
      text: 'hello there',
      correlationId: 'corr-unit',
    });

    expect(reply.type).toBe('chat.reply');
    expect(reply.success).toBe(true);
    expect(reply.text).toBe('mirror:hello there');
    expect(reply.correlationId).toBe('corr-unit');
    expect(reply.taskId).toBe('task-unit');
  });

  test('captures orchestrator errors as a failed reply instead of throwing', async () => {
    const reply = await runRemoteChatTurn(throwingOrchestrator, {
      clientId: 'client-unit',
      agentId: 'agent-x',
      taskId: 'task-unit',
      text: 'boom',
      correlationId: 'corr-err',
    });

    expect(reply.success).toBe(false);
    expect(reply.text).toBe('');
    expect(reply.error).toContain('provider exploded');
  });
});

test.describe('remote-client chat bridge — route round-trip', () => {
  let baseUrl = '';
  let close: () => Promise<void> = async () => undefined;

  test.beforeAll(async () => {
    process.env.REMOTE_CLIENT_SHARED_SECRET = SECRET;
    const app = express();
    app.use(express.json());
    app.use('/api/remote-clients', createRemoteClientRoutes({ orchestrator: mirrorOrchestrator }));

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/remote-clients`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test.afterAll(async () => {
    await close();
  });

  /** Helper: authenticated JSON request against the mounted router. */
  const call = (path: string, method: string, body?: unknown, auth = true) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { 'x-remote-client-key': SECRET } : {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });

  test('rejects an unauthenticated chat turn', async () => {
    const res = await call('/some-client/chat', 'POST', { text: 'hi' }, false);
    expect(res.status).toBe(401);
  });

  test('delivers a bot reply over the swarm-message poll queue', async () => {
    const clientId = 'chat-client-1';
    const register = await call('/register', 'POST', {
      clientId,
      name: 'Chat Client 1',
      transport: 'headscale-http',
      controlPlaneUrl: apiOrigin(),
      capabilities: ['chat'],
    });
    expect(register.status).toBe(201);

    const accept = await call(`/${clientId}/chat`, 'POST', {
      text: 'what is up',
      taskId: 'conv-1',
      correlationId: 'corr-route-1',
    });
    expect(accept.status).toBe(202);
    const acceptBody = await accept.json();
    expect(acceptBody.accepted).toBe(true);
    expect(acceptBody.taskId).toBe('conv-1');
    expect(acceptBody.correlationId).toBe('corr-route-1');

    // The reply is delivered asynchronously onto the swarm-message queue.
    await expect.poll(async () => {
      const res = await call(`/${clientId}/swarm/next`, 'GET');
      if (res.status === 204) return null;
      const body = await res.json();
      return body?.message?.payload ?? null;
    }, { timeout: 5000, intervals: [100, 250, 500] }).toMatchObject({
      type: 'chat.reply',
      success: true,
      text: 'mirror:what is up',
      correlationId: 'corr-route-1',
    });
  });

  test('returns 503 when no chat bridge orchestrator is configured', async () => {
    const noBridge = express();
    noBridge.use(express.json());
    noBridge.use('/api/remote-clients', createRemoteClientRoutes({}));
    const server = noBridge.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;

    try {
      await fetch(`http://127.0.0.1:${port}/api/remote-clients/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
        body: JSON.stringify({ clientId: 'x', name: 'X', transport: 'http', controlPlaneUrl: apiOrigin() }),
      });
      const res = await fetch(`http://127.0.0.1:${port}/api/remote-clients/x/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-remote-client-key': SECRET },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(res.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
