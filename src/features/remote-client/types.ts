/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added remote-client runtime contracts and configuration schema
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added remote-client chat request/accept schemas for the conversational A2A bridge
 */

import { z } from 'zod';
import {
  A2ATransportSchema,
  RemoteClientPlatformSchema,
  RemoteClientRegistrationSchema,
  A2ATaskEnvelopeSchema,
  A2ATaskResultSchema,
  RemoteClientStatusSchema,
} from '@/shared/types';

/**
 * @description Runtime configuration for the local remote-client daemon.
 */
export const RemoteClientConfigSchema = z.object({
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  controlPlaneUrl: z.string().url(),
  controlPlaneToken: z.string().optional(),
  platform: RemoteClientPlatformSchema.optional().default('unknown'),
  transport: A2ATransportSchema.optional().default('headscale-http'),
  tailnetHostname: z.string().optional(),
  agentId: z.string().optional(),
  mcpCommand: z.string().min(1),
  mcpArgs: z.array(z.string()).optional().default([]),
  mcpCwd: z.string().optional(),
  heartbeatIntervalMs: z.number().int().positive().optional().default(10000),
  pollIntervalMs: z.number().int().positive().optional().default(2500),
  disablePolling: z.boolean().optional().default(false),
  authHeaderName: z.string().optional().default('x-remote-client-key'),
});

/**
 * @description Runtime configuration for the local remote-client daemon.
 */
export type RemoteClientConfig = z.infer<typeof RemoteClientConfigSchema>;

/**
 * @description Local execution task kinds handled by the remote-client daemon.
 */
export const RemoteClientTaskKindSchema = z.enum([
  'mcp.initialize',
  'mcp.list-tools',
  'mcp.call-tool',
  'mcp.shutdown',
  'status.sync',
]);

/**
 * @description Local execution task handled by the remote-client daemon.
 */
