/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * (new)               | workflow-publish | Real EngineServices adapter for AUTHORED workflows. Bridges the
 *                       ProcessDefinitionExecutionEngine's node calls to actual bot dispatch (reusing the
 *                       proven dispatch-staged-worker path: bot-node client with localhost /api/send-message
 *                       fallback). Scope: authored Workflow-Studio workflows where each `execute-agent` node
 *                       pins a bot (config.agentId) and the engine owns graph order / branches / gates. This
 *                       is NOT a replacement for the 7-phase build swarm — intake/planning/testing/review are
 *                       intentionally light here because authored workflows are pre-structured by the author.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | decideBranch (bot-picked branch) + dispatchPrompt helper; runClusterStep (concurrent member dispatch + reviewer PASS/FAIL gate) + resolveAgent.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | dispatchAgentPrompt: the multi-app planner's plan-step primitive — resolve the step's bot, send its substituted prompt as a full task run, and return the reply for data-passing. Generalized the private dispatchPrompt with a chatOnly flag (default true; plan steps run full). Structural method (not on EngineServices) so the workflow-studio interface stays unwidened.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Prohibit the unsigned localhost execution fallback whenever the bot client reports that signed HTTP delegation is enforced.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Thread the persisted workflow-ticket owner and principal issuer through bot delegation, and authenticate every localhost machine fallback with that owner.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Preserve workflow owner subjects exactly and use the canonical base64url trusted-service identity header on localhost fallbacks.
 */

import type { InternalTicket } from '@/entities/ticket';
import type { TicketService } from '@/features/ticketing';
import type { BotNodeClient } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';
import { serviceSecretHeaders, trustedServiceUserHeaders } from '@/shared/middleware/authz';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import type {
  EngineServices,
  EngineTicketContext,
  PlanningNodeConfig,
  ExecutionNodeConfig,
  IntakeResult,
  PlanningResult,
  ExecutionResult,
  TestingResult,
  ReviewResult,
  SpecialistResult,
  DeliveryResult,
  DecisionNodeConfig,
  DecisionResult,
  ClusterStepConfig,
  ClusterStepResult,
} from '@/features/workflow-studio';
import type { AgentPromptDispatchConfig, AgentPromptDispatchResult } from './plan-step-executor';

const logger = createChildLogger({ module: 'engine-services-adapter' });

interface AuthoredWorkflowDispatchResult {
  success: boolean;
  response?: string;
  error?: string;
}

interface EngineDispatchIdentity {
  userSub?: string;
  principalIssuer?: string;
}

function resolveEngineDispatchIdentity(ticket: EngineTicketContext): EngineDispatchIdentity {
  const raw = ticket.raw as Partial<InternalTicket> | undefined;
  const userSub = typeof raw?.ownerSub === 'string' ? raw.ownerSub : '';
  const principalIssuer = readOwnerPrincipalIssuer(raw?.metadata);
  return {
    ...(userSub ? { userSub } : {}),
    ...(principalIssuer ? { principalIssuer } : {}),
  };
}

/** Dependencies for the authored-workflow EngineServices adapter. Mirrors the
 *  dispatch-staged-worker deps so the swarm composition wires the same handles. */
export interface EngineServicesAdapterDeps {
  /** Persona-name → agentId resolver (used when a stage pins a bot by name, not id). */
  resolveAgentIdByName?: (name: string) => Promise<string | undefined>;
  /** Bot-node client for HTTP dispatch; falls back to localhost when absent/unavailable. */
  botNodeClient?: BotNodeClient;
  /** Terminal-status writer (the graph queue manager owns final status; kept for escalate). */
  ticketService: TicketService;
  /** Local-fallback HTTP port. Default reads PORT env. */
  port?: string;
}

/**
 * @description EngineServices for authored workflows. The workhorse is runExecution,
 * which dispatches the stage's pinned bot exactly like dispatch-staged-worker. The engine
 * awaits each stage before walking to the next node, so stage handoff is sequential by
 * construction. The remaining phase methods return neutral results — authored workflows
 * do not run the swarm's decomposition/testing/review machinery unless an author wires
 * dedicated bot nodes for them.
 */
export class EngineServicesAdapter implements EngineServices {
  constructor(private readonly deps: EngineServicesAdapterDeps) {}

