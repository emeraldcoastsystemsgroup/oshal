/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Haven user model (ADR-079) persistence: user_model_facts / user_model_suggestions / user_model_state tables (owner-scoped RLS at the lazy-DDL chokepoint, A1.2 pattern), fact upsert via the pure merge logic, teach/forget, decay sweep, and suggestion persistence with dedupe. Thin SQL over user-model-logic.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added a public deduplicated proposal method used by ambient daily reviews to surface confirmation questions through the existing user-model suggestion inbox.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import {
  computeSuggestions, decayFact, isStorableFact, mergeFactUpdate, parseTeach,
  type FactCandidate, type SuggestionCandidate, type UserModelFacet, type UserModelFact,
} from './user-model-logic';

const logger = createChildLogger({ module: 'user-model-service' });

/** Minimum minutes between decay/suggestion sweeps per user (lazy, pull-based). */
const SWEEP_MIN_MINUTES = 60;
/** Minimum seconds between passive-learning extractions per user. */
const LEARN_MIN_SECONDS = 60;

/**
 * @description Persistence for the Haven user model: durable per-user facts, proactive
 * suggestions, and per-user learning/sweep throttle state. All tables are user_sub-scoped with
 * owner RLS applied at creation (A1.2 chokepoint pattern). Merge/decay/suggestion semantics live
 * in user-model-logic.ts; this class is the thin SQL layer.
 */
export class UserModelService {
  private ensured = false;

  constructor(private readonly pool: Pool) {}

  /** @description Idempotently create the user-model tables + owner RLS (validate-only aware). */
  async ensureSchema(): Promise<void> {
    if (this.ensured) return;
    await runRuntimeSchemaBootstrap({
      pool: this.pool,
      moduleName: 'user-model',
      statements: [
        `CREATE TABLE IF NOT EXISTS user_model_facts (
          fact_id TEXT PRIMARY KEY,
          user_sub TEXT NOT NULL,
          facet TEXT NOT NULL,
          fact_key TEXT NOT NULL,
          fact_value TEXT NOT NULL,
          confidence DOUBLE PRECISION NOT NULL,
          source TEXT NOT NULL,
          evidence TEXT,
          times_seen INTEGER NOT NULL DEFAULT 1,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_sub, facet, fact_key)
        )`,
        'CREATE INDEX IF NOT EXISTS user_model_facts_user ON user_model_facts (user_sub, active)',
        `CREATE TABLE IF NOT EXISTS user_model_suggestions (
          suggestion_id TEXT PRIMARY KEY,
          user_sub TEXT NOT NULL,
          kind TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'new',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_sub, kind, message)
        )`,
        `CREATE TABLE IF NOT EXISTS user_model_state (
          user_sub TEXT PRIMARY KEY,
          last_learned_at TIMESTAMPTZ,
          last_sweep_at TIMESTAMPTZ
        )`,
        ...buildOwnerRlsPolicyStatements('user_model_facts', 'user_sub'),
        ...buildOwnerRlsPolicyStatements('user_model_suggestions', 'user_sub'),
        ...buildOwnerRlsPolicyStatements('user_model_state', 'user_sub'),
      ],
      requirements: [
        { table: 'user_model_facts', columns: ['fact_id', 'user_sub', 'facet', 'fact_key', 'fact_value', 'confidence', 'active'] },
        { table: 'user_model_suggestions', columns: ['suggestion_id', 'user_sub', 'kind', 'message', 'status'] },
        { table: 'user_model_state', columns: ['user_sub', 'last_learned_at', 'last_sweep_at'] },
      ],
    });
    this.ensured = true;
  }

