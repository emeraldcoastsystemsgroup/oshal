/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist exact-caller runs, idempotent admission, cancellation and crash leases in PostgreSQL.
 */
import type { Pool } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { InstalledAppTestResult } from '@/features/swarm-apps';
import type { TestLabPrincipal, TestLabRun, TestLabRunState, TestLabRunStore } from './test-lab-run-types';

function decoded(row: Record<string, any> | undefined): TestLabRun | null {
  if (!row) return null;
  return { id: row.id, requestId: row.request_id, actor: { issuer: row.issuer, sub: row.user_sub },
    test: row.test, state: row.state, createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(), ...(row.result ? { result: row.result } : {}) };
}

/** Durable control-plane store; every user lookup additionally binds both principal fields. */
export class PostgresTestLabRunStore implements TestLabRunStore {
  constructor(private readonly pool: Pool, private readonly ready: Promise<unknown> = Promise.resolve(),
    private readonly recoverExecution?: (ids: string[]) => Promise<boolean>) {}

  private async query(sql: string, args: unknown[] = []) {
    await this.ready;
    return runWithSystemIdentity(() => this.pool.query(sql, args));
  }

  private async recover(): Promise<void> {
    await this.query(`UPDATE oshal_test_lab_runs SET state='interrupted',updated_at=NOW(),result=NULL
      WHERE state='queued' AND lease_until<NOW()`);
    const expired = await this.query("SELECT id FROM oshal_test_lab_runs WHERE state IN ('running','cancelling') AND lease_until<NOW()");
    if (!expired.rows.length || !this.recoverExecution) return;
    const ids = expired.rows.map(row => String(row.id));
    let timer: NodeJS.Timeout | undefined;
    try {
      const cleaned = await Promise.race([this.recoverExecution(ids),new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false),10000);
      })]);
      if (!cleaned) return;
      await this.query(`UPDATE oshal_test_lab_runs SET state=CASE WHEN state='cancelling' THEN 'cancelled' ELSE 'interrupted' END,
        updated_at=NOW(),result=NULL WHERE id=ANY($1::uuid[]) AND state IN ('running','cancelling') AND lease_until<NOW()`,[ids]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /** @description Admit once per caller request and refuse overlapping runs of one case.
   * @param run Server-owned exact run snapshot. @returns Newly stored or identical previously admitted run.
   */
  async create(run: TestLabRun): Promise<TestLabRun> {
    await this.recover();
    try {
      const result = await this.query(`INSERT INTO oshal_test_lab_runs(id,issuer,user_sub,request_id,app_name,case_id,state,test)
        VALUES($1,$2,$3,$4,$5,$6,'queued',$7) ON CONFLICT(issuer,user_sub,request_id) DO NOTHING RETURNING *`,
      [run.id,run.actor.issuer,run.actor.sub,run.requestId,run.test.appName,run.test.id,JSON.stringify(run.test)]);
      if (result.rows[0]) return decoded(result.rows[0])!;
    } catch (error: any) {
      if (error.code === '23505') throw Object.assign(new Error('The package runner is busy. Wait for the active run to finish.'), { status: 409 });
      throw error;
    }
    const prior = await this.query('SELECT * FROM oshal_test_lab_runs WHERE issuer=$1 AND user_sub=$2 AND request_id=$3',
      [run.actor.issuer,run.actor.sub,run.requestId]);
    return decoded(prior.rows[0])!;
  }

  /** @description Read a run only for its exact original caller. @param actor Verified current caller. @param id Run UUID. @returns Matching run, if any. */
  async get(actor: TestLabPrincipal, id: string): Promise<TestLabRun | null> {
    await this.recover();
    return decoded((await this.query('SELECT * FROM oshal_test_lab_runs WHERE issuer=$1 AND user_sub=$2 AND id=$3',
      [actor.issuer,actor.sub,id])).rows[0]);
  }

  /** @description List bounded metadata after application filtering, without stored output bytes.
   * @param actor Verified caller. @param apps Currently readable applications. @returns Latest fifty matching runs.
   */
  async list(actor: TestLabPrincipal, apps: string[]): Promise<TestLabRun[]> {
    await this.recover();
    const result = await this.query(`SELECT id,issuer,user_sub,request_id,state,test,created_at,updated_at FROM oshal_test_lab_runs
      WHERE issuer=$1 AND user_sub=$2 AND app_name=ANY($3::text[]) ORDER BY created_at DESC,id DESC LIMIT 50`, [actor.issuer,actor.sub,apps]);
    return result.rows.map(row => decoded(row)!);
  }

  /** @description Claim queued work once. @param actor Original caller. @param id Run UUID. @returns Whether this service acquired execution. */
  async begin(actor: TestLabPrincipal, id: string): Promise<boolean> {
    return (await this.query(`UPDATE oshal_test_lab_runs SET state='running',updated_at=NOW(),lease_until=NOW()+INTERVAL '60 seconds'
      WHERE issuer=$1 AND user_sub=$2 AND id=$3 AND state='queued' AND lease_until>=NOW() RETURNING id`, [actor.issuer,actor.sub,id])).rows.length === 1;
  }

  /** @description Renew a live lease and observe cancellation from another API process.
   * @param actor Original caller. @param id Run UUID. @returns Current active state, or null when retired.
   */
  async pulse(actor: TestLabPrincipal, id: string): Promise<TestLabRunState | null> {
    const result = await this.query(`UPDATE oshal_test_lab_runs SET lease_until=NOW()+INTERVAL '60 seconds'
      WHERE issuer=$1 AND user_sub=$2 AND id=$3 AND state IN ('running','cancelling') AND lease_until>=NOW() RETURNING state`, [actor.issuer,actor.sub,id]);
    return result.rows[0]?.state ?? null;
  }

  /** @description Request cancellation durably without changing already completed evidence.
   * @param actor Current exact owner. @param id Run UUID. @returns Current run, if owned.
   */
  async cancel(actor: TestLabPrincipal, id: string): Promise<TestLabRun | null> {
    await this.query(`UPDATE oshal_test_lab_runs SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'cancelling' END,updated_at=NOW()
      WHERE issuer=$1 AND user_sub=$2 AND id=$3 AND state IN ('queued','running')`, [actor.issuer,actor.sub,id]);
    return this.get(actor,id);
  }

  /** @description Publish only a live owner's terminal result; cancellation wins a completion race.
   * @param actor Original caller. @param id Run UUID. @param state Terminal outcome. @param result Bounded runner evidence.
   * @returns Completion of conditional persistence.
   */
  async finish(actor: TestLabPrincipal, id: string, state: TestLabRunState, result: InstalledAppTestResult): Promise<void> {
    await this.query(`UPDATE oshal_test_lab_runs SET state=CASE WHEN state='cancelling' THEN 'cancelled' ELSE $4 END,
      result=CASE WHEN state='cancelling' THEN NULL ELSE $5::jsonb END,updated_at=NOW()
      WHERE issuer=$1 AND user_sub=$2 AND id=$3 AND state IN ('running','cancelling') AND lease_until>=NOW()`,
    [actor.issuer,actor.sub,id,state,JSON.stringify(result)]);
  }
}
