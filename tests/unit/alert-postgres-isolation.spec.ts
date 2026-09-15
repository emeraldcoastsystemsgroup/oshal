/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove deployment DSNs are ignored, private alert fixtures cannot see each other's rows and teardown removes their containers.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Hold the other half of the same doctrine: an affected suite may not SKIP when its fixture cannot start, and its teardown may not wait on a server that setup never opened. The second was the afterAll hang — `server?.close(cb)` with no server never calls back, so the hook sat out its full timeout precisely when setup had already failed, which is the run where the failure most needed to be readable.
 */
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';

afterEach(() => vi.unstubAllEnvs());
describe('alert PostgreSQL fixture isolation', () => {
  it('never connects to an inherited deployment DSN and isolates two real databases', async () => {
    let contacts = 0;
    const sentinel = createServer(socket => { contacts += 1; socket.destroy(); });
    await new Promise<void>(done => sentinel.listen(0, '127.0.0.1', done));
    const port = (sentinel.address() as { port: number }).port;
    for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ALERT_PIPELINE_TEST_DSN', 'ALERT_PIPELINE_TEST_DATABASE_URL']) {
      vi.stubEnv(key, `postgres://must-not-connect@127.0.0.1:${port}/operator_database`);
    }
    const first = new DisposableAlertPostgres(); const second = new DisposableAlertPostgres();
    try {
      const [a, b] = await Promise.all([first.start(), second.start()]);
      expect(first.containerName).not.toBe(second.containerName);
      expect(a.options.port).not.toBe(b.options.port);
      await a.query("INSERT INTO oshal_alert_envelope(body) VALUES('{\"fixture\":true}')");
      expect((await a.query('SELECT count(*)::int AS n FROM oshal_alert_envelope')).rows[0].n).toBe(1);
      expect((await b.query('SELECT count(*)::int AS n FROM oshal_alert_envelope')).rows[0].n).toBe(0);
      expect((await a.query("SELECT current_database() AS name, to_regclass('oshal_incident') AS incident")).rows[0])
        .toEqual({ name: 'alert_fixture', incident: 'oshal_incident' });
      expect(contacts).toBe(0);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
      await new Promise<void>(done => sentinel.close(() => done()));
    }
    for (const fixture of [first, second]) {
      expect(() => execFileSync('docker', ['inspect', fixture.containerName], { stdio: 'pipe', timeout: 10_000 })).toThrow();
    }
  }, 90_000);

  it('has immediate idempotent teardown even if setup never created a server or database', async () => {
    const fixture = new DisposableAlertPostgres();
    await fixture.stop(); await fixture.stop();
    expect(() => fixture.pool).toThrow(/not started/);
  });

  it('requires every affected suite to acquire its database only through the private fixture', () => {
    for (const name of ['alert-incident-cutover', 'alert-incident-reopen', 'topology-traversal']) {
      const source = readFileSync(resolve(__dirname, `${name}.spec.ts`), 'utf8');
      expect(source).toContain('pool = await database.start()');
      expect(source).not.toMatch(/new Pool\s*\(|process\.env\.(?:DATABASE_URL|TEST_DATABASE_URL|ALERT_PIPELINE_TEST_DSN|ALERT_PIPELINE_TEST_DATABASE_URL|OSHAL_PG_PORT)/);
    }
  });

  // Source-level, and only source-level: this states that the two shapes cannot be written, not
  // that a Docker-less run behaves. What a run does is proven by exercising the fixture itself
  // in the cases above.
  it('leaves those suites no way to skip when the fixture cannot start, and no teardown that waits on a server setup never opened', () => {
    for (const name of ['alert-incident-cutover', 'alert-incident-reopen', 'topology-traversal']) {
      const source = readFileSync(resolve(__dirname, `${name}.spec.ts`), 'utf8');
      // A suite that skips itself when Docker is absent reports green having proven nothing.
      expect(source).not.toMatch(/\b(?:describe|it|test)\.(?:skip|skipIf|runIf|todo)\b/);
      // The afterAll hang: `server?.close(cb)` with no server never calls the callback, so the
      // hook sat out its whole timeout on exactly the runs where setup had already failed.
      expect(source).not.toMatch(/server\?\.close\s*\(/);
    }
  });
});
