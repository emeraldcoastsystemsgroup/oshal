/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The backup/restore round-trip, lifted out of prove-local-selfhost-live.ts so a regression can execute it against a disposable PostgreSQL instead of the operator's live one. It carries the four properties the 2026-09-12 incident showed it lacked: the dump and the restore are separate steps whose exit codes are believed (the old form piped pg_dump into `psql -v ON_ERROR_STOP=0` inside `sh -c` with no pipefail, so a cancelled dump still exited 0), the comparison covers EVERY base table rather than the single `agents` row count that let a partial restore pass, the run is bounded by a statement/lock timeout plus a wall clock and a watcher that terminates only this diagnostic's own backends, and a deploy holding the lock at $HOME/.oshal-deploy/lock means the diagnostic never starts. Cleanup also sweeps throwaway databases left by earlier killed runs - three of those were measured at 31 GB on the dev box - and can only ever drop a name it minted itself.
 */

/**
 * A genuine pg_dump/restore round-trip against a PostgreSQL running in a docker container.
 *
 * Nothing here publishes anything. It returns checks; the caller decides. `backupProofAccepted`
 * is the one gate, and it is deliberately false unless EVERY required check is present and passed,
 * so a run that stopped early cannot look like a run that passed.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** One assertion this proof makes, with the raw observation that decided it. */
export interface BackupRestoreCheck {
  id: string;
  label: string;
  passed: boolean;
  evidence: string;
}

/** The PostgreSQL this proof runs against. `password` is only needed when `local` is not trusted. */
export interface BackupRestoreTarget {
  /** Docker container name running the server. */
  container: string;
  /** Superuser able to createdb/dropdb and read every table. */
  user: string;
  /** The database being backed up. Never dropped, never restored into. */
  database: string;
  /** Optional password, passed to the in-container client as PGPASSWORD and redacted from errors. */
  password?: string;
}

/** How the caller bounds the run. Every field has a working default except `target`. */
export interface BackupRestoreOptions {
  target: BackupRestoreTarget;
  /** The deploy lock a running `oshal-deploy.sh` holds. Default `$HOME/.oshal-deploy/lock`. */
  deployLockPath?: string;
  /** Wall-clock ceiling for the whole round trip (default 20 min). */
  maxRuntimeMs?: number;
  /** Per-statement ceiling handed to pg_dump and psql (default 120 s). */
  statementTimeoutMs?: number;
  /** How long either client waits for a lock before giving up (default 5 s). */
  lockTimeoutMs?: number;
  /** How often the watcher re-reads the deploy lock and the deadline (default 2 s). */
  pollMs?: number;
  /** Override the minted throwaway name. Must match the smoke shape and differ from the source. */
  throwawayName?: string;
}

/** Everything the round trip observed, including the counts both sides reported. */
export interface BackupRestoreProof {
  throwaway: string;
  sourceDatabase: string;
  tables: string[];
  before: Record<string, number>;
  after: Record<string, number>;
  /** Throwaway databases left behind by earlier runs that this run dropped. */
  sweptOrphans: string[];
  /** Why the watcher stopped the run, when it did. */
  abortedReason?: string;
  checks: BackupRestoreCheck[];
}

/**
 * The checks a published proof must carry. A run that never reached one still reports it, failed,
 * because "not attempted" and "passed" must never be the same shape on the way out.
 */
export const REQUIRED_BACKUP_CHECKS = Object.freeze([
  'deploy-idle',
  'dump-succeeded',
  'dump-complete',
  'restore-succeeded',
  'table-set-complete',
  'row-counts-equal',
  'source-intact',
  'throwaway-dropped',
  'no-orphan-databases',
] as const);

/** The name this proof mints for its scratch database, and the only shape cleanup may drop. */
const MINTED_NAME = /^oshal_restore_smoke_\d{13}_[0-9a-f]{12}$/;
/** Older runs minted `oshal_restore_smoke_<epoch-ms>`; the sweep has to recognise those too. */
const SWEEPABLE_NAME = /^oshal_restore_smoke_\d{10,17}(_[0-9a-f]{12})?$/;

