/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG P6: the cost claim was one workload at n=1 against a median of n=7. This reads the REAL per-ticket spend out of chat_tasks, through the product's own ticket_task_links join, and emits a dated per-ticket-type census with an n on every row — so "more than one ticket type, with its n" is generated from the ledger instead of asserted.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review of #623: the join charged a chat task's whole cost to EVERY ticket it was linked to and then summed across tickets — 30 cost-bearing tasks carry 2–5 links (a bot-node task id is <workspace ticket>::<agent>, and every sibling subtask dispatched into that workspace links the same accumulating row), so the census published $149.82 against a $92.05 ledger. Each task is now attributed once, split evenly across its links, the ledger totals are read in the same READ ONLY transaction and published beside the census, and the run refuses to write an artifact whose total does not tie to them.
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
const { CENSUS_DOC, CENSUS_JSON, TABLE_END, TABLE_START, ledgerTieErrors, renderCensusTable } = require('../cost-claim-check.js');

const REPO = path.resolve(__dirname, '..', '..');

/** One ticket type's measured spend. Every field is read from the ledger; a task linked to several tickets is split evenly across them. */
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
  'A chat task linked to several tickets (sibling subtasks run in one workspace accumulate into one task row) is counted once and split evenly across them; the ledger does not record which ticket drove which call.',
];

/**
 * Each cost-bearing task is attributed ONCE. A bot-node task id is `<workspace ticket>::<agent>`,
 * and every sibling subtask dispatched into that workspace links the same accumulating
 * `chat_tasks` row to its own ticket (2–5 links on 30 of the first capture's 159 tasks), so a
 * plain join charged the whole row to every ticket and summed to $149.82 against a $92.05 ledger.
 * `task_share` divides the row by its link count: the sum over tickets is the ledger again, and
 * every sibling that ran keeps its share instead of the first link taking all of it. Which ticket
 * drove which call is not in the ledger, so an even split is the attribution the data supports.
 */
const CENSUS_SQL = `
  WITH links AS (
    SELECT l.task_id, l.ticket_id, t.ticket_type,
           COUNT(*) OVER (PARTITION BY l.task_id)::float8 AS link_count
      FROM ticket_task_links l
      JOIN tickets t ON t.ticket_id = l.ticket_id
  ),
  task_share AS (
    SELECT k.ticket_type, k.ticket_id,
           c.total_cost / k.link_count AS cost,
           (c.total_input_tokens + c.total_output_tokens) / k.link_count AS tokens,
           c.total_requests / k.link_count AS requests,
           c.created_at, c.updated_at
      FROM links k
      JOIN chat_tasks c ON c.task_id = k.task_id
     WHERE c.total_cost > 0
  ),
  per_ticket AS (
    SELECT ticket_type,
           ticket_id,
           SUM(cost)::float8 AS cost,
           SUM(tokens)::float8 AS tokens,
           SUM(requests)::float8 AS requests,
           MIN(created_at) AS first_at,
           MAX(updated_at) AS last_at
      FROM task_share
     GROUP BY 1, 2
  )
  SELECT ticket_type,
         COUNT(*)::int AS tickets,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY cost))::float8 AS median_cost,
         MIN(cost)::float8 AS min_cost,
         MAX(cost)::float8 AS max_cost,
         SUM(cost)::float8 AS total_cost,
         AVG(tokens)::float8 AS mean_tokens,
         ROUND(SUM(requests))::int AS llm_requests,
         to_char(MIN(first_at), 'YYYY-MM-DD') AS first_seen,
         to_char(MAX(last_at), 'YYYY-MM-DD') AS last_seen
    FROM per_ticket
   GROUP BY 1
   ORDER BY tickets DESC, median_cost DESC`;

/** The ledger the census must tie to: every cost-bearing task that is linked to a ticket, once. */
const LEDGER_SQL = `
  SELECT COUNT(*)::int AS tasks,
         SUM(c.total_requests)::int AS llm_requests,
         SUM(c.total_cost)::float8 AS cost
    FROM chat_tasks c
   WHERE c.total_cost > 0
     AND EXISTS (SELECT 1 FROM ticket_task_links l JOIN tickets t ON t.ticket_id = l.ticket_id WHERE l.task_id = c.task_id)`;

