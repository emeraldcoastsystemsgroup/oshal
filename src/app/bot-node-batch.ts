/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the one-shot bot-node batch entrypoint ADR-078 §1 called for and nothing implemented. Runs a SINGLE phase envelope through the SAME execution handler the long-lived bot-node-server uses (via the extracted createBotNodeRuntime), writes the classified MODE to mode.txt so Argo can lift it as a DAG output parameter, and exits with a status the Workflow can branch on. Invoked by scripts/bot-node-batch.sh with BOT_RUNTIME=bot-node-batch.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Persisted non-fatal batch Job telemetry for runtime, worker/queue identity, CPU/memory observations, provider/model/cost, and backend errors so operators can graph recent Job durations instead of scraping pod logs.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Ran the one-shot batch phase under runWithSystemIdentity — background execution that writes the FORCE-RLS tickets (status transition) + chat_tasks (cost) tables with no request in scope; SYSTEM keeps it visible once OSHAL_DB_GUC_STRICT denies the identity-less case.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Prohibit unsigned one-shot batch execution when HTTP delegation verification keys enable enforcement; batch token carriage is intentionally deferred.
 */

/**
 * Bot Node Batch — run one phase, write the mode, exit.
 *
 * This is the Kubernetes/Argo counterpart to `bot-node-server.ts`. Where the server
 * is a long-lived process consuming Redis envelopes forever, this is a Job pod: it
 * synthesises exactly one envelope for the (ticket, agent, phase) it was handed,
 * executes it on the accountable any-bot stack (so cost still lands in `chat_tasks`),
 * persists the classified MODE for the Argo DAG, and exits.
 *
 *   bot-node-batch.sh --ticket-id=T --agent-id=A --phase=investigate
 *
 * There is no mesh transport, no heartbeat, no HTTP surface — a batch pod needs none
 * of them. Everything it shares with the server comes from `createBotNodeRuntime()`.
 *
 * Exit codes: 0 = phase completed. 1 = phase failed (Argo marks the DAG task failed).
 *
 * @module bot-node-batch
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { MeshEnvelope } from '@/features/agent-management';
import { MESH_CHANNELS } from '@/features/agent-management';
import { readRcaMode } from '@/features/swarm-orchestration';
import { BatchJobTelemetryStore } from '@/features/batch-job-telemetry';
import { createBotNodeRuntime } from './bot-node-runtime';
import { buildBatchTelemetryRecord, captureBatchTelemetryStart } from './bot-node-batch-telemetry';
import { assertDelegationBatchRuntimeAllowed } from './bot-node-delegation';

const logger = createChildLogger({ module: 'bot-node-batch' });

/** The one unit of work this pod was created to run. */
export interface BatchPhaseArgs {
  ticketId: string;
  agentId: string;
  phase: string;
  /** Where the DAG expects mode.txt (Argo lifts it as an output parameter). */
  workspaceDir: string;
  /** Incident title — the work content the phase persona investigates. */
  title: string;
  /** Incident description — ditto. Without these the pod would investigate NOTHING. */
  description: string;
}

/**
 * @description Parses `--key=value` flags, falling back to the env vars the Argo template also
 * sets (TICKET_ID / AGENT_ID / TICKET_TITLE / TICKET_DESCRIPTION). Kept tolerant so the same
 * script works from a shell by hand.
 * @param argv - Raw process arguments (excluding node + script path).
 * @returns The resolved phase arguments.
 * @throws Error when a required argument is missing — a Job pod must never silently no-op.
 */
export function parseBatchArgs(argv: string[]): BatchPhaseArgs {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) flags.set(match[1], match[2]);
  }
  const ticketId = flags.get('ticket-id') || process.env.TICKET_ID || '';
  const agentId = flags.get('agent-id') || process.env.AGENT_ID || '';
  const phase = flags.get('phase') || process.env.PHASE || '';
  const workspaceDir = flags.get('workspace-dir') || process.env.WORKSPACE_DIR || '/app/workspace-shared';
  const title = flags.get('title') || process.env.TICKET_TITLE || '';
  const description = flags.get('description') || process.env.TICKET_DESCRIPTION || '';

  const missing = [
    !ticketId && '--ticket-id',
    !agentId && '--agent-id',
    !phase && '--phase',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`bot-node-batch: missing required argument(s): ${missing.join(', ')}`);
  }
  return { ticketId, agentId, phase, workspaceDir, title, description };
}

