/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Workflow Studio run history store: workflow_runs (one row per graph-ticket execution) + workflow_run_steps (one row per executed node, with agent/timing/redacted input-output summaries). Write path is deliberately NON-THROWING (telemetry — a recording failure must never break a run, mirroring the dispatch-graph-worker saveCheckpoint contract); read path throws normally so routes surface real errors. Lazy schema via runRuntimeSchemaBootstrap + owner-or-operator RLS at the A1.2 chokepoint (mirrors scripts/migrations/062-workflow-run-history.sql).
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database/schema-bootstrap-policy';
import { SCHEMA_LOCK_KEYS } from '@/shared/services/database/schema-lock';
import { buildOwnerRlsPolicyStatements } from '@/shared/services/database/owner-rls-policy';

const logger = createChildLogger({ module: 'workflow-run-history-store' });

/** Summarization limits — keep step payloads inspectable, never a data dump. */
const MAX_DEPTH = 4;
const MAX_KEYS = 40;
const MAX_ITEMS = 20;
const MAX_STRING = 400;

/** Object keys whose values are always redacted (secret-shaped names). */
const SECRET_KEY_PATTERN = /(pass(word)?|passwd|secret|token|api[-_]?key|apikey|credential|bearer|private[-_]?key|access[-_]?key|client[-_]?secret|session[-_]?id|cookie)/i;
const SECRET_EXACT_KEYS = new Set(['auth', 'authorization']);

/** String values that look like credentials (key material, bearer headers, JWTs, k=v secrets). */
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9_-]{10,})|(gh[pousr]_[A-Za-z0-9]{16,})|(xox[baprs]-[A-Za-z0-9-]{10,})|(Bearer\s+[A-Za-z0-9._-]{10,})|(eyJ[A-Za-z0-9._-]{20,})|((api[-_]?key|token|secret|password)\s*[=:]\s*[^\s&"']{6,})/gi;

/** Input for opening a run record when a graph ticket is dispatched. */
export interface WorkflowRunStartInput {
  ticketId: string;
  ownerSub?: string | null;
  ticketType?: string;
  workflowName?: string;
}

/** Input for one executed node — matches the engine's EngineStepEvent shape structurally. */
export interface WorkflowRunStepInput {
  nodeId: string;
  nodeType: string;
  title?: string;
  outcome: string;
  /** Epoch ms when the node started executing. */
  startedAt?: number;
  /** Epoch ms when the node finished. */
  finishedAt?: number;
  agentId?: string;
  /** Node input (variables visible when the node started). Redacted + truncated before insert. */
  input?: unknown;
  /** Node executor output payload. Redacted + truncated before insert. */
  output?: unknown;
}

/** Terminal (or suspend) disposition for a run. */
export interface WorkflowRunFinishInput {
  status: 'completed' | 'escalated' | 'suspended' | 'error';
  outcome?: string;
  reason?: string;
}

/** A run row as returned by the list/get APIs. */
export interface WorkflowRunSummary {
  runId: string;
  ticketId: string;
  ownerSub: string | null;
  ticketType: string;
  workflowName: string;
  status: string;
  outcome: string | null;
  reason: string | null;
  resumedCount: number;
  startedAt: string;
  finishedAt: string | null;
  stepCount: number;
}

/** One recorded step of a run. */
export interface WorkflowRunStepRecord {
  stepId: string;
  seq: number;
  nodeId: string;
  nodeType: string;
  nodeTitle: string;
  agentId: string | null;
  status: string;
  inputSummary: unknown;
  outputSummary: unknown;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A run plus its ordered steps (the run-inspector payload). */
export interface WorkflowRunDetail extends WorkflowRunSummary {
  steps: WorkflowRunStepRecord[];
}

/** Options for listing runs (owner scoping is decided by the route, enforced here). */
export interface WorkflowRunListOptions {
  /** Strict owner scope — only runs owned by this sub. */
  ownerSub?: string;
  /** Also include unowned (owner_sub IS NULL) runs alongside the ownerSub scope. */
  includeUnowned?: boolean;
  ticketType?: string;
  ticketId?: string;
  limit?: number;
  offset?: number;
}

/**
 * @description The recording port the dispatch-graph-worker calls. Every method is
 * non-throwing by contract (telemetry only) so a recording failure can never break a run.
 */
export interface WorkflowRunRecorder {
  startRun(input: WorkflowRunStartInput): Promise<string | null>;
  resumeRun(runId: string): Promise<boolean>;
  recordStep(runId: string, step: WorkflowRunStepInput): Promise<void>;
  finishRun(runId: string, input: WorkflowRunFinishInput): Promise<void>;
}

/**
 * @description Redact + truncate an arbitrary node payload into a JSON-safe summary for storage.
 * Secret-shaped KEYS are replaced with '[REDACTED]'; secret-shaped string VALUES (bearer tokens,
 * sk-/ghp- keys, JWTs, `api_key=...`) are masked in place; depth/size are capped so a summary is
 * never a data dump. Exported for direct unit coverage.
 * @param value - raw node input/output payload
 * @param depth - current recursion depth (internal)
 * @returns a JSON-serializable, redacted summary (or undefined for undefined input)
 */
export function redactRunPayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[truncated: depth]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => redactRunPayload(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`[+${value.length - MAX_ITEMS} more]`);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, val] of entries.slice(0, MAX_KEYS)) {
      out[key] = isSecretKey(key) ? '[REDACTED]' : redactRunPayload(val, depth + 1);
    }
    if (entries.length > MAX_KEYS) out['[truncated]'] = `+${entries.length - MAX_KEYS} more keys`;
    return out;
  }
  return String(value);
}

