/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A2AHarnessAdapter — outbound A2A gateway harness (BACKLOG Plan F item 3). An external A2A agent becomes a first-class dispatch target: execute = JSON-RPC message/send to the remote agent's endpoint, then tasks/get polling with backoff until a terminal state (A2A_OUTBOUND_TIMEOUT_MS cap). HTTP-lifecycle harness (NOT BaseCliHarnessAdapter — there is no subprocess). Credentials resolve from env by bot key (A2A_OUTBOUND_TOKEN_<BOTKEY>), validated at CONSTRUCTION so a missing credential is a clean config error, never a mid-task surprise. Usage metadata from the remote is mapped verbatim into the HarnessResult (the existing recordCost path bills it under the bot's agent_id); absent usage records zero-cost with costUnknown=true + a WARN — unknown remote cost is not zero, and token counts are NEVER fabricated.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Moved the cost-event type declarations (A2ARemoteUsage, A2ACostEvent, A2ARecordCostFn) to the pure-types sibling a2a-cost-events.ts so the feature barrel can expose them to controller consumers without re-exporting this harness runtime module (barrel-boundary fix, TODO-BOUNDARY-FINDING 2026-07-19). Re-exported here for back-compat with deep importers (unit spec, harness sub-barrel).
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import {
  buildConversationAwarePrompt,
  type HarnessAdapter,
  type HarnessResult,
  type HarnessTask,
  type HarnessType,
} from './harness-adapter';
import type { A2ACostEvent, A2ARecordCostFn, A2ARemoteUsage } from './a2a-cost-events';

// Back-compat re-export: the cost-event types moved to the pure-types module
// a2a-cost-events.ts (so the feature barrel never re-exports this runtime
// module); deep importers of this adapter keep working unchanged.
export type { A2ACostEvent, A2ARecordCostFn, A2ARemoteUsage } from './a2a-cost-events';

const logger = createChildLogger({ module: 'a2a-harness-adapter' });

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 10_000;
const POLL_BACKOFF_FACTOR = 1.5;
const HEALTHCHECK_TIMEOUT_MS = 5_000;

/** A2A task states after which the remote will do no further work. */
const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected']);

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * @description Full configuration for the outbound A2A harness. The endpoint is
 * the remote agent's JSON-RPC URL; the credential resolves (highest wins) from
 * `authToken` → `A2A_OUTBOUND_TOKEN_<BOTKEY>` → `A2A_OUTBOUND_TOKEN`. Both the
 * endpoint and the credential are validated at construction: a misconfigured
 * external agent must fail loudly BEFORE a ticket is mid-flight on it.
 */
export interface A2AHarnessAdapterConfig {
  /** Remote A2A agent JSON-RPC endpoint URL (e.g. http://host:9999/a2a). */
  endpointUrl?: string;

  /** Name of the env var the endpoint came from — used in error messages only. */
  endpointEnvName?: string;

  /** Registry bot name; derives the per-bot token env A2A_OUTBOUND_TOKEN_<BOTKEY>. */
  botKey?: string;

  /** Explicit bearer token (tests / programmatic wiring). Overrides env lookup. */
  authToken?: string;

  /** Allow calling an unauthenticated remote agent (or env A2A_OUTBOUND_ALLOW_ANON=true). */
  allowAnonymous?: boolean;

  /** Overall run deadline in ms. Default env A2A_OUTBOUND_TIMEOUT_MS or 120000. */
  timeoutMs?: number;

  /** First tasks/get poll delay in ms (backs off ×1.5 per poll). Default 1000. */
  pollIntervalMs?: number;

  /** Poll backoff ceiling in ms. Default 10000. */
  maxPollIntervalMs?: number;

  /** Label used in the result model string (`a2a/<label>`). Default 'remote-agent'. */
  remoteAgentLabel?: string;

  /** Optional cost/attribution sink wired by the composition root. */
  recordCost?: A2ARecordCostFn;
}

// ── Helpers (exported for tests) ──────────────────────────────────────────────

