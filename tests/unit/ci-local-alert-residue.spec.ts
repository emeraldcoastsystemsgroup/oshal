/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the ci-local alert-residue post-gate. The real gate script runs in Git Bash against a real migrated PostgreSQL — the same migrations the deployment runs — so what is proven here is the SQL and the exit code, not a description of them: a clean database passes, each of the three fixture shapes the alert integration guards write fails, a genuine deployment incident does not, a database the gate could not query is UNCHECKED rather than clean, and ci-local.sh actually calls it.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Cover the window the first pass left unproven: the gate's fail-closed promise was only tested at the opening connectivity probe, so a query that died AFTER it was nobody's regression. Three cases now judge it. Two lose the database mid-run behind a counting stand-in for the docker CLI — the only way to place a dropped connection at an exact statement — while everything else in them, script, shell, SQL, exit code and the PostgreSQL underneath, stays real. The third needs no stand-in at all: a genuine unprivileged role reads oshal_incident and is refused oshal_incident_member, which is a real query failure mid-run, and the gate must call that UNCHECKED rather than count it as zero.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';

/** The gate judges a database, so the guard gives it one of its own — never a deployment DSN. */
const database = new DisposableAlertPostgres();

const GATE_SCRIPT = resolve(__dirname, '../../scripts/ci/check-alert-residue.sh').replaceAll('\\', '/');
const CI_LOCAL = resolve(__dirname, '../../scripts/ci-local.sh');

let pool: Pool;

/** Git Bash, not the WSL launcher: the gate is a POSIX script the Windows task runs through Git Bash. */
function bash(): string {
  if (process.platform !== 'win32') return 'bash';
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up += 1, dir = dirname(dir)) {
    const candidate = resolve(dir, 'bin/bash.exe');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Git Bash is required; WSL launcher is not a substitute');
}

