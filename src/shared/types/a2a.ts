/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added shared A2A and remote-client contracts for OSHAL remote endpoint agents
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added ownerSub to the registration contract — per-user device ownership binding (repo-audit 2026-07-05 finding: any authenticated user could enqueue shell-exec-class tasks to, and read results from, ANY registered device). The owning user's OIDC sub is recorded at registration; route-level enforcement lives in remote-client-routes.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Reject blank remote-client owner subjects without transforming valid case/whitespace identity bytes.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Bound remote task/chat owner subjects to the exact control-free 512-byte identity contract without applying transforms.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Carry a bounded one-use HTTP completion capability outside model-visible tool arguments so trusted remote runtime code can report browser-task results without exposing a reusable fleet secret.
 */

import { z } from 'zod';
import { isExactUserSubject } from '@/shared/security/exact-user-subject';

const ExactUserSubjectSchema = z.string().refine(
  isExactUserSubject,
  'user subject must be exact UTF-8, control-free, and at most 512 bytes',
);

/**
 * @description Supported transport families for A2A-style remote agents.
 */
export const A2ATransportSchema = z.enum(['headscale-http', 'http', 'sse', 'stdio']);

/**
 * @description Transport family used by the remote agent.
 */
export type A2ATransport = z.infer<typeof A2ATransportSchema>;

/**
 * @description Supported host platforms for remote endpoint clients.
 */
export const RemoteClientPlatformSchema = z.enum(['macos', 'windows', 'linux', 'unknown']);

/**
 * @description Host platform value for the remote endpoint client.
 */
export type RemoteClientPlatform = z.infer<typeof RemoteClientPlatformSchema>;

/**
 * @description Shared artifact contract returned from A2A / remote-client execution.
 */
export const A2AArtifactSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  uri: z.string().optional(),
  content: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * @description Shared artifact contract.
 */
export type A2AArtifact = z.infer<typeof A2AArtifactSchema>;

/**
 * @description Agent-card style metadata published by OSHAL and remote endpoint clients.
 */
export const A2AAgentCardSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional().default(''),
  transport: A2ATransportSchema,
  endpointUrl: z.string().url().optional(),
  tailnetHostname: z.string().optional(),
  platform: RemoteClientPlatformSchema.optional().default('unknown'),
  capabilities: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  mcpServerName: z.string().optional(),
  mcpServerCommand: z.string().optional(),
  mcpToolCount: z.number().int().nonnegative().optional().default(0),
  healthy: z.boolean().optional().default(true),
  lastSeenAt: z.string().datetime().nullable().optional().default(null),
});

/**
 * @description Agent-card metadata.
 */
export type A2AAgentCard = z.infer<typeof A2AAgentCardSchema>;

/**
 * @description Identity payload used when a remote client registers itself with OSHAL.
 */
export const RemoteClientRegistrationSchema = z.object({
  clientId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  /**
   * OIDC sub of the user who OWNS this device. Task enqueue / result reads by
   * signed-in users are restricted to the owner (or an operator). A node asserts
   * its owner from its local signed-in config; a browser-session registration
   * defaults it to the session sub. Absent = unowned → fail-closed to
   * operator-only for session callers (see canAccessResource).
   */
  ownerSub: ExactUserSubjectSchema
    .refine((value) => value.trim().length > 0, 'ownerSub must be nonblank')
    .optional(),
  name: z.string().min(1),
  description: z.string().optional().default(''),
  transport: A2ATransportSchema,
  platform: RemoteClientPlatformSchema.optional().default('unknown'),
  controlPlaneUrl: z.string().url(),
  endpointUrl: z.string().url().optional(),
  tailnetHostname: z.string().optional(),
  mcpServerName: z.string().optional(),
  mcpServerCommand: z.string().optional(),
  capabilities: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  mcp: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional().default([]),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional().default({}),
  }).optional(),
});

/**
 * @description Remote client registration payload.
 */
export type RemoteClientRegistration = z.infer<typeof RemoteClientRegistrationSchema>;

/**
 * @description Heartbeat status values for remote clients.
 */
export const RemoteClientStatusSchema = z.enum(['online', 'degraded', 'offline']);

/**
 * @description Heartbeat payload emitted by remote clients.
 */
export const RemoteClientHeartbeatSchema = z.object({
  clientId: z.string().min(1),
  agentId: z.string().min(1).optional(),
  status: RemoteClientStatusSchema,
  controlPlaneReachable: z.boolean(),
  mcpReady: z.boolean(),
  activeTaskId: z.string().optional(),
  toolCount: z.number().int().nonnegative().optional().default(0),
  lastSeenAt: z.string().datetime(),
  version: z.string().optional(),
});

/**
 * @description Remote client heartbeat payload.
 */
export type RemoteClientHeartbeat = z.infer<typeof RemoteClientHeartbeatSchema>;

/**
 * @description A2A task intent values used by the remote client bridge.
 */
export const A2ATaskIntentSchema = z.enum([
  'mcp.initialize',
  'mcp.list-tools',
  'mcp.call-tool',
  'mcp.shutdown',
  'status.sync',
]);

/**
 * @description A2A task intent.
 */
export type A2ATaskIntent = z.infer<typeof A2ATaskIntentSchema>;

const A2ACallbackContextValueSchema = z.union([
  z.string().max(512),
  z.number().int().safe(),
  z.boolean(),
]);

/**
 * @description Trusted remote-runtime metadata for one bounded JSON result callback. The
 * capability is deliberately top-level on the task and must never be copied into tool arguments.
 */
export const A2ATaskCompletionCallbackSchema = z.object({
  kind: z.literal('trusted-http-json-v1'),
  url: z.string().url().max(2048),
  capability: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
  context: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/), A2ACallbackContextValueSchema)
    .refine((value) => Object.keys(value).length <= 8, 'callback context has too many fields'),
}).strict();

/** @description Trusted completion callback metadata inferred from the shared wire schema. */
export type A2ATaskCompletionCallback = z.infer<typeof A2ATaskCompletionCallbackSchema>;

/**
 * @description A2A task envelope used for bot-to-bot and control-plane-to-client dispatch.
 */
export const A2ATaskEnvelopeSchema = z.object({
  taskId: z.string().min(1),
  correlationId: z.string().min(1),
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  intent: A2ATaskIntentSchema,
  input: z.record(z.string(), z.unknown()).optional().default({}),
  artifacts: z.array(A2AArtifactSchema).optional().default([]),
  workspacePath: z.string().optional(),
  replyTo: z.string().optional(),
  completionCallback: A2ATaskCompletionCallbackSchema.optional(),
  // The end-user OIDC sub the task is on behalf of — carried so leaf-node cost capture
  // (handleCompleteTask → recordCost) can attribute spend per-owner for budget caps.
  userSub: ExactUserSubjectSchema.optional(),
  createdAt: z.string().datetime(),
  status: z.enum(['queued', 'claimed', 'running', 'completed', 'failed']).optional().default('queued'),
});

/**
 * @description A2A task envelope.
 */
export type A2ATaskEnvelope = z.infer<typeof A2ATaskEnvelopeSchema>;

/**
 * @description Structured execution result returned by a remote client.
 */
export const A2ATaskResultSchema = z.object({
  taskId: z.string().min(1),
  correlationId: z.string().min(1),
  clientId: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  output: z.unknown().optional(),
  artifacts: z.array(A2AArtifactSchema).optional().default([]),
  error: z.string().optional(),
  completedAt: z.string().datetime(),
});

/**
 * @description A2A task execution result.
 */
export type A2ATaskResult = z.infer<typeof A2ATaskResultSchema>;