  async intakeAndScore(_ticket: EngineTicketContext): Promise<IntakeResult> {
    // Authored workflows are pre-structured; no decomposition/complexity scoring.
    return { complexity: 'medium', complexityScore: 50, activePhases: [], workUnitCount: 0 };
  }

  async runPlanning(_ticket: EngineTicketContext, config: PlanningNodeConfig): Promise<PlanningResult> {
    return {
      stopAfterPlanning: config.stopAfterPlanning === true,
      workUnits: [],
      routing: {},
      planningSource: 'authored',
    };
  }

  async runExecution(
    ticket: EngineTicketContext,
    config: ExecutionNodeConfig,
    regressionFeedback?: string,
  ): Promise<ExecutionResult> {
    const ticketId = this.ticketIdOf(ticket);
    const dispatchIdentity = resolveEngineDispatchIdentity(ticket);
    // Resolve the pinned bot: explicit agentId wins; else resolve a bound name.
    let agentId = config.agentId;
    if (!agentId && config.agentBinding && this.deps.resolveAgentIdByName) {
      agentId = await this.deps.resolveAgentIdByName(config.agentBinding);
    }
    if (!agentId && config.primaryRole && this.deps.resolveAgentIdByName) {
      agentId = await this.deps.resolveAgentIdByName(config.primaryRole);
    }
    if (!agentId) {
      logger.error({ ticketId, config }, 'Stage has no resolvable bot — cannot execute node');
      return { outcome: { dispatched: false, reason: 'no bot resolved' }, strategy: 'unresolved' };
    }

    const port = this.deps.port ?? process.env.PORT ?? '5000';
    const text = [
      `### ${ticket.title}`,
      ``,
      `**Ticket ID:** ${ticketId}`,
      regressionFeedback ? `**Revision feedback:** ${regressionFeedback}` : ``,
      ``,
      `${ticket.body || '(no description provided)'}`,
    ]
      .filter(Boolean)
      .join('\n');

    const sendViaLocalhost = async (): Promise<AuthoredWorkflowDispatchResult> => {
      const response = await fetch(`http://localhost:${port}/api/send-message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(dispatchIdentity.userSub
            ? trustedServiceUserHeaders(dispatchIdentity.userSub)
            : serviceSecretHeaders()),
        },
        body: JSON.stringify({
          taskId: ticketId,
          ticketId,
          agentId,
          text,
          agenticMode: true,
          chatOnly: false,
          interactionMode: 'task',
          source: 'engine-services-adapter',
        }),
      });
      const rawBody = await response.text().catch(() => '');
      let body: Record<string, unknown> = {};
      if (rawBody.trim()) {
        try {
          body = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          body = { response: rawBody };
        }
      }
      if (!response.ok) {
        const message = typeof body.error === 'string' ? body.error : rawBody.slice(0, 300);
        throw new Error(`localhost send-message failed (${response.status}): ${message || response.statusText}`);
      }
      if (body.success !== true) {
        const message = typeof body.error === 'string'
          ? body.error
          : `localhost send-message returned success=${String(body.success)}`;
        throw new Error(message);
      }
      return {
        success: true,
        response: typeof body.response === 'string' ? body.response : undefined,
      };
    };

    let dispatchResult: AuthoredWorkflowDispatchResult;
    if (this.deps.botNodeClient) {
      try {
        const result = await this.deps.botNodeClient.execute(agentId, {
          text,
          taskId: ticketId,
          workspaceFolderId: ticketId,
          agentId,
          agenticMode: true,
          ...dispatchIdentity,
        });
        dispatchResult = {
          success: result.success === true,
          response: result.response,
          error: result.success ? undefined : result.response || 'bot-node returned success=false',
        };
      } catch (botErr) {
        if (this.deps.botNodeClient.isDelegationEnforced()) throw botErr;
        logger.warn(
          { err: (botErr as Error).message, ticketId, agentId },
          'Bot-node dispatch unavailable — falling back to localhost /api/send-message',
        );
        dispatchResult = await sendViaLocalhost();
      }
    } else {
      dispatchResult = await sendViaLocalhost();
    }

    if (!dispatchResult.success) {
      logger.error({ ticketId, agentId, error: dispatchResult.error }, 'Authored-workflow stage dispatch failed');
      return {
        outcome: { dispatched: false, reason: dispatchResult.error || 'execute-agent dispatch failed' },
        agentId,
        strategy: 'authored-stage',
      };
    }

    logger.info({ ticketId, agentId, workType: config.workType }, 'Authored-workflow stage dispatched to bot');
    return { outcome: { dispatched: true, agentId }, agentId, strategy: 'authored-stage' };
  }

  /**
   * @description Ask the bound bot to choose the next branch at an ai-decision node. Sends a
   * short decision prompt listing the allowed outcomes and matches the bot's reply back to one of
   * them (case-insensitive, exact then contains). Falls back to the first outcome when no bot is
   * resolvable — the engine layers its own configured fallbackOutcome on top of that.
   */
  async decideBranch(ticket: EngineTicketContext, config: DecisionNodeConfig): Promise<DecisionResult> {
    const ticketId = this.ticketIdOf(ticket);
    const outcomes = config.outcomes.filter((o) => o && o.trim().length > 0);
    let agentId = config.agentId;
    if (!agentId && config.agentBinding && this.deps.resolveAgentIdByName) {
      agentId = await this.deps.resolveAgentIdByName(config.agentBinding);
    }
    if (!agentId || outcomes.length === 0) {
      logger.warn({ ticketId, hasAgent: Boolean(agentId), outcomeCount: outcomes.length }, 'ai-decision not dispatchable — falling back to first outcome');
      return { outcome: outcomes[0] ?? 'default' };
    }

    const text = [
      `### Workflow decision: ${config.prompt ?? 'choose the next step'}`,
      ``,
      `**Ticket:** ${ticket.title}`,
      ticket.body ? `\n${ticket.body}` : ``,
      ``,
      `Choose exactly ONE next step and reply with only that label — nothing else:`,
      outcomes.map((o) => `- ${o}`).join('\n'),
    ].filter(Boolean).join('\n');

    const reply = (await this.dispatchPrompt(ticket, agentId, text)) ?? '';
    const lower = reply.trim().toLowerCase();
    const matched = outcomes.find((o) => lower === o.toLowerCase())
      ?? outcomes.find((o) => lower.includes(o.toLowerCase()))
      ?? outcomes[0];
    logger.info({ ticketId, agentId, reply: reply.slice(0, 120), matched }, 'ai-decision resolved by bot');
    return { outcome: matched };
  }

  /**
   * @description Run an agent-cluster step: dispatch every member agent on the same work
   * CONCURRENTLY (a ranked cluster), then gate the candidates — if a reviewer is configured it
   * judges them (PASS <n> picks a winner, FAIL rejects with feedback); otherwise consensus passes
   * when at least one member produced output. This is a real multi-agent step, not a single bot.
   */
  async runClusterStep(ticket: EngineTicketContext, config: ClusterStepConfig): Promise<ClusterStepResult> {
    const ticketId = this.ticketIdOf(ticket);
    const memberIds = (await Promise.all((config.agents ?? []).map((a) => this.resolveAgent(a))))
      .filter((id): id is string => Boolean(id));
    if (memberIds.length === 0) {
      logger.error({ ticketId }, 'Agent-cluster step has no resolvable members');
      return { passed: false, memberCount: 0, respondedCount: 0, feedback: 'no cluster members resolvable' };
    }

    const text = [
      `### ${ticket.title}`,
      ``,
      `**Ticket ID:** ${ticketId}`,
      config.feedback ? `**Revision feedback:** ${config.feedback}` : ``,
      ``,
      `${ticket.body || '(no description provided)'}`,
    ].filter(Boolean).join('\n');

    // Ranked cluster: all members work the step at once; a member that errors is isolated.
    const settled = await Promise.allSettled(
      memberIds.map((id) => this.dispatchPrompt(ticket, id, text).then((resp) => ({ id, resp: resp ?? '' }))),
    );
    const responses = settled
      .filter((s): s is PromiseFulfilledResult<{ id: string; resp: string }> => s.status === 'fulfilled' && Boolean(s.value.resp))
      .map((s) => s.value);
    logger.info({ ticketId, members: memberIds.length, responded: responses.length }, 'Agent-cluster members dispatched concurrently');
    if (responses.length === 0) {
      return { passed: false, memberCount: memberIds.length, respondedCount: 0, feedback: 'no cluster member produced output' };
    }

    // Gate: a reviewer judges the candidates; without one, consensus = at least one responded.
    let winnerAgentId = responses[0].id;
    let passed = true;
    let feedback: string | undefined;
    const reviewerId = config.reviewer ? await this.resolveAgent(config.reviewer) : undefined;
    if (reviewerId) {
      const judgePrompt = buildClusterJudgePrompt(ticket.title, responses.map((r) => r.resp));
      const verdict = (await this.dispatchPrompt(ticket, reviewerId, judgePrompt)) ?? '';
      const parsed = parseClusterVerdict(verdict, responses.length);
      passed = parsed.passed;
      if (passed && parsed.winnerIndex != null) winnerAgentId = responses[parsed.winnerIndex].id;
      feedback = parsed.feedback;
      logger.info({ ticketId, reviewerId, passed, winnerAgentId, verdict: verdict.slice(0, 120) }, 'Agent-cluster reviewer gated the step');
    }
    return { passed, winnerAgentId, memberCount: memberIds.length, respondedCount: responses.length, feedback };
  }

  /**
   * @description Dispatch one multi-app plan step to its bot and return the reply (the plan-step
   * primitive). Resolves the step's bot (explicit agentId, else a bound app/persona name), sends the
   * already-substituted prompt as a FULL task run (chatOnly=false) so cost + per-bot settings apply,
   * and returns the reply text so downstream plan steps can consume it. Honest failure: an
   * unresolved bot or a dispatch error returns dispatched=false with a reason (no fabricated output).
   * @param ticket - the engine ticket context for this run
   * @param config - the resolved bot binding + the substituted prompt for this step
   * @returns whether the step dispatched, the bot's reply, the resolved agentId, and a failure reason
   */
  async dispatchAgentPrompt(
    ticket: EngineTicketContext,
    config: AgentPromptDispatchConfig,
  ): Promise<AgentPromptDispatchResult> {
    const ticketId = this.ticketIdOf(ticket);
    let agentId = config.agentId;
    if (!agentId && config.agentBinding && this.deps.resolveAgentIdByName) {
      agentId = await this.deps.resolveAgentIdByName(config.agentBinding);
    }
    if (!agentId) {
      logger.error({ ticketId, agentBinding: config.agentBinding }, 'plan-step has no resolvable bot');
      return { dispatched: false, reason: 'no bot resolved' };
    }
    try {
      const response = await this.dispatchPrompt(ticket, agentId, config.prompt, false);
      logger.info({ ticketId, agentId, workType: config.workType }, 'plan-step dispatched to bot');
      return { dispatched: true, response, agentId };
    } catch (err) {
      logger.error({ err: (err as Error).message, ticketId, agentId }, 'plan-step dispatch failed');
      return { dispatched: false, agentId, reason: (err as Error).message };
    }
  }

  /**
   * @description Resolve an agent reference (persona name or explicit id) to an agentId. An id-shaped
   * value is used directly; otherwise a bound name is resolved via the injected resolver.
   */
  private async resolveAgent(nameOrId?: string): Promise<string | undefined> {
    const value = (nameOrId ?? '').trim();
    if (!value) return undefined;
    if (/^[0-9a-f-]{16,}$/i.test(value) || !this.deps.resolveAgentIdByName) return value;
    return (await this.deps.resolveAgentIdByName(value)) ?? value;
  }

  /**
   * @description Dispatch a prompt to a bot and return its text reply (bot-node client first,
   * localhost /api/send-message fallback). chatOnly (default true) makes it a quick answer for the
   * ai-decision branch question; plan steps pass chatOnly=false for a full accountable task run.
   */
  private async dispatchPrompt(
    ticket: EngineTicketContext,
    agentId: string,
    text: string,
    chatOnly = true,
  ): Promise<string | undefined> {
    const ticketId = this.ticketIdOf(ticket);
    const dispatchIdentity = resolveEngineDispatchIdentity(ticket);
    if (this.deps.botNodeClient) {
      try {
        const result = await this.deps.botNodeClient.execute(agentId, {
          text,
          taskId: ticketId,
          workspaceFolderId: ticketId,
          agentId,
          agenticMode: true,
          ...dispatchIdentity,
        });
        if (result.success === true) return result.response;
        logger.warn({ ticketId, agentId }, 'decision bot-node returned success=false — localhost fallback');
      } catch (botErr) {
        if (this.deps.botNodeClient.isDelegationEnforced()) throw botErr;
        logger.warn({ err: (botErr as Error).message, ticketId, agentId }, 'decision bot-node unavailable — localhost fallback');
      }
    }
    const port = this.deps.port ?? process.env.PORT ?? '5000';
    const response = await fetch(`http://localhost:${port}/api/send-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(dispatchIdentity.userSub
          ? trustedServiceUserHeaders(dispatchIdentity.userSub)
          : serviceSecretHeaders()),
      },
      body: JSON.stringify({
        taskId: ticketId,
        ticketId,
        agentId,
        text,
        agenticMode: true,
        chatOnly,
        interactionMode: 'task',
        source: 'engine-services-adapter:decision',
      }),
    });
    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`decision send-message failed (${response.status}): ${raw.slice(0, 200) || response.statusText}`);
    }
    try {
      const body = JSON.parse(raw) as Record<string, unknown>;
      return typeof body.response === 'string' ? body.response : undefined;
    } catch {
      return raw || undefined;
    }
  }

  async runTesting(_ticket: EngineTicketContext, _executionOutcome: unknown): Promise<TestingResult> {
    // No automated test phase for authored workflows; gates are author-defined nodes.
    return { passed: true };
  }

  async runReview(_ticket: EngineTicketContext, _executionOutcome: unknown): Promise<ReviewResult> {
    return { passed: true };
  }

  async runSpecialistInput(_ticket: EngineTicketContext): Promise<SpecialistResult> {
    return { contextInjected: false };
  }

  async runDelivery(_ticket: EngineTicketContext, _executionOutcome: unknown): Promise<DeliveryResult> {
    return { delivered: true };
  }

  async escalate(ticket: EngineTicketContext, target: string, severity: string, reason: string): Promise<void> {
    logger.warn({ ticketId: this.ticketIdOf(ticket), target, severity, reason }, 'Authored-workflow escalation');
  }

  private ticketIdOf(ticket: EngineTicketContext): string {
    const raw = ticket.raw as Partial<InternalTicket> | undefined;
    return String(raw?.ticketId ?? ticket.externalId);
  }
}

/**
 * @description Build the reviewer prompt for an agent-cluster step: the candidate answers plus an
 * instruction to reply "PASS <n>" (best candidate) or "FAIL <reason>".
 * @param title - the ticket title
 * @param candidates - the members' candidate outputs
 * @returns the judge prompt
 */
function buildClusterJudgePrompt(title: string, candidates: string[]): string {
  const list = candidates.map((c, i) => `--- Candidate ${i + 1} ---\n${String(c).slice(0, 1500)}`).join('\n\n');
  return [
    `### Review candidate answers for: ${title}`,
    ``,
    `${candidates.length} agents each produced a candidate answer below. Judge them as a quality gate.`,
    `Reply on a SINGLE line with EITHER "PASS <n>" (n = the number of the best candidate) OR "FAIL <reason>" if none are acceptable.`,
    ``,
    list,
  ].join('\n');
}

/**
 * @description Parse a reviewer's cluster verdict into pass/fail + winning candidate index.
 * Tolerant: "PASS 2" → pass, winner index 1; "FAIL too shallow" → fail; unparseable → pass with the
 * first candidate (a reviewer that answered but off-format shouldn't stall the workflow).
 * @param reply - the reviewer's reply
 * @param count - number of candidates (for clamping)
 * @returns { passed, winnerIndex?, feedback? }
 */
function parseClusterVerdict(reply: string, count: number): { passed: boolean; winnerIndex?: number; feedback?: string } {
  const text = (reply ?? '').trim();
  const pass = text.match(/\bPASS\b\s*#?(\d+)?/i);
  const fail = text.match(/\bFAIL\b\s*[:\-]?\s*(.*)/i);
  if (fail && (!pass || (fail.index ?? 0) < (pass.index ?? 0))) {
    return { passed: false, feedback: (fail[1] || 'reviewer rejected the cluster output').trim().slice(0, 300) };
  }
  if (pass) {
    const n = pass[1] ? Number(pass[1]) : 1;
    return { passed: true, winnerIndex: Math.min(Math.max(n, 1), count) - 1 };
  }
  return { passed: true, winnerIndex: 0 };
}

/** Factory — returns the adapter as the EngineServices interface for engine.setEngineServices(). */
export function createEngineServicesAdapter(deps: EngineServicesAdapterDeps): EngineServices {
  return new EngineServicesAdapter(deps);
}
