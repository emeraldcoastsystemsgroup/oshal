/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added in-memory intake cursor store for provider checkpointing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added Postgres cursor persistence so provider reconciliation survives controller restarts
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added atomic compare-and-set checkpoints so concurrent reconciliation cannot regress provider cursors
 */

import type { Pool } from 'pg';
import type { IntakeProvider } from '@/shared/types';

/**
 * @description Storage contract for provider intake cursors.
 */
export interface WorkItemCursorStore {
  getCursor(provider: IntakeProvider): Promise<string | null>;
  setCursor(provider: IntakeProvider, cursor: string): Promise<void>;
  compareAndSetCursor(
    provider: IntakeProvider,
    expectedCursor: string | null,
    cursor: string,
  ): Promise<boolean>;
}

/**
 * @description In-memory cursor store used as default intake checkpoint backend.
 */
export class InMemoryIntakeCursorStore implements WorkItemCursorStore {
  private readonly cursorByProvider = new Map<IntakeProvider, string>();

  async getCursor(provider: IntakeProvider): Promise<string | null> {
    return this.cursorByProvider.get(provider) ?? null;
  }

  async setCursor(provider: IntakeProvider, cursor: string): Promise<void> {
    this.cursorByProvider.set(provider, cursor);
  }

  async compareAndSetCursor(
    provider: IntakeProvider,
    expectedCursor: string | null,
    cursor: string,
  ): Promise<boolean> {
    if ((this.cursorByProvider.get(provider) ?? null) !== expectedCursor) {
      return false;
    }
    this.cursorByProvider.set(provider, cursor);
    return true;
  }
}

/**
 * @description Durable provider cursor store backed by the controller Postgres database.
 */
export class PostgresIntakeCursorStore implements WorkItemCursorStore {
  /**
   * @description Creates a durable cursor store over the shared controller pool.
   * @param pool - Postgres pool containing the oshal_intake_cursors table
   */
  constructor(private readonly pool: Pool) {}

  /**
   * @description Reads the latest cursor for one intake provider.
   * @param provider - Provider identifier
   * @returns Stored opaque cursor or null before the first successful sync
   */
  async getCursor(provider: IntakeProvider): Promise<string | null> {
    const result = await this.pool.query<{ cursor_value: string }>(
      'SELECT cursor_value FROM oshal_intake_cursors WHERE provider = $1',
      [provider],
    );
    return result.rows[0]?.cursor_value ?? null;
  }

  /**
   * @description Atomically stores the latest cursor for one intake provider.
   * @param provider - Provider identifier
   * @param cursor - Opaque provider cursor
   * @returns Nothing
   */
  async setCursor(provider: IntakeProvider, cursor: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO oshal_intake_cursors (provider, cursor_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (provider) DO UPDATE
       SET cursor_value = EXCLUDED.cursor_value, updated_at = NOW()`,
      [provider, cursor],
    );
  }

  /**
   * @description Advances a cursor only when its durable value still matches the caller's read.
   * @param provider - Provider identifier
   * @param expectedCursor - Cursor observed before external work was pulled
   * @param cursor - New opaque cursor after successful materialization
   * @returns True when the insert/update won the checkpoint race
   */
  async compareAndSetCursor(
    provider: IntakeProvider,
    expectedCursor: string | null,
    cursor: string,
  ): Promise<boolean> {
    const result = await this.pool.query<{ provider: string }>(
      `INSERT INTO oshal_intake_cursors (provider, cursor_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (provider) DO UPDATE
       SET cursor_value = EXCLUDED.cursor_value, updated_at = NOW()
       WHERE oshal_intake_cursors.cursor_value = $3::text
       RETURNING provider`,
      [provider, cursor, expectedCursor],
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }
}
