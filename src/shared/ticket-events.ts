/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Process tracker: singleton EventEmitter for ticket status transitions. Bridges the store layer to SSE consumers without coupling them directly.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 graph ingestion: added ticket-created and agent-assigned events (emitted by TicketService) so the swarm operational graph can observe the full lifecycle without instrumenting call sites. Payloads are sanitized — ids/title/status only, never descriptions.
 */

import { EventEmitter } from 'events';

/**
 * @description Payload emitted when a ticket status changes.
 */
export interface TicketStatusChangedEvent {
  ticketId: string;
  fromStatus: string;
  toStatus: string;
  /** Agent ID, 'user', or 'system' */
  changedBy: string;
  changedByLabel: string;
  timestamp: string;
}

/**
 * @description Sanitized payload emitted when a ticket is created (TicketService.createTicket).
 * Deliberately id/title/status-scale only — the description NEVER rides the bus.
 */
export interface TicketCreatedEvent {
  ticketId: string;
  /** Title, already identifier-scale (consumers may clip further). */
  title: string;
  ticketType: string;
  status: string;
  assignedAgentId: string | null;
  parentTicketId: string | null;
  timestamp: string;
}

/**
 * @description Payload emitted when an agent is assigned to a ticket (TicketService.assignAgent).
 */
export interface TicketAgentAssignedEvent {
  ticketId: string;
  agentId: string;
  role: string;
  phase?: string;
  timestamp: string;
}

/**
 * @description Process-level singleton EventEmitter for ticket lifecycle events.
 * The ticket store fires into this; cockpit-routes.ts subscribes to pipe updates to SSE clients.
 */
class TicketEventBus extends EventEmitter {
  /**
   * @description Broadcasts a ticket status transition to all subscribers under the 'status-changed' channel.
   * @param event - The status-change payload describing the ticket transition.
   * @returns Nothing.
   */
  emitStatusChanged(event: TicketStatusChangedEvent): void {
    this.emit('status-changed', event);
  }

  /**
   * @description Registers a listener invoked whenever a ticket status transition is emitted.
   * @param listener - Callback receiving the status-change payload.
   * @returns This emitter instance, to allow chaining.
   */
  onStatusChanged(listener: (event: TicketStatusChangedEvent) => void): this {
    return this.on('status-changed', listener);
  }

  /**
   * @description Broadcasts a ticket creation to all subscribers under the 'ticket-created' channel.
   * @param event - The sanitized creation payload (ids/title/status only).
   * @returns Nothing.
   */
  emitTicketCreated(event: TicketCreatedEvent): void {
    this.emit('ticket-created', event);
  }

  /**
   * @description Registers a listener invoked whenever a ticket is created.
   * @param listener - Callback receiving the creation payload.
   * @returns This emitter instance, to allow chaining.
   */
  onTicketCreated(listener: (event: TicketCreatedEvent) => void): this {
    return this.on('ticket-created', listener);
  }

  /**
   * @description Broadcasts an agent assignment under the 'agent-assigned' channel.
   * @param event - The assignment payload (ticket id, agent id, role).
   * @returns Nothing.
   */
  emitAgentAssigned(event: TicketAgentAssignedEvent): void {
    this.emit('agent-assigned', event);
  }

  /**
   * @description Registers a listener invoked whenever an agent is assigned to a ticket.
   * @param listener - Callback receiving the assignment payload.
   * @returns This emitter instance, to allow chaining.
   */
  onAgentAssigned(listener: (event: TicketAgentAssignedEvent) => void): this {
    return this.on('agent-assigned', listener);
  }
}

/**
 * @description Shared process-wide singleton instance of the ticket event bus, used by producers (the ticket store) and consumers (SSE routes) to coordinate ticket status updates.
 */
export const ticketEvents = new TicketEventBus();
