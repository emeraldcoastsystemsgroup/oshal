/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added surgical runtime-state cleanup script for stale chat_tasks, stale swarm_runs, and optional orphaned work_items with dry-run/apply modes
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added automatic .env loading for local operator usability so cleanup script can resolve Postgres config without manual shell export
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { config as loadDotenv } from 'dotenv';
import { createChildLogger } from '../src/shared/logger';
import {
  createOptionalPostgresPool,
  ensureConversationStoreSchema,
  ensureSwarmRunStoreSchema,
  ensureTicketSchema,
  ensureWorkItemSchema,
} from '../src/shared/services/database';

const logger = createChildLogger({ module: 'scripts/runtime-state-cleanup' });

const HELP_TEXT = [
  'Usage: npm run cleanup:runtime-state -- [options]',
  '',
  'Modes:',
  '  (default)        Dry-run only (no mutations)',
  '  --apply          Execute cleanup mutations',
  '',
  'Options:',
  '  --created-minutes=<n>         Age threshold for created-task deletion (default: 30)',
  '  --created-sources=<csv>       Source allow-list for created-task deletion (default: swarmbot-chat)',
  '  --stuck-hours=<n>             Age threshold for active/processing tasks (default: 6)',
  '  --stuck-sources=<csv>         Source allow-list for stale active/processing tasks (default: swarmbot-chat,none)',
  '  --run-hours=<n>               Age threshold for stale in_progress swarm_runs (default: 2)',
  '  --include-orphan-work-items   Detect/escalate orphan work_items with missing swarm_run rows',
  '  --orphan-hours=<n>            Age threshold for orphan work_items (default: 6)',
  '  --help                        Show this help text',
].join('\n');

const DEFAULT_CREATED_TASK_AGE_MINUTES = 30;
const DEFAULT_STALE_TASK_AGE_HOURS = 6;
const DEFAULT_STALE_RUN_AGE_HOURS = 2;
const DEFAULT_ORPHAN_WORK_ITEM_AGE_HOURS = 6;
const DEFAULT_CREATED_SOURCES = ['swarmbot-chat'];
const DEFAULT_STUCK_SOURCES = ['swarmbot-chat', 'none'];

const STALE_TASK_STATUSES = ['active', 'processing'] as const;
const BLOCKING_WORK_ITEM_STATUSES = [
  'pending',
  'assigned',
  'executing',
  'in-review',
  'subtask-pending',
  'subtask-assigned',
  'subtask-executing',
];
const ORPHAN_WORK_ITEM_STATUSES = [...BLOCKING_WORK_ITEM_STATUSES];

type CleanupMode = 'dry-run' | 'apply';

interface CleanupOptions {
  mode: CleanupMode;
  showHelp: boolean;
  createdTaskAgeMinutes: number;
  staleTaskAgeHours: number;
  staleRunAgeHours: number;
  orphanWorkItemAgeHours: number;
  createdSources: string[];
  stuckSources: string[];
  includeOrphanWorkItems: boolean;
}

interface CreatedTaskCandidate {
  taskId: string;
  taskSource: string;
  createdAt: string;
  updatedAt: string;
}

interface StaleTaskCandidate {
  taskId: string;
  status: string;
  taskSource: string;
  messageCount: number;
  updatedAt: string;
}

interface StaleRunCandidate {
  runId: string;
  provider: string;
  startedAt: string;
  updatedAt: string;
  totalWorkItems: number;
  blockingWorkItems: number;
}

interface OrphanWorkItemCandidate {
  workItemId: string;
  swarmRunId: string;
  status: string;
  updatedAt: string;
}

interface CleanupPlan {
  createdTasks: CreatedTaskCandidate[];
  staleTasks: StaleTaskCandidate[];
  staleRuns: StaleRunCandidate[];
  orphanWorkItems: OrphanWorkItemCandidate[];
}

interface CleanupApplyResult {
  deletedCreatedTasks: number;
  failedStaleTasks: number;
  failedStaleRuns: number;
  escalatedOrphanWorkItems: number;
}

