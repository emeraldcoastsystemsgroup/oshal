/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The OSHAL Node runs its own chat turns locally (operator, 2026-10-01: "it executes the stuff locally"). When the bot behind a node's chat resolves to a CLI harness the controller refuses to run unattended (the fleet default is antigravity-cli), and the requesting node advertises the matching local executor, the turn's model call is handed to THAT node: NodeExecutorProvider queues one mcp.call-tool task on the node's own durable task queue (origin 'node-chat') and waits for its result. The TaskOrchestrator still owns the conversation (history, persistence, usage); only the model call runs on the node, with the person's own CLI sign-in. No other node is ever asked, and a node without the executor keeps the controller path unchanged.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fixes: a stale node-chat claim (claimed longer than the deadline) is expired through the journal's settle path before a new turn is queued, so one lost settle cannot block every later turn; the turn's task is withdrawn when the controller stops waiting, so a stale run never answers nobody; a transient poll error is retried, not fatal; the bot's model travels to the node; the prompt budget never cuts the person's own latest message (the system slice and older turns give way, and a message that still cannot fit is refused with the limit named).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The handed-off prompt opens with NODE_CHAT_ANSWER_RULES (reply directly, in plain text, run no commands or tools), before any persona text: the first live hand-off ran a 60-second agentic session on the person's computer and returned a narration instead of an answer. The rules are never cut by the budget.
 */
import { randomUUID } from 'node:crypto';
import {
  LLMService,
  isUnbrokeredAutonomousProvider,
  type LLMResponse,
  type SendRequestOptions,
} from '@/features/llm-provider';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'remote-client-node-chat' });

/** The node-local tool that runs each CLI harness (packages/oshal-chat/src/main/local-tools.ts). */
export const NODE_CHAT_TOOL_BY_HARNESS: Readonly<Record<string, string>> = Object.freeze({
  'antigravity-cli': 'antigravity.exec',
  'codex-cli': 'codex.exec',
  'claude-code': 'claude.exec',
});

/** Under the node's Windows command-line cap for the prompt argument (MAX_ANTIGRAVITY_PROMPT_CHARS is 24,000). */
export const NODE_PROMPT_BUDGET_CHARS = 20_000;
const SYSTEM_BUDGET_CHARS = 4_000;
/** How the CLI must answer a chat turn: as a reply, not as an agent. It comes first, before any persona text. */
export const NODE_CHAT_ANSWER_RULES = [
  '## How to answer',
  'This is one chat message from the person who owns this computer. Reply to it directly, in plain text, in their language.',
  'Do not run commands, read or write files, browse, or use any tool: everything you need is in this prompt, and a reply that',
  'describes work you started is not an answer. If the persona below mentions tools, ignore that for this reply.',
].join('\n');
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 1_000;

/** The part of the remote-client registry this provider needs: the node's own durable task queue. */
export interface NodeTaskQueue {
  enqueueTask(clientId: string, taskInput: unknown): Promise<unknown>;
  getCompletedResult(clientId: string, taskId: string): Promise<{ status: 'completed' | 'failed'; output?: unknown; error?: string } | null>;
  /** The task the node is running now (status 'claimed'), with when it was claimed and its input. */
  getActiveTask?(clientId: string): Promise<{ taskId: string; correlationId: string; claimedAt: string | null; input?: Record<string, unknown> } | null>;
  /** Settle one of this client's tasks as failed with a reason, through the journal's own first-writer settlement. */
  failTask?(clientId: string, resultInput: unknown): Promise<unknown>;
}

/** A node chat plan: which harness the controller refused and which local tool runs it on the node. */
export interface NodeChatPlan {
  harnessType: string;
  tool: string;
  /** The model the swarm configured for the bot, when its provider names one; otherwise the node's own default. */
  model?: string;
}

/**
 * @description Decide whether a node's chat turn runs on that node. Only when the bot's provider is a CLI harness the
 * controller refuses unattended (harness:<type>) AND the requesting node advertises the matching local executor.
 * Anything else (a hosted provider, an unknown harness, a node without the tool) keeps the controller path.
 * @param providerName The name of the provider the orchestrator would use for this bot (e.g. harness:antigravity-cli).
 * @param capabilities The requesting node's advertised capabilities.
 * @returns The plan, or null when the controller path applies.
 */
export function planNodeChat(providerName: string | undefined, capabilities: readonly string[] | undefined, model?: string): NodeChatPlan | null {
  const match = /^harness:([a-z0-9-]+)$/.exec(String(providerName || ''));
  if (!match || !isUnbrokeredAutonomousProvider(match[1])) return null;
  const tool = NODE_CHAT_TOOL_BY_HARNESS[match[1]];
  if (!tool || !(capabilities || []).includes(tool)) return null;
  const chosen = typeof model === 'string' ? model.trim() : '';
  return chosen ? { harnessType: match[1], tool, model: chosen } : { harnessType: match[1], tool };
}

