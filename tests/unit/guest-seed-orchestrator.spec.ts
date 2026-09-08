/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the guest-seed orchestrator (guest-seed contract). The fan-out must: call ONLY apps that declare guestSeed, POST each hook on the loopback origin with the service secret + x-oshal-user-sub = the guest sub (the identity marriage), fence each app so one failure or timeout cannot abort the others or throw, and no-op (return []) when the secret or port is unavailable — a guest login must never be blocked or crashed by seeding.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SwarmAppManifest } from '../../src/features/swarm-apps';
import { guestSeedTargets, runGuestSeeds, type GuestSeedFetch } from '../../src/app/routes/guest-seed-orchestrator';

/** A minimal manifest with an optional guestSeed hook. */
function manifest(name: string, seedPath?: string): SwarmAppManifest {
  return { name, displayName: name, ...(seedPath ? { guestSeed: { path: seedPath } } : {}) } as SwarmAppManifest;
}

const SUB = 'guest-1c3c92e0-ec2b-44f8-ac1e-0b7da742c426';

describe('guestSeedTargets — only apps that declare a hook', () => {
  it('reduces active manifests to just the declared guest-seed hooks, in order', () => {
    const targets = guestSeedTargets([
      manifest('career-hunter', '/api/career-hunter/guest-seed'),
      manifest('jarvis'), // no hook
      manifest('finance', '/api/finance/guest-seed'),
    ]);
    expect(targets).toEqual([
      { name: 'career-hunter', path: '/api/career-hunter/guest-seed' },
      { name: 'finance', path: '/api/finance/guest-seed' },
    ]);
  });
});

describe('runGuestSeeds — calls each hook AS the guest, fenced', () => {
  it('POSTs every hook on the loopback origin with the service secret + guest sub', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; method: string }> = [];
    const fetchImpl: GuestSeedFetch = vi.fn(async (url, init) => {
      calls.push({ url, headers: init.headers, method: init.method });
      return { status: 200 };
    });
    const results = await runGuestSeeds({
      guestSub: SUB,
      port: 35457,
      manifests: [manifest('career-hunter', '/api/career-hunter/guest-seed'), manifest('finance', '/api/finance/guest-seed')],
      serviceSecret: 'top-secret',
      fetchImpl,
    });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:35457/api/career-hunter/guest-seed',
      'http://127.0.0.1:35457/api/finance/guest-seed',
    ]);
    for (const c of calls) {
      expect(c.method).toBe('POST');
      expect(c.headers['x-service-secret']).toBe('top-secret');
      expect(c.headers['x-oshal-user-sub']).toBe(SUB); // the identity marriage
    }
  });

  it('fences a failing/throwing hook — the others still run and it never throws', async () => {
    const fetchImpl: GuestSeedFetch = vi.fn(async (url) => {
      if (url.includes('/finance/')) throw new Error('finance down');
      if (url.includes('/broken/')) return { status: 500 };
      return { status: 204 };
    });
    const results = await runGuestSeeds({
      guestSub: SUB,
      port: 35457,
      manifests: [
        manifest('career-hunter', '/api/career-hunter/guest-seed'),
        manifest('finance', '/api/finance/guest-seed'),
        manifest('broken', '/api/broken/guest-seed'),
      ],
      serviceSecret: 's',
      fetchImpl,
    });
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName['career-hunter'].ok).toBe(true);
    expect(byName['finance'].ok).toBe(false); // threw
    expect(byName['broken'].ok).toBe(false); // non-2xx
    expect(byName['broken'].httpStatus).toBe(500);
  });

  it('no-ops (returns []) when the service secret is missing — login is never blocked', async () => {
    const fetchImpl = vi.fn();
    const results = await runGuestSeeds({
      guestSub: SUB,
      port: 35457,
      manifests: [manifest('career-hunter', '/api/career-hunter/guest-seed')],
      serviceSecret: '',
      fetchImpl: fetchImpl as unknown as GuestSeedFetch,
    });
    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops when the loopback port is unavailable', async () => {
    const fetchImpl = vi.fn();
    const results = await runGuestSeeds({
      guestSub: SUB,
      port: undefined,
      manifests: [manifest('career-hunter', '/api/career-hunter/guest-seed')],
      serviceSecret: 's',
      fetchImpl: fetchImpl as unknown as GuestSeedFetch,
    });
    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops when no installed app declares a hook (the common case)', async () => {
    const fetchImpl = vi.fn();
    const results = await runGuestSeeds({
      guestSub: SUB,
      port: 35457,
      manifests: [manifest('jarvis'), manifest('travel')],
      serviceSecret: 's',
      fetchImpl: fetchImpl as unknown as GuestSeedFetch,
    });
    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
