/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added in-memory workspace store fallback so MOCK_OIDC localhost ticket flows can keep workspace links functional without Postgres
 */

import { randomUUID } from 'crypto';
import type { IWorkspaceStore, CreateInternalWorkspaceInput, InternalWorkspace } from '@/entities/workspace';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'InMemoryWorkspaceStore' });

/**
 * @description In-memory workspace persistence used when Postgres is unavailable during localhost development.
 */
export class InMemoryWorkspaceStore implements IWorkspaceStore {
  private readonly workspaces = new Map<string, InternalWorkspace>();

  /**
   * @description Creates or reuses a workspace by name.
   * @param input - Workspace creation input.
   * @returns Created or updated workspace.
   */
  async create(input: CreateInternalWorkspaceInput): Promise<InternalWorkspace> {
    const existing = await this.getByName(input.name);
    if (existing) {
      const updated: InternalWorkspace = {
        ...existing,
        path: input.path ?? '',
        projectName: input.projectName ?? existing.projectName,
        metadata: Object.keys(input.metadata ?? {}).length > 0 ? { ...(input.metadata ?? {}) } : { ...existing.metadata },
      };
      this.workspaces.set(updated.workspaceId, updated);
      logger.info({ workspaceId: updated.workspaceId, name: updated.name }, 'Reused workspace in memory');
      return cloneWorkspace(updated);
    }

    const workspace: InternalWorkspace = {
      workspaceId: randomUUID(),
      name: input.name,
      path: input.path ?? '',
      projectName: input.projectName ?? null,
      ownerSub: input.ownerSub ?? null,
      metadata: { ...(input.metadata ?? {}) },
      createdAt: new Date().toISOString(),
    };
    this.workspaces.set(workspace.workspaceId, workspace);
    logger.info({ workspaceId: workspace.workspaceId, name: workspace.name }, 'Created workspace in memory');
    return cloneWorkspace(workspace);
  }

  /**
   * @description Gets one workspace by id.
   * @param workspaceId - Workspace identifier.
   * @returns Workspace or null.
   */
  async get(workspaceId: string): Promise<InternalWorkspace | null> {
    const workspace = this.workspaces.get(workspaceId) ?? null;
    return workspace ? cloneWorkspace(workspace) : null;
  }

  /**
   * @description Gets one workspace by name.
   * @param name - Workspace name.
   * @returns Workspace or null.
   */
  async getByName(name: string): Promise<InternalWorkspace | null> {
    const match = Array.from(this.workspaces.values()).find((workspace) => workspace.name === name) ?? null;
    return match ? cloneWorkspace(match) : null;
  }

  /**
   * @description Updates a workspace record.
   * @param workspaceId - Workspace identifier.
   * @param updates - Partial workspace fields.
   */
  async update(workspaceId: string, updates: Partial<Omit<InternalWorkspace, 'workspaceId' | 'createdAt'>>): Promise<void> {
    const existing = this.workspaces.get(workspaceId);
    if (!existing) {
      return;
    }

    const updated: InternalWorkspace = {
      ...existing,
      ...updates,
      metadata: 'metadata' in updates ? { ...(updates.metadata ?? {}) } : { ...existing.metadata },
    };
    this.workspaces.set(workspaceId, updated);
    logger.info({ workspaceId }, 'Updated workspace in memory');
  }

  /**
   * @description Deletes one workspace.
   * @param workspaceId - Workspace identifier.
   */
  async delete(workspaceId: string): Promise<void> {
    const deleted = this.workspaces.delete(workspaceId);
    logger.info({ workspaceId, deleted }, 'Deleted workspace from memory');
  }

  /**
   * @description Lists workspaces with optional filtering.
   * @param options - List filters.
   * @returns Matching workspaces.
   */
  async list(options?: {
    projectName?: string;
    limit?: number;
    offset?: number;
  }): Promise<InternalWorkspace[]> {
    let results = Array.from(this.workspaces.values());
    if (options?.projectName) {
      results = results.filter((workspace) => workspace.projectName === options.projectName);
    }

    results.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const offset = options?.offset && options.offset > 0 ? options.offset : 0;
    const limited = options?.limit && options.limit > 0
      ? results.slice(offset, offset + options.limit)
      : results.slice(offset);
    return limited.map(cloneWorkspace);
  }
}

function cloneWorkspace(workspace: InternalWorkspace): InternalWorkspace {
  return {
    ...workspace,
    metadata: { ...workspace.metadata },
  };
}