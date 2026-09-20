/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ONE private PostgreSQL lifetime for every spec that needs a real server. The DB-backed specs each grew their own `docker run` block, and the ones that did not grow one fell back to a connection string instead — a fallback that resolved to the local stack's published port, which is the operator's LIVE trading database, and wrote synthetic orders into the real book twice on 2026-09-14. A spec that owns its server cannot reach a deployment at all: the address is invented at start(), nothing inherits a DSN, and the container is force-removed in stop() even when startup failed part-way, so no cleanup SQL ever runs somewhere it did not create. Generalised from the alert fixture (which now delegates here) so converging a spec onto it is an import rather than a fourth copy of the same twelve lines.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Redact POSTGRES_PASSWORD out of the setup-failure message. execFileSync reports the failing command as its message, so appending it printed the fixture credential the line above promises never to echo - the diagnostic stays, the value does not.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Extra LOGIN roles, because the one thing this fixture could not host was a spec whose SUBJECT is the enforcing role. A private server has only the superuser `postgres`, and a superuser bypasses row-level security unconditionally - so a FORCE-RLS assertion made over it passes for the wrong reason and proves nothing. That is why trading-book-report-scripts still resolved an oshal_app DSN out of the environment (and, failing that, out of the operator's .env) long after its sibling specs stopped: converting it onto a superuser-only fixture would have quietly made every RLS assertion in the file vacuous. `roles:` creates NOSUPERUSER NOBYPASSRLS LOGIN roles once the server answers and before migrations run, each with a password minted here like the superuser's - never a literal, never inherited from the environment - and hands back a pool/connection per role. Role pools deliberately do NOT inherit the fixture's libpq `options`: `-c row_security=off` on a non-privileged role turns an enforced read into an error instead of a filtered result.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The failure redaction now scrubs minted secrets BY VALUE as well as by the `POSTGRES_PASSWORD=` shape. A role password reaches the server inside a CREATE ROLE statement rather than a docker argv, so the entry-2 pattern would not have caught it; scrubbing the values the fixture generated covers both shapes and any future one.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

/**
 * An extra LOGIN role the fixture creates for itself, for a spec whose subject is what a
 * NON-superuser is allowed to see. Given as a bare name when the defaults suffice.
 */
export interface DisposablePostgresRole {
  /** Role name, e.g. `oshal_app`. A lower-case SQL identifier — it is interpolated into DDL. */
  name: string;
  /**
   * libpq `options` for this role's pool. Defaults to NONE, and deliberately not the fixture's own:
   * `-c row_security=off` makes an enforced read raise instead of filtering, which is the opposite
   * of what a spec asking for a non-superuser role wants to observe.
   */
  options?: string;
  /** Pool size for this role (default 2). */
  max?: number;
}

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
  /**
   * Extra LOGIN roles to create once the server answers and BEFORE migrations run, so a migration
   * may GRANT to them. Each is NOSUPERUSER NOBYPASSRLS, so row-level security is really enforced
   * against it; reach them with `rolePool(name)` / `roleConnection(name)`.
   */
  roles?: readonly (string | DisposablePostgresRole)[];
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

/** A role after defaults are filled in. */
interface NormalizedRole { name: string; options?: string; max: number }

/**
 * A role name is interpolated into `CREATE ROLE`, which takes no parameters, so it is constrained
 * to the identifier shape rather than escaped.
 */
function normalizeRole(role: string | DisposablePostgresRole): NormalizedRole {
  const spec = typeof role === 'string' ? { name: role } : role;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(spec.name)) {
    throw new Error(`DisposablePostgres role name must match /^[a-z_][a-z0-9_]{0,62}$/ (got "${spec.name}")`);
  }
  return { name: spec.name, options: spec.options, max: spec.max ?? 2 };
}

/** Double-quote an identifier the fixture itself chose (the database name) for a GRANT. */
const quoteIdent = (value: string): string => `"${value.replace(/"/g, '""')}"`;
/** Single-quote a minted password for `CREATE ROLE ... PASSWORD`, which accepts no parameters. */
const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * A PostgreSQL server that exists only for the spec that started it.
 *
 * Own the container even during failed startup so no SQL cleanup ever targets operator data, and
 * never accept an address from the environment: the whole point is that there is nothing to point
 * at a deployment.
 */