/** Counting every base table in one round trip, rather than one query per table. */
const COUNT_ALL_TABLES = `select table_schema || '.' || table_name || '=' ||
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
  from information_schema.tables
  where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
  order by 1`;

/** Cleanup runs after something already went wrong, so it gets a tighter leash than the run did. */
const CLEANUP_BOUNDS = Object.freeze({ statementTimeoutMs: 10_000, timeoutMs: 60_000 });

/** @description Build a check row. @param id Stable id. @param label Human sentence. @param passed Outcome. @param evidence What decided it. @returns The check. */
function check(id: string, label: string, passed: boolean, evidence: string): BackupRestoreCheck {
  return { id, label, passed, evidence };
}

/** @description The default deploy lock, which `oshal-deploy.sh` creates as a directory. @returns Its absolute path. */
export function defaultDeployLockPath(): string {
  return path.join(process.env.OSHAL_DEPLOY_STATE || path.join(homedir(), '.oshal-deploy'), 'lock');
}

/**
 * @description Whether a name is one this diagnostic is allowed to DROP. A source database never
 * is, whatever it is called, and neither is anything outside the minted smoke shape.
 * @param name Candidate database name.
 * @param sourceDatabase The database being backed up.
 * @returns True when dropping it cannot destroy operator data.
 */
export function isDroppableThrowaway(name: string, sourceDatabase: string): boolean {
  return name !== sourceDatabase && SWEEPABLE_NAME.test(name);
}

/**
 * @description Decide whether a proof may be published. Every required check must be present and
 * passed; a missing check is treated as a failure, so an early return can never read as a pass.
 * @param proof The round trip's result.
 * @returns True only when the evidence is complete and clean.
 */
export function backupProofAccepted(proof: Pick<BackupRestoreProof, 'checks'>): boolean {
  const byId = new Map(proof.checks.map(item => [item.id, item]));
  return REQUIRED_BACKUP_CHECKS.every(id => byId.get(id)?.passed === true);
}

/** Mutable state shared between the round trip and the watcher that bounds it. */
interface RunState {
  aborted?: string;
  readonly appName: string;
}

/** Collects checks, defaulting every required id to a failed "not attempted". */
class CheckLedger {
  private readonly rows = new Map<string, BackupRestoreCheck>();

  constructor() {
    for (const id of REQUIRED_BACKUP_CHECKS) {
      this.rows.set(id, check(id, id, false, 'not attempted — the run stopped before this check'));
    }
  }

  /** @description Record an outcome for one id. @param row The check. @returns Nothing. */
  set(row: BackupRestoreCheck): void {
    this.rows.set(row.id, row);
  }

  /** @description The ledger in the declared order. @returns Every required check. */
  list(): BackupRestoreCheck[] {
    return REQUIRED_BACKUP_CHECKS.map(id => this.rows.get(id)!);
  }
}

/**
 * The round trip, as a class so the docker plumbing, the watcher and the ledger share one target
 * without threading eight arguments through every helper.
 */
class BackupRestoreRun {
  private readonly target: BackupRestoreTarget;
  private readonly deployLockPath: string;
  private readonly maxRuntimeMs: number;
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly pollMs: number;
  private readonly throwaway: string;
  private readonly ledger = new CheckLedger();
  private readonly state: RunState;
  private readonly deadline: number;

