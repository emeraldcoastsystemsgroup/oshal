/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Give alert integration guards a private PostgreSQL lifetime with no deployment DSN fallback.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Delegate the container lifetime to tests/helpers/disposable-postgres.ts instead of carrying a private copy of it. The trading specs needed the same private server with a different database, migration set and libpq options, and a second hand-rolled `docker run` block is how the first one came to be pasted seven times. Behaviour here is unchanged for the ~25 alert/Jarvis/test-lab specs that import this class: same container name shape, same `oshal.test-fixture=alert-postgres` label, same `alert_fixture` database, same migrations, same pool settings.
 */
import type { Pool } from 'pg';
import { DisposablePostgres } from './disposable-postgres';

const MIGRATIONS = ['104-alert-pipeline-core.sql', '105-alert-incident.sql', '106-alert-evidence.sql',
  '107-alert-config-topology.sql', '108-alert-metering.sql', '109-topology-transit.sql', '141-alert-event-effects.sql'];

/** Own the container even during failed startup so no SQL cleanup ever targets operator data. */
export class DisposableAlertPostgres {
  private readonly fixture = new DisposablePostgres({
    purpose: 'alert', label: 'alert-postgres', database: 'alert_fixture', migrations: MIGRATIONS,
    memory: '256m', max: 12, connectionTimeoutMillis: 500, statementTimeoutMs: 15_000,
  });

  /** The container this fixture owns, for a spec that asserts on its own isolation. */
  get containerName(): string { return this.fixture.containerName; }

  /**
   * @description The pool for the running alert fixture.
   * @returns The connected pool.
   * @throws When the fixture has not been started.
   */
  get pool(): Pool { return this.fixture.pool; }

  /**
   * @description Start a private PostgreSQL and apply the alert-pipeline migrations to it.
   * @returns The connected pool.
   * @throws When Docker is unavailable or the server never became ready.
   */
  async start(): Promise<Pool> { return this.fixture.start(); }

  /**
   * @description End the pool and force-remove the container.
   * @returns Nothing.
   */
  async stop(): Promise<void> { return this.fixture.stop(); }
}
