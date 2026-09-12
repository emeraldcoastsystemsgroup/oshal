/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Admit exact-owner schedules and atomically lease catalog batches across local API processes.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { TestLabPrincipal } from './test-lab-run-types';
import { testLabCadenceMs, type TestLabScheduleStore, type TestLabScheduleInput, type TestLabSchedule,
  type TestLabScheduleBatch, type TestLabScheduleClaim, type TestLabBatchSummary } from './test-lab-schedule-types';

const emptySummary = (): TestLabBatchSummary => ({ selected: 0, deferred: 0, unavailable: [], drift: [], runs: [] });
function schedule(row: Record<string, any>): TestLabSchedule {
  return { id: row.id,actor: { issuer: row.issuer,sub: row.user_sub },appName: row.app_name,levels: row.levels,cadence: row.cadence,
    enabled: row.enabled,revision: row.revision,nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),updatedAt: new Date(row.updated_at).toISOString() };
}
function batch(row: Record<string, any>): TestLabScheduleBatch {
  return { id: row.id,scheduleId: row.schedule_id,actor: { issuer: row.issuer,sub: row.user_sub },requestId: row.request_id,
    scheduleRevision: row.schedule_revision,oneOff: row.one_off,state: row.state,summary: row.summary,
    createdAt: new Date(row.created_at).toISOString(),updatedAt: new Date(row.updated_at).toISOString() };
}
function refused(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }

/** @description Durable local scheduling with principal-qualified lookups and conditional lease updates. */
export class PostgresTestLabScheduleStore implements TestLabScheduleStore {
  constructor(private readonly pool: Pool, private readonly ready: Promise<unknown> = Promise.resolve()) {}

