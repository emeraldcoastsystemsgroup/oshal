/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial PostgresWorkspaceStore with full CRUD for named persistent workspaces
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added lazy schema bootstrap via ensureWorkspaceSchema on first query
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Made create-on-name-conflict read-only so a competing caller cannot rewrite an existing workspace's immutable path or mutable metadata before owner validation.
 */

import type { Pool, QueryResult } from 'pg';
import { randomUUID } from 'crypto';
import type { IWorkspaceStore, InternalWorkspace, CreateInternalWorkspaceInput } from '@/entities/workspace';
import { ensureWorkspaceSchema } from '@/shared/services/database';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'PostgresWorkspaceStore' });

/**
 * @description Postgres-backed implementation of IWorkspaceStore.
 * Persists workspaces to the `workspaces` table bootstrapped by workspace-schema.ts.
 */
export class PostgresWorkspaceStore implements IWorkspaceStore {
  private schemaReady: Promise<void>;

  constructor(private readonly pool: Pool) {
    this.schemaReady = ensureWorkspaceSchema(pool).catch((error) => {
      logger.error({ err: error }, 'Workspace schema bootstrap failed — retrying on next query');
      this.schemaReady = ensureWorkspaceSchema(pool);
      throw error;
    });
  }

  /**
   * @description Create a new workspace in Postgres.
   * @param input - Workspace creation input
   * @returns The created workspace record
   */
  async create(input: CreateInternalWorkspaceInput): Promise<InternalWorkspace> {
    await this.schemaReady;
    const workspaceId = randomUUID();
    const now = new Date().toISOString();
    logger.info({ workspaceId, name: input.name, path: input.path }, 'Creating workspace');

    // Name reuse is a lookup, never an update. The service validates the returned
    // record's exact owner/path before treating it as the caller's workspace.
    const sql = `
      INSERT INTO workspaces (workspace_id, name, path, project_name, owner_sub, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (name) DO NOTHING
      RETURNING *
    `;

    const result: QueryResult = await this.pool.query(sql, [
      workspaceId,
      input.name,
      input.path,
      input.projectName ?? null,
      input.ownerSub ?? null,
      JSON.stringify(input.metadata ?? {}),
      now,
    ]);

    const row = result.rows[0] ?? (await this.pool.query(
      'SELECT * FROM workspaces WHERE name = $1',
      [input.name],
    )).rows[0];
    if (!row) throw new Error('Workspace creation conflicted with an inaccessible record');
    const workspace = this.mapRow(row);
    logger.info({ workspaceId: workspace.workspaceId, name: workspace.name }, 'Workspace created or reused');
    return workspace;
  }

  /**
   * @description Get a workspace by ID.
   * @param workspaceId - Workspace identifier
   * @returns Workspace record or null
   */
  async get(workspaceId: string): Promise<InternalWorkspace | null> {
    await this.schemaReady;
    logger.debug({ workspaceId }, 'Getting workspace');
    const result = await this.pool.query('SELECT * FROM workspaces WHERE workspace_id = $1', [workspaceId]);
    return result.rows.length ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * @description Get a workspace by its unique name.
   * @param name - Workspace name
   * @returns Workspace record or null
   */
  async getByName(name: string): Promise<InternalWorkspace | null> {
    await this.schemaReady;
    logger.debug({ name }, 'Getting workspace by name');
    const result = await this.pool.query('SELECT * FROM workspaces WHERE name = $1', [name]);
    return result.rows.length ? this.mapRow(result.rows[0]) : null;
  }

  /**
   * @description Update a workspace's fields.
   * @param workspaceId - Workspace identifier
   * @param updates - Partial workspace fields
   */
  async update(workspaceId: string, updates: Partial<Omit<InternalWorkspace, 'workspaceId' | 'createdAt'>>): Promise<void> {
    await this.schemaReady;
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    const fieldMap: Record<string, string> = {
      name: 'name',
      path: 'path',
      projectName: 'project_name',
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      if (key in updates) {
        setClauses.push(`${column} = $${idx++}`);
        params.push((updates as Record<string, unknown>)[key]);
      }
    }

    if ('metadata' in updates) {
      setClauses.push(`metadata = $${idx++}`);
      params.push(JSON.stringify(updates.metadata ?? {}));
    }

    if (setClauses.length === 0) {
      return;
    }

    params.push(workspaceId);
    logger.info({ workspaceId, fieldCount: setClauses.length }, 'Updating workspace');
    await this.pool.query(
      `UPDATE workspaces SET ${setClauses.join(', ')} WHERE workspace_id = $${idx}`,
      params,
    );
  }

  /**
   * @description Delete a workspace.
   * @param workspaceId - Workspace identifier
   */
  async delete(workspaceId: string): Promise<void> {
    await this.schemaReady;
    logger.info({ workspaceId }, 'Deleting workspace');
    await this.pool.query('DELETE FROM workspaces WHERE workspace_id = $1', [workspaceId]);
  }

  /**
   * @description List workspaces with optional filtering.
   * @param options - Filter options
   * @returns Array of matching workspaces
   */
  async list(options?: {
    projectName?: string;
    ownerSub?: string;
    limit?: number;
    offset?: number;
  }): Promise<InternalWorkspace[]> {
    await this.schemaReady;
    logger.debug({ options }, 'Listing workspaces');
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (options?.projectName) {
      conditions.push(`project_name = $${idx++}`);
      params.push(options.projectName);
    }

    if (options?.ownerSub) {
      conditions.push(`owner_sub = $${idx++}`);
      params.push(options.ownerSub);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    let pagination = '';
    if (options?.limit) {
      pagination += ` LIMIT $${idx++}`;
      params.push(options.limit);
    }
    if (options?.offset) {
      pagination += ` OFFSET $${idx++}`;
      params.push(options.offset);
    }

    const result = await this.pool.query(
      `SELECT * FROM workspaces ${where} ORDER BY created_at DESC${pagination}`,
      params,
    );

    return result.rows.map((row: Record<string, unknown>) => this.mapRow(row));
  }

  /**
   * @description Maps a Postgres row to an InternalWorkspace object.
   * @param row - Raw database row
   * @returns Mapped InternalWorkspace
   */
  private mapRow(row: Record<string, unknown>): InternalWorkspace {
    return {
      workspaceId: row.workspace_id as string,
      name: row.name as string,
      path: row.path as string,
      projectName: (row.project_name as string) ?? null,
      ownerSub: (row.owner_sub as string) ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: row.created_at ? String(row.created_at) : new Date().toISOString(),
    };
  }
}