/**
 * @description True when an object key names something secret-shaped.
 * @param key - object key
 * @returns whether the key's value must be redacted
 */
function isSecretKey(key: string): boolean {
  return SECRET_EXACT_KEYS.has(key.toLowerCase()) || SECRET_KEY_PATTERN.test(key);
}

/**
 * @description Mask secret-shaped substrings inside a string value and cap its length.
 * @param value - raw string
 * @returns the masked, truncated string
 */
function redactString(value: string): string {
  const masked = value.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
  return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}… [truncated]` : masked;
}

/**
 * @description Postgres-backed store for Workflow Studio run history. Writes (startRun /
 * resumeRun / recordStep / finishRun) are non-throwing telemetry; reads (listRuns / getRun)
 * throw so API routes can 500 honestly. Schema is created lazily on first use via the
 * shared runtime schema bootstrap (advisory-locked, validate-only aware) and mirrors
 * scripts/migrations/062-workflow-run-history.sql.
 */
export class WorkflowRunHistoryStore implements WorkflowRunRecorder {
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly pool: Pool) {}

  /**
   * @description Ensure workflow_runs / workflow_run_steps exist (once per store instance).
   * @returns resolves when the schema is ready
   */
  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = runRuntimeSchemaBootstrap({
        pool: this.pool,
        moduleName: 'workflow-run-history',
        statements: buildRunSchemaStatements(),
        lockKey: SCHEMA_LOCK_KEYS.workflowRun,
        requirements: [
          { table: 'workflow_runs', columns: ['run_id', 'ticket_id', 'owner_sub', 'status'] },
          { table: 'workflow_run_steps', columns: ['step_id', 'run_id', 'node_id', 'status'] },
        ],
      }).then(() => undefined).catch((error) => {
        this.schemaReady = null;
        throw error;
      });
    }
    return this.schemaReady;
  }

  /**
   * @description Open a run record for a dispatched graph ticket. Non-throwing: returns null
   * when the insert fails so the dispatch continues unrecorded rather than breaking.
   * @param input - run identity (ticket, owner, workflow)
   * @returns the new runId, or null on failure
   */
  async startRun(input: WorkflowRunStartInput): Promise<string | null> {
    try {
      await this.ensureSchema();
      const result = await this.pool.query<{ run_id: string }>(
        `INSERT INTO workflow_runs (ticket_id, owner_sub, ticket_type, workflow_name, status)
         VALUES ($1, $2, $3, $4, 'running')
         RETURNING run_id`,
        [input.ticketId, input.ownerSub ?? null, input.ticketType ?? '', input.workflowName ?? ''],
      );
      return result.rows[0]?.run_id ?? null;
    } catch (error) {
      logger.error({ err: error, ticketId: input.ticketId }, 'Failed to open workflow run record (run continues unrecorded)');
      return null;
    }
  }

  /**
   * @description Re-open a suspended/crashed run on resume (same logical run across
   * approval-gate suspends and restarts). Non-throwing.
   * @param runId - the run to re-open
   * @returns true when the run row exists and was re-opened
   */
  async resumeRun(runId: string): Promise<boolean> {
    try {
      await this.ensureSchema();
      const result = await this.pool.query(
        `UPDATE workflow_runs
         SET status = 'running', finished_at = NULL, resumed_count = resumed_count + 1, updated_at = NOW()
         WHERE run_id = $1`,
        [runId],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      logger.error({ err: error, runId }, 'Failed to re-open workflow run record (run continues unrecorded)');
      return false;
    }
  }

  /**
   * @description Record one executed node. Input/output are redacted + truncated summaries —
   * never raw payloads. Non-throwing.
   * @param runId - owning run
   * @param step - the step event from the engine
   * @returns resolves always (failures are logged, not thrown)
   */
  async recordStep(runId: string, step: WorkflowRunStepInput): Promise<void> {
    try {
      await this.ensureSchema();
      await this.pool.query(
        `INSERT INTO workflow_run_steps
           (run_id, owner_sub, node_id, node_type, node_title, agent_id, status, input_summary, output_summary, started_at, finished_at)
         SELECT r.run_id, r.owner_sub, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10
         FROM workflow_runs r WHERE r.run_id = $1`,
        [
          runId,
          step.nodeId,
          step.nodeType,
          step.title ?? '',
          step.agentId ?? null,
          step.outcome,
          step.input === undefined ? null : JSON.stringify(redactRunPayload(step.input)),
          step.output === undefined ? null : JSON.stringify(redactRunPayload(step.output)),
          step.startedAt ? new Date(step.startedAt).toISOString() : null,
          step.finishedAt ? new Date(step.finishedAt).toISOString() : null,
        ],
      );
    } catch (error) {
      logger.error({ err: error, runId, nodeId: step.nodeId }, 'Failed to record workflow run step (run continues)');
    }
  }

  /**
   * @description Close a run with its terminal (or suspended) disposition. Non-throwing.
   * @param runId - the run to close
   * @param input - status/outcome/reason
   * @returns resolves always (failures are logged, not thrown)
   */
  async finishRun(runId: string, input: WorkflowRunFinishInput): Promise<void> {
    try {
      await this.ensureSchema();
      await this.pool.query(
        `UPDATE workflow_runs
         SET status = $2, outcome = $3, reason = $4,
             finished_at = CASE WHEN $2 = 'suspended' THEN finished_at ELSE NOW() END,
             updated_at = NOW()
         WHERE run_id = $1`,
        [runId, input.status, input.outcome ?? null, input.reason ?? null],
      );
    } catch (error) {
      logger.error({ err: error, runId, status: input.status }, 'Failed to close workflow run record');
    }
  }

  /**
   * @description List runs, newest first, with step counts. Owner scoping is enforced here
   * from the options the route computed (strict ownerSub, optionally plus unowned rows).
   * Throws on database errors so routes surface them.
   * @param options - scope + filters + paging
   * @returns run summaries
   */
  async listRuns(options: WorkflowRunListOptions = {}): Promise<WorkflowRunSummary[]> {
    await this.ensureSchema();
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.ownerSub !== undefined) {
      params.push(options.ownerSub);
      where.push(options.includeUnowned ? `(r.owner_sub = $${params.length} OR r.owner_sub IS NULL)` : `r.owner_sub = $${params.length}`);
    }
    if (options.ticketType) {
      params.push(options.ticketType);
      where.push(`r.ticket_type = $${params.length}`);
    }
    if (options.ticketId) {
      params.push(options.ticketId);
      where.push(`r.ticket_id = $${params.length}`);
    }
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    params.push(limit, offset);
    const result = await this.pool.query(
      `SELECT r.*, COALESCE(s.step_count, 0)::int AS step_count
       FROM workflow_runs r
       LEFT JOIN (SELECT run_id, COUNT(*) AS step_count FROM workflow_run_steps GROUP BY run_id) s
         ON s.run_id = r.run_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.started_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return result.rows.map(mapRunRow);
  }

  /**
   * @description Load one run plus its ordered steps (the inspector payload). Throws on
   * database errors; returns null when the run does not exist.
   * @param runId - the run to load
   * @returns the run detail or null
   */
  async getRun(runId: string): Promise<WorkflowRunDetail | null> {
    await this.ensureSchema();
    const runResult = await this.pool.query(
      `SELECT r.*, COALESCE(s.step_count, 0)::int AS step_count
       FROM workflow_runs r
       LEFT JOIN (SELECT run_id, COUNT(*) AS step_count FROM workflow_run_steps WHERE run_id = $1 GROUP BY run_id) s
         ON s.run_id = r.run_id
       WHERE r.run_id = $1`,
      [runId],
    );
    const runRow = runResult.rows[0];
    if (!runRow) return null;
    const stepResult = await this.pool.query(
      `SELECT * FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq ASC`,
      [runId],
    );
    return { ...mapRunRow(runRow), steps: stepResult.rows.map(mapStepRow) };
  }
}

