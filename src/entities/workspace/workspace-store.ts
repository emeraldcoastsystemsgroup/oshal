/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

import type { InternalWorkspace, CreateInternalWorkspaceInput } from './types';

/**
 * @description Persistence contract for internal workspaces, decoupling workspace
 * lifecycle operations from any concrete storage backend so the rest of the system
 * can depend on the abstraction rather than a specific database or in-memory store.
 */
export interface IWorkspaceStore {
  create(input: CreateInternalWorkspaceInput): Promise<InternalWorkspace>;
  get(workspaceId: string): Promise<InternalWorkspace | null>;
  getByName(name: string): Promise<InternalWorkspace | null>;
  update(workspaceId: string, updates: Partial<Omit<InternalWorkspace, 'workspaceId' | 'createdAt'>>): Promise<void>;
  delete(workspaceId: string): Promise<void>;
  list(options?: { projectName?: string; ownerSub?: string; limit?: number; offset?: number }): Promise<InternalWorkspace[]>;
}