/**
 * @description Script entry point.
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  loadEnvironmentDefaults();
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    logger.info({ usage: HELP_TEXT }, 'Runtime-state cleanup help');
    return;
  }

  const pool = createOptionalPostgresPool('scripts/runtime-state-cleanup');
  if (!pool) {
    logger.error(
      {
        requiredEnv: ['DATABASE_URL', 'PGHOST/POSTGRES_HOST'],
      },
      'Postgres configuration missing. Cleanup cannot run.',
    );
    process.exitCode = 1;
    return;
  }

  try {
    await ensureSchemas(pool);
    const plan = await buildCleanupPlan(pool, options);
    logPlan(options, plan);

    if (options.mode === 'apply') {
      const result = await applyCleanup(pool, plan);
      logger.info({ durationMs: Date.now() - startedAt, result }, 'Runtime-state cleanup applied');
      return;
    }

    logger.info(
      { durationMs: Date.now() - startedAt },
      'Runtime-state cleanup dry-run complete; re-run with --apply to mutate records',
    );
  } catch (error) {
    logger.error({ err: error, durationMs: Date.now() - startedAt }, 'Runtime-state cleanup failed');
    process.exitCode = 1;
  } finally {
    await closePool(pool);
  }
}

/**
 * @description Parse and validate CLI arguments.
 */
function parseArgs(args: string[]): CleanupOptions {
  const options = buildDefaultOptions();

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      options.showHelp = true;
      continue;
    }
    if (arg === '--apply') {
      options.mode = 'apply';
      continue;
    }
    if (arg === '--include-orphan-work-items') {
      options.includeOrphanWorkItems = true;
      continue;
    }

    const parsed = splitFlag(arg);
    if (!parsed) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    applyFlagValue(options, parsed.key, parsed.value);
  }

  return options;
}

/**
 * @description Build the default runtime options.
 */
function buildDefaultOptions(): CleanupOptions {
  return {
    mode: 'dry-run',
    showHelp: false,
    createdTaskAgeMinutes: DEFAULT_CREATED_TASK_AGE_MINUTES,
    staleTaskAgeHours: DEFAULT_STALE_TASK_AGE_HOURS,
    staleRunAgeHours: DEFAULT_STALE_RUN_AGE_HOURS,
    orphanWorkItemAgeHours: DEFAULT_ORPHAN_WORK_ITEM_AGE_HOURS,
    createdSources: [...DEFAULT_CREATED_SOURCES],
    stuckSources: [...DEFAULT_STUCK_SOURCES],
    includeOrphanWorkItems: false,
  };
}

/**
 * @description Split one key=value CLI flag.
 */
function splitFlag(arg: string): { key: string; value: string } | null {
  if (!arg.startsWith('--') || !arg.includes('=')) {
    return null;
  }
  const [key, ...valueParts] = arg.slice(2).split('=');
  return { key, value: valueParts.join('=').trim() };
}

/**
 * @description Apply one parsed key/value flag onto runtime options.
 */
function applyFlagValue(options: CleanupOptions, key: string, value: string): void {
  switch (key) {
    case 'created-minutes':
      options.createdTaskAgeMinutes = parsePositiveInteger(value, key);
      return;
    case 'created-sources':
      options.createdSources = parseSourceList(value, DEFAULT_CREATED_SOURCES);
      return;
    case 'stuck-hours':
      options.staleTaskAgeHours = parsePositiveInteger(value, key);
      return;
    case 'stuck-sources':
      options.stuckSources = parseSourceList(value, DEFAULT_STUCK_SOURCES);
      return;
    case 'run-hours':
      options.staleRunAgeHours = parsePositiveInteger(value, key);
      return;
    case 'orphan-hours':
      options.orphanWorkItemAgeHours = parsePositiveInteger(value, key);
      return;
    default:
      throw new Error(`Unknown argument: --${key}`);
  }
}

/**
 * @description Parse a positive integer value from CLI input.
 */