/** The plain text of one chat message (a string, or the text blocks of a block array). */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * @description Compose the single prompt a CLI receives: a bounded slice of the system prompt, then as much recent
 * conversation as fits, newest kept, under the node's command-line budget. Swarm tools are not offered: the node
 * answers in text.
 * @param systemPrompt The bot's system prompt, if any.
 * @param messages The conversation the orchestrator built, oldest first.
 * @param budget The character budget for the whole prompt.
 * @returns The prompt.
 */
export function composeNodePrompt(systemPrompt: string | undefined, messages: ReadonlyArray<{ role?: string; content?: unknown }>, budget = NODE_PROMPT_BUDGET_CHARS): string {
  const system = String(systemPrompt || '').trim().slice(0, SYSTEM_BUDGET_CHARS);
  const rules = `${NODE_CHAT_ANSWER_RULES}\n\n`;
  const head = rules + (system ? `## System instructions\n${system}\n\n` : '');
  const turns = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role === 'user' ? 'User' : 'Assistant', text: messageText(m.content).trim() }))
    .filter((m) => m.text);
  const last = turns.pop();
  const request = `## Request\n${last ? last.text : ''}`;
  const requestChars = request.length - '## Request\n'.length;
  const maxRequest = budget - rules.length - '## System instructions\n\n\n'.length - '## Request\n'.length;
  if (requestChars > maxRequest) {
    throw new Error(`Your message is ${requestChars} characters; this computer's CLI takes at most ${maxRequest} in one turn. Please shorten it.`);
  }
  const systemRoom = Math.max(0, budget - rules.length - request.length - '## System instructions\n\n\n'.length);
  const headFits = head.length + request.length > budget ? rules + (systemRoom > 0 && system ? `## System instructions\n${system.slice(0, systemRoom)}\n\n` : '') : head;
  let room = budget - headFits.length - request.length - 40;
  const kept: string[] = [];
  for (let i = turns.length - 1; i >= 0 && room > 0; i -= 1) {
    const line = `${turns[i].role}: ${turns[i].text}`;
    if (line.length + 1 > room) break;
    kept.unshift(line);
    room -= line.length + 1;
  }
  const history = kept.length ? `## Conversation so far\n${kept.join('\n')}\n\n` : '';
  const prompt = `${headFits}${history}${request}`;
  return prompt.length <= budget ? prompt : `${headFits}${request}`;
}

/** The reply text a node task result carries (output.response from the node's local executor). */
function resultText(output: unknown): string {
  return output && typeof output === 'object' && typeof (output as { response?: unknown }).response === 'string'
    ? String((output as { response: string }).response).trim()
    : '';
}

/** Token usage a node task result reports, when it reports any. */
function resultUsage(output: unknown): { inputTokens: number; outputTokens: number } {
  const usage = output && typeof output === 'object' ? (output as { usage?: Record<string, unknown> }).usage : undefined;
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return { inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens) };
}

/** Construction inputs for one node-executed chat turn. */
export interface NodeExecutorProviderOptions {
  queue: NodeTaskQueue;
  clientId: string;
  agentId: string;
  plan: NodeChatPlan;
  chatTaskId: string;
  userSub?: string;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * @description An LLMService whose model call runs on the requesting OSHAL Node: one mcp.call-tool task on that node's
 * own queue, awaited until the node reports a result. A failed or empty result, or no result in time, is an error the
 * orchestrator reports to the node instead of an answer.
 */
export class NodeExecutorProvider extends LLMService {
  private readonly options: NodeExecutorProviderOptions;

  constructor(options: NodeExecutorProviderOptions) {
    super(`node:${options.plan.harnessType}`, {});
    this.options = options;
  }

  /**
   * @description Run the turn's model call on the node and return its answer.
   * @param request The orchestrator's request (system prompt and conversation).
   * @returns The node's answer as an LLM response.
   */
  async sendRequest(request: SendRequestOptions): Promise<LLMResponse> {
    const { queue, clientId, agentId, plan, chatTaskId, userSub } = this.options;
    const prompt = composeNodePrompt(request.systemPrompt, request.messages as ReadonlyArray<{ role?: string; content?: unknown }>);
    const taskId = `node-chat-${randomUUID()}`;
    const started = Date.now();
    logger.info({ clientId, agentId, chatTaskId, taskId, tool: plan.tool, promptChars: prompt.length }, 'Node chat turn handed to the requesting node');
    await this.expireStaleClaim();
    await queue.enqueueTask(clientId, {
      taskId,
      correlationId: taskId,
      fromAgentId: agentId,
      toAgentId: clientId,
      intent: 'mcp.call-tool',
      input: { name: plan.tool, arguments: plan.model ? { prompt, model: plan.model } : { prompt }, origin: 'node-chat', chatTaskId },
      ...(userSub ? { userSub } : {}),
      createdAt: new Date(started).toISOString(),
    });
    let result: { status: 'completed' | 'failed'; output?: unknown; error?: string };
    try {
      result = await this.awaitResult(taskId, started);
    } catch (error) {
      await this.withdraw(taskId, error instanceof Error ? error.message : 'the controller stopped waiting');
      throw error;
    }
    const text = resultText(result.output);
    if (result.status !== 'completed' || !text) {
      throw new Error(result.error || `This computer's ${plan.harnessType} run returned no answer.`);
    }
    logger.info({ clientId, chatTaskId, taskId, durationMs: Date.now() - started }, 'Node chat turn answered');
    return { content: [{ type: 'text', text }], usage: resultUsage(result.output), model: this.getProviderName() } as LLMResponse;
  }

