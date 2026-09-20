/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The contract that makes DisposableRedis worth having, proven by behaviour rather than by reading its source: two fixtures are two SEPARATE servers (a key written to one is invisible to the other, on different ports), the container is really gone after stop() so nothing survives the spec that started it, stop() is safe on a fixture that was never started, and the address is invented at start() rather than inherited - a run with OSHAL_REDIS_PORT and OSHAL_TEST_REDIS_URL both pointing somewhere else still lands on the fixture's own port. That last case is the one that matters: the defect this helper exists to close was a spec resolving OSHAL_REDIS_PORT and writing to the running swarm's scheduler store, so a helper that quietly honoured the same variable would reintroduce it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import Redis from 'ioredis';
import { DisposableRedis } from '../helpers/disposable-redis';

const started: DisposableRedis[] = [];
const track = (fixture: DisposableRedis): DisposableRedis => { started.push(fixture); return fixture; };

/** Whether Docker still knows this container at all — `--rm` plus `rm --force` should leave nothing. */
function containerExists(name: string): boolean {
  const out = execFileSync('docker', ['ps', '--all', '--filter', `name=^${name}$`, '--format', '{{.Names}}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  return out.trim().split(/\r?\n/).filter(Boolean).includes(name);
}

afterEach(async () => { while (started.length) await started.pop()!.stop(); });

describe('DisposableRedis — a server the spec owns, not one it found', () => {
  it('two fixtures are two separate servers: different ports, and neither can see the other\'s keys', async () => {
    const a = track(new DisposableRedis({ purpose: 'iso-a' }));
    const b = track(new DisposableRedis({ purpose: 'iso-b' }));
    const [ca, cb] = [await a.start(), await b.start()];
    expect(ca.port).not.toBe(cb.port);
    expect(a.containerName).not.toBe(b.containerName);

    const clientA = new Redis(a.url, { maxRetriesPerRequest: 1 });
    const clientB = new Redis(b.url, { maxRetriesPerRequest: 1 });
    try {
      await clientA.set('only-in-a', '1');
      expect(await clientA.get('only-in-a')).toBe('1');
      expect(await clientB.get('only-in-a')).toBeNull();   // a shared server would answer '1'
      expect(await clientB.dbsize()).toBe(0);
    } finally { await clientA.quit(); await clientB.quit(); }
  }, 120_000);

  it('ignores every environment variable that used to name the live stack\'s Redis', async () => {
    const before = { port: process.env.OSHAL_REDIS_PORT, url: process.env.OSHAL_TEST_REDIS_URL };
    // 6379 is not published on this box, so a helper that honoured either variable would fail to
    // connect rather than quietly succeed — the assertion below is on the port it actually chose.
    process.env.OSHAL_REDIS_PORT = '6379';
    process.env.OSHAL_TEST_REDIS_URL = 'redis://127.0.0.1:6379';
    try {
      const fixture = track(new DisposableRedis({ purpose: 'iso-env' }));
      const conn = await fixture.start();
      expect(conn.port).not.toBe(6379);
      expect(fixture.url).toBe(`redis://127.0.0.1:${conn.port}`);
      const client = new Redis(fixture.url, { maxRetriesPerRequest: 1 });
      try { expect(await client.ping()).toBe('PONG'); } finally { await client.quit(); }
    } finally {
      if (before.port === undefined) delete process.env.OSHAL_REDIS_PORT; else process.env.OSHAL_REDIS_PORT = before.port;
      if (before.url === undefined) delete process.env.OSHAL_TEST_REDIS_URL; else process.env.OSHAL_TEST_REDIS_URL = before.url;
    }
  }, 120_000);

  it('stop() really removes the container, is safe twice, and is safe on a fixture that never started', async () => {
    const fixture = new DisposableRedis({ purpose: 'iso-stop' });
    await fixture.start();
    expect(containerExists(fixture.containerName)).toBe(true);
    await fixture.stop();
    expect(containerExists(fixture.containerName)).toBe(false);
    await fixture.stop();                                   // second call must not throw
    expect(() => fixture.connection).toThrow(/not started/);

    const neverStarted = new DisposableRedis({ purpose: 'iso-never' });
    await neverStarted.stop();
    expect(containerExists(neverStarted.containerName)).toBe(false);
  }, 120_000);

  it('names its container as a fixture so a residue sweep can never match an operator container', () => {
    const fixture = new DisposableRedis({ purpose: 'iso-name' });
    expect(fixture.containerName).toMatch(/^oshal-iso-name-fixture-[0-9a-f-]{36}$/);
    expect(fixture.containerName.startsWith('oshal-local-')).toBe(false);
    expect(() => new DisposableRedis({ purpose: '  ' })).toThrow(/purpose/);
  });
});
