/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added live remote-client E2E with a real stdio MCP child process and control-plane shim
 */

import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { RemoteClientService, type RemoteClientConfig } from '@/features/remote-client';

interface CapturedControlPlaneState {
  completed: Array<Record<string, any>>;
  failed: Array<Record<string, any>>;
  heartbeats: Array<Record<string, any>>;
  registrations: Array<Record<string, any>>;
  swarmMessages: Array<Record<string, any>>;
}

test.describe('remote-client live MCP E2E', () => {
  test('executes a queued MCP tool task through a real stdio child process', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-remote-live-mcp-'));
    const mcpServerPath = path.join(workspace, 'fake-mcp-server.cjs');
    fs.writeFileSync(mcpServerPath, buildFakeMcpServer(), 'utf8');

    const state: CapturedControlPlaneState = {
      completed: [],
      failed: [],
      heartbeats: [],
      registrations: [],
      swarmMessages: [],
    };
    const taskQueue = [{
      taskId: 'remote-live-task-1',
      correlationId: 'remote-live-corr-1',
      fromAgentId: 'project-manager',
      toAgentId: 'remote-live-agent',
      intent: 'mcp.call-tool',
      input: {
        toolName: 'mirror.remote',
        arguments: { message: 'live remote MCP works' },
      },
      artifacts: [],
      createdAt: new Date().toISOString(),
      status: 'queued',
    }];

    const controlPlane = await startControlPlaneShim({
      expectedToken: 'remote-live-secret',
      state,
      taskQueue,
    });

    const config: RemoteClientConfig = {
      clientId: 'remote-live-client',
      clientName: 'Remote Live Client',
      controlPlaneUrl: controlPlane.url,
      controlPlaneToken: 'remote-live-secret',
      platform: 'linux',
      transport: 'stdio',
      agentId: 'remote-live-agent',
      mcpCommand: process.execPath,
      mcpArgs: [mcpServerPath],
      heartbeatIntervalMs: 5_000,
      pollIntervalMs: 250,
      disablePolling: false,
      authHeaderName: 'x-remote-client-key',
    };

    const service = new RemoteClientService(config);

    try {
      await service.start();

      const completed = await waitForValue(() => state.completed[0], 'remote MCP task completion');
      expect(completed.status).toBe('completed');
      expect(completed.taskId).toBe('remote-live-task-1');
      expect(completed.clientId).toBe('remote-live-client');
      expect(completed.output.structuredContent.mirrored).toBe('live remote MCP works');
      expect(completed.output.content[0].text).toBe('remote-mirror: live remote MCP works');

      expect(state.failed).toHaveLength(0);
      expect(state.registrations).toHaveLength(1);
      expect(state.registrations[0].capabilities).toContain('mirror.remote');
      expect(state.heartbeats.some((heartbeat) => heartbeat.mcpReady === true && heartbeat.toolCount === 1)).toBeTruthy();
      expect(state.swarmMessages.some((message) => message.payload?.type === 'remote-client.presence')).toBeTruthy();
    } finally {
      await service.stop().catch(() => undefined);
      await controlPlane.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function buildFakeMcpServer(): string {
  return String.raw`
const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  if (request.method === 'notifications/initialized') {
    return;
  }

  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'fake-oshal-mcp', version: '1.0.0-test' },
      capabilities: { tools: {} },
    });
    return;
  }

  if (request.method === 'tools/list') {
    respond(request.id, {
      tools: [{
        name: 'mirror.remote',
        description: 'Mirrors a message from a fake remote MCP server.',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      }],
    });
    return;
  }

  if (request.method === 'tools/call') {
    const name = request.params && request.params.name;
    const args = request.params && request.params.arguments ? request.params.arguments : {};
    if (name !== 'mirror.remote') {
      respondError(request.id, -32602, 'Unknown tool: ' + name);
      return;
    }
    respond(request.id, {
      content: [{ type: 'text', text: 'remote-mirror: ' + args.message }],
      structuredContent: { mirrored: args.message },
    });
    return;
  }

  if (request.method === 'shutdown') {
    respond(request.id, {});
    return;
  }

  respondError(request.id, -32601, 'Unknown method: ' + request.method);
});

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}
`;
}

async function startControlPlaneShim(options: {
  expectedToken: string;
  state: CapturedControlPlaneState;
  taskQueue: Array<Record<string, any>>;
}): Promise<{ close: () => Promise<void>; url: string }> {
  const server = http.createServer((req, res) => {
    void handleControlPlaneRequest(req, res, options);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Control-plane shim did not bind to a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function handleControlPlaneRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    expectedToken: string;
    state: CapturedControlPlaneState;
    taskQueue: Array<Record<string, any>>;
  },
): Promise<void> {
  const url = req.url ?? '';
  const token = req.headers['x-remote-client-key'];
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (token !== options.expectedToken || bearer !== options.expectedToken) {
    writeJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (req.method === 'POST' && url === '/api/remote-clients/register') {
    const body = await readJson(req);
    options.state.registrations.push(body);
    const now = new Date().toISOString();
    writeJson(res, 201, {
      client: {
        ...body,
        status: 'online',
        healthy: true,
        lastSeenAt: now,
        taskQueueDepth: options.taskQueue.length,
        registeredAt: now,
        lastHeartbeatAt: now,
        heartbeatCount: 0,
        mcpToolCount: Array.isArray(body.capabilities) ? body.capabilities.length : 0,
      },
      registeredAt: now,
    });
    return;
  }

  if (req.method === 'POST' && /^\/api\/remote-clients\/[^/]+\/heartbeat$/.test(url)) {
    const body = await readJson(req);
    options.state.heartbeats.push(body);
    const now = new Date().toISOString();
    writeJson(res, 200, {
      client: {
        clientId: body.clientId,
        agentId: body.agentId,
        name: 'Remote Live Client',
        transport: 'stdio',
        platform: 'linux',
        controlPlaneUrl: `http://${req.headers.host}`,
        capabilities: ['mirror.remote'],
        tags: ['remote-client', 'mcp', 'linux'],
        status: body.status,
        healthy: body.status !== 'offline',
        lastSeenAt: body.lastSeenAt,
        taskQueueDepth: options.taskQueue.length,
        registeredAt: now,
        lastHeartbeatAt: now,
        heartbeatCount: options.state.heartbeats.length,
        mcpToolCount: body.toolCount ?? 0,
      },
      acceptedAt: now,
    });
    return;
  }

  if (req.method === 'GET' && /^\/api\/remote-clients\/[^/]+\/tasks\/next$/.test(url)) {
    const task = options.taskQueue.shift();
    if (!task) {
      res.writeHead(204);
      res.end();
      return;
    }
    writeJson(res, 200, { claimed: true, task });
    return;
  }

  if (req.method === 'POST' && /^\/api\/remote-clients\/[^/]+\/tasks\/[^/]+\/complete$/.test(url)) {
    const body = await readJson(req);
    options.state.completed.push(body);
    writeJson(res, 200, body);
    return;
  }

  if (req.method === 'POST' && /^\/api\/remote-clients\/[^/]+\/tasks\/[^/]+\/fail$/.test(url)) {
    const body = await readJson(req);
    options.state.failed.push(body);
    writeJson(res, 200, body);
    return;
  }

  if (req.method === 'POST' && /^\/api\/remote-clients\/[^/]+\/swarm\/send$/.test(url)) {
    const body = await readJson(req);
    options.state.swarmMessages.push(body);
    writeJson(res, 200, {
      accepted: true,
      correlationId: body.correlationId ?? `shim-${options.state.swarmMessages.length}`,
    });
    return;
  }

  writeJson(res, 404, { error: `Unhandled shim route: ${req.method} ${url}` });
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? JSON.parse(raw) : {};
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function waitForValue<T>(read: () => T | undefined, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out`);
}