  /**
   * A node-chat task claimed longer than the deadline is a lost settle (the node quit or lost its network mid-run). The
   * journal has no lease, so that claim would block every later turn on the node; fail it through the journal's own
   * settlement so the slot frees. Only this provider's kind of task (origin node-chat) is ever expired.
   */
  private async expireStaleClaim(): Promise<void> {
    const { queue, clientId } = this.options;
    if (!queue.getActiveTask || !queue.failTask) return;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let active: { taskId: string; correlationId: string; claimedAt: string | null; input?: Record<string, unknown> } | null = null;
    try {
      active = await queue.getActiveTask(clientId);
    } catch (error) {
      logger.warn({ err: error, clientId }, 'Node chat: active-task read failed; nothing expired');
      return;
    }
    if (!active || active.input?.origin !== 'node-chat') return;
    const claimedAt = active.claimedAt ? Date.parse(active.claimedAt) : NaN;
    if (!Number.isFinite(claimedAt) || Date.now() - claimedAt < timeoutMs) return;
    await this.withdraw(active.taskId, 'the node never reported this run; expired by the controller', active.correlationId);
  }

  /** Settle a node-chat task of this client as failed so the node's single slot is free again. Best effort. */
  private async withdraw(taskId: string, reason: string, correlationId = taskId): Promise<void> {
    const { queue, clientId } = this.options;
    if (!queue.failTask) return;
    try {
      await queue.failTask(clientId, { taskId, correlationId, clientId, status: 'failed', error: reason, completedAt: new Date().toISOString() });
      logger.info({ clientId, taskId, reason }, 'Node chat task withdrawn');
    } catch (error) {
      logger.warn({ err: error, clientId, taskId }, 'Node chat task could not be withdrawn');
    }
  }

  /** Poll the node's queue for this task's terminal result until the deadline; a transient read error is retried. */
  private async awaitResult(taskId: string, started: number): Promise<{ status: 'completed' | 'failed'; output?: unknown; error?: string }> {
    const { queue, clientId, plan } = this.options;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    let readErrors = 0;
    while (Date.now() - started < timeoutMs) {
      try {
        const result = await queue.getCompletedResult(clientId, taskId);
        if (result) return result;
        readErrors = 0;
      } catch (error) {
        readErrors += 1;
        logger.warn({ err: error, clientId, taskId, readErrors }, 'Node chat: result read failed; retrying');
        if (readErrors >= 5) throw new Error("The swarm could not read this computer's answer.");
      }
      await sleep(pollMs);
    }
    logger.warn({ clientId, taskId, timeoutMs }, 'Node chat turn timed out waiting for the node');
    throw new Error(`This computer did not answer within ${Math.round(timeoutMs / 60_000)} minutes; its ${plan.harnessType} run may still finish.`);
  }
}

/** Inputs for deciding and building a node-executed chat turn. */
export interface NodeTurnProviderInput {
  getChatProvider?: (agentId: string) => { getProviderName(): string; getModel?: () => string | undefined };
  capabilities?: readonly string[];
  queue: NodeTaskQueue;
  clientId: string;
  agentId: string;
  chatTaskId: string;
  userSub?: string;
}

/**
 * @description The provider for a node's chat turn when that node should run it, else undefined (the controller path).
 * A provider lookup that throws keeps the controller path and is logged, never surfaced as a different failure.
 * @param input The bot, the requesting node and its queue.
 * @returns A NodeExecutorProvider, or undefined.
 */
export function resolveNodeTurnProvider(input: NodeTurnProviderInput): NodeExecutorProvider | undefined {
  if (!input.getChatProvider) return undefined;
  let providerName: string | undefined;
  let model: string | undefined;
  try {
    const provider = input.getChatProvider(input.agentId);
    providerName = provider.getProviderName();
    model = typeof provider.getModel === 'function' ? provider.getModel() : undefined;
  } catch (error) {
    logger.error({ err: error, agentId: input.agentId, clientId: input.clientId }, 'Node chat: provider lookup failed; the controller path applies');
    return undefined;
  }
  const plan = planNodeChat(providerName, input.capabilities, model);
  if (!plan) return undefined;
  return new NodeExecutorProvider({
    queue: input.queue, clientId: input.clientId, agentId: input.agentId, plan, chatTaskId: input.chatTaskId, userSub: input.userSub,
  });
}
