/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added dry-run/apply repair for stale Jarvis chat task counters, execution rows, and task shelf states.
 */

import type { Pool } from 'pg';
import { config as loadDotenv } from 'dotenv';
import { createChildLogger } from '../../src/shared/logger';
import { createOptionalPostgresPool, ensureConversationStoreSchema, ensureTicketSchema } from '../../src/shared/services/database';

const logger = createChildLogger({ module: 'scripts/repair-jarvis-task-lifecycle' });

const JARVIS_AGENT_ID = 'a0000000-0000-0000-0000-000000000050';
const DEFAULT_LIMIT = 5000;
const DEFAULT_STALE_MINUTES = 30;

export const HELP_TEXT = [
  'Usage: npm run repair:jarvis-task-lifecycle -- [options]',
  '',
  'Modes:',
  '  (default)             Dry-run only; no database mutations',
  '  --apply               Repair Jarvis chat_tasks and jarvis_tasks rows',
  '',
  'Options:',
  '  --stale-minutes=<n>   Age threshold for zero-message Jarvis execution rows (default: 30)',
  '  --limit=<n>           Max rows to inspect/apply per repair lane (default: 5000)',
  '  --help                Show this help text',
].join('\n');

export interface RepairJarvisOptions {
  mode: 'dry-run' | 'apply';
  staleMinutes: number;
  limit: number;
  showHelp: boolean;
}

export interface RepairJarvisResult {
  sessionBackfillCandidates: number;
  sessionBackfilled: number;
  staleExecutionCandidates: number;
  staleExecutionsFailed: number;
  shelfErrorCandidates: number;
  shelfErrorsMarked: number;
}

export function parseArgs(args: string[]): RepairJarvisOptions {
  const options: RepairJarvisOptions = {
    mode: 'dry-run',
    staleMinutes: DEFAULT_STALE_MINUTES,
    limit: DEFAULT_LIMIT,
    showHelp: false,
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--apply') {
      options.mode = 'apply';
      continue;
    }
    if (arg.startsWith('--stale-minutes=')) {
      options.staleMinutes = parsePositiveInt(arg, '--stale-minutes=', 24 * 60);
      continue;
    }
    if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInt(arg, '--limit=', 50_000);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export async function repairJarvisTaskLifecycle(pool: Pool, options: RepairJarvisOptions): Promise<RepairJarvisResult> {
  const [sessionBackfillCandidates, staleExecutionCandidates, shelfErrorCandidates] = await Promise.all([
    countSessionBackfillCandidates(pool, options.limit),
    countStaleExecutionCandidates(pool, options.staleMinutes, options.limit),
    countShelfErrorCandidates(pool, options.limit),
  ]);

  if (options.mode === 'dry-run') {
    return {
      sessionBackfillCandidates,
      sessionBackfilled: 0,
      staleExecutionCandidates,
      staleExecutionsFailed: 0,
      shelfErrorCandidates,
      shelfErrorsMarked: 0,
    };
  }

  const sessionBackfilled = await applySessionBackfill(pool, options.limit);
  const staleExecutionsFailed = await applyStaleExecutionFailure(pool, options.staleMinutes, options.limit);
  const shelfErrorsMarked = await applyShelfErrorRepair(pool, options.limit);

  return {
    sessionBackfillCandidates,
    sessionBackfilled,
    staleExecutionCandidates,
    staleExecutionsFailed,
    shelfErrorCandidates,
    shelfErrorsMarked,
  };
}

async function countSessionBackfillCandidates(pool: Pool, limit: number): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `WITH candidates AS (${sessionBackfillCandidateSql()})
       SELECT COUNT(*)::text AS count FROM candidates`,
    [limit],
  );
  return Number(rows[0]?.count ?? 0);
}

async function countStaleExecutionCandidates(pool: Pool, staleMinutes: number, limit: number): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `WITH candidates AS (${staleExecutionCandidateSql()})
       SELECT COUNT(*)::text AS count FROM candidates`,
    [staleMinutes, limit],
  );
  return Number(rows[0]?.count ?? 0);
}

async function countShelfErrorCandidates(pool: Pool, limit: number): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `WITH candidates AS (${shelfErrorCandidateSql()})
       SELECT COUNT(*)::text AS count FROM candidates`,
    [limit],
  );
  return Number(rows[0]?.count ?? 0);
}

async function applySessionBackfill(pool: Pool, limit: number): Promise<number> {
  const { rowCount } = await pool.query(
    `WITH candidates AS (${sessionBackfillCandidateSql()})
       UPDATE chat_tasks ct
          SET status = 'active',
              message_count = candidates.message_count,
              turn_count = candidates.turn_count,
              updated_at = candidates.last_message_at,
              metadata = ct.metadata || jsonb_build_object(
                'jarvisLifecycleRepairAt', NOW(),
                'jarvisLifecycleRepairReason', 'message_history_backfill'
              )
         FROM candidates
        WHERE ct.task_id = candidates.task_id`,
    [limit],
  );
  return rowCount ?? 0;
}

