/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from queue-manager-service.ts (1000-line cap decomposition): the incident-RCA dispatch pipeline — dispatchIncidentTicket (2-bot worker/queue-reviewer loop with bot-node dispatch + localhost fallback and the undici-timeout shadow-fetch) and finalizeIncidentByMode (ADR-069 §2b MODE→disposition finalization). Free function with an explicit IncidentDispatchDeps interface, same pattern as dispatch-manifest-worker.ts / dispatch-graph-worker.ts; QueueManagerService keeps a thin private delegator.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed the retired legacy-platform pre-flight: dropped its context-fetch import + env gates, and collapsed the worker prompt to its unconditional "no pre-fetched alarm/topology context" tooling section (the dead OpenSearch/graph curl block is gone). There is no OpenSearch/Memgraph; the bot investigates from the ticket + workspace + persona-granted tools.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-034 gap-b LIVE WIRING (controller half): the RCA pipeline's dispatchToBot now stamps each BotNodeClient.execute with the target's authoritative provider/model/configVersion (pushOnDispatchFields, shared with dispatch-manifest-worker) when OSHAL_PUSH_ON_DISPATCH is on. Fail-open + default OFF → byte-identical legacy dispatch; the localhost /api/send-message fallback is untouched (it hits the inline api, not a bot node).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 closure: entry 2 stripped the dead OpenSearch/graph curl BLOCK but left the STEPS still ordering the worker to "query the graph and OpenSearch … (use curl commands below)" against commands that no longer existed — a self-contradicting prompt. Steps 2/3 now reference the real optional tier conditionally, and the tooling section names the ONE surface that exists (caller-scoped /api/graph, AQL not Cypher, 503 = absent) while saying outright that no OpenSearch and no external graph service is reachable.
 */

import type { InternalTicket } from '@/entities/ticket';
import type { TicketService, WorkspaceService } from '@/features/ticketing';
import type { BotNodeClient, RuntimeParamsResolver } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';
import { pushOnDispatchFields } from './dispatch-manifest-worker';
import { serviceSecretHeaders } from '@/shared/middleware/authz';
import { taskSubdirs } from '@/shared/workspace-task-dirs';
import type { WorkflowDefinition } from './dispatch-routing';
import type { TaskFolderService } from './task-folder-service';
import { createTicketWorkspace, writeTaskBrief } from './queue-manager-workspace-helpers';
import { INCIDENT_MODE_DISPOSITION, readRcaMode } from './rca-mode';
import { extractErrorMessage } from './queue-manager-dispatch-helpers';

const logger = createChildLogger({ module: 'dispatch-incident-worker' });

/**
 * @description Dependencies needed to dispatch an incident-RCA ticket.
 * Lifted to an explicit interface so the QueueManagerService doesn't
 * need to expose its private state to a free function (same pattern as
 * ManifestWorkerDispatchDeps).
 */
export interface IncidentDispatchDeps {
  /** In-flight dispatch tracking — caller's own Set, mutated by this function. */
  activeTicketIds: Set<string>;
  /** Per-ticket dispatch-start timestamps for slot-watchdog accounting. */
  dispatchStartTimes: Map<string, number>;
  /** Persistent ticket store used for status transitions. */
  ticketService: TicketService;
  /** ADR-034 gap-b push-on-dispatch: resolves the target agent's authoritative
   *  provider/model/configVersion so each bot-node dispatch carries it (gated by
   *  OSHAL_PUSH_ON_DISPATCH). Absent/off → no stamping; fail-open, never blocks. */
  runtimeParamsResolver?: RuntimeParamsResolver;
  /**
   * The queue manager's injected pipeline services, when present. Absence skips
   * workspace creation and falls back to hardcoded agent IDs — mirroring the
   * original `this.pipelineDeps` guards exactly.
   */
  pipelineDeps?: {
    taskFolderService: TaskFolderService;
    workspaceService: WorkspaceService;
    botNodeClient?: BotNodeClient;
    resolveAgentIdByName?: (name: string) => Promise<string | undefined>;
  };
}

