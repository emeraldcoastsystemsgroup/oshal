/**
 * Concierge store — the shared per-app conversation/message/feedback persistence the concierge
 * surfaces (eats, rides, spotify, movies) all need. Every app had its own copy of the same CRUD;
 * this centralizes it so the **durable-session** behaviour (resume a thread by id, not "latest
 * guess") and the message/feedback handling live in ONE place.
 *
 * Tables follow the convention `<prefix>_conversations`, `<prefix>_messages`, and (optionally)
 * `<prefix>_feedback` — identical columns across apps (verified). `prefix` is an internal allow-
 * listed literal, NEVER user input, so interpolating it into the table name is safe (and guarded).
 *
 * CHANGE LOG
 * ---------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from the 4 concierge routes
 *            | (eats/rides/spotify/movies) into one store. Brings durable resume-by-id to all four;
 *            | feedback methods are optional (rides has no feedback table).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Allow the 'drone' prefix — the Drone Ops
 *            | concierge (ADR-098) persists its mission-drafting threads through the same store.
 * ---------------------------------------------------------------------------
 * @module concierge-store
 */

import type { Pool } from 'pg';

export interface ConvTurn { role: string; content: string }

const ALLOWED_PREFIXES = new Set(['eats', 'rides', 'spotify', 'movies', 'drone']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this a syntactically valid UUID? (Guards resume-by-id so a bad client value can't 22P02.) */
export function isUuid(s: unknown): boolean {
  return typeof s === 'string' && UUID_RE.test(s.trim());
}

/**
 * Per-app concierge persistence. `prefix` selects the table family; `hasFeedback` is false for
 * apps without a `<prefix>_feedback` table (rides). All methods are user-scoped by `sub`.
 */
export class ConciergeStore {
  private readonly conv: string;
  private readonly msg: string;
  private readonly fb: string;

  constructor(private readonly pool: Pool, private readonly prefix: string, private readonly hasFeedback = true) {
    if (!ALLOWED_PREFIXES.has(prefix)) throw new Error(`ConciergeStore: unknown prefix "${prefix}"`);
    this.conv = `${prefix}_conversations`;
    this.msg = `${prefix}_messages`;
    this.fb = `${prefix}_feedback`;
  }

  /**
   * Return the conversationId for this turn — the given one (only if it's a valid uuid the caller
   * OWNS; IDOR guard), else a freshly-created conversation. A non-owned/invalid id is ignored, never
   * read or written, so one user can't target another's thread.
   */
  async ensureConversation(sub: string, conversationId: string | undefined, title: string): Promise<string> {
    if (isUuid(conversationId)) {
      const owned = await this.pool.query(
        `SELECT 1 FROM ${this.conv} WHERE conversation_id = $1 AND user_sub = $2`,
        [String(conversationId).trim(), sub],
      );
      if (owned.rows.length) return String(conversationId).trim();
    }
    const r = await this.pool.query(
      `INSERT INTO ${this.conv} (user_sub, title) VALUES ($1, $2) RETURNING conversation_id`,
      [sub, title.slice(0, 80)],
    );
    return r.rows[0].conversation_id;
  }

  /** Append one turn to the thread. */
  async addMessage(conversationId: string, sub: string, role: 'user' | 'assistant', content: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.msg} (conversation_id, user_sub, role, content) VALUES ($1,$2,$3,$4)`,
      [conversationId, sub, role, content],
    );
  }

  /** The last `limit` turns, oldest-first (for the prompt's CONVERSATION SO FAR). */
  async loadHistory(conversationId: string, limit = 12): Promise<ConvTurn[]> {
    const r = await this.pool.query(
      `SELECT role, content FROM ${this.msg} WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [conversationId, limit],
    );
    return r.rows.reverse();
  }

  /** Bump the conversation's updated_at so "resume latest" picks the active thread. */
  async touch(conversationId: string): Promise<void> {
    await this.pool.query(`UPDATE ${this.conv} SET updated_at = NOW() WHERE conversation_id = $1`, [conversationId]);
  }

  /**
   * Durable resume: the client's stored thread by id (uuid-guarded, user-scoped), falling back to
   * the user's most-recent thread only when no valid id is supplied. Returns the resolved id + turns.
   */
  async resume(sub: string, wantId?: string): Promise<{ conversationId: string | null; messages: ConvTurn[] }> {
    let conversationId: string | null = null;
    if (isUuid(wantId)) {
      const r = await this.pool.query(
        `SELECT conversation_id FROM ${this.conv} WHERE conversation_id = $1 AND user_sub = $2`,
        [String(wantId).trim(), sub],
      );
      conversationId = r.rows[0]?.conversation_id || null;
    }
    if (!conversationId) {
      const r = await this.pool.query(
        `SELECT conversation_id FROM ${this.conv} WHERE user_sub = $1 ORDER BY updated_at DESC LIMIT 1`,
        [sub],
      );
      conversationId = r.rows[0]?.conversation_id || null;
    }
    if (!conversationId) return { conversationId: null, messages: [] };
    const m = await this.pool.query(
      `SELECT role, content FROM ${this.msg} WHERE conversation_id = $1 ORDER BY created_at`,
      [conversationId],
    );
    return { conversationId, messages: m.rows };
  }

  /** Learned preferences for the prompt (no-op [] when the app has no feedback table). */
  async loadNotes(sub: string, limit = 25): Promise<string[]> {
    if (!this.hasFeedback) return [];
    const r = await this.pool.query(
      `SELECT note FROM ${this.fb} WHERE user_sub = $1 ORDER BY created_at DESC LIMIT $2`,
      [sub, limit],
    );
    return r.rows.map((row) => row.note);
  }

  /** Persist a learned preference, de-duplicated case-insensitively (no-op when no feedback table). */
  async saveNote(sub: string, note: string): Promise<void> {
    if (!this.hasFeedback) return;
    await this.pool.query(
      `INSERT INTO ${this.fb} (user_sub, note) VALUES ($1,$2) ON CONFLICT (user_sub, lower(note)) DO NOTHING`,
      [sub, note.slice(0, 300)],
    );
  }
}