async function applyStaleExecutionFailure(pool: Pool, staleMinutes: number, limit: number): Promise<number> {
  const { rowCount } = await pool.query(
    `WITH candidates AS (${staleExecutionCandidateSql()})
       UPDATE chat_tasks ct
          SET status = 'failed',
              updated_at = NOW(),
              metadata = ct.metadata || jsonb_build_object(
                'jarvisLifecycleRepairAt', NOW(),
                'jarvisLifecycleRepairReason', 'stale_zero_message_execution',
                'jarvisLifecycleRepairStaleMinutes', $1
              )
         FROM candidates
        WHERE ct.task_id = candidates.task_id`,
    [staleMinutes, limit],
  );
  return rowCount ?? 0;
}

async function applyShelfErrorRepair(pool: Pool, limit: number): Promise<number> {
  const { rowCount } = await pool.query(
    `WITH candidates AS (${shelfErrorCandidateSql()})
       UPDATE jarvis_tasks jt
          SET status = 'error',
              error = CONCAT('Linked ticket ', candidates.ticket_status),
              finished_at = COALESCE(jt.finished_at, NOW())
         FROM candidates
        WHERE jt.id = candidates.id`,
    [limit],
  );
  return rowCount ?? 0;
}

function sessionBackfillCandidateSql(): string {
  return `
    SELECT
      ct.task_id,
      COUNT(cm.message_id)::integer AS message_count,
      SUM(CASE WHEN cm.role = 'assistant' THEN 1 ELSE 0 END)::integer AS turn_count,
      MAX(cm.created_at) AS last_message_at
    FROM chat_tasks ct
    JOIN chat_messages cm ON cm.task_id = ct.task_id
    WHERE ct.task_id LIKE 'jarvis-%'
      AND ct.task_id NOT LIKE '%::%'
    GROUP BY ct.task_id, ct.status, ct.message_count, ct.turn_count
    HAVING COUNT(cm.message_id) > 0
       AND (
         ct.status IN ('created', 'processing')
         OR ct.message_count <> COUNT(cm.message_id)::integer
         OR ct.turn_count <> SUM(CASE WHEN cm.role = 'assistant' THEN 1 ELSE 0 END)::integer
       )
    ORDER BY MAX(cm.created_at) DESC
    LIMIT $1
  `;
}

function staleExecutionCandidateSql(): string {
  return `
    SELECT ct.task_id
    FROM chat_tasks ct
    LEFT JOIN chat_messages cm ON cm.task_id = ct.task_id
    WHERE ct.agent_id = '${JARVIS_AGENT_ID}'
      AND ct.status = 'processing'
      AND ct.task_id LIKE '%::${JARVIS_AGENT_ID}'
      AND ct.updated_at < NOW() - ($1::text || ' minutes')::interval
    GROUP BY ct.task_id
    HAVING COUNT(cm.message_id) = 0
    ORDER BY MAX(ct.updated_at) DESC
    LIMIT $2
  `;
}

function shelfErrorCandidateSql(): string {
  return `
    SELECT jt.id, t.status AS ticket_status
    FROM jarvis_tasks jt
    JOIN tickets t ON t.ticket_id::text = jt.ticket_id
    WHERE jt.status IN ('queued', 'running', 'summarizing')
      AND t.status IN ('escalated', 'cancelled')
    ORDER BY jt.created_at DESC
    LIMIT $1
  `;
}

function parsePositiveInt(arg: string, prefix: string, max: number): number {
  const parsed = Number.parseInt(arg.slice(prefix.length), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${prefix.slice(0, -1)} value: ${arg}`);
  }
  return Math.min(parsed, max);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  loadDotenv();

  let options: RepairJarvisOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error), usage: HELP_TEXT }, 'Invalid Jarvis task lifecycle repair arguments');
    process.exitCode = 1;
    return;
  }

  if (options.showHelp) {
    logger.info({ usage: HELP_TEXT }, 'Jarvis task lifecycle repair help');
    return;
  }

  const pool = createOptionalPostgresPool('scripts/repair-jarvis-task-lifecycle');
  if (!pool) {
    logger.error({ requiredEnv: ['DATABASE_URL', 'PGHOST/POSTGRES_HOST'] }, 'Postgres configuration missing. Jarvis task lifecycle repair cannot run.');
    process.exitCode = 1;
    return;
  }

  try {
    await ensureConversationStoreSchema(pool);
    await ensureTicketSchema(pool);
    const result = await repairJarvisTaskLifecycle(pool, options);
    logger.info(
      {
        durationMs: Date.now() - startedAt,
        mode: options.mode,
        staleMinutes: options.staleMinutes,
        result,
      },
      options.mode === 'apply'
        ? 'Jarvis task lifecycle repair applied'
        : 'Jarvis task lifecycle repair dry-run complete; re-run with --apply to mutate records',
    );
  } catch (error) {
    logger.error({ err: error, durationMs: Date.now() - startedAt }, 'Jarvis task lifecycle repair failed');
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  void main();
}
