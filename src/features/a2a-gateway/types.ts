/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial spec-facing contracts for the inbound A2A gateway (BACKLOG Plan F). Targets the Linux Foundation A2A spec (a2a-protocol.org, JSONRPC transport): agent card at /.well-known/agent-card.json, JSON-RPC 2.0 methods message/send + tasks/get + tasks/cancel, kebab-case TaskState values, and the spec's -3200x error codes. EXTENDS the internal shared shapes in @/shared/types/a2a.ts rather than forking them — internal envelopes map to these spec shapes only at the gateway boundary.
 */

import { z } from 'zod';
import type { OshalTicketState } from '@/entities/ticket';
import type { StoredMessage } from '@/shared/types';

/**
 * @description The A2A protocol version this gateway advertises on its agent card.
 * Pinned so third-party clients can negotiate; bump deliberately with spec upgrades.
 */
export const A2A_PROTOCOL_VERSION = '0.3.0';

/**
 * @description The spec's well-known agent-card path (RFC 8615). Published verbatim so
 * third-party A2A clients discover the swarm without OSHAL-specific configuration.
 */
export const A2A_AGENT_CARD_PATH = '/.well-known/agent-card.json';

/**
 * @description Spec TaskState values (JSONRPC transport uses kebab-case strings). Our
 * internal OshalTicketState maps onto these at the boundary via mapTicketStateToA2A.
 */
export const A2ATaskStateSchema = z.enum([
  'submitted',
  'working',
  'input-required',
  'completed',
  'canceled',
  'failed',
  'rejected',
  'auth-required',
  'unknown',
]);

/** @description One spec task state value. */
export type A2ATaskState = z.infer<typeof A2ATaskStateSchema>;

/**
 * @description JSON-RPC 2.0 request envelope (the single POST /api/a2a endpoint).
 * `id` may be absent (notification) — we still answer, per the strict request/response
 * shape the A2A spec expects from non-streaming transports.
 */
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** @description A parsed JSON-RPC request. */
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

/**
 * @description JSON-RPC 2.0 error codes used by the gateway: the standard set plus the
 * A2A-specific codes (spec section "Error Handling") and one implementation-defined code
 * (-32000, reserved server range) for inbound rate limiting.
 */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** A2A: task id unknown to this server (or not visible to the calling agent). */
  TASK_NOT_FOUND: -32001,
  /** A2A: task exists but is in a state that cannot be canceled. */
  TASK_NOT_CANCELABLE: -32002,
  /** A2A: operation not available — the gateway also uses it for scope denials. */
  UNSUPPORTED_OPERATION: -32004,
  /** Implementation-defined (reserved -32000..-32099): per-agent inbound rate limit. */
  RATE_LIMITED: -32000,
} as const;

/**
 * @description Capability scopes a minted A2A agent credential may hold. Scopes gate the
 * JSON-RPC methods 1:1 so an operator can mint read-only or send-only credentials.
 */
export const A2A_SCOPES = ['message:send', 'tasks:read', 'tasks:cancel'] as const;

/** @description One A2A credential scope. */
export type A2AScope = (typeof A2A_SCOPES)[number];

/**
 * @description JSON-RPC method → required scope. A method absent from this map is not
 * served by the gateway at all (METHOD_NOT_FOUND).
 */
export const SCOPE_FOR_METHOD: Readonly<Record<string, A2AScope>> = {
  'message/send': 'message:send',
  'tasks/get': 'tasks:read',
  'tasks/cancel': 'tasks:cancel',
};

/**
 * @description Spec `message/send` params. Parts are accepted loosely (the spec allows
 * text/file/data parts) — the gateway extracts the text parts and rejects a message with
 * none, because a ticket needs a textual work description.
 */