/**
 * @description Synthesises the single MeshEnvelope this pod will execute, shaped like the
 * envelopes SwarmAgentWorker consumes off Redis. The FIELDS matter (double-check findings
 * 2026-07-08 — each was live-traced through buildExecutionUserMessage):
 *  - `workUnits` is the ONLY carrier of work content on the non-direct path (`payload.text`
 *    is ignored unless `direct`); omitting it produced a boilerplate-only prompt where the
 *    bot had no idea what incident it was investigating.
 *  - `externalId` (NOT `ticketId`) drives ticket attribution — the chat_tasks cost row's
 *    ticketExternalId, the ticket_task_links row, and the "Ticket:" prompt line.
 *  - `phase` must be numeric or absent: consumers do Number(phase), so the Argo phase NAME
 *    ('investigate') became NaN in handover filenames and awareness prompts. The name rides
 *    in `phaseName`; the numeric slot stays absent, matching the /api/swarm-execute path.
 * @param args - The phase this pod was created to run.
 * @returns The envelope to hand to the execution handler.
 */
export function buildPhaseEnvelope(args: BatchPhaseArgs): MeshEnvelope {
  const mandate = [
    args.description || '(no further description provided — investigate from the workspace context)',
    '',
    'This is the incident-rca pipeline running as an Argo batch phase.',
    'Write your deliverables to the deliverables/ folder of your workspace. Your RCA report',
    'MUST be deliverables/RCA-REPORT.md and its FIRST LINE must be your mode classification,',
    'exactly one of: "MODE: A (remediation)" | "MODE: B (info-request)" | "MODE: C (escalate)".',
  ].join('\n');
  return {
    correlationId: `batch-${args.ticketId}-${args.phase}`,
    fromAgentId: 'argo-workflow',
    toAgentId: args.agentId,
    channel: MESH_CHANNELS.agentDirect(args.agentId),
    messageType: 'request',
    payload: {
      ticketId: args.ticketId,
      externalId: args.ticketId,
      workspaceTaskId: args.ticketId,
      phaseName: args.phase,
      // A batch phase is swarm work, not an interactive reasoning call: keep the
      // handover / awareness / swarm-memory layers the phase persona expects.
      direct: false,
      workUnits: [{
        title: args.title || `Incident ${args.ticketId}`,
        description: mandate,
        labels: ['incident', `argo-phase:${args.phase}`],
      }],
    },
  };
}

/**
 * @description Extracts the classified incident MODE (A/B/C) from the phase's response text.
 * FALLBACK ONLY — the canonical source is line 1 of RCA-REPORT.md (see `resolveMode`).
 * @param response - The phase's final text output.
 * @returns The mode letter, or 'unknown' when the persona did not classify one.
 */
export function extractMode(response: string): string {
  const match = /\bMODE[:\s]+([ABC])\b/i.exec(response || '');
  return match ? match[1].toUpperCase() : 'unknown';
}

/**
 * @description Resolves the mode the Argo DAG branches on, preferring the SAME source the
 * in-process pipeline uses: line 1 of `<workspace>/<ticket>/deliverables/RCA-REPORT.md`
 * (`readRcaMode`). Only when the persona wrote no report do we fall back to scanning the
 * response text — otherwise the batch path and the in-process path could disagree on the
 * same run, which is exactly the drift this indirection exists to prevent.
 * @param args - Supplies the workspace dir + ticket id used to locate the deliverables.
 * @param response - The phase's final text output (fallback source).
 * @returns 'A' | 'B' | 'C' | 'unknown'.
 */
export function resolveMode(args: BatchPhaseArgs, response: string): string {
  const delivDir = path.join(args.workspaceDir, args.ticketId, 'deliverables');
  return readRcaMode(delivDir) ?? extractMode(response);
}

/** The execution handler's `output` payload (EnvelopeExecutionResult.output is typed `unknown`). */
interface PhaseOutput {
  content?: string;
  response?: string;
  cost?: number;
  model?: string;
  provider?: string;
}

/**
 * @description Reads the phase's response text out of the handler's `output` payload.
 * `EnvelopeExecutionResult` exposes only `{ success, output?, error? }` — the text is inside
 * `output`, NOT on the result itself.
 * @param output - The handler's opaque output payload.
 * @returns The response text, or '' when the payload carried none.
 */