/** What the ledger holds, read in the same transaction as the census. */
export interface LedgerTotals {
  tasks: number;
  llmRequests: number;
  costUsd: number;
}

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
 * @description Reads the census and the ledger totals inside one explicitly read-only
 * transaction and rolls it back, so both come from the same snapshot.
 * @param pool - Pool for the live ledger.
 * @returns One row per ticket type that has at least one cost-bearing linked task, and the
 *   ledger totals the census has to tie to.
 */
async function readCensus(pool: Pool): Promise<{ ticketTypes: TicketTypeCost[]; ledger: LedgerTotals }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    const { rows } = await client.query(CENSUS_SQL);
    const { rows: ledgerRows } = await client.query(LEDGER_SQL);
    await client.query('ROLLBACK');
    const ledger: LedgerTotals = {
      tasks: Number(ledgerRows[0].tasks),
      llmRequests: Number(ledgerRows[0].llm_requests),
      costUsd: round(ledgerRows[0].cost),
    };
    const ticketTypes = rows.map((row: Record<string, unknown>) => ({
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
    return { ticketTypes, ledger };
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
 * @description Builds the artifact written to disk, dated and sourced, with the ledger totals
 * beside the census totals so the tie is published, not asserted.
 * @param ticketTypes - The measured rows.
 * @param ledger - The ledger totals read in the same transaction.
 * @returns The census artifact.
 */
function buildArtifact(ticketTypes: TicketTypeCost[], ledger: LedgerTotals): Record<string, unknown> {
  return {
    generator: 'scripts/evidence/cost-per-ticket-type.ts',
    capturedAt: new Date().toISOString(),
    proofTier: 'live',
    source: "chat_tasks joined to tickets through the product's own ticket_task_links, each task counted once and split evenly across the tickets it is linked to, read inside a READ ONLY transaction on the operator's live cluster",
    attribution: 'A task linked to N tickets contributes 1/N of its cost, tokens and calls to each; the census totals therefore equal the ledger totals.',
    ledger,
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
 *   the very defect this replaces, so it refuses to publish rather than publish a thin number —
 *   or when the census total does not tie to the ledger it was read from.
 */
async function main(): Promise<void> {
  const pool = new Pool({ connectionString: resolveDsn(), max: 2 });
  try {
    const { ticketTypes, ledger } = await readCensus(pool);
    if (ticketTypes.length < 2) {
      throw new Error(`cost-per-ticket-type: only ${ticketTypes.length} ticket type(s) carry cost — refusing to publish a single-workload census`);
    }
    const artifact = buildArtifact(ticketTypes, ledger);
    const tieErrors: string[] = ledgerTieErrors(artifact, ticketTypes.length);
    if (tieErrors.length) throw new Error(`cost-per-ticket-type: refusing to publish — ${tieErrors.join('; ')}`);
    writeFileSync(path.join(REPO, CENSUS_JSON), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const doc = readFileSync(path.join(REPO, CENSUS_DOC), 'utf8');
    const start = doc.indexOf(TABLE_START);
    const end = doc.indexOf(TABLE_END);
    if (start < 0 || end < start) throw new Error(`cost-per-ticket-type: ${CENSUS_DOC} is missing the ${TABLE_START} / ${TABLE_END} markers`);
    const rebuilt = `${doc.slice(0, start + TABLE_START.length)}\n\n${renderCensusTable(artifact)}\n\n${doc.slice(end)}`;
    writeFileSync(path.join(REPO, CENSUS_DOC), rebuilt, 'utf8');
    const totals = artifact.totals as { ticketTypes: number; tickets: number; costUsd: number; llmRequests: number };
    console.log(`[cost-census] ${totals.ticketTypes} ticket types, ${totals.tickets} cost-bearing tickets, $${totals.costUsd} across ${totals.llmRequests} LLM calls (ledger: ${ledger.tasks} tasks, $${ledger.costUsd}, ${ledger.llmRequests} calls) -> ${CENSUS_JSON} + ${CENSUS_DOC}`);
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
