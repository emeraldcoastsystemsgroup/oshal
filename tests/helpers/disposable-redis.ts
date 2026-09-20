/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The Redis sibling of disposable-postgres.ts, which did not exist. Two specs needed it and neither could be converted without it: trading-event-leg-cadence resolved a Redis URL and trading-watchdog-books docker-execs into a Redis CONTAINER by name. Both previously defaulted to the operator's live stack - on this box OSHAL_REDIS_PORT names the port the running swarm's Redis listens on, so an unpointed run wrote and deleted keys in its queue and scheduler state. A throwaway server answers it the same way it answered the Postgres half: nothing to point, and nothing to point at. Readiness is `docker exec redis-cli PING` rather than a client handshake, so this helper stays free of any Redis client dependency and works for the exec-based spec as well as the URL-based one.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** What the fixture needs to know about itself. */
export interface DisposableRedisOptions {
  /** What this fixture is for, in `kebab-case`: names the container and labels it for residue sweeps. */
  purpose: string;
  /** Docker label value; defaults to `<purpose>-redis`. */
  label?: string;
  /** Container memory ceiling (default `128m`). Redis needs far less than Postgres. */
  memory?: string;
}

/** Where the private server is listening. */
export interface DisposableRedisConnection {
  host: string;
  port: number;
  url: string;
}

/** Docker arguments are fixed except the generated container name; inherited addresses are never read. */
function docker(args: string[], timeoutMs: number): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }).trim();
}

/**
 * A Redis server that exists only for the spec that started it.
 *
 * Owns the container even during failed startup so no cleanup ever targets operator data, and never
 * accepts an address from the environment: the whole point is that there is nothing to point at a
 * deployment. The container name is exposed because one spec reaches Redis through
 * `docker exec <name> redis-cli` rather than a client.
 */
export class DisposableRedis {
  readonly containerName: string;

  private readonly opts: Required<DisposableRedisOptions>;
  private connectionValue?: DisposableRedisConnection;
  private started = false;

  constructor(options: DisposableRedisOptions) {
    const purpose = options.purpose?.trim();
    if (!purpose) throw new Error('DisposableRedis needs a purpose to name its container after');
    this.opts = {
      purpose,
      label: options.label ?? `${purpose}-redis`,
      memory: options.memory ?? '128m',
    };
    this.containerName = `oshal-${purpose}-fixture-${randomUUID()}`;
  }

  /**
   * @description Where this fixture is listening.
   * @returns Host, port and the `redis://` URL.
   * @throws When the fixture has not been started.
   */
  get connection(): DisposableRedisConnection {
    if (!this.connectionValue) throw new Error(`Disposable Redis (${this.opts.purpose}) is not started`);
    return this.connectionValue;
  }

  /**
   * @description The `redis://` URL of this fixture, for a spec that takes a URL.
   * @returns The connection URL.
   * @throws When the fixture has not been started.
   */
  get url(): string {
    return this.connection.url;
  }

  /**
   * @description Start a private Redis on a loopback port Docker chooses, and wait for it to answer.
   * @returns The connection details.
   * @throws When Docker is unavailable or the server never became ready.
   *
   * A failure part-way removes the container before it throws, so a half-built fixture never
   * outlives the spec that tried to build it — leaked containers are not a tidiness problem: on a
   * small box they starve later fixtures, and a `beforeAll` that fails that way is reported by
   * vitest as SKIPPED rather than failed, which reads as a passing suite.
   */
  async start(): Promise<DisposableRedisConnection> {
    if (this.started) throw new Error(`Disposable Redis (${this.opts.purpose}) is already started`);
    try {
      docker(['run', '--detach', '--rm', '--name', this.containerName,
        '--label', `oshal.test-fixture=${this.opts.label}`,
        '--publish', '127.0.0.1::6379',
        '--memory', this.opts.memory, '--cpus', '1',
        'redis:7-alpine'], 60_000);
      this.started = true;

      const published = docker(['port', this.containerName, '6379/tcp'], 30_000);
      const match = /^127\.0\.0\.1:(\d+)$/m.exec(published);
      if (!match) throw new Error('Disposable Redis must publish exactly one loopback port');
      const port = Number(match[1]);
      this.connectionValue = { host: '127.0.0.1', port, url: `redis://127.0.0.1:${port}` };

      // PING through the container rather than a client: this helper serves a spec that talks to
      // Redis by `docker exec` as well as one that takes a URL, and coupling it to a client library
      // would make it useless to the first.
      let ready = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          if (docker(['exec', this.containerName, 'redis-cli', 'PING'], 10_000).includes('PONG')) {
            ready = true;
            break;
          }
        } catch { /* not up yet */ }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      if (!ready) throw new Error('Disposable Redis did not become ready');
      return this.connectionValue;
    } catch (error) {
      await this.stop();
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
      throw new Error(
        `Disposable Redis setup failed for ${this.opts.purpose} (${detail}). `
        + 'Docker with redis:7-alpine is required; deployment servers are never used.',
      );
    }
  }

  /**
   * @description Force-remove the container. Safe to call twice and safe to call after a failed
   * start — the container is removed whenever `docker run` returned at all.
   * @returns Nothing.
   */
  async stop(): Promise<void> {
    this.connectionValue = undefined;
    if (this.started) {
      try { docker(['rm', '--force', this.containerName], 60_000); } catch { /* an --rm container may already be gone */ }
      this.started = false;
    }
  }
}