  /** @description All facts for a user (active first, highest confidence first). */
  async getFacts(userSub: string, activeOnly = true): Promise<UserModelFact[]> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT * FROM user_model_facts WHERE user_sub = $1 ${activeOnly ? 'AND active = TRUE' : ''}
       ORDER BY active DESC, confidence DESC, last_seen DESC`,
      [userSub],
    );
    return result.rows.map(rowToFact);
  }

  /**
   * @description Upsert a fact candidate via the pure merge semantics (reinforce same value,
   * supersede on contradiction). Silently drops unstorable/secret-shaped candidates.
   * @returns true when the fact was stored.
   */
  async mergeFact(userSub: string, candidate: FactCandidate): Promise<boolean> {
    if (!isStorableFact(candidate)) return false;
    await this.ensureSchema();
    const now = new Date();
    const existing = await this.pool.query(
      'SELECT fact_value, confidence, times_seen FROM user_model_facts WHERE user_sub=$1 AND facet=$2 AND fact_key=$3',
      [userSub, candidate.facet, candidate.factKey],
    );
    const merged = mergeFactUpdate(
      existing.rows[0]
        ? { factValue: existing.rows[0].fact_value, confidence: Number(existing.rows[0].confidence), timesSeen: Number(existing.rows[0].times_seen) }
        : null,
      candidate, now,
    );
    await this.pool.query(
      `INSERT INTO user_model_facts (fact_id, user_sub, facet, fact_key, fact_value, confidence, source, evidence, times_seen, active, first_seen, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,$10)
       ON CONFLICT (user_sub, facet, fact_key) DO UPDATE SET
         fact_value=$5, confidence=$6, source=$7, evidence=COALESCE($8, user_model_facts.evidence),
         times_seen=$9, active=TRUE, last_seen=$10`,
      [randomUUID(), userSub, candidate.facet, candidate.factKey, merged.factValue, merged.confidence,
        candidate.source, candidate.evidence ?? null, merged.timesSeen, now],
    );
    return true;
  }

  /** @description Explicit teach: the user's words become a high-confidence fact. */
  async teach(userSub: string, text: string): Promise<FactCandidate | null> {
    const candidate = parseTeach(text);
    if (!candidate) return null;
    const stored = await this.mergeFact(userSub, candidate);
    return stored ? candidate : null;
  }

  /** @description User control: hard-delete one of their facts ("forget this"). */
  async forget(userSub: string, factId: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query('DELETE FROM user_model_facts WHERE user_sub=$1 AND fact_id=$2', [userSub, factId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * @description Lazy per-user sweep (throttled to once per {@link SWEEP_MIN_MINUTES}): decay
   * idle facts, deactivate the faded, then compute + dedupe-persist proactive suggestions.
   * Runs when the user arrives (pull-based proactivity) — no idle background work.
   */
  async sweep(userSub: string): Promise<void> {
    await this.ensureSchema();
    const now = new Date();
    const state = await this.pool.query('SELECT last_sweep_at FROM user_model_state WHERE user_sub=$1', [userSub]);
    const last = state.rows[0]?.last_sweep_at ? new Date(state.rows[0].last_sweep_at) : null;
    if (last && now.getTime() - last.getTime() < SWEEP_MIN_MINUTES * 60_000) return;
    await this.pool.query(
      `INSERT INTO user_model_state (user_sub, last_sweep_at) VALUES ($1,$2)
       ON CONFLICT (user_sub) DO UPDATE SET last_sweep_at=$2`,
      [userSub, now],
    );
    const facts = await this.getFacts(userSub, true);
    for (const fact of facts) {
      const decayed = decayFact(fact, now);
      if (decayed.confidence !== fact.confidence || decayed.active !== fact.active) {
        await this.pool.query('UPDATE user_model_facts SET confidence=$3, active=$4 WHERE user_sub=$1 AND fact_id=$2',
          [userSub, fact.factId, decayed.confidence, decayed.active]);
      }
    }
    for (const suggestion of computeSuggestions(facts, now)) {
      await this.persistSuggestion(userSub, suggestion);
    }
  }

  /** Dedupe-persist one suggestion (UNIQUE user/kind/message makes re-suggesting a no-op). */
  private async persistSuggestion(userSub: string, suggestion: SuggestionCandidate): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_model_suggestions (suggestion_id, user_sub, kind, message)
       VALUES ($1,$2,$3,$4) ON CONFLICT (user_sub, kind, message) DO NOTHING`,
      [randomUUID(), userSub, suggestion.kind, suggestion.message],
    );
  }

  /**
   * @description Adds a deduplicated owner-scoped proposal to the existing Haven suggestion inbox.
   * This only stores a question for later display; it does not execute the proposed action.
   * @param userSub - Authenticated owner's OIDC subject.
   * @param suggestion - Proposal kind and user-facing confirmation question.
   * @returns Void after the proposal is persisted or deduplicated.
   */
  async proposeSuggestion(userSub: string, suggestion: SuggestionCandidate): Promise<void> {
    const startedAt = Date.now();
    logger.info({ kind: suggestion.kind }, 'User-model proposal persistence entered');
    try {
      await this.ensureSchema();
      await this.persistSuggestion(userSub, suggestion);
      logger.info({ kind: suggestion.kind, durationMs: Date.now() - startedAt }, 'User-model proposal persistence completed');
    } catch (error) {
      logger.error({ err: error, kind: suggestion.kind, durationMs: Date.now() - startedAt }, 'User-model proposal persistence failed');
      throw error;
    }
  }

  /** @description Pending (new) suggestions for the user, oldest first. */
  async pendingSuggestions(userSub: string): Promise<Array<{ suggestionId: string; kind: string; message: string }>> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT suggestion_id, kind, message FROM user_model_suggestions WHERE user_sub=$1 AND status='new' ORDER BY created_at ASC LIMIT 5",
      [userSub],
    );
    return result.rows.map((r) => ({ suggestionId: r.suggestion_id, kind: r.kind, message: r.message }));
  }

  /** @description Dismiss (or mark done) one suggestion. */
  async resolveSuggestion(userSub: string, suggestionId: string, status: 'dismissed' | 'done'): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      'UPDATE user_model_suggestions SET status=$3 WHERE user_sub=$1 AND suggestion_id=$2', [userSub, suggestionId, status],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * @description Throttle gate for passive learning: true at most once per
   * {@link LEARN_MIN_SECONDS} per user (and records the attempt).
   */
  async shouldLearnNow(userSub: string): Promise<boolean> {
    await this.ensureSchema();
    const now = new Date();
    const state = await this.pool.query('SELECT last_learned_at FROM user_model_state WHERE user_sub=$1', [userSub]);
    const last = state.rows[0]?.last_learned_at ? new Date(state.rows[0].last_learned_at) : null;
    if (last && now.getTime() - last.getTime() < LEARN_MIN_SECONDS * 1000) return false;
    await this.pool.query(
      `INSERT INTO user_model_state (user_sub, last_learned_at) VALUES ($1,$2)
       ON CONFLICT (user_sub) DO UPDATE SET last_learned_at=$2`,
      [userSub, now],
    );
    return true;
  }
}

/** Map a user_model_facts row to the typed fact. */
function rowToFact(row: Record<string, unknown>): UserModelFact {
  return {
    factId: String(row.fact_id),
    userSub: String(row.user_sub),
    facet: String(row.facet) as UserModelFacet,
    factKey: String(row.fact_key),
    factValue: String(row.fact_value),
    confidence: Number(row.confidence),
    source: String(row.source) as UserModelFact['source'],
    evidence: (row.evidence as string | null) ?? null,
    timesSeen: Number(row.times_seen),
    active: Boolean(row.active),
    firstSeen: new Date(row.first_seen as string),
    lastSeen: new Date(row.last_seen as string),
  };
}
