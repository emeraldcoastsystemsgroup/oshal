/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from queue-manager-service.ts to stay under 800-line limit. Contains workspace creation, task brief writing, deliverable extraction, and root-ticket resolution helpers.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | TASK-BRIEF instruction 8: images meant for the user must be DOWNLOADED into deliverables/assets/ and referenced by relative path from a result-linked deliverables/*.md — Jarvis's trusted gallery pipeline only receives local, workspace-confined files and (by security design) never fetches model-authored remote URLs, so hot-linked images silently produce no visual (Fort Smith vs Van Buren galleries, 2026-07-15).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import type { InternalTicket } from '@/entities/ticket';
import type { TicketService } from '@/features/ticketing';
import type { WorkspaceService } from '@/features/ticketing';
import { createChildLogger } from '@/shared/logger';
import type { TaskFolderService } from './task-folder-service';

const logger = createChildLogger({ module: 'QueueManagerWorkspaceHelpers' });

/**
 * @description Pipeline service dependencies for workspace helpers.
 */
export interface WorkspaceHelperDeps {
  taskFolderService: TaskFolderService;
  workspaceService: WorkspaceService;
  ticketService: TicketService;
}

/**
 * @description Creates or resolves the workspace directory for a ticket.
 * Root tickets get a new workspace folder. Child tickets share the ROOT ticket's
 * workspace (legacy parity: PHASE_45 fix — all descendants share one folder).
 * @param ticket - The ticket to create/resolve a workspace for
 * @param deps - Pipeline dependencies
 * @returns TaskFolderResult with folder paths
 */
export async function createTicketWorkspace(
  ticket: InternalTicket,
  deps: WorkspaceHelperDeps,
  ticketStatus?: string,
): Promise<{ folderPath: string }> {
  const { ticketId } = ticket;
  const { taskFolderService, workspaceService, ticketService } = deps;

  // PHASE_45 PARITY: Child tickets share the ROOT ticket's workspace folder.
  let workspaceFolderId = ticketId;
  if (ticket.parentTicketId) {
    workspaceFolderId = await resolveRootTicketId(ticket.parentTicketId, ticketService);
    logger.info(
      { ticketId, parentTicketId: ticket.parentTicketId, rootTicketId: workspaceFolderId },
      'Child ticket resolved to root workspace',
    );
  }

  // Create directory structure on disk (idempotent — safe if folder already exists)
  const folderResult = taskFolderService.createTaskFolder(workspaceFolderId, {
    parentId: ticket.parentTicketId ?? null,
    status: ticketStatus ?? ticket.status ?? 'in_process_design',
  });

  // Create DB workspace record + link (skip for children if parent already linked)
  if (!ticket.parentTicketId) {
    try {
      const wsRecord = await workspaceService.createWorkspace({
        name: `workspace-${ticket.title.slice(0, 50).replace(/[^a-zA-Z0-9-_]/g, '-')}`,
        path: folderResult.folderPath,
        metadata: {},
        projectName: null,
      });

      await ticketService.linkWorkspace(ticketId, wsRecord.workspaceId);
      await ticketService.updateTicket(ticketId, { workspaceId: wsRecord.workspaceId });

      logger.info(
        { ticketId, workspaceId: wsRecord.workspaceId },
        'Workspace record created and linked to ticket',
      );
    } catch (err) {
      logger.warn(
        { err, ticketId },
        'Failed to create/link DB workspace record — folder exists on disk',
      );
    }
  }

  return folderResult;
}

/**
 * @description Walk up the parent chain to find the root ticket ID.
 * All descendants share the root's workspace folder (legacy PHASE_45 parity).
 * @param parentTicketId - The immediate parent ticket ID
 * @param ticketService - Ticket service for lookups
 * @returns Root ticket ID (the one with no parent)
 */
