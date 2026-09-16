/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ONE private PostgreSQL lifetime for every spec that needs a real server. The DB-backed specs each grew their own `docker run` block, and the ones that did not grow one fell back to a connection string instead — a fallback that resolved to the local stack's published port, which is the operator's LIVE trading database, and wrote synthetic orders into the real book twice on 2026-09-14. A spec that owns its server cannot reach a deployment at all: the address is invented at start(), nothing inherits a DSN, and the container is force-removed in stop() even when startup failed part-way, so no cleanup SQL ever runs somewhere it did not create. Generalised from the alert fixture (which now delegates here) so converging a spec onto it is an import rather than a fourth copy of the same twelve lines.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Redact POSTGRES_PASSWORD out of the setup-failure message. execFileSync reports the failing command as its message, so appending it printed the fixture credential the line above promises never to echo - the diagnostic stays, the value does not.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

/** How a caller shapes its private server. Every field has a working default except `purpose`. */
export interface DisposablePostgresOptions {
  /** What this fixture is for, in `kebab-case`: names the container and labels it for residue sweeps. */
  purpose: string;
  /** Docker label value; defaults to `<purpose>-postgres`. */
  label?: string;
  /** Database created at container start (default `oshal_fixture`). */
  database?: string;
  /** SQL files under `scripts/migrations/`, applied in order once the server answers. */
  migrations?: readonly string[];
  /** Container memory ceiling (default `256m`); raise it for a spec that drives real engine work. */
  memory?: string;
  /** Pool size (default 8). */
  max?: number;
  /** Pool connect timeout in ms (default 2000). */
  connectionTimeoutMillis?: number;
  /** Per-statement timeout in ms (default 15000). */
  statementTimeoutMs?: number;
  /** libpq `options` string, e.g. `-c row_security=off` for a spec that reads across owner policies. */
  options?: string;
}

/** Where the private server is listening. Handed out so a spec can mint its own Client if it must. */
export interface DisposablePostgresConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Docker arguments are fixed except generated fixture credentials; inherited DSNs are never read. */
function docker(args: string[], timeoutMs: number): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }).trim();
}

/**
 * A PostgreSQL server that exists only for the spec that started it.
 *
 * Own the container even during failed startup so no SQL cleanup ever targets operator data, and
 * never accept an address from the environment: the whole point is that there is nothing to point
 * at a deployment.
 */
export class DisposablePostgres {
  readonly containerName: string;
  private readonly opts: Required<Omit<DisposablePostgresOptions, 'options' | 'migrations' | 'label'>>
    & { options?: string; migrations: readonly string[]; label: string };
  private poolValue?: Pool;
  private connectionValue?: DisposablePostgresConnection;
  private started = false;

  constructor(options: DisposablePostgresOptions) {
    const purpose = options.purpose.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!purpose) throw new Error('DisposablePostgres needs a purpose to name its container after');
    this.containerName = `oshal-${purpose}-fixture-${randomUUID()}`;
    this.opts = {
      purpose,
      label: options.label ?? `${purpose}-postgres`,
      database: options.database ?? 'oshal_fixture',
      migrations: options.migrations ?? [],
      memory: options.memory ?? '256m',
      max: options.max ?? 8,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 2_000,
      statementTimeoutMs: options.statementTimeoutMs ?? 15_000,
      options: options.options,
    };
  }

  /**
   * @description The pool for the running server.
   * @returns The connected pool.
   * @throws When the fixture has not been started.
   */
  get pool(): Pool {
    if (!this.poolValue) throw new Error(`Disposable PostgreSQL (${this.opts.purpose}) is not started`);
    return this.poolValue;
  }

  /**
   * @description Where the running server listens, for a spec that needs a second connection of its
   * own (a `Client` it drives a transaction on, for instance) rather than a pooled one.
   * @returns The host, port and generated credentials of the private server.
   * @throws When the fixture has not been started.
   */
  get connection(): DisposablePostgresConnection {
    if (!this.connectionValue) throw new Error(`Disposable PostgreSQL (${this.opts.purpose}) is not started`);
    return { ...this.connectionValue };
  }

  /**
   * @description Start a private PostgreSQL, wait for it to answer, apply any declared migrations,
   * and return its pool. A failure part-way removes the container before it throws, so a half-built
   * fixture never outlives the run that made it.
   * @returns The connected pool.
   * @throws When Docker is unavailable or the server never became ready.
   */
  async start(): Promise<Pool> {
    if (this.started) throw new Error(`Disposable PostgreSQL (${this.opts.purpose}) is already started`);
    const password = randomUUID();
    try {
      docker(['run', '--detach', '--rm', '--name', this.containerName,
        '--label', `oshal.test-fixture=${this.opts.label}`,
        '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data',
        '--memory', this.opts.memory, '--cpus', '1',
        '--env', `POSTGRES_PASSWORD=${password}`, '--env', `POSTGRES_DB=${this.opts.database}`,
        'postgres:16-alpine'], 60_000);
      this.started = true;
      const published = docker(['port', this.containerName, '5432/tcp'], 30_000);
      const match = /^127\.0\.0\.1:(\d+)$/m.exec(published);
      if (!match) throw new Error('Disposable PostgreSQL must publish exactly one loopback port');
      this.connectionValue = {
        host: '127.0.0.1', port: Number(match[1]), user: 'postgres', password, database: this.opts.database,
      };
      this.poolValue = new Pool({
        ...this.connectionValue,
        max: this.opts.max,
        connectionTimeoutMillis: this.opts.connectionTimeoutMillis,
        statement_timeout: this.opts.statementTimeoutMs,
        ...(this.opts.options ? { options: this.opts.options } : {}),
      });
      let ready = false;
      for (let attempt = 0; attempt < 240; attempt += 1) {
        try { await this.poolValue.query('SELECT 1'); ready = true; break; }
        catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 250)); }
      }
      if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
      for (const migration of this.opts.migrations) {
        await this.poolValue.query(readFileSync(resolve(__dirname, '../../scripts/migrations', migration), 'utf8'));
      }
      return this.poolValue;
    } catch (error) {
      await this.stop();
      // execFileSync puts the whole docker argv in `message`, and that argv carries the fixture's
      // POSTGRES_PASSWORD. The cause is worth printing; the value never is - so redact it here
      // rather than dropping the diagnostic and leaving a bare "setup failed".
      const detail = (error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error')
        .replace(/POSTGRES_PASSWORD=\S+/g, 'POSTGRES_PASSWORD=***');
      throw new Error(`Disposable PostgreSQL setup failed for ${this.opts.purpose} (${detail}). Docker with postgres:16-alpine is required; deployment databases are never used.`);
    }
  }

  /**
   * @description End the pool and force-remove the container. Safe to call twice and safe to call
   * after a failed start — the container is removed whenever `docker run` returned at all.
   * @returns Nothing.
   */
  async stop(): Promise<void> {
    try { if (this.poolValue) { await this.poolValue.end(); this.poolValue = undefined; } }
    finally {
      this.connectionValue = undefined;
      if (this.started) {
        try { docker(['rm', '--force', this.containerName], 60_000); } catch { /* an --rm container may already be gone */ }
        this.started = false;
      }
    }
  }
}