/**
 * @description Finalizes an incident-RCA ticket by the worker's chosen MODE (ADR-069 §2b). Mode A/B
 * land in `customer_action` with a `disposition` tag (proposed_solution | human_action_needed) so the
 * operator acts on the proposed fix or gathers more data; Mode C escalates. When no MODE marker is
 * present (non-RCA worker, noop stub, older deliverables) it falls back to 'complete' — preserving
 * prior behavior. The queue surface already renders Customer Action / Escalated; this is what populates them.
 * @param ticketId - The ticket to finalize.
 * @param delivDir - The worker's deliverables directory (holds RCA-REPORT.md).
 * @param ticketService - Persistent terminal-status writer.
 * @returns Resolves once the terminal status is written.
 */
async function finalizeIncidentByMode(ticketId: string, delivDir: string, ticketService: TicketService): Promise<void> {
  const mode = readRcaMode(delivDir);
  if (!mode) {
    await ticketService.updateStatus(ticketId, 'complete');
    logger.info({ ticketId }, 'Incident finalized: complete (no MODE marker on RCA-REPORT.md)');
    return;
  }
  const { status, disposition } = INCIDENT_MODE_DISPOSITION[mode];
  await ticketService.updateStatus(ticketId, status, { mode, disposition, source: 'incident-rca-pipeline' });
  logger.info({ ticketId, mode, status, disposition }, 'Incident finalized by MODE (ADR-069 §2b)');
}

/**
 * @description Handles incident tickets via a 2-bot review loop.
 *
 * RCA PIPELINE (incident ticketType only):
 *   Worker Bot (incident-remediation-bot) — investigates, writes deliverables
 *     ↓
 *   Queue Bot  (queue-bot) — reviews output, asks "is that your best work?"
 *     ↓ REVISION-REQUIRED
 *   Worker Bot — addresses specific feedback from queue bot
 *     ↓
 *   Queue Bot approves → ticket complete
 *
 * This is intentionally separate from the build pipeline (7-phase swarm).
 * RCA has no phases — worker investigates, queue reviews, done.
 * @param ticket - The incident ticket to dispatch.
 * @param workflow - The resolved workflow definition (workerBot + optional reviewerBot).
 * @param deps - Queue-manager state + pipeline services (see IncidentDispatchDeps).
 * @returns Resolves when the pipeline reaches a terminal outcome for the ticket.
 */
