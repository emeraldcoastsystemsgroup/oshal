/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added resilient workspace store wrapper that falls back to in-memory persistence during MOCK_OIDC localhost runs when Postgres is unavailable
 */

import type { Pool } from 'pg';
import type { IWorkspaceStore, CreateInternalWorkspaceInput, InternalWorkspace } from '@/entities/workspace';
import { createChildLogger } from '@/shared/logger';
import { InMemoryWorkspaceStore } from './in-memory-workspace-store';
import { PostgresWorkspaceStore } from './workspace-store-postgres';

const logger = createChildLogger({ module: 'ResilientWorkspaceStore' });

/**
 * @description Workspace persistence wrapper that preserves localhost workbench behavior without Postgres.
 */
export class ResilientWorkspaceStore implements IWorkspaceStore {
  private readonly pool: Pool;

  private primary: PostgresWorkspaceStore | null = null;

  private readonly fallback = new InMemoryWorkspaceStore();

  private persistentMode = true;

  private readonly allowMemoryFallback: boolean;

  constructor(pool: Pool, allowMemoryFallback = isMockOidcEnabled()) {
    this.pool = pool;
    this.allowMemoryFallback = allowMemoryFallback;
  }

  /**
   * @description Creates or reuses a workspace.
   * @param input - Workspace creation input.
   * @returns Persisted workspace.
   */
  async create(input: CreateInternalWorkspaceInput): Promise<InternalWorkspace> {
    return this.execute('create', (store) => store.create(input), () => this.fallback.create(input));
  }

  /**
   * @description Gets one workspace by id.
   * @param workspaceId - Workspace identifier.
   * @returns Workspace or null.
   */
  async get(workspaceId: string): Promise<InternalWorkspace | null> {
    return this.execute('get', (store) => store.get(workspaceId), () => this.fallback.get(workspaceId));
  }

  /**
   * @description Gets one workspace by name.
   * @param name - Workspace name.
   * @returns Workspace or null.
   */
  async getByName(name: string): Promise<InternalWorkspace | null> {
    return this.execute('getByName', (store) => store.getByName(name), () => this.fallback.getByName(name));
  }

  /**
   * @description Updates one workspace.
   * @param workspaceId - Workspace identifier.
   * @param updates - Partial field updates.
   */
  async update(workspaceId: string, updates: Partial<Omit<InternalWorkspace, 'workspaceId' | 'createdAt'>>): Promise<void> {
    await this.execute('update', (store) => store.update(workspaceId, updates), () => this.fallback.update(workspaceId, updates));
  }

  /**
   * @description Deletes one workspace.
   * @param workspaceId - Workspace identifier.
   */
  async delete(workspaceId: string): Promise<void> {
    await this.execute('delete', (store) => store.delete(workspaceId), () => this.fallback.delete(workspaceId));
  }

  /**
   * @description Lists workspaces.
   * @param options - List filters.
   * @returns Matching workspaces.
   */
  async list(options?: {
    projectName?: string;
    limit?: number;
    offset?: number;
  }): Promise<InternalWorkspace[]> {
    return this.execute('list', (store) => store.list(options), () => this.fallback.list(options));
  }

  private async execute<T>(
    operation: string,
    primaryAction: (store: PostgresWorkspaceStore) => Promise<T>,
    fallbackAction: () => Promise<T>,
  ): Promise<T> {
    if (!this.persistentMode) {
      return fallbackAction();
    }

    try {
      return await primaryAction(this.getPrimaryStore());
    } catch (error) {
      if (!this.allowMemoryFallback || !isDatabaseConnectionFailure(error)) {
        throw error;
      }

      this.persistentMode = false;
      logger.warn({ err: error, operation }, 'Workspace persistence fell back to in-memory mode');
      return fallbackAction();
    }
  }

  private getPrimaryStore(): PostgresWorkspaceStore {
    if (!this.primary) {
      this.primary = new PostgresWorkspaceStore(this.pool);
    }
    return this.primary;
  }
}

function isMockOidcEnabled(): boolean {
  const value = (process.env.MOCK_OIDC ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function isDatabaseConnectionFailure(error: unknown): boolean {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : '';
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();

  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(code)) {
    return true;
  }

  if (
    message.includes('connect econnrefused')
    || message.includes('connection terminated unexpectedly')
    || message.includes('failed to connect')
  ) {
    return true;
  }

  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    return error.errors.some((nestedError) => isDatabaseConnectionFailure(nestedError));
  }

  const nestedErrors = (error as { aggregateErrors?: unknown[] })?.aggregateErrors;
  return Array.isArray(nestedErrors)
    ? nestedErrors.some((nestedError) => isDatabaseConnectionFailure(nestedError))
    : false;
}