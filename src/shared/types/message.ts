/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — ported from any-bot messageTypes.js
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Zod v4 compatibility: refactored all .default() to .optional().default(); fixed Change Log author/timestamp
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log header to governance-compliant timestamp and author format
 */

import { z } from 'zod';

/**
 * @description Message role in a conversation (user or assistant).
 */
export const MessageRoleSchema = z.enum(['user', 'assistant']);

/**
 * @description Message role type.
 */
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/**
 * @description Message type classification for internal routing.
 * Ported from any-bot's MESSAGE_TYPES constants.
 */
export const MessageTypeSchema = z.enum([
  'task',
  'say',
  'ask',
  'tool_use',
  'tool_result',
  'command',
  'completion',
  'error',
  'system',
  'checkpoint',
]);

/**
 * @description Internal message type for routing.
 */
export type MessageType = z.infer<typeof MessageTypeSchema>;

/**
 * @description Content block types within an LLM response.
 * Covers text, tool use requests, tool results, and extended thinking.
 */
export const ContentBlockTypeSchema = z.enum([
  'text',
  'tool_use',
  'tool_result',
  'thinking',
]);

/**
 * @description Content block type.
 */
export type ContentBlockType = z.infer<typeof ContentBlockTypeSchema>;

/**
 * @description A single content block within an LLM message.
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean().optional().default(false),
  }),
  z.object({
    type: z.literal('thinking'),
    thinking: z.string(),
  }),
]);

/**
 * @description A single content block in a message.
 */
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * @description Schema for a stored message record.
 */
export const StoredMessageSchema = z.object({
  messageId: z.string().uuid(),
  taskId: z.string(),
  role: MessageRoleSchema,
  type: MessageTypeSchema,
  text: z.string(),
  contentBlocks: z.array(ContentBlockSchema).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  createdAt: z.string().datetime(),
});

/**
 * @description A persisted message record.
 */
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

/**
 * @description Schema for a new message input (before persistence).
 */
export const CreateMessageSchema = z.object({
  taskId: z.string(),
  role: MessageRoleSchema,
  type: MessageTypeSchema,
  text: z.string(),
  contentBlocks: z.array(ContentBlockSchema).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

/**
 * @description Input for creating a new message.
 */
export type CreateMessageInput = z.infer<typeof CreateMessageSchema>;

/**
 * @description LLM-formatted message for provider API calls.
 * This is what gets sent to the LLM, not what gets stored.
 */
export const LLMMessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
});

/**
 * @description A message formatted for LLM API calls.
 */
export type LLMMessage = z.infer<typeof LLMMessageSchema>;
