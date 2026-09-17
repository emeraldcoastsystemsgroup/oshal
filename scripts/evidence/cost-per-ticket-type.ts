/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG P6: the cost claim was one workload at n=1 against a median of n=7. This reads the REAL per-ticket spend out of chat_tasks, through the product's own ticket_task_links join, and emits a dated per-ticket-type census with an n on every row — so "more than one ticket type, with its n" is generated from the ledger instead of asserted.
 */

/**
 * Per-ticket-type cost census — the multi-workload half of the cost claim.
 *
 *   npx tsx scripts/evidence/cost-per-ticket-type.ts
 *   OSHAL_COST_CENSUS_DSN=postgresql://... npx tsx scripts/evidence/cost-per-ticket-type.ts
 *
 * READ-ONLY by construction: every statement runs inside `BEGIN … SET TRANSACTION READ ONLY`
 * and the transaction is rolled back. This runs against the operator's live cluster, which is
 * the only place the historical ledger exists; it must never be able to write to it.
 *
 * Writes `docs/business/cost-per-ticket-type.json` and rewrites the table between the
 * CENSUS:START / CENSUS:END markers in the sibling `.md`, which
 * `tests/unit/cost-claim-carries-its-n.spec.ts` then holds to the JSON.
 *
 * @module cost-per-ticket-type
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CENSUS_DOC, CENSUS_JSON, TABLE_END, TABLE_START, renderCensusTable } = require('../cost-claim-check.js');

const REPO = path.resolve(__dirname, '..', '..');

/** One ticket type's measured spend. Every field is read, none estimated. */
export interface TicketTypeCost {
  ticketType: string;
  tickets: number;
  medianCostUsd: number;
  minCostUsd: number;
  maxCostUsd: number;
  totalCostUsd: number;
  meanTokens: number;
  llmRequests: number;
  firstSeen: string;
  lastSeen: string;
}

/** The limits that travel with every number this census publishes. */
const LIMITS = [
  'One operator cluster, one model mix, and whatever workloads that operator actually ran — not a controlled benchmark.',
  'A ticket type with a small n is a sample, not a rate: read the range beside the median, never the median alone.',
  'Cost is what the provider billed for the LLM calls linked to the ticket. Compute, storage and human time are not in it.',
  'Ticket types named smoke-*, *-probe and test-* are harness fixtures kept in the table so the n is not quietly curated.',
];

const CENSUS_SQL = `
  WITH per_ticket AS (
    SELECT t.ticket_type,
           l.ticket_id,
           SUM(c.total_cost)::float8 AS cost,
           SUM(c.total_input_tokens + c.total_output_tokens)::float8 AS tokens,
           SUM(c.total_requests)::int AS requests,
           MIN(c.created_at) AS first_at,
           MAX(c.updated_at) AS last_at
      FROM ticket_task_links l
      JOIN chat_tasks c ON c.task_id = l.task_id
      JOIN tickets t ON t.ticket_id = l.ticket_id
     WHERE c.total_cost > 0
     GROUP BY 1, 2
  )
  SELECT ticket_type,
         COUNT(*)::int AS tickets,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY cost))::float8 AS median_cost,
         MIN(cost)::float8 AS min_cost,
         MAX(cost)::float8 AS max_cost,
         SUM(cost)::float8 AS total_cost,
         AVG(tokens)::float8 AS mean_tokens,
         SUM(requests)::int AS llm_requests,
         to_char(MIN(first_at), 'YYYY-MM-DD') AS first_seen,
         to_char(MAX(last_at), 'YYYY-MM-DD') AS last_seen
    FROM per_ticket
   GROUP BY 1
   ORDER BY tickets DESC, median_cost DESC`;

/**
 * @description Resolves the live ledger DSN — the env override first, otherwise the running
 * oshal-local-db container's published host port with the api container's own credentials.
 * @returns A libpq connection string pointing at the cluster that holds the historical ledger.
 * @throws Error when neither the env override nor the container discovery yields a DSN.
 */
