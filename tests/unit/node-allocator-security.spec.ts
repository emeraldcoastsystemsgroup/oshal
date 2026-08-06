/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove allocator control calls carry machine authentication and poisoned Redis endpoints cannot receive credential-bearing assignment payloads.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove unknown assignment/release outcomes quarantine a node instead of making credential residue eligible for reassignment.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prove partial Redis active-map and release-cleanup residue cannot bypass quarantine or restore idle reuse authority.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: prove allocator requests contain non-secret assignment metadata and legacy credential carriers fail before reservation/network activity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeConfiguredNodeEndpoint,
  normalizeRegisteredNodeEndpoint,
  requireSafeNodeId,
} from '@/features/agent-management/services/node-pool-endpoint';

const mocks = vi.hoisted(() => ({
  redis: {
    on: vi.fn(),
    hget: vi.fn(),
    spop: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    sadd: vi.fn(),
    srem: vi.fn(),
    hset: vi.fn(),
    hdel: vi.fn(),
    lpush: vi.fn(),
    ltrim: vi.fn(),
    del: vi.fn(),
    smembers: vi.fn(),
    sismember: vi.fn(),
    hgetall: vi.fn(),
    disconnect: vi.fn(),
  },
}));

vi.mock('ioredis', () => ({
  default: vi.fn(function RedisMock() { return mocks.redis; }),
}));

import { NodeAllocatorService } from '@/features/agent-management/services/node-allocator-service';

const assignment = {
  agentId: 'agent-1',
  personaFile: '/app/ai-lab/bot-personas/worker.yaml',
  agent: 'cline',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SWARM_SERVICE_SECRET', 'node-control-secret');
  delete process.env.NODE_POOL_ALLOWED_HOSTS;
  mocks.redis.hget.mockResolvedValue(null);
  mocks.redis.spop.mockResolvedValue('node-1');
  mocks.redis.get.mockResolvedValue(null);
  for (const method of ['set', 'sadd', 'srem', 'hset', 'hdel', 'lpush', 'ltrim', 'del'] as const) {
    mocks.redis[method].mockResolvedValue(1);
  }
  mocks.redis.smembers.mockResolvedValue([]);
  mocks.redis.sismember.mockResolvedValue(0);
  mocks.redis.hgetall.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('node allocator authenticated assignment', () => {
  it('sends the configured service secret with non-secret assignment metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    const allocator = new NodeAllocatorService({ nodeEndpoints: { 'node-1': 'http://node-1:5000' } });
    await allocator.assignNode(assignment);
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Service-Secret': 'node-control-secret',
    });
    expect(JSON.parse(String(options.body))).toEqual(assignment);
    expect(String(options.body)).not.toMatch(/api[_-]?key|access[_-]?token|secret/i);
  });

  it('rejects a legacy credential carrier before reserving a node or making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const allocator = new NodeAllocatorService({ nodeEndpoints: { 'node-1': 'http://node-1:5000' } });
    const legacyAssignment = {
      ...assignment,
      credentials: { ANTHROPIC_API_KEY: 'must-not-leave-controller' },
    };
    await expect(allocator.assignNode(legacyAssignment)).rejects.toThrow(
      'credential fields are not accepted on node assignments',
    );
    expect(mocks.redis.spop).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a registry-poisoned endpoint before making the privileged request', async () => {
    mocks.redis.get.mockResolvedValue('http://169.254.169.254');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const allocator = new NodeAllocatorService();
    await expect(allocator.assignNode(assignment)).rejects.toThrow('Untrusted node endpoint host');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('node allocator fail-safe lifecycle', () => {
  it('returns only the persisted active assignment after all registry fences agree', async () => {
    mocks.redis.hget.mockResolvedValue('node-1');
    mocks.redis.get.mockImplementation(async (key: string) => {
      if (key.endsWith(':status')) return 'active';
      if (key.endsWith(':assignment')) {
        return JSON.stringify({
          nodeId: 'node-1', agentId: 'agent-1', agent: 'cline', model: 'persisted-model',
          provider: 'anthropic', assignedAt: '2026-08-05T12:00:00.000Z',
        });
      }
      return null;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const allocator = new NodeAllocatorService({ nodeEndpoints: { 'node-1': 'http://node-1:5000' } });

    const result = await allocator.assignNode({ ...assignment, model: 'caller-retry-model' });

    expect(result.model).toBe('persisted-model');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.redis.spop).not.toHaveBeenCalled();
  });

  it('refuses a stale active mapping instead of bypassing node quarantine', async () => {
    mocks.redis.hget.mockResolvedValue('node-1');
    mocks.redis.get.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const allocator = new NodeAllocatorService({ nodeEndpoints: { 'node-1': 'http://node-1:5000' } });

    await expect(allocator.assignNode(assignment)).rejects.toThrow('uncertain quarantined node assignment');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.redis.spop).not.toHaveBeenCalled();
    expect(mocks.redis.set).toHaveBeenCalledWith('node:pool:node-1:status', 'quarantined');
  });

  it('quarantines an assignment whose outcome is unknown instead of returning it idle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection reset')));
    const allocator = new NodeAllocatorService({ nodeEndpoints: { 'node-1': 'http://node-1:5000' } });
    await expect(allocator.assignNode(assignment)).rejects.toThrow('connection reset');
    expect(mocks.redis.set).toHaveBeenCalledWith('node:pool:node-1:status', 'quarantined');
    expect(mocks.redis.sadd).toHaveBeenCalledWith('node:pool:quarantined', 'node-1');
    expect(mocks.redis.sadd).not.toHaveBeenCalledWith('node:pool:idle', 'node-1');
  });

  it('keeps assignment metadata and quarantines a release that is not acknowledged', async () => {
    mocks.redis.get.mockImplementation(async (key: string) => key.endsWith(':assignment')
      ? JSON.stringify({ agentId: 'agent-1' })
      : null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }));
    const allocator = new NodeAllocatorService({ nodeEndpoints: { 'node-1': 'http://node-1:5000' } });
    await expect(allocator.releaseNode('node-1')).rejects.toThrow('rejected release: 401');
    expect(mocks.redis.set).toHaveBeenCalledWith('node:pool:node-1:status', 'quarantined');
    expect(mocks.redis.del).not.toHaveBeenCalledWith('node:pool:node-1:assignment');
    expect(mocks.redis.hdel).not.toHaveBeenCalledWith('node:pool:active', 'agent-1');
    expect(mocks.redis.sadd).not.toHaveBeenCalledWith('node:pool:idle', 'node-1');
  });

  it('returns a node idle only after an authenticated release acknowledgement', async () => {
    mocks.redis.get.mockResolvedValue(JSON.stringify({ agentId: 'agent-1' }));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    const allocator = new NodeAllocatorService({ nodeEndpoints: { 'node-1': 'http://node-1:5000' } });
    await allocator.releaseNode('node-1');
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      'X-Service-Secret': 'node-control-secret',
    });
    expect(mocks.redis.hdel).toHaveBeenCalledWith('node:pool:active', 'agent-1');
    expect(mocks.redis.sadd).toHaveBeenLastCalledWith('node:pool:idle', 'node-1');
  });

  it('quarantines a positively released node when Redis cleanup is incomplete', async () => {
    mocks.redis.get.mockResolvedValue(JSON.stringify({ agentId: 'agent-1' }));
    mocks.redis.del.mockRejectedValueOnce(new Error('redis cleanup failed'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }));
    const allocator = new NodeAllocatorService({ nodeEndpoints: { 'node-1': 'http://node-1:5000' } });

    await expect(allocator.releaseNode('node-1')).rejects.toThrow('redis cleanup failed');

    expect(mocks.redis.set).toHaveBeenCalledWith('node:pool:node-1:status', 'quarantined');
    expect(mocks.redis.sadd).not.toHaveBeenCalledWith('node:pool:idle', 'node-1');
  });

  it('clears every stale active mapping before restart registration restores idle', async () => {
    mocks.redis.hgetall.mockResolvedValue({ 'agent-1': 'node-1', 'agent-2': 'node-2' });
    const allocator = new NodeAllocatorService();

    await allocator.registerNode('node-1', 'http://node-1:5000');

    expect(mocks.redis.del).toHaveBeenCalledWith('node:pool:node-1:assignment');
    expect(mocks.redis.hdel).toHaveBeenCalledWith('node:pool:active', 'agent-1');
    expect(mocks.redis.hdel).not.toHaveBeenCalledWith('node:pool:active', 'agent-2');
    expect(mocks.redis.sadd).toHaveBeenLastCalledWith('node:pool:idle', 'node-1');
  });
});