function parsePositiveInteger(raw: string, key: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for --${key}: "${raw}" (expected positive integer)`);
  }
  return parsed;
}

/**
 * @description Parse and normalize comma-delimited source values.
 */
function parseSourceList(raw: string, fallback: string[]): string[] {
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (values.length === 0) {
    return [...fallback];
  }
  return Array.from(new Set(values));
}

/**
 * @description Ensure all dependent schema tables exist before querying.
 */
async function ensureSchemas(pool: Pool): Promise<void> {
  await ensureConversationStoreSchema(pool);
  await ensureTicketSchema(pool);
  await ensureSwarmRunStoreSchema(pool);
  await ensureWorkItemSchema(pool);
}

/**
 * @description Build the candidate cleanup plan without mutating records.
 */
async function buildCleanupPlan(pool: Pool, options: CleanupOptions): Promise<CleanupPlan> {
  const [createdTasks, staleTasks, staleRuns] = await Promise.all([
    findCreatedTaskCandidates(pool, options),
    findStaleTaskCandidates(pool, options),
    findStaleRunCandidates(pool, options),
  ]);
  const orphanWorkItems = options.includeOrphanWorkItems
    ? await findOrphanWorkItemCandidates(pool, options)
    : [];
  return { createdTasks, staleTasks, staleRuns, orphanWorkItems };
}

/**
 * @description Query stale created tasks safe for hard deletion.
 */
async function findCreatedTaskCandidates(pool: Pool, options: CleanupOptions): Promise<CreatedTaskCandidate[]> {
  const result = await pool.query<{
    task_id: string;
    task_source: string;
    created_at: string | Date;
    updated_at: string | Date;
  }>(
    `
      SELECT
        t.task_id,
        COALESCE(t.metadata->>'source', 'none') AS task_source,
        t.created_at,
        t.updated_at
      FROM chat_tasks t
      WHERE t.status = 'created'
        AND t.created_at < NOW() - $1::interval
        AND COALESCE(t.metadata->>'source', 'none') = ANY($2::text[])
        AND COALESCE(t.message_count, 0) = 0
        AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.task_id = t.task_id)
        AND NOT EXISTS (SELECT 1 FROM ticket_task_links l WHERE l.task_id = t.task_id)
      ORDER BY t.created_at ASC
    `,
    [`${options.createdTaskAgeMinutes} minutes`, options.createdSources],
  );

  return result.rows.map((row) => ({
    taskId: row.task_id,
    taskSource: row.task_source,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  }));
}

/**
 * @description Query stale active/processing tasks to be marked failed.
 */
async function findStaleTaskCandidates(pool: Pool, options: CleanupOptions): Promise<StaleTaskCandidate[]> {
  const result = await pool.query<{
    task_id: string;
    status: string;
    task_source: string;
    message_count: number;
    updated_at: string | Date;
  }>(
    `
      SELECT
        t.task_id,
        t.status,
        COALESCE(t.metadata->>'source', 'none') AS task_source,
        COALESCE(t.message_count, 0) AS message_count,
        t.updated_at
      FROM chat_tasks t
      WHERE t.status = ANY($1::text[])
        AND t.updated_at < NOW() - $2::interval
        AND COALESCE(t.metadata->>'source', 'none') = ANY($3::text[])
        AND NOT EXISTS (SELECT 1 FROM ticket_task_links l WHERE l.task_id = t.task_id)
      ORDER BY t.updated_at ASC
    `,
    [[...STALE_TASK_STATUSES], `${options.staleTaskAgeHours} hours`, options.stuckSources],
  );

  return result.rows.map((row) => ({
    taskId: row.task_id,
    status: row.status,
    taskSource: row.task_source,
    messageCount: Number.parseInt(String(row.message_count ?? 0), 10) || 0,
    updatedAt: normalizeDate(row.updated_at),
  }));
}

/**
 * @description Query stale in-progress swarm runs that have no blocking work items.
 */
async function findStaleRunCandidates(pool: Pool, options: CleanupOptions): Promise<StaleRunCandidate[]> {
  const result = await pool.query<{
    run_id: string;
    provider: string;
    started_at: string | Date;
    updated_at: string | Date;
    total_work_items: number;
    blocking_work_items: number;
  }>(
    `
      SELECT
        r.run_id,
        r.provider,
        r.started_at,
        r.updated_at,
        COALESCE(all_items.total_count, 0)::int AS total_work_items,
        COALESCE(blocking.blocking_count, 0)::int AS blocking_work_items
      FROM swarm_runs r
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS total_count
        FROM work_items wi
        WHERE wi.swarm_run_id = r.run_id
      ) all_items ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS blocking_count
        FROM work_items wi
        WHERE wi.swarm_run_id = r.run_id
          AND wi.status = ANY($1::text[])
      ) blocking ON TRUE
      WHERE r.status = 'in_progress'
        AND COALESCE(r.updated_at, r.started_at) < NOW() - $2::interval
        AND COALESCE(blocking.blocking_count, 0) = 0
      ORDER BY r.started_at ASC
    `,
    [BLOCKING_WORK_ITEM_STATUSES, `${options.staleRunAgeHours} hours`],
  );

  return result.rows.map((row) => ({
    runId: row.run_id,
    provider: row.provider,
    startedAt: normalizeDate(row.started_at),
    updatedAt: normalizeDate(row.updated_at),
    totalWorkItems: Number.parseInt(String(row.total_work_items ?? 0), 10) || 0,
    blockingWorkItems: Number.parseInt(String(row.blocking_work_items ?? 0), 10) || 0,
  }));
}

/**
 * @description Query orphan work items referencing missing run records.
 */
async function findOrphanWorkItemCandidates(pool: Pool, options: CleanupOptions): Promise<OrphanWorkItemCandidate[]> {
  const result = await pool.query<{
    work_item_id: string;
    swarm_run_id: string;
    status: string;
    updated_at: string | Date;
  }>(
    `
      SELECT
        wi.work_item_id,
        wi.swarm_run_id,
        wi.status,
        wi.updated_at
      FROM work_items wi
      LEFT JOIN swarm_runs sr ON sr.run_id = wi.swarm_run_id
      WHERE sr.run_id IS NULL
        AND wi.status = ANY($1::text[])
        AND wi.updated_at < NOW() - $2::interval
      ORDER BY wi.updated_at ASC
    `,
    [ORPHAN_WORK_ITEM_STATUSES, `${options.orphanWorkItemAgeHours} hours`],
  );

  return result.rows.map((row) => ({
    workItemId: row.work_item_id,
    swarmRunId: row.swarm_run_id,
    status: row.status,
    updatedAt: normalizeDate(row.updated_at),
  }));
}

/**
 * @description Log dry-run or pre-apply cleanup plan details.
 */
function logPlan(options: CleanupOptions, plan: CleanupPlan): void {
  logger.info(
    {
      mode: options.mode,
      thresholds: {
        createdTaskAgeMinutes: options.createdTaskAgeMinutes,
        staleTaskAgeHours: options.staleTaskAgeHours,
        staleRunAgeHours: options.staleRunAgeHours,
        orphanWorkItemAgeHours: options.orphanWorkItemAgeHours,
      },
      sources: {
        createdSources: options.createdSources,
        stuckSources: options.stuckSources,
      },
      includeOrphanWorkItems: options.includeOrphanWorkItems,
      summary: {
        createdTasksToDelete: plan.createdTasks.length,
        staleTasksToFail: plan.staleTasks.length,
        staleRunsToFail: plan.staleRuns.length,
        orphanWorkItemsToEscalate: plan.orphanWorkItems.length,
      },
      sample: {
        createdTaskIds: firstIds(plan.createdTasks.map((item) => item.taskId)),
        staleTaskIds: firstIds(plan.staleTasks.map((item) => item.taskId)),
        staleRunIds: firstIds(plan.staleRuns.map((item) => item.runId)),
        orphanWorkItemIds: firstIds(plan.orphanWorkItems.map((item) => item.workItemId)),
      },
    },
    'Runtime-state cleanup plan built',
  );
}

/**
 * @description Apply cleanup mutations in one transaction.
 */
async function applyCleanup(pool: Pool, plan: CleanupPlan): Promise<CleanupApplyResult> {
  const client = await pool.connect();
  const cleanupAt = new Date().toISOString();

  try {
    await client.query('BEGIN');
    const deletedCreatedTasks = await deleteCreatedTasks(client, plan.createdTasks);
    const failedStaleTasks = await failStaleTasks(client, plan.staleTasks, cleanupAt);
    const failedStaleRuns = await failStaleRuns(client, plan.staleRuns, cleanupAt);
    const escalatedOrphanWorkItems = await escalateOrphanWorkItems(client, plan.orphanWorkItems, cleanupAt);
    await client.query('COMMIT');

    return {
      deletedCreatedTasks,
      failedStaleTasks,
      failedStaleRuns,
      escalatedOrphanWorkItems,
    };
  } catch (error) {
    await rollbackTransaction(client);
    logger.error({ err: error }, 'Runtime-state cleanup transaction rolled back');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * @description Delete stale created tasks.
 */
async function deleteCreatedTasks(client: PoolClient, candidates: CreatedTaskCandidate[]): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }
  const taskIds = candidates.map((candidate) => candidate.taskId);
  const result = await client.query('DELETE FROM chat_tasks WHERE task_id = ANY($1::text[])', [taskIds]);
  return result.rowCount ?? 0;
}

/**
 * @description Mark stale active/processing tasks as failed.
 */
async function failStaleTasks(client: PoolClient, candidates: StaleTaskCandidate[], cleanupAt: string): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }
  const taskIds = candidates.map((candidate) => candidate.taskId);
  const cleanupMetadata = JSON.stringify({
    cleanup: {
      actor: 'runtime-state-cleanup-script',
      at: cleanupAt,
      reason: 'stale-active-processing-task',
    },
  });
  const result = await client.query(
    `
      UPDATE chat_tasks
      SET
        status = 'failed',
        updated_at = NOW(),
        metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE task_id = ANY($1::text[])
        AND status = ANY($3::text[])
    `,
    [taskIds, cleanupMetadata, [...STALE_TASK_STATUSES]],
  );
  return result.rowCount ?? 0;
}

/**
 * @description Mark stale in-progress swarm runs as failed.
 */
async function failStaleRuns(client: PoolClient, candidates: StaleRunCandidate[], cleanupAt: string): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }
  const runIds = candidates.map((candidate) => candidate.runId);
  const cleanupError = `[runtime-state-cleanup-script @ ${cleanupAt}] Marked failed after exceeding stale-run threshold with no blocking work items.`;
  const result = await client.query(
    `
      UPDATE swarm_runs
      SET
        status = 'failed',
        completed_at = COALESCE(completed_at, NOW()),
        error = CASE
          WHEN error IS NULL OR BTRIM(error) = '' THEN $2
          WHEN POSITION($2 IN error) > 0 THEN error
          ELSE error || E'\n' || $2
        END,
        updated_at = NOW()
      WHERE run_id = ANY($1::text[])
        AND status = 'in_progress'
    `,
    [runIds, cleanupError],
  );
  return result.rowCount ?? 0;
}

/**
 * @description Escalate orphan work items whose swarm run no longer exists.
 */
async function escalateOrphanWorkItems(
  client: PoolClient,
  candidates: OrphanWorkItemCandidate[],
  cleanupAt: string,
): Promise<number> {
  if (candidates.length === 0) {
    return 0;
  }
  const workItemIds = candidates.map((candidate) => candidate.workItemId);
  const cleanupMetadata = JSON.stringify({
    cleanup: {
      actor: 'runtime-state-cleanup-script',
      at: cleanupAt,
      reason: 'orphan-work-item-missing-run',
    },
  });
  const result = await client.query(
    `
      UPDATE work_items
      SET
        status = 'escalated',
        updated_at = NOW(),
        metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE work_item_id = ANY($1::uuid[])
        AND status = ANY($3::text[])
    `,
    [workItemIds, cleanupMetadata, ORPHAN_WORK_ITEM_STATUSES],
  );
  return result.rowCount ?? 0;
}

/**
 * @description Roll back an open transaction safely.
 */
async function rollbackTransaction(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    logger.error({ err: error }, 'Failed to rollback runtime-state cleanup transaction');
  }
}

/**
 * @description Close the pool while preserving the original error path.
 */
async function closePool(pool: Pool): Promise<void> {
  try {
    await pool.end();
  } catch (error) {
    logger.error({ err: error }, 'Failed to close Postgres pool after runtime-state cleanup');
  }
}

/**
 * @description Convert date-like query values into ISO strings.
 */
function normalizeDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date(0).toISOString();
  }
  return date.toISOString();
}

/**
 * @description Return up to five IDs for concise log previews.
 */
function firstIds(ids: string[]): string[] {
  return ids.slice(0, 5);
}

/**
 * @description Load environment defaults from local .env when present.
 * Does not override already-exported shell environment values.
 */
function loadEnvironmentDefaults(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    logger.debug({ envPath }, 'No .env file found for runtime-state cleanup defaults');
    return;
  }

  const result = loadDotenv({ path: envPath, override: false });
  if (result.error) {
    logger.warn({ err: result.error, envPath }, 'Failed to load .env defaults for runtime-state cleanup');
    return;
  }

  logger.info({ envPath }, 'Loaded .env defaults for runtime-state cleanup');
}

if (require.main === module) {
  void main();
}