export async function dispatchIncidentTicket(
  ticket: InternalTicket,
  workflow: WorkflowDefinition,
  deps: IncidentDispatchDeps,
): Promise<void> {
  const { ticketId, title, description } = ticket;
  logger.info({ ticketId, title }, 'INCIDENT — 2-bot RCA pipeline: worker investigates, queue reviews');

  deps.activeTicketIds.add(ticketId);
  deps.dispatchStartTimes.set(ticketId, Date.now());

  const path = require('path') as typeof import('path');
  const fs = require('fs') as typeof import('fs');
  const wsRoot = process.env.SHARED_WORKSPACE_ROOT || '/app/workspace-shared';
  // ADR-060: the bot may have written deliverables flat, under users/<owner>/, or _shared/ —
  // resolve to the actual dir (falling back to flat for the not-yet-written case).
  const delivDir = taskSubdirs(wsRoot, ticketId, 'deliverables')[0] || path.join(wsRoot, ticketId, 'deliverables');
  const port = process.env.PORT || '5000';
  const taskId = ticketId;

  // ── Bot node dispatch helper ──────────────────────────────────────
  // When BotNodeClient is available (any-bot architecture), dispatch to bot nodes.
  // Falls back to local /api/send-message for backward compatibility.
  const botNodeClient = deps.pipelineDeps?.botNodeClient;
  const sendMessageFallback = async (agentId: string, text: string, dispatchTaskId: string): Promise<{ success: boolean; response?: string }> => {
    const resp = await fetch(`http://localhost:${port}/api/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
      body: JSON.stringify({
        taskId: dispatchTaskId,
        ticketId,
        text,
        agentId,
        agenticMode: true,
        source: 'incident-dispatch',
        chatOnly: false,
        interactionMode: 'task',
      }),
    });
    const result = await resp.json() as Record<string, unknown>;
    return { success: !!result.success, response: result.response as string | undefined };
  };
  const dispatchToBot = async (agentId: string, text: string, dispatchTaskId: string): Promise<{ success: boolean; response?: string }> => {
    if (botNodeClient) {
      try {
        // ADR-034 gap-b: stamp the authoritative config so a drifted RCA bot self-corrects
        // before executing (no-op unless OSHAL_PUSH_ON_DISPATCH is on; fail-open otherwise).
        const configFields = await pushOnDispatchFields(deps.runtimeParamsResolver, agentId);
        const result = await botNodeClient.execute(agentId, {
          text,
          taskId: dispatchTaskId,
          workspaceFolderId: ticketId,
          agentId,
          agenticMode: true,
          ...configFields,
        });
        return { success: result.success, response: result.response };
      } catch (error) {
        // BotNodeClient unavailable for this agent (e.g. resolver returned null
        // because the bot's harnessType=codex-cli is not implemented in the
        // bot-node JS layer). Fall through to the legacy localhost path which
        // routes via the api task-orchestrator and respects the agent's
        // harnessType from the registry.
        logger.warn({ err: (error as Error).message, agentId, ticketId }, 'Bot node dispatch unavailable — falling back to localhost /api/send-message');
      }
    }
    return sendMessageFallback(agentId, text, dispatchTaskId);
  };

  // Shadow global fetch for send-message calls to avoid undici 5-min headersTimeout.
  // Workers may take 10-30 minutes; http.request has no default timeout.
  const fetch = async (url: string | URL, options?: RequestInit): Promise<Response> => {
    if (!String(url).includes('/api/send-message')) {
      return globalThis.fetch(url, options);
    }
    return new Promise((resolve, reject) => {
      const http = require('http') as typeof import('http');
      const body = (options?.body as string) || '';
      const req = http.request(
        {
          host: 'localhost',
          port: Number(port),
          path: '/api/send-message',
          method: 'POST',
          headers: {
            ...(options?.headers as Record<string, string>),
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as unknown;
              resolve({ ok: (res.statusCode ?? 500) < 400, json: () => Promise.resolve(parsed) } as unknown as Response);
            } catch {
              resolve({ ok: false, json: () => Promise.resolve({}) } as unknown as Response);
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  };

  try {
    await deps.ticketService.updateStatus(ticketId, 'in_process_discovery');

    if (deps.pipelineDeps) {
      await createTicketWorkspace(ticket, {
        taskFolderService: deps.pipelineDeps.taskFolderService,
        workspaceService: deps.pipelineDeps.workspaceService,
        ticketService: deps.ticketService,
      }, 'in_process_discovery');
      writeTaskBrief(ticket, [], deps.pipelineDeps.taskFolderService, ticketId, 'in_process_discovery');
    }

    // ── Resolve bot IDs from workflow definition ──────────────────────
    const resolveId = deps.pipelineDeps?.resolveAgentIdByName;
    const workerAgentId = resolveId
      ? (await resolveId(workflow.workerBot) || await resolveId('rca-specialist') || 'e0000000-0000-0000-0000-000000000100')
      : 'e0000000-0000-0000-0000-000000000100';
    const queueAgentId = workflow.reviewerBot
      ? (resolveId ? await resolveId(workflow.reviewerBot) : 'f0000000-0000-0000-0000-000000000001')
      : null;

    logger.info({ ticketId, workerAgentId, queueAgentId, workflow: workflow.name }, 'RCA pipeline bots resolved');

    const hasRequiredDeliverables = () => (
      fs.existsSync(path.join(delivDir, 'RCA-REPORT.md'))
      && fs.existsSync(path.join(delivDir, 'IMPACT-ASSESSMENT.md'))
      && fs.existsSync(path.join(delivDir, 'REMEDIATION-STEPS.md'))
    );

    // ── Phase 1: Worker Bot — full investigation ──────────────────────
    const workerPrompt = [
      `# Incident Investigation: ${title}`,
      '',
      description || '(no description provided)',
      '',
      '---',
      '',
      '## Your Assignment',
      '',
      'You are the Incident Remediation Specialist. This ticket has been assigned to you.',
      'Investigate this incident fully and fill out every field of the OSHAL incident tab.',
      '',
      'Your workspace is at: ' + path.join(wsRoot, ticketId),
      '',
      '## CRITICAL: Write each deliverable file AS SOON AS you complete that investigation step.',
      '## Do NOT wait until the end. Write → investigate → write → investigate → write.',
      '## The OSHAL tab is populated from these files in real time — operators are watching.',
      '',
      '## Step-by-Step Process (follow in order, write file after each step)',
      '',
      '### Step 1: Build the Timeline',
      'Read all evidence in the ticket. Construct a chronological sequence of events.',
      'What fired first? What cascaded? What was the trigger vs the symptom?',
      '→ IMMEDIATELY write **deliverables/INVESTIGATION-NOTES.md** with the timeline and your working notes.',
      '',
      '### Step 2: Root Cause Analysis',
      'From the timeline, identify the most probable root cause. Assign confidence (high/medium/low).',
      'List contributing factors. Add one alternative hypothesis with lower confidence.',
      'If the graph tier is available (see "Investigation tooling"), look for corroborating',
      'topology — but never treat an absent graph as a missing prerequisite.',
      '→ IMMEDIATELY write **deliverables/RCA-REPORT.md** with:',
      '  - Root cause statement (one sentence)',
      '  - Confidence level',
      '  - Evidence chain (what you observed that supports this)',
      '  - Contributing factors',
      '  - Alternative hypothesis',
      '  - What additional data would increase certainty',
      '',
      '### Step 3: Impact Assessment',
      'Map blast radius from the ticket evidence, plus the graph neighborhood when the tier is up.',
      'Which systems are upstream/downstream? How many users/services affected?',
      '→ IMMEDIATELY write **deliverables/IMPACT-ASSESSMENT.md** with:',
      '  - Affected systems list (specific names)',
      '  - Downstream blast radius',
      '  - Business impact',
      '  - Escalation path',
      '',
      '### Step 4: Remediation Scripts',
      'Write scripts an operator can run to diagnose and fix this incident.',
      '→ IMMEDIATELY write these files:',
      '  - **deliverables/scripts/diagnose.sh** — check current state (is it still broken?)',
      '  - **deliverables/scripts/remediate.sh** — step-by-step fix with preflight checks',
      '  - **deliverables/scripts/rollback.sh** — how to undo if fix makes things worse',
      'CRITICAL: DO NOT EXECUTE scripts. Create only. Include dry-run flags and operator prompts.',
      '',
      '### Step 5: Remediation Steps (human-readable)',
      '→ IMMEDIATELY write **deliverables/REMEDIATION-STEPS.md** with:',
      '  - Numbered operator steps (plain English, not just scripts)',
      '  - Preflight checks',
      '  - Rollback procedure',
      '  - Verification steps (how does the operator confirm it worked?)',
      '',
      '## Investigation tooling',
      '',
      'No pre-fetched alarm/topology context is available in this environment. There is no',
      'OpenSearch and no external graph service on this deployment — do not curl one.',
      'Use only the ticket description, the workspace files, and any tools your',
      'persona explicitly grants. If you need data the ticket does not contain,',
      'state "insufficient data — request: [what is missing]" and stop.',
      '',
      'ONE optional platform surface exists, reached only through the swarm api (ADR-045):',
      '  curl -s "http://oshal-local-api:5000/api/graph/neighbors?id=service:<name>&depth=2" \\',
      '    -H "X-Service-Secret: $SWARM_SERVICE_SECRET" -H "X-OSHAL-User-Sub: $OSHAL_USER_SUB"',
      'It also serves POST /query (AQL reads — NOT Cypher), GET /path, and POST /nodes|/edges.',
      'HTTP 503 means this deployment has no graph engine: note it once and continue without it.',
      '',

      '## Rules',
      '- Write each file immediately after completing that step — not at the end.',
      workflow.reviewerBot
        ? '- Your work will be reviewed by the queue bot. Hold yourself to that standard.'
        : '- No reviewer bot is configured for this workflow. Self-audit before you finish.',
      '- If you lack data, say so explicitly — do not invent. Document what is missing.',
      '- Read-only access only. Never execute remediation steps yourself.',
      '',
    ].join('\n');

    logger.info({ ticketId, workerAgentId }, 'Phase 1 — Worker Bot investigating');
    const workerResult1 = await dispatchToBot(workerAgentId, workerPrompt, taskId);
    logger.info({ ticketId, success: workerResult1.success }, 'Phase 1 — Worker Bot complete');

    if (!workerResult1.success) {
      await deps.ticketService.updateStatus(ticketId, 'escalated', {
        reason: 'worker_bot_first_pass_failed',
        source: 'incident-rca-pipeline',
      });
      logger.warn({ ticketId }, 'Worker bot failed on first pass — escalated');
      return;
    }

    if (!queueAgentId) {
      if (hasRequiredDeliverables()) {
        await finalizeIncidentByMode(ticketId, delivDir, deps.ticketService);
      } else {
        await deps.ticketService.updateStatus(ticketId, 'escalated', {
          reason: 'reviewer_unavailable_deliverables_missing',
          source: 'incident-rca-pipeline',
        });
        logger.warn({ ticketId }, 'Reviewer bot unavailable and required deliverables missing — escalated');
      }
      return;
    }

    // ── Phase 2: Queue Bot — review deliverables ──────────────────────
    const queueReviewPrompt = [
      `# Queue Review: Incident — ${title}`,
      '',
      '## Your Role',
      '',
      'You are the Queue Bot. Your ONLY job right now is to review the worker bot\'s deliverables',
      'for this incident investigation and decide if they are good enough.',
      '',
      'You did NOT do this investigation. You are reviewing someone else\'s work.',
      '',
      `## Workspace: ${path.join(wsRoot, ticketId)}`,
      '',
      'Read these files:',
      '- deliverables/RCA-REPORT.md',
      '- deliverables/IMPACT-ASSESSMENT.md',
      '- deliverables/REMEDIATION-STEPS.md',
      '- deliverables/scripts/ (directory, if present)',
      '- deliverables/INVESTIGATION-NOTES.md (if present)',
      '',
      '## Evaluation Criteria',
      '',
      '**RCA-REPORT.md must have:**',
      '- A specific root cause (not "unknown" or "under investigation")',
      '- Evidence chain supporting the root cause',
      '- Confidence level stated',
      '',
      '**IMPACT-ASSESSMENT.md must have:**',
      '- Named specific systems affected (not "various systems")',
      '- Blast radius quantified where possible',
      '',
      '**REMEDIATION-STEPS.md must have:**',
      '- Steps actionable by an operator right now',
      '- Rollback procedure',
      '',
      '## Decision',
      '',
      'Write your review to: deliverables/QUEUE-REVIEW.md',
      '',
      'If the work passes:',
      '```',
      'STATUS: APPROVED',
      'REVIEWED_BY: queue-bot',
      'NOTES: [one sentence on why this passes]',
      '```',
      '',
      'If the work needs revision:',
      '```',
      'STATUS: REVISION-REQUIRED',
      'REVIEWED_BY: queue-bot',
      'FEEDBACK:',
      '- [specific gap 1 — exact file, exact issue, exact what is needed]',
      '- [specific gap 2]',
      '```',
      '',
      'Be direct. Is this their best work? Hold the standard.',
    ].join('\n');

    // Queue bot uses a separate task folder so it doesn't stomp the worker's Cline session state
    const queueTaskId = `${ticketId}::queue-review`;
    logger.info({ ticketId, queueAgentId, queueTaskId }, 'Phase 2 — Queue Bot reviewing');
    const queueResult = await dispatchToBot(queueAgentId!, queueReviewPrompt, queueTaskId);
    logger.info({ ticketId, success: queueResult.success }, 'Phase 2 — Queue Bot review complete');

    // Read the queue bot's verdict
    const reviewPath = path.join(delivDir, 'QUEUE-REVIEW.md');
    const reviewContent = fs.existsSync(reviewPath) ? fs.readFileSync(reviewPath, 'utf8') : '';
    const approved = reviewContent.includes('STATUS: APPROVED');
    const revisionRequired = reviewContent.includes('STATUS: REVISION-REQUIRED');

    logger.info({ ticketId, approved, revisionRequired, reviewContent: reviewContent.slice(0, 200) }, 'Queue bot verdict');

    if (approved) {
      logger.info({ ticketId }, 'APPROVED by queue bot — finalizing incident by MODE');
      await finalizeIncidentByMode(ticketId, delivDir, deps.ticketService);
      return;
    }

    if (!revisionRequired) {
      // Queue bot didn't write a review — treat as approved if deliverables exist
      if (hasRequiredDeliverables()) {
        logger.info({ ticketId }, 'Queue bot did not write review but deliverables present — finalizing by MODE');
        await finalizeIncidentByMode(ticketId, delivDir, deps.ticketService);
        return;
      }
    }

    // ── Phase 3: Worker Bot — address queue bot feedback ─────────────
    logger.info({ ticketId, workerAgentId }, 'Phase 3 — Worker Bot revising based on queue bot feedback');
    const revisionPrompt = [
      `# Revision Required: ${title}`,
      '',
      'The queue bot has reviewed your incident investigation deliverables and found issues.',
      '',
      `## Queue Bot Feedback`,
      '',
      reviewContent || '(queue review file missing — re-check all deliverables)',
      '',
      '---',
      '',
      `## Your Workspace: ${path.join(wsRoot, ticketId)}`,
      '',
      'Address every point of feedback above.',
      'Update or rewrite the flagged deliverables.',
      'Do not add new files — fix the existing ones.',
      '',
      'The queue bot will not ask again. Make this your best work.',
    ].join('\n');

    const workerResult2 = await dispatchToBot(workerAgentId, revisionPrompt, `${ticketId}::revision`);
    logger.info({ ticketId, success: workerResult2.success }, 'Phase 3 — Worker Bot revision complete');

    // Complete regardless — worker has had its second pass
    if (workerResult2.success) {
      logger.info({ ticketId }, 'Revision cycle complete — finalizing incident by MODE');
      await finalizeIncidentByMode(ticketId, delivDir, deps.ticketService);
    } else {
      await deps.ticketService.updateStatus(ticketId, 'escalated', {
        reason: 'worker_bot_revision_failed',
        source: 'incident-rca-pipeline',
      });
      logger.warn({ ticketId }, 'Worker bot revision failed — escalated');
    }
  } catch (error) {
    logger.error({ err: error, ticketId }, 'Incident RCA pipeline failed');
    try {
      await deps.ticketService.updateStatus(ticketId, 'escalated', {
        reason: 'incident_rca_pipeline_failed',
        source: 'incident-rca-pipeline',
        message: extractErrorMessage(error),
      });
    } catch { /* best effort */ }
  } finally {
    deps.activeTicketIds.delete(ticketId);
    deps.dispatchStartTimes.delete(ticketId);
  }
}
