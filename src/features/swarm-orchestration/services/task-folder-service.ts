/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial TaskFolderService — creates legacy-style workspace directories for tickets with bot-prefixed output files, _meta.json, and ROUTING-DECISIONS.md
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import * as fs from 'fs';
import * as path from 'path';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'TaskFolderService' });

/**
 * @description Metadata stored in _meta.json inside each task workspace folder.
 */
export interface TaskFolderMeta {
  taskId: string;
  parentId: string | null;
  childTicketIds: string[];
  agents: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * @description Result of creating a task folder on disk.
 */
export interface TaskFolderResult {
  /** Absolute path to the created task folder */
  folderPath: string;
  /** Absolute path to _meta.json */
  metaPath: string;
  /** Absolute path to ROUTING-DECISIONS.md */
  routingDecisionsPath: string;
}

/**
 * @description Creates and manages legacy-style workspace directories for tickets.
 *
 * Each ticket gets a folder under the shared workspace root:
 * ```
 * {ticketId}/
 * ├── _meta.json
 * ├── ROUTING-DECISIONS.md
 * ├── deliverables/
 * ├── developer-handovers/
 * └── notes/
 * ```
 *
 * Bot-specific output files follow the pattern:
 * - `{bot-name}-context.md` — per-agent context snapshots
 * - `deliverables/{bot-name}/README.md` — per-agent deliverable summaries
 * - `developer-handovers/{bot-name}-handover.md` — agent handover docs
 * - `notes/{bot-name}-notes.md` — agent working notes
 */
export class TaskFolderService {
  private readonly workspaceRoot: string;

  /**
   * @description Creates a TaskFolderService.
   * @param workspaceRoot - Absolute path to the shared workspace root directory
   */
  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    logger.info({ workspaceRoot }, 'TaskFolderService initialized');
  }

  /**
   * @description Creates the full workspace directory structure for a ticket.
   * Idempotent — safe to call if the folder already exists.
   *
   * @param ticketId - UUID of the ticket
   * @param meta - Optional partial metadata to seed _meta.json
   * @returns TaskFolderResult with paths to created resources
   */
  createTaskFolder(
    ticketId: string,
    meta?: Partial<TaskFolderMeta>,
  ): TaskFolderResult {
    const startedAt = Date.now();
    const folderPath = path.join(this.workspaceRoot, ticketId);

    logger.info({ ticketId, folderPath }, 'Creating task folder');

    // Create directory structure
    const subdirs = ['deliverables', 'developer-handovers', 'notes'];
    for (const sub of subdirs) {
      const dirPath = path.join(folderPath, sub);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        logger.debug({ path: dirPath }, 'Created subdirectory');
      }
    }

    // Write _meta.json
    const metaPath = path.join(folderPath, '_meta.json');
    const fullMeta: TaskFolderMeta = {
      taskId: ticketId,
      parentId: meta?.parentId ?? null,
      childTicketIds: meta?.childTicketIds ?? [],
      agents: meta?.agents ?? [],
      status: meta?.status ?? 'in_process_design',
      createdAt: meta?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metaPath, JSON.stringify(fullMeta, null, 2), 'utf-8');
    logger.debug({ metaPath }, 'Wrote _meta.json');

    // Write ROUTING-DECISIONS.md
    const routingDecisionsPath = path.join(folderPath, 'ROUTING-DECISIONS.md');
    if (!fs.existsSync(routingDecisionsPath)) {
      const routingContent = buildRoutingDecisionsStub(ticketId);
      fs.writeFileSync(routingDecisionsPath, routingContent, 'utf-8');
      logger.debug({ routingDecisionsPath }, 'Wrote ROUTING-DECISIONS.md');
    }

    logger.info(
      { ticketId, folderPath, durationMs: Date.now() - startedAt },
      'Task folder created',
    );

