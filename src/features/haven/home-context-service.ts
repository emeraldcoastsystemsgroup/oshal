/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 1: Home context CRUD service for all 7 haven tables
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Isolation-audit fix: closeThread now requires the owning householdId and scopes the UPDATE by household_id (id-only WHERE let any caller close another household's thread once >1 household exists); returns whether a row matched so callers can 404 instead of silently succeeding
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'home-context-service' });

/**
 * @description Fallback household identifier used when no specific household is supplied,
 * letting single-household deployments operate without an explicit ID.
 */
export const HAVEN_DEFAULT_HOUSEHOLD_ID = '00000000-0000-0000-0000-000000000001';

/**
 * @description A person belonging to a household, used to give Haven awareness of who lives there.
 */
export interface HouseholdMember {
  id: string;
  name: string;
  role: string | null;
}

/**
 * @description A smart-home or platform device registered to the household so Haven knows
 * what hardware it can reference or act upon.
 */
export interface ConnectedDevice {
  id: string;
  name: string;
  platform: string;
  deviceType: string | null;
  location: string | null;
  status: string;
}

/**
 * @description A third-party service connected to the household, capturing which external
 * integrations Haven has access to and their authorization state.
 */
export interface LinkedIntegration {
  id: string;
  service: string;
  category: string;
  displayName: string | null;
  authStatus: string;
}

/**
 * @description A stored household preference (a categorized key/value with its origin) so Haven
 * can honor user choices and remember where each setting came from.
 */
export interface HouseholdPreference {
  category: string;
  key: string;
  value: string;
  source: string;
}

/**
 * @description An ongoing, unresolved conversation or task thread, letting Haven track
 * outstanding items across interactions.
 */
export interface OpenThread {
  id: string;
  description: string;
  createdAt: string;
  lastActive: string;
}

/**
 * @description A free-form memory observation Haven has recorded about the household,
 * giving it persistent recall across sessions.
 */
export interface HavenMemoryEntry {
  id: string;
  subject: string;
  content: string;
  tags: string[];
  createdAt: string;
}

/**
 * @description Aggregated, point-in-time view of all home context tables that Haven reads
 * before each LLM call to ground its responses in current household state.
 */
export interface HomeContextSnapshot {
  householdId: string;
  householdName: string | null;
  timezone: string;
  members: HouseholdMember[];
  devices: ConnectedDevice[];
  integrations: LinkedIntegration[];
  preferences: HouseholdPreference[];
  openThreads: OpenThread[];
  recentMemory: HavenMemoryEntry[];
}

/**
 * @description Service for reading and writing all home context tables.
 * Haven reads from this before every LLM call and writes back when state changes.
 */
export class HomeContextService {
  private readonly pool: {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  };

  /**
   * @description Creates the service bound to a database pool used for all context queries,
   * allowing the pool to be injected for production or testing.
   * @param pool Query-capable database pool used to read and write home context tables.
   */
  constructor(pool: {
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  }) {
    this.pool = pool;
  }

  /**
   * @description Ensures the household row exists. Creates it if missing.
   */
  async ensureHousehold(householdId: string = HAVEN_DEFAULT_HOUSEHOLD_ID): Promise<string> {
    try {
      await this.pool.query(
        `INSERT INTO home_context (household_id) VALUES ($1) ON CONFLICT (household_id) DO NOTHING`,
        [householdId],
      );
      return householdId;
    } catch (err) {
      logger.warn({ err, householdId }, 'ensureHousehold failed — continuing with provided ID');
      return householdId;
    }
  }