export const RemoteClientTaskSchema = A2ATaskEnvelopeSchema.extend({
  intent: RemoteClientTaskKindSchema,
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * @description Local execution task.
 */
export type RemoteClientTask = z.infer<typeof RemoteClientTaskSchema>;

/**
 * @description Local completion result posted back to the control plane.
 */
export const RemoteClientTaskCompletionSchema = A2ATaskResultSchema.extend({
  toolName: z.string().optional(),
});

/**
 * @description Local completion result.
 */
export type RemoteClientTaskCompletion = z.infer<typeof RemoteClientTaskCompletionSchema>;

/**
 * @description Record stored in the in-process remote client registry.
 */
export const RemoteClientRecordSchema = RemoteClientRegistrationSchema.extend({
  status: RemoteClientStatusSchema.optional().default('online'),
  healthy: z.boolean().optional().default(true),
  lastSeenAt: z.string().datetime().nullable().optional().default(null),
  taskQueueDepth: z.number().int().nonnegative().optional().default(0),
  activeTaskId: z.string().optional(),
  registeredAt: z.string().datetime(),
  lastHeartbeatAt: z.string().datetime().nullable().optional().default(null),
  heartbeatCount: z.number().int().nonnegative().optional().default(0),
  mcpToolCount: z.number().int().nonnegative().optional().default(0),
});

/**
 * @description In-memory registry record for a remote endpoint client.
 */
export type RemoteClientRecord = z.infer<typeof RemoteClientRecordSchema>;

/**
 * @description Response shape returned by the control plane when a task is claimed.
 */
export const RemoteClientClaimResponseSchema = z.object({
  claimed: z.boolean(),
  task: RemoteClientTaskSchema.nullable(),
});

/**
 * @description Claim response for task polling.
 */
export type RemoteClientClaimResponse = z.infer<typeof RemoteClientClaimResponseSchema>;

/**
 * @description Response shape returned by the control plane after a registration write.
 */
export const RemoteClientRegistrationResponseSchema = z.object({
  client: RemoteClientRecordSchema,
  registeredAt: z.string().datetime(),
});

/**
 * @description Registration response.
 */
export type RemoteClientRegistrationResponse = z.infer<typeof RemoteClientRegistrationResponseSchema>;

/**
 * @description Response shape returned by the control plane after a heartbeat write.
 */
export const RemoteClientHeartbeatResponseSchema = z.object({
  client: RemoteClientRecordSchema,
  acceptedAt: z.string().datetime(),
});

/**
 * @description Heartbeat response.
 */
export type RemoteClientHeartbeatResponse = z.infer<typeof RemoteClientHeartbeatResponseSchema>;

/**
 * @description Mesh message envelope queued for a remote client.
 */
export const RemoteClientSwarmMessageSchema = z.object({
  messageId: z.string().min(1),
  correlationId: z.string().min(1),
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  channel: z.string().min(1),
  messageType: z.enum(['request', 'reply', 'broadcast', 'event']).optional().default('event'),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
  receivedAt: z.string().datetime(),
});

/**
 * @description Swarm message envelope queued for a remote client.
 */
export type RemoteClientSwarmMessage = z.infer<typeof RemoteClientSwarmMessageSchema>;

/**
 * @description Response shape returned when the remote client claims one queued swarm message.
 */
export const RemoteClientSwarmClaimResponseSchema = z.object({
  claimed: z.boolean(),
  message: RemoteClientSwarmMessageSchema.nullable(),
});

/**
 * @description Claim response for remote-client swarm message polling.
 */
export type RemoteClientSwarmClaimResponse = z.infer<typeof RemoteClientSwarmClaimResponseSchema>;

/**
 * @description Payload sent by a remote client when publishing a swarm message.
 */
export const RemoteClientSwarmSendRequestSchema = z.object({
  mode: z.enum(['direct', 'broadcast']).optional().default('direct'),
  toAgentId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
}).superRefine((value, ctx) => {
  if (value.mode === 'direct' && (!value.toAgentId || value.toAgentId.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['toAgentId'],
      message: 'toAgentId is required when mode=direct',
    });
  }
});

/**
 * @description Request payload for remote-client initiated swarm messages.
 */
export type RemoteClientSwarmSendRequest = z.infer<typeof RemoteClientSwarmSendRequestSchema>;

/**
 * @description Response shape after a remote client publishes a swarm message.
 */
export const RemoteClientSwarmSendResponseSchema = z.object({
  accepted: z.boolean(),
  correlationId: z.string().min(1),
});

/**
 * @description Response payload for remote-client initiated swarm messages.
 */
export type RemoteClientSwarmSendResponse = z.infer<typeof RemoteClientSwarmSendResponseSchema>;

/**
 * @description Conversational chat turn posted by a remote client. The bot named
 * by `agentId` (or the control plane's default chat agent) reasons over the turn
 * and the reply is delivered back over the swarm-message queue (poll swarm/next).
 */
export const RemoteClientChatRequestSchema = z.object({
  text: z.string().min(1),
  agentId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  userSub: z.string().min(1).optional(),
});

/**
 * @description Request payload for a remote-client conversational chat turn.
 */
export type RemoteClientChatRequest = z.infer<typeof RemoteClientChatRequestSchema>;

/**
 * @description Acknowledgement returned immediately when a chat turn is accepted.
 * The reply itself arrives asynchronously on the swarm-message queue, keyed by
 * `taskId` + `correlationId`, so the client polls GET /:clientId/swarm/next.
 */
export const RemoteClientChatAcceptResponseSchema = z.object({
  accepted: z.boolean(),
  taskId: z.string().min(1),
  correlationId: z.string().min(1),
  agentId: z.string().min(1),
});

/**
 * @description Acceptance response for a remote-client chat turn.
 */
export type RemoteClientChatAcceptResponse = z.infer<typeof RemoteClientChatAcceptResponseSchema>;