function resolveDsn(): string {
  const override = process.env.OSHAL_COST_CENSUS_DSN;
  if (override) return override;
  const ports = spawnSync('docker', ['port', 'oshal-local-db', '5432/tcp'], { encoding: 'utf8' }).stdout.trim();
  const match = ports.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
  if (!match) throw new Error(`cost-per-ticket-type: no OSHAL_COST_CENSUS_DSN and could not read oshal-local-db's host port from: ${ports}`);
  const host = `${match[1] === '0.0.0.0' ? '127.0.0.1' : match[1]}:${match[2]}`;
  const inner = spawnSync('docker', ['exec', 'oshal-local-api', 'printenv', 'BOOTSTRAP_DATABASE_URL'], { encoding: 'utf8' }).stdout.trim();
  if (!inner) throw new Error('cost-per-ticket-type: oshal-local-api has no BOOTSTRAP_DATABASE_URL to borrow');
  return inner.replace(/@[^/]+\//, `@${host}/`);
}

/**
 * @description Reads the census inside an explicitly read-only transaction and rolls it back.
 * @param pool - Pool for the live ledger.
 * @returns One row per ticket type that has at least one cost-bearing linked task.
 */
async function readCensus(pool: Pool): Promise<TicketTypeCost[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    const { rows } = await client.query(CENSUS_SQL);
    await client.query('ROLLBACK');
    return rows.map((row: Record<string, unknown>) => ({
      ticketType: String(row.ticket_type),
      tickets: Number(row.tickets),
      medianCostUsd: round(row.median_cost),
      minCostUsd: round(row.min_cost),
      maxCostUsd: round(row.max_cost),
      totalCostUsd: round(row.total_cost),
      meanTokens: Math.round(Number(row.mean_tokens)),
      llmRequests: Number(row.llm_requests),
      firstSeen: String(row.first_seen),
      lastSeen: String(row.last_seen),
    }));
  } finally {
    client.release();
  }
}

/**
 * @description Rounds a dollar amount to four decimals, the precision chat_tasks bills at.
 * @param value - Raw numeric column value.
 * @returns The rounded number.
 */
function round(value: unknown): number {
  return Math.round(Number(value) * 10000) / 10000;
}

/**
 * @description Builds the artifact written to disk, dated and sourced.
 * @param ticketTypes - The measured rows.
 * @returns The census artifact.
 */
function buildArtifact(ticketTypes: TicketTypeCost[]): Record<string, unknown> {
  return {
    generator: 'scripts/evidence/cost-per-ticket-type.ts',
    capturedAt: new Date().toISOString(),
    proofTier: 'live',
    source: "chat_tasks joined to tickets through the product's own ticket_task_links, read inside a READ ONLY transaction on the operator's live cluster",
    window: {
      firstSeen: ticketTypes.map((entry) => entry.firstSeen).sort()[0],
      lastSeen: ticketTypes.map((entry) => entry.lastSeen).sort().slice(-1)[0],
    },
    totals: {
      ticketTypes: ticketTypes.length,
      tickets: ticketTypes.reduce((sum, entry) => sum + entry.tickets, 0),
      llmRequests: ticketTypes.reduce((sum, entry) => sum + entry.llmRequests, 0),
      costUsd: round(ticketTypes.reduce((sum, entry) => sum + entry.totalCostUsd, 0)),
    },
    limits: LIMITS,
    ticketTypes,
  };
}

/**
 * @description Reads the ledger, writes the JSON artifact and regenerates the published table.
 * @returns Promise resolved once both files are on disk.
 * @throws Error when fewer than two ticket types carry cost — a one-type census would restate
 *   the very defect this replaces, so it refuses to publish rather than publish a thin number.
 */
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: resolveDsn(), max: 2 });
  try {
    const ticketTypes = await readCensus(pool);
    if (ticketTypes.length < 2) {
      throw new Error(`cost-per-ticket-type: only ${ticketTypes.length} ticket type(s) carry cost — refusing to publish a single-workload census`);
    }
    const artifact = buildArtifact(ticketTypes);
    writeFileSync(path.join(REPO, CENSUS_JSON), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const doc = readFileSync(path.join(REPO, CENSUS_DOC), 'utf8');
    const start = doc.indexOf(TABLE_START);
    const end = doc.indexOf(TABLE_END);
    if (start < 0 || end < start) throw new Error(`cost-per-ticket-type: ${CENSUS_DOC} is missing the ${TABLE_START} / ${TABLE_END} markers`);
    const rebuilt = `${doc.slice(0, start + TABLE_START.length)}\n\n${renderCensusTable(artifact)}\n\n${doc.slice(end)}`;
    writeFileSync(path.join(REPO, CENSUS_DOC), rebuilt, 'utf8');
    const totals = artifact.totals as { ticketTypes: number; tickets: number };
    console.log(`[cost-census] ${totals.ticketTypes} ticket types, ${totals.tickets} cost-bearing tickets -> ${CENSUS_JSON} + ${CENSUS_DOC}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
