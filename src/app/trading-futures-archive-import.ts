/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Admit owner-scoped archive previews and explicit confirmed imports, retaining durable failures without any order or provider path.
 */
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { isOperatorIdentity } from '@/shared/middleware/authz';
import { normalizeFuturesArchiveConfig, FUTURES_ARCHIVE_CONFIRM, type FuturesArchiveConfig } from './trading-futures-archive-config';
import type { FuturesArchivePlan } from './trading-futures-archive-source';
import { executeFuturesArchiveOffLoop } from './trading-futures-archive-worker';
import { ensureFuturesArchiveSchema } from './trading-futures-archive-schema';
import { persistFuturesArchive } from './trading-futures-archive-persist';

const logger = createChildLogger({ module: 'futures-archive-import' });
/** @description Owned status returned to the console; no raw bar arrays or database credentials. */
export interface FuturesArchiveImport {
  importId: string; status: 'previewing' | 'ready' | 'importing' | 'completed' | 'failed';
  config: FuturesArchiveConfig; plan: FuturesArchivePlan | null; inserted: number | null; unchanged: number | null;
  error: string | null; createdAt: string; updatedAt: string;
}
function mapRow(row: Record<string, any>): FuturesArchiveImport {
  return { importId: row.import_id, status: row.status, config: row.config, plan: row.plan, inserted: row.inserted,
    unchanged: row.unchanged, error: row.error, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}
function assertOperator(owner: string): void {
  if (!isOperatorIdentity(owner)) throw Object.assign(new Error('operator_only'), { statusCode: 403 });
}
async function expireInterrupted(pool: Pool): Promise<void> {
  await pool.query(`UPDATE oshal_trading_futures_archive_imports SET status='failed',error='Archive worker interrupted; create a new preview.',updated_at=clock_timestamp()
    WHERE status IN ('previewing','importing') AND updated_at < now()-interval '20 minutes'`);
}
async function settle(pool: Pool, owner: string, job: FuturesArchiveImport, commit: boolean): Promise<void> {
  try {
    const prepared = await executeFuturesArchiveOffLoop(job.config, commit);
    assertOperator(owner);
    if (commit) await persistFuturesArchive(pool, owner, job.importId, prepared);
    else await pool.query(`UPDATE oshal_trading_futures_archive_imports SET status='ready',plan=$3::jsonb,updated_at=clock_timestamp()
      WHERE import_id=$1 AND owner_sub=$2 AND status='previewing'`, [job.importId, owner, JSON.stringify(prepared.plan)]);
    logger.info({ importId: job.importId, commit }, 'Futures archive job settled');
  } catch (error) {
    logger.error({ err: error, importId: job.importId, commit }, 'Futures archive job failed');
    const message = (error as { publicMessage?: string }).publicMessage ?? 'Archive work failed. No reference data was committed. Check source files, clock, schema and logs, then create a new preview.';
    await pool.query(`UPDATE oshal_trading_futures_archive_imports SET status='failed',error=$3,updated_at=clock_timestamp()
      WHERE import_id=$1 AND owner_sub=$2 AND status=$4`, [job.importId, owner, message, commit ? 'importing' : 'previewing']);
  }
}
function launch(pool: Pool, owner: string, job: FuturesArchiveImport, commit: boolean): void {
  void settle(pool, owner, job, commit).catch(error => logger.error({ err: error, importId: job.importId }, 'Futures import failure receipt unavailable'));
}

/** @description Freeze a validated import envelope and return promptly while the real archive is read off-loop.
 * @param pool - Application pool. @param owner - Authenticated operator. @param raw - Console source settings. @returns Durable preview admission.
 */
export async function previewFuturesArchive(pool: Pool, owner: string, raw: unknown): Promise<FuturesArchiveImport> {
  assertOperator(owner);
  const config = normalizeFuturesArchiveConfig(raw);
  await ensureFuturesArchiveSchema(pool); await expireInterrupted(pool);
  const row = (await pool.query(`INSERT INTO oshal_trading_futures_archive_imports(owner_sub,status,config) VALUES($1,'previewing',$2::jsonb) RETURNING *`, [owner, JSON.stringify(config)])).rows[0];
  const job = mapRow(row); launch(pool, owner, job, false);
  logger.info({ importId: job.importId, roots: config.roots }, 'Futures archive preview admitted');
  return job;
}

/** @description Require exact owned preview/citation and typed confirmation before shared reference writes; replay completed receipts without reading files.
 * @param pool - Application pool. @param owner - Authenticated operator. @param importId - Existing owned preview.
 * @param body - Only confirmation and fingerprint. @returns Import admission or completed replay.
 */
export async function confirmFuturesArchive(pool: Pool, owner: string, importId: string, body: unknown): Promise<FuturesArchiveImport> {
  assertOperator(owner);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(importId)) throw Object.assign(new Error('invalid_import_id'), { statusCode: 400 });
  const input = body as Record<string, unknown> | null;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['confirmation','fingerprint'].includes(key))
    || input.confirmation !== FUTURES_ARCHIVE_CONFIRM || typeof input.fingerprint !== 'string') throw Object.assign(new Error('explicit_archive_confirmation_required'), { statusCode: 400 });
  await ensureFuturesArchiveSchema(pool); await expireInterrupted(pool);
  const row = (await pool.query('SELECT * FROM oshal_trading_futures_archive_imports WHERE import_id=$1 AND owner_sub=$2', [importId, owner])).rows[0];
  if (!row) throw Object.assign(new Error('owned_archive_preview_not_found'), { statusCode: 404 });
  if (row.plan?.fingerprint !== input.fingerprint) throw Object.assign(new Error('archive_preview_fingerprint_mismatch'), { statusCode: 409 });
  if (row.status === 'completed') return mapRow(row);
  const claimed = (await pool.query(`UPDATE oshal_trading_futures_archive_imports SET status='importing',updated_at=clock_timestamp()
    WHERE import_id=$1 AND owner_sub=$2 AND status='ready' RETURNING *`, [importId, owner])).rows[0];
  if (!claimed) throw Object.assign(new Error('archive_preview_not_ready'), { statusCode: 409 });
  const job = mapRow(claimed); launch(pool, owner, job, true);
  logger.info({ importId }, 'Futures shared archive import explicitly confirmed');
  return job;
}

/** @description Read only this caller's recent previews/receipts even on an operator-scoped connection.
 * @param pool - Application pool. @param owner - Authenticated caller. @returns Bounded owner-qualified history.
 */
export async function listFuturesArchiveImports(pool: Pool, owner: string): Promise<FuturesArchiveImport[]> {
  await ensureFuturesArchiveSchema(pool);
  return (await pool.query('SELECT * FROM oshal_trading_futures_archive_imports WHERE owner_sub=$1 ORDER BY created_at DESC LIMIT 20', [owner])).rows.map(mapRow);
}
