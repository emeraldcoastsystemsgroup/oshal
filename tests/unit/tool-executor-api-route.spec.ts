import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { StreamManager } from '../../src/features/streaming';
import { ToolExecutorService } from '../../src/features/chat-orchestration/services/tool-executor-service';
import { DynamicToolExecutorRegistry } from '../../src/features/tool-registry';

describe('ToolExecutorService route-backed API tools', () => {
  const previousBase = process.env.OSHAL_INTERNAL_API_BASE_URL;
  const previousSecret = process.env.SWARM_SERVICE_SECRET;

  afterEach(() => {
    if (previousBase === undefined) delete process.env.OSHAL_INTERNAL_API_BASE_URL;
    else process.env.OSHAL_INTERNAL_API_BASE_URL = previousBase;
    if (previousSecret === undefined) delete process.env.SWARM_SERVICE_SECRET;
    else process.env.SWARM_SERVICE_SECRET = previousSecret;
  });

  it('resolves relative method-prefixed endpoints and stamps trusted user headers', async () => {
    const seen: Array<{
      method?: string;
      url?: string;
      serviceSecret?: string | string[];
      userSub?: string | string[];
      body: string;
    }> = [];

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          serviceSecret: req.headers['x-service-secret'],
          userSub: req.headers['x-oshal-user-sub'],
          body,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url: req.url }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    process.env.OSHAL_INTERNAL_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.SWARM_SERVICE_SECRET = 'unit-service-secret';

    const registry = new DynamicToolExecutorRegistry();
    registry.register({
      toolName: 'route-backed-search',
      executorType: 'api',
      apiEndpoint: 'GET /api/test/search?q={input.query}',
      runtimeRegistered: true,
      registeredAt: new Date().toISOString(),
    });

    try {
      const executor = new ToolExecutorService({
        streamManager: new StreamManager(),
        dynamicToolExecutorRegistry: registry,
      });

      const result = await executor.executeTool(
        'task-route-api',
        'route-backed-search',
        { query: 'milk and bread' },
        'agent-route-api',
        'user-sub-123',
      );

      expect(result).toContain('"ok":true');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        method: 'GET',
        url: '/api/test/search?q=milk%20and%20bread',
        serviceSecret: 'unit-service-secret',
        userSub: 'user-sub-123',
        body: '',
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