  /**
   * @description Builds a complete context snapshot for Haven to read before each LLM call.
   * Non-blocking: returns empty arrays for any table that fails.
   */
  async getContextSnapshot(householdId: string = HAVEN_DEFAULT_HOUSEHOLD_ID): Promise<HomeContextSnapshot> {
    const snapshot: HomeContextSnapshot = {
      householdId,
      householdName: null,
      timezone: 'America/Chicago',
      members: [],
      devices: [],
      integrations: [],
      preferences: [],
      openThreads: [],
      recentMemory: [],
    };

    try {
      const hc = await this.pool.query(
        `SELECT name, timezone FROM home_context WHERE household_id = $1`,
        [householdId],
      );
      if (hc.rows.length > 0) {
        snapshot.householdName = (hc.rows[0].name as string | null) ?? null;
        snapshot.timezone = (hc.rows[0].timezone as string) ?? 'America/Chicago';
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to read home_context row');
    }

    try {
      const members = await this.pool.query(
        `SELECT id, name, role FROM household_members WHERE household_id = $1 ORDER BY created_at`,
        [householdId],
      );
      snapshot.members = members.rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        role: (r.role as string | null) ?? null,
      }));
    } catch (err) {
      logger.warn({ err }, 'Failed to read household_members');
    }

    try {
      const devices = await this.pool.query(
        `SELECT id, name, platform, device_type, location, status
         FROM connected_devices WHERE household_id = $1 ORDER BY connected_at`,
        [householdId],
      );
      snapshot.devices = devices.rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        platform: r.platform as string,
        deviceType: (r.device_type as string | null) ?? null,
        location: (r.location as string | null) ?? null,
        status: (r.status as string) ?? 'unknown',
      }));
    } catch (err) {
      logger.warn({ err }, 'Failed to read connected_devices');
    }

    try {
      const integrations = await this.pool.query(
        `SELECT id, service, category, display_name, auth_status
         FROM linked_integrations WHERE household_id = $1 ORDER BY linked_at`,
        [householdId],
      );
      snapshot.integrations = integrations.rows.map((r) => ({
        id: r.id as string,
        service: r.service as string,
        category: r.category as string,
        displayName: (r.display_name as string | null) ?? null,
        authStatus: (r.auth_status as string) ?? 'unknown',
      }));
    } catch (err) {
      logger.warn({ err }, 'Failed to read linked_integrations');
    }

    try {
      const prefs = await this.pool.query(
        `SELECT category, key, value, source FROM household_preferences WHERE household_id = $1 ORDER BY set_at`,
        [householdId],
      );
      snapshot.preferences = prefs.rows.map((r) => ({
        category: r.category as string,
        key: r.key as string,
        value: r.value as string,
        source: (r.source as string) ?? 'user',
      }));
    } catch (err) {
      logger.warn({ err }, 'Failed to read household_preferences');
    }

    try {
      const threads = await this.pool.query(
        `SELECT id, description, created_at, last_active
         FROM open_threads WHERE household_id = $1 AND status = 'open'
         ORDER BY last_active DESC LIMIT 10`,
        [householdId],
      );
      snapshot.openThreads = threads.rows.map((r) => ({
        id: r.id as string,
        description: r.description as string,
        createdAt: (r.created_at as Date).toISOString(),
        lastActive: (r.last_active as Date).toISOString(),
      }));
    } catch (err) {
      logger.warn({ err }, 'Failed to read open_threads');
    }

    try {
      const memory = await this.pool.query(
        `SELECT id, subject, content, tags, created_at
         FROM haven_memory WHERE household_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [householdId],
      );
      snapshot.recentMemory = memory.rows.map((r) => ({
        id: r.id as string,
        subject: r.subject as string,
        content: r.content as string,
        tags: (r.tags as string[]) ?? [],
        createdAt: (r.created_at as Date).toISOString(),
      }));
    } catch (err) {
      logger.warn({ err }, 'Failed to read haven_memory');
    }

    return snapshot;
  }

  /**
   * @description Upserts a connected device entry.
   */
  async upsertDevice(
    householdId: string,
    device: {
      name: string;
      platform: string;
      platformId?: string;
      deviceType?: string;
      location?: string;
      status?: string;
      notes?: string;
    },
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO connected_devices (household_id, name, platform, platform_id, device_type, location, status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [
          householdId,
          device.name,
          device.platform,
          device.platformId ?? null,
          device.deviceType ?? null,
          device.location ?? null,
          device.status ?? 'online',
          device.notes ?? null,
        ],
      );
    } catch (err) {
      logger.warn({ err, device }, 'upsertDevice failed');
    }
  }

  /**
   * @description Upserts a linked integration entry.
   */
  async upsertIntegration(
    householdId: string,
    integration: {
      service: string;
      category: string;
      displayName?: string;
      authStatus?: string;
    },
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO linked_integrations (household_id, service, category, display_name, auth_status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          householdId,
          integration.service,
          integration.category,
          integration.displayName ?? null,
          integration.authStatus ?? 'active',
        ],
      );
    } catch (err) {
      logger.warn({ err, integration }, 'upsertIntegration failed');
    }
  }

  /**
   * @description Upserts a household preference.
   */
  async upsertPreference(
    householdId: string,
    preference: { category: string; key: string; value: string; source?: string },
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO household_preferences (household_id, category, key, value, source)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (household_id, category, key) DO UPDATE SET value = $4, source = $5, set_at = NOW()`,
        [householdId, preference.category, preference.key, preference.value, preference.source ?? 'user'],
      );
    } catch (err) {
      logger.warn({ err, preference }, 'upsertPreference failed');
    }
  }

  /**
   * @description Creates an open thread.
   */
  async createThread(householdId: string, description: string, context?: Record<string, unknown>): Promise<string | null> {
    try {
      const result = await this.pool.query(
        `INSERT INTO open_threads (household_id, description, context) VALUES ($1, $2, $3) RETURNING id`,
        [householdId, description, JSON.stringify(context ?? {})],
      );
      return result.rows[0]?.id as string ?? null;
    } catch (err) {
      logger.warn({ err }, 'createThread failed');
      return null;
    }
  }

  /**
   * @description Closes an open thread, scoped to the household that owns it. The UPDATE
   * is keyed on BOTH the row id and household_id so a caller resolved to one household can
   * never close another household's thread by guessing/replaying its id (isolation-audit fix).
   * @param householdId The caller's resolved household — the only household whose rows may change.
   * @param threadId The open_threads row id to close.
   * @returns True when a thread in the caller's household was closed; false when no row matched
   * (wrong household or unknown id) or the query failed.
   */
  async closeThread(householdId: string, threadId: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `UPDATE open_threads SET status = 'closed' WHERE id = $1 AND household_id = $2`,
        [threadId, householdId],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      logger.warn({ err, threadId, householdId }, 'closeThread failed');
      return false;
    }
  }

  /**
   * @description Adds a free-form memory observation.
   */
  async addMemory(
    householdId: string,
    subject: string,
    content: string,
    tags?: string[],
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO haven_memory (household_id, subject, content, tags) VALUES ($1, $2, $3, $4)`,
        [householdId, subject, content, tags ?? []],
      );
    } catch (err) {
      logger.warn({ err, subject }, 'addMemory failed');
    }
  }
}