    return { folderPath, metaPath, routingDecisionsPath };
  }

  /**
   * @description Updates _meta.json with new metadata (e.g., child ticket IDs, agents).
   * @param ticketId - UUID of the ticket
   * @param patch - Partial metadata to merge
   */
  updateMeta(ticketId: string, patch: Partial<TaskFolderMeta>): void {
    const metaPath = path.join(this.workspaceRoot, ticketId, '_meta.json');
    if (!fs.existsSync(metaPath)) {
      logger.warn({ ticketId, metaPath }, 'Cannot update _meta.json — file not found');
      return;
    }

    const existing: TaskFolderMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const updated: TaskFolderMeta = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    // Merge arrays instead of replacing
    if (patch.childTicketIds) {
      updated.childTicketIds = [...new Set([...existing.childTicketIds, ...patch.childTicketIds])];
    }
    if (patch.agents) {
      updated.agents = [...new Set([...existing.agents, ...patch.agents])];
    }

    fs.writeFileSync(metaPath, JSON.stringify(updated, null, 2), 'utf-8');
    logger.info({ ticketId, patchKeys: Object.keys(patch) }, 'Updated _meta.json');
  }

  /**
   * @description Appends a routing decision entry to ROUTING-DECISIONS.md.
   * @param ticketId - UUID of the ticket
   * @param decision - The routing decision text
   * @param agent - Agent that made the decision
   */
  appendRoutingDecision(ticketId: string, decision: string, agent: string): void {
    const routingPath = path.join(this.workspaceRoot, ticketId, 'ROUTING-DECISIONS.md');
    if (!fs.existsSync(routingPath)) {
      logger.warn({ ticketId }, 'ROUTING-DECISIONS.md not found — creating');
      fs.writeFileSync(routingPath, buildRoutingDecisionsStub(ticketId), 'utf-8');
    }

    const entry = `\n| ${new Date().toISOString()} | ${agent} | ${decision} |`;
    fs.appendFileSync(routingPath, entry, 'utf-8');
    logger.debug({ ticketId, agent }, 'Appended routing decision');
  }

  /**
   * @description Writes a bot-prefixed context file to the task folder root.
   * @param ticketId - UUID of the ticket
   * @param botName - Bot identifier (e.g., 'code-developer')
   * @param content - Markdown content
   */
  writeBotContext(ticketId: string, botName: string, content: string): void {
    const filePath = path.join(this.workspaceRoot, ticketId, `${botName}-context.md`);
    fs.writeFileSync(filePath, content, 'utf-8');
    logger.info({ ticketId, botName, path: filePath }, 'Wrote bot context file');
  }

  /**
   * @description Writes a bot-prefixed deliverable to deliverables/{bot-name}/README.md.
   * @param ticketId - UUID of the ticket
   * @param botName - Bot identifier
   * @param content - Deliverable content
   */
  writeDeliverable(ticketId: string, botName: string, content: string): void {
    const dirPath = path.join(this.workspaceRoot, ticketId, 'deliverables', botName);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const filePath = path.join(dirPath, 'README.md');
    fs.writeFileSync(filePath, content, 'utf-8');
    logger.info({ ticketId, botName, path: filePath }, 'Wrote deliverable');
  }

  /**
   * @description Writes a bot handover document to developer-handovers/{bot-name}-handover.md.
   * @param ticketId - UUID of the ticket
   * @param botName - Bot identifier
   * @param content - Handover content
   */
  writeHandover(ticketId: string, botName: string, content: string): void {
    const filePath = path.join(
      this.workspaceRoot, ticketId, 'developer-handovers', `${botName}-handover.md`,
    );
    fs.writeFileSync(filePath, content, 'utf-8');
    logger.info({ ticketId, botName, path: filePath }, 'Wrote handover document');
  }

  /**
   * @description Writes a bot working notes file to notes/{bot-name}-notes.md.
   * @param ticketId - UUID of the ticket
   * @param botName - Bot identifier
   * @param content - Notes content
   */
  writeNote(ticketId: string, botName: string, content: string): void {
    const filePath = path.join(
      this.workspaceRoot, ticketId, 'notes', `${botName}-notes.md`,
    );
    fs.writeFileSync(filePath, content, 'utf-8');
    logger.info({ ticketId, botName, path: filePath }, 'Wrote notes file');
  }

  /**
   * @description Checks if a task folder exists for the given ticket.
   * @param ticketId - UUID of the ticket
   * @returns True if the folder exists on disk
   */
  exists(ticketId: string): boolean {
    return fs.existsSync(path.join(this.workspaceRoot, ticketId));
  }

  /**
   * @description Returns the absolute path to a ticket's task folder.
   * @param ticketId - UUID of the ticket
   * @returns Absolute folder path
   */
  getFolderPath(ticketId: string): string {
    return path.join(this.workspaceRoot, ticketId);
  }
}

/* ── Internal Helpers ──────────────────────────────────────────────── */

/**
 * @description Builds the initial ROUTING-DECISIONS.md stub with header table.
 * @param ticketId - UUID of the ticket
 * @returns Markdown content string
 */
function buildRoutingDecisionsStub(ticketId: string): string {
  return `# Routing Decisions — ${ticketId}

| Timestamp | Agent | Decision |
|-----------|-------|----------|
| ${new Date().toISOString()} | system | Task folder created |
`;
}