/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Serialize per-execution start, phase challenges and completion without global policy locks.
 */
import type { Pool } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { RemoteExecutionError, type RemoteExecutionRecord, type RemoteExecutionStore } from './types';

/** @description PostgreSQL authority for exact immutable execution provenance and one-time phase challenges. */
export class PostgresRemoteExecutionStore implements RemoteExecutionStore {
  /** @description Bind the controller pool and schema readiness.
   * @param pool Controller pool. @param ready Required schema readiness. @returns The repository instance.
   */
  constructor(private readonly pool: Pool, private readonly ready: Promise<unknown> = Promise.resolve()) {}
  /** @description Record a prepared execution without overwriting any existing reference.
   * @param record Controller-created provenance. @returns Durable insertion completion.
   */
  async insert(record: RemoteExecutionRecord): Promise<void> {
    await this.ready;
    await runWithSystemIdentity(() => this.pool.query('INSERT INTO oshal_application_remote_executions(execution_id,payload) VALUES($1,$2)',
      [record.binding.executionId, record]));
  }
  /** @description Read one exact reference with controller-only database authority.
   * @param executionId Opaque reference. @returns Stored provenance or null.
   */
  async read(executionId: string): Promise<RemoteExecutionRecord | null> {
    await this.ready;
    const result = await runWithSystemIdentity(() => this.pool.query('SELECT payload FROM oshal_application_remote_executions WHERE execution_id=$1', [executionId]));
    return result.rows[0]?.payload ?? null;
  }
  /** @description Find all signed execution bindings, including foreign owners and linked aggregate tasks.
   * @param taskId Stored task ID. @returns Matching records that can have produced output.
   */
  async byTask(taskId: string): Promise<RemoteExecutionRecord[]> {
    await this.ready;
    const result = await runWithSystemIdentity(() => this.pool.query(`SELECT payload FROM oshal_application_remote_executions
      WHERE (payload->'binding'->>'taskId'=$1 OR payload->'binding'->>'workspaceId'=$1 OR payload->'resultTaskIds' ? $1)
        AND (payload->>'status' IN ('completed','revoked') OR jsonb_array_length(COALESCE(payload->'resultTaskIds','[]'::jsonb))>0)
      ORDER BY execution_id`, [taskId]));
    return result.rows.map(row => row.payload);
  }
  /** @description Atomically compare and persist a transition without holding a client during live policy reads.
   * @param executionId Opaque reference. @param operation Mutation on an isolated snapshot. @returns Winning operation result.
   */
  async update<T>(executionId: string, operation: (record: RemoteExecutionRecord) => Promise<T>): Promise<T> {
    await this.ready;
    const original = await this.read(executionId);
    if (!original) throw new RemoteExecutionError('remote_execution_unavailable');
    const record = structuredClone(original);
    const result = await operation(record);
    const written = await runWithSystemIdentity(() => this.pool.query(`UPDATE oshal_application_remote_executions
      SET payload=$2,updated_at=NOW() WHERE execution_id=$1 AND payload=$3::jsonb`, [executionId, record, original]));
    if (written.rowCount !== 1) throw new RemoteExecutionError('remote_execution_concurrent_change', 409);
    return result;
  }
}

/** @description Isolated repository implementing the same transaction contract without a deployment database. */
export class MemoryRemoteExecutionStore implements RemoteExecutionStore {
  private readonly rows = new Map<string, RemoteExecutionRecord>();
  private tail: Promise<void> = Promise.resolve();
  /** @description Insert independent fixture provenance.
   * @param record Prepared record. @returns Completion after duplicate checking.
   */
  async insert(record: RemoteExecutionRecord): Promise<void> {
    if (this.rows.has(record.binding.executionId)) throw new Error('Duplicate remote execution');
    this.rows.set(record.binding.executionId, structuredClone(record));
  }
  /** @description Read a defensive copy after prior fixture transactions.
   * @param executionId Opaque reference. @returns Stored record or null.
   */
  async read(executionId: string): Promise<RemoteExecutionRecord | null> {
    await this.tail; return structuredClone(this.rows.get(executionId) ?? null);
  }
  /** @description Find all non-prepared lineage, independent of caller authority.
   * @param taskId Task/workspace. @returns Matching copies.
   */
  async byTask(taskId: string): Promise<RemoteExecutionRecord[]> {
    await this.tail;
    return structuredClone([...this.rows.values()].filter(row => (['completed','revoked'].includes(row.status) || Boolean(row.resultTaskIds?.length))
      && (row.binding.taskId === taskId || row.binding.workspaceId === taskId || row.resultTaskIds?.includes(taskId))));
  }
  /** @description Serialize fixture transactions and commit only successful mutations.
   * @param executionId Opaque reference. @param operation Isolated mutation. @returns Operation result.
   */
  async update<T>(executionId: string, operation: (record: RemoteExecutionRecord) => Promise<T>): Promise<T> {
    const previous = this.tail; let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; }); await previous;
    try {
      const record = structuredClone(this.rows.get(executionId));
      if (!record) throw new RemoteExecutionError('remote_execution_unavailable');
      const result = await operation(record); this.rows.set(executionId, record); return result;
    } finally { release(); }
  }
}