export class DisposablePostgres {
  readonly containerName: string;
  private readonly opts: Required<Omit<DisposablePostgresOptions, 'options' | 'migrations' | 'label' | 'roles'>>
    & { options?: string; migrations: readonly string[]; label: string; roles: readonly NormalizedRole[] };
  private poolValue?: Pool;
  private connectionValue?: DisposablePostgresConnection;
  private started = false;
  private readonly roleConnections = new Map<string, DisposablePostgresConnection>();
  private readonly rolePools = new Map<string, Pool>();
  /** Every credential this fixture generated, so a failure message can be scrubbed BY VALUE. */
  private readonly minted: string[] = [];

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
      roles: (options.roles ?? []).map(normalizeRole),
    };
  }

  /**
   * @description Remove every credential this fixture minted from a diagnostic string, by value and
   * by the `POSTGRES_PASSWORD=` shape a docker argv carries it in.
   * @param text The message about to be thrown.
   * @returns The same message with fixture credentials replaced by `***`.
   */
  private redact(text: string): string {
    return this.minted.reduce((carry, secret) => carry.split(secret).join('***'), text)
      .replace(/POSTGRES_PASSWORD=\S+/g, 'POSTGRES_PASSWORD=***');
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
   * @description Where one of the extra LOGIN roles connects — same server, same database, its own
   * user and its own minted password. The password is generated at start(); nothing supplies it and
   * no environment variable can influence it.
   * @param name The role, as it was declared in `roles`.
   * @returns That role's host, port, generated credentials and database.
   * @throws When the fixture has not been started or never declared the role.
   */
  roleConnection(name: string): DisposablePostgresConnection {
    const connection = this.roleConnections.get(name);
    if (!connection) {
      throw new Error(this.started
        ? `Disposable PostgreSQL (${this.opts.purpose}) has no role "${name}"; declare it in options.roles`
        : `Disposable PostgreSQL (${this.opts.purpose}) is not started`);
    }
    return { ...connection };
  }

  /**
   * @description A pool connected AS one of the extra roles, created on first use and ended by
   * stop(). This is the handle a spec asserts row-level security over: the role is NOSUPERUSER and
   * NOBYPASSRLS, so a FORCE-RLS table is really enforced against it rather than silently bypassed.
   * @param name The role, as it was declared in `roles`.
   * @returns The pool for that role.
   * @throws When the fixture has not been started or never declared the role.
   */
  rolePool(name: string): Pool {
    const existing = this.rolePools.get(name);
    if (existing) return existing;
    const connection = this.roleConnection(name);
    const role = this.opts.roles.find(candidate => candidate.name === name)!;
    const pool = new Pool({
      ...connection,
      max: role.max,
      connectionTimeoutMillis: this.opts.connectionTimeoutMillis,
      statement_timeout: this.opts.statementTimeoutMs,
      ...(role.options ? { options: role.options } : {}),
    });
    this.rolePools.set(name, pool);
    return pool;
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
    this.minted.push(password);
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
      await this.createRoles();
      for (const migration of this.opts.migrations) {
        await this.poolValue.query(readFileSync(resolve(__dirname, '../../scripts/migrations', migration), 'utf8'));
      }
      return this.poolValue;
    } catch (error) {
      await this.stop();
      // execFileSync puts the whole docker argv in `message`, and that argv carries the fixture's
      // POSTGRES_PASSWORD. The cause is worth printing; the value never is - so redact it here
      // rather than dropping the diagnostic and leaving a bare "setup failed".
      const detail = this.redact(error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error');
      throw new Error(`Disposable PostgreSQL setup failed for ${this.opts.purpose} (${detail}). Docker with postgres:16-alpine is required; deployment databases are never used.`);
    }
  }

  /**
   * @description Create each declared LOGIN role with a password minted here, explicitly stripped of
   * superuser and RLS-bypass, and able to reach the fixture database. Runs before migrations so a
   * migration may GRANT to the role it expects to exist.
   * @returns Nothing.
   * @throws When the role cannot be created — the caller's catch redacts the minted password.
   */
  private async createRoles(): Promise<void> {
    for (const role of this.opts.roles) {
      const password = randomUUID();
      this.minted.push(password);
      // NOSUPERUSER/NOBYPASSRLS are the whole point: a role that kept either would make every
      // row-level-security assertion made over it pass without the policy ever being consulted.
      await this.pool.query(`CREATE ROLE ${role.name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB `
        + `NOCREATEROLE NOREPLICATION PASSWORD ${quoteLiteral(password)}`);
      await this.pool.query(`GRANT CONNECT ON DATABASE ${quoteIdent(this.opts.database)} TO ${role.name}`);
      await this.pool.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role.name}`);
      this.roleConnections.set(role.name, {
        host: this.connection.host, port: this.connection.port,
        user: role.name, password, database: this.opts.database,
      });
    }
  }

  /**
   * @description End every pool — the superuser's and each role's — and force-remove the container.
   * Safe to call twice and safe to call after a failed start: the container is removed whenever
   * `docker run` returned at all, and the roles go away with the server that held them.
   * @returns Nothing.
   */
  async stop(): Promise<void> {
    // Role pools first, and each failure swallowed: the container removal below is what actually
    // guarantees nothing survives, so no pool may be allowed to skip it.
    for (const [name, rolePool] of this.rolePools) {
      try { await rolePool.end(); } catch { /* a pool that never connected has nothing to end */ }
      this.rolePools.delete(name);
    }
    try { if (this.poolValue) { await this.poolValue.end(); this.poolValue = undefined; } }
    finally {
      this.connectionValue = undefined;
      this.roleConnections.clear();
      if (this.started) {
        try { docker(['rm', '--force', this.containerName], 60_000); } catch { /* an --rm container may already be gone */ }
        this.started = false;
      }
    }
  }
}
