/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — streaming event types from any-bot StreamController
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Zod v4 compatibility: refactored all .default() to .optional().default(); fixed Change Log author/timestamp
 */

import { z } from 'zod';

/**
 * @description SSE event type names used in the streaming protocol.
 * Ported from any-bot's StreamController broadcast methods.
 */
export const StreamEventTypeSchema = z.enum([
  'connection',
  'heartbeat',
  'message',
  'stream_chunk',
  'task_update',
  'tool_execution',
  'tool:approval:request',
  'tool:approval:response',
  'tool:approval:timeout',
  'completion',
  'error',
]);

/**
 * @description Stream event type identifier.
 */
export type StreamEventType = z.infer<typeof StreamEventTypeSchema>;

/**
 * @description Base schema for all streaming events.
 */
export const BaseStreamEventSchema = z.object({
  type: StreamEventTypeSchema,
  taskId: z.string().optional(),
  timestamp: z.number(),
});

/**
 * @description Connection established event payload.
 */
export const ConnectionEventSchema = BaseStreamEventSchema.extend({
  type: z.literal('connection'),
  clientId: z.string(),
  message: z.string(),
});

/**
 * @description Connection established event.
 */
export type ConnectionEvent = z.infer<typeof ConnectionEventSchema>;

/**
 * @description Heartbeat event payload.
 */
export const HeartbeatEventSchema = BaseStreamEventSchema.extend({
  type: z.literal('heartbeat'),
});

/**
 * @description Heartbeat keep-alive event.
 */
export type HeartbeatEvent = z.infer<typeof HeartbeatEventSchema>;

/**
 * @description New message event payload.
 */
export const MessageEventSchema = BaseStreamEventSchema.extend({
  type: z.literal('message'),
  taskId: z.string(),
  message: z.record(z.string(), z.unknown()),
});

/**
 * @description New message event.
 */
export type MessageEvent = z.infer<typeof MessageEventSchema>;

/**
 * @description Streaming chunk event for real-time LLM response tokens.
 */
export const StreamChunkEventSchema = BaseStreamEventSchema.extend({
  type: z.literal('stream_chunk'),
  taskId: z.string(),
  chunk: z.string(),
  messageId: z.string().nullable().optional().default(null),
});

/**
 * @description Stream chunk event.
 */
export type StreamChunkEvent = z.infer<typeof StreamChunkEventSchema>;

/**
 * @description Task status update event.
 */
export const TaskUpdateEventSchema = BaseStreamEventSchema.extend({
  type: z.literal('task_update'),
  taskId: z.string(),
  task: z.record(z.string(), z.unknown()),
});

/**
 * @description Task update event.
 */
export type TaskUpdateEvent = z.infer<typeof TaskUpdateEventSchema>;

/**
 * @description Tool execution status event.
 */
export const ToolExecutionEventSchema = BaseStreamEventSchema.extend({
  type: z.literal('tool_execution'),
  taskId: z.string(),
  tool: z.record(z.string(), z.unknown()),
  status: z.string(),
});

/**
 * @description Tool execution event.
 */
export type ToolExecutionEvent = z.infer<typeof ToolExecutionEventSchema>;

/**
 * @description Task completion event.
 */
export const CompletionEventSchema = BaseStreamEventSchema.extend({
  type: z.literal('completion'),
  taskId: z.string(),
  result: z.record(z.string(), z.unknown()),
});

/**
 * @description Completion event.
 */
export type CompletionEvent = z.infer<typeof CompletionEventSchema>;

/**
 * @description Error event.
 */
export const ErrorEventSchema = BaseStreamEventSchema.extend({
  type: z.literal('error'),
  taskId: z.string(),
  error: z.string(),
});

/**
 * @description Error event.
 */
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

/**
 * @description Union of all streaming event types.
 */
export type StreamEvent =
  | ConnectionEvent
  | HeartbeatEvent
  | MessageEvent
  | StreamChunkEvent
  | TaskUpdateEvent
  | ToolExecutionEvent
  | CompletionEvent
  | ErrorEvent;

/**
 * @description SSE client registration info tracked by the stream manager.
 */
export const SSEClientSchema = z.object({
  clientId: z.string(),
  taskId: z.string(),
  connectedAt: z.number(),
  knownTaskIds: z.set(z.string()).optional().default(new Set()),
});

/**
 * @description Registered SSE client state.
 */
export type SSEClient = z.infer<typeof SSEClientSchema>;