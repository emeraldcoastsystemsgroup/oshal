/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial InternalTicket Zod schemas and types for persisted ticket records
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added 'swarm-execution' role to TicketTaskLinkRole for per-bot cost tracking (ADR-027)
 */

import { z } from 'zod';
import {
  OshalTicketStateSchema,
  OshalTicketStateGroupSchema,
  OshalTicketExecutionPhaseSchema,
  TicketTypeSchema,
} from './types';

/**
 * @description Priority levels for internal tickets.
 */
export const TicketPrioritySchema = z.enum(['urgent', 'high', 'medium', 'low', 'none']);

/**
 * @description Ticket priority key.
 */
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;

/**
 * @description Role of a task linked to a ticket.
 */
export const TicketTaskLinkRoleSchema = z.enum(['primary', 'review', 'subtask', 'swarm-execution']);

/**
 * @description Task link role key.
 */
export type TicketTaskLinkRole = z.infer<typeof TicketTaskLinkRoleSchema>;

/**
 * @description Persisted internal ticket record — the canonical ticket entity in OSHAL.
 * Tickets exist independently of any external provider (Plane, GitHub) and are the
 * single source of truth for work queue items.
 */
export const InternalTicketSchema = z.object({
  ticketId: z.string().uuid(),
  ticketType: TicketTypeSchema.optional().default('build'),
  title: z.string().min(1),
  description: z.string().default(''),
  status: OshalTicketStateSchema.default('backlog'),
  stateGroup: OshalTicketStateGroupSchema.default('backlog'),
  executionPhase: OshalTicketExecutionPhaseSchema.nullable().default(null),
  priority: TicketPrioritySchema.default('none'),
  labels: z.array(z.string()).default([]),
  workspaceId: z.string().uuid().nullable().default(null),
  assignedAgentId: z.string().nullable().default(null),
  parentTicketId: z.string().uuid().nullable().default(null),
  externalProvider: z.string().nullable().default(null),
  externalId: z.string().nullable().default(null),
  externalUrl: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  /** OIDC sub of the user who owns this ticket (for per-user "my tickets" queues). */
  ownerSub: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * @description Persisted internal ticket record type.
 */
export type InternalTicket = z.infer<typeof InternalTicketSchema>;

/**
 * @description Input schema for creating a new internal ticket.
 */
export const CreateInternalTicketSchema = z.object({
  title: z.string().min(1),
  ticketType: TicketTypeSchema.optional().default('build'),
  description: z.string().optional().default(''),
  status: OshalTicketStateSchema.optional().default('backlog'),
  priority: TicketPrioritySchema.optional().default('none'),
  labels: z.array(z.string()).optional().default([]),
  workspaceId: z.string().uuid().nullable().optional().default(null),
  assignedAgentId: z.string().nullable().optional().default(null),
  parentTicketId: z.string().uuid().nullable().optional().default(null),
  externalProvider: z.string().nullable().optional().default(null),
  externalId: z.string().nullable().optional().default(null),
  externalUrl: z.string().nullable().optional().default(null),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  /** OIDC sub of the creating user — stamped by the route so tickets are per-user owned.
   *  Truly optional (no default) so existing createTicket callers need not supply it. */
  ownerSub: z.string().nullable().optional(),
});

/**
 * @description Input type for creating a new internal ticket.
 */
export type CreateInternalTicketInput = z.infer<typeof CreateInternalTicketSchema>;

/**
 * @description Ticket-task link record.
 */
export const TicketTaskLinkSchema = z.object({
  taskId: z.string(),
  ticketId: z.string().uuid(),
  role: TicketTaskLinkRoleSchema.default('primary'),
  createdAt: z.string(),
});

/**
 * @description Ticket-task link type.
 */
export type TicketTaskLink = z.infer<typeof TicketTaskLinkSchema>;

/**
 * @description Ticket-workspace link record.
 */
export const TicketWorkspaceLinkSchema = z.object({
  ticketId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  createdAt: z.string(),
});

/**
 * @description Ticket-workspace link type.
 */
export type TicketWorkspaceLink = z.infer<typeof TicketWorkspaceLinkSchema>;