export function readPhaseOutput(output: unknown): PhaseOutput {
  return (output && typeof output === 'object') ? output as PhaseOutput : {};
}

/**
 * @description Writes mode.txt where the WorkflowTemplate's output parameter points. Argo reads
 * this path off the finished container, so the directory must exist even when the phase produced
 * no classification.
 * @param args - Supplies the workspace dir and ticket id (the path is workspace/<ticket>/mode.txt).
 * @param mode - The classified mode, or 'unknown'.
 * @returns The path written.
 */
export function writeModeFile(args: BatchPhaseArgs, mode: string): string {
  const dir = path.join(args.workspaceDir, args.ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const modePath = path.join(dir, 'mode.txt');
  fs.writeFileSync(modePath, mode, 'utf8');
  return modePath;
}

/**
 * @description Runs the single phase end to end: bootstrap the shared runtime, execute one
 * envelope on the accountable any-bot stack, persist the mode for the DAG, and report.
 * @returns Process exit code — 0 when the phase completed, 1 when it failed.
 */
async function runPhase(): Promise<number> {
  assertDelegationBatchRuntimeAllowed();
  const args = parseBatchArgs(process.argv.slice(2));
  const telemetryStart = captureBatchTelemetryStart(args);
  logger.info({ ...args }, 'bot-node-batch starting one phase');

  const runtime = await createBotNodeRuntime();
  const envelope = buildPhaseEnvelope(args);

  // Mirror dispatchIncidentTicket: the in-process pipeline moves the ticket into
  // in_process_discovery before the worker phase. Without this, finalize-incident's
  // disposition (customer_action/escalated/complete) is rejected by the ticket state
  // machine — backlog/approved don't allow those transitions (double-check 2026-07-08,
  // live-proven against the running DB). Best-effort: a ticket already in-process (or a
  // review phase) just logs and continues.
  if (args.phase === 'investigate' && runtime.ticketService) {
    try {
      await runtime.ticketService.updateStatus(args.ticketId, 'in_process_discovery', {
        source: 'incident-rca-argo', phase: args.phase,
      });
    } catch (err) {
      logger.warn({ err, ticketId: args.ticketId }, 'phase-start status transition skipped (may already be in-process)');
    }
  }

  const started = Date.now();
  const result = await runtime.executionHandler(envelope);
  const durationMs = Date.now() - started;

  const output = readPhaseOutput(result.output);
  const response = output.response ?? output.content ?? '';
  const succeeded = result.success;
  const mode = succeeded ? resolveMode(args, response) : 'unknown';
  const modePath = writeModeFile(args, mode);

  logger.info(
    { ticketId: args.ticketId, phase: args.phase, agentId: args.agentId,
      succeeded, mode, modePath, durationMs, cost: output.cost ?? 0,
      provider: output.provider ?? runtime.providerName, model: output.model ?? runtime.modelName,
      error: result.error },
    'bot-node-batch phase finished',
  );

  if (runtime.pool) {
    const store = new BatchJobTelemetryStore(runtime.pool);
    await store.record(buildBatchTelemetryRecord(args, telemetryStart, {
      status: succeeded ? 'succeeded' : 'failed',
      ownerSub: process.env.OSHAL_USER_SUB || null,
      provider: output.provider ?? runtime.providerName,
      model: output.model ?? runtime.modelName,
      costUsd: output.cost ?? null,
      backendError: result.error,
      metadata: { mode, modePath, correlationId: envelope.correlationId },
    }));
  }

  // Close the pool so the Job pod exits instead of hanging on an open handle.
  try { await runtime.pool?.end(); } catch { /* pool already closed — nothing to release */ }

  return succeeded ? 0 : 1;
}

// Entrypoint guard: importable by tests without spawning a phase.
if (require.main === module) {
  runWithSystemIdentity(() => runPhase())
    .then((code) => process.exit(code))
    .catch((err) => {
      logger.error({ err }, 'bot-node-batch failed');
      // eslint-disable-next-line no-console -- CLI entrypoint: synchronous stderr crash line before process.exit (pino may not flush)
      console.error('bot-node-batch failed:', err);
      process.exit(1);
    });
}
