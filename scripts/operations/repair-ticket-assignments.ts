/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added dry-run/apply repair for tickets missing assigned_agent_id when lifecycle/work-item evidence identifies the owning bot.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added execution_output.agentId as historical work-item assignment evidence.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { config as loadDotenv } from 'dotenv';
import { createChildLogger } from '../../src/shared/logger';
import { createOptionalPostgresPool, ensureTicketSchema, ensureWorkItemSchema } from '../../src/shared/services/database';

const logger = createChildLogger({ module: 'scripts/repair-ticket-assignments' });

export const HELP_TEXT = [
  'Usage: npm run repair:ticket-assignments -- [options]',
  '',
  'Modes:',
  '  (default)             Dry-run only; no database mutations',
  '  --apply               Backfill ticket assigned_agent_id and ticket_agent_assignments',
  '',
  'Options:',
  '  --limit=<n>           Max candidate rows to inspect/apply (default: 5000)',
  '  --no-worker-bot       Do not resolve legacy escalation metadata.workerBot through agents.name',
  '  --allow-missing-agent Allow backfill when the evidence agent is not in agents',
  '  --help                Show this help text',
].join('\n');

export interface RepairOptions {
  mode: 'dry-run' | 'apply';
  limit: number;
  includeWorkerBot: boolean;
  allowMissingAgent: boolean;
  showHelp: boolean;
}

interface AssignmentCandidate {
  ticketId: string;
  status: string;
  title: string;
  agentId: string;
  evidenceSource: string;
  agentExists: boolean;
  updatedAt: string;
}

interface RepairResult {
  candidates: number;
  applicable: number;
  skippedMissingAgent: number;
  updatedTickets: number;
  recordedAssignments: number;
}

