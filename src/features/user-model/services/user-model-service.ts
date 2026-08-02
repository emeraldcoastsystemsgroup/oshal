/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Haven user model (ADR-079) persistence: user_model_facts / user_model_suggestions / user_model_state tables (owner-scoped RLS at the lazy-DDL chokepoint, A1.2 pattern), fact upsert via the pure merge logic, teach/forget, decay sweep, and suggestion persistence with dedupe. Thin SQL over user-model-logic.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added a public deduplicated proposal method used by ambient daily reviews to surface confirmation questions through the existing user-model suggestion inbox.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Closed three ADR-079 deferrals in the sweep: connector-signal facts (derive one owner-scoped signal fact per connected provider, retire the keys a disconnected provider no longer justifies, and raise a 'connector-attention' suggestion), cross-session compaction (deterministically deactivate the weakest tail so the active model stays bounded), and the haven_push_deliveries ledger the opt-in outward push uses to stay once-per-suggestion and inside its daily cap.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap } from '@/shared/services/database';
import {
  computeSuggestions, decayFact, isStorableFact, mergeFactUpdate, parseTeach,
  type FactCandidate, type SuggestionCandidate, type UserModelFacet, type UserModelFact,
} from './user-model-logic';
import {
  CONNECTOR_FACT_KEY_PREFIX,
  connectorAttentionMessages,
  connectorSignalCandidates,
  connectorSignalFactKeys,
  readConnectorSignalRows,
} from './connector-signal-facts';
import { planModelCompaction } from './model-compaction';

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
        // Outward-push ledger: one row per suggestion actually delivered. It is what makes the
        // opt-in push once-per-suggestion and rate-capped ACROSS restarts — an in-memory guard
        // would re-push everything after a container recreate.
        `CREATE TABLE IF NOT EXISTS haven_push_deliveries (
          user_sub TEXT NOT NULL,
          suggestion_id TEXT NOT NULL,
          channel TEXT,
          sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_sub, suggestion_id)
        )`,
        'CREATE INDEX IF NOT EXISTS haven_push_deliveries_user_time ON haven_push_deliveries (user_sub, sent_at DESC)',
        ...buildOwnerRlsPolicyStatements('user_model_facts', 'user_sub'),
        ...buildOwnerRlsPolicyStatements('user_model_suggestions', 'user_sub'),
        ...buildOwnerRlsPolicyStatements('user_model_state', 'user_sub'),
        ...buildOwnerRlsPolicyStatements('haven_push_deliveries', 'user_sub'),
      ],
      requirements: [
        { table: 'user_model_facts', columns: ['fact_id', 'user_sub', 'facet', 'fact_key', 'fact_value', 'confidence', 'active'] },
        { table: 'user_model_suggestions', columns: ['suggestion_id', 'user_sub', 'kind', 'message', 'status'] },
        { table: 'user_model_state', columns: ['user_sub', 'last_learned_at', 'last_sweep_at'] },
        { table: 'haven_push_deliveries', columns: ['user_sub', 'suggestion_id', 'channel', 'sent_at'] },
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
   * @description Lazy per-user sweep (throttled to once per {@link SWEEP_MIN_MINUTES}): decay idle
   * facts, refresh the connector-signal facts from the caller's own connections, compact the model
   * back inside its size bound, then compute + dedupe-persist proactive suggestions. Runs when the
   * user arrives (pull-based) and from the opt-in push cron for users who turned push on.
   * @param userSub - The owner whose model to sweep. Every read/write below is scoped to it.
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
    const connectorSuggestions = await this.syncConnectorSignals(userSub, now);
    await this.compact(userSub, now);
    for (const suggestion of [...computeSuggestions(facts, now), ...connectorSuggestions]) {
      await this.persistSuggestion(userSub, suggestion);
    }
  }

  /**
   * @description Refresh the `signal`-facet facts derived from the caller's OWN connected accounts:
   * merge one fact per connected provider (health, capabilities, expiry countdown — never a token,
   * never a raw scope, never an account identifier) and deactivate the `connector-*` facts a
   * disconnected provider no longer justifies, so Haven stops claiming a connection the user
   * removed. Non-fatal: a connector-schema problem returns no suggestions and leaves the model be.
   * @param userSub - The owner whose connections to read. The read is `WHERE user_sub = $1`.
   * @param now - The evaluation instant (drives the expiry countdown).
   * @returns The attention suggestions the current connector estate warrants (possibly empty).
   */
  async syncConnectorSignals(userSub: string, now: Date = new Date()): Promise<SuggestionCandidate[]> {
    await this.ensureSchema();
    try {
      const rows = await readConnectorSignalRows(this.pool, userSub);
      const liveKeys = connectorSignalFactKeys(rows);
      for (const candidate of connectorSignalCandidates(rows, now)) {
        await this.mergeFact(userSub, candidate);
      }
      // Retire the connector facts this estate no longer supports. Deactivate (never delete) so the
      // owner can still see what Haven used to believe on GET /api/user-model.
      await this.pool.query(
        `UPDATE user_model_facts SET active = FALSE
          WHERE user_sub = $1 AND facet = 'signal' AND active = TRUE
            AND fact_key LIKE $2 AND NOT (fact_key = ANY($3::text[]))`,
        [userSub, `${CONNECTOR_FACT_KEY_PREFIX}%`, liveKeys],
      );
      return connectorAttentionMessages(rows, now).map((message) => ({
        kind: 'connector-attention' as const, message,
      }));
    } catch (error) {
      logger.error({ err: error, stack: (error as Error).stack }, 'connector-signal sync failed (model left unchanged)');
      return [];
    }
  }

  /**
   * @description Bound the active model: deactivate the weakest compactable tail past the ceiling
   * (see planModelCompaction — explicit teaches and identity facts are never compacted). Nothing is
   * deleted; the owner still sees compacted facts and their evidence still lives in the owner-ACL'd
   * long-tail RAG collection.
   * @param userSub - The owner whose model to compact.
   * @param now - The evaluation instant.
   * @returns How many facts were deactivated.
   */
  async compact(userSub: string, now: Date = new Date()): Promise<number> {
    await this.ensureSchema();
    const plan = planModelCompaction(await this.getFacts(userSub, true), now);
    if (plan.retire.length === 0) return 0;
    const result = await this.pool.query(
      'UPDATE user_model_facts SET active = FALSE WHERE user_sub = $1 AND fact_id = ANY($2::text[])',
      [userSub, plan.retire],
    );
    logger.info({ retired: plan.retire.length, keptActive: plan.keptActive }, 'user model compacted');
    return result.rowCount ?? 0;
  }

  /**
   * @description Suggestion ids already pushed outward to this user (any day) — the once-per-
   * suggestion half of the push guard.
   * @param userSub - The owner.
   * @returns The pushed suggestion ids.
   */
  async pushedSuggestionIds(userSub: string): Promise<string[]> {
    await this.ensureSchema();
    const result = await this.pool.query(
      'SELECT suggestion_id FROM haven_push_deliveries WHERE user_sub = $1', [userSub],
    );
    return result.rows.map((row) => String(row.suggestion_id));
  }

  /**
   * @description How many outward pushes this user has received in the last 24 hours — the rate-cap
   * half of the push guard.
   * @param userSub - The owner.
   * @returns The count of pushes in the trailing 24h.
   */
  async pushesSentLastDay(userSub: string): Promise<number> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT COUNT(*)::int AS n FROM haven_push_deliveries WHERE user_sub = $1 AND sent_at > now() - INTERVAL '24 hours'",
      [userSub],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  /**
   * @description Record that one suggestion was actually delivered outward. Only ever called after a
   * real delivery, so a failed send is retried rather than silently swallowed.
   * @param userSub - The owner.
   * @param suggestionId - The suggestion that was pushed.
   * @param channel - The channel it went over (for the audit trail).
   */
  async recordPush(userSub: string, suggestionId: string, channel: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO haven_push_deliveries (user_sub, suggestion_id, channel) VALUES ($1,$2,$3)
       ON CONFLICT (user_sub, suggestion_id) DO NOTHING`,
      [userSub, suggestionId, channel.slice(0, 40)],
    );
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