export const A2AMessageSendParamsSchema = z.object({
  message: z.object({
    role: z.string().optional(),
    parts: z.array(z.record(z.string(), z.unknown())).min(1),
    messageId: z.string().optional(),
    taskId: z.string().optional(),
    contextId: z.string().optional(),
    kind: z.string().optional(),
  }),
  configuration: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** @description Parsed `message/send` params. */
export type A2AMessageSendParams = z.infer<typeof A2AMessageSendParamsSchema>;

/** @description Spec `tasks/get` / `tasks/cancel` params — the task id (+ optional history hint). */
export const A2ATaskIdParamsSchema = z.object({
  id: z.string().min(1),
  historyLength: z.number().int().nonnegative().optional(),
});

/** @description Parsed task-id params. */
export type A2ATaskIdParams = z.infer<typeof A2ATaskIdParamsSchema>;

/**
 * @description Spec-shaped artifact returned from tasks/get: a stable artifactId plus
 * text parts. This is the boundary projection of our internal result messages — the
 * internal A2AArtifact contract in @/shared/types/a2a.ts stays untouched.
 */
export interface A2ASpecArtifact {
  artifactId: string;
  name?: string;
  parts: Array<{ kind: 'text'; text: string }>;
}

/** @description Spec-shaped Task object returned by message/send, tasks/get, tasks/cancel. */
export interface A2ASpecTask {
  id: string;
  contextId: string;
  status: { state: A2ATaskState; timestamp: string };
  artifacts?: A2ASpecArtifact[];
  kind: 'task';
  metadata?: Record<string, unknown>;
}

/** @description One curated skill row on the published agent card. */
export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

/** @description The published agent card (spec AgentCard, JSONRPC transport). */
export interface A2ASpecAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: 'JSONRPC';
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  securitySchemes: Record<string, { type: string; scheme: string; description: string }>;
  security: Array<Record<string, string[]>>;
  skills: A2AAgentSkill[];
}

/** @description The authenticated identity attached to a JSON-RPC request by the bearer check. */
export interface A2AAgentIdentity {
  agentId: string;
  name: string;
  scopes: A2AScope[];
}

/**
 * @description Maps an internal OshalTicketState onto the spec TaskState an external
 * agent understands. dead_letter is TERMINAL poison quarantine → 'failed'; the
 * approval/customer gates need input → 'input-required'; everything actively held by
 * the swarm (in_process*, escalated, paused) reads as 'working' — external agents get
 * lifecycle truth without internal queue vocabulary leaking.
 * @param state - The internal canonical ticket state.
 * @returns The spec task state.
 */
export function mapTicketStateToA2A(state: OshalTicketState): A2ATaskState {
  if (state === 'complete') return 'completed';
  if (state === 'cancelled') return 'canceled';
  if (state === 'dead_letter') return 'failed';
  if (state === 'approval_required' || state === 'customer_action') return 'input-required';
  if (state === 'backlog' || state === 'approved') return 'submitted';
  return 'working';
}

/**
 * @description Projects a ticket's result messages into spec artifacts. Prefers the
 * structured bot-node completion (metadata.manifestWorkerResult — the same trusted
 * capture Jarvis's summarizer keys on) and falls back to the newest substantial message,
 * so legacy result paths still surface. Returns [] when nothing readable exists.
 * @param messages - The ticket's stored messages, oldest-first.
 * @returns Spec artifacts (at most one — the deliverable).
 */
export function specArtifactsFromMessages(messages: StoredMessage[]): A2ASpecArtifact[] {
  const newestFirst = [...(messages ?? [])].reverse();
  const completion = newestFirst.find(
    (m) => m.metadata?.manifestWorkerResult === true && String(m.text ?? '').trim().length > 0,
  );
  const chosen = completion ?? newestFirst.find((m) => String(m.text ?? '').trim().length > 30);
  if (!chosen) return [];
  return [{
    artifactId: chosen.messageId || 'result-1',
    name: 'result',
    parts: [{ kind: 'text', text: chosen.text }],
  }];
}