  private async query(sql: string, values: unknown[] = []) {
    await this.ready; return runWithSystemIdentity(() => this.pool.query(sql,values));
  }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ready;
    return runWithSystemIdentity(async () => {
      const client = await this.pool.connect();
      try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    });
  }
  private async recover(client: PoolClient): Promise<void> {
    await client.query("UPDATE oshal_test_lab_schedule_batches SET state='interrupted',updated_at=NOW() WHERE state='running' AND lease_until<NOW()");
  }
  private async insertBatch(client: PoolClient, item: TestLabSchedule, requestId: string, oneOff: boolean): Promise<TestLabScheduleBatch> {
    const result = await client.query(`INSERT INTO oshal_test_lab_schedule_batches
      (id,schedule_id,issuer,user_sub,request_id,schedule_revision,one_off,state,summary)
      VALUES($1,$2,$3,$4,$5,$6,$7,'running',$8) RETURNING *`,
    [randomUUID(),item.id,item.actor.issuer,item.actor.sub,requestId,item.revision,oneOff,JSON.stringify(emptySummary())]);
    return batch(result.rows[0]);
  }

  /** @description Save one disabled selector per exact owner/application. @param actor Verified owner.
   * @param input Validated closed selector. @returns New disabled schedule. */
  async create(actor: TestLabPrincipal, input: TestLabScheduleInput): Promise<TestLabSchedule> {
    try {
      const result = await this.query(`INSERT INTO oshal_test_lab_schedules(id,issuer,user_sub,app_name,levels,cadence)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[randomUUID(),actor.issuer,actor.sub,input.appName,JSON.stringify(input.levels),input.cadence]);
      return schedule(result.rows[0]);
    } catch (error: any) { if (error.code === '23505') refused('A schedule already exists for this application.'); throw error; }
  }
  /** @description List only the original exact owner. @param actor Verified owner. @returns Bounded schedule metadata. */
  async list(actor: TestLabPrincipal): Promise<TestLabSchedule[]> {
    return (await this.query('SELECT * FROM oshal_test_lab_schedules WHERE issuer=$1 AND user_sub=$2 ORDER BY created_at,id LIMIT 100',
      [actor.issuer,actor.sub])).rows.map(schedule);
  }
  /** @description Read one owner-qualified schedule. @param actor Verified owner. @param id Schedule UUID. @returns Owned schedule or null. */
  async get(actor: TestLabPrincipal, id: string): Promise<TestLabSchedule | null> {
    const result = await this.query('SELECT * FROM oshal_test_lab_schedules WHERE issuer=$1 AND user_sub=$2 AND id=$3',[actor.issuer,actor.sub,id]);
    return result.rows[0] ? schedule(result.rows[0]) : null;
  }
  /** @description Apply a revision-checked enable/disable; changing it invalidates active batch authority.
   * @param actor Verified owner. @param id Schedule UUID. @param revision Expected current revision.
   * @param enabled Explicit user choice. @param now Controller clock. @returns Updated schedule or null on conflict. */
  async update(actor: TestLabPrincipal, id: string, revision: number, enabled: boolean, now: Date): Promise<TestLabSchedule | null> {
    const current = await this.get(actor,id); if (!current) return null;
    const next = enabled ? new Date(now.getTime()+testLabCadenceMs(current.cadence)).toISOString() : null;
    const result = await this.query(`UPDATE oshal_test_lab_schedules SET enabled=$5,revision=revision+1,next_run_at=$6,updated_at=NOW()
      WHERE issuer=$1 AND user_sub=$2 AND id=$3 AND revision=$4 RETURNING *`,[actor.issuer,actor.sub,id,revision,enabled,next]);
    return result.rows[0] ? schedule(result.rows[0]) : null;
  }

  /** @description Admit one explicit draft/enabled run with exact retry identity and cross-process capacity.
   * @param actor Verified owner. @param id Schedule UUID. @param revision Expected revision. @param requestId Idempotency UUID.
   * @returns Durable schedule/batch claim; an exact retry returns its original receipt. */
  async claim(actor: TestLabPrincipal, id: string, revision: number, requestId: string): Promise<TestLabScheduleClaim> {
    try { return await this.transaction(async client => {
      await this.recover(client);
      const selected = await client.query('SELECT * FROM oshal_test_lab_schedules WHERE issuer=$1 AND user_sub=$2 AND id=$3 FOR UPDATE',[actor.issuer,actor.sub,id]);
      if (!selected.rows[0]) refused('Schedule not found.',404);
      const item = schedule(selected.rows[0]);
      const prior = await client.query('SELECT * FROM oshal_test_lab_schedule_batches WHERE issuer=$1 AND user_sub=$2 AND request_id=$3',[actor.issuer,actor.sub,requestId]);
      if (prior.rows[0]) {
        const previous = batch(prior.rows[0]);
        if (previous.scheduleId !== id || previous.scheduleRevision !== revision) refused('Retry key belongs to another schedule revision.');
        return { schedule: item,batch: previous,created: false };
      }
      if (item.revision !== revision) refused('Schedule changed. Refresh before running.');
      return { schedule: item,batch: await this.insertBatch(client,item,requestId,true),created: true };
    }); } catch (error: any) { if (error.code === '23505') refused('A scheduled batch is already running.'); throw error; }
  }

  /** @description Claim one due schedule without replaying missed occurrences or overlapping another batch.
   * @param now Controller clock. @returns Newly leased due batch, or null when nothing can run. */
  async claimDue(now: Date): Promise<TestLabScheduleClaim | null> {
    try { return await this.transaction(async client => {
      await this.recover(client);
      if ((await client.query("SELECT 1 FROM oshal_test_lab_schedule_batches WHERE state='running' LIMIT 1")).rows.length) return null;
      const selected = await client.query(`SELECT * FROM oshal_test_lab_schedules WHERE enabled AND next_run_at<=$1
        ORDER BY next_run_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[now.toISOString()]);
      if (!selected.rows[0]) return null;
      const item = schedule(selected.rows[0]), admitted = await this.insertBatch(client,item,randomUUID(),false);
      await client.query('UPDATE oshal_test_lab_schedules SET next_run_at=$2,updated_at=NOW() WHERE id=$1',
        [item.id,new Date(now.getTime()+testLabCadenceMs(item.cadence)).toISOString()]);
      return { schedule: item,batch: admitted,created: true };
    }); } catch (error: any) { if (error.code === '23505') return null; throw error; }
  }
  /** @description Renew only a live unchanged schedule generation; disable and expiry cannot be resurrected.
   * @param item Original durable batch claim. @returns Whether current execution remains leased. */
  async heartbeat(item: TestLabScheduleBatch): Promise<boolean> {
    const result = await this.query(`UPDATE oshal_test_lab_schedule_batches b SET lease_until=NOW()+INTERVAL '60 seconds'
      FROM oshal_test_lab_schedules s WHERE b.id=$1 AND b.issuer=$2 AND b.user_sub=$3 AND b.state='running' AND b.lease_until>=NOW()
      AND s.id=b.schedule_id AND s.revision=b.schedule_revision AND (b.one_off OR s.enabled) RETURNING b.id`,[item.id,item.actor.issuer,item.actor.sub]);
    return result.rows.length === 1;
  }
  /** @description Persist only metadata between sequential suite runs. @param item Active claim.
   * @param summary Bounded evidence links. @returns Completion of conditional persistence. */
  async checkpoint(item: TestLabScheduleBatch, summary: TestLabBatchSummary): Promise<void> {
    await this.query(`UPDATE oshal_test_lab_schedule_batches SET summary=$4,updated_at=NOW()
      WHERE id=$1 AND issuer=$2 AND user_sub=$3 AND state='running' AND lease_until>=NOW()`,[item.id,item.actor.issuer,item.actor.sub,JSON.stringify(summary)]);
  }
  /** @description Finish only the original live claim. @param item Active claim. @param state Terminal state.
   * @param summary Bounded run references and reasons. @returns Completion of conditional persistence. */
  async finish(item: TestLabScheduleBatch, state: TestLabScheduleBatch['state'], summary: TestLabBatchSummary): Promise<void> {
    await this.query(`UPDATE oshal_test_lab_schedule_batches SET state=$4,summary=$5,updated_at=NOW()
      WHERE id=$1 AND issuer=$2 AND user_sub=$3 AND state='running' AND lease_until>=NOW()`,[item.id,item.actor.issuer,item.actor.sub,state,JSON.stringify(summary)]);
  }
  /** @description Read exact-owner batch metadata; private output remains in the existing guarded run service.
   * @param actor Verified owner. @param id Schedule UUID. @returns Latest twenty batches. */
  async history(actor: TestLabPrincipal, id: string): Promise<TestLabScheduleBatch[]> {
    return (await this.query(`SELECT * FROM oshal_test_lab_schedule_batches WHERE issuer=$1 AND user_sub=$2 AND schedule_id=$3
      ORDER BY created_at DESC,id DESC LIMIT 20`,[actor.issuer,actor.sub,id])).rows.map(batch);
  }
}