/**
 * @description Derives the per-bot outbound token env var name from a registry
 * bot name — `a2a-sample-agent` → `A2A_OUTBOUND_TOKEN_A2A_SAMPLE_AGENT`. One
 * deterministic mapping so operators never guess which env var a bot reads.
 * @param botKey - The bot's registry name.
 * @returns The env var name that carries this bot's outbound bearer token.
 */
export function deriveA2ATokenEnvName(botKey: string): string {
  const normalized = botKey.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `A2A_OUTBOUND_TOKEN_${normalized}`;
}

/**
 * @description Reads remote-reported usage metadata from an A2A task/message
 * object, accepting the common key spellings (camelCase and snake_case).
 * Returns null when the remote reported nothing usable — the caller must treat
 * that as UNKNOWN cost, never as zero. Token counts are only accepted as
 * finite non-negative numbers; nothing is ever estimated or fabricated here.
 * @param node - The terminal A2A task or message object from the remote.
 * @returns Parsed usage, or null when the remote reported no usage metadata.
 */
export function readRemoteUsage(node: Record<string, unknown> | null | undefined): A2ARemoteUsage | null {
  const candidates: unknown[] = [
    readPath(node, ['metadata', 'usage']),
    readPath(node, ['status', 'message', 'metadata', 'usage']),
    readPath(node, ['usage']),
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const usage = candidate as Record<string, unknown>;
    const inputTokens = readCount(usage, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']);
    const outputTokens = readCount(usage, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']);
    if (inputTokens === null && outputTokens === null) continue;
    const totalCostUsd = readAmount(usage, ['totalCostUsd', 'total_cost_usd', 'costUsd', 'cost_usd', 'totalCost', 'total_cost']);
    return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, totalCostUsd };
  }
  return null;
}

/** @returns The value at a nested object path, or undefined. */
function readPath(node: Record<string, unknown> | null | undefined, path: string[]): unknown {
  let cursor: unknown = node;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** @returns The first finite non-negative integer under any of the keys, else null. */
function readCount(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return null;
}

/** @returns The first finite non-negative amount under any of the keys, else null. */
function readAmount(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/** @returns Concatenated text from an A2A parts[] array ({kind:'text', text}). */
function readPartsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      const kind = record.kind ?? record.type;
      return kind === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

/** @returns Milliseconds sleep as a promise. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * @description Outbound A2A harness — wraps one external A2A agent as a standard
 * OSHAL harness (ADR-033 HTTP-transport sibling of the CLI adapters). One `run()`
 * is: JSON-RPC `message/send` carrying the assembled prompt → poll `tasks/get`
 * with ×1.5 backoff until the remote task is terminal → map the remote artifacts
 * to the HarnessResult contract. The remote agent owns its own reasoning — from
 * the controller's perspective this is an HTTP call, never an LLM call
 * (two-runtimes rule), and in-swarm bots keep using the Redis mesh (A2A is for
 * EXTERNAL agents only).
 *
 * @example Registry wiring (both registry files)
 * ```ts
 * { name: 'a2a-sample-agent', harnessType: 'a2a', apiType: 'a2a',
 *   a2aEndpointEnv: 'A2A_SAMPLE_AGENT_URL', ... }
 * // token env: A2A_OUTBOUND_TOKEN_A2A_SAMPLE_AGENT
 * ```
 */
export class A2AHarnessAdapter implements HarnessAdapter {
  readonly harnessType: HarnessType = 'a2a';

  private readonly endpointUrl: string;
  private readonly endpointHost: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly remoteAgentLabel: string;
  private readonly recordCost?: A2ARecordCostFn;

  constructor(config: A2AHarnessAdapterConfig = {}) {
    this.endpointUrl = (config.endpointUrl ?? '').trim().replace(/\/$/, '');
    if (!this.endpointUrl) {
      throw new Error(
        `A2AHarnessAdapter: no remote agent endpoint configured — set ${config.endpointEnvName ?? 'the a2a endpoint env var'} `
        + 'to the external agent\'s JSON-RPC URL before dispatching to this bot.',
      );
    }
    this.endpointHost = safeHost(this.endpointUrl);

    const tokenEnv = config.botKey ? deriveA2ATokenEnvName(config.botKey) : undefined;
    const resolvedToken = config.authToken
      ?? (tokenEnv ? process.env[tokenEnv] : undefined)
      ?? process.env.A2A_OUTBOUND_TOKEN
      ?? '';
    const allowAnonymous = config.allowAnonymous ?? (process.env.A2A_OUTBOUND_ALLOW_ANON === 'true');
    if (!resolvedToken && !allowAnonymous) {
      // Fail at CONSTRUCTION: a credential gap must never surface mid-task.
      throw new Error(
        `A2AHarnessAdapter: no outbound credential for remote agent — set ${tokenEnv ?? 'A2A_OUTBOUND_TOKEN'} `
        + '(or A2A_OUTBOUND_ALLOW_ANON=true for an unauthenticated remote agent).',
      );
    }
    this.authToken = resolvedToken;

    this.timeoutMs = config.timeoutMs ?? readEnvInt('A2A_OUTBOUND_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    this.pollIntervalMs = config.pollIntervalMs ?? readEnvInt('A2A_OUTBOUND_POLL_MS', DEFAULT_POLL_INTERVAL_MS);
    this.maxPollIntervalMs = config.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
    this.remoteAgentLabel = config.remoteAgentLabel?.trim() || 'remote-agent';
    this.recordCost = config.recordCost;

    logger.info(
      {
        endpointHost: this.endpointHost,
        hasToken: this.authToken.length > 0,
        timeoutMs: this.timeoutMs,
        pollIntervalMs: this.pollIntervalMs,
        remoteAgentLabel: this.remoteAgentLabel,
      },
      'A2AHarnessAdapter initialized',
    );
  }

  /**
   * @description Executes one unit of work on the external A2A agent:
   * message/send, then tasks/get polling until terminal, then artifact mapping.
   * @param task - Normalised harness task from the execution pipeline.
   * @returns HarnessResult with the remote artifacts' text and honest usage.
   */
  async run(task: HarnessTask): Promise<HarnessResult> {
    const deadline = Date.now() + this.timeoutMs;
    const startMs = Date.now();
    const outboundText = this.buildOutboundText(task);

    logger.info(
      { taskId: task.taskId, agentId: task.agentId, endpointHost: this.endpointHost, promptLength: outboundText.length },
      'A2AHarnessAdapter: dispatching message/send to remote agent',
    );

    const sendResult = await this.rpc('message/send', {
      message: {
        kind: 'message',
        role: 'user',
        messageId: randomUUID(),
        parts: [{ kind: 'text', text: outboundText }],
        metadata: { oshalTaskId: task.taskId, oshalAgentId: task.agentId },
      },
    }, deadline);

    const terminal = await this.awaitTerminal(sendResult, deadline);
    const result = await this.mapTerminalToResult(terminal, task);

    logger.info(
      {
        taskId: task.taskId,
        agentId: task.agentId,
        endpointHost: this.endpointHost,
        durationMs: Date.now() - startMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        textLength: result.text.length,
      },
      'A2AHarnessAdapter: remote agent run completed',
    );
    return result;
  }

  /**
   * @description Liveness probe — fetches the remote's public A2A agent card at
   * `/.well-known/agent-card.json`. A reachable card means the agent is up.
   * @returns True when the agent card responds OK within the probe timeout.
   */
  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);
    try {
      const cardUrl = new URL('/.well-known/agent-card.json', this.endpointUrl).toString();
      const response = await fetch(cardUrl, { method: 'GET', signal: controller.signal });
      return response.ok;
    } catch (err) {
      logger.warn({ err, endpointHost: this.endpointHost }, 'A2AHarnessAdapter: healthCheck failed — remote agent card unreachable');
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * @description Assembles the outbound prompt: optional system/persona
   * instructions + conversation history + the current request. A2A has no
   * system role, so persona instructions travel as a labeled prompt section
   * (same collapse the one-shot CLI harnesses perform).
   */
  private buildOutboundText(task: HarnessTask): string {
    const conversationAware = buildConversationAwarePrompt(task);
    if (task.systemPrompt && task.systemPrompt.trim().length > 0) {
      return `## Operating instructions\n${task.systemPrompt.trim()}\n\n${conversationAware}`;
    }
    return conversationAware;
  }

  /**
   * @description Polls tasks/get with exponential backoff until the remote task
   * reaches a terminal state or the run deadline expires. An immediate
   * `message` result (the remote answered synchronously) short-circuits.
   */
  private async awaitTerminal(
    initial: Record<string, unknown>,
    deadline: number,
  ): Promise<Record<string, unknown>> {
    if (readKind(initial) === 'message') return initial;

    let current = initial;
    let interval = this.pollIntervalMs;
    while (!TERMINAL_STATES.has(readTaskState(current))) {
      const remoteTaskId = typeof current.id === 'string' ? current.id : '';
      if (!remoteTaskId) {
        throw new Error('A2AHarnessAdapter: remote agent returned an unrecognized response shape (no task id, no message)');
      }
      if (Date.now() + interval >= deadline) {
        throw new Error(
          `A2AHarnessAdapter: remote task ${remoteTaskId} did not reach a terminal state within ${this.timeoutMs}ms — failing cleanly (no retry)`,
        );
      }
      await sleep(interval);
      interval = Math.min(interval * POLL_BACKOFF_FACTOR, this.maxPollIntervalMs);
      current = await this.rpc('tasks/get', { id: remoteTaskId }, deadline);
    }
    return current;
  }

  /**
   * @description Maps the terminal A2A object to the HarnessResult contract and
   * emits the cost/attribution event. Non-completed terminal states become one
   * clean harness error (the queue's normal failure path — no retry storm).
   */
  private async mapTerminalToResult(
    terminal: Record<string, unknown>,
    task: HarnessTask,
  ): Promise<HarnessResult> {
    const isDirectMessage = readKind(terminal) === 'message';
    const state = isDirectMessage ? 'completed' : readTaskState(terminal);
    if (state !== 'completed') {
      const remoteDetail = readPartsText(readPath(terminal, ['status', 'message', 'parts'])) || 'no detail provided';
      throw new Error(`A2AHarnessAdapter: remote agent task ended '${state}' — ${remoteDetail.slice(0, 300)}`);
    }

    const text = this.extractResultText(terminal, isDirectMessage);
    if (!text) {
      throw new Error('A2AHarnessAdapter: remote agent completed but returned no text artifacts');
    }

    const usage = readRemoteUsage(terminal);
    await this.emitCostEvent(task, usage);

    return {
      text,
      usage: { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 },
      model: `a2a/${this.remoteAgentLabel}`,
      stopReason: 'end_turn',
    };
  }

  /**
   * @description Extracts the result text: artifact text parts first (the A2A
   * deliverable channel), falling back to the terminal status message, or the
   * direct message parts when the remote answered synchronously.
   */
  private extractResultText(terminal: Record<string, unknown>, isDirectMessage: boolean): string {
    if (isDirectMessage) return readPartsText(terminal.parts);
    const artifacts = terminal.artifacts;
    if (Array.isArray(artifacts)) {
      const artifactText = artifacts
        .map((artifact) => (artifact && typeof artifact === 'object'
          ? readPartsText((artifact as Record<string, unknown>).parts)
          : ''))
        .filter((text) => text.length > 0)
        .join('\n\n');
      if (artifactText) return artifactText;
    }
    return readPartsText(readPath(terminal, ['status', 'message', 'parts']));
  }

  /**
   * @description Emits the cost/attribution event for this run. Remote-reported
   * usage is forwarded verbatim; an absent report is recorded as ZERO-cost with
   * `costUnknown: true` and a WARN — unknown remote cost is not zero, and this
   * adapter never fabricates token counts. Recording failures are non-fatal.
   */
  private async emitCostEvent(task: HarnessTask, usage: A2ARemoteUsage | null): Promise<void> {
    if (usage === null) {
      logger.warn(
        { taskId: task.taskId, agentId: task.agentId, endpointHost: this.endpointHost },
        'A2AHarnessAdapter: remote agent reported NO usage metadata — recording zero-cost with costUnknown=true (unknown remote cost is not zero)',
      );
    }
    if (!this.recordCost) return;

    const event: A2ACostEvent = {
      taskId: task.taskId ?? `a2a-${randomUUID()}`,
      agentId: task.agentId ?? 'unknown-agent',
      providerId: 'a2a',
      modelId: `a2a/${this.remoteAgentLabel}`,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      inputCost: 0,
      outputCost: 0,
      totalCost: usage?.totalCostUsd ?? 0,
      currency: 'USD',
      requestCount: usage ? 1 : 0,
      costUnknown: usage === null,
      remoteEndpointHost: this.endpointHost,
    };
    try {
      await this.recordCost(event);
    } catch (err) {
      logger.error({ err, taskId: task.taskId, agentId: task.agentId }, 'A2AHarnessAdapter: cost event recording failed — non-blocking');
    }
  }

  /**
   * @description One JSON-RPC 2.0 call to the remote endpoint, bounded by the
   * remaining run deadline. RPC-level errors and non-2xx responses become clean
   * harness errors; response bodies are truncated in logs and errors.
   */
  private async rpc(
    method: string,
    params: Record<string, unknown>,
    deadline: number,
  ): Promise<Record<string, unknown>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`A2AHarnessAdapter: run deadline (${this.timeoutMs}ms) exceeded before '${method}' could be sent`);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Response;
    try {
      response = await fetch(this.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('abort')) {
        throw new Error(`A2AHarnessAdapter: '${method}' timed out against the remote agent (deadline ${this.timeoutMs}ms)`);
      }
      logger.error({ err, method, endpointHost: this.endpointHost }, 'A2AHarnessAdapter: network error calling remote agent');
      throw new Error(`A2AHarnessAdapter: network error on '${method}' — ${message}`);
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      logger.error(
        { method, status: response.status, endpointHost: this.endpointHost, body: bodyText.slice(0, 300) },
        'A2AHarnessAdapter: remote agent returned an HTTP error status',
      );
      throw new Error(`A2AHarnessAdapter: remote agent HTTP ${response.status} on '${method}' — ${bodyText.slice(0, 300)}`);
    }
    return parseRpcBody(bodyText, method);
  }
}

/**
 * @description Parses a JSON-RPC 2.0 response body, surfacing rpc-level errors
 * as clean harness errors and rejecting non-object results.
 * @param bodyText - Raw HTTP response body.
 * @param method - The RPC method (error context only).
 * @returns The JSON-RPC `result` object.
 */
function parseRpcBody(bodyText: string, method: string): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error(`A2AHarnessAdapter: remote agent returned non-JSON on '${method}' — ${bodyText.slice(0, 200)}`);
  }
  const rpcError = parsed.error as { code?: number; message?: string } | undefined;
  if (rpcError) {
    throw new Error(`A2AHarnessAdapter: remote agent error ${rpcError.code ?? 'unknown'} on '${method}' — ${rpcError.message ?? 'no message'}`);
  }
  const result = parsed.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`A2AHarnessAdapter: remote agent returned no result object on '${method}'`);
  }
  return result as Record<string, unknown>;
}

/** @returns The A2A object kind ('task' | 'message' | ''). */
function readKind(node: Record<string, unknown>): string {
  return typeof node.kind === 'string' ? node.kind : '';
}

/** @returns The A2A task state (status.state), or '' when absent. */
function readTaskState(node: Record<string, unknown>): string {
  const state = readPath(node, ['status', 'state']);
  return typeof state === 'string' ? state : '';
}

/** @returns The hostname of a URL, or the raw string when unparsable. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** @returns A positive integer env value, else the fallback. */
function readEnvInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