describe('node endpoint trust boundary', () => {
  it('rejects Redis key injection and prototype sentinel node ids', () => {
    expect(() => requireSafeNodeId('node-1:status')).toThrow('Invalid node id');
    expect(() => requireSafeNodeId('__proto__')).toThrow('Invalid node id');
    expect(() => requireSafeNodeId('constructor')).toThrow('Invalid node id');
    expect(requireSafeNodeId('node-1')).toBe('node-1');
  });

  it('allows an operator-configured origin but still rejects dangerous URL forms', () => {
    expect(normalizeConfiguredNodeEndpoint('node-1', 'https://pool.example:8443/')).toBe('https://pool.example:8443');
    expect(() => normalizeConfiguredNodeEndpoint('node-1', 'file:///etc/passwd')).toThrow();
    expect(() => normalizeConfiguredNodeEndpoint('node-1', 'http://user:pass@node-1')).toThrow();
    expect(() => normalizeConfiguredNodeEndpoint('node-1', 'http://node-1/admin')).toThrow();
  });

  it('requires registry endpoints to match node DNS or the explicit host allowlist', () => {
    expect(normalizeRegisteredNodeEndpoint('node-1', 'http://node-1:5000')).toBe('http://node-1:5000');
    expect(() => normalizeRegisteredNodeEndpoint('node-1', 'http://metadata.internal')).toThrow();
    process.env.NODE_POOL_ALLOWED_HOSTS = 'pool.internal.example';
    expect(normalizeRegisteredNodeEndpoint('node-1', 'https://pool.internal.example')).toBe('https://pool.internal.example');
  });
});
