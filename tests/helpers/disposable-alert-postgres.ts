/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Give alert integration guards a private PostgreSQL lifetime with no deployment DSN fallback.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const MIGRATIONS = ['104-alert-pipeline-core.sql', '105-alert-incident.sql', '106-alert-evidence.sql',
  '107-alert-config-topology.sql', '108-alert-metering.sql', '109-topology-transit.sql'];

/** Docker arguments are fixed except generated fixture credentials; inherited DSNs are never read. */
function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

/** Own the container even during failed startup so no SQL cleanup ever targets operator data. */
export class DisposableAlertPostgres {
  readonly containerName = `oshal-alert-fixture-${randomUUID()}`;
  private poolValue?: Pool;
  private started = false;

  get pool(): Pool {
    if (!this.poolValue) throw new Error('Disposable alert PostgreSQL is not started');
    return this.poolValue;
  }

  async start(): Promise<Pool> {
    if (this.started) throw new Error('Disposable alert PostgreSQL is already started');
    const password = randomUUID();
    try {
      docker(['run', '--detach', '--rm', '--name', this.containerName, '--label', 'oshal.test-fixture=alert-postgres',
        '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data', '--memory', '256m', '--cpus', '1',
        '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=alert_fixture', 'postgres:16-alpine']);
      this.started = true;
      const published = docker(['port', this.containerName, '5432/tcp']);
      const match = /^127\.0\.0\.1:(\d+)$/.exec(published);
      if (!match) throw new Error('Disposable alert PostgreSQL must publish exactly one loopback port');
      this.poolValue = new Pool({ host: '127.0.0.1', port: Number(match[1]), user: 'postgres', password,
        database: 'alert_fixture', max: 12, connectionTimeoutMillis: 500, statement_timeout: 15_000 });
      let ready = false;
      for (let attempt = 0; attempt < 90; attempt += 1) {
        try { await this.poolValue.query('SELECT 1'); ready = true; break; }
        catch { await new Promise(resolveDelay => setTimeout(resolveDelay, 200)); }
      }
      if (!ready) throw new Error('Disposable alert PostgreSQL did not become ready');
      for (const migration of MIGRATIONS) {
        await this.poolValue.query(readFileSync(resolve(__dirname, '../../scripts/migrations', migration), 'utf8'));
      }
      return this.poolValue;
    } catch (error) {
      await this.stop();
      // Do not echo Docker argv: POSTGRES_PASSWORD is a transient fixture credential.
      throw new Error(`Disposable alert PostgreSQL setup failed (${error instanceof Error ? error.name : 'unknown error'}). Docker with postgres:16-alpine is required; deployment databases are never used.`);
    }
  }

  async stop(): Promise<void> {
    try { if (this.poolValue) { await this.poolValue.end(); this.poolValue = undefined; } }
    finally {
      if (this.started) {
        docker(['rm', '--force', this.containerName]);
        this.started = false;
      }
    }
  }
}