/**
 * @description Map a workflow_runs row (snake_case) to the API summary shape.
 * @param row - raw pg row
 * @returns the summary
 */
function mapRunRow(row: Record<string, unknown>): WorkflowRunSummary {
  return {
    runId: String(row.run_id),
    ticketId: String(row.ticket_id),
    ownerSub: (row.owner_sub as string | null) ?? null,
    ticketType: String(row.ticket_type ?? ''),
    workflowName: String(row.workflow_name ?? ''),
    status: String(row.status ?? ''),
    outcome: (row.outcome as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    resumedCount: Number(row.resumed_count ?? 0),
    startedAt: toIso(row.started_at) ?? new Date(0).toISOString(),
    finishedAt: toIso(row.finished_at),
    stepCount: Number(row.step_count ?? 0),
  };
}

/**
 * @description Map a workflow_run_steps row (snake_case) to the API step shape.
 * @param row - raw pg row
 * @returns the step record
 */
function mapStepRow(row: Record<string, unknown>): WorkflowRunStepRecord {
  return {
    stepId: String(row.step_id),
    seq: Number(row.seq ?? 0),
    nodeId: String(row.node_id ?? ''),
    nodeType: String(row.node_type ?? ''),
    nodeTitle: String(row.node_title ?? ''),
    agentId: (row.agent_id as string | null) ?? null,
    status: String(row.status ?? ''),
    inputSummary: row.input_summary ?? null,
    outputSummary: row.output_summary ?? null,
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
  };
}

/**
 * @description Normalize a pg timestamp value (Date or string) to an ISO string, or null.
 * @param value - raw column value
 * @returns ISO string or null
 */
function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * @description Ordered idempotent DDL for the run-history tables — the runtime mirror of
 * scripts/migrations/062-workflow-run-history.sql, with owner-or-operator RLS appended at
 * the lazy-DDL chokepoint (A1.2) so a fresh database is never policy-less.
 * @returns SQL statements
 */
function buildRunSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id UUID NOT NULL,
      owner_sub TEXT,
      ticket_type TEXT NOT NULL DEFAULT '',
      workflow_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'suspended', 'completed', 'escalated', 'error')),
      outcome TEXT,
      reason TEXT,
      resumed_count INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_workflow_runs_ticket ON workflow_runs(ticket_id)`,
    `CREATE INDEX IF NOT EXISTS idx_workflow_runs_owner ON workflow_runs(owner_sub) WHERE owner_sub IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_workflow_runs_started ON workflow_runs(started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)`,
    `CREATE TABLE IF NOT EXISTS workflow_run_steps (
      step_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      owner_sub TEXT,
      seq BIGSERIAL,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      node_title TEXT NOT NULL DEFAULT '',
      agent_id TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('completed', 'terminal', 'jump', 'skipped', 'escalated', 'suspended')),
      input_summary JSONB,
      output_summary JSONB,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run ON workflow_run_steps(run_id, seq)`,
    ...buildOwnerRlsPolicyStatements('workflow_runs', 'owner_sub'),
    ...buildOwnerRlsPolicyStatements('workflow_run_steps', 'owner_sub'),
  ];
}