export async function resolveRootTicketId(
  parentTicketId: string,
  ticketService: TicketService,
): Promise<string> {
  let current = parentTicketId;
  const maxDepth = 10;
  for (let i = 0; i < maxDepth; i++) {
    try {
      const all = await ticketService.listTickets({});
      const ticket = all.find((t) => t.ticketId === current);
      if (!ticket || !ticket.parentTicketId) return current;
      current = ticket.parentTicketId;
    } catch {
      return current;
    }
  }
  return current;
}

/**
 * @description Writes a task brief document to the workspace before dispatching to the swarm pipeline.
 * The task brief seeds bots with context about what needs to be done.
 * @param ticket - The ticket being dispatched
 * @param childTicketIds - IDs of decomposed child tickets
 * @param taskFolderService - Task folder service for file operations
 */
export function writeTaskBrief(
  ticket: InternalTicket,
  childTicketIds: string[],
  taskFolderService: TaskFolderService,
  workspaceFolderId?: string,
  ticketStatus?: string,
): void {
  const { ticketId, title, description } = ticket;
  const folderId = workspaceFolderId || ticketId;
  const resolvedStatus = ticketStatus || ticket.status || 'in_process_design';
  const lifecycleNotes = resolvedStatus === 'in_process_discovery'
    ? [
      '## Lifecycle',
      '- Current phase: Phase 0 - discovery and planning.',
      '- The system is still shaping the build and required artifacts before execution starts.',
      '',
    ]
    : resolvedStatus === 'approval_required'
      ? [
        '## Lifecycle',
        '- Current phase: human interaction / approval required.',
        '- Planning is complete. Review the prep packet, artifact package, and child build tickets before moving the parent ticket into build.',
        '',
      ]
      : [];

  const briefContent = [
    `# Task Brief — ${title}`,
    '',
    `**Ticket ID:** ${ticketId}`,
    `**Status:** ${resolvedStatus}`,
    `**Created:** ${new Date().toISOString()}`,
    '',
    '## Description',
    description ?? '(no description)',
    '',
    ...lifecycleNotes,
    '## Decomposition',
    childTicketIds.length > 0
      ? `Decomposed into ${childTicketIds.length} subtasks:\n${childTicketIds.map((id, i) => `${i + 1}. ${id}`).join('\n')}`
      : 'Single work unit — no subtask decomposition.',
    '',
    '## Instructions',
    '1. Read this task brief and the ticket description carefully',
    '2. If PM-PREP-PACKET.md exists, read it before planning or setup work',
    '3. Review the ROUTING-DECISIONS.md for context on agent selection',
    '4. If previous handovers exist in developer-handovers/, read them before starting',
    '5. Complete your assigned work unit(s)',
    '6. Write a developer handover document summarizing what you did',
    '7. Place deliverables in the deliverables/ directory',
    '8. Images meant to be SHOWN to the user (galleries, screenshots, photos): download the image',
    '   files into deliverables/assets/ and reference them by RELATIVE path (e.g.',
    '   `![caption](assets/photo.jpg)`) from a Markdown file in deliverables/ that your completion',
    '   summary links to. Never hot-link remote image URLs in that Markdown — the platform only',
    '   displays local workspace files and silently skips remote references.',
    '',
    '## Acceptance Criteria',
    ...(ticket.metadata?.acceptanceCriteria
      ? (ticket.metadata.acceptanceCriteria as string[]).map((ac) => `- ${ac}`)
      : ['(see ticket description for acceptance criteria)']),
  ].join('\n');

  try {
    const fs = require('fs');
    const path = require('path');
    const folderPath = taskFolderService.getFolderPath(folderId);
    const briefPath = path.join(folderPath, 'TASK-BRIEF.md');
    fs.writeFileSync(briefPath, briefContent, 'utf-8');
    writePreparationArtifacts(folderPath, ticket.metadata);
    logger.info({ ticketId, briefPath }, 'Task brief written');
  } catch (err) {
    logger.warn({ err, ticketId }, 'Failed to write task brief — non-fatal');
  }
}