interface GateRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the real gate against this run's private PostgreSQL; overrides steer the failure cases. */
function runGate(overrides: Record<string, string> = {}): GateRun {
  const result = spawnSync(bash(), [GATE_SCRIPT], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      OSHAL_RESIDUE_DB_CONTAINER: database.containerName,
      OSHAL_RESIDUE_DB_USER: 'postgres',
      OSHAL_RESIDUE_DB_NAME: 'alert_fixture',
      ...overrides,
    },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Empties the consolidation tables so each case states exactly the rows it is about. */
async function reset(): Promise<void> {
  await pool.query('TRUNCATE oshal_incident, oshal_alert_event RESTART IDENTITY CASCADE');
}

/** Writes one incident row; only the identity columns matter to the gate. */
async function insertIncident(dedupKey: string, primaryTarget: string): Promise<string> {
  const { rows } = await pool.query<{ incident_id: string }>(
    'INSERT INTO oshal_incident (dedup_key, primary_target) VALUES ($1, $2) RETURNING incident_id',
    [dedupKey, primaryTarget],
  );
  return rows[0].incident_id;
}

/**
 * Stand-in for the docker CLI, used only to time a lost connection. It hands the first
 * OSHAL_ALERT_SHIM_PASS calls to the real binary and refuses everything after, which is
 * the one thing a real container cannot be asked to do on cue.
 */
const DOCKER_SHIM = [
  '#!/usr/bin/env bash',
  'attempt=$(cat "$OSHAL_ALERT_SHIM_COUNTER" 2>/dev/null || echo 0)',
  'attempt=$((attempt + 1))',
  'printf %s "$attempt" > "$OSHAL_ALERT_SHIM_COUNTER"',
  'if [ "$attempt" -gt "$OSHAL_ALERT_SHIM_PASS" ]; then',
  '  echo "Error response from daemon: connection reset by peer" >&2',
  '  exit 1',
  'fi',
  'exec "$OSHAL_ALERT_SHIM_REAL_DOCKER" "$@"',
  '',
].join('\n');

let realDockerPath = '';

/** Resolves docker the way the gate does — through Git Bash — so the shim can delegate to it. */
function realDocker(): string {
  if (!realDockerPath) {
    realDockerPath = execFileSync(bash(), ['-c', 'command -v docker'], { encoding: 'utf8' }).trim();
  }
  if (!realDockerPath) throw new Error('docker must be on PATH: the alert-residue gate shells out to it');
  return realDockerPath;
}

/**
 * Runs the real gate against the real fixture database and takes the database away after
 * `passedCalls` statements, so the verdict for a mid-run failure can be asserted per statement.
 */
function runGateLosingDatabaseAfter(passedCalls: number): GateRun {
  const shimDir = mkdtempSync(resolve(tmpdir(), 'oshal-alert-residue-shim-'));
  const counter = resolve(shimDir, 'calls').replaceAll('\\', '/');
  writeFileSync(counter, '0');
  writeFileSync(resolve(shimDir, 'docker'), DOCKER_SHIM, { mode: 0o755 });
  return runGate({
    PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
    OSHAL_ALERT_SHIM_COUNTER: counter,
    OSHAL_ALERT_SHIM_PASS: String(passedCalls),
    OSHAL_ALERT_SHIM_REAL_DOCKER: realDocker(),
  });
}

beforeAll(async () => {
  pool = await database.start();
}, 120_000);

afterAll(async () => {
  await database.stop();
}, 60_000);

describe('ci-local alert-residue post-gate', () => {
  it('passes on a deployment database holding no fixture rows', async () => {
    await reset();
    const run = runGate();
    expect(run.stderr).not.toContain('alert-residue:');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('alert-residue: clean');
  }, 60_000);

  it('passes on genuine deployment incidents, so a real outage is never mistaken for residue', async () => {
    await reset();
    await insertIncident('oshal-local:a677df51e4dfbbde8d910dcc71903ff0', 'oshal-local-api');
    await insertIncident('oshal-local:b4c1e2f09a7d6b5c4e3f2a1908d7c6b5', 'oshal-local-queue-bot');
    const run = runGate();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('alert-residue: clean');
  }, 60_000);

  it("fails on the reopen spec's probe-target incident and names the offending row", async () => {
    await reset();
    await insertIncident('zz-incident-reopen-1234-1786039809193-arm-a-1', 'probe-target');
    const run = runGate();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('alert-residue: FAIL');
    expect(run.stderr).toContain('probe-target');
    expect(run.stderr).toContain('oshal_incident=1');
  }, 60_000);

  it("fails on the cutover spec's cut- run prefix", async () => {
    await reset();
    await insertIncident('oshal-local:a677df51e4dfbbde8d910dcc71903ff0', 'cut-3x4-mshuk5cq-container');
    const run = runGate();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('cut-3x4-mshuk5cq-container');
  }, 60_000);

  it('fails on a reopen dedup key even when the target column looks like a real container', async () => {
    await reset();
    await insertIncident('zz-incident-reopen-9999-1786040902383-arm-b-2', 'oshal-local-api');
    const run = runGate();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('zz-incident-reopen-9999');
  }, 60_000);

  it('counts member and event residue, not incident rows alone', async () => {
    await reset();
    const incidentId = await insertIncident('zz-incident-reopen-4242-1786040902383-arm-a-1', 'probe-target');
    await pool.query(
      "INSERT INTO oshal_incident_member (incident_id, member_key, attach_reason) VALUES ($1, 'probe-target', 'genesis')",
      [incidentId],
    );
    await pool.query("INSERT INTO oshal_alert_event (target, dedup_key) VALUES ('probe-target', $1)", [
      'zz-incident-reopen-4242-1786040902383-arm-a-1',
    ]);
    const run = runGate();
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('oshal_incident=1 oshal_incident_member=1 oshal_alert_event=1');
    expect(run.stderr).toContain('3 synthetic row(s)');
  }, 60_000);

  it('reports UNCHECKED instead of clean when it cannot reach the database', () => {
    const run = runGate({ OSHAL_RESIDUE_DB_CONTAINER: 'oshal-alert-residue-absent-fixture' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('UNCHECKED');
    expect(run.stderr).toContain('nothing here says the deployment is clean');
    expect(run.stdout).not.toContain('clean (');
  }, 60_000);

  it('says so plainly when the consolidation tables were never migrated here', () => {
    // The container's own bootstrap database has no alert schema at all.
    const run = runGate({ OSHAL_RESIDUE_DB_NAME: 'postgres' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('oshal_incident is not present');
  }, 60_000);

  it('reports UNCHECKED when the database is lost between the probe and the table-existence check', async () => {
    await reset();
    const run = runGateLosingDatabaseAfter(1);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('oshal_incident existence check');
    expect(run.stderr).toContain('nothing here says the deployment is clean');
    // The false-green this closes: an unanswered existence check used to be announced
    // as an unmigrated deployment, which reads as "nothing to find here" and exits 0.
    expect(run.stdout).not.toContain('is not present');
    expect(run.stdout).not.toContain('clean (');
  }, 60_000);

  it('reports UNCHECKED when a companion table check dies, rather than counting that table as zero', async () => {
    await reset();
    // Deliberately no residue rows: the incident count legitimately comes back 0, so the
    // only thing standing between this run and a "clean" verdict is whether the gate is
    // honest about the two companion tables it never managed to read.
    const run = runGateLosingDatabaseAfter(3);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('oshal_incident_member existence check');
    expect(run.stdout).not.toContain('clean (');
  }, 60_000);

  it('reports UNCHECKED when a residue count is genuinely refused, with nothing stood in for', async () => {
    await reset();
    // A real unprivileged role against the real database: it may read oshal_incident and
    // is refused oshal_incident_member, so the failure the gate must survive is PostgreSQL's
    // own, not a simulated one.
    await pool.query('DROP ROLE IF EXISTS oshal_residue_partial_reader');
    await pool.query('CREATE ROLE oshal_residue_partial_reader LOGIN');
    await pool.query('GRANT USAGE ON SCHEMA public TO oshal_residue_partial_reader');
    await pool.query('GRANT SELECT ON oshal_incident TO oshal_residue_partial_reader');
    const run = runGate({ OSHAL_RESIDUE_DB_USER: 'oshal_residue_partial_reader' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('oshal_incident_member count');
    expect(run.stderr).toContain('permission denied');
    expect(run.stdout).not.toContain('clean (');
  }, 60_000);

  it('is wired into ci-local.sh as a gate rather than only existing on disk', () => {
    const script = readFileSync(CI_LOCAL, 'utf8');
    expect(script).toContain('scripts/ci/check-alert-residue.sh');
    expect(script).toContain('run_gate alert-residue gate_alert_residue');
  });
});