  constructor(options: BackupRestoreOptions) {
    this.target = options.target;
    this.deployLockPath = options.deployLockPath ?? defaultDeployLockPath();
    this.maxRuntimeMs = options.maxRuntimeMs ?? 20 * 60_000;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 120_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.pollMs = options.pollMs ?? 2_000;
    this.throwaway = options.throwawayName
      ?? `oshal_restore_smoke_${String(Date.now()).padStart(13, '0')}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.state = { appName: `oshal-backup-proof-${randomUUID().slice(0, 8)}` };
    this.deadline = Date.now() + this.maxRuntimeMs;
  }

  /** @description Remove the target password from a diagnostic string. @param text Message. @returns The scrubbed text. */
  private redact(text: string): string {
    const password = this.target.password;
    return password ? text.split(password).join('***') : text;
  }

  /**
   * @description Run one client inside the target container with the bounds this proof promises.
   * @param argv The in-container command and its arguments.
   * @returns Trimmed stdout.
   * @throws When the command exits non-zero, with the password scrubbed out of the message.
   */
  private async exec(argv: string[], bounds: { statementTimeoutMs?: number; timeoutMs?: number } = {}): Promise<string> {
    const statementTimeoutMs = bounds.statementTimeoutMs ?? this.statementTimeoutMs;
    const env = [
      '--env', `PGOPTIONS=-c statement_timeout=${statementTimeoutMs} -c lock_timeout=${this.lockTimeoutMs}`,
      '--env', `PGAPPNAME=${this.state.appName}`,
      ...(this.target.password ? ['--env', `PGPASSWORD=${this.target.password}`] : []),
    ];
    try {
      const { stdout } = await execFileAsync('docker', ['exec', ...env, this.target.container, ...argv], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: bounds.timeoutMs ?? this.maxRuntimeMs,
      });
      return stdout.trim();
    } catch (error) {
      const detail = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ''}` : String(error);
      throw new Error(this.redact(detail).slice(0, 1200));
    }
  }

  /** @description Run psql against one database and return its unaligned rows. @param database Target db. @param sql Statement. @returns Trimmed stdout. */
  private psql(database: string, sql: string, bounds?: { statementTimeoutMs?: number; timeoutMs?: number }): Promise<string> {
    return this.exec(['psql', '-v', 'ON_ERROR_STOP=1', '-U', this.target.user, '-d', database, '-tAc', sql], bounds);
  }

  /**
   * @description Terminate only the backends this diagnostic opened, identified by the
   * application_name it minted. This is the automated form of the manual cancellation that
   * unblocked the 2026-09-12 deploy; it can never reach an operator or application session.
   * @returns Nothing. A failure here is swallowed: cleanup must continue regardless.
   */
  private async terminateOwnBackends(): Promise<void> {
    const sql = `select pg_terminate_backend(pid) from pg_stat_activity
      where application_name = '${this.state.appName}' and pid <> pg_backend_pid()`;
    try { await this.psql('postgres', sql, CLEANUP_BOUNDS); } catch { /* the server may already be gone */ }
  }

  /**
   * @description Watch for a deploy taking the lock and for the wall-clock deadline, and cut this
   * diagnostic's own backends loose the moment either trips. This is what stops a concurrent
   * deployment waiting on locks pg_dump is holding.
   * @returns A stop function that clears the timer.
   */
  private startWatcher(): () => void {
    const timer = setInterval(() => {
      if (this.state.aborted) return;
      if (existsSync(this.deployLockPath)) this.state.aborted = 'a deployment took the lock mid-run';
      else if (Date.now() > this.deadline) this.state.aborted = `the ${this.maxRuntimeMs} ms runtime ceiling was reached`;
      if (this.state.aborted) void this.terminateOwnBackends();
    }, this.pollMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** @description List the databases on the server. @returns Every datname. */
  private async databases(): Promise<string[]> {
    const raw = await this.psql('postgres', 'select datname from pg_database where not datistemplate order by 1', CLEANUP_BOUNDS);
    return raw.split('\n').map(line => line.trim()).filter(Boolean);
  }

  /**
   * @description The base tables one database declares, read from the catalog only. Deliberately not
   * `counts()`: counting rows takes an ACCESS SHARE lock on every table, and cleanup runs in exactly
   * the situation where a lock is already contended — measured at 33 s on a run the watcher had
   * already aborted, which is the opposite of letting go of the database.
   * @param database Which database.
   * @returns Qualified table names.
   */
  private async tableNames(database: string): Promise<string[]> {
    const raw = await this.psql(database, `select table_schema || '.' || table_name from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') order by 1`, CLEANUP_BOUNDS);
    return raw.split('\n').map(line => line.trim()).filter(Boolean);
  }

  /**
   * @description Drop every throwaway database an earlier run left behind, terminating its
   * connections first. Three such orphans were measured holding 31 GB on the dev box, left when a
   * killed run skipped its cleanup.
   * @param names The databases currently on the server.
   * @returns The names actually dropped.
   */
  private async sweepOrphans(names: string[]): Promise<string[]> {
    const dropped: string[] = [];
    for (const name of names) {
      if (!isDroppableThrowaway(name, this.target.database)) continue;
      await this.psql('postgres', `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = '${name}' and pid <> pg_backend_pid()`);
      await this.exec(['dropdb', '-U', this.target.user, '--if-exists', name]);
      dropped.push(name);
    }
    return dropped;
  }

  /** @description Read every base table's row count. @param database Which database. @returns name → count. */
  private async counts(database: string): Promise<Record<string, number>> {
    const raw = await this.psql(database, COUNT_ALL_TABLES);
    const counts: Record<string, number> = {};
    for (const line of raw.split('\n').map(item => item.trim()).filter(Boolean)) {
      const split = line.lastIndexOf('=');
      if (split > 0) counts[line.slice(0, split)] = Number(line.slice(split + 1));
    }
    return counts;
  }

  /**
   * @description Dump the source to a file and believe pg_dump's exit code, then confirm the file
   * carries pg_dump's own completion marker. The marker is what makes a truncated dump — the shape
   * a cancelled run leaves — visible rather than restorable.
   * @param dumpPath Where the dump lands inside the container.
   * @returns True when both the exit code and the marker say the dump is whole.
   */
  private async dump(dumpPath: string): Promise<boolean> {
    try {
      await this.exec(['pg_dump', '-U', this.target.user, '-d', this.target.database,
        '--no-owner', '--no-privileges', '-f', dumpPath]);
      this.ledger.set(check('dump-succeeded', 'pg_dump completed with a zero exit status', true, `pg_dump -d ${this.target.database} -f ${dumpPath}`));
    } catch (error) {
      const why = this.state.aborted ? `aborted: ${this.state.aborted}` : (error as Error).message;
      this.ledger.set(check('dump-succeeded', 'pg_dump completed with a zero exit status', false, why));
      this.ledger.set(check('dump-complete', 'The dump file carries pg_dump\'s completion marker', false, 'no dump to inspect'));
      return false;
    }
    const tail = await this.exec(['sh', '-c', `tail -c 512 ${dumpPath}`]);
    const complete = tail.includes('PostgreSQL database dump complete');
    this.ledger.set(check('dump-complete', 'The dump file carries pg_dump\'s completion marker', complete,
      complete ? 'trailing marker present' : `trailing bytes carry no completion marker: ${JSON.stringify(tail.slice(-120))}`));
    return complete;
  }

  /**
   * @description Restore the dump into the throwaway with ON_ERROR_STOP=1, so the first error ends
   * the restore with a non-zero status instead of leaving a partially loaded database behind.
   * @param dumpPath The dump file inside the container.
   * @returns True when psql exited zero.
   */
  private async restore(dumpPath: string): Promise<boolean> {
    try {
      await this.exec(['psql', '-v', 'ON_ERROR_STOP=1', '-U', this.target.user, '-d', this.throwaway, '-f', dumpPath]);
      this.ledger.set(check('restore-succeeded', 'psql restored the dump with no error and a zero exit status', true, `psql -v ON_ERROR_STOP=1 -d ${this.throwaway} -f ${dumpPath}`));
      return true;
    } catch (error) {
      const why = this.state.aborted ? `aborted: ${this.state.aborted}` : (error as Error).message;
      this.ledger.set(check('restore-succeeded', 'psql restored the dump with no error and a zero exit status', false, why));
      return false;
    }
  }

  /**
   * @description Compare the restored database against the source across EVERY base table, which is
   * what the single `agents` equality could not do: a partial restore that happened to carry that
   * one table passed.
   * @param before Source counts.
   * @returns The restored counts.
   */
  private async compare(before: Record<string, number>): Promise<Record<string, number>> {
    const after = await this.counts(this.throwaway);
    const missing = Object.keys(before).filter(name => !(name in after));
    this.ledger.set(check('table-set-complete', 'Every source base table exists in the restore', missing.length === 0,
      missing.length ? `missing after restore: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ''}`
        : `${Object.keys(before).length} table(s) present on both sides`));
    const differing = Object.keys(before).filter(name => before[name] !== after[name]);
    this.ledger.set(check('row-counts-equal', 'Every table holds the same number of rows after restore', differing.length === 0,
      differing.length ? differing.slice(0, 10).map(name => `${name}: ${before[name]} -> ${after[name] ?? 'absent'}`).join('; ')
        : `${Object.keys(before).length} table(s) matched, ${Object.values(before).reduce((sum, n) => sum + n, 0)} row(s) total`));
    return after;
  }

  /**
   * @description Drop the scratch database and its dump file, and prove afterwards that the source
   * is still there with the table set it started with. The drop is refused unless the name is one
   * this run minted, so no path through here can reach operator data.
   * @param dumpPath The dump file inside the container.
   * @param sourceTables The source table set read before the dump.
   * @returns Nothing.
   */
  private async cleanup(dumpPath: string, sourceTables: string[]): Promise<void> {
    await this.terminateOwnBackends();
    try { await this.exec(['sh', '-c', `rm -f ${dumpPath}`], CLEANUP_BOUNDS); } catch { /* a dump that never existed */ }
    let dropped = false;
    let detail = `refused: "${this.throwaway}" is not a minted throwaway name`;
    if (isDroppableThrowaway(this.throwaway, this.target.database)) {
      try {
        await this.psql('postgres', `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = '${this.throwaway}' and pid <> pg_backend_pid()`, CLEANUP_BOUNDS);
        await this.exec(['dropdb', '-U', this.target.user, '--if-exists', this.throwaway], CLEANUP_BOUNDS);
        dropped = true;
        detail = `dropdb --if-exists ${this.throwaway}`;
      } catch (error) { detail = (error as Error).message; }
    }
    const remaining = await this.databases().catch(() => [] as string[]);
    this.ledger.set(check('throwaway-dropped', 'The scratch database is gone', dropped && !remaining.includes(this.throwaway), detail));
    const orphans = remaining.filter(name => isDroppableThrowaway(name, this.target.database));
    this.ledger.set(check('no-orphan-databases', 'No throwaway database is left on the server', orphans.length === 0,
      orphans.length ? `left behind: ${orphans.join(', ')}` : 'none present'));
    // A run that was aborted before it read the source table set cannot confirm intactness, and
    // saying "the table set is not what it was" about it would be a false claim rather than a
    // cautious one. It still fails — unconfirmed is not confirmed — but it says which it is.
    const present = remaining.includes(this.target.database);
    const names = present ? await this.tableNames(this.target.database).catch(() => null) : null;
    const intact = names !== null && sourceTables.length > 0 && sameSet(names, sourceTables);
    const evidence = !present ? `the source database ${this.target.database} is no longer on the server`
      : names === null ? 'the source database could not be re-read'
        : sourceTables.length === 0 ? 'unconfirmed: the run ended before it read the source table set'
          : intact ? `${sourceTables.length} table(s) still present` : `table set changed: ${sourceTables.length} before, ${names.length} now`;
    this.ledger.set(check('source-intact', `The source database ${this.target.database} survived unchanged in shape`, intact, evidence));
  }

  /**
   * @description Run the whole round trip under the watcher, converting every failure into a failed
   * check rather than an exception, so a caller's publication gate is the single decision point.
   * @returns The proof, complete with every required check.
   */
  async run(): Promise<BackupRestoreProof> {
    const empty: BackupRestoreProof = {
      throwaway: this.throwaway, sourceDatabase: this.target.database, tables: [],
      before: {}, after: {}, sweptOrphans: [], checks: this.ledger.list(),
    };
    if (existsSync(this.deployLockPath)) {
      this.ledger.set(check('deploy-idle', 'No deployment held the lock when this diagnostic started', false,
        `${this.deployLockPath} exists — a deploy is in flight; nothing was run`));
      return { ...empty, checks: this.ledger.list() };
    }
    if (!MINTED_NAME.test(this.throwaway) || this.throwaway === this.target.database) {
      this.ledger.set(check('deploy-idle', 'No deployment held the lock when this diagnostic started', true, `${this.deployLockPath} absent`));
      this.ledger.set(check('throwaway-dropped', 'The scratch database is gone', false,
        `refused: "${this.throwaway}" is not a minted throwaway name; nothing was created or dropped`));
      return { ...empty, checks: this.ledger.list() };
    }
    this.ledger.set(check('deploy-idle', 'No deployment held the lock when this diagnostic started', true, `${this.deployLockPath} absent`));
    return this.execute(empty);
  }

  /**
   * @description The part of the run that touches the database, split out to keep `run` short.
   * @param empty The zero-value proof the ledger is folded into.
   * @returns The proof.
   */
  private async execute(empty: BackupRestoreProof): Promise<BackupRestoreProof> {
    const stop = this.startWatcher();
    const dumpPath = `/tmp/${this.throwaway}.sql`;
    let before: Record<string, number> = {};
    let after: Record<string, number> = {};
    let swept: string[] = [];
    try {
      swept = await this.sweepOrphans(await this.databases());
      before = await this.counts(this.target.database);
      await this.exec(['createdb', '-U', this.target.user, this.throwaway]);
      if (await this.dump(dumpPath) && await this.restore(dumpPath)) after = await this.compare(before);
    } catch (error) {
      const why = this.state.aborted ? `aborted: ${this.state.aborted}` : (error as Error).message;
      this.ledger.set(check('dump-succeeded', 'pg_dump completed with a zero exit status', false, why));
    } finally {
      stop();
      // A deploy that appeared mid-run is the same fact as a deploy that was already holding the
      // lock when this started, so it reports through the same check rather than a second one.
      if (this.state.aborted?.includes('deployment')) {
        this.ledger.set(check('deploy-idle', 'No deployment held the lock when this diagnostic started', false, this.state.aborted));
      }
      await this.cleanup(dumpPath, Object.keys(before)).catch(() => { /* the ledger already says failed */ });
    }
    return {
      ...empty, tables: Object.keys(before), before, after, sweptOrphans: swept,
      abortedReason: this.state.aborted, checks: this.ledger.list(),
    };
  }
}

/** @description Whether two name lists hold the same members. @param left First list. @param right Second list. @returns True when equal as sets. */
function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(right);
  return left.every(name => seen.has(name));
}

/**
 * @description Run a bounded, deploy-aware pg_dump/restore round trip and report what it observed.
 * It never throws for a proof failure and never publishes anything: pair it with
 * `backupProofAccepted` at the point where evidence would be written.
 * @param options The target container/database and the bounds to run under.
 * @returns The proof, carrying every required check whether or not the run reached it.
 */
export async function runBackupRestoreProof(options: BackupRestoreOptions): Promise<BackupRestoreProof> {
  return new BackupRestoreRun(options).run();
}