/**
 * @description Enriches the workspace folder after pipeline completion.
 * Extracts agent output from work items and writes deliverables, handovers, and context files.
 * @param ticket - The completed ticket
 * @param processed - Processing result from the swarm pipeline
 * @param taskFolderService - Task folder service for file operations
 */
export async function enrichWorkspaceAfterPipeline(
  ticket: InternalTicket,
  processed: { selectedAgentId: string; selectedStrategy: string; workUnitCount: number },
  taskFolderService: TaskFolderService,
  workspaceFolderId?: string,
): Promise<void> {
  const folderId = workspaceFolderId || ticket.ticketId;

  // Update _meta.json with participating agents
  taskFolderService.updateMeta(folderId, {
    agents: [processed.selectedAgentId],
    status: 'complete',
  });

  // Append routing decision with agent selection details
  taskFolderService.appendRoutingDecision(
    folderId,
    `Agent ${processed.selectedAgentId} selected (strategy: ${processed.selectedStrategy}, ${processed.workUnitCount} work units)`,
    'swarm-pipeline',
  );

  // Write bot context file for the selected agent
  taskFolderService.writeBotContext(folderId, processed.selectedAgentId, [
    `# Agent Context — ${processed.selectedAgentId}`,
    '',
    `**Ticket:** ${ticket.title}`,
    `**Selection Strategy:** ${processed.selectedStrategy}`,
    `**Work Units:** ${processed.workUnitCount}`,
    `**Timestamp:** ${new Date().toISOString()}`,
  ].join('\n'));

  // Extract execution output from work_items DB and write deliverables
  await extractAndWriteDeliverables(ticket, processed.selectedAgentId, taskFolderService, folderId);

  logger.info({ ticketId: ticket.ticketId, folderId, agentId: processed.selectedAgentId }, 'Workspace enriched after pipeline completion');
}

/**
 * @description Queries work_items for execution output and writes it to the deliverables folder.
 * @param ticket - The completed ticket
 * @param agentId - The agent that produced the output
 * @param taskFolderService - Task folder service for file operations
 */
async function extractAndWriteDeliverables(
  ticket: InternalTicket,
  agentId: string,
  taskFolderService: TaskFolderService,
  workspaceFolderId?: string,
): Promise<void> {
  const folderId = workspaceFolderId || ticket.ticketId;
  const { title } = ticket;

  taskFolderService.writeDeliverable(folderId, agentId, [
    `# Deliverable — ${title}`,
    '',
    `**Agent:** ${agentId}`,
    `**Completed:** ${new Date().toISOString()}`,
    '',
    '## Summary',
    'Execution output stored in work_items database table.',
    'Query with: `SELECT execution_output FROM work_items WHERE external_id = \'${ticketId}\'`',
    '',
    '## Next Steps',
    '- Review the execution output in the cockpit UI',
    '- Check developer-handovers/ for handover documents',
  ].join('\n').replace('${ticketId}', ticket.ticketId));

  // Write handover stub
  taskFolderService.writeHandover(folderId, agentId, [
    `# Developer Handover — ${agentId}`,
    '',
    `**Ticket:** ${title}`,
    `**Phase:** Execution`,
    `**Timestamp:** ${new Date().toISOString()}`,
    '',
    '## What I Did',
    `- Processed ticket "${title}" through the swarm lifecycle`,
    `- ${ticket.description?.slice(0, 200) ?? 'No description available'}`,
    '',
    '## Key Context for Next Agent',
    '- Check work_items table for full execution output',
    '- Review ROUTING-DECISIONS.md for routing history',
  ].join('\n'));
}

function writePreparationArtifacts(workspaceFolderPath: string, metadata: Record<string, unknown> | null | undefined): void {
  if (!metadata) {
    return;
  }

  const fs = require('fs');
  const path = require('path');
  const prepPacket = typeof metadata.pmPrepPacket === 'string' ? metadata.pmPrepPacket.trim() : '';
  if (!prepPacket) {
    return;
  }

  fs.writeFileSync(path.join(workspaceFolderPath, 'PM-PREP-PACKET.md'), prepPacket, 'utf-8');
}