const DEFAULT_LIMIT = 5000;
const UUID_REGEX = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export function parseArgs(args: string[]): RepairOptions {
  const options: RepairOptions = {
    mode: 'dry-run',
    limit: DEFAULT_LIMIT,
    includeWorkerBot: true,
    allowMissingAgent: false,
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
    if (arg === '--no-worker-bot') {
      options.includeWorkerBot = false;
      continue;
    }
    if (arg === '--allow-missing-agent') {
      options.allowMissingAgent = true;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --limit value: ${arg}`);
      }
      options.limit = Math.min(parsed, 50_000);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function buildCandidateSql(includeWorkerBot: boolean): string {
  const workerBotSelect = includeWorkerBot
    ? `
    SELECT
      latest_worker_bot.ticket_id,
      a.agent_id::text AS agent_id,
      'ticket_status_history.metadata.workerBot'::text AS evidence_source
    FROM latest_worker_bot
    JOIN agents a ON lower(a.name) = lower(latest_worker_bot.worker_bot)
    WHERE latest_worker_bot.worker_bot IS NOT NULL
  `
    : `
    SELECT
      NULL::uuid AS ticket_id,
      NULL::text AS agent_id,
      NULL::text AS evidence_source
    WHERE false
  `;

  return `
WITH latest_history_agent AS (
  SELECT DISTINCT ON (h.ticket_id)
    h.ticket_id,
    COALESCE(NULLIF(h.metadata->>'workerAgentId', ''), NULLIF(h.metadata->>'agentId', '')) AS agent_id,
    CASE
      WHEN NULLIF(h.metadata->>'workerAgentId', '') IS NOT NULL THEN 'ticket_status_history.metadata.workerAgentId'
      ELSE 'ticket_status_history.metadata.agentId'
    END AS evidence_source
  FROM ticket_status_history h
  WHERE COALESCE(NULLIF(h.metadata->>'workerAgentId', ''), NULLIF(h.metadata->>'agentId', '')) IS NOT NULL
  ORDER BY h.ticket_id, h.created_at DESC
),
latest_work_item_agent AS (
  SELECT DISTINCT ON (wi.external_id)
    wi.external_id::uuid AS ticket_id,
    wi.assigned_agent_id AS agent_id,
    'work_items.assigned_agent_id'::text AS evidence_source
  FROM work_items wi
  WHERE wi.assigned_agent_id IS NOT NULL
    AND wi.external_id ~ '${UUID_REGEX}'
  ORDER BY wi.external_id, wi.updated_at DESC
),
latest_work_item_output_agent AS (
  SELECT DISTINCT ON (wi.external_id)
    wi.external_id::uuid AS ticket_id,
    NULLIF(wi.execution_output->>'agentId', '') AS agent_id,
    'work_items.execution_output.agentId'::text AS evidence_source
  FROM work_items wi
  WHERE NULLIF(wi.execution_output->>'agentId', '') IS NOT NULL
    AND wi.external_id ~ '${UUID_REGEX}'
  ORDER BY wi.external_id, wi.updated_at DESC
),
latest_worker_bot AS (
  SELECT DISTINCT ON (h.ticket_id)
    h.ticket_id,
    NULLIF(h.metadata->>'workerBot', '') AS worker_bot
  FROM ticket_status_history h
  WHERE NULLIF(h.metadata->>'workerBot', '') IS NOT NULL
  ORDER BY h.ticket_id, h.created_at DESC
),
worker_bot_agent AS (
  ${workerBotSelect}
),
candidate_evidence AS (
  SELECT * FROM latest_history_agent
  UNION ALL
  SELECT * FROM latest_work_item_agent
  UNION ALL
  SELECT * FROM latest_work_item_output_agent
  UNION ALL
  SELECT * FROM worker_bot_agent
),
ranked_evidence AS (
  SELECT DISTINCT ON (ticket_id)
    ticket_id,
    agent_id,
    evidence_source
  FROM candidate_evidence
  WHERE agent_id IS NOT NULL
  ORDER BY ticket_id,
    CASE evidence_source
      WHEN 'ticket_status_history.metadata.workerAgentId' THEN 1
      WHEN 'ticket_status_history.metadata.agentId' THEN 2
      WHEN 'work_items.assigned_agent_id' THEN 3
      WHEN 'work_items.execution_output.agentId' THEN 4
      WHEN 'ticket_status_history.metadata.workerBot' THEN 5
      ELSE 9
    END
)
SELECT
  t.ticket_id::text AS ticket_id,
  t.status,
  t.title,
  re.agent_id,
  re.evidence_source,
  (a.agent_id IS NOT NULL) AS agent_exists,
  t.updated_at::text AS updated_at
FROM tickets t
JOIN ranked_evidence re ON re.ticket_id = t.ticket_id
LEFT JOIN agents a ON a.agent_id::text = re.agent_id
WHERE t.assigned_agent_id IS NULL
ORDER BY t.updated_at DESC
LIMIT $1
`;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  loadEnvironmentDefaults();

  let options: RepairOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error), usage: HELP_TEXT }, 'Invalid ticket assignment repair arguments');
    process.exitCode = 1;
    return;
  }

  if (options.showHelp) {
    logger.info({ usage: HELP_TEXT }, 'Ticket assignment repair help');
    return;
  }

  const pool = createOptionalPostgresPool('scripts/repair-ticket-assignments');
  if (!pool) {
    logger.error({ requiredEnv: ['DATABASE_URL', 'PGHOST/POSTGRES_HOST'] }, 'Postgres configuration missing. Ticket assignment repair cannot run.');
    process.exitCode = 1;
    return;
  }

  try {
    await ensureTicketSchema(pool);
    await ensureWorkItemSchema(pool);
    const result = await repairTicketAssignments(pool, options);
    logger.info(
      {
        durationMs: Date.now() - startedAt,
        mode: options.mode,
        result,
      },
      options.mode === 'apply'
        ? 'Ticket assignment repair applied'
        : 'Ticket assignment repair dry-run complete; re-run with --apply to mutate records',
    );
  } catch (error) {
    logger.error({ err: error, durationMs: Date.now() - startedAt }, 'Ticket assignment repair failed');
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function repairTicketAssignments(pool: Pool, options: RepairOptions): Promise<RepairResult> {
  const candidates = await loadCandidates(pool, options);
  const applicable = candidates.filter((candidate) => candidate.agentExists || options.allowMissingAgent);
  const skippedMissingAgent = candidates.length - applicable.length;

  logger.info(
    {
      mode: options.mode,
      scannedCandidates: candidates.length,
      applicable: applicable.length,
      skippedMissingAgent,
      sample: applicable.slice(0, 20),
    },
    'Ticket assignment repair plan',
  );

  if (options.mode === 'dry-run') {
    return {
      candidates: candidates.length,
      applicable: applicable.length,
      skippedMissingAgent,
      updatedTickets: 0,
      recordedAssignments: 0,
    };
  }

  let updatedTickets = 0;
  let recordedAssignments = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const candidate of applicable) {
      const update = await client.query(
        `UPDATE tickets
         SET assigned_agent_id = $2, updated_at = NOW()
         WHERE ticket_id = $1 AND assigned_agent_id IS NULL`,
        [candidate.ticketId, candidate.agentId],
      );
      updatedTickets += update.rowCount ?? 0;

      const assignment = await client.query(
        `INSERT INTO ticket_agent_assignments (ticket_id, agent_id, role, phase)
         VALUES ($1, $2, 'executor', 'assignment-repair')
         ON CONFLICT (ticket_id, agent_id, role)
         DO UPDATE SET phase = COALESCE(EXCLUDED.phase, ticket_agent_assignments.phase)`,
        [candidate.ticketId, candidate.agentId],
      );
      recordedAssignments += assignment.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return {
    candidates: candidates.length,
    applicable: applicable.length,
    skippedMissingAgent,
    updatedTickets,
    recordedAssignments,
  };
}

async function loadCandidates(pool: Pool, options: RepairOptions): Promise<AssignmentCandidate[]> {
  const result = await pool.query(buildCandidateSql(options.includeWorkerBot), [options.limit]);
  return result.rows.map((row: Record<string, unknown>) => ({
    ticketId: String(row.ticket_id),
    status: String(row.status ?? ''),
    title: String(row.title ?? ''),
    agentId: String(row.agent_id ?? ''),
    evidenceSource: String(row.evidence_source ?? ''),
    agentExists: row.agent_exists === true,
    updatedAt: String(row.updated_at ?? ''),
  }));
}

function loadEnvironmentDefaults(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (fs.existsSync(candidate)) {
      loadDotenv({ path: candidate, override: false });
    }
  }
}

if (require.main === module) {
  void main();
}
